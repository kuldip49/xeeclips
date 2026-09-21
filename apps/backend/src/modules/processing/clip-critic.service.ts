import { Injectable, Logger } from '@nestjs/common';
import { processingModeFor, ScoredClipCandidate } from './clip-candidates';
import { calculateConfidence, calculateGenerationQuality, ClipEvidence,
  ClipUnderstanding } from './clip-intelligence.service';
import { fallbackContent, hashtagsGroundedInClip, normalizedHookSimilarity,
  normalizeSynopsis, synopsisGroundedInClip, synopsisParagraphs } from './openai-clip-judge.service';
import { LlmProviderError, StrictJsonSchema } from './llm-provider.service';
import { LlmRouteMetadata, LlmRouterService } from './llm-router.service';
import { countPerformance } from './performance-telemetry';

const COMPONENTS = ['hooks', 'caption', 'title', 'hashtags', 'synopsis'] as const;
export const MAX_COMPONENT_REPAIR_CYCLES = 1;
type Component = typeof COMPONENTS[number];
type Review = { candidateId?: string; accepted: boolean; components: Record<Component, boolean>;
  reasons: Record<Component, string>; unsupportedClaims: string[] };

const componentBooleans = Object.fromEntries(COMPONENTS.map((name) => [name, { type: 'boolean' }]));
const componentStrings = Object.fromEntries(COMPONENTS.map((name) => [name, { type: 'string' }]));
// candidateId lets a batched critic call (several candidates per request) be matched back
// positionally-safely; legacy single-item responses without it still match by position.
const CRITIC_SCHEMA: StrictJsonSchema = { type: 'object', additionalProperties: false,
  properties: { reviews: { type: 'array', items: { type: 'object', additionalProperties: false,
    properties: { candidateId: { type: 'string' }, accepted: { type: 'boolean' },
    components: { type: 'object',
      additionalProperties: false, properties: componentBooleans, required: [...COMPONENTS] },
    reasons: { type: 'object', additionalProperties: false, properties: componentStrings,
      required: [...COMPONENTS] }, unsupportedClaims: { type: 'array', items: { type: 'string' } } },
    required: ['candidateId', 'accepted', 'components', 'reasons', 'unsupportedClaims'] } } },
  required: ['reviews'] };

const normalize = (value: string) => value.trim().replace(/\s+/gu, ' ');
const tokens = (value: string) => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const numbers = (value: string) => new Set(tokens(value).filter((word) => /^\d/u.test(word)));

function deterministicReview(candidate: ScoredClipCandidate): Review {
  const sourceNumbers = numbers([candidate.transcriptText, candidate.chapterSummary || '',
    candidate.wholeVideoContext || ''].join(' '));
  const unsupportedNumber = (value: string) => [...numbers(value)].some((item) => !sourceNumbers.has(item));
  const sourceWords = new Set(tokens(candidate.transcriptText).filter(word => word.length >= 4));
  const grounded = (value: string) => !sourceWords.size || tokens(value)
    .some(word => word.length >= 4 && sourceWords.has(word));
  const hooks = candidate.hooks || [];
  const hookPass = hooks.length === 3 && new Set(hooks.map((item) => item.style)).size === 3 &&
    hooks.every((item) => normalize(item.text).length >= 8 && /[.!?]$/u.test(normalize(item.text)) &&
      !unsupportedNumber(item.text) && grounded(item.text)) &&
    new Set(hooks.map(item => tokens(item.text).slice(0, 3).join(' '))).size === hooks.length &&
    normalizedHookSimilarity(hooks[0].text, hooks[1].text) < .8 &&
    normalizedHookSimilarity(hooks[0].text, hooks[2].text) < .8 &&
    normalizedHookSimilarity(hooks[1].text, hooks[2].text) < .8;
  const captionPass = !!normalize(candidate.caption || '') &&
    normalize(candidate.caption || '').toLowerCase() !== normalize(candidate.bestHook || '').toLowerCase() &&
    !unsupportedNumber(candidate.caption || '') && grounded(candidate.caption || '');
  const titlePass = !!normalize(candidate.title || '') && !unsupportedNumber(candidate.title || '') &&
    grounded(candidate.title || '');
  const hashtags = candidate.hashtags || [];
  const hashtagPass = hashtags.length === 5 && new Set(hashtags.map((item) => item.toLowerCase())).size === 5 &&
    hashtags.every((item) => /^#[\p{L}\p{N}_]+$/u.test(item)) &&
    hashtagsGroundedInClip(hashtags, candidate);
  const synopsisPass = synopsisGroundedInClip(candidate.synopsis || '', candidate) &&
    !unsupportedNumber(candidate.synopsis || '');
  const components = { hooks: hookPass, caption: captionPass, title: titlePass,
    hashtags: hashtagPass, synopsis: synopsisPass };
  const reasons = Object.fromEntries(COMPONENTS.map((name) => [name,
    components[name] ? '' : name + ' failed deterministic grounding/format validation'])) as Record<Component, string>;
  return { accepted: Object.values(components).every(Boolean), components, reasons,
    unsupportedClaims: [] };
}

// Mechanical repairs: fixes that only rearrange/reformat what the model already produced
// (never invent new claims), so they are always tried before spending a componentRepair call on
// Luna. Each one is verified against the same deterministicReview() acceptance the rest of the
// pipeline uses, so a mechanical fix is only accepted when it actually clears the bar; anything
// it can't safely resolve (missing content, ungrounded claims, too few paragraphs to merge from)
// still escalates to Luna for semantic rewriting.
function stripFormattingArtifacts(value: string) {
  // Includes markdown emphasis markers (*, _) alongside quote/backtick chars so a model's
  // "**Title**" or "_Title_" wrapping is stripped the same way as a quoted title — these are
  // never legitimate leading/trailing title or caption content.
  return normalize(value)
    .replace(/^[`'"“”‘’*_]+|[`'"“”‘’*_]+$/gu, '')
    .replace(/^[-*•]\s+/u, '')
    .replace(/^#+\s*/u, '')
    .trim();
}

function normalizeHashtagFormat(value: string) {
  const cleaned = value.trim().replace(/^#+/u, '').replace(/[^\p{L}\p{N}_]/gu, '');
  return cleaned ? '#' + cleaned : '';
}

// Repairs hashtag count/uniqueness/formatting deterministically: reformats and dedupes what the
// model gave, then pads any shortfall from the deterministic fallback hashtag pool. Grounding
// (whether the resulting five are actually relevant to the clip) is left to the caller's
// deterministicReview() check, since that is the one place already defining "grounded".
function deterministicHashtagRepair(candidate: ScoredClipCandidate): string[] | null {
  const seen = new Set<string>();
  const unique: string[] = [];
  const collect = (values: string[]) => {
    for (const raw of values) {
      if (unique.length >= 5) break;
      const tag = normalizeHashtagFormat(raw);
      if (!tag || seen.has(tag.toLowerCase())) continue;
      seen.add(tag.toLowerCase());
      unique.push(tag);
    }
  };
  collect(candidate.hashtags || []);
  if (unique.length < 5) collect(fallbackContent(candidate).hashtags);
  return unique.length === 5 ? unique : null;
}

// Repairs paragraph count only when the model over-split (more than 3 paragraphs): folding the
// extra paragraphs into the third is a structural merge, not new content. Under-count (fewer than
// 3) has no safe deterministic fix — splitting one paragraph into two would fabricate a boundary
// that was never in the source — so that case is left for Luna.
function deterministicSynopsisRepair(candidate: ScoredClipCandidate): string | null {
  const paragraphs = synopsisParagraphs(candidate.synopsis || '');
  if (paragraphs.length <= 3) return null;
  return [...paragraphs.slice(0, 2), paragraphs.slice(2).join(' ')].join('\n\n');
}

function deterministicComponentRepair(candidate: ScoredClipCandidate, components: Component[]) {
  const values: Partial<Pick<ScoredClipCandidate,
    'hooks' | 'caption' | 'title' | 'hashtags' | 'synopsis'>> = {};
  const remaining: Component[] = [];
  let probe = candidate;
  for (const component of components) {
    if (component === 'hashtags') {
      const repairedHashtags = deterministicHashtagRepair(probe);
      const next = repairedHashtags ? { ...probe, hashtags: repairedHashtags } : null;
      if (next && deterministicReview(next).components.hashtags) {
        values.hashtags = repairedHashtags as string[]; probe = next; continue;
      }
      remaining.push(component);
    } else if (component === 'synopsis') {
      const repairedSynopsis = deterministicSynopsisRepair(probe);
      const next = repairedSynopsis ? { ...probe, synopsis: repairedSynopsis } : null;
      if (next && deterministicReview(next).components.synopsis) {
        values.synopsis = repairedSynopsis as string; probe = next; continue;
      }
      remaining.push(component);
    } else if (component === 'caption' || component === 'title') {
      const source = probe[component] || '';
      const cleaned = stripFormattingArtifacts(source);
      const next = cleaned && cleaned !== source ? { ...probe, [component]: cleaned } : null;
      if (next && deterministicReview(next as ScoredClipCandidate).components[component]) {
        values[component] = cleaned; probe = next as ScoredClipCandidate; continue;
      }
      remaining.push(component);
    } else {
      // Hooks always require semantic (re)generation; there is no mechanical fix for content.
      remaining.push(component);
    }
  }
  return { values, remaining };
}

@Injectable()
export class ClipCriticService {
  private readonly logger = new Logger(ClipCriticService.name);
  constructor(private readonly router: LlmRouterService = new LlmRouterService()) {}

  async review(candidates: ScoredClipCandidate[]) {
    const results: ScoredClipCandidate[] = new Array(candidates.length);
    const configuredBatch = Number(process.env.CLIP_CRITIC_BATCH_SIZE ?? 4);
    const batchSize = Number.isFinite(configuredBatch) ? Math.max(1, Math.min(6,
      Math.floor(configuredBatch))) : 4;
    const batches = Array.from({ length: Math.ceil(candidates.length / batchSize) },
      (_, index) => ({ start: index * batchSize,
        items: candidates.slice(index * batchSize, (index + 1) * batchSize) }));
    let next = 0;
    const configured = Number(process.env.CLIP_CRITIC_CONCURRENCY ?? 1);
    const concurrency = Number.isFinite(configured) ? Math.max(1, Math.min(4, Math.floor(configured))) : 1;
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        const reviewed = await this.reviewPackage(batch.items);
        reviewed.forEach((candidate, offset) => { results[batch.start + offset] = candidate; });
      }
    }));
    return results;
  }

  private async reviewPackage(candidates: ScoredClipCandidate[]) {
    if (!candidates.length) return candidates;
    const deterministic = candidates.map(deterministicReview);
    let reviews = deterministic;
    let route: LlmRouteMetadata | null = null;
    let criticFailure = '';
    // Escalate to the Luna critic only when deterministic grounding/format checks fail AND
    // generation itself did not already pin down which components are broken. Deterministic
    // checks already cover hashtag count/uniqueness, formatting, paragraph count, duplicate
    // hook structure, and schema normalization, so a package that already passes those needs
    // no model call. When localValidationIssues is already populated (generation's own local
    // parse flagged specific components), skip the critic and repair exactly those components
    // directly — the critic call would be redundant with what generation already determined.
    const suspiciousIndexes = deterministic.map((review, index) =>
      !review.accepted && !(candidates[index].localValidationIssues?.length)
        ? index : -1)
      .filter(index => index >= 0);
    try {
      if (!suspiciousIndexes.length) throw new Error('LOCAL_VALIDATION_ACCEPTED');
      const suspicious = suspiciousIndexes.map(index => candidates[index]);
      const result = await this.router.generate<{ reviews: Review[] }>({ role: 'critic', request: {
        schemaName: 'clip_content_critic', schema: CRITIC_SCHEMA, partialBatchField: 'reviews',
        cacheKey: suspicious.map((item) => item.contentFingerprint || item.rangeKey).join(':'),
        systemPrompt: 'Act as a strict grounding critic. The source transcript is authoritative. ' +
          'Review hooks for accuracy, specificity, standalone meaning, payoff, unsupported claims, numbers, ' +
          'clickbait and duplication. Review caption/title/synopsis for clip specificity and fabrication. ' +
          'Synopsis must have exactly three useful, distinct paragraphs: clip context, key development, and supported takeaway. Each paragraph must be grounded in transcript and visual/video context, with no fabrication, filler, or promotional language. Hashtags must be exactly five, unique, clip-relevant, discoverable, and formatted. A component passes only when grounded.',
        userPrompt: JSON.stringify(suspicious.map((candidate) => ({
          candidateId: candidate.rangeKey,
          evidence: candidate.evidence || { transcript: candidate.transcriptText,
            previousContext: candidate.previousTranscriptContext || '',
            nextContext: candidate.nextTranscriptContext || '' },
          clipUnderstanding: candidate.clipUnderstanding || {},
          generated: { hooks: candidate.hooks, caption: candidate.caption, title: candidate.title,
            hashtags: candidate.hashtags, synopsis: candidate.synopsis }
        }))), maxOutputTokens: Math.min(6000, 1800 * suspicious.length), options: { temperature: 0 },
        local: { schemaName: 'local_clip_content_critic', schema: CRITIC_SCHEMA,
          partialBatchField: 'reviews',
          maxOutputTokens: Math.min(7000, 2200 * suspicious.length),
          systemPrompt: 'Validate each generated clip package against its exact clip transcript. ' +
            'Echo each candidateId exactly. Reject unsupported claims and return only concise JSON ' +
            'matching the schema.',
          userPrompt: JSON.stringify(suspicious.map((candidate) => ({
            candidateId: candidate.rangeKey,
            timing: [candidate.startTime, candidate.endTime],
            transcript: candidate.transcriptText,
            previousContext: (candidate.previousTranscriptContext || '').slice(0, 180),
            nextContext: (candidate.nextTranscriptContext || '').slice(0, 180),
            overallTopic: (candidate.overallVideoTopic || '').slice(0, 120),
            visual: Array.isArray(candidate.evidence?.visualSignals) &&
              candidate.evidence.visualSignals.length
              ? candidate.evidence.candidateVisualEvidence : null,
            scores: { hook: candidate.hookScore, standalone: candidate.standaloneScore,
              payoff: candidate.payoffScore },
            generated: { hooks: candidate.hooks, caption: candidate.caption,
              title: candidate.title, hashtags: candidate.hashtags,
              synopsis: candidate.synopsis }
          }))) } }
      });
      // candidateId, when the model echoes it, matches a batched review back to its candidate
      // without relying on array order or a full-length response: partialBatchField lets a
      // truncated/partially invalid batch still credit the items that did come back clean,
      // rather than discarding the whole batch to deterministic fallback (matched by position
      // only when ids are absent and the response length still lines up, e.g. legacy callers).
      const matchedIndexes = new Set<number>();
      result.data.reviews.forEach((model, resultIndex) => {
        if (!model) return;
        const byId = model.candidateId
          ? suspiciousIndexes.find((candidateIndex) => candidates[candidateIndex].rangeKey === model.candidateId)
          : undefined;
        const index = byId ?? (result.data.reviews.length === suspicious.length
          ? suspiciousIndexes[resultIndex] : undefined);
        if (index === undefined || matchedIndexes.has(index)) return;
        matchedIndexes.add(index);
        const components = Object.fromEntries(COMPONENTS.map((component) =>
          [component, model.components[component] && deterministic[index].components[component]])) as
          Record<Component, boolean>;
        reviews[index] = { ...model, components,
          accepted: model.accepted && deterministic[index].accepted };
      });
      if (!matchedIndexes.size) {
        throw new LlmProviderError('SCHEMA_FAILURE', 'Critic response matched no requested candidates');
      }
      route = result.metadata;
      reviews.forEach((review, index) => {
        if (!review.accepted) this.logger.warn(JSON.stringify({ event: 'critic_rejection',
          candidateIndex: index, rejectedComponents: COMPONENTS.filter((name) =>
            !review.components[name]), provider: route?.provider, model: route?.model }));
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'LOCAL_VALIDATION_ACCEPTED') {
        criticFailure = '';
      } else {
      criticFailure = error instanceof LlmProviderError ? error.kind : 'SCHEMA_FAILURE';
      this.logger.warn('Model critic unavailable; deterministic grounding validator used: ' + criticFailure);
      }
    }

    return Promise.all(candidates.map(async (candidate, index) => {
      const review = reviews[index];
      const fallback = fallbackContent(candidate);
      let repaired: ScoredClipCandidate = { ...candidate };
      const requestedRepairs = COMPONENTS.filter((component) => !review.components[component]);
      let repairRoute: LlmRouteMetadata | null = null;
      if (requestedRepairs.length) {
        countPerformance('schemaRepairCount');
        const mechanical = deterministicComponentRepair(repaired, requestedRepairs);
        if (Object.keys(mechanical.values).length) {
          countPerformance('mechanicalComponentRepairCount');
          repaired = { ...repaired, ...mechanical.values };
          this.logger.log(JSON.stringify({ event: 'component_mechanical_repair',
            candidateIndex: index, components: Object.keys(mechanical.values) }));
        }
        const semanticRepairs = mechanical.remaining;
        if (semanticRepairs.length) {
          this.logger.log(JSON.stringify({ event: 'component_regeneration',
            candidateIndex: index, components: semanticRepairs }));
          try {
            if (criticFailure) throw new Error('Critic unavailable; use local repair');
            const result = await this.repairComponents(repaired, semanticRepairs, review);
            repaired = { ...repaired, ...result.values };
            if (result.values.hooks) Object.assign(repaired, {
              bestHook: result.values.hooks[0].text,
              alternateHooks: result.values.hooks.slice(1).map((item) => item.text),
              generatedHookScore: result.values.hooks[0].score,
              selectedHookStrategy: result.values.hooks[0].style
            });
            repairRoute = result.route;
          } catch (error) {
            this.logger.warn('Component-only regeneration failed; deterministic component repair used: ' +
              (error instanceof LlmProviderError ? error.kind : 'SCHEMA_FAILURE'));
          }
        }
      }
      const afterRepair = deterministicReview(repaired);
      const repairedComponents: Component[] = [];
      for (const component of requestedRepairs) {
        if (afterRepair.components[component]) continue;
        repairedComponents.push(component);
        if (component === 'hooks') Object.assign(repaired, { bestHook: fallback.bestHook,
          alternateHooks: fallback.alternateHooks, hooks: fallback.hooks,
          generatedHookScore: fallback.generatedHookScore,
          selectedHookStrategy: fallback.selectedHookStrategy });
        else if (component === 'hashtags') repaired.hashtags = fallback.hashtags;
        else repaired[component] = fallback[component];
      }
      const providerMetadata = [...(candidate.providerMetadata || [])];
      if (route) providerMetadata.push(route as unknown as Record<string, unknown>);
      if (repairRoute) providerMetadata.push(repairRoute as unknown as Record<string, unknown>);
      const evidence = (candidate.evidence || {}) as unknown as ClipEvidence;
      const understanding = (candidate.clipUnderstanding || {}) as unknown as ClipUnderstanding;
      const criticAccepted = afterRepair.accepted && repairedComponents.length === 0;
      const generationMode = processingModeFor(providerMetadata,
        candidate.generationStatus === 'GENERATED');
      return { ...repaired, localValidationIssues: [],
        criticResult: { ...review, repairedComponents,
        validationMode: route ? 'MODEL_AND_DETERMINISTIC' : 'DETERMINISTIC',
        criticFailure }, providerMetadata, generationMode,
        fallbackUsed: candidate.generationStatus === 'FALLBACK' || repairedComponents.length > 0,
        failureCategory: candidate.failureCategory || criticFailure ||
          (repairedComponents.length ? 'CONTENT_QUALITY_FAILURE' : ''),
        generationQuality: calculateGenerationQuality(repaired, criticAccepted),
        confidence: calculateConfidence(evidence, understanding,
          candidate.generationStatus === 'GENERATED', criticAccepted) };
    }));
  }

  private async repairComponents(candidate: ScoredClipCandidate, components: Component[], review: Review) {
    const hookSchema = { type: 'array', minItems: 3, maxItems: 3, items: { type: 'object',
      additionalProperties: false, properties: { text: { type: 'string' },
        style: { type: 'string' }, score: { type: 'number', minimum: 0, maximum: 100 } },
      required: ['text', 'style', 'score'] } } as const;
    const properties: Record<string, unknown> = {};
    for (const component of components) {
      properties[component] = component === 'hooks' ? hookSchema
        : component === 'hashtags' ? { type: 'array', minItems: 5, maxItems: 5,
          items: { type: 'string' } } : { type: 'string' };
    }
    const schema: StrictJsonSchema = { type: 'object', additionalProperties: false,
      properties, required: components };
    const result = await this.router.generate<Record<string, unknown>>({
      role: 'componentRepair', request: { schemaName: 'clip_component_repair', schema,
        cacheKey: (candidate.contentFingerprint || candidate.rangeKey) + ':' + components.join(','),
        systemPrompt: 'Regenerate only the named rejected components. Preserve grounded facts from the ' +
          'exact transcript. Do not add unsupported numbers. Hooks must be exactly three complete, distinct ' +
          'styles with scores. A title must name the exact clip subject. A caption must not repeat a title ' +
          'or hook. Hashtags must be exactly five unique, topic-relevant formatted hashtags. ' +
          'Synopsis must be exactly three useful paragraphs separated by blank lines: clip context, ' +
          'key point or development, and supported takeaway. Ground each in transcript and visual/video context. ' +
          'Return exact JSON with no unrequested fields.',
        userPrompt: JSON.stringify({ exactTranscript: candidate.transcriptText,
          evidence: candidate.evidence || {}, clipUnderstanding: candidate.clipUnderstanding || {},
          rejectedComponents: components,
          criticReasons: Object.fromEntries(components.map((name) => [name, review.reasons[name]])) }),
        maxOutputTokens: 4000, options: { temperature: .45 },
        local: { schemaName: 'local_clip_component_repair', schema,
          maxOutputTokens: 1600,
          systemPrompt: 'Repair only the requested components using the exact clip transcript. ' +
            'Return concise JSON matching the schema; never invent claims or numbers.',
          userPrompt: JSON.stringify({ timing: [candidate.startTime, candidate.endTime],
            transcript: candidate.transcriptText,
            previousContext: (candidate.previousTranscriptContext || '').slice(0, 180),
            nextContext: (candidate.nextTranscriptContext || '').slice(0, 180),
            overallTopic: (candidate.overallVideoTopic || '').slice(0, 120),
            visual: Array.isArray(candidate.evidence?.visualSignals) &&
              candidate.evidence.visualSignals.length
              ? candidate.evidence.candidateVisualEvidence : null,
            scores: { hook: candidate.hookScore, standalone: candidate.standaloneScore,
              payoff: candidate.payoffScore }, rejectedComponents: components,
            criticReasons: Object.fromEntries(components.map((name) =>
              [name, review.reasons[name]])) }) } }
    });
    const values = result.data as Partial<Pick<ScoredClipCandidate,
      'hooks' | 'caption' | 'title' | 'hashtags' | 'synopsis'>>;
    if (typeof values.synopsis === 'string') values.synopsis = normalizeSynopsis(values.synopsis);
    return { values, route: result.metadata };
  }
}
