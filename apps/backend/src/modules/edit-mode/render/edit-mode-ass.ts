// EditMode Phase 5 text and caption rendering, extended by Workstream C.
//
// Every TEXT and SUBTITLE element on the canonical timeline becomes one or more
// ASS events, rendered with the canonical element's own stored properties.
// Wording is never regenerated at export time: the content that was saved is the
// content that is drawn, sanitised for libass and nothing more.
//
// The geometry matches the frontend preview exactly - the same normalized
// top-left box, and the same font-size convention the preview's `cqw` sizing
// implements (see FONT_SIZE_CANVAS_DIVISOR).
//
// ============================================================================
// PARITY LIMITATIONS (browser CSS -> ASS/libass)
// ============================================================================
// These are the places where the exported frame is a deterministic CLOSEST
// MATCH rather than a pixel reproduction of the preview. They are listed here,
// reported as render warnings, and asserted by scripts/test-edit-mode-text.cjs -
// none of them is silently papered over.
//
//  1. STROKE + BACKGROUND TOGETHER. ASS draws a plate with BorderStyle 3, which
//     repurposes the Outline field as the plate's padding. An element with both
//     a plate and a stroke therefore renders with the PLATE and no stroke. The
//     preview draws the same choice, so the two still agree.
//  2. CORNER RADIUS. An ASS plate is a rectangle. A non-zero corner radius is
//     drawn in the preview and rendered square in the export.
//  3. SHADOW BLUR. ASS has no independent shadow blur; `\blur` softens the
//     border and shadow together. The stored blur is mapped onto it, so a
//     blurrier shadow is blurrier - but the falloff is not the CSS one.
//  4. LINE SPACING. libass lays lines out on the font's own leading and offers
//     no line-spacing override. The stored multiplier drives the preview and
//     this module's overflow estimate; the exported leading is the font's.
//  5. FONT WEIGHT. ASS carries one boolean Bold, so weights are quantized:
//     >= 600 renders bold, below renders regular.
//
// The frozen auto-pipeline subtitle implementation (src/modules/editing/
// subtitle-renderer.service.ts) is not touched by any of this; EditMode styling
// is isolated.

import { assTime } from '../../editing/subtitle-renderer.service';
import { escapeAssText, sanitizeSubtitleText } from '../../editing/subtitle-text';
import { estimateTextWidth } from '../../editing/text-layout';
import { readTextStyle, resolveEditModeFont } from '../edit-mode-text';
import { AUTOMATIC_2_STREET3_LAYOUT } from '../styles/automatic-2-street3-layout';
import type { RenderCanvas, RenderTextOverlay } from './edit-mode-render.types';

export { EDIT_MODE_FONT_FAMILIES, resolveEditModeFont } from '../edit-mode-text';

/**
 * The preview sizes text at `fontSize / 6` container-query width percent, i.e.
 * `fontSize * canvasWidth / 600` pixels. The renderer uses the same formula so
 * an overlay is the size on the exported frame that the editor showed.
 */
export const FONT_SIZE_CANVAS_DIVISOR = 600;

/** One design unit resolved to canvas pixels. Every text dimension - stroke
 * width, shadow blur and offset, plate padding, letter spacing - uses this
 * single conversion, which is what keeps the export the same picture at any
 * output resolution. */
export const designPx = (value: number, canvasWidth: number) =>
  Math.round(value * canvasWidth / FONT_SIZE_CANVAS_DIVISOR);

export const fontSizePx = (fontSize: number, canvasWidth: number) =>
  Math.max(8, designPx(fontSize, canvasWidth));

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

/** The inline primary-colour override, which carries no alpha. */
const inlineColor = (hex: string) => {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/iu.exec(hex.trim());
  if (!match) return '&HFFFFFF&';
  const [, r, g, b] = match;
  return `&H${b}${g}${r}`.toUpperCase() + '&';
};

export const isTransparent = (color: string) =>
  !color || color === 'transparent' || /^#[0-9a-f]{6}00$/iu.test(color);

/**
 * Wraps a token list to a pixel width, returning the TOKEN INDICES on each
 * line. Indices rather than strings is what lets the active-word highlight know
 * which line a given word landed on. Only breaks are inserted; no token is ever
 * dropped, merged or rewritten.
 */
/** Per-family correction to the sans-serif-tuned width estimate. EB Garamond averages
 * ~0.34 em/char against the estimate's ~0.48, so without this it wraps far too early. */
const FONT_WIDTH_SCALE: Record<string, number> = { 'EB Garamond 12': 0.8 };
/** libass sizes a font by its line height, so EB Garamond renders 0.875x the CSS em at the
 * same number. Scaling by 1/0.875 makes the exported glyphs match the browser preview. */
const FONT_SIZE_SCALE: Record<string, number> = { 'EB Garamond 12': 1 / 0.875 };
export const fontSizeScale = (family: string) => FONT_SIZE_SCALE[resolveEditModeFont(family)] ?? 1;
export const fontWidthScale = (family: string) => FONT_WIDTH_SCALE[resolveEditModeFont(family)] ?? 1;
/** Minimum average advance (em/char) for families the layout fitter measures in the same
 * unit (`AUTOMATIC_2_STREET3_LAYOUT.typography.glyphWidthEm`). The scaled sans estimate
 * alone under-measures long serif lines by ~5 %, so a hook the fitter sized for two lines
 * was emitted as one line wider than the canvas (ASS WrapStyle 2 never re-wraps it). */
const FONT_GLYPH_EM: Record<string, number> = {
  'EB Garamond 12': AUTOMATIC_2_STREET3_LAYOUT.typography.glyphWidthEm };

export function wrapTokens(tokens: string[], fontSize: number, maxWidth: number,
  options: { widthScale?: number; balance?: boolean; glyphWidthEm?: number } = {}): number[][] {
  if (!tokens.length) return [];
  const scale = options.widthScale ?? 1;
  const glyph = options.glyphWidthEm ?? 0;
  const width = (text: string) => Math.max(estimateTextWidth(text, fontSize) * scale,
    glyph * fontSize * text.length);
  const lines: number[][] = [];
  let current: number[] = [];
  let text = '';
  for (let index = 0; index < tokens.length; index++) {
    const candidate = text ? `${text} ${tokens[index]}` : tokens[index];
    if (current.length && width(candidate) > maxWidth) {
      lines.push(current);
      current = [index];
      text = tokens[index];
    } else {
      current.push(index);
      text = candidate;
    }
  }
  if (current.length) lines.push(current);
  // Editorial headlines break evenly: with exactly two lines, move the break to
  // the point that minimises the wider line (each line must still fit).
  if (options.balance && lines.length === 2 && tokens.length > 3) {
    let best = lines;
    let bestWidest = Math.max(...lines.map((line) => width(line.map((at) => tokens[at]).join(' '))));
    for (let cut = 1; cut < tokens.length; cut++) {
      const first = tokens.slice(0, cut).join(' ');
      const second = tokens.slice(cut).join(' ');
      const widest = Math.max(width(first), width(second));
      if (widest <= maxWidth && widest < bestWidest - 1e-6) {
        bestWidest = widest;
        best = [Array.from({ length: cut }, (_, at) => at),
          Array.from({ length: tokens.length - cut }, (_, at) => cut + at)];
      }
    }
    return best;
  }
  return lines;
}

const wrapOptions = (family: string) => {
  const widthScale = fontWidthScale(family);
  const glyphWidthEm = FONT_GLYPH_EM[resolveEditModeFont(family)];
  return widthScale === 1 ? {} : { widthScale, balance: true,
    ...(glyphWidthEm ? { glyphWidthEm } : {}) };
};

/** Back-compat wrapper: the same wrapping, as strings. */
export function wrapToWidth(text: string, fontSize: number, maxWidth: number): string[] {
  const tokens = text.split(/\s+/u).filter(Boolean);
  return wrapTokens(tokens, fontSize, maxWidth)
    .map((line) => line.map((index) => tokens[index]).join(' '));
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

/**
 * Fills in any Workstream C style block an overlay is missing.
 *
 * A RenderTextOverlay can arrive from an older serialized plan - an export that
 * was in flight when the backend restarted - or from a caller that only fills
 * the Phase 5 fields. Style is resolved through the same canonical reader the
 * editor uses, so a missing block is a documented default rather than a crash
 * halfway through a render.
 */
export function withStyleDefaults(overlay: RenderTextOverlay): RenderTextOverlay {
  if (overlay.stroke && overlay.shadow && overlay.background && overlay.activeWord &&
    Array.isArray(overlay.words) && Array.isArray(overlay.textRuns)) return overlay;
  const style = readTextStyle({ backgroundColor: overlay.backgroundColor });
  return {
    ...overlay,
    stroke: overlay.stroke ?? style.stroke,
    shadow: overlay.shadow ?? style.shadow,
    background: overlay.background ?? style.background,
    activeWord: overlay.activeWord ?? style.activeWord,
    textRuns: Array.isArray(overlay.textRuns) ? overlay.textRuns : [],
    letterSpacing: Number.isFinite(overlay.letterSpacing) ? overlay.letterSpacing : 0,
    lineSpacing: Number.isFinite(overlay.lineSpacing) ? overlay.lineSpacing : 1.2,
    rotation: Number.isFinite(overlay.rotation) ? overlay.rotation : 0,
    uppercase: overlay.uppercase === true,
    words: Array.isArray(overlay.words) ? overlay.words : []
  };
}

export type AssBuildResult = { content: string; eventCount: number; overflowed: string[];
  /** Parity notes for elements whose style could not be reproduced exactly. */
  parityNotes: string[] };

/** One drawn span of an overlay: a time range and which token is live in it. */
export type AssSpan = { startSec: number; endSec: number; activeIndex: number };

/**
 * Splits an overlay into the spans ASS actually draws.
 *
 * Without an active-word highlight that is one span. With one it is a span per
 * word plus the gaps between them, each carrying the index of the word that is
 * live - exactly what the preview highlights at the same instant, so the two
 * cannot disagree about which word is lit.
 *
 * The highlight is only ever produced when the stored word list lines up with
 * the stored wording one-for-one. A manually reworded caption therefore falls
 * back to a plain caption rather than lighting the wrong word.
 */
export function assSpans(overlay: RenderTextOverlay, tokenCount: number): AssSpan[] {
  const plain: AssSpan[] = [{ startSec: overlay.startSec, endSec: overlay.endSec,
    activeIndex: -1 }];
  if (!overlay.activeWord.enabled || overlay.words.length !== tokenCount ||
    tokenCount === 0) return plain;
  const spans: AssSpan[] = [];
  let cursor = overlay.startSec;
  overlay.words.forEach((word, index) => {
    const start = Math.max(cursor, Math.min(overlay.endSec, word.start));
    const end = Math.max(start, Math.min(overlay.endSec, word.end));
    if (start > cursor + 1e-6) spans.push({ startSec: cursor, endSec: start, activeIndex: -1 });
    if (end > start + 1e-6) spans.push({ startSec: start, endSec: end, activeIndex: index });
    cursor = Math.max(cursor, end);
  });
  if (overlay.endSec > cursor + 1e-6) {
    spans.push({ startSec: cursor, endSec: overlay.endSec, activeIndex: -1 });
  }
  return spans.length ? spans : plain;
}

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
  const parityNotes: string[] = [];
  const ordered = [...overlays].sort((left, right) => left.zIndex - right.zIndex ||
    left.startSec - right.startSec);

  ordered.forEach((raw, index) => {
    const overlay = withStyleDefaults(raw);
    const text = sanitizeSubtitleText(overlay.content.replace(/\r?\n/gu, ' '));
    if (!text) return;
    const styleName = `Edit${index}`;
    const boxed = overlay.background.enabled && overlay.background.opacity > 0;
    const stroked = overlay.stroke.enabled && overlay.stroke.width > 0;
    if (boxed && stroked) {
      parityNotes.push(`${overlay.elementId}: ASS draws a plate OR a stroke, not both; the ` +
        'plate is rendered and the stroke is dropped.');
    }
    if (boxed && overlay.background.radius > 0) {
      parityNotes.push(`${overlay.elementId}: rounded caption plates render as square ` +
        'rectangles; ASS has no corner radius.');
    }
    // libass's natural leading is about 1.2x, which is also the default, so only
    // a line spacing the user actually changed is worth reporting - and only on
    // text that has more than one line for it to affect.
    if (Math.abs(overlay.lineSpacing - 1.2) > 0.01 &&
      wrapTokens(text.split(' ').filter(Boolean), overlay.fontSizePx,
        Math.max(1, overlay.width), wrapOptions(overlay.fontFamily)).length > 1) {
      parityNotes.push(`${overlay.elementId}: line spacing shapes the preview only; libass ` +
        "lays lines out on the font's own leading.");
    }

    // Outline / plate. In BorderStyle 3 the Outline field is the plate's
    // padding and OutlineColour is the plate itself; in BorderStyle 1 they are
    // the stroke's width and colour. An unstyled element keeps the legible dark
    // stroke Phase 5 always drew, so nothing regresses.
    const outlineWidth = boxed ? designPx(overlay.background.padding, canvas.width)
      : stroked ? Math.max(1, designPx(overlay.stroke.width, canvas.width))
        : Math.max(1, Math.round(overlay.fontSizePx * 0.07));
    const outlineColour = boxed
      ? toAssColor(overlay.background.color, overlay.background.opacity * overlay.opacity)
      : stroked ? toAssColor(overlay.stroke.color, overlay.opacity)
        : toAssColor('#000000', overlay.opacity);
    // BackColour is the drop shadow's colour.
    const shadowOn = overlay.shadow.enabled && overlay.shadow.opacity > 0;
    const shadowColour = shadowOn
      ? toAssColor(overlay.shadow.color, overlay.shadow.opacity * overlay.opacity)
      : toAssColor('#000000', 0);
    // ASS carries one shadow DISTANCE in the style; the signed per-axis offsets
    // are applied as \xshad/\yshad overrides below.
    const shadowDistance = shadowOn
      ? Math.max(0, designPx(Math.max(Math.abs(overlay.shadow.offsetX),
        Math.abs(overlay.shadow.offsetY)), canvas.width))
      : 0;
    // CSS rotates clockwise; the ASS Angle field rotates counter-clockwise.
    const angle = Number((-overlay.rotation).toFixed(3));

    lines.push(`Style: ${styleName},${resolveEditModeFont(overlay.fontFamily)},` +
      `${Math.round(overlay.fontSizePx * fontSizeScale(overlay.fontFamily))},${toAssColor(overlay.color, overlay.opacity)},` +
      `${toAssColor(overlay.color, overlay.opacity)},${outlineColour},${shadowColour},` +
      `${overlay.fontWeight >= 600 ? -1 : 0},0,0,0,100,100,` +
      `${designPx(overlay.letterSpacing, canvas.width)},${angle},` +
      `${boxed ? 3 : 1},${outlineWidth},${shadowDistance},` +
      `${alignmentFor(overlay.textAlign)},0,0,0,1`);

    // Stored line breaks are authored breaks and are always honoured; each
    // resulting line is then wrapped to the element's own width.
    const tokens = text.split(' ').filter(Boolean);
    const staticColors: string[] = [];
    if (overlay.textRuns.length && overlay.textRuns.map((run) => run.text).join('') === overlay.content) {
      const ranges: Array<{ start: number; end: number; color: string }> = [];
      let cursor = 0;
      for (const run of overlay.textRuns) {
        ranges.push({ start: cursor, end: cursor + run.text.length, color: run.color });
        cursor += run.text.length;
      }
      for (const match of overlay.content.matchAll(/\S+/gu)) {
        const at = match.index ?? 0;
        staticColors.push(ranges.find((range) => at >= range.start && at < range.end)?.color ?? overlay.color);
      }
    }
    const wrapped = wrapTokens(tokens, overlay.fontSizePx, Math.max(1, overlay.width),
      wrapOptions(overlay.fontFamily));
    const rendered = wrapped.length ? wrapped : [tokens.map((_, at) => at)];
    const blockHeight = rendered.length * overlay.fontSizePx * 1.2;
    if (blockHeight > overlay.height * 1.35 + 1) overflowed.push(overlay.elementId);
    const anchor = anchorPoint(overlay);

    const prefix = [`\\pos(${anchor.x},${anchor.y})`];
    if (shadowOn && (overlay.shadow.offsetX !== 0 || overlay.shadow.offsetY !== 0)) {
      prefix.push(`\\xshad(${designPx(overlay.shadow.offsetX, canvas.width)})`,
        `\\yshad(${designPx(overlay.shadow.offsetY, canvas.width)})`);
    }
    if (shadowOn && overlay.shadow.blur > 0) {
      // The closest deterministic match ASS offers: \blur softens border and
      // shadow together. Documented above as a parity limitation.
      prefix.push(`\\blur${Math.max(0.5,
        Number((overlay.shadow.blur / 6).toFixed(2)))}`);
    }
    const head = `{${prefix.join('')}}`;
    const base = inlineColor(overlay.color);
    const body = (activeIndex: number) => rendered.map((line) => line.map((at) => {
      const color = at === activeIndex ? overlay.activeWord.color : staticColors[at];
      return color && color.toLowerCase() !== overlay.color.toLowerCase()
        ? `{\\1c${inlineColor(color)}}${escapeAssText(tokens[at])}{\\1c${base}}`
        : escapeAssText(tokens[at]);
    }).join(' ')).join('\\N');

    for (const span of assSpans(overlay, tokens.length)) {
      if (!(span.endSec > span.startSec)) continue;
      events.push(`Dialogue: ${overlay.zIndex},${assTime(span.startSec)},` +
        `${assTime(span.endSec)},${styleName},,0,0,0,,${head}${body(span.activeIndex)}`);
    }
  });

  lines.push('', '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text', ...events);
  return { content: `${lines.join('\n')}\n`, eventCount: events.length, overflowed,
    parityNotes: [...new Set(parityNotes)] };
}
