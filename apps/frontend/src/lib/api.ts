export type ProcessingStageName = 'UPLOADED' | 'INSPECT_MEDIA' | 'EXTRACT_AUDIO' |
  'TRANSCRIBE' | 'BUILD_CHUNKS' | 'MULTIMODAL_UNDERSTANDING' |
  'WHOLE_VIDEO_UNDERSTANDING' | 'ANALYZE_CHUNKS' | 'EVIDENCE_FUSION' |
  'CLIP_UNDERSTANDING' | 'GENERATE_CLIP_CANDIDATES' | 'CONTENT_GENERATION' |
  'CRITIC_VALIDATION' |
  'VISUAL_ANALYSIS' | 'COMPLETED' | 'FAILED';

export type AiProcessingMode = 'ONLINE' | 'OFFLINE' | 'FALLBACK_ONLY';
export type ProcessingType = 'NORMAL_CLIPS' | 'EDITED_CLIPS';
export type OutputAspectRatio = '9:16' | '16:9' | '4:5' | '1:1';
export type TargetPlatform = 'INSTAGRAM_REELS' | 'YOUTUBE_SHORTS' | 'TIKTOK';
export type OutputStyle = 'NORMAL' | 'AI_EDITED';

export const TARGET_PLATFORM_LABELS: Record<TargetPlatform, string> = {
  INSTAGRAM_REELS: 'Instagram Reels',
  YOUTUBE_SHORTS: 'YouTube Shorts',
  TIKTOK: 'TikTok'
};

export const AI_PROCESSING_MODE_LABELS: Record<AiProcessingMode, string> = {
  ONLINE: 'Online AI',
  OFFLINE: 'Offline AI',
  FALLBACK_ONLY: 'Fallback Only'
};

export type VideoProcessingStage = {
  stage: ProcessingStageName;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
  progress: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
};

export type MediaErrorCode = 'NO_AUDIO_STREAM' | 'NO_VIDEO_STREAM' | 'INVALID_MEDIA_FILE' |
  'AUDIO_EXTRACTION_FAILED' | 'AUDIO_RECOVERY_FAILED' | 'STORAGE_OR_DOWNLOAD_CORRUPTION' |
  'VIDEO_TOO_LONG';

export const MEDIA_ERROR_UI_MESSAGES: Record<MediaErrorCode, { title: string; description: string }> = {
  NO_AUDIO_STREAM: {
    title: 'Audio track not found.',
    description: 'This video does not contain an audio stream. Upload a version with audio.'
  },
  NO_VIDEO_STREAM: {
    title: 'No video stream found.',
    description: 'This file does not contain a readable video stream. Please upload a valid video file.'
  },
  INVALID_MEDIA_FILE: {
    title: 'Unsupported or corrupted file.',
    description: 'This file could not be read as a valid media file. Please upload another source file.'
  },
  AUDIO_EXTRACTION_FAILED: {
    title: 'Audio extraction failed.',
    description: 'We could not extract audio from this video. You can retry — if it keeps failing, ' +
      'try re-uploading the source file.'
  },
  AUDIO_RECOVERY_FAILED: {
    title: 'Audio track is damaged.',
    description: 'We found an audio track, but parts of it are damaged or unsupported. Please ' +
      're-export the video or upload another copy.'
  },
  STORAGE_OR_DOWNLOAD_CORRUPTION: {
    title: 'Upload could not be verified.',
    description: 'The uploaded file could not be read back correctly from storage. You can retry — ' +
      'if it keeps failing, re-upload the source file.'
  },
  VIDEO_TOO_LONG: {
    title: 'This video is longer than the 2-hour limit.',
    description: 'Please upload a video shorter than 2 hours.'
  }
};

export class ApiError extends Error {
  status: number;
  code?: string;
  retryable?: boolean;

  constructor(message: string, status: number, code?: string, retryable?: boolean) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function retryVideo(videoId: string) {
  return apiFetch<ProcessingJob>('/videos/' + encodeURIComponent(videoId) + '/retry', { method: 'POST' });
}

export function deleteVideo(videoId: string) {
  return apiFetch<{ id: string; deleted: true }>('/videos/' + encodeURIComponent(videoId), {
    method: 'DELETE'
  });
}

export type Video = {
  id: string;
  projectId: string;
  originalName: string;
  objectKey: string;
  bucket: string;
  mimeType: string;
  sizeBytes: number;
  duration?: number | null;
  fps?: number | null;
  width?: number | null;
  height?: number | null;
  codec?: string | null;
  bitrate?: number | null;
  hasVideo?: boolean | null;
  hasAudio?: boolean | null;
  audioCodec?: string | null;
  videoStreamIndex?: number | null;
  audioStreamIndex?: number | null;
  formatName?: string | null;
  targetPlatform?: TargetPlatform | null;
  audioObjectKey?: string | null;
  audioBucket?: string | null;
  hasTranscript?: boolean;
  hasChunks?: boolean;
  processingJobs?: ProcessingJob[];
  processingStages?: VideoProcessingStage[];
  createdAt: string;
  updatedAt: string;
  project?: {
    id: string;
    name: string;
  };
};

export type ProcessingJob = {
  progress: number;
  id: string;
  videoId: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  aiMode: AiProcessingMode;
  processingType: ProcessingType;
  outputAspectRatio: OutputAspectRatio | null;
  outputStyle?: OutputStyle | null;
  requestedClipCount?: number | null;
  clipRenderStatus?: ClipRenderStatus | null;
  error?: string | null;
  errorCode?: MediaErrorCode | string | null;
  retryable?: boolean;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TranscriptSegment = {
  id: string;
  position: number;
  start: number;
  end: number;
  text: string;
  words: Array<{ start: number; end: number; text: string; confidence?: number | null }>;
  confidence?: number | null;
  speaker?: string | null;
  createdAt: string;
};

export type Transcript = {
  id: string;
  videoId: string;
  text: string;
  language?: string | null;
  languageProbability?: number | null;
  duration?: number | null;
  segments: TranscriptSegment[];
  createdAt: string;
  updatedAt: string;
};

export type Project = {
  id: string;
  name: string;
  description?: string | null;
  videos: Video[];
  createdAt: string;
  updatedAt: string;
};

export function getApiBaseUrl() {
  if (typeof window !== "undefined") {
    return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  }

  return (
    process.env.SERVER_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:4000"
  );
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    cache: "no-store"
  });

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const message = typeof record.message === 'string'
      ? record.message
      : `API request failed: ${response.status}`;
    const code = typeof record.code === 'string' ? record.code : undefined;
    const retryable = typeof record.retryable === 'boolean' ? record.retryable : undefined;
    throw new ApiError(message, response.status, code, retryable);
  }

  return response.json() as Promise<T>;
}

export function listProjects() {
  return apiFetch<Project[]>("/projects");
}

export function createProject(input: { name: string; description?: string }) {
  return apiFetch<Project>('/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });
}

export function listVideos(projectId?: string) {
  const query = projectId ? '?projectId=' + encodeURIComponent(projectId) : '';
  return apiFetch<Video[]>('/videos' + query);
}

export function uploadVideo(projectId: string, body: FormData) {
  return apiFetch<Video>('/projects/' + encodeURIComponent(projectId) + '/videos', {
    method: 'POST',
    body
  });
}

export function getTranscript(videoId: string) {
  return apiFetch<Transcript>('/videos/' + encodeURIComponent(videoId) + '/transcript');
}

export type VideoUnderstandingChapter = {
  id: string;
  position: number;
  startTime: number;
  endTime: number;
  title: string;
  summary: string;
  topics: string[];
  importanceScore: number;
};

export type VideoImportantMoment = {
  startTime: number;
  endTime: number;
  title: string;
  description: string;
  importanceScore: number;
};

export type VideoUnderstanding = {
  id: string;
  videoId: string;
  summary: string;
  mainTopic: string;
  contentType: string;
  targetAudience: string;
  language: string;
  chapters: VideoUnderstandingChapter[];
  topics: string[];
  keyClaims: string[];
  questions: string[];
  stories: string[];
  importantMoments: VideoImportantMoment[];
  provider: string;
  model: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
};

export function getVideoUnderstanding(videoId: string) {
  return apiFetch<VideoUnderstanding>('/videos/' + encodeURIComponent(videoId) + '/understanding');
}

export type TranscriptChunk = {
  id: string;
  videoId: string;
  position: number;
  startTime: number;
  endTime: number;
  text: string;
  duration: number;
  wordCount: number;
};

export function getChunks(videoId: string) {
  return apiFetch<TranscriptChunk[]>('/videos/' + encodeURIComponent(videoId) + '/chunks');
}

export type ChunkAnalysis = {
  id: string;
  chunkId: string;
  questionCount: number;
  exclamationCount: number;
  keywordDensity: number;
  averageSentenceLength: number;
  speechRate: number;
  informationDensity: number;
  readabilityScore: number;
  createdAt: string;
  updatedAt: string;
};

export function getChunkAnalysis(videoId: string) {
  return apiFetch<ChunkAnalysis[]>('/videos/' + encodeURIComponent(videoId) + '/chunk-analysis');
}

export type ClipCandidate = {
  id: string;
  videoId: string;
  startTime: number;
  endTime: number;
  duration: number;
  transcriptText: string;
  heuristicScore: number;
  hookScore: number;
  sourceHookScore: number;
  standaloneScore: number;
  payoffScore: number;
  flowScore: number;
  informationScore: number;
  retentionScore: number;
  shareabilityScore: number;
  contentPotential: number;
  generationQuality: number;
  confidence: number;
  overallScore: number;
  reject: boolean;
  topic: string;
  reason: string;
  rejectionReason: string;
  judgeSource: 'GPT_5_4_MINI' | 'LLM' | 'HEURISTIC_FALLBACK' | 'LEGACY';
  rank: number | null;
  recommendationTier: 'PRIMARY' | 'SECONDARY';
  hooks: Array<{
    text: string;
    style: string;
    score: number;
  }>;
  bestHook: string;
  alternateHooks: string[];
  generatedHookScore: number;
  selectedHookStrategy: string;
  title: string;
  synopsis: string;
  caption: string;
  hashtags: string[];
  cta: string;
  contentType: string;
  whySelected: string;
  provider: string;
  model: string;
  promptVersion: string;
  generationStatus: 'GENERATED' | 'FALLBACK' | 'PENDING' | 'LEGACY';
  fallbackReason: string;
  generationMode: 'CLOUD_AI' | 'PARTIAL_CLOUD_AI' | 'LOCAL_AI' |
    'DETERMINISTIC_FALLBACK';
  fallbackUsed: boolean;
  failureCategory: string;
  providerMetadata: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
};

export function getClipCandidates(videoId: string, limit = 100) {
  return apiFetch<ClipCandidate[]>('/videos/' + encodeURIComponent(videoId) +
    '/clip-candidates?limit=' + encodeURIComponent(limit));
}

export type ClipRecommendations = {
  videoDuration: number;
  candidatesDiscovered: number;
  recommendedClipCount: number;
  maximumClipCount: number;
  primaryCount: number;
  secondaryCount: number;
  candidates: ClipCandidate[];
};

export function getClipRecommendations(videoId: string) {
  return apiFetch<ClipRecommendations>('/videos/' + encodeURIComponent(videoId) +
    '/clip-recommendations');
}

export type GeneratedClip = {
  id: string;
  videoId: string;
  candidateId?: string | null;
  rangeKey: string;
  startTime: number;
  endTime: number;
  duration: number;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  codec: string;
  processingType?: ProcessingType;
  aspectRatio?: OutputAspectRatio | 'SOURCE';
  editTelemetry?: { editQualityStatus?: 'PASSED' | 'DEGRADED'; editQualityDegradedChecks?: string[] } | null;
  playbackUrl: string;
  createdAt: string;
  updatedAt: string;
  candidate?: ClipCandidate | null;
};

export type ClipRenderStatus = 'IDLE' | 'QUEUED' | 'RENDERING' | 'COMPLETED' | 'FAILED';
export type AiModeUsed = 'Online' | 'Local' | 'Fallback';

export type ClipAnalysis = {
  videoId: string;
  durationSec: number | null;
  targetPlatform: TargetPlatform | null;
  analysisStatus: 'ANALYZING' | 'READY' | 'FAILED' | 'REJECTED';
  rejectionMessage: string | null;
  maxClipCount: number;
  defaultClipCount: number;
  candidateAvailability: 'PENDING' | 'AVAILABLE' | 'EXPANSION_REQUIRED';
  clipRequest: {
    status: ClipRenderStatus;
    outputStyle: OutputStyle | null;
    requestedClipCount: number | null;
    returnedClipCount: number;
    error: string | null;
  } | null;
};

export type ClipCard = {
  id: string;
  position: number;
  playbackUrl: string;
  /** Designed cover carrying the clip's own hook; null when none was rendered. */
  posterUrl: string | null;
  outputStyle: OutputStyle;
  durationSec: number;
  width: number;
  height: number;
  hook: string;
  synopsis: string;
  caption: string;
  hashtags: string[];
  aiModeUsed: AiModeUsed;
};

export type ClipResults = {
  status: ClipRenderStatus | null;
  outputStyle: OutputStyle | null;
  requestedClipCount: number | null;
  error: string | null;
  clips: ClipCard[];
};

export function getClipAnalysis(videoId: string) {
  return apiFetch<ClipAnalysis>('/videos/' + encodeURIComponent(videoId) + '/clip-analysis');
}

export function getClipResults(videoId: string) {
  return apiFetch<ClipResults>('/videos/' + encodeURIComponent(videoId) + '/clip-results');
}

export function createClips(videoId: string, request: {
  requestedClipCount: number; outputStyle: OutputStyle;
}) {
  return apiFetch<ClipAnalysis>('/videos/' + encodeURIComponent(videoId) + '/clip-selection', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request)
  });
}

export function getGeneratedClips(videoId: string) {
  return apiFetch<GeneratedClip[]>('/videos/' + encodeURIComponent(videoId) + '/generated-clips');
}

export type VisualAnalysis = {
  id: string;
  chunkId: string;
  shotBoundaries: number[];
  sceneChangeCount: number;
  averageMotion: number;
  faceCount: number;
  largestFaceRatio: number;
  brightness: number;
  contrast: number;
  colorfulness: number;
  ocrText: string;
  subtitleDetected: boolean;
  createdAt: string;
  updatedAt: string;
};

export function getVisualAnalysis(videoId: string) {
  return apiFetch<VisualAnalysis[]>('/videos/' + encodeURIComponent(videoId) + '/visual-analysis');
}

export function getProject(id: string) {
  return apiFetch<Project>(`/projects/${id}`);
}
