import { STYLE_TWO, usesStyleTwoVectors, styleTwoText, assPath, roundedRect, type PathCommand } from '@ai-content-platform/shared/style-two.cjs';
import { assTime } from '../../editing/subtitle-renderer.service';
import { escapeAssText } from '../../editing/subtitle-text';
import type { RenderTextOverlay } from './edit-mode-render.types';

// Isolated vector lettering + rounded plate. The exact licensed outlines are
// also drawn by StyleTwoPreviewText; generic ASS/StyleOne rendering is untouched.
export function styleTwoAss(overlay: RenderTextOverlay, canvasWidth: number,
  color: (hex: string, opacity?: number) => string) {
  if (!usesStyleTwoVectors(overlay)) return null;
  const scale = canvasWidth / 600;
  const text = styleTwoText({ ...overlay, fontSize: overlay.fontSizePx,
    fontFamily: overlay.fontFamily, lineHeight: overlay.lineSpacing,
    letterSpacing: overlay.letterSpacing * scale,
    boxed: overlay.background.enabled, padding: overlay.background.padding, radius: overlay.background.radius, scale });
  if (!text) return null;
  if (!text.lines.length) return { events: [], overflow: false, fallback: false, truncated: false };
  const event = (body: string, layer = overlay.zIndex) =>
    `Dialogue: ${layer},${assTime(overlay.startSec)},${assTime(overlay.endSec)},StyleTwoVector,,0,0,0,,${body}`;
  const radians = overlay.rotation * Math.PI / 180;
  const centerX = overlay.x + overlay.width / 2, centerY = overlay.y + overlay.height / 2;
  const transform = (commands: PathCommand[], offsetX: number, offsetY: number) => commands.map(([kind, ...values]) => {
    const points: number[] = [];
    for (let i = 0; i < values.length; i += 2) {
      const x = values[i] + offsetX - centerX, y = values[i + 1] + offsetY - centerY;
      points.push(centerX + x * Math.cos(radians) - y * Math.sin(radians),
        centerY + x * Math.sin(radians) + y * Math.cos(radians));
    }
    return [kind, ...points] as PathCommand;
  });
  const draw = (commands: PathCommand[], fill: string, opacity: number, border: number, outline: string,
    offsetX = 0, offsetY = 0, blur = 0) => {
      const primary = color(fill, opacity), edge = color(outline, opacity);
      return event(`{\\an7\\pos(0,0)\\p1\\bord${border}\\blur${blur}` +
        `\\shad0\\alpha&H${primary.slice(2, 4)}&\\1c&H${primary.slice(4)}&\\3c&H${edge.slice(4)}&}${assPath(transform(commands, offsetX, offsetY))}{\\p0}`);
    };
  const events: string[] = [];
  const shadow = overlay.shadow;
  if (overlay.background.enabled) {
    const plate = roundedRect(text.plate);
    if (shadow.enabled) events.push(draw(plate, shadow.color, shadow.opacity * overlay.opacity,
      0, shadow.color, shadow.offsetX * scale, shadow.offsetY * scale, shadow.blur * scale / 2));
    events.push(draw(plate, overlay.background.color, overlay.background.opacity * overlay.opacity,
      STYLE_TWO.edgeWidth * scale, STYLE_TWO.edge));
  }
  const lettering = text.paths.flat();
  if (lettering.length) {
    if (shadow.enabled) events.push(draw(lettering, shadow.color, shadow.opacity * overlay.opacity,
      0, shadow.color, shadow.offsetX * scale, shadow.offsetY * scale, shadow.blur * scale / 2));
    events.push(draw(lettering, overlay.color, overlay.opacity,
      overlay.stroke.enabled ? overlay.stroke.width * scale : 0, overlay.stroke.color));
  }
  // Full Unicode still uses libass's existing fallback chain when a glyph isn't
  // in the Latin outline subset. No emoji is inserted by the template.
  for (const glyph of text.fallback) {
    const [, x, y] = transform([['m', glyph.x, glyph.y - glyph.size]], 0, 0)[0];
    const primary = color(overlay.color, overlay.opacity);
    const alignment = glyph.anchor === 'middle' ? 8 : glyph.anchor === 'end' ? 9 : 7;
    events.push(event(`{\\an${alignment}\\pos(${x},${y})\\frz${-overlay.rotation}` +
      `\\fn${overlay.fontFamily.split(',')[0]}\\fs${glyph.size}\\bord0\\shad0` +
      `\\alpha&H${primary.slice(2, 4)}&\\1c&H${primary.slice(4)}&}${escapeAssText(glyph.text)}`));
  }
  return { events, overflow: text.overflow, fallback: text.fallback.length > 0, truncated: text.truncated };
}
