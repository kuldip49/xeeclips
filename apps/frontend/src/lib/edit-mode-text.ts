import type { CSSProperties } from 'react';

/**
 * The editor's half of the text and caption style contract.
 *
 * Every constant, bound and preset here MIRRORS
 * apps/backend/src/modules/edit-mode/edit-mode-text.ts. The mirror exists so the
 * preview can draw a styled element without a round trip; it is not a second
 * source of truth, and `GET /edit-mode/text-styles` plus the parity test in
 * apps/backend/scripts/test-edit-mode-text.cjs are what stop the two drifting.
 *
 * UNITS. Every size below - fontSize, stroke width, shadow blur and offset,
 * plate padding and radius, letter spacing - is a DESIGN UNIT on a 600-wide
 * canvas, exactly as the renderer's `designPx` reads it. The preview resolves
 * them against the MEASURED width of its canvas with the same arithmetic, so a
 * value is the same fraction of the frame in the editor and in the MP4 at any
 * window size and any output resolution.
 */

export const DESIGN_CANVAS_UNITS = 600;

/** One design unit in canvas pixels. The browser half of the renderer's
 * `designPx` - deliberately the same formula, not an approximation of it. */
export const designPx = (value: number, canvasWidth: number) =>
  value * canvasWidth / DESIGN_CANVAS_UNITS;

export type TextStroke = { enabled: boolean; color: string; width: number };
export type TextShadow = { enabled: boolean; color: string; opacity: number; blur: number;
  offsetX: number; offsetY: number };
export type TextBackground = { enabled: boolean; color: string; opacity: number;
  padding: number; radius: number };
export type ActiveWordStyle = { enabled: boolean; color: string };

export type TextStyle = {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  textAlign: 'left' | 'center' | 'right';
  opacity: number;
  stroke: TextStroke;
  shadow: TextShadow;
  background: TextBackground;
  letterSpacing: number;
  lineSpacing: number;
  uppercase: boolean;
  activeWord: ActiveWordStyle;
};

/** One transcript word, in seconds relative to the element's own start. */
export type CaptionWord = { start: number; end: number; text: string };
export type TextRun = { text: string; color: string };

export const TEXT_BOUNDS = {
  minFontSize: 8, maxFontSize: 300,
  minFontWeight: 100, maxFontWeight: 900,
  maxStrokeWidth: 40,
  maxShadowBlur: 60, maxShadowOffset: 60,
  maxBackgroundPadding: 120, maxBackgroundRadius: 120,
  minLetterSpacing: -20, maxLetterSpacing: 60,
  minLineSpacing: 0.6, maxLineSpacing: 3,
  maxTextLength: 2000, maxCaptionLength: 500
} as const;

/** Families the editor offers. The label is what the picker shows; the CSS stack
 * is what the preview draws with, and the id is what the element stores. */
export const EDIT_MODE_FONTS: Array<{ id: string; label: string; css: string }> = [
  { id: 'Inter, sans-serif', label: 'Inter', css: 'Inter, "Noto Sans", system-ui, sans-serif' },
  { id: 'Inter ExtraBold, sans-serif', label: 'Inter Display',
    css: 'Inter, "Noto Sans", system-ui, sans-serif' },
  { id: 'Noto Sans, sans-serif', label: 'Noto Sans', css: '"Noto Sans", system-ui, sans-serif' },
  { id: 'Noto Serif, serif', label: 'Noto Serif', css: '"Noto Serif", Georgia, serif' },
  { id: 'EB Garamond, serif', label: 'EB Garamond', css: '"EB Garamond", Garamond, Georgia, serif' },
  { id: 'Arial, sans-serif', label: 'Sans (legacy)', css: 'Arial, Helvetica, sans-serif' },
  { id: 'Georgia, serif', label: 'Serif (legacy)', css: 'Georgia, "Times New Roman", serif' },
  { id: 'monospace', label: 'Mono (legacy)', css: 'ui-monospace, "Noto Sans Mono", monospace' }
];

export const EDIT_MODE_FONT_IDS = EDIT_MODE_FONTS.map((font) => font.id);

export const fontCss = (id: string) =>
  EDIT_MODE_FONTS.find((font) => font.id === id)?.css ?? EDIT_MODE_FONTS[0].css;

export const NEUTRAL_STROKE: TextStroke = { enabled: false, color: '#000000', width: 4 };
export const NEUTRAL_SHADOW: TextShadow = { enabled: false, color: '#000000', opacity: 0.6,
  blur: 6, offsetX: 2, offsetY: 3 };
export const NEUTRAL_BACKGROUND: TextBackground = { enabled: false, color: '#000000',
  opacity: 0.6, padding: 12, radius: 8 };
export const NEUTRAL_ACTIVE_WORD: ActiveWordStyle = { enabled: false, color: '#ffe066' };

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'Inter, sans-serif', fontSize: 48, fontWeight: 700, color: '#ffffff',
  textAlign: 'center', opacity: 1,
  stroke: { ...NEUTRAL_STROKE }, shadow: { ...NEUTRAL_SHADOW },
  background: { ...NEUTRAL_BACKGROUND },
  letterSpacing: 0, lineSpacing: 1.2, uppercase: false,
  activeWord: { ...NEUTRAL_ACTIVE_WORD }
};

// --- Readers -----------------------------------------------------------------

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const finite = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const round = (value: number) => Number(value.toFixed(4));
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/iu;
const colorOr = (value: unknown, fallback: string) =>
  typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : fallback;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function readStroke(properties: unknown): TextStroke {
  const stroke = record(record(properties).stroke);
  return { enabled: stroke.enabled === true,
    color: colorOr(stroke.color, NEUTRAL_STROKE.color),
    width: clamp(finite(stroke.width, NEUTRAL_STROKE.width), 0, TEXT_BOUNDS.maxStrokeWidth) };
}

export function readShadow(properties: unknown): TextShadow {
  const shadow = record(record(properties).shadow);
  return { enabled: shadow.enabled === true,
    color: colorOr(shadow.color, NEUTRAL_SHADOW.color),
    opacity: clamp(finite(shadow.opacity, NEUTRAL_SHADOW.opacity), 0, 1),
    blur: clamp(finite(shadow.blur, NEUTRAL_SHADOW.blur), 0, TEXT_BOUNDS.maxShadowBlur),
    offsetX: clamp(finite(shadow.offsetX, NEUTRAL_SHADOW.offsetX),
      -TEXT_BOUNDS.maxShadowOffset, TEXT_BOUNDS.maxShadowOffset),
    offsetY: clamp(finite(shadow.offsetY, NEUTRAL_SHADOW.offsetY),
      -TEXT_BOUNDS.maxShadowOffset, TEXT_BOUNDS.maxShadowOffset) };
}

/** Mirrors the backend reader, including its fallback to the Phase 3
 * `backgroundColor` property, so a preset-authored plate does not vanish. */
export function readBackground(properties: unknown): TextBackground {
  const props = record(properties);
  const legacy = typeof props.backgroundColor === 'string' ? props.backgroundColor : '';
  const legacyEnabled = !!legacy && legacy !== 'transparent';
  if (props.background === undefined) {
    const alpha = legacyEnabled && legacy.length === 9
      ? parseInt(legacy.slice(7, 9), 16) / 255 : 1;
    return { enabled: legacyEnabled,
      color: legacyEnabled ? legacy.slice(0, 7).toLowerCase() : NEUTRAL_BACKGROUND.color,
      opacity: legacyEnabled ? round(clamp(alpha, 0, 1)) : NEUTRAL_BACKGROUND.opacity,
      padding: NEUTRAL_BACKGROUND.padding, radius: NEUTRAL_BACKGROUND.radius };
  }
  const background = record(props.background);
  return { enabled: background.enabled === true,
    color: colorOr(background.color, NEUTRAL_BACKGROUND.color),
    opacity: clamp(finite(background.opacity, NEUTRAL_BACKGROUND.opacity), 0, 1),
    padding: clamp(finite(background.padding, NEUTRAL_BACKGROUND.padding),
      0, TEXT_BOUNDS.maxBackgroundPadding),
    radius: clamp(finite(background.radius, NEUTRAL_BACKGROUND.radius),
      0, TEXT_BOUNDS.maxBackgroundRadius) };
}

export function readActiveWord(properties: unknown): ActiveWordStyle {
  const active = record(record(properties).activeWord);
  return { enabled: active.enabled === true,
    color: colorOr(active.color, NEUTRAL_ACTIVE_WORD.color) };
}

export function readCaptionWords(properties: unknown): CaptionWord[] {
  const raw = record(properties).words;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const word = record(item);
    const start = finite(word.start, -1);
    const end = finite(word.end, -1);
    const text = typeof word.text === 'string' ? word.text : '';
    return start >= 0 && end > start && text.trim()
      ? [{ start: round(start), end: round(end), text }] : [];
  }).sort((left, right) => left.start - right.start);
}

export function readTextRuns(properties: unknown): TextRun[] {
  const props = record(properties);
  if (!Array.isArray(props.textRuns) || typeof props.content !== 'string') return [];
  const runs = props.textRuns.flatMap((item) => {
    const run = record(item);
    return typeof run.text === 'string' && run.text && typeof run.color === 'string' && HEX.test(run.color)
      ? [{ text: run.text, color: run.color.toLowerCase() }] : [];
  });
  return runs.length && runs.map((run) => run.text).join('') === props.content ? runs : [];
}

export function readTextStyle(properties: unknown): TextStyle {
  const props = record(properties);
  const family = typeof props.fontFamily === 'string' &&
    EDIT_MODE_FONT_IDS.includes(props.fontFamily)
    ? props.fontFamily : DEFAULT_TEXT_STYLE.fontFamily;
  const align = props.textAlign === 'left' || props.textAlign === 'right'
    ? props.textAlign : 'center';
  return {
    fontFamily: family,
    fontSize: clamp(finite(props.fontSize, DEFAULT_TEXT_STYLE.fontSize),
      TEXT_BOUNDS.minFontSize, TEXT_BOUNDS.maxFontSize),
    fontWeight: clamp(Math.round(finite(props.fontWeight, DEFAULT_TEXT_STYLE.fontWeight)),
      TEXT_BOUNDS.minFontWeight, TEXT_BOUNDS.maxFontWeight),
    color: colorOr(props.color, DEFAULT_TEXT_STYLE.color),
    textAlign: align,
    opacity: clamp(finite(props.opacity, 1), 0, 1),
    stroke: readStroke(properties),
    shadow: readShadow(properties),
    background: readBackground(properties),
    letterSpacing: clamp(finite(props.letterSpacing, 0),
      TEXT_BOUNDS.minLetterSpacing, TEXT_BOUNDS.maxLetterSpacing),
    lineSpacing: clamp(finite(props.lineSpacing, DEFAULT_TEXT_STYLE.lineSpacing),
      TEXT_BOUNDS.minLineSpacing, TEXT_BOUNDS.maxLineSpacing),
    uppercase: props.uppercase === true,
    activeWord: readActiveWord(properties)
  };
}

const rgba = (hex: string, opacity: number) => {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/iu.exec(hex);
  if (!match) return hex;
  const [, r, g, b, a] = match;
  const alpha = (a === undefined ? 1 : parseInt(a, 16) / 255) * clamp(opacity, 0, 1);
  return `rgba(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${alpha.toFixed(3)})`;
};

/**
 * The CSS one styled text or caption element is drawn with.
 *
 * It deliberately makes the SAME choices the ASS builder does where the two
 * media disagree - a plate suppresses the stroke, because ASS can draw one or
 * the other but not both - so the preview shows what will actually export
 * rather than a richer picture the renderer cannot reach.
 */
export function textStyleCss(properties: Record<string, unknown>,
  canvasWidth: number): CSSProperties {
  const style = readTextStyle(properties);
  const px = (value: number) => `${designPx(value, canvasWidth).toFixed(3)}px`;
  const boxed = style.background.enabled && style.background.opacity > 0;
  const css: CSSProperties = {
    fontFamily: fontCss(style.fontFamily),
    fontSize: px(style.fontSize),
    fontWeight: style.fontWeight,
    color: style.color,
    textAlign: style.textAlign,
    letterSpacing: px(style.letterSpacing),
    lineHeight: style.lineSpacing,
    textTransform: style.uppercase ? 'uppercase' : 'none',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word'
  };
  // Editorial serif headlines (Automatic 2) break evenly, like the export renderer.
  if (style.fontFamily === 'EB Garamond, serif') (css as Record<string, unknown>).textWrap = 'balance';
  if (boxed) {
    css.background = rgba(style.background.color, style.background.opacity);
    css.padding = px(style.background.padding);
    css.borderRadius = px(style.background.radius);
  } else if (style.stroke.enabled && style.stroke.width > 0) {
    // `paint-order` puts the stroke behind the fill, which is how libass draws
    // an outline; without it the stroke eats into the glyph. CSS centres the
    // stroke on the glyph edge where ASS puts it outside, so half the stored
    // width is the closest match.
    css.WebkitTextStrokeWidth = px(style.stroke.width / 2);
    css.WebkitTextStrokeColor = style.stroke.color;
    css.paintOrder = 'stroke fill';
  }
  if (style.shadow.enabled && style.shadow.opacity > 0) {
    css.textShadow = `${px(style.shadow.offsetX)} ${px(style.shadow.offsetY)} ` +
      `${px(style.shadow.blur)} ${rgba(style.shadow.color, style.shadow.opacity)}`;
  }
  return css;
}

/** The word lit at one instant, or -1. Mirrors `activeWordIndex` on the backend
 * so the preview and the export highlight the same word. */
export function activeWordIndex(words: CaptionWord[], offsetSec: number): number {
  for (let index = 0; index < words.length; index++) {
    if (offsetSec >= words[index].start - 1e-6 && offsetSec < words[index].end - 1e-6) {
      return index;
    }
  }
  return -1;
}

/** True when a caption can actually show a live word: the style asks for it, and
 * the stored timings line up one-for-one with the stored wording. Anything else
 * falls back to a plain caption rather than faking word-level animation. */
export function canHighlightWords(properties: Record<string, unknown>) {
  const words = readCaptionWords(properties);
  const tokens = String(properties.content ?? '').split(/\s+/u).filter(Boolean);
  return readActiveWord(properties).enabled && words.length > 0 &&
    words.length === tokens.length;
}

// --- Built-in presets (mirrors) ----------------------------------------------

export type TextStylePresetId = 'BASIC' | 'HEADING' | 'HOOK' | 'TITLE' | 'SUBTITLE' |
  'LOWER_THIRD' | 'CTA' | 'BOLD_SOCIAL' | 'MINIMAL';
export type CaptionStylePresetId = 'CLEAN' | 'BOLD_HIGHLIGHT' | 'MINIMAL' | 'PODCAST' |
  'SOCIAL' | 'EDUCATIONAL' | 'HIGH_CONTRAST';

export type StylePresetSummary<Id extends string> = {
  id: Id; label: string; description: string;
  box: { x: number; y: number; width: number; height: number };
  style: Partial<TextStyle>;
};

const stroke = (width: number, color = '#000000'): TextStroke => ({ enabled: true, color, width });
const shadow = (over: Partial<TextShadow> = {}): TextShadow =>
  ({ ...NEUTRAL_SHADOW, enabled: true, ...over });
const plate = (over: Partial<TextBackground> = {}): TextBackground =>
  ({ ...NEUTRAL_BACKGROUND, enabled: true, ...over });

export const TEXT_STYLE_PRESETS: Array<StylePresetSummary<TextStylePresetId>> = [
  { id: 'BASIC', label: 'Basic', description: 'Plain white text with a legible dark stroke.',
    box: { x: 0.2, y: 0.42, width: 0.6, height: 0.16 },
    style: { fontFamily: 'Inter, sans-serif', fontSize: 48, fontWeight: 600, color: '#ffffff',
      textAlign: 'center', stroke: stroke(3), shadow: { ...NEUTRAL_SHADOW },
      background: { ...NEUTRAL_BACKGROUND }, letterSpacing: 0, lineSpacing: 1.2,
      uppercase: false } },
  { id: 'HEADING', label: 'Heading', description: 'Large editorial heading, no plate.',
    box: { x: 0.1, y: 0.12, width: 0.8, height: 0.2 },
    style: { fontFamily: 'Inter ExtraBold, sans-serif', fontSize: 74, fontWeight: 800,
      color: '#ffffff', textAlign: 'center', stroke: stroke(5),
      shadow: shadow({ opacity: 0.5, blur: 10, offsetX: 0, offsetY: 4 }),
      background: { ...NEUTRAL_BACKGROUND }, letterSpacing: -1, lineSpacing: 1.1,
      uppercase: false } },
  { id: 'HOOK', label: 'Hook', description: 'Loud opening line on a solid plate.',
    box: { x: 0.08, y: 0.1, width: 0.84, height: 0.22 },
    style: { fontFamily: 'Inter ExtraBold, sans-serif', fontSize: 82, fontWeight: 900,
      color: '#ffffff', textAlign: 'center', stroke: stroke(6),
      shadow: shadow({ opacity: 0.7, blur: 14, offsetX: 0, offsetY: 5 }),
      background: plate({ color: '#000000', opacity: 0.55, padding: 18, radius: 14 }),
      letterSpacing: -1, lineSpacing: 1.08, uppercase: true } },
  { id: 'TITLE', label: 'Title', description: 'Centred title card.',
    box: { x: 0.12, y: 0.38, width: 0.76, height: 0.2 },
    style: { fontFamily: 'Inter, sans-serif', fontSize: 66, fontWeight: 700, color: '#ffffff',
      textAlign: 'center', stroke: stroke(4),
      shadow: shadow({ opacity: 0.45, blur: 8, offsetX: 0, offsetY: 3 }),
      background: { ...NEUTRAL_BACKGROUND }, letterSpacing: 1, lineSpacing: 1.15,
      uppercase: false } },
  { id: 'SUBTITLE', label: 'Subtitle', description: 'Quiet supporting line under a title.',
    box: { x: 0.15, y: 0.58, width: 0.7, height: 0.12 },
    style: { fontFamily: 'Inter, sans-serif', fontSize: 34, fontWeight: 500, color: '#e2e8f0',
      textAlign: 'center', stroke: stroke(2), shadow: { ...NEUTRAL_SHADOW },
      background: { ...NEUTRAL_BACKGROUND }, letterSpacing: 1, lineSpacing: 1.3,
      uppercase: false } },
  { id: 'LOWER_THIRD', label: 'Lower Third',
    description: 'Left-aligned name bar near the bottom.',
    box: { x: 0.06, y: 0.72, width: 0.6, height: 0.12 },
    style: { fontFamily: 'Inter, sans-serif', fontSize: 38, fontWeight: 700, color: '#ffffff',
      textAlign: 'left', stroke: { ...NEUTRAL_STROKE },
      shadow: shadow({ opacity: 0.4, blur: 6, offsetX: 1, offsetY: 2 }),
      background: plate({ color: '#0f172a', opacity: 0.8, padding: 14, radius: 6 }),
      letterSpacing: 0, lineSpacing: 1.2, uppercase: false } },
  { id: 'CTA', label: 'CTA', description: 'Bright call-to-action pill.',
    box: { x: 0.24, y: 0.8, width: 0.52, height: 0.1 },
    style: { fontFamily: 'Inter ExtraBold, sans-serif', fontSize: 40, fontWeight: 800,
      color: '#0b0f1a', textAlign: 'center', stroke: { ...NEUTRAL_STROKE },
      shadow: shadow({ opacity: 0.35, blur: 8, offsetX: 0, offsetY: 3 }),
      background: plate({ color: '#facc15', opacity: 1, padding: 16, radius: 40 }),
      letterSpacing: 2, lineSpacing: 1.1, uppercase: true } },
  { id: 'BOLD_SOCIAL', label: 'Bold Social',
    description: 'Thick outlined social caption look.',
    box: { x: 0.1, y: 0.44, width: 0.8, height: 0.18 },
    style: { fontFamily: 'Inter ExtraBold, sans-serif', fontSize: 70, fontWeight: 900,
      color: '#ffffff', textAlign: 'center', stroke: stroke(9),
      shadow: shadow({ opacity: 0.6, blur: 4, offsetX: 0, offsetY: 6 }),
      background: { ...NEUTRAL_BACKGROUND }, letterSpacing: -1, lineSpacing: 1.05,
      uppercase: true } },
  { id: 'MINIMAL', label: 'Minimal', description: 'Thin, unstyled, nothing behind it.',
    box: { x: 0.2, y: 0.46, width: 0.6, height: 0.12 },
    style: { fontFamily: 'Inter, sans-serif', fontSize: 34, fontWeight: 400, color: '#ffffff',
      textAlign: 'center', stroke: { ...NEUTRAL_STROKE }, shadow: { ...NEUTRAL_SHADOW },
      background: { ...NEUTRAL_BACKGROUND }, letterSpacing: 3, lineSpacing: 1.4,
      uppercase: false } }
];

export const DEFAULT_CAPTION_BOX = { x: 0.1, y: 0.73, width: 0.8, height: 0.13 };

export const CAPTION_STYLE_PRESETS: Array<StylePresetSummary<CaptionStylePresetId>> = [
  { id: 'CLEAN', label: 'Clean', description: 'White on a soft dark plate.',
    box: { ...DEFAULT_CAPTION_BOX },
    style: { fontFamily: 'Inter, sans-serif', fontSize: 40, fontWeight: 700, color: '#ffffff',
      textAlign: 'center', stroke: { ...NEUTRAL_STROKE },
      shadow: shadow({ opacity: 0.5, blur: 6, offsetX: 0, offsetY: 2 }),
      background: plate({ color: '#000000', opacity: 0.6, padding: 12, radius: 8 }),
      letterSpacing: 0, lineSpacing: 1.2, uppercase: false,
      activeWord: { enabled: false, color: '#ffe066' } } },
  { id: 'BOLD_HIGHLIGHT', label: 'Bold Highlight',
    description: 'Heavy outlined caption with a yellow active word.',
    box: { ...DEFAULT_CAPTION_BOX },
    style: { fontFamily: 'Inter ExtraBold, sans-serif', fontSize: 52, fontWeight: 900,
      color: '#ffffff', textAlign: 'center', stroke: stroke(8),
      shadow: shadow({ opacity: 0.6, blur: 3, offsetX: 0, offsetY: 4 }),
      background: { ...NEUTRAL_BACKGROUND }, letterSpacing: -1, lineSpacing: 1.05,
      uppercase: true, activeWord: { enabled: true, color: '#ffe066' } } },
  { id: 'MINIMAL', label: 'Minimal', description: 'Small, plain, no plate.',
    box: { ...DEFAULT_CAPTION_BOX },
    style: { fontFamily: 'Inter, sans-serif', fontSize: 30, fontWeight: 500, color: '#ffffff',
      textAlign: 'center', stroke: stroke(2), shadow: { ...NEUTRAL_SHADOW },
      background: { ...NEUTRAL_BACKGROUND }, letterSpacing: 0, lineSpacing: 1.3,
      uppercase: false, activeWord: { enabled: false, color: '#ffe066' } } },
  { id: 'PODCAST', label: 'Podcast', description: 'Wide serif band for talking-head clips.',
    box: { x: 0.08, y: 0.76, width: 0.84, height: 0.12 },
    style: { fontFamily: 'Noto Serif, serif', fontSize: 36, fontWeight: 600, color: '#f8fafc',
      textAlign: 'center', stroke: { ...NEUTRAL_STROKE },
      shadow: shadow({ opacity: 0.45, blur: 8, offsetX: 0, offsetY: 2 }),
      background: plate({ color: '#0b0f1a', opacity: 0.72, padding: 14, radius: 10 }),
      letterSpacing: 0, lineSpacing: 1.25, uppercase: false,
      activeWord: { enabled: true, color: '#7dd3fc' } } },
  { id: 'SOCIAL', label: 'Social',
    description: 'Centre-screen social captions with a live word.',
    box: { x: 0.1, y: 0.6, width: 0.8, height: 0.16 },
    style: { fontFamily: 'Inter ExtraBold, sans-serif', fontSize: 48, fontWeight: 800,
      color: '#ffffff', textAlign: 'center', stroke: stroke(6),
      shadow: shadow({ opacity: 0.55, blur: 5, offsetX: 0, offsetY: 3 }),
      background: { ...NEUTRAL_BACKGROUND }, letterSpacing: -1, lineSpacing: 1.1,
      uppercase: true, activeWord: { enabled: true, color: '#4ade80' } } },
  { id: 'EDUCATIONAL', label: 'Educational',
    description: 'Quiet readable band for explainers.',
    box: { x: 0.1, y: 0.78, width: 0.8, height: 0.12 },
    style: { fontFamily: 'Inter, sans-serif', fontSize: 34, fontWeight: 600, color: '#ffffff',
      textAlign: 'center', stroke: { ...NEUTRAL_STROKE }, shadow: { ...NEUTRAL_SHADOW },
      background: plate({ color: '#1e293b', opacity: 0.85, padding: 14, radius: 6 }),
      letterSpacing: 0, lineSpacing: 1.3, uppercase: false,
      activeWord: { enabled: true, color: '#fbbf24' } } },
  { id: 'HIGH_CONTRAST', label: 'High Contrast',
    description: 'Maximum legibility: black plate, heavy white type.',
    box: { ...DEFAULT_CAPTION_BOX },
    style: { fontFamily: 'Inter ExtraBold, sans-serif', fontSize: 44, fontWeight: 900,
      color: '#ffffff', textAlign: 'center', stroke: stroke(4),
      shadow: { ...NEUTRAL_SHADOW },
      background: plate({ color: '#000000', opacity: 1, padding: 16, radius: 0 }),
      letterSpacing: 0, lineSpacing: 1.15, uppercase: false,
      activeWord: { enabled: true, color: '#fde047' } } }
];
