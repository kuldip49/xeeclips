"""Bounded short-video sampling, with per-time OCR geometry, reusing local visual models."""
from pathlib import Path
import cv2
import numpy as np
from app.edit_analysis import analyze_edit_window
from app.visual_analysis import RUNTIME, VisualConfig, _walk_dicts


def ocr_boxes(raw, shape):
    height, width = shape[:2]
    found = []
    records = list(_walk_dicts(raw))
    for item in records or raw or []:
        if isinstance(item, dict):
            polys = item.get('rec_polys', item.get('dt_polys', []))
            rows = zip(polys, item.get('rec_texts', []), item.get('rec_scores', []))
        elif isinstance(item, list):
            rows = ((r[0], r[1][0], r[1][1]) for r in item if isinstance(r, list) and len(r) == 2)
        else:
            continue
        for polygon, text, score in rows:
            points = np.asarray(polygon)
            if points.ndim != 2 or points.shape[1] != 2:
                continue
            x0, y0 = np.maximum(points.min(axis=0), [0, 0])
            x1, y1 = np.minimum(points.max(axis=0), [width, height])
            if x1 > x0 and y1 > y0:
                found.append(dict(x=round(float(x0 / width), 4), y=round(float(y0 / height), 4),
                                  w=round(float((x1-x0)/width), 4), h=round(float((y1-y0)/height), 4),
                                  text=str(text), confidence=round(float(score), 4)))
    return found


def black_bars(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    rows, columns = (gray < 12).mean(axis=1), (gray < 12).mean(axis=0)
    def edge(values):
        count = 0
        for v in values[:max(1, len(values)//5)]:
            if v < .98:
                break
            count += 1
        return round(count / len(values), 4)
    return dict(top=edge(rows), bottom=edge(rows[::-1]), left=edge(columns), right=edge(columns[::-1]))


def analyze_quick_reframe(path: Path):
    capture = cv2.VideoCapture(str(path))
    duration = capture.get(cv2.CAP_PROP_FRAME_COUNT) / max(1, capture.get(cv2.CAP_PROP_FPS))
    if duration <= 0 or duration > 180.05:
        capture.release()
        raise ValueError('Video must be at most 180 seconds')
    # Reuse subject tracks/scene detection; OCR below never extrapolates a shot-wide layout.
    result = analyze_edit_window(path, fps=1, max_frames=180, run_ocr=False)
    ocr = RUNTIME.load_ocr(VisualConfig(), cpu_threads=2)
    frames = result['frames']
    # Base engine provides representative subject tracks and frame-level scene boundaries.
    result['runtime']['ocr'] = ocr is not None
    previous_signature = None
    previous_boxes = []
    try:
        for item in frames:
            capture.set(cv2.CAP_PROP_POS_MSEC, item['t'] * 1000)
            ok, image = capture.read()
            if not ok:
                continue
            if image.shape[1] > 960:
                image = cv2.resize(image, (960, round(image.shape[0]*960/image.shape[1])))
            item['bars'] = black_bars(image)
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            item['brightness'] = round(float(gray.mean()) / 255, 4)
            item['contrast'] = round(float(gray.std()) / 255, 4)
            if ocr is not None:
                try:
                    # Verify a text-layout signature before reusing OCR; changing wording,
                    # moving overlays, or scene cuts force fresh recognition.
                    mask = np.zeros(image.shape[:2], dtype=np.uint8)
                    for box in item.get('text_boxes', []) + item.get('graphic_boxes', []):
                        x, y = round(box['x']*image.shape[1]), round(box['y']*image.shape[0])
                        w, h = round(box['w']*image.shape[1]), round(box['h']*image.shape[0])
                        mask[y:y+h, x:x+w] = (gray[y:y+h, x:x+w] > 190) * 255
                    signature = cv2.resize(mask, (160, 160), interpolation=cv2.INTER_AREA)
                    stable = np.count_nonzero(mask) > 0 and previous_signature is not None and float(np.abs(signature.astype(float)-previous_signature).mean()) < .3
                    near_cut = any(abs(item['t']-cut)<1.1 for cut in result['shot_boundaries'])
                    if stable and not near_cut:
                        item['ocr_boxes'] = previous_boxes
                    else:
                        raw = list(ocr.predict(image, text_det_limit_side_len=640, text_det_limit_type='max', text_rec_score_thresh=.5)) if hasattr(ocr, 'predict') else ocr.ocr(image, cls=False)
                        item['ocr_boxes'] = ocr_boxes(raw, image.shape)
                    previous_signature, previous_boxes = signature, item['ocr_boxes']
                except Exception:
                    result['runtime']['ocr'] = False
                    ocr = None
    finally:
        capture.release()
    return result
