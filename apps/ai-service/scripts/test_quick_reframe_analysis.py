import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from app.quick_reframe_analysis import ocr_boxes, black_bars
polygon = np.array([[10, 20], [90, 20], [90, 30], [10, 30]])
boxes = ocr_boxes([{'res': {'rec_polys': [polygon], 'rec_texts': ['Useful hook'], 'rec_scores': [.96]}}], (100, 100, 3))
assert len(boxes) == 1 and boxes[0]['text'] == 'Useful hook'
assert boxes[0]['x'] == .1 and boxes[0]['y'] == .2 and boxes[0]['confidence'] == .96
image = np.full((100, 100, 3), 128, np.uint8)
image[:10] = 0
image[-5:] = 0
bars = black_bars(image)
assert bars['top'] == .1 and bars['bottom'] == .05 and bars['left'] == 0
print('Quick Reframe nested OCR geometry/confidence and bounded black-bar detection passed.')
