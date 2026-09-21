"""Controlled, idempotent model cache initialization for visual intelligence."""
from __future__ import annotations

import os
import shutil
import urllib.request
from pathlib import Path


MODEL_DIR = Path(os.getenv("VISUAL_MODEL_DIR", "/models/visual"))
PADDLE_CACHE_DIR = Path(
    os.getenv("PADDLE_PDX_CACHE_HOME", str(MODEL_DIR / "paddle"))
)
FACE_DETECTOR_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_detector/"
    "blaze_face_short_range/float16/latest/blaze_face_short_range.tflite"
)
FACE_LANDMARKER_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/latest/face_landmarker.task"
)


def download(url: str, destination: Path) -> None:
    if destination.is_file() and destination.stat().st_size:
        return
    temporary = destination.with_suffix(destination.suffix + ".partial")
    with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as output:
        shutil.copyfileobj(response, output)
    temporary.replace(destination)


def migrate_legacy_paddle_cache(destination: Path) -> None:
    """Copy a pre-existing default PaddleX cache into persistent storage.

    PaddleX stores official models below ``~/.paddlex`` by default. Copying
    rather than deleting keeps the old cache as a safe fallback if setup is
    interrupted. Existing files in the persistent cache are left untouched.
    """
    legacy_root = Path.home() / ".paddlex"
    legacy_models = legacy_root / "official_models"
    target_models = destination / "official_models"
    if not legacy_models.is_dir():
        return

    target_models.mkdir(parents=True, exist_ok=True)
    copied = False
    for source in sorted(legacy_models.iterdir()):
        target = target_models / source.name
        if target.exists():
            continue
        if source.is_dir():
            shutil.copytree(source, target)
        else:
            shutil.copy2(source, target)
        copied = True
    if copied:
        print(f"Migrated legacy PaddleX cache: {legacy_models} -> {target_models}")


def prepare_persistent_dirs() -> None:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    PADDLE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    os.environ["PADDLE_PDX_CACHE_HOME"] = str(PADDLE_CACHE_DIR)
    migrate_legacy_paddle_cache(PADDLE_CACHE_DIR)

    ultralytics_config = Path(
        os.getenv("YOLO_CONFIG_DIR", str(MODEL_DIR / "ultralytics-config"))
    )
    ultralytics_config.mkdir(parents=True, exist_ok=True)
    ultralytics_settings = ultralytics_config / "Ultralytics"
    ultralytics_settings.mkdir(parents=True, exist_ok=True)
    try:
        # The service normally runs as root, but make this harmless settings
        # directory writable for images using a different runtime user too.
        ultralytics_config.chmod(0o777)
        ultralytics_settings.chmod(0o777)
    except OSError:
        pass


def main() -> None:
    # This must happen before importing ultralytics or paddleocr/paddlex.
    prepare_persistent_dirs()
    os.environ.setdefault("YOLO_CONFIG_DIR", str(MODEL_DIR / "ultralytics-config"))
    failures: list[str] = []

    try:
        from ultralytics import YOLO

        yolo_name = os.getenv("YOLO_MODEL", "yolo26n.pt")
        yolo_path = MODEL_DIR / Path(yolo_name).name
        if not yolo_path.is_file():
            model = YOLO(yolo_name)
            resolved = Path(model.ckpt_path)
            if resolved.resolve() != yolo_path.resolve():
                shutil.copy2(resolved, yolo_path)
        YOLO(str(yolo_path))
        print(f"YOLO ready: {yolo_path}")
    except Exception as exc:  # pragma: no cover - depends on network/model cache
        failures.append(f"YOLO: {type(exc).__name__}: {exc}")

    for label, url, destination in (
        ("MediaPipe face detector", FACE_DETECTOR_URL, MODEL_DIR / "blaze_face_short_range.tflite"),
        ("MediaPipe face landmarker", FACE_LANDMARKER_URL, MODEL_DIR / "face_landmarker.task"),
    ):
        try:
            download(url, destination)
            print(f"{label} ready: {destination}")
        except Exception as exc:  # pragma: no cover - depends on network/model cache
            failures.append(f"{label}: {type(exc).__name__}: {exc}")

    try:
        from paddleocr import PaddleOCR

        print(f"PaddleX cache: {PADDLE_CACHE_DIR}")
        PaddleOCR(
            lang="en",
            text_detection_model_name="PP-OCRv5_mobile_det",
            text_recognition_model_name="PP-OCRv5_mobile_rec",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            device="cpu",
            enable_mkldnn=False,
        )
        print("PaddleOCR ready")
    except Exception as exc:  # pragma: no cover - depends on network/model cache
        failures.append(f"PaddleOCR: {type(exc).__name__}: {exc}")

    cache_roots = [MODEL_DIR, PADDLE_CACHE_DIR]
    for cache_root in cache_roots:
        if not cache_root.is_dir():
            continue
        for path in sorted(cache_root.rglob("*")):
            if path.is_file():
                print(f"{path}: {path.stat().st_size} bytes")
    if failures:
        print("Visual model setup completed with unavailable optional assets:")
        for failure in failures:
            print(f"- {failure}")


if __name__ == "__main__":
    main()
