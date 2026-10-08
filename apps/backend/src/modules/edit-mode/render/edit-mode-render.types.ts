// EditMode Phase 5 render plan.
//
// The plan is the single typed description of one export: everything FFmpeg is
// asked to do is derived from it, and it is fully validated before a frame is
// encoded. It is built deterministically from the canonical EditProject state
// (settings + EditAsset[] + EditElement[]) plus the analysis/transcript already
// cached on the source asset. No LLM, no queue, no re-analysis.

import type { AnalysisFrame } from '../../editing/edit-analysis';
import type { InformationRegion } from '../../editing/information-region';
import type { Shot } from '../../editing/shot-classifier';
import type { ColorAdjustments } from '../edit-mode-color';
import type { SpeechWindow } from '../edit-mode-audio';
import type { CropInsets } from '../edit-mode-transform';
import type { ActiveWordStyle, CaptionWord, TextBackground, TextRun, TextShadow,
  TextStroke } from '../edit-mode-text';
import type { EditAspectRatio, EditPresetId, GradingPolicy, ReframePolicy,
  SubtitlePolicy, ZoomPolicy } from '../presets/edit-preset-policy';
import type { ResolvedVisualLayout } from '../styles/resolved-visual-layout';

/** Typed failure codes surfaced to the UI. */
export const EDIT_EXPORT_ERROR_CODES = ['SOURCE_MISSING', 'ASSET_MISSING', 'INVALID_TIMELINE',
  'UNSUPPORTED_MEDIA', 'RENDER_FAILED', 'QA_FAILED', 'UPLOAD_FAILED', 'STALE_EXPORT',
  'EXPORT_ALREADY_RUNNING',
  // Phase 7: the backend process died while this export was running, and
  // startup recovery settled it rather than leaving the project EXPORTING.
  'INTERRUPTED'] as const;
export type EditExportErrorCode = typeof EDIT_EXPORT_ERROR_CODES[number];

/** Coarse progress, persisted so a reloaded workspace can resume watching. */
export const EDIT_EXPORT_PHASES = ['PREPARING', 'RENDERING', 'QA', 'UPLOADING', 'COMPLETED',
  'FAILED'] as const;
export type EditExportPhase = typeof EDIT_EXPORT_PHASES[number];

export type EditExportProgress = {
  exportId: string;
  phase: EditExportPhase;
  /** 0-100, monotonic within one export. */
  percent: number;
  sourceRevision: number;
  startedAt: string;
  updatedAt: string;
  attempt: number;
  assetId: string | null;
  errorCode: EditExportErrorCode | null;
  message: string | null;
  /** Set only by startup recovery, so the UI can say why this export ended. */
  recoveredAt?: string;
};

export type RenderCanvas = {
  width: number; height: number; fps: number;
  aspectRatio: EditAspectRatio;
  /** Source shape the plan was built against. */
  sourceWidth: number; sourceHeight: number;
  /** Step 10: what shows behind a FIT (letterboxed) frame. Default BLUR. */
  fitBackground?: 'BLUR' | 'BLACK' | 'WHITE';
  /** Exact geometry resolved before the canonical style mutation. */
  visualLayout?: ResolvedVisualLayout | null;
  /** SOURCE already contains the user's confirmed Quick Reframe crop. */
  bakedSourceCrop?: true;
};

/** One kept source range and where it lands on the exported timeline. Splits,
 * trims, deletions and reorders all reduce to an ordered list of these, and the
 * manual transform of the element that produced it travels with it: crop and
 * rotation are per-segment, because a split can give two halves different ones. */
export type RenderVideoSegment = {
  elementId: string;
  sourceStart: number; sourceEnd: number;
  timelineStart: number; timelineEnd: number;
  /** Playback rate. (timelineEnd - timelineStart) is the source range over this. */
  speed: number;
  /** Normalized source-region insets; four zeroes when uncropped. */
  crop: CropInsets;
  /** Degrees, positive clockwise. */
  rotation: number;
  flipH: boolean; flipV: boolean;
  /** Canvas transform applied after crop/flip/rotate, before fitting. */
  scale: number;
  offsetX: number; offsetY: number;
  /** Manual colour, applied BEFORE the geometry above (see
   * edit-mode-color-filter.ts for why). Neutral on an ungraded segment. */
  color: ColorAdjustments;
  /** The source video's own audio for this segment. A gain, so 1 is "as
   * recorded" and 2 is twice that. */
  sourceVolume: number;
  sourceMuted: boolean;
  /** Step 5 per-segment framing override; null = the reframe policy decides. */
  frameLayout?: 'FIT' | 'FILL' | null;
};

export type RenderVisualOverlay = {
  elementId: string;
  assetId: string;
  role: 'IMAGE' | 'LOGO';
  /** Canvas pixels, top-left anchored - the frontend's normalized box resolved. */
  x: number; y: number; width: number; height: number;
  startSec: number; endSec: number;
  opacity: number; zIndex: number;
  preserveAspectRatio: boolean;
  /** Manual transform, applied to the overlay image before it is composited.
   * The preview draws the same three, so what is placed is what is exported. */
  crop: CropInsets;
  rotation: number;
  flipH: boolean; flipV: boolean;
};

export type RenderTextOverlay = {
  elementId: string;
  kind: 'TEXT' | 'SUBTITLE';
  /** Exact stored wording, uppercased only when the style asks for it. Never
   * regenerated, never rewritten. */
  content: string;
  lines: string[];
  startSec: number; endSec: number;
  /** Canvas pixels. */
  x: number; y: number; width: number; height: number;
  fontSizePx: number; fontWeight: number; fontFamily: string;
  textAlign: 'left' | 'center' | 'right';
  color: string; backgroundColor: string;
  opacity: number; zIndex: number;
  presetRole: string | null;
  // --- Workstream C: professional text styling ------------------------------
  // Every size below is already resolved to CANVAS PIXELS, so the ASS builder
  // never has to know about the 600-wide design-unit convention.
  stroke: TextStroke;
  shadow: TextShadow;
  background: TextBackground;
  /** Letter spacing in canvas pixels; line spacing as a line-height multiplier. */
  letterSpacing: number;
  lineSpacing: number;
  /** Degrees, positive clockwise, matching the preview's CSS rotation. */
  rotation: number;
  uppercase: boolean;
  activeWord: ActiveWordStyle;
  /** Persisted static semantic emphasis, used by editorial hooks. */
  textRuns: TextRun[];
  /** Word timings in TIMELINE seconds. Empty when the caption has none, which is
   * what makes the active-word highlight impossible to fake. */
  words: CaptionWord[];
};

export type RenderAudioTrack = {
  elementId: string;
  /** null for the source's own audio. */
  assetId: string | null;
  kind: 'SOURCE' | 'MUSIC';
  startSec: number; endSec: number;
  trimStart: number; trimEnd: number;
  /** A gain: 1 is the uploaded file's own level, 2 is twice that. */
  volume: number; muted: boolean;
  fadeInSec: number; fadeOutSec: number;
  /** Speech ducking. `duckUnderSpeech` is opt-in PER TRACK, so a second music
   * bed or a sound effect the user did not configure is never touched. */
  duckUnderSpeech: boolean; duckLevel: number; attackMs: number; releaseMs: number;
};

/** How one shot of the exported timeline is fitted to the canvas. */
export type RenderFrameSegment = {
  shotIndex: number;
  startSec: number; endSec: number;
  layout: 'FILL' | 'FIT' | 'INFORMATION_FIT';
  shotClass: string;
  frameMode: string;
  faceCount: number;
  reason: string;
};

export type RenderZoomEvent = {
  id: string;
  startSec: number; peakStartSec: number; peakEndSec: number; endSec: number;
  peakScale: number;
  focusX: number; focusY: number;
  intensity: Exclude<ZoomPolicy, 'OFF'>;
  triggerText: string;
  reason: string;
  /** Active face selected by the camera at the semantic phrase midpoint. */
  focusTrackId?: string | null;
  /** Frame numbers on the exported timeline, for the zoompan envelope. */
  startFrame: number; peakStartFrame: number; peakEndFrame: number; endFrame: number;
  /** Set when the requested scale had to be reduced to stay subject/information safe. */
  reducedFromScale: number | null;
};

export type RenderZoomRejection = { triggerText: string; startSec: number; reason: string };

export type RenderGrading = {
  policy: GradingPolicy;
  /** The frozen grade preset this policy borrows, and how hard it is applied. */
  preset: string;
  strengthScale: number;
  filter: string;
};

export type RenderOutput = {
  container: 'mp4';
  videoCodec: 'h264';
  audioCodec: 'aac';
  crf: number;
  preset: string;
  audioBitrate: string;
};

export type RenderPlan = {
  editProjectId: string;
  sourceRevision: number;
  sourceAssetId: string;
  presetId: EditPresetId;
  canvas: RenderCanvas;
  durationSec: number;
  videoSegments: RenderVideoSegment[];
  visualOverlays: RenderVisualOverlay[];
  textOverlays: RenderTextOverlay[];
  subtitles: RenderTextOverlay[];
  audioTracks: RenderAudioTrack[];
  frameSegments: RenderFrameSegment[];
  zoomEvents: RenderZoomEvent[];
  zoomRejections: RenderZoomRejection[];
  grading: RenderGrading;
  output: RenderOutput;
  policies: {
    aspectRatio: EditAspectRatio; reframePolicy: ReframePolicy; zoomPolicy: ZoomPolicy;
    gradingPolicy: GradingPolicy; subtitlePolicy: SubtitlePolicy;
  };
  /** True when the source has a decodable audio stream. */
  hasSourceAudio: boolean;
  /** Speech passages on the EXPORTED timeline, derived from the cached
   * transcript's word timings. Empty when the source has none. */
  speechWindows: SpeechWindow[];
  /** False when the cached transcript has no word timings, in which case
   * ducking is refused rather than approximated. */
  duckingAvailable: boolean;
  /** Set when subtitles were generated at render time from the cached transcript
   * because Phase 4 stored only the policy (element count exceeded the cap). */
  subtitlesFromTranscript: boolean;
  warnings: string[];
};

/** Evidence the planner and the QA pass share, so neither re-derives it. */
export type RenderEvidence = {
  shots: Shot[];
  informationRegion: InformationRegion | null;
  /** Analysis frames remapped onto the exported timeline. */
  frames: AnalysisFrame[];
  cropAt: (t: number) => { x: number; y: number; w: number; h: number };
  /** Source-pixel crop for INFORMATION_FIT spans, when one was detected. */
  informationCrop: { x: number; y: number; width: number; height: number } | null;
  fitExpression: string;
  informationFitExpression: string;
  cameraFilter: string;
  renderHeight: number;
  speakerSegments: Array<{ startSec: number; endSec: number;
    targetFace: { x: number; y: number; w: number; h: number };
    confidence: number; trackId: string | null }>;
  speakerSwitchCount: number;
  faceSafetyViolations: number;
  cameraMoves: Array<{ t: number; durationSec: number; distance: number; snapped: boolean }>;
  /** Automatic 2 speaker punch-ins folded into `cropAt` and the camera filter. */
  punches: Array<{ startSec: number; endSec: number; scale: number; framing: 'CLOSE' | 'MEDIUM' }>;
};

export const QA_RESULTS = ['PASS', 'DEGRADED_ACCEPTABLE', 'REPAIR_REQUIRED', 'REJECT'] as const;
export type QaResult = typeof QA_RESULTS[number];

export type QaRepair =
  | { kind: 'REDUCE_ZOOM'; zoomEventId: string; scale: number }
  | { kind: 'SUPPRESS_ZOOM'; zoomEventId: string }
  | { kind: 'WIDEN_CROP'; shotIndex: number }
  | { kind: 'INFORMATION_FIT'; shotIndex: number };

export type QaCheck = {
  id: string;
  result: QaResult;
  detail: string;
  /** Present when this check can be repaired locally and re-rendered. */
  repair: QaRepair | null;
};

export type QaReport = {
  result: QaResult;
  checks: QaCheck[];
  repairs: QaRepair[];
  sampledFrameCount: number;
  measured: {
    width: number | null; height: number | null; durationSec: number | null;
    hasVideo: boolean; hasAudio: boolean; videoCodec: string | null; audioCodec: string | null;
    bitrate: number | null;
    audioPeakDb: number | null;
    finalFrameDecoded: boolean;
    negativeTimestamps: boolean;
    blackFrameRatio: number | null;
    subjectSafetyRatio: number | null;
    informationPreservedRatio: number | null;
    overlayInBounds: boolean;
    subtitleInBounds: boolean;
  };
};

export type EditExportResult = {
  exportId: string;
  assetId: string;
  editProjectId: string;
  sourceRevision: number;
  stale: boolean;
  qa: QaReport;
  attempts: number;
  renderMs: number;
  metadata: Record<string, unknown>;
};

/** One repair the orchestrator applied between render attempts. */
export type RenderRepairLog = { attempt: number; repair: QaRepair; reason: string };
