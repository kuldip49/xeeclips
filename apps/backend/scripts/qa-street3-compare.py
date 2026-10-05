"""Automatic 2 vs street3.mp4 geometry QA.

Usage: python qa-street3-compare.py <street3.mp4> <generated.mp4|frame.png ...> [--ffmpeg PATH]

Samples the reference and each generated MP4 at 0/10/25/50/75/90/100 % and measures, per frame:
  media window (y0,y1,x-extent), hook ink block, supporting-line ink block.
Then checks that visible media stays inside the fixed reference window and
compares black-space proportions and block positions with the reference.
FIT shots can have black padding inside the window, so visible pixels are not
required to reach its edges.
Content is never compared - only geometry.
"""
import subprocess, sys, tempfile, os, json
import numpy as np
from PIL import Image

args = [a for a in sys.argv[1:] if not a.startswith('--')]
ff = 'ffmpeg'
if '--ffmpeg' in sys.argv:
    ff = sys.argv[sys.argv.index('--ffmpeg') + 1]
    args = [a for a in args if a != ff]
ref, gens = args[0], args[1:]
W, H = 1080, 1920


def duration(path):
    out = subprocess.run([ff.replace('ffmpeg', 'ffprobe'), '-v', 'error', '-show_entries', 'format=duration',
                          '-of', 'csv=p=0', path], capture_output=True, text=True).stdout
    return float(out.strip())


def frames(path):
    d = duration(path)
    tmp = tempfile.mkdtemp()
    out = []
    for i, p in enumerate([0.0, .1, .25, .5, .75, .9, 1.0]):
        t = max(0.0, min(d - 0.1, d * p))
        f = os.path.join(tmp, f'{i}.png')
        subprocess.run([ff, '-v', 'error', '-y', '-ss', f'{t:.3f}', '-i', path, '-frames:v', '1', f], check=True)
        out.append((p, np.array(Image.open(f).convert('RGB')).max(axis=2)))
    return out


def blocks(mask_rows, gap=14):
    ys = np.where(mask_rows)[0]
    groups, start, prev = [], None, None
    for y in ys:
        if start is None:
            start = prev = y
        elif y - prev > gap:
            groups.append((int(start), int(prev))); start = prev = y
        else:
            prev = y
    if start is not None:
        groups.append((int(start), int(prev)))
    return groups


def frac(g):
    return (g > 3).mean(axis=1)


def window(fs):
    """Media window from the union over all sampled frames (dark shots hide rows)."""
    best = np.max([frac(g) for _, g in fs], axis=0)
    runs = [r for r in blocks(best > 0.85, gap=3) if r[1] - r[0] > 150]
    if not runs:
        # A portrait screen/presentation fitted into the card may occupy far
        # less than the full width. Keep the tall picture run, not the hook.
        runs = [r for r in blocks(best > 0.1, gap=3) if r[1] - r[0] > 150]
    m0, m1 = max(runs, key=lambda r: r[1] - r[0])
    return m0, m1 + 1


def measure(g, win):
    m0, m1 = win
    rows = (g > 100).sum(axis=1) > 2
    above = blocks(rows[:m0 - 1])
    below = blocks(rows[m1 + 2:])
    f = frac(g)
    res = {'outside_full_rows': int((np.r_[f[:m0 - 2], f[m1 + 2:]] > 0.85).sum())}
    if above:
        a0, a1 = above[0][0], above[-1][1]
        xs = np.where((g[a0:a1 + 1] > 100).sum(axis=0) > 0)[0]
        res['hook'] = (a0, a1 + 1, int(xs.min()), int(xs.max()))
    if below:
        b0, b1 = below[0][0] + m1 + 2, below[-1][1] + m1 + 2
        xs = np.where((g[b0:b1 + 1] > 100).sum(axis=0) > 0)[0]
        res['support'] = (b0, b1 + 1, int(xs.min()), int(xs.max()))
    return res


def summarize(name, fs):
    win = window(fs)
    rows = [(p, measure(g, win)) for p, g in fs]
    print(f'== {name}  media window y={win[0]}..{win[1]} (h={win[1] - win[0]})')
    for p, r in rows:
        print(f'  {int(p * 100):3d}%  {r}')
    return win, rows


ref_win, ref_rows = summarize('reference', frames(ref))
ok = True
r0 = {k: v for k, v in ref_rows[-1][1].items() if k != 'outside_full_rows'}
for gpath in gens:
    generated = frames(gpath)
    visible_win = window(generated)
    print(f'== {os.path.basename(gpath)} visible media y={visible_win[0]}..{visible_win[1]} '
          f'(fixed card y={ref_win[0]}..{ref_win[1]})')
    rows = [(p, measure(g, ref_win)) for p, g in generated]
    for p, r in rows:
        print(f'  {int(p * 100):3d}%  {r}')
    stray = sum(r['outside_full_rows'] for _, r in rows)
    print(f'  rows outside the media window that are full-width picture: {stray} (must be 0)')
    ok &= stray == 0
    inside = visible_win[0] >= ref_win[0] - 3 and visible_win[1] <= ref_win[1] + 3
    print(f'  visible media inside fixed reference window: {inside}')
    ok &= inside
    for key in ('hook', 'support'):
        gr = [r[key] for _, r in rows if key in r]
        if gr and key in r0:
            print(f'  {key}: gen y={gr[0][0]}..{gr[0][1]} x={gr[0][2]}..{gr[0][3]}  '
                  f'ref y={r0[key][0]}..{r0[key][1]} x={r0[key][2]}..{r0[key][3]}')
print(json.dumps({'ok': bool(ok)}))
sys.exit(0 if ok else 1)
