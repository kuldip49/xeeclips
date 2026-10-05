// Step 9-11: the natural-language creative brief.
//
// A brief carries two different things and they are kept apart:
//
//   CONTENT INTENT  what deserves clipping ("funny moments", "only the AI and
//                   jobs discussion", "controversial statements, keep context")
//                   -> drives candidate SELECTION (intent-aware ranking)
//   STYLE HINTS     how to edit it ("yellow captions", "no zooms", "warm")
//                   -> the INSTRUCTION layer of the style resolver
//
// OpenAI interprets it when available (any language, vague wording). The
// deterministic parser below is the honest fallback for plain English and
// common Hinglish; it never pretends to understand what it does not.

import type { Logger } from '@nestjs/common';
import type { LlmRouterService } from '../../processing/llm-router.service';
import { createPerformanceTelemetry, performanceContext } from '../../processing/performance-telemetry';
import { aiAvailable, aiUnavailable, classifyAiFailure, type AiAvailability } from '../../ai/ai-availability';
import { COMPONENT_STYLES, FULL_TEMPLATES, STYLE_CATEGORIES,
  type StyleCategory } from './creative-style-library';
import type { StyleChoice } from './creative-style-resolver';

export const CONTENT_MODES = ['FUNNY', 'EDUCATIONAL', 'CONTROVERSIAL', 'EMOTIONAL', 'INSPIRING',
  'STORY', 'ADVICE', 'SURPRISING', 'DRAMATIC'] as const;
export type ContentMode = typeof CONTENT_MODES[number];

export type ContentIntent = {
  modes: ContentMode[];
  /** Topic phrases the user asked for (lower-case). */
  topics: string[];
  /** When true ("only X"), candidates that do not match are excluded, not just demoted. */
  strict: boolean;
  /**
   * "only the serious explanations" / "just funny moments": the restriction is on the KIND of
   * moment. Moments with no evidence of it are excluded - unless that would exclude every
   * candidate, because mode evidence is a fuzzy lexical signal and must never zero out delivery.
   */
  strictModes?: boolean;
  exclude: string[];
  keepFullContext: boolean;
};

export type InterpretedBrief = {
  brief: string;
  intent: ContentIntent;
  styleHints: Partial<Record<StyleCategory, StyleChoice>>;
  /** A template the brief names ("podcast style"): applied at TEMPLATE priority. */
  templateHint: string | null;
  source: 'OPENAI' | 'DETERMINISTIC' | 'EMPTY';
  ai: AiAvailability;
};

export const EMPTY_INTENT: ContentIntent = { modes: [], topics: [], strict: false, exclude: [],
  keepFullContext: false };

const MODE_WORDS: Record<ContentMode, RegExp> = {
  FUNNY: /\b(?:funn(?:y|iest)|humou?r(?:ous)?|hilarious|jokes?|laugh(?:s|ing|ter)?|comed(?:y|ic)|mazedar|mazaak)\b/u,
  EDUCATIONAL: /\b(?:educational|explain(?:s|ed|ers?|ing)?|explanations?|learn(?:ing)?|teach(?:es|ing)?|tutorial|lessons?|tips?|how[- ]to|insights?)\b/u,
  CONTROVERSIAL: /\b(?:controversial|hot takes?|debat(?:e|able)|disagree(?:ment)?|provocative|spicy|polari[sz]ing|bold claims?)\b/u,
  EMOTIONAL: /\b(?:emotional|heartfelt|touching|moving|vulnerable|sad)\b/u,
  INSPIRING: /\b(?:inspir(?:ing|ational)|motivat(?:ing|ional)|uplifting)\b/u,
  STORY: /\b(?:stor(?:y|ies)|anecdotes?|narrative)\b/u,
  ADVICE: /\b(?:advice|recommendations?|practical|actionable|lessons learned)\b/u,
  SURPRISING: /\b(?:surpris(?:ing|es)|shocking|unexpected|mind[- ]blowing|wow)\b/u,
  DRAMATIC: /\b(?:dramatic|intense|heated|conflict)\b/u
};

// Words that describe HOW a moment feels or how good it is, never WHAT it is
// about: "only the serious explanations" asks for a kind of moment, not a topic.
const DESCRIPTORS = /\b(?:the|a|an|only|just|please|best|good|great|top|key|main|important|interesting|serious|light|short|long|strong|most|more|some|all|moments?|parts?|clips?|bits?|stuff|things?|sections?|segments?)\b/gu;
const EDIT_INSTRUCTION = /^(?:make|add|use|keep|put|remove|set|change|turn|move|apply|do|give it)\b|\b(?:captions?|subtitles?|zooms?|colou?rs?|music|hook|logo|fonts?|cleaner|look|style|crop|framing|volume|transitions?|cinematic|brighter|darker)\b/u;
const stripModeWords =(value: string) => Object.values(MODE_WORDS).reduce((text, pattern) =>
  text.replace(new RegExp(pattern.source, 'gu'), ' '), value);

const COLOR_HINTS: Array<[RegExp, string]> = [
  [/\b(?:cinematic)\b/u, 'COLOR_CINEMATIC'], [/\b(?:warm(?:er)?)\b/u, 'COLOR_WARM'],
  [/\b(?:cool(?:er)?|cold)\b/u, 'COLOR_COOL'], [/\b(?:vibrant|colou?rful|punchy colou?rs?)\b/u, 'COLOR_VIBRANT'],
  [/\b(?:black and white|b&w|monochrome|grayscale|greyscale)\b/u, 'COLOR_BW'],
  [/\b(?:vintage|retro)\b/u, 'COLOR_VINTAGE'], [/\b(?:muted|desaturated)\b/u, 'COLOR_MUTED'],
  [/\b(?:filmic|film look)\b/u, 'COLOR_FILMIC'], [/\b(?:luxury|luxurious|premium)\b/u, 'COLOR_LUXURY'],
  [/\b(?:dark|moody|dramatic look)\b/u, 'COLOR_DARK_DRAMATIC']
];
const NAMED_COLORS: Record<string, string> = { yellow: '#FFD400', white: '#FFFFFF', black: '#000000',
  red: '#FF3B30', blue: '#2F80FF', green: '#34C759', orange: '#FF9500', pink: '#FF2D95',
  purple: '#AF52DE', gold: '#FFC83D', cyan: '#22D3EE' };
const COLOR_WORD = Object.keys(NAMED_COLORS).join('|');

/** Deterministic interpretation (English + a little Hinglish). */
export function interpretBriefDeterministic(briefValue: string): Omit<InterpretedBrief, 'ai'> {
  const brief = briefValue.trim().slice(0, 1500);
  if (!brief) return { brief, intent: { ...EMPTY_INTENT }, styleHints: {}, templateHint: null,
    source: 'EMPTY' };
  const text = brief.toLowerCase().replace(/\bsirf\b/gu, 'only').replace(/\bwale\b/gu, '');
  const modes = CONTENT_MODES.filter((mode) => MODE_WORDS[mode].test(text));
  const strict = /\b(?:only|just|exclusively|nothing but)\b/u.test(text);
  const keepFullContext = /\b(?:full|whole|complete) context\b|\bkeep (?:the )?context\b|\bdon'?t cut (?:them )?off\b/u.test(text);
  // Topic phrases: "about X", "on X", "only X", "focus on X", "discussion of X", "where they talk about X".
  const topics = new Set<string>();
  // "only" / "just" express RESTRICTION (captured in `strict` above), never topic content.
  const topicPattern = /\b(?:about|regarding|on the topic of|focus(?:ed|ing)? on|only|just|discussion (?:of|about|on)|talk(?:s|ing)? about|mentions? of)\s+(?:the\s+)?([a-z0-9][a-z0-9 &'\-+]{1,60}?)(?=$|[,.;!?]|\s+(?:and keep|but|with|in|for|where|that|which|moments?|parts?|clips?|segments?)\b)/gu;
  for (const match of text.matchAll(topicPattern)) {
    // "only the part about hiring" -> the subject is what follows the last "about/regarding/on/of".
    const subject = match[1].replace(/^.*\b(?:about|regarding|on|of)\s+(?:the\s+)?/u, '');
    // "just make it cleaner" is an EDITING instruction, not something to find in the source.
    if (EDIT_INSTRUCTION.test(subject)) continue;
    for (const piece of subject.split(/\s+(?:and|or|&|aur)\s+/u)) {
      const topic = stripModeWords(piece).replace(DESCRIPTORS, ' ').replace(/\s{2,}/gu, ' ').trim();
      if (topic.length >= 2 && !/^(?:it|this|that|them|ones?|discussion)$/u.test(topic)) topics.add(topic);
    }
  }
  const exclude = [...text.matchAll(/\b(?:no|avoid|skip|without|exclude|not about)\s+([a-z][a-z ]{2,30}?)(?=$|[,.;!?]|\s+(?:and|but)\b)/gu)]
    .map((match) => match[1].trim())
    .filter((value) => !/\b(?:zoom|zooms|caption|captions|subtitles?|music|hook|logo|colou?r|filter|motion)\b/u.test(value));

  // --- style hints -------------------------------------------------------------
  const hints: Partial<Record<StyleCategory, StyleChoice>> = {};
  const captionColor = new RegExp(`\\b(${COLOR_WORD})\\s+(?:captions?|subtitles?)\\b|\\b(?:captions?|subtitles?)\\s+(?:in\\s+)?(${COLOR_WORD})\\b`, 'u').exec(text);
  const activeColor = new RegExp(`\\b(${COLOR_WORD})\\s+(?:active|highlight(?:ed)?)\\s*words?\\b`, 'u').exec(text);
  if (/\bno (?:captions|subtitles)\b|\bwithout (?:captions|subtitles)\b/u.test(text)) hints.CAPTIONS = { styleId: 'CAP_NONE' };
  else if (captionColor || activeColor) {
    const overrides: Record<string, unknown> = {};
    const color = captionColor?.[1] ?? captionColor?.[2];
    if (color && color !== activeColor?.[1]) overrides.color = NAMED_COLORS[color];
    if (activeColor) { overrides.activeWord = true; overrides.activeWordColor = NAMED_COLORS[activeColor[1]]; }
    hints.CAPTIONS = { overrides };
  } else if (/\b(?:big(?:ger)?|large) captions\b/u.test(text)) hints.CAPTIONS = { styleId: 'CAP_LARGE_READABLE' };
  else if (/\b(?:simple|clean|normal) captions?\b|\bcaptions? (?:lower|low)\b/u.test(text)) {
    hints.CAPTIONS = { styleId: 'CAP_CLEAN_LOWER_THIRD',
      ...(/\bcaptions? (?:lower|low)\b/u.test(text) ? { overrides: { y: 0.74 } } : {}) };
  }
  else if (/\b(?:small(?:er)?|minimal|subtle) captions\b/u.test(text)) hints.CAPTIONS = { styleId: 'CAP_MINIMAL_WHITE' };
  if (/\bno (?:zooms?|zooming|motion)\b|\bwithout (?:zooms?|zooming)\b|\bstatic\b/u.test(text)) hints.ZOOM = { styleId: 'ZOOM_NONE' };
  else if (/\b(?:subtle|gentle|light) zooms?\b/u.test(text)) hints.ZOOM = { styleId: 'ZOOM_SUBTLE' };
  else if (/\b(?:strong|punchy|lots of|energetic) zooms?\b/u.test(text)) hints.ZOOM = { styleId: 'ZOOM_STRONG' };
  if (/\bno hook\b|\bwithout (?:a )?hook\b/u.test(text)) hints.HOOK = { styleId: 'HOOK_NONE' };
  else if (/\bquestion hooks?\b|\bhook as a question\b/u.test(text)) hints.HOOK = { styleId: 'HOOK_BOLD_QUESTION' };
  else if (/\b(?:clean|normal|simple|minimal|restrained)(?:\s+(?:clean|normal|simple|minimal|restrained))* hooks?\b/u.test(text)) hints.HOOK = { styleId: 'HOOK_CLEAN' };
  if (/\bblack background\b|\bbackground black\b|\bon black\b/u.test(text)) hints.BACKGROUND = { styleId: 'BG_BLACK' };
  else if (/\bblur(?:red)? background\b/u.test(text)) hints.BACKGROUND = { styleId: 'BG_BLURRED' };
  else if (/\bwhite background\b/u.test(text)) hints.BACKGROUND = { styleId: 'BG_WHITE' };
  if (/\bno music\b|\bvoice only\b|\bwithout music\b/u.test(text)) hints.AUDIO = { styleId: 'AUDIO_VOICE_ONLY' };
  if (/\bface|speaker\b.*\bframe|\bkeep (?:the )?face/u.test(text)) hints.FRAMING = { styleId: 'FRAME_FACE_PRIORITY' };
  if (/\b(?:don'?t|do not) over[- ]?edit\b|\brestrained\b/u.test(text)) {
    hints.ZOOM = { styleId: 'ZOOM_NONE' };
    hints.COLOR ??= { styleId: 'COLOR_CLEAN' };
  }
  if (/\bprofessional\b/u.test(text)) hints.FRAMING ??= { styleId: 'FRAME_FACE_PRIORITY' };
  // Unambiguous look words count anywhere; ambiguous ones ("cool", "dark",
  // "warm", "premium") only when the brief is talking about the look, so "a
  // cool story" never recolours the clip.
  const talksAboutLook = /\b(?:look|colou?rs?|grade|grading|tone|tones|vibe|feel|filter|lighting)\b/u.test(text);
  for (const [pattern, id] of COLOR_HINTS) {
    const unambiguous = ['COLOR_CINEMATIC', 'COLOR_BW', 'COLOR_VINTAGE', 'COLOR_FILMIC'].includes(id);
    if (pattern.test(text) && (unambiguous || talksAboutLook)) { hints.COLOR = { styleId: id }; break; }
  }

  const templateHint = FULL_TEMPLATES.find((template) => {
    const name = template.name.toLowerCase().replace(/[^a-z ]/gu, ' ').split(/\s+/u)[0];
    return new RegExp(`\\b${name}(?:\\s+(?:pro|style|template|look))\\b`, 'u').test(text);
  })?.id ?? null;
  return { brief, intent: { modes, topics: [...topics].slice(0, 8), strict: strict && topics.size > 0,
    strictModes: strict && topics.size === 0 && modes.length > 0,
    exclude: exclude.slice(0, 6), keepFullContext }, styleHints: hints, templateHint,
  source: 'DETERMINISTIC' };
}

const BRIEF_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    modes: { type: 'array', maxItems: 4, items: { type: 'string', enum: [...CONTENT_MODES] } },
    topics: { type: 'array', maxItems: 8, items: { type: 'string' } },
    strict: { type: 'boolean' },
    exclude: { type: 'array', maxItems: 6, items: { type: 'string' } },
    keepFullContext: { type: 'boolean' },
    styles: { type: 'array', maxItems: 9, items: { type: 'object', additionalProperties: false,
      properties: { category: { type: 'string', enum: [...STYLE_CATEGORIES] },
        styleId: { type: 'string', enum: COMPONENT_STYLES.map((style) => style.id) } },
      required: ['category', 'styleId'] } },
    templateId: { type: ['string', 'null'] }
  },
  required: ['modes', 'topics', 'strict', 'exclude', 'keepFullContext', 'styles', 'templateId']
} as const;

/** OpenAI when available (any language, vague wording); deterministic otherwise. */
export async function interpretBrief(input: { brief: string; llm?: LlmRouterService | null;
  logger?: Logger; aiMode?: string }): Promise<InterpretedBrief> {
  const local = interpretBriefDeterministic(input.brief);
  if (local.source === 'EMPTY' || !input.llm) {
    return { ...local, ai: input.llm ? aiAvailable() : aiUnavailable('NOT_REQUESTED') };
  }
  const telemetry = createPerformanceTelemetry(input.aiMode ?? 'ONLINE');
  try {
    const result = await performanceContext.run(telemetry, async () => {
      if (!input.llm!.isAnyConfigured('clipUnderstanding')) return null;
      return input.llm!.generate<{ modes: ContentMode[]; topics: string[]; strict: boolean;
        exclude: string[]; keepFullContext: boolean; styles: Array<{ category: StyleCategory;
          styleId: string }>; templateId: string | null }>({ role: 'clipUnderstanding', request: {
        schemaName: 'creative_brief', schema: BRIEF_SCHEMA, role: 'clipUnderstanding',
        systemPrompt: 'You read a creator\'s brief for turning a long video into short clips. ' +
          'Separate WHAT to clip (content modes, topics; strict=true only if they said only/just/' +
          'exclusively) from HOW to edit it (styles chosen ONLY from the given ids). Any language. ' +
          'Do not invent topics that are not in the brief.',
        userPrompt: JSON.stringify({ brief: local.brief,
          styleCatalog: COMPONENT_STYLES.map((style) => ({ id: style.id, category: style.category,
            name: style.name })), templates: FULL_TEMPLATES.map((template) => ({ id: template.id,
            name: template.name })) }),
        options: { temperature: 0.1, maxOutputTokens: 1200 } } });
    });
    // Rules-only by the deployment's choice is DISABLED; only a missing provider is NOT_CONFIGURED.
    if (!result) {
      return { ...local, ai: aiUnavailable(String(input.aiMode ?? 'ONLINE').toUpperCase() === 'ONLINE'
        ? 'NOT_CONFIGURED' : 'DISABLED') };
    }
    const data = result.data;
    const styleHints: Partial<Record<StyleCategory, StyleChoice>> = { ...local.styleHints };
    for (const style of data.styles ?? []) {
      // Deterministic refinements ("yellow captions") are exact; the model adds the rest.
      if (!styleHints[style.category]) styleHints[style.category] = { styleId: style.styleId };
    }
    return { brief: local.brief, source: 'OPENAI', ai: aiAvailable(),
      intent: { modes: [...new Set([...(data.modes ?? []), ...local.intent.modes])],
        topics: [...new Set([...(data.topics ?? []).map((topic) => topic.toLowerCase()),
          ...local.intent.topics])].slice(0, 8),
        strict: Boolean(data.strict) || local.intent.strict,
        strictModes: Boolean(local.intent.strictModes) && !(data.topics ?? []).length,
        exclude: [...new Set([...(data.exclude ?? []), ...local.intent.exclude])].slice(0, 6),
        keepFullContext: Boolean(data.keepFullContext) || local.intent.keepFullContext },
      styleHints,
      templateHint: FULL_TEMPLATES.some((template) => template.id === data.templateId)
        ? data.templateId : local.templateHint };
  } catch (error) {
    const ai = classifyAiFailure(error);
    input.logger?.warn(JSON.stringify({ event: 'creative_brief_ai_failed', state: ai.state }));
    return { ...local, ai };
  }
}

const RELEVANCE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { scores: { type: 'array', maxItems: 40, items: { type: 'object',
    additionalProperties: false, properties: { id: { type: 'string' },
      relevance: { type: 'integer', minimum: 0, maximum: 100 } }, required: ['id', 'relevance'] } } },
  required: ['scores']
} as const;

/**
 * Step 11 + 22: semantic relevance of candidate moments to the brief. Bounded:
 * at most 40 candidates, each a short excerpt - never the whole transcript.
 * Returns null (deterministic scoring only) whenever AI is unavailable.
 */
export async function scoreCandidatesWithOpenAi(input: { llm: LlmRouterService; brief: string;
  intent: ContentIntent; candidates: Array<{ id: string; transcriptText: string; topic?: string | null }>;
  logger?: Logger; aiMode?: string }): Promise<Map<string, number> | null> {
  const pool = input.candidates.slice(0, 40);
  if (!pool.length || !input.brief.trim()) return null;
  const telemetry = createPerformanceTelemetry(input.aiMode ?? 'ONLINE');
  try {
    const result = await performanceContext.run(telemetry, async () => {
      if (!input.llm.isAnyConfigured('candidateJudge')) return null;
      return input.llm.generate<{ scores: Array<{ id: string; relevance: number }> }>({
        role: 'candidateJudge', request: { schemaName: 'brief_relevance', schema: RELEVANCE_SCHEMA,
          role: 'candidateJudge',
          systemPrompt: 'Rate how well each candidate video moment matches the creator\'s brief, ' +
            '0-100. Judge only the given excerpt. Do not reward generic quality.',
          userPrompt: JSON.stringify({ brief: input.brief.slice(0, 600), intent: input.intent,
            candidates: pool.map((candidate) => ({ id: candidate.id, topic: candidate.topic ?? '',
              excerpt: candidate.transcriptText.slice(0, 280) })) }),
          options: { temperature: 0, maxOutputTokens: 1500 } } });
    });
    if (!result) return null;
    const known = new Set(pool.map((candidate) => candidate.id));
    const map = new Map(result.data.scores.filter((score) => known.has(score.id))
      .map((score) => [score.id, Math.max(0, Math.min(100, Number(score.relevance) || 0))]));
    input.logger?.log(JSON.stringify({ event: 'clip_intent_semantic_scores', scored: map.size,
      provider: result.metadata.provider }));
    return map;
  } catch (error) {
    input.logger?.warn(JSON.stringify({ event: 'clip_intent_semantic_failed',
      state: classifyAiFailure(error).state }));
    return null;
  }
}
