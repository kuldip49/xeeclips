/** Versioned, normalized Quick Reframe editing contract. Source time is never remapped. */
export type ReframeBox = { x: number; y: number; w: number; h: number };
export type ReframeRegion = ReframeBox & { id: string; start: number; end: number;
  confidence: number; text: string; kind: 'DECORATIVE' | 'CAPTION' | 'ATTRIBUTION' | 'INFORMATION' | 'UNKNOWN' };
export type ReframeAnalysis = { regions: ReframeRegion[];
  frames: { t: number; faces: ReframeBox[]; persons: ReframeBox[]; information: ReframeBox[] }[];
  boundaries: number[]; subtitleState: 'EXISTING_READABLE' | 'MISSING' | 'PARTIAL_OR_UNREADABLE';
  warnings: string[]; appearance?: { brightness: number; contrast: number };
  bars: { top: number; bottom: number; left: number; right: number };
  /** False when OCR was unavailable, so "no captions" could not be established. */
  ocrAvailable?: boolean };
/**
 * Crop shape: SOURCE = locked to the original ratio, CUSTOM = Free Crop (no lock), "W:H" = a preset or
 * user-entered ratio. STYLEONE (StyleOne's 1080x700 window) is only kept for sessions saved by V2.
 */
export type ReframeAspect = 'SOURCE' | 'CUSTOM' | 'STYLEONE' | `${number}:${number}`;
/** Overlay drawn over the crop area while adjusting. Display only: never changes the crop. */
export type ReframeCropGrid = 'THIRDS' | 'GRID3' | 'GRID4' | 'CROSSHAIR' | 'GOLDEN' | 'NONE';
export type ReframeCleanup = ReframeBox & { regionId: string; start: number; end: number; method: 'BLUR' | 'COVER';
  intensity: number; authorized: boolean; ownedBranding?: boolean };
export type ReframePlan = { version: 1; aspect: ReframeAspect;
  /** Normalized to the uploaded frame and fixed for the whole video: exactly what the user chose. */
  crop: ReframeBox; framing: 'CROP' | 'FIT';
  /** V1/V2 subject tracking. V3 never creates it and saving a crop removes it. */
  tracking?: { t: number; x: number; y: number }[];
  grid?: ReframeCropGrid;
  cleanup: ReframeCleanup[];
  hook: { enabled: boolean; text: string; y: number };
  captions: { enabled: boolean; replaceExisting: boolean; font: string; size: number; y: number; color: string;
    cues: { start: number; end: number; text: string }[] };
  color: { exposure: number; contrast: number; saturation: number; temperature: number; sharpness: number; denoise: boolean };
  audio: { muted: boolean; volume: number }; resolution: 720 | 1080; reasons: string[] };
/** The part of a plan that changes source pixels. Confirming the crop bakes exactly this into SOURCE. */
export type ReframePreparation = Pick<ReframePlan, 'aspect' | 'crop' | 'framing' | 'tracking' | 'cleanup'> & { denoise: boolean };
export type ReframeHookCategory = 'BOLD' | 'CURIOSITY' | 'QUESTION' | 'CONTRARIAN' | 'EMOTIONAL' | 'PROFESSIONAL';
export type ReframeHook = { text: string; category: ReframeHookCategory; score: number; recommended: boolean;
  source: 'OPENAI' | 'LOCAL' };
export type ReframeEditPath = 'STYLEONE' | 'MANUAL';
/** Social post copy is metadata, never a timeline element or burned-in subtitle. */
export type ReframeSocialSource = { sourcePostText: string; sourceHashtags: string[];
  sourcePlatform: 'instagram' | 'x'; sourcePostUrl: string; sourceAuthor?: string; sourcePostTitle?: string };
export type ReframeSocialCaption = { style: 'Concise' | 'Engaging' | 'Professional' | 'Conversational' | 'Bold';
  text: string; recommended: boolean };
export type ReframeHashtagSet = { label: 'Focused' | 'Broad' | 'Niche'; hashtags: string[] };
export type ReframeContentUnderstanding = { topic: string; mainMessage: string; audience: string; tone: string;
  keyPoints: string[]; importantEntities: string[]; callToAction: string; existingCaptionIntent: string };
export type ReframePostCopy = { version: number; generatedCaptions: ReframeSocialCaption[];
  generatedHashtagSets: ReframeHashtagSet[]; selectedCaption: string; selectedHashtags: string[];
  understanding?: ReframeContentUnderstanding; editingDirection?: string; purpose?: string;
  /** Media revision used to generate these suggestions; copy edits do not invalidate video exports. */
  contextRevision?: number };
export type ReframeExport = { id: string; url: string; revision: number | null; width: number | null;
  height: number | null; duration: number | null; sizeBytes: number | null; createdAt: string; current: boolean };
export type ReframeSession = { id: string; editProjectId: string; revision: number; name: string; duration: number;
  /** Uploaded file (browser-playable copy when the codec needed one). Crop coordinates refer to this. */
  width: number; height: number; originalUrl: string | null;
  /** The confirmed, cropped and cleaned SOURCE every editing path renders from. */
  sourceUrl: string | null; sourceWidth: number; sourceHeight: number;
  /** True when SOURCE matches the current plan's crop and cleanup. */
  cropConfirmed: boolean; confirmed: ReframePreparation | null; editPath: ReframeEditPath | null;
  styleOneApplied: boolean;
  previewUrl: string | null; exportUrl: string | null; previewRevision: number | null; exportRevision: number | null;
  exports: ReframeExport[];
  status: string; progress: number; message: string; error: string | null;
  analysis: ReframeAnalysis | null; plan: ReframePlan | null; hooks: ReframeHook[];
  sourceContext?: ReframeSocialSource | null; postCopy?: ReframePostCopy;
  /** Exact export canvases for each quality (null until the crop is confirmed). */
  outputs: { 720: { width: number; height: number }; 1080: { width: number; height: number } } | null;
  hasAudio: boolean; hasTranscript: boolean; captionCount: number; createdAt: string };
