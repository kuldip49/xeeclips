"""Smoke test every visual runtime; optional real-video 5m/15m timing."""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.visual_analysis import VisualConfig, VisualRuntime, _device, analyze_video_chunks


def file_inventory(root: Path) -> list[dict[str, object]]:
    return [{"path": str(path.resolve()), "bytes": path.stat().st_size}
            for path in sorted(root.rglob("*")) if path.is_file()]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video-5m", type=Path)
    parser.add_argument("--video-15m", type=Path)
    args = parser.parse_args()
    root = Path(os.getenv("VISUAL_MODEL_DIR", "/models/visual"))
    config = VisualConfig(model_dir=root, max_frames=900)
    device, cuda, _ = _device()
    versions = {name: importlib.metadata.version(name) for name in (
        "ultralytics", "mediapipe", "paddleocr", "paddlepaddle", "paddlex",
        "scenedetect", "opencv-contrib-python", "numpy")}
    print(json.dumps({"versions": versions, "visualDevice": device,
                      "cudaAvailable": cuda, "yoloModel": config.yolo_model}, indent=2))
    runtime = VisualRuntime()
    image = np.zeros((256, 448, 3), dtype=np.uint8)
    cv2.putText(image, "Clear title", (40, 140), cv2.FONT_HERSHEY_SIMPLEX,
                1.4, (255, 255, 255), 3, cv2.LINE_AA)
    import mediapipe as mp
    detector, _ = runtime.load_faces(config)
    if detector is None:
        raise RuntimeError("FaceDetector could not load: " + repr(runtime.failures))
    face_result = detector.detect(mp.Image(
        image_format=mp.ImageFormat.SRGB,
        data=cv2.cvtColor(image, cv2.COLOR_BGR2RGB)))
    print(json.dumps({"faceInference": "ok", "detections": len(face_result.detections)}))
    ocr = runtime.load_ocr(config)
    if ocr is None:
        raise RuntimeError("PaddleOCR could not load: " + repr(runtime.failures))
    ocr_result = list(ocr.predict(image))
    print(json.dumps({"ocrInference": "ok", "resultCount": len(ocr_result)}))
    if not ocr_result:
        raise RuntimeError("PaddleOCR returned no result for text image")
    with TemporaryDirectory() as directory:
        path = Path(directory) / "frame.avi"
        writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 5, (448, 256))
        if not writer.isOpened():
            raise RuntimeError("OpenCV could not create smoke-test video")
        for _ in range(10):
            writer.write(image)
        writer.release()
        started = perf_counter()
        result = analyze_video_chunks(path, [(0, 0, 2)], config=config, runtime=runtime)
        print(json.dumps({"smokeLatencySec": round(perf_counter() - started, 3),
                          "smokeResult": result[0], "failures": runtime.failures}, indent=2))
    print(json.dumps({"models": file_inventory(root)}, indent=2))
    for label, path in (("5m", args.video_5m), ("15m", args.video_15m)):
        if path is None:
            continue
        if not path.is_file():
            raise FileNotFoundError(path)
        started = perf_counter()
        duration = 300 if label == "5m" else 900
        result = analyze_video_chunks(path, [(0, 0, duration)], config=config, runtime=runtime)
        print(json.dumps({"benchmark": label, "elapsedSec": round(perf_counter() - started, 3),
                          "sampledFrames": result[0]["sampled_frame_count"]}, indent=2))
    if runtime.failures:
        raise RuntimeError("Visual smoke test had subsystem failures: " + repr(runtime.failures))


if __name__ == "__main__":
    main()
