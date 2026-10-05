"""Dense, clip-local visual analysis for the EDITED_CLIPS renderer.

The chunk-level visual analysis samples a long video sparsely (seconds apart).
Professional reframing needs denser evidence for the short edit window only:
per-frame face/person boxes with stable track ids, a mouth-activity signal for
active-speaker framing, text regions for information-preservation layouts, and
frame-accurate shot boundaries. The service stays stateless.
"""
from __future__ import annotations

import logging
from pathlib import Path
from time import perf_counter
from typing import Any

import cv2
import numpy as np

from app.visual_analysis import (RUNTIME, VisualConfig, _device, _parse_ocr_result,
                                 deduplicate_ocr_lines)

logger = logging.getLogger("uvicorn.error")

SHOT_DISTANCE = 0.42         # Bhattacharyya distance between consecutive frames
SOFT_SHOT_DISTANCE = 0.22    # accepted together with a large pixel change
PIXEL_CHANGE = 38.0          # mean abs difference of 64x36 gray thumbnails
MIN_SHOT_GAP_SEC = 0.4
OCR_FRAMES = 4
OCR_MIN_COVERAGE = 0.04
_multi_landmarker: Any | None = None
_multi_landmarker_failed = False


def _round(value: float) -> float:
    return round(float(value), 4)


def text_regions(frame: np.ndarray, limit: int = 12) -> tuple[float, list[dict[str, float]]]:
    """Text-like line regions (normalized boxes) and their frame coverage."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    if gray.shape[1] > 480:
        gray = cv2.resize(gray, (480, max(1, round(gray.shape[0] * 480 / gray.shape[1]))))
    height, width = gray.shape
    gradient = cv2.morphologyEx(gray, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
    _, binary = cv2.threshold(gradient, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    joined = cv2.morphologyEx(binary, cv2.MORPH_CLOSE,
                              cv2.getStructuringElement(cv2.MORPH_RECT, (13, 3)))
    contours, _ = cv2.findContours(joined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if not (6 <= h <= height * .2 and w >= max(30, h * 2.5) and w * h <= width * height * .25):
            continue
        # Text lines are dense in edges; flat bars are not.
        density = float(binary[y:y + h, x:x + w].mean()) / 255
        if density < .18:
            continue
        boxes.append((x, y, w, h))
    coverage = min(1.0, sum(w * h for _, _, w, h in boxes) / max(1, width * height))
    boxes.sort(key=lambda box: box[2] * box[3], reverse=True)
    return coverage, [{"x": _round(x / width), "y": _round(y / height),
                       "w": _round(w / width), "h": _round(h / height)}
                      for x, y, w, h in boxes[:limit]]


def graphic_regions(frame: np.ndarray, limit: int = 6) -> list[dict[str, float]]:
    """Large bright burned-in lettering (e.g. "COMING UP" cards, titles).

    Display-size glyphs only have edges on their outlines, so text_regions misses
    them. These boxes are only used to keep captions off source graphics; they do
    not change text coverage or shot classification.
    """
    value = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)[:, :, 2]
    if value.shape[1] > 480:
        value = cv2.resize(value, (480, max(1, round(value.shape[0] * 480 / value.shape[1]))))
    height, width = value.shape
    bright = (value >= 215).astype(np.uint8) * 255
    joined = cv2.morphologyEx(bright, cv2.MORPH_CLOSE,
                              cv2.getStructuringElement(cv2.MORPH_RECT, (17, 3)))
    contours, _ = cv2.findContours(joined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if not (height * .04 <= h <= height * .25 and w >= h * 2.2 and w <= width * .95):
            continue
        glyphs = bright[y:y + h, x:x + w] > 0
        fill = float(glyphs.mean())
        # Letters: solid strokes with gaps between them (not a lamp, window or bar).
        columns = glyphs.any(axis=0).astype(np.int8)
        gaps = int(np.count_nonzero(np.diff(columns) == -1))
        if not (.2 <= fill <= .8 and gaps >= 3):
            continue
        # Overlay lettering sits on a darker surround; bright floors/walls do not.
        if float(value[y:y + h, x:x + w][~glyphs].mean()) > 150:
            continue
        boxes.append((x, y, w, h))
    boxes.sort(key=lambda box: box[2] * box[3], reverse=True)
    return [{"x": _round(x / width), "y": _round(y / height),
             "w": _round(w / width), "h": _round(h / height)} for x, y, w, h in boxes[:limit]]


def _signature(frame: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    small = cv2.resize(frame, (160, 90))
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [16, 8], [0, 180, 0, 256])
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    # Hue/saturation alone cannot separate two grayscale shots; add luminance.
    luma = cv2.calcHist([gray], [0], None, [32], [0, 256])
    thumb = cv2.resize(gray, (64, 36)).astype(np.float32)
    return cv2.normalize(hist, hist).flatten(), cv2.normalize(luma, luma).flatten(), thumb


def shot_change(previous: tuple[np.ndarray, np.ndarray, np.ndarray],
                current: tuple[np.ndarray, np.ndarray, np.ndarray]) -> bool:
    color = cv2.compareHist(previous[0], current[0], cv2.HISTCMP_BHATTACHARYYA)
    luma = cv2.compareHist(previous[1], current[1], cv2.HISTCMP_BHATTACHARYYA)
    pixels = float(np.abs(previous[2] - current[2]).mean())
    distance = max(color, luma)
    return distance > SHOT_DISTANCE or (distance > SOFT_SHOT_DISTANCE and pixels > PIXEL_CHANGE)


def _load_multi_landmarker(config: VisualConfig) -> Any | None:
    global _multi_landmarker, _multi_landmarker_failed
    if _multi_landmarker is not None or _multi_landmarker_failed or not config.face_landmarks_enabled:
        return _multi_landmarker
    try:
        import mediapipe as mp
        options = mp.tasks.vision.FaceLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(config.face_landmarker_path)),
            running_mode=mp.tasks.vision.RunningMode.IMAGE,
            num_faces=4, min_face_detection_confidence=0.5, min_face_presence_confidence=0.5)
        _multi_landmarker = mp.tasks.vision.FaceLandmarker.create_from_options(options)
    except Exception as error:  # pragma: no cover - optional runtime
        _multi_landmarker_failed = True
        logger.warning("Edit analysis landmarker unavailable: %s", error)
    return _multi_landmarker


# The short-range BlazeFace model misses faces narrower than ~15% of the frame
# (typical podcast and interview framing). Upper crops enlarge them 2x.
FACE_CROPS = ((0.0, 0.0, 1.0, 1.0), (0.0, 0.0, 0.55, 0.8), (0.25, 0.0, 0.5, 0.8), (0.45, 0.0, 0.55, 0.8))


def detect_faces(detector: Any, image: np.ndarray) -> list[dict[str, float]]:
    import mediapipe as mp
    height, width = image.shape[:2]
    found: list[dict[str, float]] = []
    for cx, cy, cw, ch in FACE_CROPS:
        x0, y0 = int(cx * width), int(cy * height)
        crop = image[y0:y0 + int(ch * height), x0:x0 + int(cw * width)]
        if crop.size == 0:
            continue
        scale = 640 / crop.shape[1]
        resized = cv2.resize(crop, None, fx=scale, fy=scale) if abs(scale - 1) > .01 else crop
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
        for detection in detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)).detections:
            box = detection.bounding_box
            score = detection.categories[0].score if detection.categories else 0.0
            found.append({"x": (x0 + box.origin_x / scale) / width, "y": (y0 + box.origin_y / scale) / height,
                          "w": box.width / scale / width, "h": box.height / scale / height,
                          "score": float(score)})
    kept: list[dict[str, float]] = []
    for face in sorted(found, key=lambda item: item["score"], reverse=True):
        if all(_iou(face, other) < 0.3 for other in kept):
            kept.append(face)
    return [{key: _round(value) for key, value in face.items()} for face in kept
            if face["w"] > 0 and face["h"] > 0]


def _mouth_openness(landmarker: Any, image: np.ndarray, face: dict[str, float]) -> float | None:
    import mediapipe as mp
    height, width = image.shape[:2]
    size = max(face["w"] * width, face["h"] * height) * 2.2
    cx = (face["x"] + face["w"] / 2) * width
    cy = (face["y"] + face["h"] / 2) * height
    x0, y0 = int(max(0, cx - size / 2)), int(max(0, cy - size / 2))
    crop = image[y0:int(min(height, cy + size / 2)), x0:int(min(width, cx + size / 2))]
    if crop.shape[0] < 16 or crop.shape[1] < 16:
        return None
    crop = cv2.resize(crop, (256, 256))
    result = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB,
                                        data=cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)))
    if not result.face_landmarks or len(result.face_landmarks[0]) <= 152:
        return None
    points = result.face_landmarks[0]
    face_height = max(1e-4, abs(points[152].y - points[10].y))
    return float(abs(points[14].y - points[13].y) / face_height)


def _iou(a: dict[str, float], b: dict[str, float]) -> float:
    x1, y1 = max(a["x"], b["x"]), max(a["y"], b["y"])
    x2 = min(a["x"] + a["w"], b["x"] + b["w"])
    y2 = min(a["y"] + a["h"], b["y"] + b["h"])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union > 0 else 0.0


def assign_tracks(frames: list[dict[str, Any]], boundaries: list[float]) -> None:
    """Greedy IoU/centre tracking; a shot boundary ends every track."""
    next_id = 0
    previous: list[dict[str, Any]] = []
    boundary_index = 0
    for frame in frames:
        while boundary_index < len(boundaries) and boundaries[boundary_index] <= frame["t"]:
            previous = []
            boundary_index += 1
        used: set[int] = set()
        for face in sorted(frame["faces"], key=lambda item: item["w"] * item["h"], reverse=True):
            best, best_score = None, 0.0
            for index, prior in enumerate(previous):
                if index in used:
                    continue
                centre = np.hypot(face["x"] + face["w"] / 2 - prior["x"] - prior["w"] / 2,
                                  face["y"] + face["h"] / 2 - prior["y"] - prior["h"] / 2)
                score = max(_iou(face, prior), 0.3 if centre < 0.08 else 0.0)
                if score > best_score:
                    best, best_score = index, score
            if best is not None and best_score >= 0.3:
                used.add(best)
                face["track_id"] = previous[best]["track_id"]
            else:
                face["track_id"] = f"f{next_id}"
                next_id += 1
        previous = frame["faces"]


def mouth_activity(frames: list[dict[str, Any]], window_sec: float = 0.75) -> None:
    """Rolling std of mouth openness per track, normalized to 0..1."""
    series: dict[str, list[tuple[float, float]]] = {}
    for frame in frames:
        for face in frame["faces"]:
            if face.get("mouth_open") is not None:
                series.setdefault(face["track_id"], []).append((frame["t"], face["mouth_open"]))
    for frame in frames:
        for face in frame["faces"]:
            values = [value for t, value in series.get(face["track_id"], [])
                      if abs(t - frame["t"]) <= window_sec]
            if len(values) >= 3:
                face["mouth_activity"] = _round(min(1.0, float(np.std(values)) / 0.03))
            face.pop("mouth_open", None)


def ocr_candidates(sampled: list[dict[str, Any]], boundaries: list[float]):
    """Middle frame of shots without a dominant face (or with visible text), at most OCR_FRAMES."""
    edges = [0.0, *boundaries, float("inf")]
    shots = []
    for start, end in zip(edges, edges[1:]):
        frames = [item for item in sampled if start <= item["t"] < end]
        if not frames:
            continue
        middle = frames[len(frames) // 2]
        largest_face = max((face["w"] * face["h"] for face in middle["faces"]), default=0.0)
        if largest_face < 0.02 or middle["text_coverage"] >= OCR_MIN_COVERAGE:
            shots.append((largest_face >= 0.02, -len(frames), middle, frames))
    shots.sort(key=lambda entry: (entry[0], entry[1]))
    return [(middle, frames) for _, _, middle, frames in shots[:OCR_FRAMES]]


def analyze_edit_window(video_path: Path, fps: float = 4.0, max_frames: int = 480,
                        config: VisualConfig | None = None) -> dict[str, Any]:
    started = perf_counter()
    config = config or VisualConfig()
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise ValueError("Could not open edit window")
    source_fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, round(source_fps / max(0.5, fps)))
    sampled: list[dict[str, Any]] = []
    boundaries: list[float] = []
    previous_signature: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None
    index = 0
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            t = index / source_fps
            signature = _signature(frame)
            if previous_signature is not None and shot_change(previous_signature, signature) and (
                    not boundaries or t - boundaries[-1] > MIN_SHOT_GAP_SEC):
                boundaries.append(_round(t))
            previous_signature = signature
            if index % step == 0 and len(sampled) < max_frames:
                scale = min(1.0, 640 / frame.shape[1])
                image = cv2.resize(frame, None, fx=scale, fy=scale) if scale < 1 else frame
                sampled.append({"t": _round(t), "image": image, "faces": [], "persons": []})
            index += 1
    finally:
        capture.release()
    decode_sec = perf_counter() - started

    detector, _ = RUNTIME.load_faces(config)
    landmarker = _load_multi_landmarker(config)
    face_started = perf_counter()
    if detector is not None:
        for item in sampled:
            item["faces"] = detect_faces(detector, item["image"])
            if landmarker is not None:
                for face in item["faces"]:
                    openness = _mouth_openness(landmarker, item["image"], face)
                    if openness is not None:
                        face["mouth_open"] = openness
    face_sec = perf_counter() - face_started

    yolo_started = perf_counter()
    model = RUNTIME.load_yolo(config)
    # Persons matter most where faces are missing; elsewhere 2 fps is enough.
    yolo_items = [item for position, item in enumerate(sampled)
                  if position % 2 == 0 or not item["faces"]]
    if model is not None and yolo_items:
        device, _, half = _device()
        names = getattr(model, "names", {})
        pairs = names.items() if isinstance(names, dict) else enumerate(names)
        person_class = [key for key, name in pairs if str(name) == "person"]
        for offset in range(0, len(yolo_items), config.yolo_batch_size):
            batch = yolo_items[offset:offset + config.yolo_batch_size]
            try:
                results = model.predict([item["image"] for item in batch], conf=config.yolo_confidence,
                                        device=device, half=half, verbose=False,
                                        imgsz=config.yolo_imgsz, classes=person_class or None)
            except Exception as error:  # pragma: no cover - optional runtime
                RUNTIME.fail("yoloInference", error)
                break
            for item, result in zip(batch, results):
                boxes = getattr(result, "boxes", None)
                if boxes is None:
                    continue
                height, width = item["image"].shape[:2]
                for box, confidence in zip(boxes.xyxy.detach().cpu().numpy(),
                                           boxes.conf.detach().cpu().numpy()):
                    x1, y1, x2, y2 = map(float, box)
                    item["persons"].append({"x": _round(x1 / width), "y": _round(y1 / height),
                                            "w": _round((x2 - x1) / width), "h": _round((y2 - y1) / height),
                                            "score": _round(confidence)})
    yolo_sec = perf_counter() - yolo_started

    text_started = perf_counter()
    for item in sampled:
        coverage, boxes = text_regions(item["image"])
        item["text_coverage"] = _round(coverage)
        item["text_boxes"] = boxes
        item["graphic_boxes"] = graphic_regions(item["image"])
        gray = cv2.cvtColor(item["image"], cv2.COLOR_BGR2GRAY)
        item["edge_density"] = _round(float((cv2.Canny(gray, 80, 160) > 0).mean()))
        item["ocr_lines"] = []
    ocr_lines: list[str] = []
    ocr = None
    for item, shot_frames in ocr_candidates(sampled, boundaries):
        ocr = ocr or RUNTIME.load_ocr(config)
        if ocr is None:
            break
        try:
            raw = (list(ocr.predict(item["image"])) if hasattr(ocr, "predict")
                   else ocr.ocr(item["image"], cls=False))
            lines, _, area, _, _ = _parse_ocr_result(raw, item["image"].shape)
        except Exception as error:  # pragma: no cover - optional runtime
            RUNTIME.fail("ocrInference", error)
            break
        lines = deduplicate_ocr_lines(lines, 80)
        item["ocr_lines"] = lines
        # The OCR result describes the whole shot (text layouts are static).
        for frame in shot_frames:
            frame["ocr_coverage"] = _round(area / 100)
        ocr_lines.extend(lines)
    text_sec = perf_counter() - text_started

    assign_tracks(sampled, boundaries)
    mouth_activity(sampled)
    for item in sampled:
        item.pop("image", None)
    runtime = {"decodeSec": _round(decode_sec), "faceSec": _round(face_sec),
               "yoloSec": _round(yolo_sec), "textSec": _round(text_sec),
               "totalSec": _round(perf_counter() - started), "sampledFrames": len(sampled),
               "decodedFrames": index, "shotBoundaries": len(boundaries),
               "faceDetector": detector is not None, "landmarker": landmarker is not None,
               "yolo": model is not None, "yoloFrames": len(yolo_items), "ocr": ocr is not None,
               "failures": dict(RUNTIME.failures)}
    logger.info("Edit analysis completed %s", runtime)
    return {"frames": sampled, "shot_boundaries": boundaries,
            "ocr_text": " ".join(deduplicate_ocr_lines(ocr_lines, 200)), "runtime": runtime}
