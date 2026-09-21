import { Inject, Injectable, Logger } from '@nestjs/common';
import { StrictJsonSchema, StructuredGenerationRequest } from './llm-provider.service';
import { LlmRouteMetadata, LlmRouterService } from './llm-router.service';
import { ChapterNormalizationTelemetry, currentAiProcessingMode, performanceContext,
  recordChapterNormalization, recordWholeVideoFallbackReason } from './performance-telemetry';
import { AiProcessingMode } from './ai-processing-mode';

export type TranscriptPart = {
  position: number;
  startTime: number;
  endTime: number;
  text: string;
};

export type UnderstandingChapter = {
  startTime: number;
  endTime: number;
  title: string;
  summary: string;
  topics: string[];
  importanceScore: number;
};

export type ImportantMoment = {
  startTime: number;
  endTime: number;
  title: string;
  description: string;
  importanceScore: number;
};

export type VideoUnderstandingResult = {
  summary: string;
  mainTopic: string;
  contentType: string;
  targetAudience: string;
  language: string;
  chapters: UnderstandingChapter[];
  topics: string[];
  keyClaims: string[];
  questions: string[];
  stories: string[];
  importantMoments: ImportantMoment[];
};

type ChunkSummary = {
  startTime: number;
  endTime: number;
  summary: string;
  topics: string[];
  keyClaims: string[];
  questions: string[];
  stories: string[];
  importantMoments: ImportantMoment[];
};

const stringArraySchema = { type: 'array', maxItems: 12, items: { type: 'string' } } as const;
const importantMomentSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    startTime: { type: 'number', minimum: 0 },
    endTime: { type: 'number', minimum: 0 },
    title: { type: 'string' },
    description: { type: 'string' },
    importanceScore: { type: 'number', minimum: 0, maximum: 100 }
  },
  required: ['startTime', 'endTime', 'title', 'description', 'importanceScore']
} as const;
const chapterSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    startTime: { type: 'number', minimum: 0 },
    endTime: { type: 'number', minimum: 0 },
    title: { type: 'string' },
    summary: { type: 'string' },
    topics: stringArraySchema,
    importanceScore: { type: 'number', minimum: 0, maximum: 100 }
  },
  required: ['startTime', 'endTime', 'title', 'summary', 'topics', 'importanceScore']
} as const;

export const VIDEO_UNDERSTANDING_SCHEMA: StrictJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    mainTopic: { type: 'string' },
    contentType: { type: 'string' },
    targetAudience: { type: 'string' },
    language: { type: 'string' },
    chapters: { type: 'array', minItems: 1, maxItems: 16, items: chapterSchema },
    topics: stringArraySchema,
    keyClaims: stringArraySchema,
    questions: stringArraySchema,
    stories: stringArraySchema,
    importantMoments: { type: 'array', maxItems: 12, items: importantMomentSchema }
  },
  required: [
    'summary', 'mainTopic', 'contentType', 'targetAudience', 'language', 'chapters',
    'topics', 'keyClaims', 'questions', 'stories', 'importantMoments'
  ]
};

export const VIDEO_UNDERSTANDING_CHUNK_SCHEMA: StrictJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    startTime: { type: 'number', minimum: 0 },
    endTime: { type: 'number', minimum: 0 },
    summary: { type: 'string' },
    topics: stringArraySchema,
    keyClaims: stringArraySchema,
    questions: stringArraySchema,
    stories: stringArraySchema,
    importantMoments: { type: 'array', maxItems: 8, items: importantMomentSchema }
  },
  required: [
    'startTime', 'endTime', 'summary', 'topics', 'keyClaims', 'questions',
    'stories', 'importantMoments'
  ]
};

function exactObject(value: unknown, keys: readonly string[], label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be an object');
  }
  const item = value as Record<string, unknown>;
  const actual = Object.keys(item);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in item))) {
    throw new Error(label + ' does not match the strict schema');
  }
  return item;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' must be a string');
  return value.trim();
}

function stringArray(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(label + ' must be a string array');
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function boundedNumber(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) ||
    value < minimum || value > maximum) {
    throw new Error(label + ' is outside its valid range');
  }
  return value;
}

function finiteNumber(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(label + ' must be a finite number');
  }
  return value;
}

function clampToRange(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

// Two adjacent chapters whose edges disagree by a small amount, relative to either chapter's own
// duration, are boundary noise from the model (rounding/drift) rather than a structural
// contradiction, so they can be safely trimmed instead of discarding the whole result.
function isTinyChapterOverlap(overlapSeconds: number, previousDuration: number, currentDuration: number) {
  const relativeAllowance = 0.15 * Math.min(previousDuration, currentDuration);
  return overlapSeconds <= Math.min(3, Math.max(0.5, relativeAllowance));
}

type ParsedChapterFields = {
  startTime: number;
  endTime: number;
  title: string;
  summary: string;
  topics: string[];
  importanceScore: number;
};

function parseChapterFields(chapterValue: unknown): ParsedChapterFields {
  const chapter = exactObject(chapterValue, [
    'startTime', 'endTime', 'title', 'summary', 'topics', 'importanceScore'
  ], 'chapter');
  return {
    startTime: finiteNumber(chapter.startTime, 'chapter.startTime'),
    endTime: finiteNumber(chapter.endTime, 'chapter.endTime'),
    title: requiredString(chapter.title, 'chapter.title'),
    summary: requiredString(chapter.summary, 'chapter.summary'),
    topics: stringArray(chapter.topics, 'chapter.topics'),
    importanceScore: boundedNumber(chapter.importanceScore, 'chapter.importanceScore', 0, 100)
  };
}

// Deterministic repair pass applied before a whole-video result is ever rejected: clamps
// out-of-bounds timestamps, drops zero-length/duplicate/fully-nested chapters, reorders
// chronologically when the model returned chapters out of sequence, and trims small boundary
// overlaps. It never invents or rewrites transcript-derived content (titles/summaries/topics
// pass through untouched) and still throws when chapters are genuinely contradictory (a large,
// non-nested overlap) or nothing usable survives, so the caller falls back to the deterministic
// transcript analysis exactly as before.
export function normalizeChapters(rawChapters: ParsedChapterFields[], minimumTime: number,
  maximumTime: number): { chapters: UnderstandingChapter[]; telemetry: ChapterNormalizationTelemetry } {
  const chapterCountBefore = rawChapters.length;
  let chapterBoundaryClamps = 0;
  const clamped = rawChapters.map((chapter) => {
    const startTime = clampToRange(chapter.startTime, minimumTime, maximumTime);
    const endTime = clampToRange(chapter.endTime, minimumTime, maximumTime);
    if (startTime !== chapter.startTime || endTime !== chapter.endTime) chapterBoundaryClamps += 1;
    return { ...chapter, startTime, endTime };
  }).filter((chapter) => chapter.endTime > chapter.startTime);

  const deduped: typeof clamped = [];
  const seenBounds = new Set<string>();
  for (const chapter of clamped) {
    const key = chapter.startTime.toFixed(3) + ':' + chapter.endTime.toFixed(3);
    if (seenBounds.has(key)) continue;
    seenBounds.add(key);
    deduped.push(chapter);
  }

  const sorted = [...deduped].sort((left, right) => left.startTime - right.startTime);
  const chaptersReordered = sorted.some((chapter, index) => chapter !== deduped[index]);

  let chapterOverlapRepairs = 0;
  const resolved: typeof sorted = [];
  for (const chapter of sorted) {
    const previous = resolved[resolved.length - 1];
    if (!previous || chapter.startTime >= previous.endTime) { resolved.push(chapter); continue; }
    if (chapter.endTime <= previous.endTime) {
      // Fully nested inside the previous chapter: redundant: dropped rather than fabricated.
      chapterOverlapRepairs += 1;
      continue;
    }
    const overlap = previous.endTime - chapter.startTime;
    if (isTinyChapterOverlap(overlap, previous.endTime - previous.startTime,
      chapter.endTime - chapter.startTime)) {
      chapterOverlapRepairs += 1;
      const trimmedStart = previous.endTime;
      if (trimmedStart >= chapter.endTime) continue;
      resolved.push({ ...chapter, startTime: trimmedStart });
      continue;
    }
    throw new Error('chapters contain a large invalid overlap that cannot be safely normalized');
  }

  if (!resolved.length) {
    throw new Error('videoUnderstanding.chapters contained no valid chapters after normalization');
  }

  const chapterCountAfter = resolved.length;
  const telemetry: ChapterNormalizationTelemetry = {
    chapterCountBefore, chapterCountAfter, chaptersReordered, chapterOverlapRepairs,
    chapterBoundaryClamps, wholeVideoNormalizationApplied: chaptersReordered ||
      chapterOverlapRepairs > 0 || chapterBoundaryClamps > 0 || chapterCountAfter !== chapterCountBefore
  };
  return { chapters: resolved, telemetry };
}

function parseImportantMoment(value: unknown, minimumTime: number, maximumTime: number) {
  const item = exactObject(value, [
    'startTime', 'endTime', 'title', 'description', 'importanceScore'
  ], 'importantMoment');
  const startTime = boundedNumber(item.startTime, 'importantMoment.startTime',
    minimumTime, maximumTime);
  const endTime = boundedNumber(item.endTime, 'importantMoment.endTime',
    minimumTime, maximumTime);
  if (endTime < startTime) throw new Error('importantMoment ends before it starts');
  return {
    startTime,
    endTime,
    title: requiredString(item.title, 'importantMoment.title'),
    description: requiredString(item.description, 'importantMoment.description'),
    importanceScore: boundedNumber(item.importanceScore,
      'importantMoment.importanceScore', 0, 100)
  };
}

export function parseVideoUnderstanding(
  value: unknown,
  minimumTime: number,
  maximumTime: number
): VideoUnderstandingResult {
  const keys = [
    'summary', 'mainTopic', 'contentType', 'targetAudience', 'language', 'chapters',
    'topics', 'keyClaims', 'questions', 'stories', 'importantMoments'
  ] as const;
  const item = exactObject(value, keys, 'videoUnderstanding');
  if (!Array.isArray(item.chapters) || item.chapters.length === 0) {
    throw new Error('videoUnderstanding.chapters must be a non-empty array');
  }
  const rawChapters = item.chapters.map((chapterValue) => parseChapterFields(chapterValue));
  const { chapters, telemetry } = normalizeChapters(rawChapters, minimumTime, maximumTime);
  recordChapterNormalization(telemetry);
  return {
    summary: requiredString(item.summary, 'summary'),
    mainTopic: requiredString(item.mainTopic, 'mainTopic'),
    contentType: requiredString(item.contentType, 'contentType'),
    targetAudience: requiredString(item.targetAudience, 'targetAudience'),
    language: requiredString(item.language, 'language'),
    chapters,
    topics: stringArray(item.topics, 'topics'),
    keyClaims: stringArray(item.keyClaims, 'keyClaims'),
    questions: stringArray(item.questions, 'questions'),
    stories: stringArray(item.stories, 'stories'),
    importantMoments: Array.isArray(item.importantMoments)
      ? item.importantMoments.map((moment) =>
        parseImportantMoment(moment, minimumTime, maximumTime))
      : (() => { throw new Error('importantMoments must be an array'); })()
  };
}

function parseChunkSummary(value: unknown, minimumTime: number, maximumTime: number): ChunkSummary {
  const item = exactObject(value, [
    'startTime', 'endTime', 'summary', 'topics', 'keyClaims', 'questions',
    'stories', 'importantMoments'
  ], 'chunkSummary');
  const startTime = boundedNumber(item.startTime, 'chunkSummary.startTime',
    minimumTime, maximumTime);
  const endTime = boundedNumber(item.endTime, 'chunkSummary.endTime',
    minimumTime, maximumTime);
  if (endTime < startTime) throw new Error('chunkSummary ends before it starts');
  return {
    startTime,
    endTime,
    summary: requiredString(item.summary, 'chunkSummary.summary'),
    topics: stringArray(item.topics, 'chunkSummary.topics'),
    keyClaims: stringArray(item.keyClaims, 'chunkSummary.keyClaims'),
    questions: stringArray(item.questions, 'chunkSummary.questions'),
    stories: stringArray(item.stories, 'chunkSummary.stories'),
    importantMoments: Array.isArray(item.importantMoments)
      ? item.importantMoments.map((moment) =>
        parseImportantMoment(moment, minimumTime, maximumTime))
      : (() => { throw new Error('chunkSummary.importantMoments must be an array'); })()
  };
}

function splitOversizedPart(part: TranscriptPart, maximumCharacters: number) {
  if (part.text.length <= maximumCharacters) return [part];
  const pieces = [];
  const count = Math.ceil(part.text.length / maximumCharacters);
  for (let index = 0; index < count; index += 1) {
    const startRatio = index / count;
    const endRatio = (index + 1) / count;
    pieces.push({
      ...part,
      position: part.position * 10000 + index,
      startTime: part.startTime + (part.endTime - part.startTime) * startRatio,
      endTime: part.startTime + (part.endTime - part.startTime) * endRatio,
      text: part.text.slice(index * maximumCharacters, (index + 1) * maximumCharacters)
    });
  }
  return pieces;
}

function formatPart(part: TranscriptPart) {
  return '[' + part.startTime.toFixed(3) + '-' + part.endTime.toFixed(3) + '] ' +
    part.text.trim();
}

function groupBySize<T>(items: T[], maximumCharacters: number, serialize: (item: T) => string) {
  const groups: T[][] = [];
  let current: T[] = [];
  let currentSize = 0;
  for (const item of items) {
    const size = serialize(item).length + 1;
    if (current.length && currentSize + size > maximumCharacters) {
      groups.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(item);
    currentSize += size;
  }
  if (current.length) groups.push(current);
  return groups;
}

const analysisPrompt = [
  'Analyze the supplied timestamped transcript as one complete video.',
  'Use only supplied evidence and preserve all timestamps in seconds.',
  'Create chronological, non-overlapping chapters with meaningful semantic boundaries.',
  'Return only the exact JSON schema. Do not add markdown or extra properties.',
  'Questions are questions materially discussed; stories are concise descriptions of narrative anecdotes.',
  'Important moments must use timestamp ranges from the supplied transcript.',
  'Keep the response compact: summary at most 500 words; chapter summaries at most 80 words;',
  'chapter titles at most 12 words; list entries at most 40 words; use no more items than the schema permits.'
].join(' ');

const localStringArraySchema = { type: 'array', maxItems: 6,
  items: { type: 'string' } } as const;
const localChapterSchema = { ...chapterSchema, properties: { ...chapterSchema.properties,
  topics: { type: 'array', maxItems: 4, items: { type: 'string' } } } } as const;
const LOCAL_VIDEO_UNDERSTANDING_SCHEMA: StrictJsonSchema = {
  ...VIDEO_UNDERSTANDING_SCHEMA,
  properties: { ...(VIDEO_UNDERSTANDING_SCHEMA.properties as Record<string, unknown>),
    chapters: { type: 'array', minItems: 1, maxItems: 8, items: localChapterSchema },
    topics: localStringArraySchema, keyClaims: localStringArraySchema,
    questions: localStringArraySchema, stories: localStringArraySchema,
    importantMoments: { type: 'array', maxItems: 6, items: importantMomentSchema } }
};
const LOCAL_VIDEO_CHUNK_SCHEMA: StrictJsonSchema = {
  ...VIDEO_UNDERSTANDING_CHUNK_SCHEMA,
  properties: { ...(VIDEO_UNDERSTANDING_CHUNK_SCHEMA.properties as Record<string, unknown>),
    topics: { type: 'array', maxItems: 4, items: { type: 'string' } },
    keyClaims: { type: 'array', maxItems: 4, items: { type: 'string' } },
    questions: { type: 'array', maxItems: 3, items: { type: 'string' } },
    stories: { type: 'array', maxItems: 3, items: { type: 'string' } },
    importantMoments: { type: 'array', maxItems: 4, items: importantMomentSchema } }
};
const localAnalysisPrompt = [
  'Analyze compact chronological transcript evidence for one video.',
  'Use only supplied evidence and timestamps.',
  'Return concise JSON only, with no prose or markdown.',
  'Use at most 8 chapters, 6 topics, 6 claims, 6 questions, 6 stories, and 6 important moments.',
  'Keep summaries and list entries short; omit weak items rather than repeating evidence.'
].join(' ');

function compactText(value: string, maximum: number) {
  const clean = value.trim().replace(/\s+/gu, ' ');
  if (clean.length <= maximum) return clean;
  const first = Math.max(1, Math.floor(maximum * .65));
  return (clean.slice(0, first) + ' … ' + clean.slice(-(maximum - first - 3))).slice(0, maximum);
}

export function compactTranscriptForLocal(parts: TranscriptPart[], maximumCharacters = 12000,
  entryCap = 96) {
  const maximum = Math.max(2000, Math.floor(maximumCharacters));
  const maximumEntries = Math.min(parts.length, entryCap, Math.max(1, Math.floor(maximum / 60)));
  const selected = maximumEntries === parts.length ? parts : Array.from({ length: maximumEntries },
    (_, index) => parts[Math.min(parts.length - 1,
      Math.floor(index * parts.length / maximumEntries))]);
  let allowance = Math.max(40, Math.floor((maximum - selected.length * 32) /
    Math.max(1, selected.length)));
  let serialized = '';
  do {
    serialized = JSON.stringify(selected.map(part => ({
      t: [Number(part.startTime.toFixed(2)), Number(part.endTime.toFixed(2))],
      x: compactText(part.text, allowance)
    })));
    allowance = Math.max(20, allowance - 20);
  } while (serialized.length > maximum && allowance > 20);
  return serialized;
}

function compactSummariesForLocal(summaries: ChunkSummary[]) {
  const count = Math.min(12, summaries.length);
  const groups = Array.from({ length: count }, (_, index) => summaries.slice(
    Math.floor(index * summaries.length / count),
    Math.floor((index + 1) * summaries.length / count)));
  const unique = (values: string[], maximum: number) => [...new Set(values)].slice(0, maximum);
  return JSON.stringify(groups.map(group => ({
    t: [group[0].startTime, group[group.length - 1].endTime],
    s: compactText(group.map(summary => summary.summary).join(' '), 360),
    topics: unique(group.flatMap(summary => summary.topics), 4),
    claims: unique(group.flatMap(summary => summary.keyClaims), 4),
    questions: unique(group.flatMap(summary => summary.questions), 2),
    stories: unique(group.flatMap(summary => summary.stories), 2),
    moments: group.flatMap(summary => summary.importantMoments).slice(0, 3)
  })));
}

function localInputLimit() {
  const configured = Number(process.env.LOCAL_WHOLE_VIDEO_INPUT_CHARS ?? 12000);
  return Number.isFinite(configured) ? Math.max(2000, Math.min(24000,
    Math.floor(configured))) : 12000;
}

// Cloud requests get a larger compact budget than the local/offline path (better model, still
// far below the raw timestamped transcript), which is what keeps the ONLINE wholeVideoUnderstanding
// call inside its fail-fast timeout ceiling (AI_MODE_ROLE_TIMEOUTS.ONLINE.wholeVideoUnderstanding).
function onlineInputLimit() {
  const configured = Number(process.env.LLM_WHOLE_VIDEO_INPUT_CHARS ?? 16000);
  return Number.isFinite(configured) ? Math.max(4000, Math.min(40000,
    Math.floor(configured))) : 16000;
}

function wholeVideoUnderstandingEnabled() {
  const raw = process.env.WHOLE_VIDEO_UNDERSTANDING_ENABLED;
  if (raw === undefined) return true;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

const onlineChapterSchema = { ...chapterSchema, properties: { ...chapterSchema.properties,
  topics: { type: 'array', maxItems: 6, items: { type: 'string' } } } } as const;
const onlineStringArraySchema = { type: 'array', maxItems: 8, items: { type: 'string' } } as const;
// A compact schema keeps requestedMaxOutputTokens small without weakening the strict shape
// validation applied to the full VIDEO_UNDERSTANDING_SCHEMA (kept as-is for direct API callers).
const ONLINE_VIDEO_UNDERSTANDING_SCHEMA: StrictJsonSchema = {
  ...VIDEO_UNDERSTANDING_SCHEMA,
  properties: { ...(VIDEO_UNDERSTANDING_SCHEMA.properties as Record<string, unknown>),
    chapters: { type: 'array', minItems: 1, maxItems: 10, items: onlineChapterSchema },
    topics: onlineStringArraySchema, keyClaims: onlineStringArraySchema,
    questions: onlineStringArraySchema, stories: onlineStringArraySchema,
    importantMoments: { type: 'array', maxItems: 8, items: importantMomentSchema } }
};
const ONLINE_VIDEO_CHUNK_SCHEMA: StrictJsonSchema = {
  ...VIDEO_UNDERSTANDING_CHUNK_SCHEMA,
  properties: { ...(VIDEO_UNDERSTANDING_CHUNK_SCHEMA.properties as Record<string, unknown>),
    topics: { type: 'array', maxItems: 6, items: { type: 'string' } },
    keyClaims: { type: 'array', maxItems: 6, items: { type: 'string' } },
    questions: { type: 'array', maxItems: 4, items: { type: 'string' } },
    stories: { type: 'array', maxItems: 4, items: { type: 'string' } },
    importantMoments: { type: 'array', maxItems: 6, items: importantMomentSchema } }
};
const onlineAnalysisPrompt = [
  'Analyze the supplied compact chronological transcript evidence as one complete video.',
  'Each entry has t: [startSeconds, endSeconds] and x: condensed spoken text; use only supplied evidence.',
  'Create chronological, non-overlapping chapters with meaningful semantic boundaries.',
  'Return only the exact JSON schema. Do not add markdown or extra properties.',
  'Keep the response compact: summary at most 300 words; chapter summaries at most 50 words;',
  'chapter titles at most 12 words; list entries at most 30 words; use no more items than the schema permits.'
].join(' ');

@Injectable()
export class VideoUnderstandingService {
  private readonly logger = new Logger(VideoUnderstandingService.name);
  private lastRoute: LlmRouteMetadata | null = null;
  private readonly routesByJob = new WeakMap<object, LlmRouteMetadata>();
  private readonly llmRouter: LlmRouterService;

  constructor(@Inject(LlmRouterService) routerOrLegacyProvider: LlmRouterService | {
    providerName: string;
    modelName: string;
    generateStructured<T>(request: StructuredGenerationRequest): Promise<T>;
  } = new LlmRouterService()) {
    if ('generate' in routerOrLegacyProvider) {
      this.llmRouter = routerOrLegacyProvider;
    } else {
      const legacy = routerOrLegacyProvider;
      this.llmRouter = {
        routesFor: () => [{ provider: legacy.providerName, model: legacy.modelName }],
        generate: async <T>(input: { request: StructuredGenerationRequest }) => {
          const configured = Number(process.env.LLM_MAX_RETRIES ?? 2);
          const retries = Number.isInteger(configured) ? Math.max(0, Math.min(5, configured)) : 2;
          let lastError: unknown;
          for (let attempt = 0; attempt <= retries; attempt += 1) {
            try {
              return { data: await legacy.generateStructured<T>(input.request), metadata: {
                role: 'wholeVideoUnderstanding' as const, provider: legacy.providerName,
                model: legacy.modelName, failover: false, cacheHit: false, attempts: [] } };
            } catch (error) { lastError = error; }
          }
          throw lastError;
        }
      } as unknown as LlmRouterService;
    }
  }

  get providerName() {
    return this.currentRoute()?.provider ??
      this.llmRouter.routesFor('wholeVideoUnderstanding')[0]?.provider ?? '';
  }

  get modelName() {
    return this.currentRoute()?.model ??
      this.llmRouter.routesFor('wholeVideoUnderstanding')[0]?.model ?? '';
  }

  async analyzeWithFallback(parts: TranscriptPart[], languageHint?: string | null) {
    if (currentAiProcessingMode() === AiProcessingMode.OFFLINE) {
      this.logger.log(JSON.stringify({ event: 'offline_deterministic_role',
        role: 'wholeVideoUnderstanding' }));
      return this.deterministicAnalysis(parts, languageHint);
    }
    if (!wholeVideoUnderstandingEnabled()) {
      // Confidence gate: whole-video context only enriches candidate framing (topic/chapter
      // labels), it never drives scoring, so operators may disable the model call entirely.
      this.logger.log(JSON.stringify({ event: 'whole_video_understanding_disabled',
        role: 'wholeVideoUnderstanding' }));
      return this.deterministicAnalysis(parts, languageHint);
    }
    try {
      return await this.analyze(parts, languageHint);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn('Whole-video understanding failed; transcript heuristics remain active: ' + reason);
      recordWholeVideoFallbackReason(reason);
      return this.deterministicAnalysis(parts, languageHint);
    }
  }

  private deterministicAnalysis(parts: TranscriptPart[], languageHint?: string | null) {
    const usable = parts.filter(part => part.text.trim() && part.endTime > part.startTime)
      .sort((left, right) => left.startTime - right.startTime || left.position - right.position);
    if (!usable.length) return null;
    this.setRoute({ role: 'wholeVideoUnderstanding', provider: 'deterministic',
      model: 'transcript-extractive', failover: false, cacheHit: false, attempts: [] });
    const chapters = groupBySize(usable, 5000, part => part.text).map(group => ({
      startTime: group[0].startTime, endTime: group[group.length - 1].endTime,
      title: group[0].text.split(/\s+/u).slice(0, 10).join(' '),
      summary: group.map(part => part.text.match(/[^.!?]+[.!?]?/u)?.[0] || '').join(' ').slice(0, 1500),
      topics: [] as string[], importanceScore: 50 }));
    return { summary: chapters.map(chapter => chapter.summary).join(' ').slice(0, 4000),
      mainTopic: chapters[0].title, contentType: 'Transcript excerpt', targetAudience: 'Unspecified',
      language: languageHint || 'unknown', chapters, topics: [], keyClaims: [], questions: [],
      stories: [], importantMoments: [] } as VideoUnderstandingResult;
  }

  async analyze(parts: TranscriptPart[], languageHint?: string | null) {
    const usable = parts.filter((part) => part.text.trim() &&
      Number.isFinite(part.startTime) && Number.isFinite(part.endTime) &&
      part.startTime >= 0 && part.endTime >= part.startTime)
      .sort((left, right) => left.startTime - right.startTime || left.position - right.position);
    if (!usable.length) throw new Error('Transcript contains no analyzable text');
    const minimumTime = usable[0].startTime;
    const maximumTime = Math.max(...usable.map((part) => part.endTime));
    const configuredLimit = Number(process.env.LLM_SAFE_INPUT_CHARS ?? 60000);
    const safeLimit = Number.isFinite(configuredLimit)
      ? Math.max(4000, Math.floor(configuredLimit))
      : 60000;
    const payloadLimit = Math.max(3000, safeLimit - 1500);
    // Extractive compression covers the entire timeline without serial model summary passes.
    // Small-context configurations retain the existing hierarchical path for integrations.
    const totalCharacters = usable.reduce((sum, part) => sum + part.text.length, 0);
    const budget = 24000;
    const compressed = safeLimit >= budget && totalCharacters > budget
      ? usable.map(part => {
        const allowance = Math.max(80, Math.floor(budget * part.text.length / totalCharacters));
        if (part.text.length <= allowance) return part;
        const sentences = part.text.match(/[^.!?]+[.!?]?/gu) || [part.text];
        const chosen = new Set([0, sentences.length - 1]);
        let length = [...chosen].reduce((sum, index) => sum + sentences[index].length, 0);
        for (let index = 1; index < sentences.length - 1; index++) {
          if (length + sentences[index].length > allowance) continue;
          chosen.add(index); length += sentences[index].length;
        }
        return { ...part, text: [...chosen].sort((a, b) => a - b).map(index => sentences[index]).join(' ') };
      }) : usable;
    const expanded = compressed.flatMap((part) => splitOversizedPart(part, payloadLimit - 100));
    const transcriptText = expanded.map(formatPart).join('\n');
    const language = languageHint?.trim() || 'unknown';

    if (transcriptText.length <= payloadLimit) {
      const onlineEvidence = compactTranscriptForLocal(usable, onlineInputLimit(), 160);
      const localEvidence = compactTranscriptForLocal(usable, localInputLimit());
      this.logger.log(JSON.stringify({ event: 'whole_video_understanding_input_size',
        rawTranscriptChars: transcriptText.length, compactOnlineChars: onlineEvidence.length }));
      const raw = await this.generateWithRetry<unknown>({
        schemaName: 'video_understanding',
        schema: ONLINE_VIDEO_UNDERSTANDING_SCHEMA,
        systemPrompt: onlineAnalysisPrompt,
        userPrompt: 'Language hint: ' + language +
          '\nCompact chronological transcript evidence (JSON array of {t:[startSeconds,endSeconds],' +
          ' x:condensedText}):\n' + onlineEvidence,
        maxOutputTokens: 4500,
        local: { schemaName: 'local_video_understanding',
          schema: LOCAL_VIDEO_UNDERSTANDING_SCHEMA, systemPrompt: localAnalysisPrompt,
          userPrompt: JSON.stringify({ language, transcript: JSON.parse(localEvidence) }),
          maxOutputTokens: 4000 }
      });
      return parseVideoUnderstanding(raw, minimumTime, maximumTime);
    }

    let summaries = await Promise.all(groupBySize(expanded, payloadLimit, formatPart)
      .map((group) => this.summarize(group.map(formatPart).join('\n'),
        group[0].startTime, group[group.length - 1].endTime, language)));

    while (JSON.stringify(summaries).length > payloadLimit) {
      const groups = groupBySize(summaries, payloadLimit,
        (summary) => JSON.stringify(summary));
      summaries = await Promise.all(groups.map((group) => this.summarize(
        JSON.stringify(group),
        group[0].startTime,
        group[group.length - 1].endTime,
        language,
        true
      )));
    }

    const onlineSummaries = compactSummariesForLocal(summaries);
    const localSummaries = compactSummariesForLocal(summaries);
    this.logger.log(JSON.stringify({ event: 'whole_video_understanding_input_size',
      rawSummaryChars: JSON.stringify(summaries).length, compactOnlineChars: onlineSummaries.length }));
    const raw = await this.generateWithRetry<unknown>({
      schemaName: 'video_understanding',
      schema: ONLINE_VIDEO_UNDERSTANDING_SCHEMA,
      systemPrompt: onlineAnalysisPrompt,
      userPrompt: 'Language hint: ' + language +
        '\nThese are compact chronological summaries of the full transcript. Synthesize the whole ' +
        'video without inventing details:\n' + onlineSummaries,
      maxOutputTokens: 4500,
      local: { schemaName: 'local_video_understanding',
        schema: LOCAL_VIDEO_UNDERSTANDING_SCHEMA, systemPrompt: localAnalysisPrompt,
        userPrompt: JSON.stringify({ language, summaries: JSON.parse(localSummaries) }),
        maxOutputTokens: 4000 }
    });
    return parseVideoUnderstanding(raw, minimumTime, maximumTime);
  }

  private async summarize(
    source: string,
    startTime: number,
    endTime: number,
    language: string,
    merging = false
  ) {
    const localSource = compactText(source, Math.min(8000, localInputLimit()));
    const onlineSource = compactText(source, Math.min(10000, onlineInputLimit()));
    const raw = await this.generateWithRetry<unknown>({
      schemaName: 'video_understanding_chunk',
      schema: ONLINE_VIDEO_CHUNK_SCHEMA,
      systemPrompt: [
        'Compress transcript evidence for a later whole-video analysis.',
        'Retain concrete topics, claims, questions, stories, important moments, and exact timestamps.',
        'Return only the exact JSON schema. Do not add markdown or extra properties.'
      ].join(' '),
      userPrompt: 'Language hint: ' + language + '\nRequired range: ' + startTime + '-' +
        endTime + '\nSource type: ' + (merging ? 'prior chronological summaries' : 'transcript') +
        '\nSource:\n' + onlineSource,
      maxOutputTokens: 2600,
      local: { schemaName: 'local_video_understanding_chunk',
        schema: LOCAL_VIDEO_CHUNK_SCHEMA,
        systemPrompt: 'Compress only the supplied evidence. Preserve the exact required range. ' +
          'Return concise JSON only; no prose, markdown, repetition, or invented details.',
        userPrompt: JSON.stringify({ language, requiredRange: [startTime, endTime],
          sourceType: merging ? 'summaries' : 'transcript', source: localSource }),
        maxOutputTokens: 2400 }
    });
    const parsed = parseChunkSummary(raw, startTime, endTime);
    if (Math.abs(parsed.startTime - startTime) > 0.001 ||
      Math.abs(parsed.endTime - endTime) > 0.001) {
      throw new Error('Chunk summary did not preserve its required timestamp range');
    }
    return parsed;
  }

  private async generateWithRetry<T>(request: StructuredGenerationRequest) {
    const result = await this.llmRouter.generate<T>({
      role: 'wholeVideoUnderstanding',
      request
    });
    this.setRoute(result.metadata);
    return result.data;
  }

  private setRoute(route: LlmRouteMetadata) {
    const context = performanceContext.getStore();
    if (context) this.routesByJob.set(context, route);
    else this.lastRoute = route;
  }

  private currentRoute() {
    const context = performanceContext.getStore();
    return context ? this.routesByJob.get(context) ?? null : this.lastRoute;
  }
}

type UnderstandingPrisma = {
  videoUnderstanding: {
    upsert(args: Record<string, unknown>): Promise<unknown>;
  };
};

export function persistVideoUnderstanding(
  prisma: UnderstandingPrisma,
  videoId: string,
  result: VideoUnderstandingResult,
  provider: string,
  model: string
) {
  const fields = {
    summary: result.summary,
    mainTopic: result.mainTopic,
    contentType: result.contentType,
    targetAudience: result.targetAudience,
    language: result.language,
    topics: result.topics,
    keyClaims: result.keyClaims,
    questions: result.questions,
    stories: result.stories,
    importantMoments: result.importantMoments,
    provider,
    model
  };
  const chapters = result.chapters.map((chapter, position) => ({ ...chapter, position }));
  return prisma.videoUnderstanding.upsert({
    where: { videoId },
    update: {
      ...fields,
      chapters: { deleteMany: {}, create: chapters }
    },
    create: {
      videoId,
      ...fields,
      chapters: { create: chapters }
    }
  });
}
