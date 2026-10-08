"""Local deterministic pixel QA. Requires Pillow/numpy, no services or network.
Usage: python verify-style-two-visual.py REFERENCE_VIDEO [FFMPEG]
Run verify-style-two-preview.cjs first. All artifacts stay in ignored QA folders.
"""
import json, subprocess, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / '.real-qa-preview/style-two'
PARITY = OUT / 'parity'
REFERENCE = OUT / 'reference'
REFERENCE.mkdir(parents=True, exist_ok=True)
FFMPEG = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / '.cache/ffmpeg-benchmark/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe'
TIMES = [.2, 1, 5, 15, 29, 45, 57]

def rgb(file):
    return np.asarray(Image.open(file).convert('RGB'))

def bounds(mask):
    ys, xs = np.where(mask)
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1] if len(xs) else None

def red_bounds(a):
    # Reference's lower caption band; excluding the speaker's red headwear.
    mask = np.max(np.abs(a.astype(float) - np.array([176, 50, 27])), axis=2) < 25
    mask[:850] = False
    mask[980:] = False
    # Largest connected red region, excluding isolated codec noise/skin pixels.
    pending = mask.copy(); largest = []
    for y, x in zip(*np.where(mask)):
        if not pending[y, x]: continue
        pending[y, x] = False; stack = [(int(y), int(x))]; component = []
        while stack:
            cy, cx = stack.pop(); component.append((cy, cx))
            for ny, nx in [(cy-1, cx), (cy+1, cx), (cy, cx-1), (cy, cx+1)]:
                if 0 <= ny < len(mask) and 0 <= nx < mask.shape[1] and pending[ny, nx]:
                    pending[ny, nx] = False; stack.append((ny, nx))
        if len(component) > len(largest): largest = component
    if len(largest) < 1000: return None
    ys, xs = zip(*largest)
    return [min(xs), min(ys), max(xs)+1, max(ys)+1]

preview, export = rgb(PARITY / 'preview.png'), rgb(PARITY / 'export.png')
assert preview.shape == export.shape == (1920, 1080, 3)
errors = {}
for name, first, last in [('full', 0, 1920), ('hook', 285, 600), ('caption', 1275, 1467)]:
    errors[name] = float(np.abs(preview[first:last].astype(float) - export[first:last]).mean())
    assert errors[name] < 2, (name, errors[name])
mobile = rgb(PARITY / 'preview-mobile.png')
assert mobile.shape == (640, 360, 3)
assert (mobile[510:] == 255).all(), 'mobile lower white region'
pair = Image.new('RGB', (1080 * 2, 1920), 'white')
pair.paste(Image.open(PARITY / 'preview.png'), (0, 0))
pair.paste(Image.open(PARITY / 'export.png'), (1080, 0))
pair.resize((1080, 960)).save(OUT / 'preview-export.png')

measurements = []
montage = Image.new('RGB', (720 * 2 * 4, 1280 * 2), '#eee')
for i, t in enumerate(TIMES):
    ref_file = REFERENCE / f'reference-{t}.png'
    subprocess.run([str(FFMPEG), '-v', 'error', '-ss', str(t), '-i', sys.argv[1], '-frames:v', '1', '-y', str(ref_file)], check=True)
    a = rgb(ref_file)
    assert a.shape == (1280, 720, 3)
    rows = np.where((a.min(2) < 220).mean(1) > .75)[0]
    assert abs(int(rows.min()) - 419) <= 1 and int(rows.max()) == 992
    sample = Image.open(PARITY / f'sample-{t}.png').convert('RGB')
    b = np.asarray(sample)
    assert (b[:285] == 255).all() and (b[1490:] == 255).all()
    assert (b[630, 0] == 128).all() and (b[1489, 0] == 128).all()
    small = sample.resize((720, 1280), Image.Resampling.LANCZOS)
    small_a = np.asarray(small)
    rb, sb = red_bounds(a), red_bounds(small_a)
    if rb:
        assert sb, f'missing caption at {t}'
        assert abs((rb[1] + rb[3]) / 2 - (sb[1] + sb[3]) / 2) <= 5, (t, rb, sb)
        # Reference plates vary slightly by phrase/entrance frame (92..108px).
        assert abs((rb[3] - rb[1]) - (sb[3] - sb[1])) <= 16, (t, rb, sb)
        assert abs((rb[2] - rb[0]) - (sb[2] - sb[0])) <= 35, (t, rb, sb)
    measurements.append({'time': t, 'mediaYInclusive': [int(rows.min()), int(rows.max())],
                         'referenceCaptionBoundsExclusive': rb, 'styleTwoCaptionBoundsExclusive': sb})
    # Same footage as reference to make geometry/font comparison legible. Baked
    # reference captions are retained; this montage is a visual fixture, not a
    # claim of a clean-source automatic generation run.
    source = Image.open(ref_file).crop((0, 419, 720, 993)).resize((1080, 860), Image.Resampling.LANCZOS)
    equivalent = sample.copy()
    underlying = np.asarray(equivalent).copy()
    video = np.asarray(source)
    media = underlying[630:1490]
    gray = np.all(media == 128, axis=2)
    media[gray] = video[gray]
    equivalent = Image.fromarray(underlying).resize((720, 1280), Image.Resampling.LANCZOS)
    equivalent.save(REFERENCE / f'equivalent-{t}.png')
    cell = Image.new('RGB', (1440, 1280), 'white')
    cell.paste(Image.open(ref_file), (0, 0)); cell.paste(equivalent, (720, 0))
    ImageDraw.Draw(cell).text((8, 8), f'{t}s: reference | StyleTwo geometry fixture (emoji omitted)', fill='black')
    cell.save(REFERENCE / f'comparison-{t}.png')
    montage.paste(cell, ((i % 4) * 1440, (i // 4) * 1280))
montage.resize((2160, 960)).save(OUT / 'reference-comparison.png')

# Font alternatives are local system fonts or bundled OFL fonts. System fonts
# appear only in comparison PNGs and are never copied into the repository.
fonts = {'Roboto Condensed Bold': ROOT / 'packages/shared/assets/fonts/RobotoCondensed-Bold.ttf',
         'Anton': ROOT / 'packages/shared/assets/fonts/Anton-Regular.ttf',
         'Impact': Path('C:/Windows/Fonts/impact.ttf'), 'Arial Narrow Bold': Path('C:/Windows/Fonts/ARIALNB.TTF')}
font_metrics = []
comparison = Image.new('RGB', (1000, 850), 'white'); draw = ImageDraw.Draw(comparison)
for section, (name, text, rect) in enumerate([
        ('Hook', '“Being Somali-American is like', (27, 204, 697, 261)),
        ('Caption', "SOMALI ISN'T", (208, 886, 513, 943))]):
    target_w, target_h = rect[2] - rect[0], rect[3] - rect[1]
    draw.text((10, section * 425 + 5), f'{name}: reference {target_w} x {target_h}px', fill='black')
    comparison.paste(Image.open(REFERENCE / 'reference-1.png').crop(rect), (260, section * 425 + 30))
    for n, (family, file) in enumerate(fonts.items()):
        font_size = min(range(35, 100), key=lambda s: abs((lambda b: b[3] - b[1])(ImageFont.truetype(str(file), s).getbbox(text)) - target_h)
                        + abs(ImageFont.truetype(str(file), s).getlength(text) - target_w) / 10)
        font = ImageFont.truetype(str(file), font_size); box = font.getbbox(text)
        tile = Image.new('L', (int(font.getlength(text)) + 10, box[3] - box[1] + 4), 255)
        ImageDraw.Draw(tile).text((0, -box[1]), text, font=font, fill=0)
        font_metrics.append({'role': name, 'font': family, 'size': font_size, 'width': font.getlength(text),
                             'inkHeight': box[3] - box[1], 'darkCoverage': float((np.asarray(tile) < 128).mean())})
        y = section * 425 + 100 + n * 76
        draw.text((10, y + 20), f'{family} {font_size}px', fill='black')
        draw.text((260, y - box[1]), text, font=font, fill='black')
comparison.save(OUT / 'font-comparison.png')

# Existing-style decoded video AND audio must remain byte-for-byte equivalent.
regression = {}
for style in ['stylezero', 'styleone']:
    for stream in ['video', 'audio']:
        before = (OUT / 'before' / f'{style}-{stream}.md5').read_bytes()
        after = (OUT / 'current' / f'{style}-{stream}.md5').read_bytes()
        assert before == after, (style, stream, 'decoded regression')
        regression[f'{style}-{stream}'] = 'identical decoded framemd5'
report = {'pixelMAEOutOf255': errors, 'referenceFrames': measurements, 'fontCandidates': font_metrics,
          'existingStyles': regression, 'limits': ['Exact original font unknown', 'Emoji omitted in fixture',
          'Source already has burned captions and camera motion', 'No new semantic selection/provider run']}
(OUT / 'visual-results.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
