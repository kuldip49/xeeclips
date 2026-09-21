import unittest
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.visual_analysis import (FrameEvidence, VisualConfig, VisualRuntime,
                                 _aggregate, _candidate_anchors, _sampling_times,
                                 _text_like, _run_ocr, analyze_video_chunks,
                                 calculate_face_metrics, deduplicate_ocr_lines)


class VisualIntelligenceTests(unittest.TestCase):
    def test_fast_scan_and_shortlist_anchor_limits(self):
        config = VisualConfig(profile='FAST')
        chunks = [(index, index * 30.0, (index + 1) * 30.0) for index in range(29)]
        times = _sampling_times(chunks, [], config)
        self.assertGreaterEqual(len(times), 180)
        self.assertLessEqual(len(times), 230)
        self.assertEqual(len(times), len(set(times)))
        anchors = _candidate_anchors([(0, 30), (30, 60), (0, 30)], config)
        self.assertEqual(anchors, [0, 15, 30, 45, 60])

    def test_text_presence_gate(self):
        frame = np.zeros((240, 480, 3), dtype=np.uint8)
        self.assertFalse(_text_like(frame))
        cv2.putText(frame, 'IMPORTANT TITLE', (25, 120),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 2)
        self.assertTrue(_text_like(frame))

    def test_ocr_only_loads_for_text_like_anchors(self):
        class Ocr:
            calls = 0
            def predict(self, _):
                self.calls += 1
                return [{'rec_texts': ['IMPORTANT TITLE'], 'rec_scores': [.95]}]

        class Runtime(VisualRuntime):
            def __init__(self):
                super().__init__()
                self.model = Ocr()
                self.loads = 0
            def load_ocr(self, _):
                self.loads += 1
                return self.model

        frame = np.zeros((240, 480, 3), dtype=np.uint8)
        cv2.putText(frame, 'IMPORTANT TITLE', (25, 120),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 2)
        values = [FrameEvidence(index, frame if index == 0 else np.zeros_like(frame))
                  for index in range(20)]
        runtime = Runtime()
        with patch('app.visual_analysis.RUNTIME', runtime):
            _run_ocr(values, [(0, 0, 19)], [], VisualConfig(profile='FAST'))
        self.assertEqual(runtime.loads, 1)
        self.assertEqual(runtime.model.calls, 1)
        self.assertEqual(values[0].ocr_lines, ['IMPORTANT TITLE'])
        self.assertEqual(sum(item.ocr_analyzed for item in values), 1)

    def test_shortlisted_semantics_and_cache_reuse(self):
        class Tensor:
            def __init__(self, data):
                self.data = np.asarray(data)
            def detach(self):
                return self
            def cpu(self):
                return self
            def numpy(self):
                return self.data

        class Detector:
            names = {0: 'person'}
            calls = 0
            def predict(self, images, **_):
                self.calls += len(images)
                boxes = type('Boxes', (), {'xyxy': Tensor([[1, 1, 20, 20]]),
                                             'cls': Tensor([0]), 'conf': Tensor([.9])})()
                return [type('Result', (), {'boxes': boxes, 'names': self.names})()
                        for _ in images]

        class FaceDetector:
            calls = 0
            def detect(self, _):
                self.calls += 1
                box = type('Box', (), {'origin_x': 1, 'origin_y': 1,
                                       'width': 20, 'height': 20})()
                return type('Faces', (), {'detections': [type('Detection', (), {
                    'bounding_box': box})()]})()

        class Runtime(VisualRuntime):
            def __init__(self):
                super().__init__()
                self.detector = Detector()
                self.faces = FaceDetector()
            def load_yolo(self, _):
                return self.detector
            def load_faces(self, _):
                return self.faces, None
            def load_ocr(self, _):
                return None

        with TemporaryDirectory() as directory:
            path = Path(directory) / 'source.avi'
            writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*'MJPG'),
                                     5, (64, 64))
            self.assertTrue(writer.isOpened())
            for index in range(30):
                writer.write(np.full((64, 64, 3), index * 3, dtype=np.uint8))
            writer.release()
            runtime = Runtime()
            config = VisualConfig(model_dir=Path(directory), profile='FAST', scene_enabled=True,
                                  ocr_enabled=False)
            chunks = [(0, 0, 3), (1, 3, 6)]
            with patch('app.visual_analysis._detect_scenes',
                       side_effect=AssertionError('unexpected second decode')):
                first = analyze_video_chunks(path, chunks, config, runtime,
                                             video_id='video-1', candidates=[(0, 3)])
                calls = (runtime.detector.calls, runtime.faces.calls)
                second = analyze_video_chunks(path, chunks, config, runtime,
                                              video_id='video-1', candidates=[(0, 3)])
            self.assertEqual(first, second)
            self.assertEqual(calls, (3, 3))
            self.assertEqual(calls, (runtime.detector.calls, runtime.faces.calls))
            self.assertEqual(first[0]['yolo_frame_count'], 3)
            self.assertEqual(first[0]['face_frame_count'], 3)
            self.assertEqual(first[1]['yolo_frame_count'], 1)

    def test_bounded_sampling_and_anchors(self):
        config = VisualConfig(max_frames=30)
        times = _sampling_times([(0, 0, 900)], [3.5, 45.3], config)
        self.assertLessEqual(len(times), 30)
        self.assertEqual(times[0], 0)
        self.assertEqual(times[-1], 900)

    def test_face_prominence_and_stability(self):
        frame = np.zeros((100, 100, 3), dtype=np.uint8)
        values = [FrameEvidence(0, frame, faces=[(.3, .3, .4, .4)]),
                  FrameEvidence(1, frame, faces=[(.31, .3, .4, .4)])]
        presence, count, area, centeredness, stability, talking = calculate_face_metrics(values)
        self.assertEqual(presence, 100)
        self.assertEqual(count, 1)
        self.assertAlmostEqual(area, 16)
        self.assertGreater(centeredness, 95)
        self.assertGreater(stability, 90)
        self.assertGreater(talking, 60)

    def test_ocr_deduplication_and_scene_aggregation(self):
        self.assertEqual(deduplicate_ocr_lines([
            'A Strong Title', 'A   Strong Title!', 'Another item']),
            ['A Strong Title', 'Another item'])
        result = _aggregate(0, 0, 30, [], [5, 10, 31])
        self.assertEqual(result['scene_change_count'], 2)
        self.assertEqual(result['shot_boundaries'], [5, 10])
        self.assertAlmostEqual(result['scene_cut_rate'], .07)

    def test_yolo_feeds_evidence_and_failures_do_not_crash(self):
        class Tensor:
            def __init__(self, data):
                self.data = np.asarray(data)
            def detach(self):
                return self
            def cpu(self):
                return self
            def numpy(self):
                return self.data

        class Detector:
            def predict(self, frames, **_):
                boxes = type('Boxes', (), {'xyxy': Tensor([[100, 20, 300, 170]]),
                                            'cls': Tensor([0]), 'conf': Tensor([.9])})()
                return [type('Result', (), {'boxes': boxes, 'names': {0: 'person'}})()
                        for _ in frames]

        class Runtime(VisualRuntime):
            def load_yolo(self, _):
                return Detector()
            def load_faces(self, _):
                raise RuntimeError('face unavailable')
            def load_ocr(self, _):
                raise RuntimeError('ocr unavailable')

        with TemporaryDirectory() as directory:
            path = Path(directory) / 'video.avi'
            writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*'MJPG'), 5, (400, 200))
            self.assertTrue(writer.isOpened())
            for _ in range(10):
                writer.write(np.full((200, 400, 3), 80, dtype=np.uint8))
            writer.release()
            config = VisualConfig(model_dir=Path(directory), scene_enabled=False,
                                  ocr_enabled=False, face_enabled=False)
            with (patch('app.visual_analysis._run_faces', side_effect=RuntimeError('face')),
                  patch('app.visual_analysis._run_ocr', side_effect=RuntimeError('ocr'))):
                result = analyze_video_chunks(path, [(0, 0, 2)], config=config, runtime=Runtime())
            self.assertGreater(result[0]['person_presence_ratio'], 0)
            self.assertGreater(result[0]['largest_person_prominence'], 0)


if __name__ == '__main__':
    unittest.main()
