// EditMode canonical text and caption styling.
//
// This module is the single definition of what a TEXT or SUBTITLE element's
// visual style IS: which properties exist, what a valid value is, what the
// neutral one looks like, and what the built-in presets set. The command layer,
// the render planner, the ASS builder and the tests all read it from here, so a
// style the editor can store is by construction one the renderer can draw.
//
// Everything is pure. Nothing here touches Prisma, FFmpeg or the frozen
// pipeline's subtitle implementation (src/modules/editing/*), which stays
// exactly as it was: EditMode styling is isolated by design.
//
// UNITS. Every size below - fontSize, stroke width, shadow blur and offset,
// background padding and radius, letter spacing - is a DESIGN UNIT on a
// 600-wide canvas, the same convention `fontSizePx` already implements
// (see FONT_SIZE_CANVAS_DIVISOR in render/edit-mode-ass.ts). One convention for
// every dimension is what keeps the browser preview and the exported frame the
// same picture at any output resolution. `lineSpacing` is the one exception: it
// is a multiplier of the line height, because that is how both CSS and libass
// think about leading.

export class TextRangeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TextRangeError';
  }
}

export type TextStroke = { enabled: boolean; color: string; width: number };
export type TextShadow = { enabled: boolean; color: string; opacity: number; blur: number;
  offsetX: number; offsetY: number };
export type TextBackground = { enabled: boolean; color: string; opacity: number;
  padding: number; radius: number };
/** Word-level emphasis. Only ever drawn when real word timings exist. */
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
  /** Multiplier of the line height; 1 is the font's natural leading. */
  lineSpacing: number;
  uppercase: boolean;
  activeWord: ActiveWordStyle;
};

/** One transcript word, in seconds RELATIVE to the element's own start. Stored
 * on a caption element so the active-word highlight survives a retime. */
export type CaptionWord = { start: number; end: number; text: string };
/** Persisted static rich-text runs. Readers accept them only when their text
 * exactly reconstructs `content`, so manual wording edits cannot leave stale
 * semantic colours attached to the wrong characters. */
export type TextRun = { text: string; color: string };

// --- Bounds ------------------------------------------------------------------
// Finite and deliberately generous. A control the editor offers can never ask
// for a value outside these, and a raw request asking for one is rejected with
// its own code rather than silently clamped, so the preview and the export can
// never disagree about what was stored.

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 300;
export const MIN_FONT_WEIGHT = 100;
export const MAX_FONT_WEIGHT = 900;
export const MAX_STROKE_WIDTH = 40;
export const MAX_SHADOW_BLUR = 60;
export const MAX_SHADOW_OFFSET = 60;
export const MAX_BACKGROUND_PADDING = 120;
export const MAX_BACKGROUND_RADIUS = 120;
export const MIN_LETTER_SPACING = -20;
export const MAX_LETTER_SPACING = 60;
export const MIN_LINE_SPACING = 0.6;
export const MAX_LINE_SPACING = 3;
export const MAX_TEXT_LENGTH = 2000;
export const MAX_CAPTION_LENGTH = 500;

/**
 * Families the editor offers, mapped to the fontconfig family the renderer asks
 * libass for.
 *
 * The backend image installs `font-noto` and `font-inter` and nothing else (see
 * apps/backend/Dockerfile), so every entry here names a face that is genuinely
 * present. The three legacy keys are the values Phase 3/4 elements already
 * carry; they are kept so old elements keep validating, and they are mapped to
 * the faces fontconfig was already falling back to for them.
 */
export const EDIT_MODE_FONT_FAMILIES: Record<string, string> = {
  'Arial, sans-serif': 'Noto Sans',
  'Georgia, serif': 'Noto Serif',
  monospace: 'Noto Sans Mono',
  'Inter, sans-serif': 'Inter',
  'Inter ExtraBold, sans-serif': 'Inter ExtraBold',
  'Noto Sans, sans-serif': 'Noto Sans',
  'Noto Serif, serif': 'Noto Serif',
  // The 12 pt optical cut: the same file the editor loads (public/fonts/EBGaramond12-Regular.otf).
  // Plain "EB Garamond" makes fontconfig pick the wider 08 cut, so the export ran ~10% wider.
  'EB Garamond, serif': 'EB Garamond 12'
};

export const EDIT_MODE_FONT_IDS = Object.keys(EDIT_MODE_FONT_FAMILIES);

export const resolveEditModeFont = (family: string) =>
  EDIT_MODE_FONT_FAMILIES[family] ?? EDIT_MODE_FONT_FAMILIES['Arial, sans-serif'];

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

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

export function readStroke(properties: unknown): TextStroke {
  const stroke = record(record(properties).stroke);
  return {
    enabled: stroke.enabled === true,
    color: colorOr(stroke.color, NEUTRAL_STROKE.color),
    width: clamp(finite(stroke.width, NEUTRAL_STROKE.width), 0, MAX_STROKE_WIDTH)
  };
}

export function readShadow(properties: unknown): TextShadow {
  const shadow = record(record(properties).shadow);
  return {
    enabled: shadow.enabled === true,
    color: colorOr(shadow.color, NEUTRAL_SHADOW.color),
    opacity: clamp(finite(shadow.opacity, NEUTRAL_SHADOW.opacity), 0, 1),
    blur: clamp(finite(shadow.blur, NEUTRAL_SHADOW.blur), 0, MAX_SHADOW_BLUR),
    offsetX: clamp(finite(shadow.offsetX, NEUTRAL_SHADOW.offsetX),
      -MAX_SHADOW_OFFSET, MAX_SHADOW_OFFSET),
    offsetY: clamp(finite(shadow.offsetY, NEUTRAL_SHADOW.offsetY),
      -MAX_SHADOW_OFFSET, MAX_SHADOW_OFFSET)
  };
}

/**
 * The plate behind the text.
 *
 * `backgroundColor` is the Phase 3 property and is still what a pre-existing
 * element carries, so an element with no `background` object inherits its state
 * from it. That is what stops a preset-authored caption plate from vanishing the
 * first time this module reads it.
 */
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
  return {
    enabled: background.enabled === true,
    color: colorOr(background.color, NEUTRAL_BACKGROUND.color),
    opacity: clamp(finite(background.opacity, NEUTRAL_BACKGROUND.opacity), 0, 1),
    padding: clamp(finite(background.padding, NEUTRAL_BACKGROUND.padding),
      0, MAX_BACKGROUND_PADDING),
    radius: clamp(finite(background.radius, NEUTRAL_BACKGROUND.radius), 0, MAX_BACKGROUND_RADIUS)
  };
}

export function readActiveWord(properties: unknown): ActiveWordStyle {
  const active = record(record(properties).activeWord);
  return { enabled: active.enabled === true,
    color: colorOr(active.color, NEUTRAL_ACTIVE_WORD.color) };
}

/** Word timings stored on a caption, relative to its own start. Never invented:
 * a caption without them reads back as an empty list. */
export function readCaptionWords(properties: unknown): CaptionWord[] {
  const raw = record(properties).words;
  if (!Array.isArray(raw)) return [];
  const words: CaptionWord[] = [];
  for (const item of raw) {
    const word = record(item);
    const start = finite(word.start, -1);
    const end = finite(word.end, -1);
    const text = typeof word.text === 'string' ? word.text : '';
    if (start >= 0 && end > start && text.trim()) {
      words.push({ start: round(start), end: round(end), text });
    }
  }
  return words.sort((left, right) => left.start - right.start);
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
  const family = typeof props.fontFamily === 'string' && EDIT_MODE_FONT_FAMILIES[props.fontFamily]
    ? props.fontFamily : DEFAULT_TEXT_STYLE.fontFamily;
  const align = props.textAlign === 'left' || props.textAlign === 'right'
    ? props.textAlign : 'center';
  return {
    fontFamily: family,
    fontSize: clamp(finite(props.fontSize, DEFAULT_TEXT_STYLE.fontSize),
      MIN_FONT_SIZE, MAX_FONT_SIZE),
    fontWeight: clamp(Math.round(finite(props.fontWeight, DEFAULT_TEXT_STYLE.fontWeight)),
      MIN_FONT_WEIGHT, MAX_FONT_WEIGHT),
    color: colorOr(props.color, DEFAULT_TEXT_STYLE.color),
    textAlign: align,
    opacity: clamp(finite(props.opacity, 1), 0, 1),
    stroke: readStroke(properties),
    shadow: readShadow(properties),
    background: readBackground(properties),
    letterSpacing: clamp(finite(props.letterSpacing, 0), MIN_LETTER_SPACING, MAX_LETTER_SPACING),
    lineSpacing: clamp(finite(props.lineSpacing, DEFAULT_TEXT_STYLE.lineSpacing),
      MIN_LINE_SPACING, MAX_LINE_SPACING),
    uppercase: props.uppercase === true,
    activeWord: readActiveWord(properties)
  };
}

/**
 * The single background colour the ASS builder and the preview both fall back
 * to. `#rrggbbaa`, or 'transparent' when there is no plate.
 */
export function effectiveBackgroundColor(background: TextBackground): string {
  if (!background.enabled || background.opacity <= 0) return 'transparent';
  const alpha = Math.round(clamp(background.opacity, 0, 1) * 255).toString(16).padStart(2, '0');
  return `${background.color}${alpha}`;
}

// --- Validators --------------------------------------------------------------
// Each returns the value it accepted. They throw TextRangeError with a specific
// code so the editor can point at the control that was out of range rather than
// showing a generic rejection.

const requireFinite = (value: unknown, code: string, message: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TextRangeError(code, message);
  return parsed;
};

const requireRange = (value: unknown, low: number, high: number, code: string, label: string) => {
  const parsed = requireFinite(value, code, `${label} must be a number`);
  if (parsed < low || parsed > high) {
    throw new TextRangeError(code, `${label} must be between ${low} and ${high}`);
  }
  return round(parsed);
};

const requireBoolean = (value: unknown, code: string, label: string) => {
  if (typeof value !== 'boolean') throw new TextRangeError(code, `${label} must be a boolean`);
  return value;
};

export function validateColor(value: unknown, label: string, code = 'INVALID_TEXT_COLOR') {
  if (typeof value !== 'string' || !HEX.test(value)) {
    throw new TextRangeError(code, `${label} must be a #rrggbb or #rrggbbaa hex colour`);
  }
  return value.toLowerCase();
}

export function validateFontFamily(value: unknown): string {
  const family = String(value);
  if (!EDIT_MODE_FONT_FAMILIES[family]) {
    throw new TextRangeError('INVALID_FONT_FAMILY',
      `fontFamily must be one of: ${EDIT_MODE_FONT_IDS.join(', ')}`);
  }
  return family;
}

export const validateFontSize = (value: unknown) =>
  requireRange(value, MIN_FONT_SIZE, MAX_FONT_SIZE, 'INVALID_FONT_SIZE', 'fontSize');

export function validateFontWeight(value: unknown): number {
  const weight = requireRange(value, MIN_FONT_WEIGHT, MAX_FONT_WEIGHT,
    'INVALID_FONT_WEIGHT', 'fontWeight');
  if (!Number.isInteger(weight) || weight % 100 !== 0) {
    throw new TextRangeError('INVALID_FONT_WEIGHT', 'fontWeight must be a multiple of 100');
  }
  return weight;
}

export function validateAlignment(value: unknown): TextStyle['textAlign'] {
  if (value !== 'left' && value !== 'center' && value !== 'right') {
    throw new TextRangeError('INVALID_TEXT_ALIGNMENT',
      'textAlign must be left, center or right');
  }
  return value;
}

export function validateStroke(input: Record<string, unknown>): TextStroke {
  const enabled = requireBoolean(input.strokeEnabled, 'INVALID_TEXT_STROKE', 'strokeEnabled');
  return { enabled,
    color: validateColor(input.strokeColor, 'strokeColor', 'INVALID_TEXT_STROKE'),
    width: requireRange(input.strokeWidth, 0, MAX_STROKE_WIDTH,
      'INVALID_TEXT_STROKE', 'strokeWidth') };
}

export function validateShadow(input: Record<string, unknown>): TextShadow {
  const enabled = requireBoolean(input.shadowEnabled, 'INVALID_TEXT_SHADOW', 'shadowEnabled');
  return { enabled,
    color: validateColor(input.shadowColor, 'shadowColor', 'INVALID_TEXT_SHADOW'),
    opacity: requireRange(input.shadowOpacity, 0, 1, 'INVALID_TEXT_SHADOW', 'shadowOpacity'),
    blur: requireRange(input.shadowBlur, 0, MAX_SHADOW_BLUR, 'INVALID_TEXT_SHADOW', 'shadowBlur'),
    offsetX: requireRange(input.shadowOffsetX, -MAX_SHADOW_OFFSET, MAX_SHADOW_OFFSET,
      'INVALID_TEXT_SHADOW', 'shadowOffsetX'),
    offsetY: requireRange(input.shadowOffsetY, -MAX_SHADOW_OFFSET, MAX_SHADOW_OFFSET,
      'INVALID_TEXT_SHADOW', 'shadowOffsetY') };
}

export function validateBackground(input: Record<string, unknown>): TextBackground {
  const enabled = requireBoolean(input.backgroundEnabled, 'INVALID_TEXT_BACKGROUND',
    'backgroundEnabled');
  return { enabled,
    color: validateColor(input.backgroundColor, 'backgroundColor', 'INVALID_TEXT_BACKGROUND'),
    opacity: requireRange(input.backgroundOpacity, 0, 1,
      'INVALID_TEXT_BACKGROUND', 'backgroundOpacity'),
    padding: requireRange(input.backgroundPadding, 0, MAX_BACKGROUND_PADDING,
      'INVALID_TEXT_BACKGROUND', 'backgroundPadding'),
    radius: requireRange(input.backgroundRadius, 0, MAX_BACKGROUND_RADIUS,
      'INVALID_TEXT_BACKGROUND', 'backgroundRadius') };
}

export function validateSpacing(input: Record<string, unknown>) {
  return {
    letterSpacing: requireRange(input.letterSpacing, MIN_LETTER_SPACING, MAX_LETTER_SPACING,
      'INVALID_TEXT_SPACING', 'letterSpacing'),
    lineSpacing: requireRange(input.lineSpacing, MIN_LINE_SPACING, MAX_LINE_SPACING,
      'INVALID_TEXT_SPACING', 'lineSpacing')
  };
}

export function validateActiveWord(input: Record<string, unknown>): ActiveWordStyle {
  return {
    enabled: requireBoolean(input.activeWordEnabled, 'INVALID_ACTIVE_WORD', 'activeWordEnabled'),
    color: validateColor(input.activeWordColor, 'activeWordColor', 'INVALID_ACTIVE_WORD')
  };
}

// --- Built-in presets --------------------------------------------------------
//
// A preset is a PARTIAL style: applying one changes only the properties it
// names, so a user who set their own colour and then picks "Hook" keeps the
// geometry they placed. Text presets also carry a default box, used only when
// the preset creates the element rather than restyling an existing one.

export type TextStylePresetId = 'BASIC' | 'HEADING' | 'HOOK' | 'TITLE' | 'SUBTITLE' |
  'LOWER_THIRD' | 'CTA' | 'BOLD_SOCIAL' | 'MINIMAL';

export type TextBox = { x: number; y: number; width: number; height: number };

export type TextStylePreset = {
  id: TextStylePresetId;
  label: string;
  description: string;
  box: TextBox;
  style: Partial<TextStyle>;
};

const stroke = (width: number, color = '#000000'): TextStroke => ({ enabled: true, color, width });
const shadow = (over: Partial<TextShadow> = {}): TextShadow => ({ ...NEUTRAL_SHADOW,
  enabled: true, ...over });
const plate = (over: Partial<TextBackground> = {}): TextBackground => ({ ...NEUTRAL_BACKGROUND,
  enabled: true, ...over });

export const TEXT_STYLE_PRESETS: TextStylePreset[] = [
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
  { id: 'LOWER_THIRD', label: 'Lower Third', description: 'Left-aligned name bar near the bottom.',
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
  { id: 'BOLD_SOCIAL', label: 'Bold Social', description: 'Thick outlined social caption look.',
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

export const TEXT_STYLE_PRESET_IDS = TEXT_STYLE_PRESETS.map((preset) => preset.id);

export const textStylePreset = (id: string): TextStylePreset => {
  const preset = TEXT_STYLE_PRESETS.find((item) => item.id === id);
  if (!preset) {
    throw new TextRangeError('INVALID_TEXT_STYLE_PRESET',
      `textStyleId must be one of: ${TEXT_STYLE_PRESET_IDS.join(', ')}`);
  }
  return preset;
};

export type CaptionStylePresetId = 'CLEAN' | 'BOLD_HIGHLIGHT' | 'MINIMAL' | 'PODCAST' |
  'SOCIAL' | 'EDUCATIONAL' | 'HIGH_CONTRAST';

export type CaptionStylePreset = {
  id: CaptionStylePresetId;
  label: string;
  description: string;
  /** Default caption band. Applied only when the user has not moved captions. */
  box: TextBox;
  style: Partial<TextStyle>;
};

/** The safe default caption band: lower-middle, full readable width. */
export const DEFAULT_CAPTION_BOX: TextBox = { x: 0.1, y: 0.73, width: 0.8, height: 0.13 };

export const CAPTION_STYLE_PRESETS: CaptionStylePreset[] = [
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
  { id: 'SOCIAL', label: 'Social', description: 'Centre-screen social captions with a live word.',
    box: { x: 0.1, y: 0.6, width: 0.8, height: 0.16 },
    style: { fontFamily: 'Inter ExtraBold, sans-serif', fontSize: 48, fontWeight: 800,
      color: '#ffffff', textAlign: 'center', stroke: stroke(6),
      shadow: shadow({ opacity: 0.55, blur: 5, offsetX: 0, offsetY: 3 }),
      background: { ...NEUTRAL_BACKGROUND }, letterSpacing: -1, lineSpacing: 1.1,
      uppercase: true, activeWord: { enabled: true, color: '#4ade80' } } },
  { id: 'EDUCATIONAL', label: 'Educational', description: 'Quiet readable band for explainers.',
    box: { x: 0.1, y: 0.78, width: 0.8, height: 0.12 },
    style: { fontFamily: 'Inter, sans-serif', fontSize: 34, fontWeight: 600, color: '#ffffff',
      textAlign: 'center', stroke: { ...NEUTRAL_STROKE },
      shadow: { ...NEUTRAL_SHADOW },
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

export const CAPTION_STYLE_PRESET_IDS = CAPTION_STYLE_PRESETS.map((preset) => preset.id);

export const captionStylePreset = (id: string): CaptionStylePreset => {
  const preset = CAPTION_STYLE_PRESETS.find((item) => item.id === id);
  if (!preset) {
    throw new TextRangeError('INVALID_CAPTION_STYLE_PRESET',
      `captionStyleId must be one of: ${CAPTION_STYLE_PRESET_IDS.join(', ')}`);
  }
  return preset;
};

/**
 * A preset flattened into the exact property patch the element stores.
 *
 * `backgroundColor` is written alongside the structured `background` so that
 * anything still reading the Phase 3 property - an old history snapshot, the
 * frozen plan reader - sees the same plate.
 */
export function styleProperties(style: Partial<TextStyle>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (style.fontFamily !== undefined) patch.fontFamily = style.fontFamily;
  if (style.fontSize !== undefined) patch.fontSize = style.fontSize;
  if (style.fontWeight !== undefined) patch.fontWeight = style.fontWeight;
  if (style.color !== undefined) patch.color = style.color;
  if (style.textAlign !== undefined) patch.textAlign = style.textAlign;
  if (style.opacity !== undefined) patch.opacity = style.opacity;
  if (style.stroke !== undefined) patch.stroke = { ...style.stroke };
  if (style.shadow !== undefined) patch.shadow = { ...style.shadow };
  if (style.background !== undefined) {
    patch.background = { ...style.background };
    patch.backgroundColor = effectiveBackgroundColor(style.background);
  }
  if (style.letterSpacing !== undefined) patch.letterSpacing = style.letterSpacing;
  if (style.lineSpacing !== undefined) patch.lineSpacing = style.lineSpacing;
  if (style.uppercase !== undefined) patch.uppercase = style.uppercase;
  if (style.activeWord !== undefined) patch.activeWord = { ...style.activeWord };
  return patch;
}

/** The style properties one element carries, as a patch. Used by "apply to all",
 * which must copy STYLE and nothing else. */
export function extractStyleProperties(properties: unknown): Record<string, unknown> {
  return styleProperties(readTextStyle(properties));
}

export const applyUppercase = (text: string, uppercase: boolean) =>
  uppercase ? text.toLocaleUpperCase() : text;
