import { createHash } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  calculateContentPotential,
  clampScore,
  ClipScores,
  processingModeFor,
  roundScore,
  ScoredClipCandidate
} from './clip-candidates';
import {
  LlmProviderError,
  LLM_DEFAULT_OPENAI_MODEL
} from './llm-provider.service';
import { LlmRouterService } from './llm-router.service';
import { semanticSimilarity } from './semantic-similarity.service';
import { countPerformance, currentAiProcessingMode } from './performance-telemetry';
import type { TargetPlatform } from './clip-selection-policy';
import { adaptHashtagsForPlatform, packageConsistency, packagingFor, packagingTelemetry,
  platformPackagingPrompt } from './platform-packaging';

export const CLIP_JUDGE_MODEL = LLM_DEFAULT_OPENAI_MODEL;
export const CLIP_CONTENT_PROMPT_VERSION = 'clip-content-v8-platform-aware-packaging';
const SCORE_FIELDS = ['hookScore', 'standaloneScore', 'payoffScore', 'flowScore',
  'informationScore', 'retentionScore', 'shareabilityScore'] as const;
const HOOK_SCORE_FIELDS = ['relevance', 'clarity', 'curiosity', 'payoffAlignment',
  'specificity'] as const;
const HOOK_STRATEGIES = ['strong claim', 'curiosity', 'question', 'surprising fact',
  'stakes/consequence', 'contradiction', 'problem/solution', 'story setup', 'warning',
  'educational/value', 'opinion/debate', 'emotional tension', 'supported quote',
  'supported number/stat'] as const;
const ANALYSIS_FIELDS = ['mainTopic', 'mainClaim', 'strongestFact', 'questionOrProblem',
  'tensionOrConflict', 'surprisingPoint', 'emotionalTone', 'payoffOrConclusion',
  'contentType', 'viewerValue'] as const;
const CONTENT_STRING_FIELDS = ['title', 'synopsis', 'caption', 'cta', 'topic',
  'contentType', 'whySelected'] as const;
const CONTENT_LIMITS: Record<(typeof CONTENT_STRING_FIELDS)[number], number> = {
  title: 100,
  synopsis: 600,
  caption: 1200,
  cta: 180,
  topic: 120,
  contentType: 80,
  whySelected: 500
};
const CANDIDATE_FIELDS = new Set([...SCORE_FIELDS, 'reject', 'reason', 'rejectionReason',
  ...CONTENT_STRING_FIELDS, 'clipAnalysis', 'hookCandidates', 'hashtags',
  'captionCandidates', 'titleCandidates', 'hashtagCandidates', 'synopsisCandidates']);
const STOP_WORDS = new Set(['about', 'after', 'again', 'also', 'and', 'are', 'because',
  'been', 'before', 'but', 'can', 'could', 'does', 'for', 'from', 'have', 'here',
  'into', 'just', 'more', 'most', 'that', 'the', 'their', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'what', 'when', 'where', 'which', 'why', 'will',
  'with', 'would', 'your']);

type HookScoreComponents = Record<(typeof HOOK_SCORE_FIELDS)[number], number>;
export type HookStrategy = (typeof HOOK_STRATEGIES)[number];
type ClipAnalysis = Record<(typeof ANALYSIS_FIELDS)[number], string>;
type HookOption = {
  hook: string;
  strategy: HookStrategy;
  components: HookScoreComponents;
  score: number;
};
export type GeneratedContent = {
  bestHook: string;
  alternateHooks: string[];
  generatedHookScore: number;
  selectedHookStrategy: HookStrategy;
  title: string;
  synopsis: string;
  caption: string;
  hashtags: string[];
  cta: string;
  topic: string;
  contentType: string;
  whySelected: string;
  hooks: Array<{ text: string; style: HookStrategy; score: number }>;
  hookOptions: HookOption[];
  creativeCandidates: Record<string, unknown>;
};

export const CLIP_CONTENT_PACKAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hookScore: { type: 'number', minimum: 0, maximum: 100 },
          standaloneScore: { type: 'number', minimum: 0, maximum: 100 },
          payoffScore: { type: 'number', minimum: 0, maximum: 100 },
          flowScore: { type: 'number', minimum: 0, maximum: 100 },
          informationScore: { type: 'number', minimum: 0, maximum: 100 },
          retentionScore: { type: 'number', minimum: 0, maximum: 100 },
          shareabilityScore: { type: 'number', minimum: 0, maximum: 100 },
          reject: { type: 'boolean' },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
          rejectionReason: { type: 'string', maxLength: 500 },
          clipAnalysis: {
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(ANALYSIS_FIELDS.map((field) =>
              [field, { type: 'string', minLength: 1, maxLength: 500 }])),
            required: [...ANALYSIS_FIELDS]
          },
          hookCandidates: {
            type: 'array', minItems: 10, maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                hook: { type: 'string', minLength: 8, maxLength: 180 },
                strategy: { type: 'string', enum: [...HOOK_STRATEGIES] },
                scores: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    relevance: { type: 'number', minimum: 0, maximum: 100 },
                    clarity: { type: 'number', minimum: 0, maximum: 100 },
                    curiosity: { type: 'number', minimum: 0, maximum: 100 },
                    payoffAlignment: { type: 'number', minimum: 0, maximum: 100 },
                    specificity: { type: 'number', minimum: 0, maximum: 100 }
                  },
                  required: [...HOOK_SCORE_FIELDS]
                }
              },
              required: ['hook', 'strategy', 'scores']
            }
          },
          captionCandidates: { type: 'array', minItems: 3, maxItems: 4,
            items: { type: 'string', minLength: 1, maxLength: 1200 } },
          titleCandidates: { type: 'array', minItems: 3, maxItems: 5,
            items: { type: 'string', minLength: 1, maxLength: 100 } },
          hashtagCandidates: { type: 'array', minItems: 15, maxItems: 20,
            items: { type: 'string', minLength: 2, maxLength: 60 } },
          synopsisCandidates: { type: 'array', minItems: 2, maxItems: 4,
            items: { type: 'string', minLength: 1, maxLength: 600 } },
          title: { type: 'string', minLength: 1, maxLength: 100 },
          synopsis: { type: 'string', minLength: 1, maxLength: 600 },
          caption: { type: 'string', minLength: 1, maxLength: 1200 },
          hashtags: {
            type: 'array', minItems: 5, maxItems: 5,
            items: { type: 'string', minLength: 2, maxLength: 60 }
          },
          cta: { type: 'string', maxLength: 180 },
          topic: { type: 'string', minLength: 1, maxLength: 120 },
          contentType: { type: 'string', minLength: 1, maxLength: 80 },
          whySelected: { type: 'string', minLength: 1, maxLength: 500 }
        },
        required: [...SCORE_FIELDS, 'reject', 'reason', 'rejectionReason',
          'clipAnalysis', 'hookCandidates', 'title', 'synopsis',
          'captionCandidates', 'titleCandidates', 'hashtagCandidates', 'synopsisCandidates',
          'caption', 'hashtags', 'cta', 'topic', 'contentType', 'whySelected']
      }
    }
  },
  required: ['candidates']
} as const;

export const LOCAL_CLIP_CONTENT_PACKAGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { candidates: { type: 'array', minItems: 1, maxItems: 1,
    items: { type: 'object', additionalProperties: false, properties: {
      hooks: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'object',
        additionalProperties: false, properties: { text: { type: 'string' },
          style: { type: 'string', enum: [...HOOK_STRATEGIES] } },
        required: ['text', 'style'] } },
      title: { type: 'string' }, synopsis: { type: 'string' }, caption: { type: 'string' },
      hashtags: { type: 'array', minItems: 5, maxItems: 5,
        items: { type: 'string' } }
    }, required: ['hooks', 'title', 'synopsis', 'caption', 'hashtags'] } } },
  required: ['candidates']
} as const;

// Batching several final candidates into one creativeGeneration request cuts call count roughly
// proportionally to batch size. candidateId is required (unlike the single-item schema above) so
// a batched response is matched back to its candidate by id rather than trusting array order.
function batchedClipContentPackageSchema(size: number) {
  return {
    type: 'object', additionalProperties: false,
    properties: { candidates: { type: 'array', minItems: size, maxItems: size,
      items: { type: 'object', additionalProperties: false, properties: {
        candidateId: { type: 'string' },
        hooks: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'object',
          additionalProperties: false, properties: { text: { type: 'string' },
            style: { type: 'string', enum: [...HOOK_STRATEGIES] } },
          required: ['text', 'style'] } },
        title: { type: 'string' }, synopsis: { type: 'string' }, caption: { type: 'string' },
        hashtags: { type: 'array', minItems: 5, maxItems: 5, items: { type: 'string' } }
      }, required: ['candidateId', 'hooks', 'title', 'synopsis', 'caption', 'hashtags'] } } },
    required: ['candidates']
  } as const;
}

// Reorders a batched response by echoed candidateId so a model that does not preserve array
// order still lands each package on its correct candidate. Falls back to the response's own
// order (positional) whenever ids are absent, duplicated, or incomplete, e.g. the unbatched
// single-item shape used when candidates.length === 1, which carries no candidateId at all.
function alignBatchItemsById(rawItems: unknown[] | undefined, candidates: ScoredClipCandidate[]) {
  if (!Array.isArray(rawItems) || candidates.length <= 1) return rawItems;
  const byId = new Map<string, unknown>();
  for (const item of rawItems) {
    const id = item && typeof item === 'object' &&
      typeof (item as Record<string, unknown>).candidateId === 'string'
      ? (item as Record<string, unknown>).candidateId as string : null;
    if (id && !byId.has(id)) byId.set(id, item);
  }
  if (byId.size !== rawItems.length || byId.size !== candidates.length) return rawItems;
  return candidates.map((candidate) => byId.get(candidate.rangeKey));
}

export const LOCAL_CREATIVE_SYSTEM_PROMPT = [
  'Create one transcript-grounded short-form content package and return exact JSON only.',
  'Return exactly 3 hooks. Each hook must be a complete sentence or complete thought and each must use a clearly different structure, style, and opening.',
  'Never add unsupported statistics, numbers, dates, names, facts, or claims; use only the exact clip transcript and supplied context.',
  'The title must name the exact clip subject. The caption must not repeat the title or any hook.',
  'Write the synopsis as exactly 3 useful paragraphs separated by \\n\\n: first the clip subject and context, second its key point or development, third its supported takeaway or significance. Ground every paragraph in the transcript and supplied visual/video context; do not fabricate, repeat filler, or use promotional language.',
  'Return exactly 5 unique hashtags relevant to this specific clip. Choose discoverable broad and niche/topic tags where appropriate; never add irrelevant generic spam tags, #viral, or #fyp.',
  'Do not use clickbait unsupported by the transcript. Do not return markdown, prose explanations, or verification notes.',
  'Before output, silently verify: all 3 hooks are distinct; no number is invented; the title is clip-specific; each of the 3 synopsis paragraphs is grounded and useful; and all 5 hashtags are unique and relevant.',
  'Compact valid shape example: {"candidates":[{"hooks":[{"text":"Solar dust blocks useful sunlight.","style":"strong claim"},{"text":"Why does cleaning restore panel output?","style":"question"},{"text":"Ignoring panel dust can reduce the light reaching each panel.","style":"stakes/consequence"}],"title":"How Dust Affects Solar Panels","synopsis":"The clip discusses dust on solar panels and the sunlight reaching them.\\n\\nDust blocks some of that sunlight; cleaning the panels removes the obstruction.\\n\\nThe point is that keeping panels clear helps preserve their exposure to sunlight.","caption":"Clean surfaces help panels receive the sunlight described in the clip.","hashtags":["#SolarPanels","#PanelCleaning","#SolarDust","#Sunlight","#SolarMaintenance"]}]}'
].join(' ');

export const BATCHED_CREATIVE_SYSTEM_PROMPT = [
  'Create one transcript-grounded short-form content package per supplied candidate and return exact JSON only.',
  'Each input item has its own candidateId and its own exact clip transcript; treat every candidate independently and echo its candidateId exactly in your matching output item.',
  'Return exactly 3 hooks per candidate. Each hook must be a complete sentence or complete thought and each must use a clearly different structure, style, and opening.',
  'Never add unsupported statistics, numbers, dates, names, facts, or claims; use only that candidate\'s exact clip transcript and supplied context.',
  'The title must name the exact clip subject. The caption must not repeat the title or any hook.',
  'Write the synopsis as exactly 3 useful paragraphs separated by \\n\\n: first the clip subject and context, second its key point or development, third its supported takeaway or significance. Ground every paragraph in the transcript and supplied visual/video context; do not fabricate, repeat filler, or use promotional language.',
  'Return exactly 5 unique hashtags relevant to that specific clip. Choose discoverable broad and niche/topic tags where appropriate; never add irrelevant generic spam tags, #viral, or #fyp.',
  'Do not use clickbait unsupported by the transcript. Do not return markdown, prose explanations, or verification notes.',
  'Before output, silently verify per candidate: all 3 hooks are distinct; no number is invented; the title is clip-specific; each of the 3 synopsis paragraphs is grounded and useful; all 5 hashtags are unique and relevant; and candidateId is echoed exactly.'
].join(' ');

/**
 * The creative system prompt for this batch shape, with the platform's packaging
 * preferences appended. The base prompts stay exported and unchanged so existing
 * scripts and comparisons still reference the same grounding rules.
 */
export function creativeSystemPrompt(batched: boolean, platform: TargetPlatform | null) {
  return (batched ? BATCHED_CREATIVE_SYSTEM_PROMPT : LOCAL_CREATIVE_SYSTEM_PROMPT) + ' ' +
    platformPackagingPrompt(platform) +
    ' Write the caption for that platform rather than as a generic summary: it should extend the ' +
    'chosen hook, add the context a new viewer needs, keep curiosity alive, and carry the ' +
    'clip\'s own searchable terms naturally. It must never repeat the hook word for word.';
}

function normalize(value: string) {
  return value.trim().replace(/\s+/gu, ' ');
}

export function synopsisParagraphs(value: string) {
  return value.trim().split(/(?:\r?\n\s*){2,}/u).map(normalize);
}

export function normalizeSynopsis(value: string) {
  return synopsisParagraphs(value).join('\n\n');
}

export function hasThreeUsefulSynopsisParagraphs(value: string) {
  const paragraphs = synopsisParagraphs(value);
  return paragraphs.length === 3 && paragraphs.every(paragraph =>
    paragraph.length >= 20 && contentTerms(paragraph).size >= 2 &&
    !/\b(?:like and subscribe|don't miss out|watch till the end)\b/iu.test(paragraph)) &&
    new Set(paragraphs.map(paragraph => paragraph.toLowerCase())).size === 3;
}

export function synopsisGroundedInClip(value: string, candidate: ScoredClipCandidate) {
  const evidence = contentTerms([candidate.transcriptText, candidate.chapterSummary ?? '',
    candidate.wholeVideoContext ?? '', candidate.overallVideoTopic ?? '',
    ...(candidate.relevantTopics ?? [])].join(' '));
  return hasThreeUsefulSynopsisParagraphs(value) && synopsisParagraphs(value).every(paragraph =>
    [...contentTerms(paragraph)].some(term => evidence.has(term)));
}

export function hashtagsGroundedInClip(hashtags: string[], candidate: ScoredClipCandidate) {
  const evidence = contentTerms([candidate.transcriptText, candidate.chapterSummary ?? '',
    candidate.wholeVideoContext ?? '', candidate.overallVideoTopic ?? '', candidate.topic ?? '',
    ...(candidate.relevantTopics ?? [])].join(' '));
  return hashtags.every(tag => [...evidence].some(term =>
    tag.toLowerCase().includes(term) || term.includes(tag.slice(1).toLowerCase())));
}

function cleanForLog(value: string) {
  return normalize(value).replace(/[\r\n\t]/gu, ' ').slice(0, 300);
}

function words(value: string) {
  return value.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? [];
}

function contentTerms(value: string) {
  return new Set(words(value).filter((word) => word.length >= 4 && !STOP_WORDS.has(word)));
}

export function normalizedHookSimilarity(leftValue: string, rightValue: string) {
  return semanticSimilarity.similarity(leftValue, rightValue);
}

function isCompleteHook(value: string) {
  const clean = normalize(value);
  return clean.length >= 8 && /[.!?]["']?$/u.test(clean) &&
    !clean.endsWith('...') && !clean.endsWith('\u2026');
}

function assertHookTiedToCandidate(hook: string, candidate: ScoredClipCandidate) {
  const evidence = contentTerms([
    candidate.transcriptText,
    candidate.chapterSummary ?? '',
    candidate.wholeVideoContext ?? '',
    candidate.overallVideoTopic ?? '',
    ...(candidate.relevantTopics ?? [])
  ].join(' '));
  if (!evidence.size || !words(hook).some((word) => evidence.has(word))) {
    throw new Error('Generated hook is not tied to supplied clip content');
  }
  const sourceNumbers = new Set(words([
    candidate.transcriptText,
    candidate.chapterSummary ?? '',
    candidate.wholeVideoContext ?? ''
  ].join(' ')).filter((word) => /^\d/u.test(word)));
  const unsupportedNumber = words(hook).find((word) =>
    /^\d/u.test(word) && !sourceNumbers.has(word));
  if (unsupportedNumber) {
    throw new Error('Generated hook contains an unsupported number: ' + unsupportedNumber);
  }
}

function assertNoUnsupportedNumbers(
  value: string,
  candidate: ScoredClipCandidate,
  field: string
) {
  const evidenceNumbers = new Set(words([
    candidate.transcriptText,
    candidate.chapterSummary ?? '',
    candidate.wholeVideoContext ?? ''
  ].join(' ')).filter((word) => /^\d/u.test(word)));
  const unsupported = words(value).find((word) =>
    /^\d/u.test(word) && !evidenceNumbers.has(word));
  if (unsupported) throw new Error(field + ' contains an unsupported number: ' + unsupported);
}

function assertClipSpecificText(
  value: string,
  candidate: ScoredClipCandidate,
  field: string
) {
  const sourceTerms = contentTerms(candidate.transcriptText);
  if (!sourceTerms.size) return;
  const generatedTerms = contentTerms(value);
  if (![...generatedTerms].some((word) => sourceTerms.has(word))) {
    throw new Error(field + ' is not specific to the exact clip transcript');
  }
}

export function calculateGeneratedHookScore(scores: HookScoreComponents) {
  return roundScore(
    clampScore(scores.relevance) * 0.25 +
    clampScore(scores.clarity) * 0.20 +
    clampScore(scores.curiosity) * 0.20 +
    clampScore(scores.payoffAlignment) * 0.20 +
    clampScore(scores.specificity) * 0.15
  );
}

function calibratedScore(modelScore: number, heuristicScore: number) {
  return roundScore(heuristicScore * 0.35 + modelScore * 0.65);
}

function sentenceCount(value: string) {
  return normalize(value).match(/[^.!?]+[.!?]+|[^.!?]+$/gu)?.length ?? 0;
}

function parseClipAnalysis(value: unknown): ClipAnalysis {
  if (!value || typeof value !== 'object' ||
    Object.keys(value).some((field) =>
      !ANALYSIS_FIELDS.includes(field as (typeof ANALYSIS_FIELDS)[number]))) {
    throw new Error('Invalid clipAnalysis');
  }
  const analysis = {} as ClipAnalysis;
  for (const field of ANALYSIS_FIELDS) {
    const raw = (value as Record<string, unknown>)[field];
    if (typeof raw !== 'string' || !normalize(raw) || normalize(raw).length > 500) {
      throw new Error('Invalid clipAnalysis field: ' + field);
    }
    analysis[field] = normalize(raw);
  }
  return analysis;
}

function parseHookOptions(
  value: unknown,
  input: ScoredClipCandidate,
  analysis: ClipAnalysis
) {
  if (!Array.isArray(value) || value.length < 10 || value.length > 12) {
    throw new Error('hookCandidates must contain ten to twelve scored hooks');
  }
  const prefixCounts = new Map<string, number>();
  const parsed = value.map((raw, index): HookOption => {
    if (!raw || typeof raw !== 'object' ||
      Object.keys(raw).some((field) => !['hook', 'strategy', 'scores'].includes(field))) {
      throw new Error('Invalid hook candidate');
    }
    const item = raw as Record<string, unknown>;
    const hook = typeof item.hook === 'string' ? normalize(item.hook) : '';
    if (!isCompleteHook(hook) || hook.length > 180) {
      throw new Error('Generated hook candidate is incomplete');
    }
    assertHookTiedToCandidate(hook, input);
    if (typeof item.strategy !== 'string' ||
      !HOOK_STRATEGIES.includes(item.strategy as HookStrategy)) {
      throw new Error('Invalid hook strategy');
    }
    if (!item.scores || typeof item.scores !== 'object' ||
      Object.keys(item.scores).some((field) =>
        !HOOK_SCORE_FIELDS.includes(field as (typeof HOOK_SCORE_FIELDS)[number]))) {
      throw new Error('Invalid hook candidate scores');
    }
    const components = {} as HookScoreComponents;
    for (const field of HOOK_SCORE_FIELDS) {
      const score = (item.scores as Record<string, unknown>)[field];
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) {
        throw new Error('Invalid generated hook score component: ' + field);
      }
      components[field] = score;
    }
    const prefix = words(hook).slice(0, 3).join(' ');
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    return {
      hook,
      strategy: item.strategy as HookStrategy,
      components,
      score: calculateGeneratedHookScore(components) - index * 0.0001
    };
  });
  const sourceOpening = normalize(input.transcriptText)
    .match(/^[^.!?]+[.!?]?/u)?.[0]?.toLocaleLowerCase('en-US') ?? '';
  const payoffTerms = contentTerms(analysis.payoffOrConclusion);
  for (const option of parsed) {
    const lower = option.hook.toLocaleLowerCase('en-US');
    let penalty = 0;
    if (/^(?:the key insight|here'?s why|the truth is|you won'?t believe|this changes everything)\b/iu
      .test(option.hook)) penalty += 35;
    if (/\b(?:mind[- ]blowing|guaranteed|secret they don'?t want|shocking)\b/iu
      .test(option.hook)) penalty += 30;
    if (sourceOpening && (lower === sourceOpening ||
      normalize(input.transcriptText).toLocaleLowerCase('en-US').startsWith(lower))) {
      penalty += 30;
    }
    const hookTerms = contentTerms(option.hook);
    if (payoffTerms.size && ![...hookTerms].some((word) => payoffTerms.has(word))) {
      penalty += 15;
    }
    const prefix = words(option.hook).slice(0, 3).join(' ');
    if ((prefixCounts.get(prefix) ?? 0) > 1) penalty += 12;
    option.score = roundScore(option.score - penalty);
  }
  return parsed.sort((left, right) => right.score - left.score);
}

function chooseHookPackage(options: HookOption[]) {
  const chosen: HookOption[] = [];
  for (const option of options) {
    if (chosen.some((existing) => existing.strategy === option.strategy ||
      normalizedHookSimilarity(existing.hook, option.hook) >= 0.8)) continue;
    chosen.push(option);
    if (chosen.length === 3) break;
  }
  if (chosen.length !== 3) {
    throw new Error('Hook candidates did not provide three meaningfully distinct choices');
  }
  return chosen;
}

function parseBatch(value: unknown, inputs: ScoredClipCandidate[]) {
  if (!value || typeof value !== 'object' ||
    !Array.isArray((value as { candidates?: unknown }).candidates)) {
    throw new Error('Response is not a candidates object');
  }
  if (Object.keys(value).some((key) => key !== 'candidates')) {
    throw new Error('Response contains unexpected root fields');
  }
  const candidates = (value as { candidates: unknown[] }).candidates;
  if (candidates.length !== inputs.length) throw new Error('Response length mismatch');

  return candidates.map((candidate, index): ScoredClipCandidate => {
    if (!candidate || typeof candidate !== 'object') throw new Error('Invalid candidate object');
    const item = candidate as Record<string, unknown>;
    if (Object.keys(item).some((field) => !CANDIDATE_FIELDS.has(field))) {
      throw new Error('Candidate contains unexpected fields');
    }
    const input = inputs[index];
    // Rank the returned pools locally; all selected text must remain grounded in the exact clip.
    const sourceTerms = contentTerms(input.transcriptText);
    for (const [field, pool] of [['title', 'titleCandidates'], ['caption', 'captionCandidates'],
      ['synopsis', 'synopsisCandidates']] as const) {
      const choices = [item[field], ...(Array.isArray(item[pool]) ? item[pool] as unknown[] : [])]
        .filter((entry): entry is string => typeof entry === 'string' && !!normalize(entry))
        .map(entry => field === 'synopsis' ? normalizeSynopsis(entry) : normalize(entry)).filter(text => {
          try {
            assertNoUnsupportedNumbers(text, input, field);
            assertClipSpecificText(text, input, field);
            return text.length <= CONTENT_LIMITS[field] && (field !== 'synopsis' ||
              synopsisGroundedInClip(text, input));
          } catch { return false; }
        });
      const score = (text: string) => {
        const terms = [...contentTerms(text)];
        const supported = terms.filter(term => sourceTerms.has(term)).length;
        const target = field === 'title' ? 60 : field === 'caption' ? 180 : 240;
        return supported * 3 + supported / Math.max(1, terms.length) * 10 -
          Math.abs(text.length - target) / target;
      };
      choices.sort((left, right) => score(right) - score(left));
      if (choices.length) item[field] = choices[0];
    }
    const tags = [...(Array.isArray(item.hashtags) ? item.hashtags : []),
      ...(Array.isArray(item.hashtagCandidates) ? item.hashtagCandidates : [])]
      .filter((tag): tag is string => typeof tag === 'string')
      .map(tag => '#' + tag.replace(/^#+/u, '').replace(/[^\p{L}\p{N}_]/gu, ''))
      .filter(tag => tag.length > 1 && tag.length <= 60 && !/^#(?:viral|fyp)$/iu.test(tag));
    const uniqueTags = [...new Map(tags.map(tag => [tag.toLowerCase(), tag])).values()];
    const tagScore = (tag: string) => [...sourceTerms].filter(term => tag.toLowerCase().includes(term)).length;
    uniqueTags.sort((left, right) => tagScore(right) - tagScore(left));
    if (uniqueTags.length >= 5) item.hashtags = uniqueTags.slice(0, 5);
    const scores = {} as Record<(typeof SCORE_FIELDS)[number], number>;
    for (const field of SCORE_FIELDS) {
      if (typeof item[field] !== 'number' || !Number.isFinite(item[field]) ||
        (item[field] as number) < 0 || (item[field] as number) > 100) {
        throw new Error('Invalid candidate score: ' + field);
      }
      scores[field] = calibratedScore(item[field] as number, input[field]);
    }
    if (typeof item.reject !== 'boolean' || typeof item.reason !== 'string' ||
      !normalize(item.reason) ||
      typeof item.rejectionReason !== 'string') {
      throw new Error('Invalid candidate decision metadata');
    }
    for (const field of CONTENT_STRING_FIELDS) {
      if (typeof item[field] !== 'string' ||
        (field !== 'cta' && !normalize(item[field] as string)) ||
        normalize(item[field] as string).length > CONTENT_LIMITS[field]) {
        throw new Error('Invalid generated field: ' + field);
      }
    }
    for (const [field, minimum, maximum] of [
      ['captionCandidates', 3, 4], ['titleCandidates', 3, 5],
      ['hashtagCandidates', 15, 20], ['synopsisCandidates', 2, 4]
    ] as const) {
      const values = item[field];
      if (!Array.isArray(values) || values.length < minimum || values.length > maximum ||
        values.some((entry) => typeof entry !== 'string' || !normalize(entry))) {
        throw new Error(field + ' has an invalid candidate pool');
      }
    }
    for (const field of ['title', 'synopsis', 'caption', 'topic'] as const) {
      assertNoUnsupportedNumbers(item[field] as string, input, field);
    }
    assertClipSpecificText(item.synopsis as string, input, 'synopsis');
    const analysis = parseClipAnalysis(item.clipAnalysis);
    const hookOptions = parseHookOptions(item.hookCandidates, input, analysis);
    const selectedHooks = chooseHookPackage(hookOptions);
    const bestHook = selectedHooks[0].hook;
    const alternateHooks = selectedHooks.slice(1).map(({ hook }) => hook);
    if (!Array.isArray(item.hashtags) || item.hashtags.length !== 5 ||
      item.hashtags.some((tag) => typeof tag !== 'string' || !normalize(tag) ||
        normalize(tag).length > 60)) {
      throw new Error('hashtags must contain exactly five values');
    }
    if (!synopsisGroundedInClip(item.synopsis as string, input)) {
      throw new Error('synopsis must contain exactly three useful paragraphs');
    }
    if (normalize(item.caption as string).toLocaleLowerCase('en-US') ===
      bestHook.toLocaleLowerCase('en-US') ||
      normalize(item.caption as string).toLocaleLowerCase('en-US') ===
      normalize(item.synopsis as string).toLocaleLowerCase('en-US')) {
      throw new Error('caption must not duplicate the hook or synopsis');
    }
    const hashtags = (item.hashtags as string[]).map((tag) => {
      const clean = normalize(tag).replace(/^#+/u, '').replace(/[^\p{L}\p{N}_]/gu, '');
      if (!clean) throw new Error('Generated hashtag is empty after normalization');
      return '#' + clean;
    });
    if (new Set(hashtags.map((tag) => tag.toLocaleLowerCase('en-US'))).size !== hashtags.length ||
      hashtags.some((tag) => /^#(?:viral|fyp)$/iu.test(tag)) ||
      !hashtagsGroundedInClip(hashtags, input)) {
      throw new Error('hashtags must be relevant, deduplicated, and non-spammy');
    }
    const normalizedScores = scores as Pick<ClipScores, (typeof SCORE_FIELDS)[number]>;
    const overallScore = calculateContentPotential(normalizedScores);
    return {
      ...input,
      ...normalizedScores,
      sourceHookScore: normalizedScores.hookScore,
      contentPotential: overallScore,
      overallScore,
      reject: item.reject,
      reason: normalize(item.reason),
      rejectionReason: item.reject
        ? normalize(item.rejectionReason) || 'Rejected by configured LLM clip judge.'
        : '',
      bestHook,
      alternateHooks,
      generatedHookScore: selectedHooks[0].score,
      selectedHookStrategy: selectedHooks[0].strategy,
      title: normalize(item.title as string),
      synopsis: normalizeSynopsis(item.synopsis as string),
      caption: normalize(item.caption as string),
      hashtags,
      cta: normalize(item.cta as string),
      topic: normalize(item.topic as string),
      contentType: normalize(item.contentType as string),
      whySelected: normalize(item.whySelected as string),
      hooks: selectedHooks.map(({ hook, strategy, score }) => ({
        text: hook,
        style: strategy,
        score: roundScore(score)
      })),
      hookOptions,
      creativeCandidates: {
        hooks: hookOptions,
        captions: (item.captionCandidates as string[]).map(normalize),
        titles: (item.titleCandidates as string[]).map(normalize),
        hashtags: (item.hashtagCandidates as string[]).map(normalize),
        synopses: (item.synopsisCandidates as string[]).map(normalizeSynopsis)
      },
      generationStatus: 'GENERATED',
      fallbackReason: ''
    };
  });
}

export function parseLocalCreativeBatch(value: unknown, inputs: ScoredClipCandidate[]) {
  const candidates = value && typeof value === 'object' &&
    Array.isArray((value as { candidates?: unknown }).candidates)
    ? (value as { candidates: unknown[] }).candidates : [];
  if (candidates.length !== inputs.length) throw new Error('Local response length mismatch');
  return candidates.map((raw, index): ScoredClipCandidate => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Invalid local creative candidate');
    const item = raw as Record<string, unknown>;
    const allowed = new Set(['candidateId', 'hooks', 'title', 'synopsis', 'caption', 'hashtags']);
    if (Object.keys(item).some(field => !allowed.has(field)))
      throw new Error('Local creative candidate contains unexpected fields');
    const input = inputs[index];
    if (!Array.isArray(item.hooks) || item.hooks.length !== 3)
      throw new Error('Local creative output must contain exactly three hooks');
    const baseComponents: HookScoreComponents = { relevance: input.informationScore,
      clarity: input.flowScore, curiosity: input.hookScore,
      payoffAlignment: input.payoffScore, specificity: input.informationScore };
    const invalidComponents = new Set<NonNullable<ScoredClipCandidate['localValidationIssues']>[number]>();
    const hookOptions = item.hooks.map((entry, position): HookOption => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new Error('Invalid local hook');
      const hook = typeof (entry as { text?: unknown }).text === 'string'
        ? normalize((entry as { text: string }).text) : '';
      const style = (entry as { style?: unknown }).style;
      if (typeof style !== 'string' || !HOOK_STRATEGIES.includes(style as HookStrategy))
        throw new Error('Invalid local hook style');
      try {
        if (!isCompleteHook(hook) || hook.length > 180) throw new Error('Local hook is incomplete');
        assertHookTiedToCandidate(hook, input);
      } catch { invalidComponents.add('hooks'); }
      return { hook, strategy: style as HookStrategy, components: baseComponents,
        score: roundScore(calculateGeneratedHookScore(baseComponents) - position * .01) };
    });
    if (new Set(hookOptions.map(item => item.strategy)).size !== 3 ||
      hookOptions.some((item, left) => hookOptions.some((other, right) => left < right &&
        normalizedHookSimilarity(item.hook, other.hook) >= .8))) {
      invalidComponents.add('hooks');
    }
    const title = typeof item.title === 'string' ? normalize(item.title) : '';
    const synopsis = typeof item.synopsis === 'string' ? normalizeSynopsis(item.synopsis) : '';
    const caption = typeof item.caption === 'string' ? normalize(item.caption) : '';
    if (!title || title.length > CONTENT_LIMITS.title) invalidComponents.add('title');
    if (!caption || caption.length > CONTENT_LIMITS.caption) invalidComponents.add('caption');
    if (!synopsis || synopsis.length > CONTENT_LIMITS.synopsis ||
      !synopsisGroundedInClip(synopsis, input)) invalidComponents.add('synopsis');
    for (const [field, text] of [['title', title], ['caption', caption],
      ['synopsis', synopsis]] as const) {
      try {
        assertNoUnsupportedNumbers(text, input, field);
        assertClipSpecificText(text, input, field);
      } catch { invalidComponents.add(field); }
    }
    const captionKey = caption.toLowerCase();
    if ([title, synopsis, ...hookOptions.map(option => option.hook)]
      .some(value => captionKey === value.toLowerCase())) invalidComponents.add('caption');
    if (!Array.isArray(item.hashtags) || item.hashtags.length !== 5)
      throw new Error('Local output must contain exactly five hashtags');
    const hashtags = item.hashtags.map(tag => {
      if (typeof tag !== 'string') throw new Error('Invalid local hashtag');
      const clean = normalize(tag).replace(/^#+/u, '').replace(/[^\p{L}\p{N}_]/gu, '');
      if (!clean || clean.length > 59) throw new Error('Invalid local hashtag');
      return '#' + clean;
    });
    if (new Set(hashtags.map(tag => tag.toLowerCase())).size !== 5 ||
      hashtags.some(tag => /^#(?:viral|fyp)$/iu.test(tag)) ||
      !hashtagsGroundedInClip(hashtags, input))
      invalidComponents.add('hashtags');
    if (invalidComponents.size > 2) {
      throw new Error('Local creative package failed more than two content checks: ' +
        [...invalidComponents].join(', '));
    }
    const fallback = fallbackContent(input);
    return { ...input, sourceHookScore: input.hookScore,
      bestHook: hookOptions[0].hook, alternateHooks: hookOptions.slice(1).map(item => item.hook),
      generatedHookScore: hookOptions[0].score, selectedHookStrategy: hookOptions[0].strategy,
      title, synopsis, caption, hashtags, cta: fallback.cta,
      topic: input.topic || fallback.topic, contentType: fallback.contentType,
      whySelected: fallback.whySelected,
      hooks: hookOptions.map(item => ({ text: item.hook, style: item.strategy, score: item.score })),
      hookOptions, creativeCandidates: { hooks: hookOptions, titles: [title],
        captions: [caption], synopses: [synopsis], hashtags },
      generationStatus: 'GENERATED', fallbackReason: '',
      localValidationIssues: [...invalidComponents] };
  });
}

function completeSentence(value: string) {
  const clean = normalize(value).replace(/(?:\.{3}|…)+$/u, '').replace(/[.!?]+$/u, '');
  return clean ? clean + '.' : '';
}

function boundedSentences(value: string, limit: number, maxSentences = 3) {
  const items = normalize(value).match(/[^.!?]+[.!?]+|[^.!?]+$/gu) ?? [];
  const selected: string[] = [];
  for (const item of items) {
    const complete = completeSentence(item);
    if (!complete) continue;
    if (selected.join(' ').length + complete.length + 1 > limit) break;
    selected.push(complete);
    if (selected.length === maxSentences) break;
  }
  return selected.join(' ');
}

function fallbackTitle(candidate: ScoredClipCandidate) {
  const source = normalize(candidate.topic || candidate.overallVideoTopic || candidate.transcriptText)
    .replace(/(?:\.{3}|…)$/u, '').replace(/[.!?]+$/u, '');
  const title = source.split(/\s+/u).slice(0, 10).join(' ');
  return title || 'Clip insight';
}

function fallbackHashtags(candidate: ScoredClipCandidate, title: string) {
  const weakTagWords = new Set(['remove', 'removes', 'removed', 'make', 'makes',
    'made', 'help', 'helps', 'helped', 'show', 'shows', 'shown', 'explain',
    'explains', 'explained', 'reach', 'reaches', 'reached', 'thing', 'things']);
  const values = [...(candidate.relevantTopics ?? []), title,
    ...[...contentTerms(candidate.transcriptText)].filter(word => !weakTagWords.has(word))]
    .map((value) => words(value).slice(0, 4)
      .map((word) => word.charAt(0).toLocaleUpperCase('en-US') + word.slice(1)).join(''))
    .filter((value) => value.length >= 3);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const tag = '#' + value.slice(0, 40);
    const key = tag.toLocaleLowerCase('en-US');
    if (seen.has(key) || /^#(?:viral|fyp)$/iu.test(tag)) continue;
    seen.add(key);
    unique.push(tag);
    if (unique.length === 5) break;
  }
  const topicWords = words([candidate.topic, title, candidate.transcriptText].filter(Boolean).join(' '))
    .filter(word => word.length >= 3 && !STOP_WORDS.has(word));
  for (let index = 0; unique.length < 5 && index < topicWords.length * topicWords.length; index++) {
    const first = topicWords[index % topicWords.length];
    const second = topicWords[Math.floor(index / topicWords.length) % topicWords.length];
    if (first === second) continue;
    const tag = '#' + [first, second].map(word =>
      word.charAt(0).toLocaleUpperCase('en-US') + word.slice(1)).join('').slice(0, 40);
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    unique.push(tag);
  }
  return unique;
}

function withoutTerminal(value: string) {
  return normalize(value).replace(/[.!?]+$/u, '');
}

function compactSentence(value: string, maxWords = 24) {
  const clean = withoutTerminal(value);
  const compact = clean.split(/\s+/u).slice(0, maxWords).join(' ');
  return completeSentence(compact);
}

function analyzeClip(candidate: ScoredClipCandidate): ClipAnalysis {
  const title = fallbackTitle(candidate);
  const sourceSentences = normalize(candidate.transcriptText)
    .match(/[^.!?]+[.!?]+|[^.!?]+$/gu)?.map(completeSentence).filter(Boolean) ?? [];
  const contextSentences = normalize([
    candidate.chapterSummary ?? '',
    candidate.wholeVideoContext ?? ''
  ].filter(Boolean).join(' ')).match(/[^.!?]+[.!?]+|[^.!?]+$/gu)
    ?.map(completeSentence).filter(Boolean) ?? [];
  const supportingSentences = [...sourceSentences, ...contextSentences];
  const first = sourceSentences[0] ?? completeSentence(title);
  const payoff = [...sourceSentences].reverse().find((sentence) =>
    sentence.length <= 220) ?? first;
  const strongestFact = supportingSentences.find((sentence) => /\b\d/u.test(sentence)) ??
    [...supportingSentences].sort((left, right) =>
      contentTerms(right).size - contentTerms(left).size)[0] ?? first;
  const question = supportingSentences.find((sentence) => /\?/u.test(sentence));
  const problem = supportingSentences.find((sentence) =>
    /\b(?:problem|challenge|risk|hard|difficult|fail|wrong|without)\b/iu.test(sentence));
  const tension = supportingSentences.find((sentence) =>
    /\b(?:but|however|instead|although|yet|versus|while)\b/iu.test(sentence));
  const surprising = supportingSentences.find((sentence) =>
    /\b(?:surpris|unexpected|actually|only|even|despite)\w*\b/iu.test(sentence));
  const emotionalTone = /\b(?:risk|fail|danger|warning|cost|lose|lost)\b/iu
    .test(candidate.transcriptText) ? 'Concerned and cautionary'
    : /\b(?:win|improve|success|better|opportunity|work(?:ed|s)?)\b/iu
      .test(candidate.transcriptText) ? 'Constructive and optimistic'
      : 'Clear and informative';
  const contentType = question ? 'Q&A insight'
    : problem && payoff !== problem ? 'Problem/solution'
      : /\b(?:I|we)\s+(?:saw|tried|built|learned|went)\b/u.test(candidate.transcriptText)
        ? 'Story/lesson' : 'Educational insight';
  return {
    mainTopic: title,
    mainClaim: compactSentence(first),
    strongestFact: compactSentence(strongestFact),
    questionOrProblem: compactSentence(question ?? problem ??
      'The clip examines ' + withoutTerminal(title)),
    tensionOrConflict: compactSentence(tension ?? problem ??
      'The clip separates the issue from its conclusion'),
    surprisingPoint: compactSentence(surprising ?? strongestFact),
    emotionalTone,
    payoffOrConclusion: compactSentence(payoff),
    contentType,
    viewerValue: compactSentence('A clearer understanding of ' + withoutTerminal(title))
  };
}

function fallbackHookOptions(candidate: ScoredClipCandidate, analysis: ClipAnalysis) {
  const title = withoutTerminal(analysis.mainTopic);
  const claim = withoutTerminal(analysis.mainClaim);
  const fact = withoutTerminal(analysis.strongestFact);
  const problem = withoutTerminal(analysis.questionOrProblem);
  const payoff = withoutTerminal(analysis.payoffOrConclusion);
  const baseComponents: HookScoreComponents = {
    relevance: (candidate.informationScore + candidate.standaloneScore) / 2,
    clarity: candidate.flowScore,
    curiosity: candidate.hookScore,
    payoffAlignment: candidate.payoffScore,
    specificity: candidate.informationScore
  };
  const proposals: Array<[HookStrategy, string, Partial<HookScoreComponents>]> = [
    ['strong claim', compactSentence(payoff), { payoffAlignment: candidate.payoffScore + 8 }],
    ['educational/value', compactSentence(title + ': ' + claim),
      { relevance: candidate.informationScore + 6 }],
    ['question', /\?/u.test(candidate.transcriptText)
      ? compactSentence(problem).replace(/\.$/u, '?')
      : compactSentence('What makes ' + title + ' useful in practice').replace(/\.$/u, '?'),
      { curiosity: candidate.hookScore + 8 }],
    ['surprising fact', compactSentence('One detail stands out: ' + fact),
      { specificity: candidate.informationScore + 8 }],
    ['problem/solution', compactSentence(problem) + ' ' + compactSentence(payoff),
      { payoffAlignment: candidate.payoffScore + 6 }],
    ['curiosity', compactSentence('What connects ' + title + ' to this result: ' + payoff),
      { curiosity: candidate.hookScore + 6 }],
    ['stakes/consequence', compactSentence(fact) + ' ' +
      compactSentence('The consequence is ' + payoff), { relevance: candidate.informationScore }],
    ['contradiction', compactSentence(analysis.tensionOrConflict) + ' ' +
      compactSentence(payoff), { curiosity: candidate.hookScore + 4 }]
  ];
  if (/\b\d/u.test(analysis.strongestFact)) {
    proposals.unshift(['supported number/stat', compactSentence(fact),
      {
        relevance: candidate.informationScore + 10,
        curiosity: candidate.hookScore + 8,
        payoffAlignment: candidate.payoffScore + 8,
        specificity: candidate.informationScore + 15
      }]);
  }
  if (/\b(?:warning|risk|danger|avoid|never|don'?t)\b/iu.test(candidate.transcriptText)) {
    proposals.unshift(['warning', compactSentence(fact + ': ' + payoff),
      { relevance: candidate.informationScore + 8 }]);
  }
  const unique = new Map<string, HookOption>();
  for (const [strategy, rawHook, overrides] of proposals) {
    const hook = compactSentence(rawHook, 28).slice(0, 180);
    const key = hook.toLocaleLowerCase('en-US');
    if (!isCompleteHook(hook) || unique.has(key)) continue;
    const components = { ...baseComponents, ...overrides };
    unique.set(key, {
      hook,
      strategy,
      components,
      score: calculateGeneratedHookScore(components)
    });
  }
  const sourceOpening = normalize(candidate.transcriptText)
    .match(/^[^.!?]+[.!?]?/u)?.[0]?.toLocaleLowerCase('en-US') ?? '';
  for (const option of unique.values()) {
    const lower = option.hook.toLocaleLowerCase('en-US');
    if (sourceOpening && (lower === sourceOpening ||
      normalize(candidate.transcriptText).toLocaleLowerCase('en-US').startsWith(lower))) {
      option.score = roundScore(option.score - 30);
    }
  }
  return [...unique.values()].sort((left, right) => right.score - left.score);
}

export function fallbackContent(candidate: ScoredClipCandidate,
  platform: TargetPlatform | null = null): GeneratedContent {
  const analysis = analyzeClip(candidate);
  const title = fallbackTitle(candidate);
  let hookOptions = fallbackHookOptions(candidate, analysis);
  const selected: HookOption[] = [];
  for (const option of hookOptions) {
    if (selected.some((current) => current.strategy === option.strategy ||
      normalizedHookSimilarity(current.hook, option.hook) >= 0.88)) continue;
    selected.push(option);
    if (selected.length === 3) break;
  }
  if (selected.length < 3) {
    for (const option of hookOptions) {
      if (!selected.includes(option)) selected.push(option);
      if (selected.length === 3) break;
    }
  }
  while (selected.length < 3) {
    const index = selected.length;
    const hook = compactSentence([
      analysis.payoffOrConclusion,
      analysis.strongestFact,
      analysis.mainClaim,
      analysis.questionOrProblem
    ][index] + ' ' + title, 26);
    const components: HookScoreComponents = {
      relevance: candidate.informationScore,
      clarity: candidate.flowScore,
      curiosity: candidate.hookScore,
      payoffAlignment: candidate.payoffScore,
      specificity: candidate.informationScore
    };
    selected.push({ hook, strategy: HOOK_STRATEGIES[index], components,
      score: calculateGeneratedHookScore(components) });
  }
  hookOptions = [...selected, ...hookOptions.filter((option) => !selected.includes(option))];
  const sourceSentences = normalize(candidate.transcriptText)
    .match(/[^.!?]+[.!?]+|[^.!?]+$/gu)?.map(completeSentence).filter(Boolean) ?? [];
  const firstPoint = sourceSentences[0] ?? compactSentence(title);
  const middlePoint = sourceSentences[Math.floor((sourceSentences.length - 1) / 2)] ?? firstPoint;
  const lastPoint = sourceSentences[sourceSentences.length - 1] ?? firstPoint;
  const context = withoutTerminal(candidate.overallVideoTopic || candidate.chapterSummary || title);
  const synopsis = sourceSentences.length >= 3 ? [
    compactSentence('The clip discusses ' + withoutTerminal(title) + ': ' + withoutTerminal(firstPoint), 35),
    compactSentence(middlePoint, 35),
    compactSentence(lastPoint, 35)
  ].join('\n\n') : [
    compactSentence('The clip covers ' + withoutTerminal(title) + ' in the context of ' + context, 35),
    compactSentence(firstPoint, 35),
    compactSentence(lastPoint, 35)
  ].join('\n\n');
  // A fallback caption is still specific to this clip: its subject, its own
  // strongest point and its conclusion, phrased for the target surface. Never
  // "watch what happens" filler.
  const captionStyle = packagingFor(platform).captionStyle;
  const caption = captionStyle === 'PUNCHY_CURIOSITY' ?
    compactSentence(analysis.questionOrProblem, 18) + ' ' +
      compactSentence(analysis.payoffOrConclusion, 20) :
    captionStyle === 'CLEAR_SEARCHABLE' ?
      compactSentence(withoutTerminal(title) + ': ' + withoutTerminal(analysis.mainClaim), 26) +
        ' ' + compactSentence(analysis.payoffOrConclusion, 20) :
      compactSentence('A closer look at ' + withoutTerminal(title) +
        ', grounded in the clip\'s concrete point') + ' The conclusion: ' +
        compactSentence(analysis.payoffOrConclusion);
  const cta = analysis.contentType === 'Problem/solution'
    ? 'Which part of this approach would you try first?'
    : analysis.contentType === 'Q&A insight'
      ? 'How would you answer the question before hearing the conclusion?'
      : 'Which detail would be most useful in practice?';
  return {
    bestHook: selected[0].hook,
    alternateHooks: selected.slice(1, 3).map(({ hook }) => hook),
    generatedHookScore: selected[0].score,
    selectedHookStrategy: selected[0].strategy,
    title,
    synopsis,
    caption,
    // The platform's hashtag count is applied once, after the critic has passed
    // the package (see applyPlatformPackaging), so generation and validation keep
    // one contract.
    hashtags: fallbackHashtags(candidate, title),
    cta,
    topic: title,
    contentType: analysis.contentType,
    whySelected: (candidate.whySelected ? candidate.whySelected + '; ' : '') +
      'Selected from the supplied transcript with standalone ' +
      roundScore(candidate.standaloneScore) + ', information ' +
      roundScore(candidate.informationScore) + ', and payoff ' +
      roundScore(candidate.payoffScore) + '.',
    hooks: selected.map(({ hook, strategy, score }) => ({
      text: hook,
      style: strategy,
      score: roundScore(score)
    })),
    hookOptions,
    creativeCandidates: {
      hooks: hookOptions,
      captions: [caption, compactSentence(analysis.viewerValue), compactSentence(analysis.mainClaim)],
      titles: [title, withoutTerminal(analysis.mainClaim),
        withoutTerminal(analysis.payoffOrConclusion)],
      hashtags: fallbackHashtags(candidate, title),
      synopses: [synopsis]
    }
  };
}

/**
 * Platform packaging applied to a finished, critic-approved package: the
 * hashtag set is resized to what the surface actually rewards, an over-long
 * caption is cut back at a sentence boundary, and the packaging decisions are
 * recorded so analytics can correlate them with performance later. No text is
 * rewritten here - nothing may change what the package claims.
 */
export function applyPlatformPackaging(candidate: ScoredClipCandidate,
  platform: TargetPlatform | null): ScoredClipCandidate {
  const packaging = packagingFor(platform);
  const pools = (candidate.creativeCandidates ?? {}) as Record<string, unknown>;
  const pool = Array.isArray(pools.hashtags) ? pools.hashtags.filter((tag): tag is string =>
    typeof tag === 'string') : [];
  const hashtags = adaptHashtagsForPlatform(platform, candidate.hashtags ?? [], pool,
    `${candidate.transcriptText} ${candidate.title ?? ''} ${candidate.topic ?? ''}`);
  let caption = normalize(candidate.caption ?? '');
  if (caption.length > packaging.captionChars.max)
    caption = boundedSentences(caption, packaging.captionChars.max, 4) ||
      caption.slice(0, packaging.captionChars.max).replace(/\s+\S*$/u, '');
  const delivered = hashtags.length ? hashtags : candidate.hashtags ?? [];
  return { ...candidate, caption: caption || candidate.caption,
    hashtags: hashtags.length ? hashtags : candidate.hashtags,
    creativeCandidates: { ...pools,
      packaging: { ...packagingTelemetry(platform, delivered),
        ...packageConsistency({ transcript: candidate.transcriptText,
          hook: candidate.bestHook, caption: caption || candidate.caption,
          synopsis: candidate.synopsis, hashtags: delivered }) } } };
}

function inferHookStrategy(hook: string): HookStrategy {
  if (/\b\d/u.test(hook)) return 'supported number/stat';
  if (/\?/u.test(hook)) return 'question';
  if (/\b(?:but|however|instead|yet)\b/iu.test(hook)) return 'contradiction';
  if (/\b(?:warning|risk|avoid|never|don'?t)\b/iu.test(hook)) return 'warning';
  return 'educational/value';
}

export function ensureSameVideoHookDiversity(candidates: ScoredClipCandidate[]) {
  const used: string[] = [];
  const diversified = [...candidates].sort((left, right) =>
    right.overallScore - left.overallScore || left.startTime - right.startTime)
    .map((candidate) => {
      if (candidate.reject || !candidate.bestHook) return candidate;
      if (!used.some((hook) => normalizedHookSimilarity(hook, candidate.bestHook!) >= 0.72)) {
        used.push(candidate.bestHook);
        return candidate;
      }
      const fallback = fallbackContent(candidate);
      const options = (candidate.hookOptions ?? [
        candidate.bestHook,
        ...(candidate.alternateHooks ?? []),
        ...fallback.hookOptions.map(({ hook }) => hook)
      ].map((hook, index) => ({
        hook,
        strategy: index === 0
          ? candidate.selectedHookStrategy ?? inferHookStrategy(hook)
          : inferHookStrategy(hook),
        components: {
          relevance: candidate.informationScore,
          clarity: candidate.flowScore,
          curiosity: candidate.hookScore,
          payoffAlignment: candidate.payoffScore,
          specificity: candidate.informationScore
        },
        score: index === 0 ? candidate.generatedHookScore ?? 0
          : calculateGeneratedHookScore({
            relevance: candidate.informationScore,
            clarity: candidate.flowScore,
            curiosity: candidate.hookScore,
            payoffAlignment: candidate.payoffScore,
            specificity: candidate.informationScore
          })
      }))) as HookOption[];
      const replacement = options.find((option) =>
        !used.some((hook) => normalizedHookSimilarity(hook, option.hook) >= 0.72));
      if (!replacement) {
        used.push(candidate.bestHook);
        return candidate;
      }
      const packaged: HookOption[] = [];
      for (const option of [replacement, ...options]) {
        if (packaged.some((current) => current.hook === option.hook ||
          current.strategy === option.strategy ||
          normalizedHookSimilarity(current.hook, option.hook) >= 0.8)) continue;
        packaged.push(option);
        if (packaged.length === 3) break;
      }
      if (packaged.length !== 3) {
        used.push(candidate.bestHook);
        return candidate;
      }
      const alternates = packaged.slice(1).map(({ hook }) => hook);
      const hooks = packaged.map(({ hook: text, strategy: style, score }) => ({
        text,
        style,
        score: roundScore(score)
      }));
      used.push(replacement.hook);
      return {
        ...candidate,
        bestHook: replacement.hook,
        alternateHooks: alternates,
        hooks,
        generatedHookScore: replacement.score,
        selectedHookStrategy: replacement.strategy
      };
    });
  const byRange = new Map(diversified.map((candidate) => [candidate.rangeKey, candidate]));
  return candidates.map((candidate) => byRange.get(candidate.rangeKey) ?? candidate);
}

export function buildContentFingerprint(candidate: ScoredClipCandidate,
  platform: TargetPlatform | null = null) {
  return createHash('sha256').update(JSON.stringify({
    promptVersion: CLIP_CONTENT_PROMPT_VERSION,
    // Packaging is platform-specific, so a package generated for one surface is
    // never silently reused for another.
    platform,
    transcriptText: normalize(candidate.transcriptText),
    chapterSummary: normalize(candidate.chapterSummary ?? ''),
    overallVideoTopic: normalize(candidate.overallVideoTopic ?? ''),
    relevantTopics: candidate.relevantTopics ?? [],
    previousTranscriptContext: normalize(candidate.previousTranscriptContext ?? ''),
    nextTranscriptContext: normalize(candidate.nextTranscriptContext ?? ''),
    wholeVideoContext: normalize(candidate.wholeVideoContext ?? ''),
    evidence: candidate.evidence ?? {},
    clipUnderstanding: candidate.clipUnderstanding ?? {},
    scores: SCORE_FIELDS.map((field) => roundScore(candidate[field])),
    heuristicScore: roundScore(candidate.heuristicScore)
  })).digest('hex');
}

export function canReuseGeneratedContent(
  candidate: ScoredClipCandidate,
  cached: {
    generationStatus: string;
    bestHook: string;
    alternateHooks?: string[];
    hooks?: unknown;
    selectedHookStrategy?: string;
    title?: string;
    synopsis?: string;
    caption?: string;
    hashtags?: string[];
    cta?: string;
    topic?: string;
    contentType?: string;
    whySelected?: string;
    provider?: string;
    model?: string;
    creativeCandidates?: unknown;
    contentFingerprint: string;
    promptVersion: string;
  } | null | undefined
) {
  const hooks = Array.isArray(cached?.hooks) ? cached.hooks : [];
  const completeHooks = hooks.length === 3 && hooks.every((hook) =>
    !!hook && typeof hook === 'object' &&
    typeof (hook as Record<string, unknown>).text === 'string' &&
    !!normalize((hook as Record<string, unknown>).text as string) &&
    typeof (hook as Record<string, unknown>).style === 'string' &&
    typeof (hook as Record<string, unknown>).score === 'number') &&
    new Set(hooks.map((hook) => (hook as Record<string, unknown>).style)).size === 3;
  const pools = cached?.creativeCandidates && typeof cached.creativeCandidates === 'object'
    ? cached.creativeCandidates as Record<string, unknown> : {};
  const completePools = Array.isArray(pools.hooks) && pools.hooks.length >= 3 &&
    Array.isArray(pools.captions) && pools.captions.length >= 1 &&
    Array.isArray(pools.titles) && pools.titles.length >= 1 &&
    Array.isArray(pools.hashtags) && pools.hashtags.length >= 2 &&
    Array.isArray(pools.synopses) && pools.synopses.length >= 1;
  return !!cached && cached.generationStatus === 'GENERATED' && !!cached.bestHook &&
    cached.alternateHooks?.length === 2 && completeHooks && completePools &&
    !!cached.selectedHookStrategy &&
    !!cached.title && !!cached.synopsis && !!cached.caption &&
    // The hashtag count is platform-dependent now (a YouTube Shorts package
    // deliberately carries fewer), so completeness is a floor, not an exact count.
    !!cached.hashtags && cached.hashtags.length >= 2 && cached.hashtags.length <= 8 &&
    hasThreeUsefulSynopsisParagraphs(cached.synopsis) &&
    typeof cached.cta === 'string' && !!cached.topic && !!cached.contentType &&
    !!cached.whySelected && !!cached.provider && !!cached.model &&
    cached.promptVersion === CLIP_CONTENT_PROMPT_VERSION &&
    cached.contentFingerprint === (candidate.contentFingerprint ??
      buildContentFingerprint(candidate));
}

function failureReason(error: unknown) {
  if (error instanceof LlmProviderError) return error.kind + ': ' + error.message;
  return 'SCHEMA_FAILURE: ' + (error instanceof Error ? error.message :
    'Structured generation response failed validation');
}

@Injectable()
export class ClipJudgeService {
  private readonly logger = new Logger(ClipJudgeService.name);
  private readonly successfulByFingerprint = new Map<string, ScoredClipCandidate>();
  private readonly llmRouter: LlmRouterService;

  constructor(@Inject(LlmRouterService) routerOrLegacyProvider: LlmRouterService | {
    providerName: string;
    modelName: string;
    isConfigured(): boolean;
    generateStructured?<T>(request: unknown): Promise<T>;
  } = new LlmRouterService()) {
    if ('isAnyConfigured' in routerOrLegacyProvider) {
      this.llmRouter = routerOrLegacyProvider;
    } else {
      const legacy = routerOrLegacyProvider;
      this.llmRouter = {
        isAnyConfigured: () => legacy.isConfigured(),
        routesFor: () => [{ provider: legacy.providerName, model: legacy.modelName }],
        configuredRouteFor: () => ({ provider: legacy.providerName, model: legacy.modelName }),
        generate: async <T>(input: { request: unknown }) => ({
          data: await legacy.generateStructured!<T>(input.request),
          metadata: { role: 'creativeGeneration' as const, provider: legacy.providerName,
            model: legacy.modelName, failover: false, cacheHit: false, attempts: [] }
        })
      } as unknown as LlmRouterService;
    }
  }

  async judgeCandidates(candidates: ScoredClipCandidate[],
    onProgress?: (completed: number, total: number) => Promise<void>,
    targetPlatform: TargetPlatform | null = null): Promise<ScoredClipCandidate[]> {
    const prepared = candidates.map((candidate) => ({
      ...candidate,
      contentFingerprint: candidate.contentFingerprint ??
        buildContentFingerprint(candidate, targetPlatform)
    }));
    const results = new Map<string, ScoredClipCandidate>();
    const usable: ScoredClipCandidate[] = [];
    const modeCachePrefix = currentAiProcessingMode() + ':' + (targetPlatform ?? 'ANY') + ':';
    for (const candidate of prepared) {
      const cached = this.successfulByFingerprint.get(
        modeCachePrefix + candidate.contentFingerprint!);
      if (cached) {
        results.set(candidate.rangeKey, {
          ...candidate,
          ...cached,
          rangeKey: candidate.rangeKey,
          videoId: candidate.videoId,
          startTime: candidate.startTime,
          endTime: candidate.endTime,
          duration: candidate.duration,
          transcriptText: candidate.transcriptText,
          heuristicScore: candidate.heuristicScore,
          rank: candidate.rank,
          chapterSummary: candidate.chapterSummary,
          overallVideoTopic: candidate.overallVideoTopic,
          wholeVideoContext: candidate.wholeVideoContext,
          relevantTopics: candidate.relevantTopics,
          previousTranscriptContext: candidate.previousTranscriptContext,
          nextTranscriptContext: candidate.nextTranscriptContext,
          contentFingerprint: candidate.contentFingerprint
        });
      } else if (normalize(candidate.transcriptText)) usable.push(candidate);
      else {
        const reason = 'EMPTY_INPUT: Candidate transcript is empty';
        this.logFallback(reason);
        results.set(candidate.rangeKey, this.withFallback(candidate, reason));
      }
    }
    if (!this.llmRouter.isAnyConfigured('creativeGeneration')) {
      const reason = currentAiProcessingMode() === 'FALLBACK_ONLY'
        ? 'AI_MODE_FALLBACK_ONLY: Generative model routing is disabled'
        : 'CONFIGURATION_FAILURE: No creative-generation model is configured';
      this.logFallback(reason);
      usable.forEach((candidate) => results.set(candidate.rangeKey,
        this.withFallback(candidate, reason, targetPlatform)));
      return ensureSameVideoHookDiversity(
        prepared.map((candidate) => results.get(candidate.rangeKey)!));
    }

    // Batching several final packages per request cuts creativeGeneration call count roughly
    // proportionally; OFFLINE/local generation keeps one package per request (matches its
    // existing concurrency-1 default and avoids growing an already-slower local completion).
    const configuredBatchSize = Number(process.env.CLIP_JUDGE_BATCH_SIZE ?? 2);
    const batchSize = currentAiProcessingMode() === 'OFFLINE' ? 1 :
      Number.isFinite(configuredBatchSize) ? Math.max(1, Math.min(3, Math.floor(configuredBatchSize))) : 2;
    const batches = Array.from({ length: Math.ceil(usable.length / batchSize) }, (_, index) =>
      usable.slice(index * batchSize, index * batchSize + batchSize));
    const configuredConcurrency = Number(process.env.CLIP_JUDGE_CONCURRENCY ?? 1);
    const concurrency = Number.isFinite(configuredConcurrency)
      ? Math.max(1, Math.min(4, Math.floor(configuredConcurrency))) : 1;
    let nextBatch = 0;
    let completed = 0;
    const worker = async () => {
      while (nextBatch < batches.length) {
        const batch = batches[nextBatch++];
        try {
          const { candidates: generated, metadata } = await this.scoreBatch(batch, targetPlatform);
          const judgeSource = metadata.provider === 'openai' &&
            metadata.model === CLIP_JUDGE_MODEL ? 'GPT_5_4_MINI' as const : 'LLM' as const;
          generated.forEach((candidate) => {
            if (candidate.generationStatus === 'FALLBACK') {
              results.set(candidate.rangeKey, candidate); return;
            }
            const complete: ScoredClipCandidate = {
              ...candidate,
              judgeSource,
              provider: metadata.provider,
              model: metadata.model,
              providerMetadata: [...(candidate.providerMetadata || []),
                metadata as unknown as Record<string, unknown>],
              generationMode: processingModeFor([...(candidate.providerMetadata || []),
                metadata as unknown as Record<string, unknown>], true),
              fallbackUsed: false,
              promptVersion: CLIP_CONTENT_PROMPT_VERSION
            };
            results.set(candidate.rangeKey, complete);
            if (!complete.localValidationIssues?.length)
              this.successfulByFingerprint.set(
                modeCachePrefix + candidate.contentFingerprint!, complete);
          });
        } catch (error) {
          const reason = failureReason(error);
          this.logFallback(reason);
          batch.forEach((candidate) => results.set(candidate.rangeKey,
            this.withFallback(candidate, reason, targetPlatform)));
        }
        completed += batch.length;
        if (onProgress) await onProgress(completed, usable.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
    if (this.successfulByFingerprint.size > 500) {
      this.successfulByFingerprint.delete(
        this.successfulByFingerprint.keys().next().value as string);
    }
    return ensureSameVideoHookDiversity(
      prepared.map((candidate) => results.get(candidate.rangeKey)!));
  }

  private withFallback(candidate: ScoredClipCandidate, reason: string,
    targetPlatform: TargetPlatform | null = null): ScoredClipCandidate {
    const route = this.llmRouter.configuredRouteFor('creativeGeneration') ??
      this.llmRouter.routesFor('creativeGeneration')[0];
    return {
      ...candidate,
      ...fallbackContent(candidate, targetPlatform),
      sourceHookScore: candidate.hookScore,
      provider: route?.provider || 'unconfigured',
      model: route?.model || 'unconfigured',
      promptVersion: CLIP_CONTENT_PROMPT_VERSION,
      generationStatus: 'FALLBACK',
      fallbackReason: reason,
      generationMode: 'DETERMINISTIC_FALLBACK',
      fallbackUsed: true,
      failureCategory: reason.split(':')[0],
      judgeSource: 'HEURISTIC_FALLBACK'
    };
  }

  private logFallback(reason: string) {
    const route = this.llmRouter.configuredRouteFor('creativeGeneration') ??
      this.llmRouter.routesFor('creativeGeneration')[0];
    this.logger.warn('Clip content fallback provider=' +
      cleanForLog(route?.provider || 'unconfigured') + ' model=' +
      cleanForLog(route?.model || 'unconfigured') + ' reason=' +
      cleanForLog(reason));
  }

  private async scoreBatch(candidates: ScoredClipCandidate[],
    targetPlatform: TargetPlatform | null = null) {
    const batched = candidates.length > 1;
    const schema = batched ? batchedClipContentPackageSchema(candidates.length)
      : LOCAL_CLIP_CONTENT_PACKAGE_SCHEMA;
    const systemPrompt = creativeSystemPrompt(batched, targetPlatform);
    const userPrompt = JSON.stringify(candidates.map((candidate) =>
      localCreativeInput(candidate, targetPlatform)));
    const result = await this.llmRouter.generate<unknown>({
      role: 'creativeGeneration',
      request: {
      schemaName: batched ? 'clip_candidate_content_package_batch' : 'clip_candidate_content_package',
      schema, partialBatchField: 'candidates', systemPrompt, userPrompt,
      maxOutputTokens: Math.min(7000, 2600 * candidates.length),
      options: { temperature: 0.75 },
      cacheKey: candidates.map((candidate) => candidate.contentFingerprint ??
        buildContentFingerprint(candidate, targetPlatform)).join(':'),
      local: {
        schemaName: batched ? 'local_clip_content_package_batch' : 'local_clip_content_package',
        schema, partialBatchField: 'candidates',
        maxOutputTokens: Math.min(8000, 3000 * candidates.length),
        systemPrompt, userPrompt
      }
      }
    });
    const rawItems = (result.data as { candidates?: unknown[] })?.candidates;
    const items = alignBatchItemsById(rawItems, candidates);
    return { candidates: candidates.map((candidate, index) => {
      try {
        if (!Array.isArray(items) || items.length !== candidates.length)
          throw new Error('Expected ' + candidates.length + ' identified package(s); received ' + (items?.length ?? 0));
        return parseLocalCreativeBatch({ candidates: [items[index]] }, [candidate])[0];
      } catch (error) {
        countPerformance('schemaRepairCount');
        const reason = failureReason(error); this.logFallback(reason);
        return this.withFallback(candidate, reason, targetPlatform);
      }
    }), metadata: result.metadata };
  }
}

function localCreativeInput(candidate: ScoredClipCandidate,
  targetPlatform: TargetPlatform | null = null) {
  const evidence = (candidate.evidence || {}) as Record<string, unknown>;
  const array = (name: string, maximum: number) => Array.isArray(evidence[name])
    ? (evidence[name] as unknown[]).slice(0, maximum) : [];
  const packaging = packagingFor(targetPlatform);
  return { candidateId: candidate.rangeKey, exactClipTranscript: candidate.transcriptText,
    targetPlatform: targetPlatform ?? null,
    captionStyle: packaging.captionStyle,
    captionLengthGuide: packaging.captionChars.target,
    hashtagCountGuide: packaging.hashtags,
    clipTiming: [candidate.startTime, candidate.endTime],
    previousNearbyContext: (candidate.previousTranscriptContext || '').slice(0, 240),
    nextNearbyContext: (candidate.nextTranscriptContext || '').slice(0, 240),
    chapterSummary: (candidate.chapterSummary || '').slice(0, 360),
    overallTopic: (candidate.overallVideoTopic || '').slice(0, 120),
    deterministicMetrics: { hook: candidate.hookScore, standalone: candidate.standaloneScore,
      payoff: candidate.payoffScore, flow: candidate.flowScore,
      information: candidate.informationScore, retention: candidate.retentionScore,
      shareability: candidate.shareabilityScore, speech: evidence.speechSignals || {},
      visual: Array.isArray(evidence.visualSignals) && evidence.visualSignals.length
        ? evidence.candidateVisualEvidence || null : null,
      visualMoments: array('importantMoments', 3) },
    supportedFacts: array('supportedFacts', 5) };
}

// Backward-compatible export for existing scripts and integrations.
export class OpenAiClipJudgeService extends ClipJudgeService {}
