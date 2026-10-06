from __future__ import annotations

import logging
import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from time import perf_counter
from typing import Any, Iterable

import cv2
import numpy as np

logger = logging.getLogger("uvicorn.error")


def _flag(name: str, default: bool = True) -> bool:
    return os.getenv(name, "true" if default else "false").strip().lower() in {
        "1", "true", "yes", "on",
    }


def _number(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return min(maximum, max(minimum, value))


@dataclass(frozen=True)
class VisualConfig:
    enabled: bool = field(default_factory=lambda: _flag("VISUAL_INTELLIGENCE_ENABLED"))
    model_dir: Path = field(default_factory=lambda: Path(os.getenv("VISUAL_MODEL_DIR", "/models/visual")))
    yolo_model: str = field(default_factory=lambda: os.getenv("YOLO_MODEL", "yolo26n.pt"))
    profile: str = field(default_factory=lambda: os.getenv(
        "VISUAL_ANALYSIS_PROFILE", "BALANCED").strip().upper())
    sample_interval_sec: float = field(default_factory=lambda: _number(
        "VISUAL_SAMPLE_INTERVAL_SEC", 2.75, 2.5, 10.0))
    # This is the lightweight scan cap. Expensive inference has a separate,
    # duration-aware cap in _duration_expensive_cap().
    max_frames: int = field(default_factory=lambda: int(_number(
        "VISUAL_MAX_FRAMES", 2400, 12, 5000)))
    expensive_max_frames: int = field(default_factory=lambda: int(_number(
        "VISUAL_EXPENSIVE_MAX_FRAMES", 600, 12, 600)))
    time_budget_sec: float = field(default_factory=lambda: _number(
        "VISUAL_ANALYSIS_BUDGET_SEC", 0, 0, 1800))
    yolo_confidence: float = field(default_factory=lambda: _number(
        "VISUAL_YOLO_CONFIDENCE", 0.35, 0.05, 0.95))
    yolo_imgsz: int = field(default_factory=lambda: int(_number(
        "VISUAL_YOLO_IMGSZ", 416, 320, 640)))
    yolo_batch_size: int = field(default_factory=lambda: int(_number(
        "VISUAL_YOLO_BATCH_SIZE", 16, 1, 64)))
    yolo_classes: tuple[str, ...] = field(default_factory=lambda: tuple(
        item.strip() for item in os.getenv(
            "VISUAL_YOLO_CLASSES",
            "person,car,bicycle,motorcycle,bus,truck,cat,dog,cell phone,laptop,tv,book,sports ball,skateboard,surfboard",
        ).split(",") if item.strip()))
    ocr_enabled: bool = field(default_factory=lambda: _flag("VISUAL_OCR_ENABLED"))
    ocr_max_frames: int = field(default_factory=lambda: int(_number(
        "VISUAL_OCR_MAX_FRAMES", 120, 1, 600)))
    ocr_ratio: float = field(default_factory=lambda: _number(
        "VISUAL_OCR_RATIO", 0.15, 0.10, 0.20))
    face_enabled: bool = field(default_factory=lambda: _flag("VISUAL_FACE_ENABLED"))
    face_landmarks_enabled: bool = field(default_factory=lambda: _flag(
        "VISUAL_FACE_LANDMARKS_ENABLED"))
    face_landmarker_max_frames: int = field(default_factory=lambda: int(_number(
        "VISUAL_FACE_LANDMARKER_MAX_FRAMES", 40, 1, 120)))
    scene_enabled: bool = field(default_factory=lambda: _flag("VISUAL_SCENE_ENABLED"))
    cache_enabled: bool = field(default_factory=lambda: _flag("VISUAL_CACHE_ENABLED"))
    cache_dir: Path = field(default_factory=lambda: Path(os.getenv(
        "VISUAL_CACHE_DIR", "/models/visual/cache")))

    def __post_init__(self) -> None:
        if self.profile not in {"FAST", "BALANCED", "DEEP"}:
            object.__setattr__(self, "profile", "BALANCED")

    @property
    def profile_expensive_factor(self) -> float:
        return {"FAST": 0.60, "BALANCED": 1.0, "DEEP": 1.0}[self.profile]

    @property
    def effective_ocr_ratio(self) -> float:
        return min(self.ocr_ratio, 0.10) if self.profile == "FAST" else self.ocr_ratio

    @property
    def effective_sample_interval_sec(self) -> float:
        if self.profile == "FAST":
            return max(4.5, self.sample_interval_sec)
        if self.profile == "DEEP":
            return max(2.5, self.sample_interval_sec * 0.9)
        return self.sample_interval_sec

    @property
    def yolo_path(self) -> Path:
        configured = Path(self.yolo_model)
        return configured if configured.is_absolute() else self.model_dir / configured.name

    @property
    def face_detector_path(self) -> Path:
        return Path(os.getenv("MEDIAPIPE_FACE_DETECTOR_MODEL",
                              str(self.model_dir / "blaze_face_short_range.tflite")))

    @property
    def face_landmarker_path(self) -> Path:
        return Path(os.getenv("MEDIAPIPE_FACE_LANDMARKER_MODEL",
                              str(self.model_dir / "face_landmarker.task")))


@dataclass
class FrameEvidence:
    timestamp: float
    frame: np.ndarray
    brightness: float = 0.0
    contrast: float = 0.0
    sharpness: float = 0.0
    colorfulness: float = 0.0
    motion: float = 0.0
    novelty: float = 0.0
    black: bool = False
    person_count: int = 0
    object_count: int = 0
    classes: set[str] = field(default_factory=set)
    largest_person_ratio: float = 0.0
    central_person_score: float = 0.0
    detection_confidences: list[float] = field(default_factory=list)
    faces: list[tuple[float, float, float, float]] = field(default_factory=list)
    persons: list[tuple[float, float, float, float]] = field(default_factory=list)
    landmark_orientation: float | None = None
    ocr_lines: list[str] = field(default_factory=list)
    ocr_confidences: list[float] = field(default_factory=list)
    text_area_ratio: float = 0.0
    subtitle: bool = False
    title_card: bool = False
    opencv_analyzed: bool = True
    yolo_analyzed: bool = False
    face_analyzed: bool = False
    ocr_analyzed: bool = False


class VisualRuntime:
    """Lazy process-wide model cache. Individual subsystem failures stay isolated."""

    def __init__(self) -> None:
        self.yolo: Any | None = None
        self.face_detector: Any | None = None
        self.face_landmarker: Any | None = None
        self.ocr: Any | None = None
        self.failures: dict[str, str] = {}

    def fail(self, subsystem: str, error: Exception) -> None:
        message = f"{type(error).__name__}: {error}"
        self.failures[subsystem] = message
        logger.warning("Visual subsystem unavailable subsystem=%s error=%s", subsystem, message)

    def load_yolo(self, config: VisualConfig) -> Any | None:
        if self.yolo is not None or "yolo" in self.failures:
            return self.yolo
        try:
            from ultralytics import YOLO
            config.model_dir.mkdir(parents=True, exist_ok=True)
            requested = config.yolo_model
            _, cuda, _ = _device()
            if not cuda and Path(requested).name.lower() == "yolo26s.pt":
                logger.warning("Replacing CPU-incompatible YOLO model %s with yolo26n.pt", requested)
                requested = "yolo26n.pt"
            configured = Path(requested)
            source = configured if configured.is_absolute() else config.model_dir / configured.name
            if not source.is_file():
                source = requested
            self.yolo = YOLO(str(source))
            logger.info("YOLO model resolved path=%s", getattr(self.yolo, "ckpt_path", source))
        except Exception as error:  # pragma: no cover - optional runtime
            self.fail("yolo", error)
        return self.yolo

    def load_faces(self, config: VisualConfig) -> tuple[Any | None, Any | None]:
        if not config.face_enabled:
            return None, None
        try:
            import mediapipe as mp
            if self.face_detector is None and "faceDetector" not in self.failures:
                options = mp.tasks.vision.FaceDetectorOptions(
                    base_options=mp.tasks.BaseOptions(model_asset_path=str(config.face_detector_path)),
                    running_mode=mp.tasks.vision.RunningMode.IMAGE,
                    min_detection_confidence=0.5,
                )
                self.face_detector = mp.tasks.vision.FaceDetector.create_from_options(options)
        except Exception as error:  # pragma: no cover - optional runtime
            self.fail("faceDetector" if self.face_detector is None else "faceLandmarker", error)
        return self.face_detector, self.face_landmarker

    def load_face_landmarker(self, config: VisualConfig) -> Any | None:
        if (not config.face_enabled or not config.face_landmarks_enabled or
                self.face_landmarker is not None or "faceLandmarker" in self.failures):
            return self.face_landmarker
        try:
            import mediapipe as mp
            options = mp.tasks.vision.FaceLandmarkerOptions(
                base_options=mp.tasks.BaseOptions(model_asset_path=str(config.face_landmarker_path)),
                running_mode=mp.tasks.vision.RunningMode.IMAGE,
                num_faces=1,
                min_face_detection_confidence=0.5,
                min_face_presence_confidence=0.5,
            )
            self.face_landmarker = mp.tasks.vision.FaceLandmarker.create_from_options(options)
        except Exception as error:  # pragma: no cover - optional runtime
            self.fail("faceLandmarker", error)
        return self.face_landmarker

    def load_ocr(self, config: VisualConfig, cpu_threads: int | None = None) -> Any | None:
        if not config.ocr_enabled or self.ocr is not None or "ocr" in self.failures:
            return self.ocr
        try:
            from paddleocr import PaddleOCR
            config.model_dir.mkdir(parents=True, exist_ok=True)
            try:
                self.ocr = PaddleOCR(
                    lang="en",
                    text_detection_model_name="PP-OCRv5_mobile_det",
                    text_recognition_model_name="PP-OCRv5_mobile_rec",
                    use_doc_orientation_classify=False,
                    use_doc_unwarping=False,
                    use_textline_orientation=False,
                    device="cpu",
                    # PaddleOCR 3.7 defaults CPU inference to oneDNN; Paddle 3.3.1's
                    # PIR executor cannot convert an Array<Double> attribute there.
                    enable_mkldnn=False,
                    **({'cpu_threads': cpu_threads} if cpu_threads is not None else {}),
                )
            except (TypeError, ValueError):
                raise
        except Exception as error:  # pragma: no cover - optional runtime
            self.fail("ocr", error)
        return self.ocr


RUNTIME = VisualRuntime()


def _round(value: float) -> float:
    return round(float(value) if np.isfinite(value) else 0.0, 2)


def _mean(values: Iterable[float]) -> float:
    items = list(values)
    return float(np.mean(items)) if items else 0.0


def _colorfulness(frame: np.ndarray) -> float:
    blue, green, red = cv2.split(frame.astype(np.float32))
    red_green = np.abs(red - green)
    yellow_blue = np.abs(0.5 * (red + green) - blue)
    return min(100.0, float(np.hypot(red_green.std(), yellow_blue.std()) +
                            0.3 * np.hypot(red_green.mean(), yellow_blue.mean())))


def _histogram(frame: np.ndarray) -> np.ndarray:
    histogram = cv2.calcHist([frame], [0, 1], None, [32, 32], [0, 256, 0, 256])
    return cv2.normalize(histogram, histogram).flatten()


def _text_like(frame: np.ndarray) -> bool:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    if gray.shape[1] > 480:
        gray = cv2.resize(gray, (480, max(1, round(gray.shape[0] * 480 / gray.shape[1]))))
    gradient = cv2.morphologyEx(gray, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
    _, binary = cv2.threshold(gradient, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    # Join adjacent glyphs into likely text lines; raw glyph-contour counts
    # miss clean title cards and slides with only a few large words.
    joined = cv2.morphologyEx(binary, cv2.MORPH_CLOSE,
                              cv2.getStructuringElement(cv2.MORPH_RECT, (13, 3)))
    contours, _ = cv2.findContours(joined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    height, width = gray.shape
    for contour in contours:
        _, _, w, h = cv2.boundingRect(contour)
        if (6 <= h <= height * .20 and w >= max(30, h * 2.5) and
                w * h <= width * height * .25):
            return True
    return False


def deduplicate_ocr_lines(lines: Iterable[str], limit: int = 600) -> list[str]:
    accepted: list[str] = []
    keys: set[str] = set()
    length = 0
    for raw in lines:
        text = re.sub(r"\s+", " ", raw).strip()
        key = re.sub(r"[^a-z0-9]+", "", text.lower())
        if len(key) < 2 or key in keys:
            continue
        if any(key in prior or prior in key for prior in keys if min(len(key), len(prior)) >= 8):
            continue
        if length + len(text) > limit:
            break
        keys.add(key)
        accepted.append(text)
        length += len(text) + 1
    return accepted


def _walk_dicts(value: Any) -> Iterable[dict[str, Any]]:
    if not isinstance(value, (dict, list, tuple)):
        for attribute in ("json", "to_dict"):
            candidate = getattr(value, attribute, None)
            if candidate is None:
                continue
            try:
                converted = candidate() if callable(candidate) else candidate
                if isinstance(converted, str):
                    converted = json.loads(converted)
                yield from _walk_dicts(converted)
                return
            except (TypeError, ValueError, json.JSONDecodeError):
                pass
        return
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk_dicts(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            yield from _walk_dicts(child)


def _parse_ocr_result(raw: Any, shape: tuple[int, ...]) -> tuple[list[str], list[float], float, bool, bool]:
    height, width = shape[:2]
    lines: list[str] = []
    confidences: list[float] = []
    polygons: list[Any] = []
    for item in _walk_dicts(raw):
        texts = item.get("rec_texts")
        scores = item.get("rec_scores")
        if isinstance(texts, (list, tuple)):
            lines.extend(str(value) for value in texts)
            if isinstance(scores, (list, tuple, np.ndarray)):
                confidences.extend(float(value) for value in scores)
            polygons.extend(item.get("rec_polys") or item.get("dt_polys") or [])
    if not lines:
        for item in raw if isinstance(raw, (list, tuple)) else []:
            for record in item if isinstance(item, list) else []:
                if (isinstance(record, (list, tuple)) and len(record) >= 2 and
                        isinstance(record[1], (list, tuple)) and len(record[1]) >= 2):
                    polygons.append(record[0])
                    lines.append(str(record[1][0]))
                    confidences.append(float(record[1][1]))
    accepted = [(line, confidences[index] if index < len(confidences) else 0.0)
                for index, line in enumerate(lines)
                if line.strip() and (confidences[index] if index < len(confidences) else 0.0) >= 0.45]
    area = 0.0
    lower = False
    title = False
    for polygon in polygons:
        points = np.asarray(polygon, dtype=np.float32).reshape(-1, 2)
        if len(points) < 3:
            continue
        area += abs(float(cv2.contourArea(points)))
        center_y = float(points[:, 1].mean())
        lower |= center_y >= height * 0.65
        title |= center_y <= height * 0.45 and float(np.ptp(points[:, 0])) >= width * 0.2
    return ([item[0] for item in accepted], [item[1] for item in accepted],
            min(100.0, area / max(1, width * height) * 100), lower, title)


def _detect_scenes(video_path: Path, config: VisualConfig) -> tuple[list[float], float]:
    if not config.scene_enabled:
        return [], 0.0
    started = perf_counter()
    try:
        from scenedetect import AdaptiveDetector, detect
        scenes = detect(str(video_path), AdaptiveDetector())
        return [scene[0].get_seconds() for scene in scenes[1:]], perf_counter() - started
    except Exception as error:
        RUNTIME.fail("scene", error)
        return [], perf_counter() - started


def _duration_expensive_cap(duration: float, config: VisualConfig) -> int:
    """Hard ceiling for model inference; it is never proportional without a cap."""
    if duration <= 5 * 60:
        suggested = 120
    elif duration <= 15 * 60:
        suggested = 220
    elif duration <= 30 * 60:
        suggested = 320
    elif duration <= 60 * 60:
        suggested = 450
    else:
        suggested = 600
    return max(1, min(suggested, config.expensive_max_frames,
                      int(suggested * config.profile_expensive_factor)))


def _analysis_budget(duration: float, config: VisualConfig) -> float:
    if config.time_budget_sec > 0:
        return config.time_budget_sec
    if duration <= 5 * 60:
        return 25.0
    if duration <= 15 * 60:
        return 60.0 if config.profile == "FAST" else 55.0
    if duration <= 30 * 60:
        return 90.0
    if duration <= 60 * 60:
        return 150.0
    return 180.0


def _sampling_times(chunks: list[tuple[int, float, float]], boundaries: list[float],
                    config: VisualConfig) -> list[float]:
    start = min(item[1] for item in chunks)
    end = max(item[2] for item in chunks)
    base_values = {round(float(value), 3) for value in
                   np.arange(start, end, config.effective_sample_interval_sec)}
    anchor_values = {round(start, 3), round(end, 3)}
    values = sorted(base_values | anchor_values)
    if len(values) <= config.max_frames:
        return values
    if len(anchor_values) >= config.max_frames:
        indices = np.linspace(0, len(anchor_values) - 1, config.max_frames, dtype=int)
        return sorted({sorted(anchor_values)[index] for index in indices.tolist()})
    remaining = config.max_frames - len(anchor_values)
    non_anchors = sorted(base_values - anchor_values)
    if not non_anchors:
        return sorted(anchor_values)
    indices = np.linspace(0, len(non_anchors) - 1, remaining, dtype=int)
    return sorted(anchor_values | {non_anchors[index] for index in indices.tolist()})


def _scan_boundaries(frames: list[FrameEvidence]) -> list[float]:
    # Frame differences and histogram novelty come from the same sparse decode.
    # Avoid a second, full-video PySceneDetect decode on CPU.
    return [item.timestamp for item in frames[1:]
            if item.novelty >= 35 and item.motion >= 8]


def _candidate_anchors(candidates: list[tuple[float, float]],
                       config: VisualConfig) -> list[float]:
    anchors = {round(max(0.0, value), 3) for start, end in candidates
               for value in (start, (start + end) / 2, end) if end >= start}
    duration = max((end for _, end in candidates), default=0)
    return sorted(anchors)[:_duration_expensive_cap(duration, config)]


def _extract_frames(video_path: Path, times: list[float],
                    max_width: int = 480,
                    deadline: float | None = None) -> tuple[list[FrameEvidence], float]:
    started = perf_counter()
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise ValueError("Could not open video for visual analysis")
    output: list[FrameEvidence] = []
    previous_gray: np.ndarray | None = None
    previous_histogram: np.ndarray | None = None
    try:
        for timestamp in sorted(set(times)):
            if deadline is not None and perf_counter() >= deadline:
                break
            capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000)
            ok, frame = capture.read()
            if not ok:
                continue
            if frame.shape[1] > max_width:
                scale = max_width / frame.shape[1]
                frame = cv2.resize(frame, None, fx=scale, fy=scale)
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            histogram = _histogram(frame)
            brightness = float(gray.mean()) / 255 * 100
            contrast = min(100.0, float(gray.std()) / 80 * 100)
            sharpness = min(100.0, float(cv2.Laplacian(gray, cv2.CV_64F).var()) / 8)
            motion = (float(cv2.absdiff(gray, previous_gray).mean()) / 255 * 100
                      if previous_gray is not None and previous_gray.shape == gray.shape else 0.0)
            novelty = (float(cv2.compareHist(previous_histogram, histogram,
                                             cv2.HISTCMP_BHATTACHARYYA)) * 100
                       if previous_histogram is not None else 0.0)
            output.append(FrameEvidence(
                timestamp=timestamp, frame=frame, brightness=brightness, contrast=contrast,
                sharpness=sharpness, colorfulness=_colorfulness(frame), motion=motion,
                novelty=min(100.0, novelty), black=brightness < 4 and contrast < 8,
            ))
            previous_gray, previous_histogram = gray, histogram
    finally:
        capture.release()
    return output, perf_counter() - started


def _device() -> tuple[str, bool, bool]:
    try:
        import torch
        cuda = bool(torch.cuda.is_available())
        return ("cuda:0" if cuda else "cpu"), cuda, cuda
    except Exception:
        return "cpu", False, False


def _run_yolo(frames: list[FrameEvidence], config: VisualConfig,
              deadline: float | None = None) -> float:
    started = perf_counter()
    if not frames:
        return perf_counter() - started
    model = RUNTIME.load_yolo(config)
    if model is None:
        return perf_counter() - started
    device, _, half = _device()
    try:
        batch_size = min(4, config.yolo_batch_size) if config.profile == "FAST" else config.yolo_batch_size
        for offset in range(0, len(frames), batch_size):
            if deadline is not None and perf_counter() >= deadline:
                break
            batch = frames[offset:offset + batch_size]
            names = getattr(model, "names", {})
            named_classes = names.items() if isinstance(names, dict) else enumerate(names)
            allowed_classes = [index for index, name in named_classes
                               if str(name) in config.yolo_classes]
            options = {
                "conf": config.yolo_confidence, "device": device, "half": half,
                "verbose": False, "imgsz": config.yolo_imgsz,
            }
            if allowed_classes:
                options["classes"] = allowed_classes
            results = model.predict([item.frame for item in batch], **options)
            for evidence, result in zip(batch, results):
                evidence.yolo_analyzed = True
                boxes = getattr(result, "boxes", None)
                if boxes is None:
                    continue
                height, width = evidence.frame.shape[:2]
                area = max(1, width * height)
                names = getattr(result, "names", getattr(model, "names", {}))
                xyxy = boxes.xyxy.detach().cpu().numpy()
                classes = boxes.cls.detach().cpu().numpy().astype(int)
                confidences = boxes.conf.detach().cpu().numpy()
                evidence.object_count = len(classes)
                evidence.detection_confidences = [float(value) for value in confidences]
                for box, class_index in zip(xyxy, classes):
                    name = str(names.get(int(class_index), class_index))
                    evidence.classes.add(name)
                    if name != "person":
                        continue
                    evidence.person_count += 1
                    x1, y1, x2, y2 = map(float, box)
                    evidence.persons.append((x1 / width, y1 / height,
                                             (x2 - x1) / width, (y2 - y1) / height))
                    ratio = max(0.0, (x2 - x1) * (y2 - y1) / area * 100)
                    center_x, center_y = (x1 + x2) / 2 / width, (y1 + y2) / 2 / height
                    centered = max(0.0, 100 - np.hypot(center_x - .5, center_y - .5) * 141.42)
                    if ratio >= evidence.largest_person_ratio:
                        evidence.largest_person_ratio = ratio
                        evidence.central_person_score = float(centered)
    except Exception as error:
        RUNTIME.fail("yoloInference", error)
    return perf_counter() - started


def _run_faces(frames: list[FrameEvidence], config: VisualConfig,
               deadline: float | None = None) -> float:
    started = perf_counter()
    if not frames:
        return perf_counter() - started
    detector, landmarker = RUNTIME.load_faces(config)
    if detector is None:
        return perf_counter() - started
    try:
        import mediapipe as mp
        landmark_count = 0
        landmark_stride = 3 if config.profile == "DEEP" else 5
        for index, evidence in enumerate(frames):
            if deadline is not None and perf_counter() >= deadline:
                break
            evidence.face_analyzed = True
            rgb = cv2.cvtColor(evidence.frame, cv2.COLOR_BGR2RGB)
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = detector.detect(image)
            height, width = evidence.frame.shape[:2]
            for detection in result.detections:
                box = detection.bounding_box
                evidence.faces.append((box.origin_x / width, box.origin_y / height,
                                       box.width / width, box.height / height))
            likely_talking_head = bool(evidence.faces and max(
                box[2] * box[3] for box in evidence.faces) >= 0.025)
            if (config.profile != "FAST" and likely_talking_head and landmarker is None):
                landmarker = RUNTIME.load_face_landmarker(config)
            if (config.profile != "FAST" and landmarker is not None and likely_talking_head
                    and index % landmark_stride == 0
                    and landmark_count < config.face_landmarker_max_frames):
                landmarks = landmarker.detect(image).face_landmarks
                landmark_count += 1
                if landmarks and len(landmarks[0]) > 263:
                    points = landmarks[0]
                    eye_mid = (points[33].x + points[263].x) / 2
                    eye_span = max(0.001, abs(points[263].x - points[33].x))
                    evidence.landmark_orientation = min(1.0, abs(points[1].x - eye_mid) / eye_span)
    except Exception as error:
        RUNTIME.fail("faceInference", error)
    return perf_counter() - started


def _run_ocr(frames: list[FrameEvidence], chunks: list[tuple[int, float, float]],
             boundaries: list[float], config: VisualConfig,
             deadline: float | None = None) -> float:
    started = perf_counter()
    if not frames:
        return perf_counter() - started
    anchors = [value for _, left, right in chunks for value in (left, (left + right) / 2, right)]
    anchors.extend(boundaries)
    eligible = [index for index, evidence in enumerate(frames)
                if _text_like(evidence.frame)]
    max_ocr_frames = min(config.ocr_max_frames,
                         max(1, int(len(frames) * config.effective_ocr_ratio)))
    if max_ocr_frames <= 0:
        return perf_counter() - started
    prioritized = sorted(eligible, key=lambda index: (
        not any(abs(frames[index].timestamp - anchor) <= .2 for anchor in anchors),
        frames[index].timestamp,
    ))[:max_ocr_frames]
    if not prioritized or deadline is not None and perf_counter() >= deadline:
        return perf_counter() - started
    ocr = RUNTIME.load_ocr(config)
    if ocr is None:
        return perf_counter() - started
    try:
        for index in prioritized:
            if deadline is not None and perf_counter() >= deadline:
                break
            evidence = frames[index]
            raw = (list(ocr.predict(evidence.frame)) if hasattr(ocr, "predict")
                   else ocr.ocr(evidence.frame, cls=False))
            lines, confidences, area, subtitle, title = _parse_ocr_result(raw, evidence.frame.shape)
            evidence.ocr_lines = deduplicate_ocr_lines(lines, 240)
            evidence.ocr_confidences = confidences
            evidence.text_area_ratio = area
            evidence.subtitle = subtitle
            evidence.title_card = title
            evidence.ocr_analyzed = True
    except Exception as error:
        RUNTIME.fail("ocrInference", error)
    return perf_counter() - started


def calculate_face_metrics(frames: list[FrameEvidence]) -> tuple[float, float, float, float, float, float]:
    with_faces = [item for item in frames if item.faces]
    if not frames or not with_faces:
        return 0.0, 0.0, 0.0, 0.0, 0.0, 0.0
    primary = [max(item.faces, key=lambda box: box[2] * box[3]) for item in with_faces]
    areas = [box[2] * box[3] * 100 for box in primary]
    centers = [(box[0] + box[2] / 2, box[1] + box[3] / 2) for box in primary]
    centeredness = [max(0.0, 100 - np.hypot(x - .5, y - .5) * 141.42) for x, y in centers]
    jitter = _mean(np.hypot(centers[index][0] - centers[index - 1][0],
                            centers[index][1] - centers[index - 1][1]) * 100
                   for index in range(1, len(centers)))
    stability = max(0.0, 100 - jitter * 5)
    presence = len(with_faces) / len(frames) * 100
    prominence = _mean(areas)
    talking = min(100.0, presence * .5 + min(100.0, prominence * 4) * .25 + stability * .25)
    return presence, _mean(len(item.faces) for item in frames), prominence, _mean(centeredness), stability, talking


def _aggregate(position: int, start: float, end: float, frames: list[FrameEvidence],
               boundaries: list[float]) -> dict[str, object]:
    relevant = [item for item in frames if start - .001 <= item.timestamp <= end + .001]
    light = [item for item in relevant if item.opencv_analyzed]
    cuts = [value for value in boundaries if start < value < end]
    duration = max(.001, end - start)
    face_frames = [item for item in relevant if item.face_analyzed]
    # Preserve the small helper's standalone behavior for callers constructing
    # FrameEvidence directly (including older integrations and tests).
    if not face_frames:
        face_frames = [item for item in relevant if item.faces]
    yolo_frames = [item for item in relevant if item.yolo_analyzed]
    if not yolo_frames:
        yolo_frames = [item for item in relevant if item.person_count or item.object_count]
    face_presence, avg_faces, face_area, face_center, face_stability, talking = calculate_face_metrics(face_frames)
    all_ocr = deduplicate_ocr_lines(line for item in relevant for line in item.ocr_lines)
    classes = sorted({name for item in relevant for name in item.classes})[:40]
    face_tracks = []
    person_tracks = []
    for item in relevant:
        # Keep several subjects for the edited-clip camera; summary scoring still
        # uses the separate aggregate metrics above.
        for box in sorted(item.faces, key=lambda value: value[2] * value[3], reverse=True)[:3]:
            face_tracks.append({"timestamp": _round(item.timestamp),
                                "x": _round(box[0]), "y": _round(box[1]),
                                "w": _round(box[2]), "h": _round(box[3])})
        for box in sorted(item.persons, key=lambda value: value[2] * value[3], reverse=True)[:3]:
            person_tracks.append({"timestamp": _round(item.timestamp),
                                  "x": _round(box[0]), "y": _round(box[1]),
                                  "w": _round(box[2]), "h": _round(box[3])})
    ocr_confidences = [value for item in relevant for value in item.ocr_confidences]
    scene_rate = len(cuts) / duration
    average_shot = duration / (len(cuts) + 1)
    transition = max(0.0, 100 - abs(scene_rate - .08) * 650) if cuts else 25.0
    return {
        "position": position, "sampled_frame_count": len(relevant),
        "yolo_frame_count": len([item for item in relevant if item.yolo_analyzed]),
        "face_frame_count": len([item for item in relevant if item.face_analyzed]),
        "ocr_frame_count": len([item for item in relevant if item.ocr_analyzed]),
        "shot_boundaries": [_round(value) for value in cuts],
        "scene_change_count": len(cuts), "scene_cut_rate": _round(scene_rate),
        "average_shot_duration": _round(average_shot),
        "visual_transition_score": _round(transition),
        "average_motion": _round(_mean(item.motion for item in light)),
        "visual_novelty": _round(_mean(item.novelty for item in light)),
        "face_count": max((len(item.faces) for item in face_frames), default=0),
        "face_tracks": face_tracks, "person_tracks": person_tracks,
        "largest_face_ratio": _round(max((box[2] * box[3] * 100 for item in face_frames
                                           for box in item.faces), default=0.0)),
        "face_presence_ratio": _round(face_presence), "average_face_count": _round(avg_faces),
        "primary_face_area_ratio": _round(face_area),
        "primary_face_centeredness": _round(face_center), "face_stability": _round(face_stability),
        "talking_head_likelihood": _round(talking),
        "person_presence_ratio": _round(_mean(float(item.person_count > 0) for item in yolo_frames) * 100),
        "average_person_count": _round(_mean(item.person_count for item in yolo_frames)),
        "object_activity": _round(_mean(item.object_count for item in yolo_frames)),
        "object_diversity": len(classes), "detected_object_classes": classes,
        "largest_person_prominence": _round(_mean(item.largest_person_ratio for item in yolo_frames)),
        "central_person_score": _round(_mean(item.central_person_score for item in yolo_frames if item.person_count)),
        "detection_confidence_mean": _round(_mean(value for item in yolo_frames
                                                    for value in item.detection_confidences) * 100),
        "brightness": _round(_mean(item.brightness for item in light)),
        "contrast": _round(_mean(item.contrast for item in light)),
        "colorfulness": _round(_mean(item.colorfulness for item in light)),
        "sharpness_score": _round(_mean(item.sharpness for item in light)),
        "black_frame_ratio": _round(_mean(float(item.black) for item in light) * 100),
        "ocr_text": "\n".join(all_ocr), "ocr_confidence": _round(_mean(ocr_confidences) * 100),
        "text_area_ratio": _round(_mean(item.text_area_ratio for item in relevant)),
        "subtitle_detected": any(item.subtitle for item in relevant),
        "title_card_presence": any(item.title_card for item in relevant),
    }


def _cache_path(video_path: Path, chunks: list[tuple[int, float, float]],
                config: VisualConfig, video_id: str | None,
                anchors: list[float] | None = None) -> Path:
    try:
        stat = video_path.stat()
        source = {"videoId": video_id or str(video_path.resolve()), "size": stat.st_size}
        # API requests download to a fresh temporary path. Its mtime is not a
        # source version, so only use it when no stable video id was supplied.
        if video_id is None:
            source["mtimeNs"] = stat.st_mtime_ns
    except OSError:
        source = {"videoId": video_id or str(video_path.resolve())}
    settings = {
        "source": source,
        # Do not reuse observations cached while FaceDetector/OCR was unavailable.
        "cacheVersion": 4, "anchors": anchors,
        "profile": config.profile, "sampleInterval": config.sample_interval_sec,
        "maxFrames": config.max_frames, "expensiveMaxFrames": config.expensive_max_frames,
        "timeBudget": config.time_budget_sec,
        "yoloModel": config.yolo_model, "yoloConfidence": config.yolo_confidence,
        "yoloImgSize": config.yolo_imgsz, "yoloBatchSize": config.yolo_batch_size,
        "yoloClasses": config.yolo_classes,
        "ocr": [config.ocr_enabled, config.ocr_max_frames, config.effective_ocr_ratio],
        "faces": [config.face_enabled, config.face_landmarks_enabled,
                  config.face_landmarker_max_frames],
        "scene": config.scene_enabled,
    }
    digest = hashlib.sha256(json.dumps(settings, sort_keys=True, default=str).encode()).hexdigest()
    cache_dir = config.cache_dir
    if "VISUAL_CACHE_DIR" not in os.environ and config.cache_dir == Path("/models/visual/cache"):
        cache_dir = config.model_dir / "cache"
    return cache_dir / f"{digest}.json"


def _serialize_evidence(evidence: FrameEvidence) -> dict[str, object]:
    return {
        "timestamp": evidence.timestamp, "brightness": evidence.brightness,
        "contrast": evidence.contrast, "sharpness": evidence.sharpness,
        "colorfulness": evidence.colorfulness, "motion": evidence.motion,
        "novelty": evidence.novelty, "black": evidence.black,
        "personCount": evidence.person_count, "objectCount": evidence.object_count,
        "classes": sorted(evidence.classes), "largestPersonRatio": evidence.largest_person_ratio,
        "centralPersonScore": evidence.central_person_score,
        "detectionConfidences": evidence.detection_confidences,
        "faces": evidence.faces, "landmarkOrientation": evidence.landmark_orientation,
        "persons": evidence.persons,
        "ocrLines": evidence.ocr_lines, "ocrConfidences": evidence.ocr_confidences,
        "textAreaRatio": evidence.text_area_ratio, "subtitle": evidence.subtitle,
        "titleCard": evidence.title_card, "opencvAnalyzed": evidence.opencv_analyzed,
        "yoloAnalyzed": evidence.yolo_analyzed, "faceAnalyzed": evidence.face_analyzed,
        "ocrAnalyzed": evidence.ocr_analyzed,
    }


def _deserialize_evidence(raw: dict[str, object]) -> FrameEvidence:
    return FrameEvidence(
        timestamp=float(raw["timestamp"]), frame=np.empty((0, 0, 3), dtype=np.uint8),
        brightness=float(raw.get("brightness", 0)), contrast=float(raw.get("contrast", 0)),
        sharpness=float(raw.get("sharpness", 0)), colorfulness=float(raw.get("colorfulness", 0)),
        motion=float(raw.get("motion", 0)), novelty=float(raw.get("novelty", 0)),
        black=bool(raw.get("black", False)), person_count=int(raw.get("personCount", 0)),
        object_count=int(raw.get("objectCount", 0)),
        classes=set(str(item) for item in raw.get("classes", [])),
        largest_person_ratio=float(raw.get("largestPersonRatio", 0)),
        central_person_score=float(raw.get("centralPersonScore", 0)),
        detection_confidences=[float(item) for item in raw.get("detectionConfidences", [])],
        faces=[tuple(float(value) for value in box) for box in raw.get("faces", [])],
        persons=[tuple(float(value) for value in box) for box in raw.get("persons", [])],
        landmark_orientation=(float(raw["landmarkOrientation"])
                             if raw.get("landmarkOrientation") is not None else None),
        ocr_lines=[str(item) for item in raw.get("ocrLines", [])],
        ocr_confidences=[float(item) for item in raw.get("ocrConfidences", [])],
        text_area_ratio=float(raw.get("textAreaRatio", 0)),
        subtitle=bool(raw.get("subtitle", False)), title_card=bool(raw.get("titleCard", False)),
        opencv_analyzed=bool(raw.get("opencvAnalyzed", True)),
        yolo_analyzed=bool(raw.get("yoloAnalyzed", False)),
        face_analyzed=bool(raw.get("faceAnalyzed", False)),
        ocr_analyzed=bool(raw.get("ocrAnalyzed", False)),
    )


def _load_cached_observations(path: Path, chunks: list[tuple[int, float, float]]) -> tuple[list[FrameEvidence], list[float]] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        frames = [_deserialize_evidence(item) for item in payload["frames"]]
        boundaries = [float(item) for item in payload.get("boundaries", [])]
        if not frames:
            return None
        coverage = payload.get("requestedCoverage",
                              payload.get("coverage", [frames[0].timestamp, frames[-1].timestamp]))
        requested_start = min(item[1] for item in chunks)
        requested_end = max(item[2] for item in chunks)
        if (not frames or float(coverage[0]) > requested_start + .001 or
                float(coverage[1]) < requested_end - .001):
            return None
        return frames, boundaries
    except (OSError, IndexError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def _save_observations(path: Path, frames: list[FrameEvidence], boundaries: list[float],
                       chunks: list[tuple[int, float, float]]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "version": 1, "frames": [_serialize_evidence(item) for item in frames],
            "boundaries": boundaries,
            "coverage": [frames[0].timestamp, frames[-1].timestamp] if frames else [],
            "requestedCoverage": [min(item[1] for item in chunks),
                                  max(item[2] for item in chunks)],
        }), encoding="utf-8")
    except OSError as error:  # Cache is optional and must never fail the pipeline.
        logger.warning("Visual observation cache unavailable path=%s error=%s", path, error)


def analyze_video_chunks(video_path: Path, chunks: list[tuple[int, float, float]],
                         config: VisualConfig | None = None,
                         runtime: VisualRuntime | None = None,
                         video_id: str | None = None,
                         candidates: list[tuple[float, float]] | None = None) -> list[dict[str, object]]:
    config = config or VisualConfig()
    global RUNTIME
    if runtime is not None:
        RUNTIME = runtime
    if not chunks:
        return []
    if not config.enabled:
        logger.info("Visual intelligence disabled")
        return [_aggregate(position, start, end, [], []) for position, start, end in chunks]
    config.model_dir.mkdir(parents=True, exist_ok=True)
    total_started = perf_counter()
    anchors = _candidate_anchors(candidates if candidates is not None else
                                 [(left, right) for _, left, right in chunks], config)
    cache_file = (_cache_path(video_path, chunks, config, video_id, anchors)
                  if config.cache_enabled else None)
    cached = (_load_cached_observations(cache_file, chunks)
              if cache_file is not None else None)
    cache_hit = cached is not None
    if cached is not None:
        frames, boundaries = cached
        scene_time = extraction_time = anchor_decode_time = yolo_time = face_time = ocr_time = 0.0
        expensive_frames = [item for item in frames if item.yolo_analyzed or item.face_analyzed]
        frames_skipped_by_budget = 0
    else:
        duration = max(0.001, max(item[2] for item in chunks) - min(item[1] for item in chunks))
        deadline = total_started + _analysis_budget(duration, config)
        times = _sampling_times(chunks, [], config)
        base_count = len(times)
        frames, extraction_time = _extract_frames(
            video_path, times, max_width=480 if config.profile == "FAST" else 640,
            deadline=deadline)
        scene_started = perf_counter()
        boundaries = _scan_boundaries(frames) if config.scene_enabled else []
        scene_time = perf_counter() - scene_started
        # Semantic models see only shortlisted candidate anchors. They are
        # decoded once and deduplicated independently of the sparse scan.
        expensive_frames = []
        anchor_decode_time = 0.0
        if perf_counter() < deadline and anchors:
            scan_by_time = {round(item.timestamp, 3): item for item in frames}
            missing_times = [value for value in anchors if value not in scan_by_time]
            new_frames, anchor_decode_time = _extract_frames(
                video_path, missing_times, max_width=640, deadline=deadline) if missing_times else ([], 0.0)
            for item in new_frames:
                item.opencv_analyzed = False
            by_time = {**scan_by_time, **{round(item.timestamp, 3): item for item in new_frames}}
            expensive_frames = [by_time[value] for value in anchors if value in by_time]
        else:
            new_frames = []

        def safe_run(name: str, run: Any) -> float:
            started = perf_counter()
            try:
                if perf_counter() >= deadline:
                    return 0.0
                return run()
            except Exception as error:
                RUNTIME.fail(name, error)
                return perf_counter() - started

        # Reserve CPU time for face detection; otherwise a single slow YOLO
        # batch can starve every subsequent semantic subsystem.
        yolo_deadline = min(deadline, perf_counter() + max(8, _analysis_budget(duration, config) * .35))
        yolo_time = safe_run("yolo", lambda: _run_yolo(expensive_frames, config, yolo_deadline))
        face_time = safe_run("face", lambda: _run_faces(expensive_frames, config, deadline))
        ocr_time = safe_run("ocr", lambda: _run_ocr(
            expensive_frames, chunks, boundaries, config, deadline))
        processed_counts = [len([item for item in expensive_frames if item.yolo_analyzed]),
                            len([item for item in expensive_frames if item.face_analyzed]),
                            len([item for item in expensive_frames if item.ocr_analyzed])]
        budget_exceeded = perf_counter() >= deadline
        frames_skipped_by_budget = (max(0, len(anchors) - processed_counts[0],
                                        len(anchors) - processed_counts[1] if config.face_enabled else 0)
                                    if budget_exceeded else 0)
        if cache_file is not None:
            _save_observations(cache_file, [*frames, *new_frames], boundaries, chunks)
        frames.extend(new_frames)
    if cached is not None:
        base_count = len([item for item in frames if item.opencv_analyzed])
    device, cuda, _ = _device()
    total = perf_counter() - total_started
    yolo_count = len([item for item in frames if item.yolo_analyzed])
    face_count = len([item for item in frames if item.face_analyzed])
    ocr_count = len([item for item in frames if item.ocr_analyzed])
    landmarker_count = len([item for item in frames if item.landmark_orientation is not None])
    logger.info(
        "Visual intelligence profile=%s cacheHit=%s visualDevice=%s yoloModel=%s "
        "cudaAvailable=%s baseSampleCount=%d anchorSampleCount=%d "
        "deduplicatedSampleCount=%d finalDecodedFrameCount=%d "
        "lightweightSampleCount=%d candidateAnchorCount=%d deduplicatedAnchorCount=%d "
        "sampledFrameCount=%d opencvFrameCount=%d yoloFrameCount=%d "
        "faceFrameCount=%d ocrFrameCount=%d landmarkerFrameCount=%d "
        "opencvMs=%.1f anchorDecodeMs=%.1f yoloMs=%.1f faceMs=%.1f ocrMs=%.1f sceneMs=%.1f "
        "totalVisualAnalysisMs=%.1f framesSkippedByBudget=%d visualAnalysisStatus=%s failures=%s",
        config.profile, cache_hit, device, config.yolo_model, cuda,
        base_count, len(anchors), len(set([*times, *anchors])) if not cache_hit else len(frames),
        len(frames), base_count, len(anchors), len(anchors), len(frames),
        len([item for item in frames if item.opencv_analyzed]),
        yolo_count, face_count, ocr_count, landmarker_count, extraction_time * 1000,
        anchor_decode_time * 1000, yolo_time * 1000, face_time * 1000,
        ocr_time * 1000, scene_time * 1000,
        total * 1000, frames_skipped_by_budget,
        "BUDGET_EXCEEDED" if frames_skipped_by_budget else
        "PARTIAL" if anchors and (not yolo_count or config.face_enabled and not face_count)
        else "COMPLETED", RUNTIME.failures,
    )
    return [_aggregate(position, start, end, frames, boundaries)
            for position, start, end in chunks]
