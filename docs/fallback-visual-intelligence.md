# FALLBACK_ONLY visual intelligence

`FALLBACK_ONLY` uses no generative model. YOLO26s, MediaPipe Tasks FaceDetector and optional FaceLandmarker, PP-OCRv5 mobile detection/recognition, PySceneDetect AdaptiveDetector, and OpenCV supply measured visual evidence. The existing seven-factor Content Potential formula, 75 primary threshold, 60 secondary threshold, and duration limits are unchanged. `ONLINE` and `OFFLINE` provider routing is unchanged.

## Installation and models

The Python 3.12 service uses the exact versions in `apps/ai-service/requirements.txt`. Rebuild the service image and apply the Prisma migration before processing new videos. The image runs `scripts/setup_visual_models.py` during build; the Docker `visual_models` volume persists `/models/visual` after the first container creation. Use `python scripts/setup_visual_models.py` again for a controlled initialization on a different runtime. It reports actual model file sizes; never assume a model is available merely because a package imported. Ultralytics may create an intermediate download before the script copies it to the persistent directory.

Expected assets:

| Model | Container path | Purpose |
| --- | --- | --- |
| `yolo26s.pt` | `/models/visual/yolo26s.pt` | COCO person/object detection |
| `blaze_face_short_range.tflite` | `/models/visual/blaze_face_short_range.tflite` | MediaPipe face detection |
| `face_landmarker.task` | `/models/visual/face_landmarker.task` | Optional face orientation proxy |
| `PP-OCRv5_mobile_det`, `PP-OCRv5_mobile_rec` | PaddleX's model cache | English-capable text detection/recognition |

The service initializes OCR once per worker, but the PaddleX cache location depends on PaddleOCR's installed version. Confirm the actual paths and sizes with the verification script; the service must not download models on every video. `YOLO_MODEL=yolo26n.pt` is available as a measured-performance fallback, not the default. The default Python image is CPU-only; CUDA requires a compatible PyTorch/CUDA image and host GPU pass-through. Runtime logs emit `visualDevice`, `yoloModel`, and `cudaAvailable` once per analysis job. FP16 is requested only when CUDA is available.

`VISUAL_SAMPLE_INTERVAL_SEC=1.25` and `VISUAL_MAX_FRAMES=900` bound decoded/inferred frames. Transcript chunk edges/midpoints and scene boundaries contribute additional anchors within that cap. YOLO batches 16 frames; OCR runs at most 180 prioritized frames per video. Scene detection scans the stream once. A single visual request covers all pending chunks, rather than downloading and scanning the same video for every chunk. Configure `VISUAL_OCR_ENABLED`, `VISUAL_FACE_ENABLED`, `VISUAL_FACE_LANDMARKS_ENABLED`, or `VISUAL_SCENE_ENABLED` to isolate expensive subsystems. `VISUAL_INTELLIGENCE_ENABLED=false` disables the fallback visual pass, including when `ENABLE_VISUAL_ANALYSIS=false` is overridden by fallback mode.

Per-job logs contain frame extraction, YOLO, face, OCR, scene, OpenCV, and total seconds. `recommendation_candidate` logs all seven scores, Content Potential, visual evidence, tier, and `reasonNotPrimary`. `recommendation_summary` records raw/shortlist/primary/secondary/recommended counts, duration cap, and unchanged primary threshold. A two-clip outcome can reflect fewer than three primary candidates, suppression of overlapping/near-duplicate clips, or the duration cap; secondary clips are counted but do **not** increase `recommendedClipCount`. Diagnosis requires the actual job logs, not a blanket change to the 75 threshold.

Visual evidence is persisted per transcript chunk; candidate `evidence.candidateVisualEvidence` combines face/person presence, centeredness, motion, cuts, OCR-transcript overlap, sharpness, novelty, black-frame ratio, and speech-word coverage. Content type is an approximate deterministic classification. No face is a neutral signal for gameplay, presentations, screen recordings, and sports/action. Transcript word timestamps supply speech coverage/silence estimates; audio energy is not currently measured, so no energy-based claim is made. Detection failures are logged and the remaining evidence continues; an inaccessible video causes the optional visual stage to be skipped, not the processing job to fail.

## Licensing and commercial deployment

| Dependency | License / implication |
| --- | --- |
| [Ultralytics](https://www.ultralytics.com/license) | AGPL-3.0 or Enterprise; review SaaS/network-service obligations with counsel, or obtain Enterprise terms before closed-source commercial deployment. Model weights may carry additional terms. |
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE) | Apache-2.0; review downloaded model notices. |
| [MediaPipe](https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE) | Apache-2.0; review task asset terms. No identity recognition is performed. |
| [PySceneDetect](https://github.com/Breakthrough/PySceneDetect/blob/main/LICENSE) | BSD-3-Clause. |
| [OpenCV](https://opencv.org/license/) | Apache-2.0 for recent releases; retain dependency notices. |

These are engineering notes, not legal advice.

## Verification

Run `python -m pip check`, `python scripts/verify_visual_runtime.py`, `python -m unittest discover -s scripts -p 'test_visual_*.py'` in the AI service, then `npm --workspace apps/backend run test:ai-modes` and `npm --workspace apps/backend run test:visual-intelligence`. The verification script runs one synthetic image through every component and prints actual versions, model paths/sizes, CUDA selection, and inference latency. Supply `--video-5m` and `--video-15m` to benchmark representative real files; synthetic extrapolation is not a benchmark.
