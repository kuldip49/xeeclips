import type { ChatContext } from '../chat/edit-chat-context';
import type { BackgroundSpec, CaptionSpec, FramingSpec, HookSpec } from './creative-style-library';
import type { ResolvedCreativeStyle } from './creative-style-resolver';
import { AUTOMATIC_2_STREET3_LAYOUT as STREET3 } from './automatic-2-street3-layout';

export type NormalizedRect = { x: number; y: number; width: number; height: number };
export type ResolvedVisualLayout = {
  version: 1;
  editingProfile?: 'AUTOMATIC_2';
  canvas: { width: 1080; height: 1920; aspect: '9:16' };
  videoFrame: NormalizedRect & { mode: 'FILL' | 'FIT' | 'CARD'; cropPolicy: string };
  hook: NormalizedRect & { enabled: boolean; maxWidth: number; maxLines: 2 | 3;
    fontSize: number; lineHeight: number; safeRegion: 'TOP'; glyphWidthEm?: number };
  captions: NormalizedRect & { maxWidth: number; maxLines: 2; fontSize: number;
    lineHeight: number; baseline: number; activeWordScale: 1; safeRegion: 'LOWER_THIRD' };
  background: { type: 'BLUR' | 'SOLID' | 'VIDEO'; color: string; blur: number };
  supportingText?: NormalizedRect & { enabled: boolean; maxWidth: number; maxLines: 2;
    fontSize: number; lineHeight: number; safeRegion: 'BOTTOM'; glyphWidthEm?: number };
  safeAreas: { top: number; bottom: number; left: number; right: number };
  faceSafeRegion?: NormalizedRect & { eyeMinY: number; eyeMaxY: number };
  /** Canonical crop samples used by browser preview; export recomputes the same
   * pure camera from the same analysis and validates it before rendering. */
  cameraPath?: Array<{ t: number; x: number; y: number; w: number; h: number }>;
  overlays: { logo: NormalizedRect };
};

const spec = <T>(resolved: ResolvedCreativeStyle, category: keyof ResolvedCreativeStyle['components']) => {
  const value = resolved.components[category];
  return value?.source !== 'DEFAULT' && value?.spec ? value.spec as T : null;
};

/** Deterministic approximation shared by preview, canonical state and render.
 * Font units use the editor's 600-wide design canvas convention. */
export function autoFitText(text: string, input: { width: number; height: number; maxLines: number;
  preferred: number; minimum: number; lineHeight: number; glyphWidthEm?: number }) {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  let size = input.preferred;
  for (; size >= input.minimum; size -= 2) {
    // Inter ExtraBold/uppercase hooks are materially wider than the common
    // 0.56-em body-text estimate. A conservative 0.64-em measure keeps the
    // deterministic result inside the promised three-line region in both CSS
    // and libass instead of allowing a fourth line at preview scale.
    const capacity = Math.max(1, input.width * 600 / (size * (input.glyphWidthEm ?? 0.64)));
    let lines = 1;
    let used = 0;
    for (const word of words) {
      const next = word.length + (used ? 1 : 0);
      if (used && used + next > capacity) { lines += 1; used = word.length; }
      else used += next;
    }
    const normalizedHeight = lines * size * input.lineHeight / 1920 * (1080 / 600);
    if (lines <= input.maxLines && normalizedHeight <= input.height) return size;
  }
  return input.minimum;
}

export function resolveVisualLayout(resolved: ResolvedCreativeStyle, evidence?: {
  sourceWidth?: number | null; sourceHeight?: number | null; faceShotRatio?: number;
  hookText?: string | null;
}): ResolvedVisualLayout {
  const background = spec<BackgroundSpec>(resolved, 'BACKGROUND');
  const framing = spec<FramingSpec>(resolved, 'FRAMING');
  const hookStyle = spec<HookSpec>(resolved, 'HOOK');
  const captionStyle = spec<CaptionSpec>(resolved, 'CAPTIONS');
  const sourceLandscape = (evidence?.sourceWidth ?? 16) / Math.max(1, evidence?.sourceHeight ?? 9) > 1.15;
  const backgroundKind = background?.fitBackground ?? 'BLUR';
  const street = background?.composition === 'STREET_EDITORIAL';
  const requestedFit = background?.layout === 'FIT' || framing?.layout === 'FIT';
  // A black 9:16 talking-head composition gets a deliberate central picture
  // region, not a 16:9 image floating at 32% canvas height with enormous bars.
  const card = street || (sourceLandscape && requestedFit && backgroundKind === 'BLACK');
  // Automatic 2: the outer geometry is one measured constant (street3.mp4). No
  // source, face-count or B-roll evidence may change it.
  const videoFrame: ResolvedVisualLayout['videoFrame'] = street
    ? { ...STREET3.mediaBox, mode: 'CARD', cropPolicy: framing?.reframePolicy ?? 'AUTO' }
    : card
    ? { x: 0.035, y: 0.19, width: 0.93, height: 0.62, mode: 'CARD',
      cropPolicy: framing?.reframePolicy ?? 'AUTO' }
    : { x: 0, y: 0, width: 1, height: 1, mode: requestedFit ? 'FIT' : 'FILL',
      cropPolicy: framing?.reframePolicy ?? 'AUTO' };
  const hookText = evidence?.hookText ?? 'Your clip’s hook';
  const hookRect = street
    ? { ...STREET3.hookBox }
    : card
    ? { x: 0.07, y: 0.045, width: 0.86, height: 0.12 }
    : { x: 0.07, y: 0.055, width: 0.86, height: 0.18 };
  const hookPreferred = street ? STREET3.typography.hook.fontSize
    : Math.min(52, hookStyle?.fontSize ?? 48);
  const hookFont = autoFitText(hookText, { width: hookRect.width, height: hookRect.height,
    maxLines: street ? 2 : 3, preferred: hookPreferred, minimum: street ? 22 : 30,
    lineHeight: street ? STREET3.typography.hook.lineHeight : 1.08,
    ...(street ? { glyphWidthEm: STREET3.typography.glyphWidthEm } : {}) });
  const captionRect = street
    // Keep the caption block in the bottom of the card. The Automatic 2 camera
    // holds eyes at 30%-40% of the card and the complete face above this band,
    // so subtitles do not cover the mouth/chin.
    ? { ...STREET3.captionSafeBox }
    : card
    ? { x: 0.07, y: 0.835, width: 0.86, height: 0.105 }
    : { x: 0.075, y: Math.min(0.78, captionStyle?.y ?? 0.74), width: 0.85, height: 0.14 };
  const captionFont = street ? STREET3.typography.captions.fontSize
    : Math.min(42, Math.max(28, captionStyle?.fontSize ?? 38));
  return {
    version: 1,
    ...(resolved.templateId === 'AUTOMATIC_2'
      ? { editingProfile: 'AUTOMATIC_2' as const,
        faceSafeRegion: { x: 0.1, y: 0.1, width: 0.8, height: 0.58,
          eyeMinY: 0.3, eyeMaxY: 0.4 } } : {}),
    canvas: { width: 1080, height: 1920, aspect: '9:16' },
    videoFrame,
    hook: { ...hookRect, enabled: hookStyle?.none !== true, maxWidth: hookRect.width,
      maxLines: street ? 2 : 3, fontSize: hookFont,
      lineHeight: street ? STREET3.typography.hook.lineHeight : 1.08,
      safeRegion: 'TOP', ...(street ? { glyphWidthEm: STREET3.typography.glyphWidthEm } : {}) },
    captions: { ...captionRect, maxWidth: captionRect.width, maxLines: 2,
      fontSize: captionFont, lineHeight: 1.16, baseline: captionRect.y + captionRect.height / 2,
      activeWordScale: 1, safeRegion: 'LOWER_THIRD' },
    background: street ? { type: 'SOLID', color: STREET3.colors.background, blur: 0 }
      : backgroundKind === 'BLACK'
      ? { type: 'SOLID', color: '#000000', blur: 0 }
      : backgroundKind === 'WHITE'
        ? { type: 'SOLID', color: '#ffffff', blur: 0 }
        : requestedFit ? { type: 'BLUR', color: '#000000', blur: 28 }
          : { type: 'VIDEO', color: '#000000', blur: 0 },
    ...(street ? { supportingText: { ...STREET3.supportingTextBox,
      enabled: true, maxWidth: STREET3.supportingTextBox.width, maxLines: 2 as const,
      fontSize: STREET3.typography.support.fontSize,
      lineHeight: STREET3.typography.support.lineHeight,
      safeRegion: 'BOTTOM' as const, glyphWidthEm: STREET3.typography.glyphWidthEm } } : {}),
    safeAreas: { top: 0.035, bottom: 0.055, left: 0.05, right: 0.05 },
    overlays: { logo: { x: 0.78, y: 0.055, width: 0.16, height: 0.09 } }
  };
}

export function layoutEvidenceFromContext(context: ChatContext, hookText?: string | null) {
  const source = context.assets.find((asset) => asset.role === 'SOURCE');
  return { sourceWidth: source?.width, sourceHeight: source?.height,
    faceShotRatio: context.analysis.faceShotRatio, hookText };
}
