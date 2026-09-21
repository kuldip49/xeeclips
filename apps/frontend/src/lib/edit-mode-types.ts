export type EditProjectStatus = 'DRAFT' | 'READY' | 'EXPORTING' | 'COMPLETED' | 'FAILED';
export type EditAssetRole = 'SOURCE' | 'OVERLAY' | 'AUDIO' | 'IMAGE' | 'LOGO' | 'EXPORT';
export type EditElementType = 'VIDEO' | 'AUDIO' | 'TEXT' | 'SUBTITLE' | 'IMAGE' | 'EFFECT';

export type EditAnalysisSummary = {
  sampledFrameCount: number;
  faceDetections: number;
  mouthActivitySamples: number;
  shotCount: number;
  ocrRegionCount: number;
};

export type EditAsset = {
  id: string;
  editProjectId: string;
  sourceVideoId?: string | null;
  role: EditAssetRole;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  metadata: Record<string, unknown>;
  transcript?: Record<string, unknown> | null;
  analysis?: {
    source?: string;
    summary?: EditAnalysisSummary;
    shotBoundaries?: number[];
    ocrText?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
};

export type EditElement = {
  id: string;
  editProjectId: string;
  assetId?: string | null;
  type: EditElementType;
  track: number;
  position: number;
  startTime: number;
  duration: number;
  trimStart: number;
  trimEnd?: number | null;
  properties: Record<string, unknown>;
};

/** Visual coordinates are normalized to the preview canvas (0..1), from its top-left corner. */
export type VisualElementProperties = {
  x: number; y: number; width: number; height: number; scale?: number; rotation: number; opacity: number;
  zIndex: number; anchor: 'top-left'; locked: boolean; role?: 'IMAGE' | 'LOGO';
  content?: string; fontSize?: number; fontWeight?: number; fontFamily?: string;
  textAlign?: 'left' | 'center' | 'right'; color?: string; backgroundColor?: string;
};

/** Audio volume is normalized: 0 is silent and 1 is the asset's original level. */
export type AudioElementProperties = {
  volume: number; muted: boolean; fadeInSec: number; fadeOutSec: number;
  duckUnderSpeech?: boolean; duckLevel?: number; attackMs?: number; releaseMs?: number;
};

export type EditProject = {
  id: string;
  name: string;
  sourceProjectId?: string | null;
  status: EditProjectStatus;
  settings: Record<string, unknown>;
  revision: number;
  assets: EditAsset[];
  elements?: EditElement[];
  _count?: { elements: number; history: number };
  createdAt: string;
  updatedAt: string;
};

export type EditHistory = {
  id: string;
  editProjectId: string;
  revision: number;
  actor: 'USER' | 'PRESET' | 'ASSISTANT' | 'SYSTEM';
  action: string;
  command?: Record<string, unknown> | null;
  beforeState?: Record<string, unknown> | null;
  afterState: Record<string, unknown>;
  createdAt: string;
};

export type SourceVideoOption = {
  id: string;
  originalName: string;
  project?: { id: string; name: string };
};

// --- EditMode Phase 4: presets ---------------------------------------------

export type EditPresetId = 'INSTAGRAM_REEL_PROFESSIONAL' | 'PODCAST_CLIP' | 'EDUCATIONAL' |
  'PRODUCT_PROMO' | 'MOTIVATIONAL' | 'CLEAN_BUSINESS' | 'MINIMAL' | 'SOURCE_MANUAL';
export type EditAspectRatio = '9:16' | '16:9' | '1:1' | 'SOURCE';
export type SubtitlePolicy = 'OFF' | 'AUTO' | 'ALWAYS';
export type HookPolicy = 'OFF' | 'AUTO' | 'RECOMMENDED';
export type ZoomPolicy = 'OFF' | 'SUBTLE' | 'MODERATE' | 'STRONG';
export type ReframePolicy = 'SOURCE' | 'AUTO' | 'FACE_FOCUSED' | 'INFORMATION_PRESERVING';
export type MusicPolicy = 'OFF' | 'KEEP_EXISTING' | 'OPTIONAL_USER_ASSET';
export type GradingPolicy = 'NONE' | 'SUBTLE' | 'CLEAN' | 'WARM' | 'CONTRAST';

export type EditPresetSummary = {
  id: EditPresetId;
  displayName: string;
  description: string;
  automatic: boolean;
  aspectRatio: EditAspectRatio;
  pacing: string;
  subtitlePolicy: SubtitlePolicy;
  hookPolicy: HookPolicy;
  reframingPolicy: ReframePolicy;
  zoomPolicy: ZoomPolicy;
  textPolicy: string;
  audioPolicy: MusicPolicy;
  overlayPolicy: string;
  gradingPolicy: GradingPolicy;
  informationRegionPolicy: string;
};

/** The style block a preset persists on EditProject.settings. */
export type EditProjectStyle = {
  selectedPreset: EditPresetId;
  aspectRatio: EditAspectRatio;
  pacing: string;
  subtitlePolicy: SubtitlePolicy;
  hookPolicy: HookPolicy;
  zoomPolicy: ZoomPolicy;
  reframePolicy: ReframePolicy;
  musicPolicy: MusicPolicy;
  gradingPolicy: GradingPolicy;
  textPolicy: string;
  overlayPolicy: string;
  informationRegionPolicy: string;
  hookText: string | null;
};

export type EditPresetEstimatedChanges = {
  trims: number;
  overlays: number;
  subtitles: number;
  removedPresetElements: number;
  subtitlePolicyChanged: boolean;
  zoomPolicyChanged: boolean;
  reframePolicyChanged: boolean;
  aspectRatioChanged: boolean;
  hookChanged: boolean;
};

/** A preview proposal. `commands` is intentionally not surfaced in the UI. */
export type EditPresetProposal = {
  mode?: 'PREVIEW';
  presetId: EditPresetId;
  displayName: string;
  description: string;
  summary: string;
  plannedChanges: string[];
  affectedElements: string[];
  warnings: string[];
  estimatedChanges: EditPresetEstimatedChanges;
  style: EditProjectStyle;
  generation: 'DETERMINISTIC' | 'LLM_ASSISTED';
  evidence: {
    sourceDurationSec: number;
    transcriptAvailable: boolean;
    analysisAvailable: boolean;
    analysisSource: string;
    shotCount: number;
    informationShotRatio: number;
    faceShotRatio: number;
    pairShotRatio: number;
    semanticPeakCount: number;
  };
};

export type EditPresetApplyResult = {
  mode: 'APPLY';
  presetRunId: string;
  plan: Omit<EditPresetProposal, 'mode'>;
  project: EditProject;
};
