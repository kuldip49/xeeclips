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

// --- EditMode Phase 5: render and export -----------------------------------

export type EditExportPhase = 'PREPARING' | 'RENDERING' | 'QA' | 'UPLOADING' | 'COMPLETED'
  | 'FAILED';
export type EditExportErrorCode = 'SOURCE_MISSING' | 'ASSET_MISSING' | 'INVALID_TIMELINE'
  | 'UNSUPPORTED_MEDIA' | 'RENDER_FAILED' | 'QA_FAILED' | 'UPLOAD_FAILED' | 'STALE_EXPORT'
  | 'EXPORT_ALREADY_RUNNING'
  /** The backend restarted mid-render; startup recovery settled this export. */
  | 'INTERRUPTED';
export type QaResult = 'PASS' | 'DEGRADED_ACCEPTABLE' | 'REPAIR_REQUIRED' | 'REJECT';

export type EditExportProgress = {
  exportId: string;
  phase: EditExportPhase;
  percent: number;
  sourceRevision: number;
  startedAt: string;
  updatedAt: string;
  attempt: number;
  assetId: string | null;
  errorCode: EditExportErrorCode | null;
  message: string | null;
  /** Present only when startup recovery, not the render itself, ended this. */
  recoveredAt?: string;
};

/** What one finished render recorded about itself. */
export type EditExportMetadata = {
  sourceRevision: number;
  stale: boolean;
  preset: EditPresetId;
  aspectRatio: EditAspectRatio;
  resolution: { width: number | null; height: number | null };
  durationSec: number | null;
  codec: { video: string | null; audio: string | null };
  bitrate: number | null;
  fileSizeBytes: number;
  renderDurationMs: number;
  attempts: number;
  qa: { result: QaResult; sampledFrameCount: number;
    checks: Array<{ id: string; result: QaResult; detail: string }> };
  zoom: { rendered: number; rejected: number; reduced: number };
  grading: { policy: GradingPolicy; preset: string; strengthScale: number };
  segments: number;
  overlays: number;
  textElements: number;
  subtitles: number;
  subtitlesFromTranscript: boolean;
  audioTracks: number;
  warnings: string[];
};

/** An EditAsset(role: EXPORT), with the currency of its source revision. */
export type EditExport = EditAsset & {
  metadata: EditExportMetadata;
  sourceRevision: number | null;
  /** False once the timeline has moved on from the revision this was rendered from. */
  current: boolean;
};

// --- EditMode Phase 6: AI chat editor ---------------------------------------

export type ChatMessageRole = 'USER' | 'ASSISTANT' | 'SYSTEM_STATUS';

export type ChatProposalState = 'PLANNING' | 'READY' | 'APPLYING' | 'APPLIED' | 'CANCELLED' |
  'STALE' | 'FAILED' | 'NEEDS_CLARIFICATION';

export type ChatMessage = {
  id: string;
  role: ChatMessageRole;
  text: string;
  createdAt: string;
  proposalId?: string;
  state?: ChatProposalState;
  plannedChanges?: string[];
};

export type ChatGroundingType = 'TRANSCRIPT' | 'SELECTION' | 'ASSET' | 'ANALYSIS' | 'PLAYHEAD' |
  'TIMESTAMP' | 'CONTEXT';

export type ChatGrounding = {
  type: ChatGroundingType;
  confidence: number;
  evidence: string;
  startSec?: number;
  endSec?: number;
};

/**
 * A planned edit awaiting Apply.
 *
 * The raw commands are deliberately absent: they stay on the server, so the
 * browser cannot alter what gets executed. Apply sends only `proposalId`.
 */
export type ChatProposal = {
  proposalId: string;
  baseRevision: number;
  state: ChatProposalState;
  userMessage: string;
  summary: string;
  plannedChanges: string[];
  warnings: string[];
  needsClarification: boolean;
  clarificationQuestion: string;
  affectedElements: string[];
  plannedDurationSec: number;
  grounding: ChatGrounding[];
  planner: 'LLM' | 'DETERMINISTIC';
  expiresAt: number;
  /** Set when the turn asks to travel history rather than to edit. */
  historyAction?: 'UNDO' | 'REDO';
};

/** A range dragged on the timeline ruler, in timeline seconds. */
export type EditTimeRange = { startSec: number; endSec: number };

export type ChatPlanResult = { proposal: ChatProposal; messages: ChatMessage[] };

export type ChatApplyResult = {
  proposal: ChatProposal;
  project: EditProject;
  affectedElementIds: string[];
  messages: ChatMessage[];
};

export type ChatThreadResult = {
  messages: ChatMessage[];
  revision: number;
  lastAppliedSummary: string;
};
