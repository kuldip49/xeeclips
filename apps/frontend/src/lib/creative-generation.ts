// Unified generation (Steps 9-12, 17), frontend side.
//
// The backend owns the style library and the ONE precedence resolver
// (instruction > component > reference > template > default). This file only
// fetches it and turns a resolved style into an approximate source-frame
// preview model. It never decides precedence itself.

import type { CSSProperties } from 'react';
import { isAutomaticLook } from '@/lib/automatic-looks';
import { apiFetch, getPublicApiBaseUrl, type GenerationRequest } from '@/lib/api';
import { COLOR_FILTER_IDS, colorOverlayLayers, colorPreviewStyle, NEUTRAL_COLOR, resolveColorFilter,
  type ColorAdjustments, type ColorFilterId } from '@/lib/edit-mode-color';
import { CAPTION_STYLE_PRESETS, NEUTRAL_SHADOW, NEUTRAL_STROKE, TEXT_STYLE_PRESETS, type StylePresetSummary, type TextStyle } from '@/lib/edit-mode-text';

export const STYLE_CATEGORIES = ['HOOK', 'CAPTIONS', 'TEXT', 'COLOR', 'ZOOM', 'FRAMING', 'AUDIO',
  'BACKGROUND', 'OVERLAY'] as const;
export type StyleCategory = typeof STYLE_CATEGORIES[number];

export const CATEGORY_LABELS: Record<StyleCategory, string> = {
  HOOK: 'Hook', CAPTIONS: 'Captions', TEXT: 'Text', COLOR: 'Color', ZOOM: 'Zoom',
  FRAMING: 'Framing', AUDIO: 'Audio', BACKGROUND: 'Background / layout', OVERLAY: 'Logo'
};

export type ComponentStyle = {
  id: string; category: StyleCategory; name: string; description: string;
  supported: boolean; note?: string; spec: Record<string, unknown>;
};
export type FullTemplate = { id: string; name: string; description: string;
  components: Partial<Record<StyleCategory, string>> };
export type CreativeCatalog = { categories: StyleCategory[]; templates: FullTemplate[];
  components: Record<StyleCategory, ComponentStyle[]> };

export type StyleSource = 'INSTRUCTION' | 'COMPONENT' | 'REFERENCE' | 'TEMPLATE' | 'DEFAULT';
export type ResolvedComponent = { category: StyleCategory; source: StyleSource; styleId: string | null;
  name: string | null; spec: Record<string, unknown> | null; supported: boolean; note?: string;
  overridden: Array<{ source: StyleSource; styleId: string | null }> };
export type ResolvedCreativeStyle = { templateId: string | null;
  components: Record<StyleCategory, ResolvedComponent>; styled: boolean; notes: string[] };
export type CreativeResolution = {
  interpreted: { intent?: { modes?: string[]; topics?: string[]; strict?: boolean } | null;
    source?: string; ai?: { state?: string } };
  resolved: ResolvedCreativeStyle;
  layout: ResolvedVisualLayout;
};

export type NormalizedRect = { x: number; y: number; width: number; height: number };
export type ResolvedVisualLayout = {
  version: 1;
  canvas: { width: number; height: number; aspect: '9:16' };
  videoFrame: NormalizedRect & { mode: 'FILL' | 'FIT' | 'CARD'; cropPolicy: string };
  hook: NormalizedRect & { enabled: boolean; maxWidth: number; maxLines: 3;
    fontSize: number; lineHeight: number; safeRegion: 'TOP' };
  captions: NormalizedRect & { maxWidth: number; maxLines: 2; fontSize: number;
    lineHeight: number; baseline: number; activeWordScale: 1; safeRegion: 'LOWER_THIRD' };
  background: { type: 'BLUR' | 'SOLID' | 'VIDEO'; color: string; blur: number };
  supportingText?: NormalizedRect & { enabled: boolean; maxWidth: number; maxLines: 2;
    fontSize: number; lineHeight: number; safeRegion: 'BOTTOM' };
  safeAreas: { top: number; bottom: number; left: number; right: number };
  overlays: { logo: NormalizedRect };
};

export type SavedStyle = { id: string; category: StyleCategory; name: string };
export type ReferenceAsset = { id: string; originalName: string; status: 'ANALYZING' | 'READY' | 'FAILED';
  error: string | null; sourceUrl: string | null;
  derivedStyle: { principles?: string[]; notMeasured?: string[] } | null };

export const SOURCE_LABELS: Record<StyleSource, string> = {
  INSTRUCTION: 'from your brief', COMPONENT: 'your pick', REFERENCE: 'from reference',
  TEMPLATE: 'from template', DEFAULT: 'automatic'
};

// --- API ---------------------------------------------------------------------

const json = (body: unknown): RequestInit => ({ method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const getCreativeCatalog = () => apiFetch<CreativeCatalog>('/edit-mode/creative/catalog');

export const resolveCreative = (input: Omit<GenerationRequest, 'referenceId'> & { referenceId?: string | null;
  sourceWidth?: number | null; sourceHeight?: number | null },
  signal?: AbortSignal) => apiFetch<CreativeResolution>('/edit-mode/creative/resolve', { ...json(input), signal });

export const listSavedStyles = () => apiFetch<SavedStyle[]>('/edit-mode/saved-styles');

export function uploadReference(file: File, videoId: string) {
  const body = new FormData();
  body.set('file', file);
  body.set('videoId', videoId);
  return apiFetch<ReferenceAsset>('/edit-mode/references/upload', { method: 'POST', body });
}

export const referenceFromUrl = (url: string, videoId: string) =>
  apiFetch<ReferenceAsset>('/edit-mode/references/url', json({ url, videoId }));

export const getReference = (id: string) =>
  apiFetch<ReferenceAsset>(`/edit-mode/references/${encodeURIComponent(id)}`);

export const retryGeneratedClipStyle = (id: string) => apiFetch<{ accepted: boolean }>(
  `/edit-mode/generation/clips/${encodeURIComponent(id)}/retry-style`, { method: 'POST' });

export const sourcePosterUrl = (videoId: string) =>
  `${getPublicApiBaseUrl()}/videos/${encodeURIComponent(videoId)}/poster`;
export const sourceFileUrl = (videoId: string) =>
  `${getPublicApiBaseUrl()}/videos/${encodeURIComponent(videoId)}/file`;

/**
 * The generation payload, or null when the user chose nothing beyond count and a base look.
 * `look` is the user's SELECTED configuration, persisted so a reload shows what they picked
 * even when the request itself renders a clean cut to apply the style canonically.
 */
export function generationPayload(input: { templateId: string | null;
  components: Partial<Record<StyleCategory, string>>; brief: string; referenceId: string | null;
  look?: string | null }): GenerationRequest | null {
  const components = Object.fromEntries(Object.entries(input.components)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''));
  const brief = input.brief.trim();
  const look = input.look ?? input.templateId ?? null;
  // The selected automatic template is part of the immutable request even when
  // it has no component overrides. Never infer Automatic 1 from render mode.
  const templateId = input.templateId ?? (isAutomaticLook(look) ? look : null);
  if (!templateId && !brief && !input.referenceId && !Object.keys(components).length) return null;
  return { templateId, components, brief, referenceId: input.referenceId, look };
}

const LOW_INFORMATION_WORDS = new Set(['about', 'after', 'again', 'because', 'before', 'could',
  'every', 'from', 'have', 'here', 'into', 'just', 'many', 'more', 'most', 'really', 'should',
  'some', 'that', 'their', 'them', 'there', 'these', 'they', 'this', 'those', 'very', 'what',
  'when', 'where', 'which', 'while', 'with', 'would', 'your']);

/**
 * The hook's emphasised words, split into coloured runs. Mirrors the backend's
 * `semanticHookRuns` (creative-style-commands.ts) so previews highlight the same words the
 * export does: numbers, mid-sentence names and substantive long words, at most two.
 */
export function hookEmphasisRuns(text: string, baseColor: string, emphasis: readonly string[]) {
  if (!emphasis.length) return [{ text, color: baseColor }];
  const words = [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)];
  const titleCase = words.length > 3 &&
    words.filter((match) => /^\p{Lu}/u.test(match[0])).length / words.length > 0.6;
  const selected = words.map((match, index) => {
    const word = match[0];
    const entity = !titleCase && index > 0 && /^\p{Lu}/u.test(word);
    const number = /\p{N}/u.test(word);
    const substantive = word.length >= 7 && !LOW_INFORMATION_WORDS.has(word.toLocaleLowerCase());
    return { start: match.index ?? 0, end: (match.index ?? 0) + word.length,
      score: (number ? 5 : 0) + (entity ? 4 : 0) + (substantive ? 2 : 0) + word.length / 100 };
  }).filter((item) => item.score >= 2).sort((a, b) => b.score - a.score).slice(0, 2)
    .sort((a, b) => a.start - b.start);
  const runs: Array<{ text: string; color: string }> = [];
  let cursor = 0;
  selected.forEach((range, index) => {
    if (range.start > cursor) runs.push({ text: text.slice(cursor, range.start), color: baseColor });
    runs.push({ text: text.slice(range.start, range.end), color: emphasis[index % emphasis.length] });
    cursor = range.end;
  });
  if (cursor < text.length) runs.push({ text: text.slice(cursor), color: baseColor });
  return runs;
}

/** True when `payload` asks for exactly what `stored` (the served request) was created with. */
export function sameGenerationRequest(stored: (GenerationRequest & { requestedTemplate?: string }) | null | undefined,
  payload: GenerationRequest | null): boolean {
  const norm = (value: GenerationRequest | null | undefined, template?: string | null) => JSON.stringify({
    t: template ?? value?.templateId ?? null, b: (value?.brief ?? '').trim(), r: value?.referenceId ?? null,
    c: Object.entries(value?.components ?? {}).filter(([, id]) => !!id).sort(([a], [b]) => a.localeCompare(b)) });
  return norm(stored, stored?.requestedTemplate ?? stored?.templateId) === norm(payload);
}

// --- Preview model -------------------------------------------------------------
//
// An APPROXIMATION of the resolved style on the source still: hook, captions,
// background/layout, colour, framing, logo corner. Timing, per-clip framing and
// the actual hook wording are decided per clip, so the UI labels it as such.

export type PreviewText = { text: string; box: NormalizedRect; maxLines: number;
  style: Partial<TextStyle>; activeWordColor: string | null; semanticColor?: string[] | null };
export type StylePreviewModel = {
  layout: 'FILL' | 'FIT';
  fitBackground: 'BLUR' | 'BLACK' | 'WHITE';
  videoScale: number;
  objectPosition: string;
  zoomScale: number;
  videoStyle: CSSProperties;
  overlayLayers: Array<{ key: string; style: CSSProperties }>;
  hook: PreviewText | null;
  captions: PreviewText | null;
  supportingText: PreviewText | null;
  logoCorner: string | null;
  badges: string[];
  unsupported: string[];
};

const spec = (resolved: ResolvedCreativeStyle | null, category: StyleCategory) =>
  (resolved?.components[category]?.spec ?? {}) as Record<string, unknown>;
const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const numeric = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const preset = <Id extends string>(list: Array<StylePresetSummary<Id>>, id: unknown, fallback: Id) =>
  list.find((item) => item.id === id) ?? list.find((item) => item.id === fallback)!;

function withPlate(style: Partial<TextStyle>, plate: unknown, opacity: unknown): Partial<TextStyle> {
  if (plate === 'none') return { ...style, background: { ...style.background!, enabled: false } };
  if (typeof plate === 'string' && style.background) {
    return { ...style, background: { ...style.background, enabled: true, color: plate,
      opacity: numeric(opacity) ?? Math.max(style.background.opacity, 0.6) } };
  }
  return style;
}

const HOOK_Y: Record<string, number> = { TOP: 0.08, UPPER: 0.16, CENTER: 0.42 };
const HOOK_SAMPLE: Record<string, string> = { QUESTION: 'Why does nobody talk about this?',
  CURIOSITY: 'This changed everything…', STATEMENT: 'This is the real problem', KEEP: 'Your clip’s hook' };

export function stylePreviewModel(resolved: ResolvedCreativeStyle | null,
  exact?: ResolvedVisualLayout | null): StylePreviewModel {
  const background = spec(resolved, 'BACKGROUND');
  const framing = spec(resolved, 'FRAMING');
  const layout = (str(background.layout) ?? str(framing.layout) ?? 'FILL') === 'FIT' ? 'FIT' : 'FILL';
  const fit = str(background.fitBackground);
  const policy = str(framing.reframePolicy) ?? 'AUTO';

  // Colour: the same filter resolution the editor sliders use.
  const colorSpec = spec(resolved, 'COLOR');
  const filterId = str(colorSpec.filterId) as ColorFilterId | undefined;
  let color: ColorAdjustments = filterId && (COLOR_FILTER_IDS as readonly string[]).includes(filterId)
    ? resolveColorFilter(filterId, numeric(colorSpec.strength) ?? 1) : { ...NEUTRAL_COLOR };
  const overrides = colorSpec.overrides && typeof colorSpec.overrides === 'object'
    ? colorSpec.overrides as Record<string, number> : {};
  color = { ...color, ...Object.fromEntries(Object.entries(overrides)
    .filter(([key, value]) => key in color && typeof value === 'number')
    .map(([key, value]) => [key, (color[key as keyof ColorAdjustments] ?? 0) + value])) } as ColorAdjustments;

  // Hook.
  const hookSpec = spec(resolved, 'HOOK');
  let hook: PreviewText | null = null;
  if (resolved && hookSpec.none !== true) {
    const base = preset(TEXT_STYLE_PRESETS, hookSpec.textStyle, 'HOOK');
    let style: Partial<TextStyle> = { ...base.style,
      ...(numeric(hookSpec.fontSize) ? { fontSize: numeric(hookSpec.fontSize) } : {}),
      ...(str(hookSpec.color) ? { color: str(hookSpec.color) } : {}),
      ...(str(hookSpec.fontFamily) ? { fontFamily: str(hookSpec.fontFamily) } : {}),
      ...(numeric(hookSpec.fontWeight) ? { fontWeight: numeric(hookSpec.fontWeight) } : {}),
      ...(hookSpec.noStroke === true ? { stroke: { ...NEUTRAL_STROKE }, shadow: { ...NEUTRAL_SHADOW },
        letterSpacing: 0 } : {}),
      ...(typeof hookSpec.uppercase === 'boolean' ? { uppercase: hookSpec.uppercase } : {}) };
    style = withPlate(style, hookSpec.plate, undefined);
    const y = numeric(background.hookY) ?? HOOK_Y[str(hookSpec.position) ?? 'TOP'] ?? 0.08;
    hook = { text: HOOK_SAMPLE[str(hookSpec.writing) ?? 'KEEP'] ?? HOOK_SAMPLE.KEEP,
      box: exact ? { x: exact.hook.x, y: exact.hook.y, width: exact.hook.width,
        height: exact.hook.height } : { x: base.box.x, y, width: base.box.width, height: base.box.height },
      maxLines: exact?.hook.maxLines ?? 3,
      style: { ...style, ...(exact ? { fontSize: exact.hook.fontSize,
        lineSpacing: exact.hook.lineHeight } : {}) }, activeWordColor: null,
      semanticColor: Array.isArray(hookSpec.semanticHighlightColor)
        ? hookSpec.semanticHighlightColor.filter((c): c is string => typeof c === 'string')
        : str(hookSpec.semanticHighlightColor) ? [str(hookSpec.semanticHighlightColor)!] : null };
  }

  // Captions.
  const capSpec = spec(resolved, 'CAPTIONS');
  let captions: PreviewText | null = null;
  if (capSpec.hidden !== true) {
    const base = preset(CAPTION_STYLE_PRESETS, capSpec.preset, 'CLEAN');
    let style: Partial<TextStyle> = { ...base.style,
      ...(numeric(capSpec.fontSize) ? { fontSize: numeric(capSpec.fontSize) } : {}),
      ...(str(capSpec.color) ? { color: str(capSpec.color) } : {}),
      ...(numeric(capSpec.fontWeight) ? { fontWeight: numeric(capSpec.fontWeight) } : {}),
      ...(str(capSpec.fontFamily) ? { fontFamily: str(capSpec.fontFamily) } : {}),
      ...(typeof capSpec.uppercase === 'boolean' ? { uppercase: capSpec.uppercase } : {}) };
    if (numeric(capSpec.strokeWidth)) style.stroke = { enabled: true, color: '#000000', width: numeric(capSpec.strokeWidth)! };
    if (capSpec.shadow === true && style.shadow) style.shadow = { ...style.shadow, enabled: true };
    style = withPlate(style, capSpec.plate, capSpec.plateOpacity);
    const activeOn = typeof capSpec.activeWord === 'boolean' ? capSpec.activeWord : !!base.style.activeWord?.enabled;
    const y = numeric(background.captionY) ?? numeric(capSpec.y) ?? base.box.y;
    captions = { text: 'captions follow every word', box: exact
      ? { x: exact.captions.x, y: exact.captions.y, width: exact.captions.width,
        height: exact.captions.height }
      : { x: base.box.x, y, width: base.box.width, height: base.box.height },
      maxLines: exact?.captions.maxLines ?? 2,
      style: { ...style, ...(exact ? { fontSize: exact.captions.fontSize,
        lineSpacing: exact.captions.lineHeight } : {}) },
      activeWordColor: activeOn ? str(capSpec.activeWordColor) ?? base.style.activeWord?.color ?? '#ffe066' : null };
  }

  const textSpec = spec(resolved, 'TEXT');
  const supporting = exact?.supportingText && textSpec.role === 'SUPPORTING_LINE'
    ? { text: 'Supporting line from this clip',
      box: { x: exact.supportingText.x, y: exact.supportingText.y,
        width: exact.supportingText.width, height: exact.supportingText.height },
      maxLines: exact.supportingText.maxLines,
      style: { ...preset(TEXT_STYLE_PRESETS, textSpec.textStyle, 'TITLE').style,
        ...(str(textSpec.fontFamily) ? { fontFamily: str(textSpec.fontFamily) } : {}),
        ...(str(textSpec.color) ? { color: str(textSpec.color) } : {}),
        ...(numeric(textSpec.fontWeight) ? { fontWeight: numeric(textSpec.fontWeight) } : {}),
        ...(textSpec.noStroke === true ? { stroke: { ...NEUTRAL_STROKE }, shadow: { ...NEUTRAL_SHADOW },
          letterSpacing: 0 } : {}),
        fontSize: exact.supportingText.fontSize, lineSpacing: exact.supportingText.lineHeight },
      activeWordColor: null } : null;

  const zoomSpec = spec(resolved, 'ZOOM');
  const zoomCount = numeric(zoomSpec.maxCount) ?? 0;
  const audioSpec = spec(resolved, 'AUDIO');
  const badges: string[] = [];
  if (resolved) {
    badges.push(resolved.templateId === 'AUTOMATIC_3_STYLE_TWO' ? 'Automatic zoom timing preserved' : zoomCount > 0 ? `Zoom: up to ${zoomCount} × ${Math.round(((numeric(zoomSpec.scale) ?? 1) - 1) * 100)}%`
      : 'Zoom: none');
    badges.push(`Framing: ${resolved.components.FRAMING?.name ?? 'Auto'}`);
    if (audioSpec.muteMusic === true) badges.push('Audio: voice only');
    else if (numeric(audioSpec.musicVolume) !== undefined) {
      badges.push(`Music ${Math.round(numeric(audioSpec.musicVolume)! * 100)}%${audioSpec.ducking ? `, ${String(audioSpec.ducking).toLowerCase()} ducking` : ''}`);
    }
  }
  const unsupported = resolved ? STYLE_CATEGORIES.map((category) => resolved.components[category])
    .filter((component) => component && (!component.supported || component.note))
    .map((component) => `${component.name ?? component.category}: ${component.note ?? 'not supported by the renderer'}`) : [];

  return {
    layout: exact ? (exact.videoFrame.mode === 'FIT' ? 'FIT' : 'FILL') : layout,
    fitBackground: exact?.background.color.toLowerCase() === '#ffffff' ? 'WHITE'
      : exact?.background.type === 'SOLID' ? 'BLACK' : fit === 'WHITE' ? 'WHITE' : fit === 'BLACK' ? 'BLACK' : 'BLUR',
    videoScale: exact?.videoFrame.width ?? (layout === 'FIT' ? Math.min(1, numeric(background.videoScale) ?? 1) : 1),
    // A still cannot show a tracked camera; face/information policies are
    // shown as a centred crop, which is what the renderer falls back to.
    objectPosition: policy === 'CENTERED' ? 'center' : 'center 35%',
    zoomScale: zoomCount > 0 ? Math.min(1.15, numeric(zoomSpec.scale) ?? 1) : 1,
    videoStyle: colorPreviewStyle(color),
    overlayLayers: colorOverlayLayers(color),
    hook, captions, supportingText: supporting,
    logoCorner: str(spec(resolved, 'OVERLAY').logoPosition) ?? null,
    badges, unsupported
  };
}
