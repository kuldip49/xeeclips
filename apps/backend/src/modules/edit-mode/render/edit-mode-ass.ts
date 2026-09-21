// EditMode Phase 5 text and caption rendering.
//
// Every TEXT, SUBTITLE and preset HOOK element on the canonical timeline becomes
// one ASS event, rendered with the canonical element's own stored properties.
// Wording is never regenerated at export time: the content that was saved is the
// content that is drawn, sanitised for libass and nothing more.
//
// The geometry matches the frontend preview exactly - the same normalized
// top-left box, and the same font-size convention the preview's `cqw` sizing
// implements (see FONT_SIZE_CANVAS_DIVISOR).

import { assTime } from '../../editing/subtitle-renderer.service';
import { escapeAssText, sanitizeSubtitleText } from '../../editing/subtitle-text';
import { estimateTextWidth } from '../../editing/text-layout';
import type { RenderCanvas, RenderTextOverlay } from './edit-mode-render.types';

/**
 * The preview sizes text at `fontSize / 6` container-query width percent, i.e.
 * `fontSize * canvasWidth / 600` pixels. The renderer uses the same formula so
 * an overlay is the size on the exported frame that the editor showed.
 */
export const FONT_SIZE_CANVAS_DIVISOR = 600;

export const fontSizePx = (fontSize: number, canvasWidth: number) =>
  Math.max(8, Math.round(fontSize * canvasWidth / FONT_SIZE_CANVAS_DIVISOR));

/** Families the element schema allows, mapped to faces the backend image has.
 * Nothing is downloaded: an unavailable family resolves through fontconfig to
 * the image's own fallback. */
export const EDIT_MODE_FONT_FAMILIES: Record<string, string> = {
  'Arial, sans-serif': 'DejaVu Sans',
  'Georgia, serif': 'DejaVu Serif',
  monospace: 'DejaVu Sans Mono'
};

export const resolveEditModeFont = (family: string) =>
  EDIT_MODE_FONT_FAMILIES[family] ?? EDIT_MODE_FONT_FAMILIES['Arial, sans-serif'];

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** `#rrggbb` / `#rrggbbaa` -> ASS `&HAABBGGRR`, with an extra opacity multiplier. */
export function toAssColor(hex: string, opacity = 1): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/iu.exec(hex.trim());
  if (!match) return '&H00FFFFFF';
  const [, r, g, b, a] = match;
  const alpha = a === undefined ? 1 : parseInt(a, 16) / 255;
  // ASS alpha is inverted: 00 is opaque, FF is fully transparent.
  const value = Math.round((1 - clamp01(alpha * clamp01(opacity))) * 255);
  return `&H${value.toString(16).padStart(2, '0')}${b}${g}${r}`.toUpperCase();
}

export const isTransparent = (color: string) =>
  !color || color === 'transparent' || /^#[0-9a-f]{6}00$/iu.test(color);

/**
 * Wraps one line of text to a pixel width using the shared width estimate.
 * Only inserts breaks; it never drops or rewrites a word.
 */
export function wrapToWidth(text: string, fontSize: number, maxWidth: number): string[] {
  const words = text.split(/\s+/u).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && estimateTextWidth(candidate, fontSize) > maxWidth) {
      lines.push(current);
      current = word;
    } else current = candidate;
  }
  if (current) lines.push(current);
  return lines;
}

/** ASS alignment for a middle-anchored box: 4 left, 5 centre, 6 right. */
const alignmentFor = (textAlign: RenderTextOverlay['textAlign']) =>
  textAlign === 'left' ? 4 : textAlign === 'right' ? 6 : 5;

/** The anchor point inside the element box that `\pos` addresses. */
export function anchorPoint(overlay: RenderTextOverlay) {
  const y = Math.round(overlay.y + overlay.height / 2);
  if (overlay.textAlign === 'left') return { x: Math.round(overlay.x), y };
  if (overlay.textAlign === 'right') return { x: Math.round(overlay.x + overlay.width), y };
  return { x: Math.round(overlay.x + overlay.width / 2), y };
}

export type AssBuildResult = { content: string; eventCount: number; overflowed: string[] };

/**
 * Builds the single ASS file the render graph burns in.
 *
 * Events are emitted in zIndex order and carry their zIndex as the ASS layer,
 * so the canonical stacking is what libass composites - captions over a hook
 * plate, a hook over a lower-third, exactly as the timeline says.
 */
export function buildEditModeAss(canvas: RenderCanvas,
  overlays: RenderTextOverlay[]): AssBuildResult {
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${canvas.width}`,
    `PlayResY: ${canvas.height}`, 'ScaledBorderAndShadow: yes', 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,' +
      'Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,' +
      'Alignment,MarginL,MarginR,MarginV,Encoding'
  ];
  const events: string[] = [];
  const overflowed: string[] = [];
  const ordered = [...overlays].sort((left, right) => left.zIndex - right.zIndex ||
    left.startSec - right.startSec);

  ordered.forEach((overlay, index) => {
    const text = sanitizeSubtitleText(overlay.content.replace(/\r?\n/gu, ' '));
    if (!text) return;
    const styleName = `Edit${index}`;
    const boxed = !isTransparent(overlay.backgroundColor);
    const outline = boxed ? Math.max(2, Math.round(overlay.fontSizePx * 0.16))
      : Math.max(1, Math.round(overlay.fontSizePx * 0.07));
    lines.push(`Style: ${styleName},${resolveEditModeFont(overlay.fontFamily)},` +
      `${overlay.fontSizePx},${toAssColor(overlay.color, overlay.opacity)},` +
      `${toAssColor(overlay.color, overlay.opacity)},` +
      // Unboxed text keeps a dark stroke so it stays legible over any footage.
      `${boxed ? toAssColor(overlay.backgroundColor, overlay.opacity) : toAssColor('#000000', overlay.opacity)},` +
      `${boxed ? toAssColor(overlay.backgroundColor, overlay.opacity) : toAssColor('#00000080', overlay.opacity)},` +
      `${overlay.fontWeight >= 600 ? -1 : 0},0,0,0,100,100,0,0,${boxed ? 3 : 1},${outline},` +
      `${boxed ? 0 : Math.max(1, Math.round(overlay.fontSizePx * 0.05))},` +
      `${alignmentFor(overlay.textAlign)},0,0,0,1`);

    // Stored line breaks are authored breaks and are always honoured; each
    // resulting line is then wrapped to the element's own width.
    const authored = text.split(' ');
    const wrapped = authored.flatMap((line) =>
      wrapToWidth(line, overlay.fontSizePx, Math.max(1, overlay.width)));
    const rendered = wrapped.length ? wrapped : authored;
    const blockHeight = rendered.length * overlay.fontSizePx * 1.2;
    if (blockHeight > overlay.height * 1.35 + 1) overflowed.push(overlay.elementId);
    const anchor = anchorPoint(overlay);
    const body = rendered.map((line) => escapeAssText(line)).join('\\N');
    events.push(`Dialogue: ${overlay.zIndex},${assTime(overlay.startSec)},` +
      `${assTime(overlay.endSec)},${styleName},,0,0,0,,` +
      `{\\pos(${anchor.x},${anchor.y})}${body}`);
  });

  lines.push('', '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text', ...events);
  return { content: `${lines.join('\n')}\n`, eventCount: events.length, overflowed };
}
