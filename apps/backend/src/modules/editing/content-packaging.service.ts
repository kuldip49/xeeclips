import { Injectable } from '@nestjs/common';
import { AiProcessingMode } from '../processing/ai-processing-mode';
import { LlmRouterService } from '../processing/llm-router.service';
import type { TargetPlatform } from '../processing/clip-selection-policy';
import { adaptHashtagsForPlatform, packagingFor } from '../processing/platform-packaging';
import { deterministicHookCandidates, HookContext, scoreHook } from './hook-generator';

export const CONTENT_CATEGORIES = ['PODCAST', 'COMEDY', 'TECH', 'AI', 'FINANCE', 'BUSINESS',
  'SPORTS', 'GAMING', 'NEWS', 'POLITICS', 'EDUCATION', 'MOTIVATION', 'RELATIONSHIPS',
  'HEALTH', 'ENTERTAINMENT', 'GENERAL'] as const;
export type ContentCategory = typeof CONTENT_CATEGORIES[number];
export const CLIP_ARCHETYPES = ['HOT_TAKE', 'CONTROVERSY', 'REVEAL', 'SURPRISING_FACT',
  'FUNNY_MOMENT', 'ARGUMENT', 'STORY', 'ADVICE', 'WARNING', 'PREDICTION', 'FAILURE',
  'SUCCESS', 'MONEY', 'CONFESSION', 'REACTION', 'BREAKDOWN', 'EXPLANATION', 'COMPARISON',
  'CONSEQUENCE', 'QUESTION', 'PUNCHLINE'] as const;
export type ClipArchetype = typeof CLIP_ARCHETYPES[number];
export const EMOTIONAL_TONES = ['FUNNY', 'SERIOUS', 'ANGRY', 'SHOCKING', 'INSPIRATIONAL',
  'SARCASTIC', 'AWKWARD', 'CONFIDENT', 'CURIOUS', 'CONFRONTATIONAL', 'NEUTRAL'] as const;
export type EmotionalTone = typeof EMOTIONAL_TONES[number];
export const HUMOR_TYPES = ['SARCASM', 'IRONY', 'ABSURDITY', 'DEADPAN', 'SELF_DEPRECATION',
  'ROAST', 'AWKWARDNESS', 'EXAGGERATION', 'PUNCHLINE', 'WORDPLAY'] as const;
export type HumorType = typeof HUMOR_TYPES[number];
export const SUBTITLE_TEMPLATES = ['PODCAST_BOLD', 'COMEDY_POP', 'EDUCATION_CLEAN',
  'FINANCE_BOLD', 'GAMING_ENERGY', 'NEWS_EDITORIAL'] as const;
export type SubtitleTemplate = typeof SUBTITLE_TEMPLATES[number];

export type EntityEvidence = { source: 'TITLE' | 'METADATA' | 'DESCRIPTION' | 'INTRODUCTION' |
  'TRANSCRIPT' | 'OCR' | 'UNDERSTANDING' | 'CHANNEL'; text: string; weight: number };
export type ResolvedEntity = { id: string; name: string;
  type: 'PERSON' | 'COMPANY' | 'PRODUCT' | 'PLACE' | 'ORGANIZATION' | 'EVENT'; role?: string;
  aliases: string[]; confidence: number; safeToUse: boolean; evidence: EntityEvidence[] };
export type SpeakerIdentity = { speakerTrackId: string; resolvedEntityId?: string;
  probableRole: 'HOST' | 'GUEST' | 'INTERVIEWER' | 'INTERVIEWEE' | 'COMMENTATOR' |
    'EXPERT' | 'CREATOR' | 'UNKNOWN'; confidence: number };
export type PackagingHookCandidate = { text: string;
  style: 'BOLD' | 'CURIOSITY' | 'HUMOROUS' | 'CONTRADICTION' | 'ENTITY_NAME_LED' |
    'CONSEQUENCE' | 'QUESTION' | 'DETERMINISTIC';
  score: number; rejected: string; groundingEvidence: string[];
  components: { grounding: number; clarity: number; curiosity: number; specificity: number;
    entityRecognition: number; emotionalStrength: number; categoryFit: number;
    archetypeFit: number; firstFrameStrength: number; retentionPotential: number;
    novelty: number; humorFit: number; boldness: number; readability: number;
    scrollStopStrength: number; stakes: number; curiosityGap: number;
    emotionalTension: number; consequence: number; mobileReadability: number;
    academicQuestionStyle: number; policyMemoStyle: number;
    genericExplanationStyle: number; weakModalLanguage: number } };
export type PlatformCopy = { youtubeShorts: string; instagramReels: string; tiktok: string };
export type PlatformHashtags = { youtubeShorts: string[]; instagramReels: string[]; tiktok: string[] };
export type PackagingQa = { entityResolutionValid: boolean; entityNameSafeToUse: boolean;
  hookGrounded: boolean; hookSpecific: boolean; hookMetaLanguageFree: boolean;
  hookBoldnessValid: boolean; hookCategoryFit: boolean; hookHumorFit: boolean;
  hookReadable: boolean; hookFirstFrameValid: boolean | null; captionNotDuplicateHook: boolean;
  captionRelevant: boolean; hashtagsRelevant: boolean; hashtagsPlatformValid: boolean;
  subtitlePresent: boolean | null; subtitleReadable: boolean | null;
  subtitleWithinSafeArea: boolean | null; subtitleNoOverflow: boolean | null;
  subtitleMaxTwoLines: boolean | null; subtitlePhraseLengthValid: boolean | null;
  subtitleLayoutStable: boolean | null; subtitleWordHighlightVisible: boolean | null;
  subtitleTimingAverageValid: boolean | null; subtitleFaceCollisionSafe: boolean | null;
  subtitleSourceGraphicCollisionSafe: boolean | null };
export type ContentPackaging = { version: 1; primaryCategory: ContentCategory;
  secondaryCategory: ContentCategory | null; categoryConfidence: number;
  wholeVideoCategory: ContentCategory; archetype: ClipArchetype; emotionalTone: EmotionalTone;
  humor: { detected: boolean; type: HumorType | null; confidence: number };
  entities: ResolvedEntity[]; speakers: SpeakerIdentity[];
  hookCandidates: PackagingHookCandidate[]; selectedHook: PackagingHookCandidate;
  captions: PlatformCopy; hashtags: PlatformHashtags; subtitleTemplate: SubtitleTemplate;
  visualPackagingProfile: { hookRegion: 'EXISTING_EDITORIAL_HEADER';
    subtitleRegion: 'NORMAL_OR_SAFE_HIGH'; firstFramePriority: string[] };
  qa: PackagingQa; packagingScore: { value: number; potential: 'HIGH' | 'MEDIUM' | 'LOW';
    components: Record<string, number> }; generationSource: 'LUNA' | 'OLLAMA' | 'DETERMINISTIC' };

export type PackagingInput = { aiMode: AiProcessingMode; transcript: string; title: string;
  synopsis: string; wholeVideoSummary: string; originalName?: string; sourceDescription?: string;
  channelName?: string; ocrText?: string; speakerTrackIds?: string[];
  existingHooks?: string[]; existingCaption?: string; existingHashtags?: string[];
  targetPlatform?: TargetPlatform | null };

const words = (value: string) => value.match(/[\p{L}\p{N}'’%$-]+/gu) ?? [];
const normal = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const round = (value: number) => Number(clamp(value).toFixed(3));
const slug = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '');
const unique = <T>(items: T[], key: (item: T) => string) => {
  const seen = new Set<string>();
  return items.filter((item) => { const id = key(item); if (seen.has(id)) return false; seen.add(id); return true; });
};
const META_LANGUAGE = /\b(?:the|this)\s+(?:speaker|clip|segment|video|person)\b|\b(?:speaker|host)\s+(?:says?|explains?|talks?|thinks?)\b/iu;
const GENERIC_TAG = /^#?(?:viral|fyp|foryou|foryoupage|trending|reels|shorts)$/iu;

const CATEGORY_RULES: Array<[ContentCategory, RegExp]> = [
  ['AI', /\b(?:artificial intelligence|openai|chatgpt|llm|machine learning|neural network|generative ai)\b/iu],
  ['TECH', /\b(?:software|developer|technology|computer|app|startup|silicon valley|programming|code)\b/iu],
  ['FINANCE', /[$₹€£]|\b(?:money|invest|stock|market|bond|bank|interest rate|inflation|portfolio|revenue|profit)\b/iu],
  ['BUSINESS', /\b(?:business|company|founder|ceo|customer|sales|marketing|management|entrepreneur)\b/iu],
  ['SPORTS', /\b(?:player|coach|team|league|match|game|season|score|championship|athlete|football|cricket|basketball)\b/iu],
  ['GAMING', /\b(?:gaming|gamer|gameplay|xbox|playstation|nintendo|steam|esports|level|boss fight)\b/iu],
  ['POLITICS', /\b(?:president|minister|election|government|congress|parliament|policy|democrat|republican|politic)\w*/iu],
  ['NEWS', /\b(?:breaking|reported|reporter|headline|news|journalist|investigation)\b/iu],
  ['HEALTH', /\b(?:health|doctor|medical|medicine|fitness|diet|sleep|therapy|disease|patient)\b/iu],
  ['RELATIONSHIPS', /\b(?:relationship|dating|marriage|partner|breakup|husband|wife|boyfriend|girlfriend)\b/iu],
  ['EDUCATION', /\b(?:learn|lesson|teacher|student|school|university|explain|tutorial|study|research)\b/iu],
  ['MOTIVATION', /\b(?:motivation|discipline|mindset|habit|goal|success|confidence|never give up)\b/iu],
  ['COMEDY', /\b(?:comedian|comedy|joke|funny|hilarious|laugh|punchline|stand-up)\b/iu],
  ['ENTERTAINMENT', /\b(?:movie|film|music|actor|celebrity|show|series|director|artist)\b/iu],
  ['PODCAST', /\b(?:podcast|episode|interview|host|guest|conversation)\b/iu]
];

@Injectable()
export class EntityResolutionService {
  resolve(input: PackagingInput): { entities: ResolvedEntity[]; speakers: SpeakerIdentity[] } {
    // A filename copied from the title is not independent identity evidence.
    // Counting both would make a title-cased topic phrase look corroborated.
    const independentOriginalName = input.originalName &&
      normal(input.originalName) !== normal(input.title) ? input.originalName : '';
    const evidenceSources = ([
      { source: 'TITLE', text: input.title, weight: .56 },
      { source: 'METADATA', text: independentOriginalName, weight: .28 },
      { source: 'DESCRIPTION', text: input.sourceDescription ?? '', weight: .42 },
      { source: 'TRANSCRIPT', text: input.transcript, weight: .28 },
      { source: 'OCR', text: input.ocrText ?? '', weight: .68 },
      { source: 'UNDERSTANDING', text: input.wholeVideoSummary, weight: .34 },
      { source: 'CHANNEL', text: input.channelName ?? '', weight: .4 }
    ] satisfies Array<{ source: EntityEvidence['source']; text: string; weight: number }>)
      .filter((item) => item.text.trim());
    const found = new Map<string, { name: string; evidence: EntityEvidence[] }>();
    const add = (name: string, item: typeof evidenceSources[number], explicit = false) => {
      const clean = name.replace(/\s+/gu, ' ').replace(/[.,:;!?]+$/u, '').trim();
      if (words(clean).length < 2 || words(clean).length > 4 ||
        /^(?:Artificial Intelligence|United States|New York|YouTube Shorts|Instagram Reels)$/iu.test(clean)) return;
      // The broad title-case scan is evidence discovery, not a declaration that
      // every headline fragment is a person. Obvious headline grammar is dropped;
      // explicit introductions still bypass this filter.
      if (!explicit && /^(?:why|how|what|when|where|who|the|a|an|this|that|my|your|our|deadpan|story|investor|risk)\b|\b(?:about|story|losing)\b/iu.test(clean)) return;
      const key = normal(clean);
      const entry = found.get(key) ?? { name: clean, evidence: [] };
      if (!entry.evidence.some((evidence) => evidence.source === item.source))
        entry.evidence.push({ source: explicit ? 'INTRODUCTION' : item.source,
          text: clean, weight: explicit ? .92 : item.weight });
      found.set(key, entry);
    };
    for (const item of evidenceSources) {
      for (const match of item.text.matchAll(/\b(?:I(?:'m| am)|[Mm]y name is|[Ww]elcome|[Jj]oined by|[Ww]ith us is|[Tt]his is|[Cc]onversation with|[Ii]nterview with|[Ff]eaturing)\s+([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){1,3})/gu))
        add(match[1], item, true);
      for (const match of item.text.matchAll(/\b([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){1,3})\b/gu))
        add(match[1], item);
      if (item.source === 'OCR')
        for (const line of item.text.split(/[\r\n|]/u))
          if (/^[A-Z][A-Z'’ -]{4,40}$/u.test(line.trim())) add(line.trim().replace(/\s+/gu, ' '), item);
    }
    const entities = [...found.values()].map(({ name, evidence }, index): ResolvedEntity => {
      const confidence = round(1 - evidence.reduce((remaining, item) => remaining * (1 - item.weight), 1));
      const sources = new Set(evidence.map((item) => item.source));
      const safeToUse = confidence >= .78 || (confidence >= .6 && sources.size >= 2);
      const context = `${input.title} ${input.transcript}`;
      const role = new RegExp(`\\b(CEO|comedian|creator|coach|analyst|founder|doctor|professor|journalist)\\b[^.]{0,30}${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'iu').exec(context)?.[1];
      return { id: `entity-${index + 1}-${slug(name)}`, name, type: 'PERSON',
        ...(role ? { role: role.toLowerCase() } : {}), aliases: [name], confidence,
        safeToUse, evidence };
    }).sort((a, b) => b.confidence - a.confidence);
    const tracks = unique(input.speakerTrackIds ?? [], (item) => item);
    const safePeople = entities.filter((entity) => entity.safeToUse && entity.type === 'PERSON');
    const speakers = tracks.map((speakerTrackId, index): SpeakerIdentity => {
      // A single named person plus a single speaker track is a defensible association.
      // Multi-speaker order is never guessed from a title or aggregate OCR.
      const entity = tracks.length === 1 && safePeople.length === 1 ? safePeople[0] : undefined;
      const roleText = `${entity?.role ?? ''} ${input.title}`.toLowerCase();
      const probableRole: SpeakerIdentity['probableRole'] = /host|interviewer/u.test(roleText) ? 'HOST' :
        /guest|interviewee/u.test(roleText) ? 'GUEST' : /expert|doctor|professor|analyst/u.test(roleText) ?
          'EXPERT' : /creator/u.test(roleText) ? 'CREATOR' : index === 0 && tracks.length > 1 ?
            'HOST' : tracks.length > 1 ? 'GUEST' : 'UNKNOWN';
      return { speakerTrackId, ...(entity ? { resolvedEntityId: entity.id } : {}), probableRole,
        confidence: entity ? entity.confidence : probableRole === 'UNKNOWN' ? .2 : .45 };
    });
    return { entities, speakers };
  }
}

@Injectable()
export class ContentCategoryService {
  classify(text: string, wholeVideoText = '') {
    const clipScores = new Map<ContentCategory, number>();
    const wholeScores = new Map<ContentCategory, number>();
    for (const [category, pattern] of CATEGORY_RULES) {
      const clip = text.match(new RegExp(pattern.source, `${pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'}`))?.length ?? 0;
      const whole = wholeVideoText.match(new RegExp(pattern.source, `${pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'}`))?.length ?? 0;
      clipScores.set(category, clip * 2 + whole * .35);
      wholeScores.set(category, whole + clip * .2);
    }
    const ranked = [...clipScores.entries()].sort((a, b) => b[1] - a[1]);
    const wholeRanked = [...wholeScores.entries()].sort((a, b) => b[1] - a[1]);
    const primary = ranked[0]?.[1] ? ranked[0][0] : 'GENERAL';
    const secondary = ranked[1]?.[1] && ranked[1][0] !== primary ? ranked[1][0] : null;
    const total = ranked.reduce((sum, item) => sum + item[1], 0);
    return { primaryCategory: primary, secondaryCategory: secondary,
      confidence: round(primary === 'GENERAL' ? .35 : .55 + (ranked[0][1] / Math.max(1, total)) * .4),
      wholeVideoCategory: wholeRanked[0]?.[1] ? wholeRanked[0][0] : primary };
  }
}

@Injectable()
export class FirstFramePackagingValidator {
  validate(input: { hookVisible: boolean; hookReadable: boolean | null;
    hookInsideSafeZone: boolean | null; subjectVisible: boolean; hookContrastRatio: number | null;
    subtitleFirstStartSec?: number | null; firstSpeechSec?: number | null }) {
    const noSubtitleBeforeSpeech = input.subtitleFirstStartSec == null || input.firstSpeechSec == null ||
      input.subtitleFirstStartSec >= input.firstSpeechSec - .05;
    const checks = { identifiableSubject: input.subjectVisible, hookVisible: input.hookVisible,
      hookReadable: input.hookReadable !== false,
      noVisualCollision: input.hookInsideSafeZone !== false,
      noAwkwardBlankFrame: input.hookVisible || input.subjectVisible,
      noSubtitleBeforeSpeech, adequateContrast: input.hookContrastRatio == null ||
        input.hookContrastRatio >= 3 };
    return { ...checks, valid: Object.values(checks).every(Boolean) };
  }
}

function classifyNarrative(text: string): { archetype: ClipArchetype; emotionalTone: EmotionalTone;
  humor: ContentPackaging['humor'] } {
  const lower = text.toLowerCase();
  const humorRules: Array<[HumorType, RegExp]> = [['SARCASM', /\b(?:sarcasm|sarcastic|yeah right|obviously)\b/iu],
    ['IRONY', /\b(?:ironic|ironically|the irony)\b/iu], ['ABSURDITY', /\b(?:absurd|ridiculous|bizarre)\b/iu],
    ['SELF_DEPRECATION', /\b(?:i'm terrible|my own fault|i was an idiot|i failed)\b/iu],
    ['ROAST', /\b(?:roast|mock|burn)\b/iu], ['AWKWARDNESS', /\b(?:awkward|uncomfortable)\b/iu],
    ['EXAGGERATION', /\b(?:literally everyone|a million times|never in my life)\b/iu],
    ['PUNCHLINE', /\b(?:punchline|joke|laughed|hilarious|funny)\b/iu],
    ['WORDPLAY', /\b(?:pun|wordplay)\b/iu], ['DEADPAN', /\bdeadpan\b/iu]];
  const humorMatch = humorRules.find(([, pattern]) => pattern.test(lower));
  const humorConfidence = humorMatch ? (/\b(?:laugh|laughed|laughter|hilarious|punchline)\b/iu.test(lower) ? .88 : .72) : .12;
  const archetype: ClipArchetype = humorConfidence >= .7 ? (/punchline|joke|laugh/iu.test(lower) ? 'PUNCHLINE' : 'FUNNY_MOMENT') :
    /\b(?:warning|danger|avoid|never)\b/iu.test(lower) ? 'WARNING' :
    /[$₹€£]|\b(?:money|cost|profit|million|billion|percent)\b/iu.test(lower) ? 'MONEY' :
    /\b(?:versus|compared|better than|worse than)\b/iu.test(lower) ? 'COMPARISON' :
    /\b(?:because|therefore|means|led to|result)\b/iu.test(lower) ? 'CONSEQUENCE' :
    /\b(?:i admit|confess|truth is)\b/iu.test(lower) ? 'CONFESSION' :
    /\b(?:will|going to|predict|future)\b/iu.test(lower) ? 'PREDICTION' :
    /\b(?:wrong|disagree|argument|debate|fight)\b/iu.test(lower) ? 'ARGUMENT' :
    /\b(?:how|why|because|works|explain)\b/iu.test(lower) ? 'EXPLANATION' :
    /\?/u.test(text) ? 'QUESTION' : 'HOT_TAKE';
  const emotionalTone: EmotionalTone = humorConfidence >= .7 ?
    (humorMatch?.[0] === 'SARCASM' ? 'SARCASTIC' : humorMatch?.[0] === 'AWKWARDNESS' ? 'AWKWARD' : 'FUNNY') :
    /\b(?:angry|furious|outrage|hate)\b/iu.test(lower) ? 'ANGRY' :
    /\b(?:shocking|unbelievable|stunned)\b/iu.test(lower) ? 'SHOCKING' :
    /\b(?:inspire|hope|overcome|believe)\b/iu.test(lower) ? 'INSPIRATIONAL' :
    /\b(?:definitely|certainly|i know|the truth)\b/iu.test(lower) ? 'CONFIDENT' :
    /\?/u.test(text) ? 'CURIOUS' : 'SERIOUS';
  return { archetype, emotionalTone,
    humor: { detected: humorConfidence >= .7, type: humorMatch?.[0] ?? null,
      confidence: humorConfidence } };
}

function captionFrom(text: string, hook: string, platform: TargetPlatform) {
  const sentences = text.replace(/\s+/gu, ' ').split(/(?<=[.!?])\s+/u)
    .map((item) => item.trim()).filter((item) => words(item).length >= 4);
  const hookTerms = new Set(words(hook).map(normal));
  const context = sentences.find((item) => {
    const terms = words(item).map(normal).filter((term) => term.length > 3);
    return terms.some((term) => !hookTerms.has(term));
  }) ?? sentences[0] ?? words(text).slice(0, 26).join(' ');
  const clean = context.replace(/^[,;:–—\s]+|[,;:–—\s]+$/gu, '');
  if (platform === 'TIKTOK') return `The part that matters: ${clean}`.slice(0, packagingFor(platform).captionChars.max);
  if (platform === 'INSTAGRAM_REELS') return `${clean}\n\nThe context makes the moment land.`.slice(0, packagingFor(platform).captionChars.max);
  return clean.slice(0, packagingFor(platform).captionChars.max);
}

function hashtagPool(input: PackagingInput, entities: ResolvedEntity[], category: ContentCategory) {
  const tags = entities.filter((entity) => entity.safeToUse).map((entity) => `#${words(entity.name).join('')}`);
  const categoryTags: Partial<Record<ContentCategory, string[]>> = {
    AI: ['#ArtificialIntelligence', '#AI'], TECH: ['#Technology'], FINANCE: ['#Finance', '#Investing'],
    BUSINESS: ['#Business'], SPORTS: ['#Sports'], GAMING: ['#Gaming'], COMEDY: ['#Comedy'],
    EDUCATION: ['#Education'], PODCAST: ['#Podcast'], HEALTH: ['#Health'], NEWS: ['#News'] };
  tags.push(...(categoryTags[category] ?? [`#${category[0]}${category.slice(1).toLowerCase()}`]));
  const source = `${input.title} ${input.transcript}`;
  const stop = new Set(['this', 'that', 'with', 'from', 'have', 'what', 'when', 'where', 'about',
    'there', 'their', 'would', 'could', 'should', 'because', 'really', 'speaker', 'video', 'clip']);
  for (const generic of ['means', 'people', 'sometimes', 'exactly', 'story', 'losing', 'mornings',
    'great', 'watching', 'matters']) stop.add(generic);
  const counts = new Map<string, number>();
  for (const word of words(source)) {
    const key = normal(word);
    if (key.length < 5 || stop.has(key) || /^\d+$/u.test(key)) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8))
    tags.push(`#${key[0].toUpperCase()}${key.slice(1)}`);
  return unique([...(input.existingHashtags ?? []), ...tags].filter((tag) => !GENERIC_TAG.test(tag)), normal);
}

function hookStyle(mechanism: string, text: string, humor: ContentPackaging['humor']): PackagingHookCandidate['style'] {
  if (humor.detected && /\b(?:funny|hilarious|absurd|ridiculous|ironic|joke|surprisingly|somehow|apparently|plot twist)\b/iu.test(text)) return 'HUMOROUS';
  if (/\?$/u.test(text)) return 'QUESTION';
  if (mechanism === 'CONTRADICTION' || mechanism === 'COUNTERINTUITIVE') return 'CONTRADICTION';
  if (mechanism === 'HIDDEN_CONSEQUENCE') return 'CONSEQUENCE';
  if (mechanism === 'CURIOSITY_GAP' || mechanism === 'REVEAL') return 'CURIOSITY';
  return 'BOLD';
}

function groundedEntityLedHooks(input: PackagingInput, entities: ResolvedEntity[],
  baseCandidates: string[]) {
  const safe = entities.filter((entity) => entity.safeToUse);
  const speakerEntityIds = new Set(safe.filter((entity) =>
    entity.evidence.some((evidence) => ['INTRODUCTION', 'TRANSCRIPT', 'OCR']
      .includes(evidence.source))).map((entity) => entity.id));
  const entity = safe.find((item) => speakerEntityIds.has(item.id)) ??
    ((input.speakerTrackIds?.length ?? 0) <= 1 && safe.length === 1 ? safe[0] : undefined);
  if (!entity) return [];
  const base = baseCandidates.find((candidate) => words(candidate).length >= 4);
  if (!base) return [];
  const rest = base.replace(/^(?:why|how|does|do|did|can|could|should|would|is|are)\s+/iu, '')
    .replace(/[?!.]+$/u, '').trim();
  const compact = words(rest).slice(0, Math.max(3, 12 - words(entity.name).length - 1)).join(' ');
  if (words(compact).length < 3) return [];
  return [`${entity.name} Explains ${compact}`];
}

function packagingHook(text: string, context: HookContext, category: ContentCategory,
  archetype: ClipArchetype, tone: EmotionalTone, humor: ContentPackaging['humor'],
  entities: ResolvedEntity[]): PackagingHookCandidate {
  const base = scoreHook(text, context);
  const lower = text.toLowerCase();
  const safeNames = entities.filter((entity) => entity.safeToUse).map((entity) => entity.name);
  const entityRecognition = safeNames.some((name) => lower.includes(name.toLowerCase())) ? 1 : 0;
  const unsupportedEntity = entities.some((entity) => !entity.safeToUse && lower.includes(entity.name.toLowerCase()));
  const sourceText = `${context.transcript} ${context.title} ${context.synopsis}`;
  const unsupportedNumber = (text.match(/[$₹€£]?\d+(?:[.,]\d+)?%?/gu) ?? [])
    .some((number) => !sourceText.includes(number));
  const unresolvedPronoun = /^(?:he|she|they|his|her|their)\b/iu.test(text.trim());
  const categoryFit = CATEGORY_RULES.find(([item]) => item === category)?.[1].test(text) ? 1 : .55;
  const explicitHumor = /\b(?:funny|hilarious|absurd|ridiculous|ironic|joke)\b/iu.test(text);
  // Surprise language is humor only when the source classifier already found
  // humor. This lets a grounded deadpan/absurd hook fit without treating every
  // serious "surprising fact" headline as a joke.
  const sourceSupportedHumor = humor.detected && (explicitHumor ||
    /\b(?:surprisingly|somehow|apparently|plot twist)\b/iu.test(text));
  const humorFit = sourceSupportedHumor ? 1 : explicitHumor ? 0 : humor.detected ? .65 : 1;
  const boldness = /\b(?:never|wrong|cost|truth|actually|biggest|warning|failed|changed|refused|revealed)\b/iu.test(text) ? .9 : .55;
  const stakes = /\b(?:cost|risk|warning|failed|failure|lose|lost|limit|harder|crisis|consequence|forced)\b/iu.test(text) ? .9 : .35;
  const consequence = /\b(?:cost|means|meant|result|led to|turned|changed|forced|consequence|harder|easier)\b/iu.test(text) ? .9 : .35;
  const emotionalTension = /\b(?:wrong|fear|risk|crisis|fight|delay|limit|harder|impossible|refused|lost)\b/iu.test(text) ? .85 : .35;
  const academicQuestionStyle = /^(?:does|do|did|can|could|should|would|is|are|has|have|whether)\b.*\?$/iu.test(text.trim()) ? 1 : 0;
  const policyMemoStyle = /\b(?:policy|framework|implications?|stability|outcomes?|assessment)\b/iu.test(text) &&
    !/\b(?:cost|failed|changed|forced|harder|wrong|truth|risk)\b/iu.test(text) ? 1 : 0;
  const genericExplanationStyle = /\b(?:discusses|talks about|overview|an explanation of|understanding)\b/iu.test(text) ? 1 : 0;
  const weakModalMatch = /\b(?:may have|could potentially|might be)\b/iu.exec(text)?.[0] ?? '';
  const weakModalRequired = weakModalMatch && sourceText.toLowerCase().includes(weakModalMatch.toLowerCase());
  const weakModalLanguage = weakModalMatch ? (weakModalRequired ? .25 : 1) : 0;
  const wordCount = words(text).length;
  const mobileReadability = wordCount >= 5 && wordCount <= 10 ? 1 :
    wordCount <= 16 ? .7 : .35;
  const curiosityGap = clamp((base.components.curiosity ?? 0) / 3.7);
  const scrollStopStrength = clamp((boldness + stakes + curiosityGap + entityRecognition +
    consequence) / 5);
  const components = {
    grounding: round(base.rejected ? 0 : (base.components.grounding ?? 0) / 2),
    clarity: round(base.rejected ? 0 : .65 + (base.components.readability ?? 0) / 5),
    curiosity: round(curiosityGap), specificity: round((base.components.specificity ?? 0) / 1.6),
    entityRecognition, emotionalStrength: tone === 'NEUTRAL' ? .45 : .78,
    categoryFit, archetypeFit: lower.includes(archetype.toLowerCase().split('_')[0]) ? .9 : .65,
    firstFrameStrength: round(wordCount >= 5 && wordCount <= 10 ? .95 : .55),
    retentionPotential: round(base.rejected ? 0 : clamp((base.score + 2) / 14)),
    novelty: base.rejected === 'DUPLICATE_ACROSS_CLIPS' ? 0 : .8,
    humorFit, boldness, readability: round(base.rejected ? 0 : (base.components.readability ?? 0) / 1.5),
    scrollStopStrength: round(scrollStopStrength), stakes: round(stakes),
    curiosityGap: round(curiosityGap), emotionalTension: round(emotionalTension),
    consequence: round(consequence), mobileReadability: round(mobileReadability),
    academicQuestionStyle, policyMemoStyle, genericExplanationStyle, weakModalLanguage
  };
  const positive = components.grounding * 1.5 + components.specificity * 1.25 +
    components.scrollStopStrength * 1.5 + components.stakes + components.curiosityGap * 1.15 +
    components.emotionalTension * .8 + components.entityRecognition + components.consequence +
    components.humorFit * .55 + components.boldness * 1.2 + components.mobileReadability * 1.1 +
    components.clarity * .45 + components.categoryFit * .4;
  const penalties = components.academicQuestionStyle * 1.1 + components.policyMemoStyle * 1 +
    components.genericExplanationStyle * 1.1 + components.weakModalLanguage * .9;
  const score = round((positive - penalties) / 12.9);
  const rejected = unsupportedEntity ? 'UNSAFE_ENTITY_NAME' : unsupportedNumber ?
    'UNSUPPORTED_NUMBER' : unresolvedPronoun ? 'UNRESOLVED_PRONOUN' : explicitHumor && !humor.detected ?
    'UNSUPPORTED_HUMOR' : META_LANGUAGE.test(text) ? 'META_LANGUAGE' : base.rejected;
  return { text: base.text, style: entityRecognition ? 'ENTITY_NAME_LED' :
    hookStyle(base.mechanism, text, humor), score: rejected ? 0 : score, rejected,
    groundingEvidence: [context.transcript, context.title].filter((source) => words(source)
      .some((word) => lower.includes(normal(word)))).map((source) => source.slice(0, 180)), components };
}

@Injectable()
export class ContentPackagingService {
  constructor(private readonly router: LlmRouterService = new LlmRouterService(),
    private readonly entities: EntityResolutionService = new EntityResolutionService(),
    private readonly categories: ContentCategoryService = new ContentCategoryService(),
    private readonly firstFrame: FirstFramePackagingValidator = new FirstFramePackagingValidator()) {}

  private async modelHooks(input: PackagingInput, entities: ResolvedEntity[], category: ContentCategory,
    archetype: ClipArchetype, tone: EmotionalTone, humor: ContentPackaging['humor']) {
    if (input.aiMode === AiProcessingMode.FALLBACK_ONLY) return { hooks: [] as string[], source: 'DETERMINISTIC' as const };
    const fields = ['bold', 'curiosity', 'humorous', 'contradiction', 'entityLed', 'consequence', 'question'];
    const schema = { type: 'object' as const, additionalProperties: false,
      properties: Object.fromEntries(fields.map((field) => [field, { type: 'string' }])), required: fields };
    try {
      const result = await this.router.generate<Record<string, string>>({ role: 'editingPlan', request: {
        schemaName: 'content_packaging_hooks_v1', schema,
        systemPrompt: 'Propose seven distinct social-native headline variants. Prefer 5-10 words ' +
          '(up to 20 only when factual meaning requires it), grounded only in the supplied transcript/evidence, and must not ' +
          'invent names, quotes, numbers, outcomes, accusations, controversy or emotion. Use a humorous ' +
          'line only when humor.detected is true. Prefer specific stakes, consequence, tension and curiosity ' +
          'over academic questions or policy-memo phrasing. Avoid weak modal language unless the source ' +
          'requires uncertainty. When safeEntities are present, make entityLed genuinely name the most ' +
          'relevant verified entity. Avoid the speaker, the host, this clip, this segment, this video and ' +
          'unresolved pronouns. Return empty humorous/entityLed fields when unsupported.',
        userPrompt: JSON.stringify({ transcript: input.transcript, title: input.title,
          synopsis: input.synopsis, category, archetype, tone, humor,
          safeEntities: entities.filter((entity) => entity.safeToUse).map((entity) =>
            ({ name: entity.name, role: entity.role, evidence: entity.evidence })) }),
        maxOutputTokens: 600, options: { temperature: .55 } } });
      const onlineContract = input.aiMode !== AiProcessingMode.ONLINE ||
        (result.metadata.provider === 'openai' && result.metadata.model === 'gpt-5.6-luna');
      if (!onlineContract) return { hooks: [] as string[], source: 'DETERMINISTIC' as const };
      return { hooks: fields.map((field) => result.data[field]).filter((item) => item?.trim()),
        source: input.aiMode === AiProcessingMode.ONLINE ? 'LUNA' as const : 'OLLAMA' as const };
    } catch { return { hooks: [] as string[], source: 'DETERMINISTIC' as const }; }
  }

  async create(input: PackagingInput): Promise<ContentPackaging> {
    const identity = this.entities.resolve(input);
    const category = this.categories.classify(`${input.title} ${input.synopsis} ${input.transcript}`,
      input.wholeVideoSummary);
    const narrative = classifyNarrative(`${input.title} ${input.synopsis} ${input.transcript}`);
    const verifiedEntities = identity.entities.filter((entity) => entity.safeToUse).map((entity) => entity.name);
    const hookContext: HookContext = { transcript: input.transcript, title: input.title,
      synopsis: input.synopsis, platform: input.targetPlatform ?? null, verifiedEntities };
    const model = await this.modelHooks(input, identity.entities, category.primaryCategory,
      narrative.archetype, narrative.emotionalTone, narrative.humor);
    const deterministic = deterministicHookCandidates(hookContext);
    const entityLed = groundedEntityLedHooks(input, identity.entities,
      [...model.hooks, ...deterministic]);
    const pool = unique([...(input.existingHooks ?? []), ...model.hooks, ...entityLed,
      ...deterministic, input.title].filter(Boolean), normal);
    // A sparse source can legitimately produce fewer than five accepted rewrites. Preserve the
    // rejected raw alternatives for diagnostics instead of inventing five unsupported claims.
    const diagnostic = [...pool];
    const transcriptSlices = input.transcript.split(/(?<=[.!?])\s+/u).map((item) => item.trim())
      .filter(Boolean);
    for (const item of [...transcriptSlices, input.synopsis]) {
      if (diagnostic.length >= 7) break;
      if (!diagnostic.some((existing) => normal(existing) === normal(item))) diagnostic.push(item);
    }
    while (diagnostic.length < 5) diagnostic.push(`${input.title} ${diagnostic.length + 1}`.trim());
    const hookCandidates = unique(diagnostic.map((text) => packagingHook(text, hookContext,
      category.primaryCategory, narrative.archetype, narrative.emotionalTone, narrative.humor,
      identity.entities)), (item) => normal(item.text));
    const selectedHook = hookCandidates.filter((item) => !item.rejected)
      .sort((a, b) => b.score - a.score)[0] ?? hookCandidates[0];
    const captions: PlatformCopy = {
      youtubeShorts: captionFrom(input.transcript, selectedHook.text, 'YOUTUBE_SHORTS'),
      instagramReels: captionFrom(input.transcript, selectedHook.text, 'INSTAGRAM_REELS'),
      tiktok: captionFrom(input.transcript, selectedHook.text, 'TIKTOK') };
    const poolTags = hashtagPool(input, identity.entities, category.primaryCategory);
    const relevance = `${input.title} ${input.transcript} ${verifiedEntities.join(' ')}`;
    const hashtags: PlatformHashtags = {
      youtubeShorts: adaptHashtagsForPlatform('YOUTUBE_SHORTS', [], poolTags, relevance),
      instagramReels: adaptHashtagsForPlatform('INSTAGRAM_REELS', [], poolTags, relevance),
      tiktok: adaptHashtagsForPlatform('TIKTOK', [], poolTags, relevance) };
    const selectedCaption = input.targetPlatform === 'INSTAGRAM_REELS' ? captions.instagramReels :
      input.targetPlatform === 'TIKTOK' ? captions.tiktok : captions.youtubeShorts;
    const selectedTags = input.targetPlatform === 'INSTAGRAM_REELS' ? hashtags.instagramReels :
      input.targetPlatform === 'TIKTOK' ? hashtags.tiktok : hashtags.youtubeShorts;
    const qa: PackagingQa = {
      entityResolutionValid: identity.entities.every((entity) => entity.evidence.length > 0),
      entityNameSafeToUse: !identity.entities.some((entity) => selectedHook.text.toLowerCase()
        .includes(entity.name.toLowerCase()) && !entity.safeToUse),
      hookGrounded: !selectedHook.rejected && selectedHook.components.grounding >= .5,
      hookSpecific: selectedHook.components.specificity >= .35 || selectedHook.components.entityRecognition > 0,
      hookMetaLanguageFree: !META_LANGUAGE.test(selectedHook.text),
      hookBoldnessValid: selectedHook.components.boldness >= .5,
      hookCategoryFit: selectedHook.components.categoryFit >= .5,
      hookHumorFit: selectedHook.components.humorFit >= .7,
      hookReadable: words(selectedHook.text).length >= 5 && words(selectedHook.text).length <= 20,
      hookFirstFrameValid: null,
      captionNotDuplicateHook: normal(selectedCaption) !== normal(selectedHook.text),
      captionRelevant: words(selectedCaption).some((word) => input.transcript.toLowerCase().includes(word.toLowerCase())),
      hashtagsRelevant: selectedTags.length > 0 && selectedTags.every((tag) => !GENERIC_TAG.test(tag)),
      hashtagsPlatformValid: selectedTags.length >= packagingFor(input.targetPlatform).hashtags.min &&
        selectedTags.length <= packagingFor(input.targetPlatform).hashtags.max,
      subtitlePresent: null, subtitleReadable: null, subtitleWithinSafeArea: null,
      subtitleNoOverflow: null, subtitleMaxTwoLines: null, subtitlePhraseLengthValid: null,
      subtitleLayoutStable: null, subtitleWordHighlightVisible: null,
      subtitleTimingAverageValid: null, subtitleFaceCollisionSafe: null,
      subtitleSourceGraphicCollisionSafe: null };
    const components = { identityConfidence: identity.entities[0]?.confidence ?? .35,
      hookStrength: selectedHook.score, curiosityStrength: selectedHook.components.curiosity,
      boldness: selectedHook.components.boldness, humorFit: selectedHook.components.humorFit,
      categoryFit: selectedHook.components.categoryFit,
      captionStrength: qa.captionNotDuplicateHook && qa.captionRelevant ? .85 : .35,
      hashtagRelevance: qa.hashtagsRelevant ? .85 : .3, firstFrameStrength: .5,
      subtitleVisualQuality: .5 };
    const value = round(Object.values(components).reduce((sum, item) => sum + item, 0) /
      Object.keys(components).length);
    return { version: 1, primaryCategory: category.primaryCategory,
      secondaryCategory: category.secondaryCategory, categoryConfidence: category.confidence,
      wholeVideoCategory: category.wholeVideoCategory, archetype: narrative.archetype,
      emotionalTone: narrative.emotionalTone, humor: narrative.humor,
      entities: identity.entities, speakers: identity.speakers, hookCandidates, selectedHook,
      captions, hashtags, subtitleTemplate: 'PODCAST_BOLD',
      visualPackagingProfile: { hookRegion: 'EXISTING_EDITORIAL_HEADER',
        subtitleRegion: 'NORMAL_OR_SAFE_HIGH',
        firstFramePriority: ['HOOK_VISIBLE', 'SUBJECT_VISIBLE', 'NO_COLLISION', 'ADEQUATE_CONTRAST'] },
      qa, packagingScore: { value, potential: value >= .75 ? 'HIGH' : value >= .5 ? 'MEDIUM' : 'LOW',
        components }, generationSource: model.source };
  }

  finalize(packaging: ContentPackaging, hookText: string, rendered: {
    hookVisible: boolean; hookReadable: boolean | null; hookInsideSafeZone: boolean | null;
    subjectVisible: boolean; hookContrastRatio: number | null; subtitleFirstStartSec?: number | null;
    firstSpeechSec?: number | null; subtitleTelemetry?: Record<string, unknown> }) {
    const selected = packaging.hookCandidates.find((candidate) =>
      normal(candidate.text) === normal(hookText)) ?? { ...packaging.selectedHook, text: hookText };
    const firstFrame = this.firstFrame.validate(rendered);
    const firstFrameStrength = [rendered.hookVisible, rendered.hookReadable !== false,
      rendered.hookInsideSafeZone !== false, rendered.subjectVisible].filter(Boolean).length / 4;
    const components = { ...packaging.packagingScore.components, hookStrength: selected.score,
      firstFrameStrength,
      subtitleVisualQuality: rendered.subtitleTelemetry ? .9 : .5 };
    const value = round(Object.values(components).reduce((sum, item) => sum + item, 0) /
      Object.keys(components).length);
    return { ...packaging, selectedHook: selected,
      qa: { ...packaging.qa, hookFirstFrameValid: firstFrame.valid,
        hookReadable: rendered.hookReadable !== false,
        subtitlePresent: Number(rendered.subtitleTelemetry?.subtitlePhraseCount ?? 0) > 0,
        subtitleReadable: Number(rendered.subtitleTelemetry?.subtitleFontSize ?? 72) >= 64,
        subtitleWithinSafeArea: rendered.subtitleTelemetry?.subtitleWithinSafeArea !== false,
        subtitleNoOverflow: Number(rendered.subtitleTelemetry?.subtitleMaxWidthRatio ?? 0) <= .78,
        subtitleMaxTwoLines: Number(rendered.subtitleTelemetry?.maxSubtitleLineCount ?? 0) <= 2,
        subtitlePhraseLengthValid: Number(rendered.subtitleTelemetry?.maxWordsPerPhrase ?? 0) <= 6,
        subtitleLayoutStable: rendered.subtitleTelemetry?.subtitleLayoutStable !== false,
        subtitleWordHighlightVisible: Number(rendered.subtitleTelemetry?.activeWordHighlightCount ?? 0) > 0,
        subtitleTimingAverageValid: Number(rendered.subtitleTelemetry?.subtitleTimingAverageResidualMs ?? 0) <= 50,
        subtitleFaceCollisionSafe: Number(rendered.subtitleTelemetry?.subtitleFaceCollisionCount ?? 0) === 0,
        subtitleSourceGraphicCollisionSafe:
          Number(rendered.subtitleTelemetry?.subtitleSourceGraphicCollisionRatio ?? 0) <= .06 },
      packagingScore: { value, potential: value >= .75 ? 'HIGH' as const :
        value >= .5 ? 'MEDIUM' as const : 'LOW' as const, components } };
  }
}

export function packagingTelemetryOf(packaging: ContentPackaging, platform: TargetPlatform | null,
  subtitle: Record<string, unknown> = {}) {
  const persons = packaging.entities.filter((entity) => entity.type === 'PERSON');
  const selectedTags = platform === 'INSTAGRAM_REELS' ? packaging.hashtags.instagramReels :
    platform === 'TIKTOK' ? packaging.hashtags.tiktok : packaging.hashtags.youtubeShorts;
  return { entityCount: packaging.entities.length,
    resolvedPersonCount: persons.filter((entity) => entity.safeToUse).length,
    namedSpeakerCount: packaging.speakers.filter((speaker) => speaker.resolvedEntityId).length,
    identityFallbackCount: packaging.speakers.filter((speaker) => !speaker.resolvedEntityId).length,
    primaryCategory: packaging.primaryCategory, categoryConfidence: packaging.categoryConfidence,
    archetype: packaging.archetype, emotionalTone: packaging.emotionalTone,
    packagingHookCandidateCount: packaging.hookCandidates.length,
    selectedHookStyle: packaging.selectedHook.style,
    hookGroundingScore: packaging.selectedHook.components.grounding,
    hookBoldnessScore: packaging.selectedHook.components.boldness,
    hookScrollStopStrength: packaging.selectedHook.components.scrollStopStrength,
    hookSpecificityScore: packaging.selectedHook.components.specificity,
    hookStakesScore: packaging.selectedHook.components.stakes,
    hookCuriosityGapScore: packaging.selectedHook.components.curiosityGap,
    hookEmotionalTensionScore: packaging.selectedHook.components.emotionalTension,
    hookEntityRecognitionScore: packaging.selectedHook.components.entityRecognition,
    hookConsequenceScore: packaging.selectedHook.components.consequence,
    hookMobileReadabilityScore: packaging.selectedHook.components.mobileReadability,
    hookAcademicQuestionStyle: packaging.selectedHook.components.academicQuestionStyle,
    hookPolicyMemoStyle: packaging.selectedHook.components.policyMemoStyle,
    hookGenericExplanationStyle: packaging.selectedHook.components.genericExplanationStyle,
    hookWeakModalLanguage: packaging.selectedHook.components.weakModalLanguage,
    hookHumorScore: packaging.selectedHook.components.humorFit,
    hookCategoryFitScore: packaging.selectedHook.components.categoryFit,
    captionPlatform: platform, hashtagCount: selectedTags.length,
    subtitleTemplate: packaging.subtitleTemplate, packagingScore: packaging.packagingScore.value,
    packagingPotential: packaging.packagingScore.potential, packagingQa: packaging.qa, ...subtitle };
}
