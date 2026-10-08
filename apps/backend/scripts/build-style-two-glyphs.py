"""Rebuild the shared Latin/punctuation outlines from bundled OFL static fonts.
Development-only dependency: fontTools. Runtime/browser/export use the JSON.
"""
import json
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen

ROOT = Path(__file__).resolve().parents[3]
class Pen(BasePen):
    def __init__(self, glyphs):
        super().__init__(glyphs); self.commands = []
    def _moveTo(self, p): self.commands.append(['m', *p])
    def _lineTo(self, p): self.commands.append(['l', *p])
    def _curveToOne(self, p1, p2, p3): self.commands.append(['b', *p1, *p2, *p3])
    def _closePath(self): self.commands.append(['c'])
    def _endPath(self): pass

result = {}
for role, file in [('hook', 'RobotoCondensed-Bold.ttf'), ('caption', 'Anton-Regular.ttf')]:
    font = TTFont(ROOT / 'packages/shared/assets/fonts' / file)
    glyph_set = font.getGlyphSet(); cmap = font.getBestCmap(); units = font['head'].unitsPerEm
    glyphs = {}
    for char in list(range(32, 592)) + list(range(0x2010, 0x203b)) + [0x20ac, 0x2122]:
        if char not in cmap: continue
        glyph = cmap[char]; pen = Pen(glyph_set); glyph_set[glyph].draw(pen)
        glyphs[chr(char)] = {'advance': font['hmtx'][glyph][0] / units, 'path': [[p[0], *[
            round(v / units * (1 if i % 2 == 0 else -1), 6) for i, v in enumerate(p[1:])]] for p in pen.commands]}
    result[role] = {'family': 'Roboto Condensed' if role == 'hook' else 'Anton', 'glyphs': glyphs,
                    'cap': font['OS/2'].sCapHeight / units, 'ascent': font['hhea'].ascent / units,
                    'descent': font['hhea'].descent / units}
(ROOT / 'packages/shared/style-two-glyphs.json').write_text(json.dumps(result, separators=(',', ':')))
