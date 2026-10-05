export type EditProjectStatus = 'DRAFT' | 'READY' | 'EXPORTING' | 'COMPLETED' | 'FAILED';
export type EditAssetRole = 'SOURCE' | 'REFERENCE' | 'OVERLAY' | 'AUDIO' | 'IMAGE' | 'LOGO' | 'EXPORT';
export type EditAssetStorageOwnership = 'OWNED' | 'SHARED';
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
  storageOwnership?: EditAssetStorageOwnership;
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

/** Normalized source-region insets: the fraction of the frame removed from each
 * edge. Four zeroes is uncropped. Mirrors the backend's CropInsets exactly. */
export type CropInsets = { left: number; right: number; top: number; bottom: number };

export const NEUTRAL_CROP: CropInsets = { left: 0, right: 0, top: 0, bottom: 0 };

/** Manual transform bounds. These mirror edit-mode-transform.ts on the backend;
 * the editor clamps to them so a control can never ask for a rejected value. */
export const TRANSFORM_BOUNDS = {
  minSpeed: 0.25, maxSpeed: 4,
  minScale: 0.1, maxScale: 4,
  minRotation: -180, maxRotation: 180,
  minCropRemainder: 0.05
} as const;

export const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** Visual coordinates are normalized to the preview canvas (0..1), from its top-left corner. */
export type VisualElementProperties = {
  x: number; y: number; width: number; height: number; scale?: number; rotation: number; opacity: number;
  zIndex: number; anchor: 'top-left'; locked: boolean; role?: 'IMAGE' | 'LOGO';
  content?: string; fontSize?: number; fontWeight?: number; fontFamily?: string;
  textRuns?: Array<{ text: string; color: string }>;
  textAlign?: 'left' | 'center' | 'right'; color?: string; backgroundColor?: string;
  /** Manual transform. Absent on elements created before these existed, so every
   * reader defaults rather than assuming presence. */
  crop?: CropInsets; flipH?: boolean; flipV?: boolean;
  /** VIDEO only: playback rate, and the canvas offset from centre. */
  speed?: number; offsetX?: number; offsetY?: number;
  /** VIDEO only: the canonical colour grade, the filter it was started from, and
   * the strength that filter was applied at. Absent on an ungraded element, so
   * every reader resolves the neutral value rather than assuming presence. */
  colorAdjustments?: Partial<Record<string, number>>;
  colorFilterId?: string | null;
  colorFilterStrength?: number;
  /** VIDEO only: the source video's own audio. A gain, so 1 is "as recorded". */
  sourceVolume?: number; sourceMuted?: boolean;
};

/** Audio volume is a GAIN: 0 is silent, 1 is the asset's original level and 2 is
 * twice that. `duckStrength` is the named choice; `duckLevel` is the gain it
 * resolved to, which is what actually renders. */
export type AudioElementProperties = {
  volume: number; muted: boolean; fadeInSec: number; fadeOutSec: number;
  duckUnderSpeech?: boolean; duckLevel?: number; duckStrength?: string;
  attackMs?: number; releaseMs?: number;
};

export type EditProject = {
  id: string;
  name: string;
  sourceProjectId?: string | null;
  generatedClipId?: string | null;
  originalVideoId?: string | null;
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
export type ReframePolicy = 'SOURCE' | 'AUTO' | 'FACE_FOCUSED' | 'INFORMATION_PRESERVING' |
  'CENTERED';
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
  /** Workstream G: concrete before -> after lines ("Music volume 20% -> 14%"). */
  changes?: ChatChange[];
  /** Why a turn could not become an edit, when it could not. */
  code?: ChatOutcomeCode;
  /** How the turn was produced. CREATIVE_* means the wording was written for you. */
  route?: ChatRoute;
  /** Set when the proposal applies a template through the Templates path. */
  templateAction?: { templateId: string; templateName: string };
};

export type ChatChange = { label: string; before: string; after: string };

export type ChatOutcomeCode = 'UNSUPPORTED_EDIT_CAPABILITY' | 'NEEDS_TARGET' |
  'CREATIVE_UNAVAILABLE' | 'NOT_UNDERSTOOD';

export type ChatRoute = 'DETERMINISTIC' | 'LLM' | 'CREATIVE_DETERMINISTIC' | 'CREATIVE_LLM' |
  'TEMPLATE' | 'HISTORY' | 'NONE';

/** A range dragged on the timeline ruler, in timeline seconds. */
export type EditTimeRange = { startSec: number; endSec: number };

export type ChatPlanResult = { proposal: ChatProposal; messages: ChatMessage[] };

export type ChatApplyResult = {
  proposal: ChatProposal;
  project: EditProject;
  affectedElementIds: string[];
  messages: ChatMessage[];
};

// --- Step 7/8: the AI editor agent ------------------------------------------

export type AgentAutonomy = 'MANUAL' | 'AI_ASSISTED' | 'AI_AUTONOMOUS' | 'HYBRID';
export type AgentLedgerStatus = 'DONE' | 'NEEDS_CONFIRMATION' | 'UNSUPPORTED' | 'FAILED' |
  'SKIPPED' | 'BLOCKED_BY_CONSTRAINT' | 'NEEDS_INPUT';
export type AgentLedgerEntry = {
  index: number; clause: string; intent: string; planSource: string;
  plannedChanges: string[]; status: AgentLedgerStatus;
  verification: 'VERIFIED' | 'FAILED' | 'NOT_APPLICABLE' | 'PENDING';
  detail: string; destructive: boolean; evidence: string[]; affectedElementIds: string[];
};
export type AgentAiState = { state: string; retryable: boolean; message: string };
export type AgentRun = {
  runId: string; message: string; autonomy: AgentAutonomy;
  startedRevision: number; finalRevision: number; revisions: number[];
  ledger: AgentLedgerEntry[];
  review: { summary: string; items: Array<{ dimension: string; severity: string; title: string;
    evidence: string[]; suggestion: string | null }> } | null;
  ai: AgentAiState; summary: string; createdAt: string;
};
export type AgentState = { revision: number; autonomy: AgentAutonomy; runs: AgentRun[];
  ai: AgentAiState };
export type EditConstraintInput = { type: string; lifetime?: 'TASK' | 'PROJECT';
  target?: Record<string, unknown> };

export type ChatThreadResult = {
  messages: ChatMessage[];
  revision: number;
  lastAppliedSummary: string;
};

// --- Workstreams H/I: review and supervised edit from brief ----------------

export type ReviewSeverity = 'NEEDS_ATTENTION' | 'COULD_IMPROVE' | 'LOOKS_GOOD';
export type ReviewDimension = 'HOOK' | 'PACING' | 'CAPTIONS' | 'FRAMING' | 'ZOOM' | 'COLOR' |
  'AUDIO' | 'OVERLAYS' | 'STRUCTURE';
export type ReviewFinding = { id: string; dimension: ReviewDimension; severity: ReviewSeverity;
  title: string; evidence: string[]; suggestion: string | null; applyInstruction: string | null;
  previewRange: EditTimeRange | null; evidenceLimit: string | null };
export type EditReview = { reviewId: string; revision: number;
  scope: 'PROJECT' | 'SELECTION' | 'RANGE' | 'HOOK' | 'CAPTIONS' | 'AUDIO' | 'PACING';
  summary: string; findings: ReviewFinding[]; sampledMomentsSec: number[]; createdAt: string };

export type BriefPlanStatus = 'PENDING' | 'PLANNING' | 'AWAITING_CONFIRMATION' | 'APPLIED' |
  'REVISING' | 'SKIPPED' | 'FAILED' | 'COMPLETED' | 'STOPPED';
export type BriefStep = { id: string; label: string; originalInstruction: string;
  interpretedGoal: string; resolvedTargets: string[]; proposedCommands: string[];
  status: BriefPlanStatus; warnings: string[]; affectedHandles: string[];
  projectRevision: number; resultSummary: string; kind: 'EDIT' | 'REVIEW' | 'UNSUPPORTED' };
export type BriefPlan = { planId: string; originalBrief: string; status: BriefPlanStatus;
  steps: BriefStep[]; currentStepIndex: number; protectedConstraints: string[];
  unaccountedInstructions: string[]; revision: number; activeProposal: ChatProposal | null;
  finalReview: EditReview | null; createdAt: string; updatedAt: string };
export type BriefRespondResult = { plan: BriefPlan; project?: EditProject };
