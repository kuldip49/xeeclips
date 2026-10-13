import { isAutomaticLook, type AutomaticLook } from '@/lib/automatic-looks';
import type {
  AiProcessingMode, ClipCreationBody, OutputAspectRatio, ProcessingStageName, TargetPlatform,
  VideoImportJob, VideoProcessingStage
} from '@/lib/api';
import { requestOutputStyle } from '@/lib/clip-creation-state';
import { generationPayload } from '@/lib/creative-generation';

/**
 * One-step entry: everything the user picks before the source exists. It is sent with the
 * upload/import as the ordinary clip-selection request and started once analysis completes.
 */
export type EntryTemplate = AutomaticLook;
export type EntrySource = 'file' | 'youtube';
export type EntrySettings = {
  template: EntryTemplate;
  count: number;
  brief: string;
  platform: TargetPlatform;
  aspectRatio: OutputAspectRatio;
  aiMode: AiProcessingMode;
};

/** The largest count any accepted source allows (a two-hour source). */
export const ENTRY_MAX_CLIPS = 30;

/** Mirrors the backend rule: up to 8 under 15 min, 20 up to an hour, 30 up to two hours. */
export function maxClipsForDuration(seconds: number | null | undefined) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return ENTRY_MAX_CLIPS;
  return seconds < 900 ? 8 : seconds <= 3600 ? 20 : 30;
}
export const CLIP_LIMIT_HINT = 'Up to 8 clips for videos under 15 min, 20 up to 1 hour, 30 up to 2 hours.';

export const DEFAULT_ENTRY_SETTINGS: EntrySettings = {
  template: 'AUTOMATIC_1', count: 3, brief: '', platform: 'YOUTUBE_SHORTS', aspectRatio: '9:16',
  aiMode: 'ONLINE'
};

export const ENTRY_TEMPLATE_LABELS: Record<EntryTemplate, string> = {
  AUTOMATIC_1: 'StyleZero', AUTOMATIC_2: 'StyleOne', AUTOMATIC_3_STYLE_TWO: 'StyleTwo', AUTOMATIC_RAW: 'No Edit'
};

/** Built with the same helpers as the "Create clips" button, so both send identical requests. */
export function entryGenerationRequest(settings: EntrySettings): ClipCreationBody {
  return {
    requestedClipCount: settings.count,
    outputStyle: requestOutputStyle(settings.template, true) ?? 'AI_EDITED',
    generation: generationPayload({ templateId: settings.template, components: {},
      brief: settings.brief, referenceId: null, look: settings.template })
  };
}

/** Settings to restore when a failed YouTube import falls back to a file upload. */
export function settingsFromImport(job: VideoImportJob): EntrySettings {
  const request = job.autoGeneration;
  const template = request?.generation?.templateId;
  const count = Number(request?.requestedClipCount);
  return {
    template: isAutomaticLook(template) ? template : 'AUTOMATIC_1',
    count: Number.isInteger(count) && count >= 1 && count <= ENTRY_MAX_CLIPS ? count
      : DEFAULT_ENTRY_SETTINGS.count,
    brief: request?.generation?.brief ?? '',
    platform: job.targetPlatform ?? DEFAULT_ENTRY_SETTINGS.platform,
    aspectRatio: job.outputAspectRatio ?? DEFAULT_ENTRY_SETTINGS.aspectRatio,
    // The backend runs a legacy OFFLINE job as FALLBACK_ONLY, so it restores as XeeFree too.
    aiMode: job.aiMode === 'FALLBACK_ONLY' || job.aiMode === 'OFFLINE' ? 'FALLBACK_ONLY' : 'ONLINE'
  };
}

export function importProgressLabel(job: VideoImportJob) {
  if (job.stage === 'PREPARING_SOURCE' || job.stage === 'VALIDATING') return 'Preparing source...';
  if (job.status === 'PENDING' || job.stage === 'FETCHING_INFO') return 'Checking video...';
  return job.stage === 'DOWNLOADING' && job.progress > 1
    ? `Importing YouTube video... ${job.progress}%` : 'Importing YouTube video...';
}

const STAGE_ORDER: ProcessingStageName[] = ['UPLOADED', 'INSPECT_MEDIA', 'EXTRACT_AUDIO',
  'TRANSCRIBE', 'BUILD_CHUNKS', 'MULTIMODAL_UNDERSTANDING', 'WHOLE_VIDEO_UNDERSTANDING',
  'ANALYZE_CHUNKS', 'VISUAL_ANALYSIS', 'EVIDENCE_FUSION', 'CLIP_UNDERSTANDING',
  'GENERATE_CLIP_CANDIDATES', 'CONTENT_GENERATION', 'CRITIC_VALIDATION', 'COMPLETED'];

const STAGE_LABELS: Partial<Record<ProcessingStageName, string>> = {
  UPLOADED: 'Preparing source...', INSPECT_MEDIA: 'Preparing source...',
  EXTRACT_AUDIO: 'Preparing source...', TRANSCRIBE: 'Transcribing...',
  BUILD_CHUNKS: 'Analyzing...', MULTIMODAL_UNDERSTANDING: 'Analyzing...',
  WHOLE_VIDEO_UNDERSTANDING: 'Analyzing...', ANALYZE_CHUNKS: 'Analyzing...',
  VISUAL_ANALYSIS: 'Analyzing...', EVIDENCE_FUSION: 'Finding clips...',
  CLIP_UNDERSTANDING: 'Finding clips...', GENERATE_CLIP_CANDIDATES: 'Finding clips...',
  CONTENT_GENERATION: 'Finding clips...', CRITIC_VALIDATION: 'Finding clips...',
  COMPLETED: 'Finding clips...'
};

/** A plain-language label for the analysis stage that is running (or next) - never stage ids. */
export function analysisProgressLabel(stages: VideoProcessingStage[] | undefined) {
  const byName = new Map((stages ?? []).map((stage) => [stage.stage, stage]));
  const current = STAGE_ORDER.find((name) => byName.get(name)?.status === 'PROCESSING') ??
    STAGE_ORDER.find((name) => byName.get(name)?.status === 'PENDING');
  return (current && STAGE_LABELS[current]) || 'Preparing source...';
}
