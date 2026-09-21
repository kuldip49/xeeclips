// EditMode Phase 4 preset policies.
//
// A preset is a POLICY, not a fixed template: it states what a professional edit
// of this kind is allowed and expected to do, and the content-aware planner
// decides what the specific source actually justifies. Nothing here is a
// sequence of operations and nothing here is an opaque string - every field is a
// closed enum so the planner can reason about it and the API can validate it.

export const EDIT_PRESET_IDS = ['INSTAGRAM_REEL_PROFESSIONAL', 'PODCAST_CLIP', 'EDUCATIONAL',
  'PRODUCT_PROMO', 'MOTIVATIONAL', 'CLEAN_BUSINESS', 'MINIMAL', 'SOURCE_MANUAL'] as const;
export type EditPresetId = typeof EDIT_PRESET_IDS[number];

/** SOURCE keeps the uploaded frame shape; the rest are explicit render targets. */
export const EDIT_ASPECT_RATIOS = ['9:16', '16:9', '1:1', 'SOURCE'] as const;
export type EditAspectRatio = typeof EDIT_ASPECT_RATIOS[number];

/** How much the preset may compress dead air. SOURCE never trims. */
export const EDIT_PACING = ['SOURCE', 'RELAXED', 'MODERATE', 'TIGHT', 'STRONG'] as const;
export type EditPacing = typeof EDIT_PACING[number];

/** AUTO means "only when the source supports it"; ALWAYS still needs a transcript. */
export const SUBTITLE_POLICIES = ['OFF', 'AUTO', 'ALWAYS'] as const;
export type SubtitlePolicy = typeof SUBTITLE_POLICIES[number];

export const HOOK_POLICIES = ['OFF', 'AUTO', 'RECOMMENDED'] as const;
export type HookPolicy = typeof HOOK_POLICIES[number];

export const ZOOM_POLICIES = ['OFF', 'SUBTLE', 'MODERATE', 'STRONG'] as const;
export type ZoomPolicy = typeof ZOOM_POLICIES[number];

export const REFRAME_POLICIES = ['SOURCE', 'AUTO', 'FACE_FOCUSED', 'INFORMATION_PRESERVING'] as const;
export type ReframePolicy = typeof REFRAME_POLICIES[number];

/** Presets never fetch music. They keep what the user added, or offer to place a
 * user-uploaded asset; they never remove an existing music element. */
export const MUSIC_POLICIES = ['OFF', 'KEEP_EXISTING', 'OPTIONAL_USER_ASSET'] as const;
export type MusicPolicy = typeof MUSIC_POLICIES[number];

/** Style intent only - Phase 4 does not render grading. */
export const GRADING_POLICIES = ['NONE', 'SUBTLE', 'CLEAN', 'WARM', 'CONTRAST'] as const;
export type GradingPolicy = typeof GRADING_POLICIES[number];

export const TEXT_POLICIES = ['OFF', 'MINIMAL', 'CTA_ONLY', 'KEY_POINTS'] as const;
export type TextPolicy = typeof TEXT_POLICIES[number];

export const OVERLAY_POLICIES = ['NONE', 'MINIMAL', 'USER_ASSETS', 'PRODUCT_FORWARD'] as const;
export type OverlayPolicy = typeof OVERLAY_POLICIES[number];

/** RESPECT keeps text readable; PRESERVE additionally forbids any zoom over it. */
export const INFORMATION_REGION_POLICIES = ['IGNORE', 'RESPECT', 'PRESERVE'] as const;
export type InformationRegionPolicy = typeof INFORMATION_REGION_POLICIES[number];

export type EditPresetPolicy = {
  readonly id: EditPresetId;
  readonly displayName: string;
  readonly description: string;
  /** false only for SOURCE_MANUAL: the planner emits no transformation at all. */
  readonly automatic: boolean;
  readonly aspectRatio: EditAspectRatio;
  /** Keep the source shape when it is already composed for the target. */
  readonly sourceAwareAspect: boolean;
  readonly pacing: EditPacing;
  readonly subtitlePolicy: SubtitlePolicy;
  readonly hookPolicy: HookPolicy;
  readonly reframingPolicy: ReframePolicy;
  readonly zoomPolicy: ZoomPolicy;
  readonly textPolicy: TextPolicy;
  readonly audioPolicy: MusicPolicy;
  readonly overlayPolicy: OverlayPolicy;
  readonly gradingPolicy: GradingPolicy;
  readonly informationRegionPolicy: InformationRegionPolicy;
  /** Ceiling, never a quota, for preset-authored key-point callouts. */
  readonly maxKeyPointTexts: number;
  /** Seconds of leading/trailing silence tolerated before a lead-in trim. */
  readonly leadInToleranceSec: number;
};

const preset = (policy: EditPresetPolicy) => policy;

export const EDIT_PRESETS: Readonly<Record<EditPresetId, EditPresetPolicy>> = {
  INSTAGRAM_REEL_PROFESSIONAL: preset({
    id: 'INSTAGRAM_REEL_PROFESSIONAL', displayName: 'Instagram Reel — Professional',
    description: 'Social-native vertical framing with clean pacing, subtitles when the source ' +
      'supports them, and emphasis only where the words justify it.',
    automatic: true, aspectRatio: '9:16', sourceAwareAspect: false, pacing: 'MODERATE',
    subtitlePolicy: 'AUTO', hookPolicy: 'AUTO', reframingPolicy: 'AUTO', zoomPolicy: 'SUBTLE',
    textPolicy: 'MINIMAL', audioPolicy: 'KEEP_EXISTING', overlayPolicy: 'MINIMAL',
    gradingPolicy: 'SUBTLE', informationRegionPolicy: 'RESPECT',
    maxKeyPointTexts: 0, leadInToleranceSec: 0.6
  }),
  PODCAST_CLIP: preset({
    id: 'PODCAST_CLIP', displayName: 'Podcast Clip',
    description: 'Dialogue first: speaker-aware framing, pair composition when both people ' +
      'matter, readable subtitles, and almost no overlay.',
    automatic: true, aspectRatio: '9:16', sourceAwareAspect: false, pacing: 'MODERATE',
    subtitlePolicy: 'ALWAYS', hookPolicy: 'AUTO', reframingPolicy: 'FACE_FOCUSED',
    zoomPolicy: 'SUBTLE', textPolicy: 'OFF', audioPolicy: 'KEEP_EXISTING', overlayPolicy: 'NONE',
    gradingPolicy: 'CLEAN', informationRegionPolicy: 'RESPECT',
    maxKeyPointTexts: 0, leadInToleranceSec: 0.8
  }),
  EDUCATIONAL: preset({
    id: 'EDUCATIONAL', displayName: 'Educational',
    description: 'Protects charts, slides, screenshots and documents. Readability wins over ' +
      'motion, with subtitles and at most a couple of key-point callouts.',
    automatic: true, aspectRatio: '9:16', sourceAwareAspect: true, pacing: 'RELAXED',
    subtitlePolicy: 'ALWAYS', hookPolicy: 'AUTO', reframingPolicy: 'INFORMATION_PRESERVING',
    zoomPolicy: 'OFF', textPolicy: 'KEY_POINTS', audioPolicy: 'KEEP_EXISTING',
    overlayPolicy: 'MINIMAL', gradingPolicy: 'CLEAN', informationRegionPolicy: 'PRESERVE',
    maxKeyPointTexts: 2, leadInToleranceSec: 1
  }),
  PRODUCT_PROMO: preset({
    id: 'PRODUCT_PROMO', displayName: 'Product Promo',
    description: 'Commercial pacing that foregrounds product imagery and a logo you uploaded, ' +
      'with one short call to action when the source supports it.',
    automatic: true, aspectRatio: '9:16', sourceAwareAspect: false, pacing: 'TIGHT',
    subtitlePolicy: 'AUTO', hookPolicy: 'RECOMMENDED', reframingPolicy: 'AUTO',
    zoomPolicy: 'MODERATE', textPolicy: 'CTA_ONLY', audioPolicy: 'OPTIONAL_USER_ASSET',
    overlayPolicy: 'PRODUCT_FORWARD', gradingPolicy: 'CONTRAST',
    informationRegionPolicy: 'RESPECT', maxKeyPointTexts: 0, leadInToleranceSec: 0.4
  }),
  MOTIVATIONAL: preset({
    id: 'MOTIVATIONAL', displayName: 'Motivational',
    description: 'Stronger pacing and emphasis that still stays accurate: an impactful headline ' +
      'only when the words earn it, and intelligibility over effect.',
    automatic: true, aspectRatio: '9:16', sourceAwareAspect: false, pacing: 'STRONG',
    subtitlePolicy: 'ALWAYS', hookPolicy: 'RECOMMENDED', reframingPolicy: 'FACE_FOCUSED',
    zoomPolicy: 'MODERATE', textPolicy: 'MINIMAL', audioPolicy: 'OPTIONAL_USER_ASSET',
    overlayPolicy: 'MINIMAL', gradingPolicy: 'CONTRAST', informationRegionPolicy: 'RESPECT',
    maxKeyPointTexts: 0, leadInToleranceSec: 0.4
  }),
  CLEAN_BUSINESS: preset({
    id: 'CLEAN_BUSINESS', displayName: 'Clean Business',
    description: 'Restrained and highly readable: neutral grading, clean typography, minimal ' +
      'zoom and overlays, professional framing.',
    automatic: true, aspectRatio: 'SOURCE', sourceAwareAspect: true, pacing: 'MODERATE',
    subtitlePolicy: 'AUTO', hookPolicy: 'OFF', reframingPolicy: 'AUTO', zoomPolicy: 'SUBTLE',
    textPolicy: 'OFF', audioPolicy: 'KEEP_EXISTING', overlayPolicy: 'MINIMAL',
    gradingPolicy: 'NONE', informationRegionPolicy: 'RESPECT',
    maxKeyPointTexts: 0, leadInToleranceSec: 1
  }),
  MINIMAL: preset({
    id: 'MINIMAL', displayName: 'Minimal',
    description: 'Preserves the source. No hook, no music, no zoom - only the cleanup the ' +
      'source actually needs, with subtitles left configurable.',
    automatic: true, aspectRatio: 'SOURCE', sourceAwareAspect: true, pacing: 'SOURCE',
    subtitlePolicy: 'AUTO', hookPolicy: 'OFF', reframingPolicy: 'SOURCE', zoomPolicy: 'OFF',
    textPolicy: 'OFF', audioPolicy: 'KEEP_EXISTING', overlayPolicy: 'NONE',
    gradingPolicy: 'NONE', informationRegionPolicy: 'RESPECT',
    maxKeyPointTexts: 0, leadInToleranceSec: 1.5
  }),
  SOURCE_MANUAL: preset({
    id: 'SOURCE_MANUAL', displayName: 'Source / Manual',
    description: 'Applies no automatic transformation. Records the choice and leaves the ' +
      'timeline exactly as it is, as a clean starting point for manual editing.',
    automatic: false, aspectRatio: 'SOURCE', sourceAwareAspect: true, pacing: 'SOURCE',
    subtitlePolicy: 'OFF', hookPolicy: 'OFF', reframingPolicy: 'SOURCE', zoomPolicy: 'OFF',
    textPolicy: 'OFF', audioPolicy: 'KEEP_EXISTING', overlayPolicy: 'NONE',
    gradingPolicy: 'NONE', informationRegionPolicy: 'RESPECT',
    maxKeyPointTexts: 0, leadInToleranceSec: 0
  })
};

export const editPresetList = (): EditPresetPolicy[] =>
  EDIT_PRESET_IDS.map((id) => EDIT_PRESETS[id]);

export const isEditPresetId = (value: unknown): value is EditPresetId =>
  typeof value === 'string' && (EDIT_PRESET_IDS as readonly string[]).includes(value);

/** Zoom intent recorded for the later render phase; Phase 4 renders nothing. */
export type PlannedZoomMoment = { startSec: number; endSec: number; reason: string;
  triggerText: string; intensity: Exclude<ZoomPolicy, 'OFF'> };

/** The style block persisted on EditProject.settings. */
export type EditProjectStyle = {
  selectedPreset: EditPresetId;
  aspectRatio: EditAspectRatio;
  pacing: EditPacing;
  subtitlePolicy: SubtitlePolicy;
  hookPolicy: HookPolicy;
  zoomPolicy: ZoomPolicy;
  reframePolicy: ReframePolicy;
  musicPolicy: MusicPolicy;
  gradingPolicy: GradingPolicy;
  textPolicy: TextPolicy;
  overlayPolicy: OverlayPolicy;
  informationRegionPolicy: InformationRegionPolicy;
  /** Resolved headline, or null when no grounded hook cleared the quality bar. */
  hookText: string | null;
};

/** Bookkeeping for the last preset run, so a reapply replaces exactly what it
 * created and nothing else. */
export type EditPresetRun = {
  presetId: EditPresetId;
  presetRunId: string;
  appliedAtRevision: number;
  summary: string;
  plannedZoomMoments: PlannedZoomMoment[];
  /** Video trims this run authored, so a reapply can tell them from manual trims. */
  trims: Array<{ elementId: string; trimStart: number; trimEnd: number }>;
};

const STYLE_ENUMS: Record<Exclude<keyof EditProjectStyle, 'selectedPreset' | 'hookText'>,
  readonly string[]> = {
  aspectRatio: EDIT_ASPECT_RATIOS, pacing: EDIT_PACING, subtitlePolicy: SUBTITLE_POLICIES,
  hookPolicy: HOOK_POLICIES, zoomPolicy: ZOOM_POLICIES, reframePolicy: REFRAME_POLICIES,
  musicPolicy: MUSIC_POLICIES, gradingPolicy: GRADING_POLICIES, textPolicy: TEXT_POLICIES,
  overlayPolicy: OVERLAY_POLICIES, informationRegionPolicy: INFORMATION_REGION_POLICIES
};

/** Reads the style block out of EditProject.settings, falling back to the
 * defaults for anything a project has not chosen yet. Unknown values are
 * ignored rather than trusted, since settings is free-form JSON. */
export function readEditProjectStyle(settings: unknown): EditProjectStyle {
  const record = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? settings as Record<string, unknown> : {};
  const style = { ...DEFAULT_EDIT_PROJECT_STYLE };
  if (isEditPresetId(record.selectedPreset)) style.selectedPreset = record.selectedPreset;
  if (record.hookText === null || typeof record.hookText === 'string') {
    style.hookText = record.hookText === null ? null : record.hookText.slice(0, 200);
  }
  for (const [key, options] of Object.entries(STYLE_ENUMS)) {
    const value = record[key];
    if (typeof value === 'string' && options.includes(value)) {
      (style as unknown as Record<string, string>)[key] = value;
    }
  }
  return style;
}

export function readEditPresetRun(settings: unknown): EditPresetRun | null {
  const record = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? settings as Record<string, unknown> : {};
  const run = record.presetRun;
  if (!run || typeof run !== 'object' || Array.isArray(run)) return null;
  const value = run as Record<string, unknown>;
  if (!isEditPresetId(value.presetId) || typeof value.presetRunId !== 'string') return null;
  const trims = (Array.isArray(value.trims) ? value.trims : []).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const trim = item as Record<string, unknown>;
    return typeof trim.elementId === 'string' && Number.isFinite(Number(trim.trimStart)) &&
      Number.isFinite(Number(trim.trimEnd))
      ? [{ elementId: trim.elementId, trimStart: Number(trim.trimStart),
        trimEnd: Number(trim.trimEnd) }] : [];
  });
  return { presetId: value.presetId, presetRunId: value.presetRunId,
    appliedAtRevision: Number(value.appliedAtRevision) || 0,
    summary: typeof value.summary === 'string' ? value.summary : '',
    plannedZoomMoments: Array.isArray(value.plannedZoomMoments)
      ? value.plannedZoomMoments as PlannedZoomMoment[] : [],
    trims };
}

export const DEFAULT_EDIT_PROJECT_STYLE: EditProjectStyle = {
  selectedPreset: 'SOURCE_MANUAL', aspectRatio: 'SOURCE', pacing: 'SOURCE',
  subtitlePolicy: 'OFF', hookPolicy: 'OFF', zoomPolicy: 'OFF', reframePolicy: 'SOURCE',
  musicPolicy: 'KEEP_EXISTING', gradingPolicy: 'NONE', textPolicy: 'OFF',
  overlayPolicy: 'NONE', informationRegionPolicy: 'RESPECT', hookText: null
};
