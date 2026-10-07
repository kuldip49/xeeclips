import { creativeService } from '../content-intelligence/creative-package.service';
import { sharedQuality } from '../content-intelligence/creative-quality.service';
import { Injectable } from '@nestjs/common';
import { AiProcessingMode } from '../processing/ai-processing-mode';
import { LlmRouterService } from '../processing/llm-router.service';
import { OutputAspectRatio } from '../processing/processing-type';
import { EDIT_PLAN_SCHEMA, EditPlan, TimedWord, fallbackEditPlan } from './edit-plan';
import { EditingPlanValidator, validateHook } from './editing-plan-validator';
import { applyDeterministicEditorial } from './deterministic-editorial';
import { chooseBestHook, deterministicHookCandidates, HookContext, HOOK_LENGTH, scoreHook,
  solemnSubject, titleCase, trimDanglingTail } from './hook-generator';
import type { TargetPlatform } from '../processing/clip-selection-policy';
import { ContentPackagingService, type ContentPackaging } from './content-packaging.service';

// Soft editorial preferences only; the clip's meaning and quality always take priority.
export const PLATFORM_EDITORIAL_GUIDANCE: Record<TargetPlatform, string> = {
  INSTAGRAM_REELS: 'Instagram Reels: polished editorial look, a visually strong hook and ' +
    'premium, uncluttered composition.',
  YOUTUBE_SHORTS: 'YouTube Shorts: fast comprehension, a clear educational or story ' +
    'progression, a strong payoff, and highly readable captions.',
  TIKTOK: 'TikTok: open immediately on the most engaging line and keep conversational ' +
    'energy with quicker pacing where the content supports it.'
};

// Headline phrasing preferences per surface. Packaging only: the promise a
// headline makes is identical on every platform, only its voice changes.
export const PLATFORM_HOOK_GUIDANCE: Record<TargetPlatform, string> = {
  INSTAGRAM_REELS: 'Instagram Reels rewards an emotionally clear, polished line with a visible ' +
    'human stake; keep it clean rather than shouty.',
  YOUTUBE_SHORTS: 'YouTube Shorts rewards clarity and searchable specifics: name the subject, ' +
    'the number or the concrete consequence so the line reads well cold.',
  TIKTOK: 'TikTok rewards a conversational, immediate line - a direct question, an ironic turn ' +
    'or a blunt statement, in the register a person would actually speak.'
};

export type EditContext = {
  start: number; end: number; aspectRatio: OutputAspectRatio; aiMode: AiProcessingMode;
  transcript: string; words: TimedWord[]; title: string; synopsis: string;
  wholeVideoSummary: string; visualEvidence: unknown; clipUnderstanding: unknown;
  // Extra context around the candidate that the edit may use (source seconds).
  windowStart?: number; windowEnd?: number; windowWords?: TimedWord[];
  targetPlatform?: TargetPlatform | null;
  // Headlines and mechanisms already used by earlier clips of the same source,
  // so a batch of clips does not open five times on the same construction.
  usedHookTexts?: string[];
  usedHookMechanisms?: string[];
  packaging?: ContentPackaging;
};
export type EditPlanResult = {
  plan: EditPlan; source: 'LUNA' | 'DETERMINISTIC_FALLBACK';
  provider: string; model: string; fallbackReason: string; warnings: string[];
  hookOriginalText: string; hookValidationFailureReason: string;
  hookRepairAttempted: boolean; hookRepairSucceeded: boolean; hookFinalText: string;
  // How the delivered hook was produced, and what it was chosen over.
  hookSource: HookSource; hookMechanism: string; hookScore: number | null;
  hookCandidates: Array<{ text: string; score: number; rejected: string; mechanism: string;
    wordCount: number; components: Record<string, number> }>;
  // Ranking aids for the later analytics loop: how much choice the selector had
  // and which mechanisms it could choose between.
  hookCandidateCount: number; hookMechanismsOffered: string[];
  hookWordCount: number; hookScoreComponents: Record<string, number>;
};
export type HookSource = 'LUNA_CANDIDATE' | 'LUNA_PLAN' | 'LUNA_REPAIR' |
  'DETERMINISTIC' | 'TITLE_LAST_RESORT' | 'NONE';

// Below this score a headline is grounded and complete but says very little -
// a bland survivor of a clip whose own wording offers no angle.
const WEAK_HOOK_SCORE = 2.5;

// A hook is mandatory for AI_EDITED, so the ladder always ends somewhere: the
// clip's own title, compressed, is accepted even when it duplicates the title.
// A headline has to be a complete thought (at least HOOK_LENGTH.min words), so a
// short title is extended with the clip's own opening words rather than shipped
// as a three-word fragment.
function lastResortHook(context: { title: string; transcript: string }) {
  const pick = (value: string) => value.match(/[\p{L}\p{N}'’-]+/gu) ?? [];
  const words = pick(context.title).slice(0, HOOK_LENGTH.preferredMax);
  const spoken = pick(context.transcript);
  if (words.length < HOOK_LENGTH.min) {
    const lower = new Set(words.map((word) => word.toLowerCase()));
    // A few words past the floor, so trimming an unfinished tail below still
    // leaves a complete thought rather than dropping back under it.
    for (const word of spoken) {
      if (words.length >= HOOK_LENGTH.min + 4) break;
      if (lower.has(word.toLowerCase())) continue;
      words.push(word);
      lower.add(word.toLowerCase());
    }
  }
  const trimmed = trimDanglingTail(words, HOOK_LENGTH.min);
  if (trimmed.length >= HOOK_LENGTH.min) return titleCase(trimmed.join(' '));
  return trimmed.length >= 3 ? titleCase(trimmed.join(' ')) : '';
}

@Injectable()
export class EditPlanService {
  constructor(private readonly router: LlmRouterService,
    private readonly validator: EditingPlanValidator) {}

  /**
   * Installs the hook on a plan. The headline is mandatory for an edited clip, so
   * this never leaves `onScreenHook.enabled` false: candidates are scored, the
   * best grounded one wins, and when every candidate is rejected the clip's own
   * compressed title is used rather than shipping a bare frame.
   */
  private applyHook(plan: EditPlan, context: EditContext,
    candidates: Array<{ text: string; source: HookSource }>) {
    if (context.packaging?.sharedPackage) {
      const p = context.packaging.sharedPackage;
      const evidence = { transcript: context.transcript, sourceTitle: context.title, visibleText: context.packaging.sharedPackage.understanding.visibleText };
      const ranked = sharedQuality.rank(p.hooks, evidence, p.understanding, p.hooks.some(h=>h.source==='OPENAI') ? 'OPENAI' : 'LOCAL', context.usedHookTexts);
      const selected = ranked.find(h => h.text === p.selectedHook) ?? ranked[0];
      const text = selected?.text ?? '';
      return { plan: { ...plan, hookRequired: Boolean(text), onScreenHook: { ...plan.onScreenHook,
        enabled: Boolean(text), text, startSec: context.start, endSec: context.end } },
        hookSource: (selected?.source==='OPENAI' ? 'LUNA_CANDIDATE' : text ? 'DETERMINISTIC' : 'NONE') as HookSource,
        hookScore: selected ? selected.score / 10 : null, hookMechanism: selected?.category ?? '', hookFinalText: text,
        hookScoreComponents: selected?.components ?? {}, hookWordCount: text.split(/\s+/u).filter(Boolean).length,
        hookCandidates: ranked.map(h => ({ text: h.text, score: h.score / 10, rejected: '', mechanism: h.category,
          components: h.components ?? {}, wordCount: h.text.split(/\s+/u).length })),
        hookCandidateCount: ranked.length, hookMechanismsOffered: ranked.map(h => h.category) };
    }
    const hookContext: HookContext = { transcript: context.transcript,
      title: context.title, synopsis: context.synopsis,
      platform: context.targetPlatform ?? null,
      usedHooks: context.usedHookTexts ?? [], usedMechanisms: context.usedHookMechanisms ?? [],
      verifiedEntities: context.packaging?.entities.filter((entity) => entity.safeToUse)
        .map((entity) => entity.name) ?? [] };
    const bySource = new Map(candidates.filter((item) => item.text?.trim())
      .map((item) => [item.text.trim(), item.source]));
    // The deterministic path always contributes its whole pool, not just its own
    // winner: a grounded rewrite sometimes outranks every model line, and when
    // Luna is absent this pool is the entire choice.
    for (const derived of deterministicHookCandidates(hookContext))
      if (!bySource.has(derived)) bySource.set(derived, 'DETERMINISTIC');
    for (const packaged of context.packaging?.hookCandidates ?? [])
      if (!packaged.rejected && !bySource.has(packaged.text))
        bySource.set(packaged.text, packaged.style === 'DETERMINISTIC' ?
          'DETERMINISTIC' : 'LUNA_CANDIDATE');
    const { best, scored } = chooseBestHook([...bySource.keys()], hookContext);
    let text = best?.text ?? '';
    let hookSource: HookSource = text ? bySource.get(text) ?? 'DETERMINISTIC' : 'NONE';
    let score: number | null = best?.score ?? null;
    let mechanism = best?.mechanism ?? '';
    let components: Record<string, number> = best?.components ?? {};
    let wordCount = best?.wordCount ?? 0;
    // A survivor can still be a thin line ("Not Only Seeing") when the clip's
    // wording gives the rewriter nothing to work with. Below the quality floor a
    // grounded headline built from the clip's own title says more to a viewer
    // than a vague three-word fragment does.
    if (best && best.score < WEAK_HOOK_SCORE) {
      const fromTitle = lastResortHook(context);
      const titleWords = fromTitle.split(/\s+/u).filter(Boolean).length;
      if (titleWords >= HOOK_LENGTH.min && fromTitle.toLowerCase() !== text.toLowerCase()) {
        text = fromTitle;
        hookSource = 'TITLE_LAST_RESORT';
        score = null;
        mechanism = 'TITLE';
        components = {};
        wordCount = titleWords;
      }
    }
    if (!text) {
      text = lastResortHook(context);
      hookSource = text ? 'TITLE_LAST_RESORT' : 'NONE';
      score = null;
      mechanism = 'FALLBACK';
      components = {};
      wordCount = text.split(/\s+/u).filter(Boolean).length;
    }
    const hooked: EditPlan = text ? { ...plan, hookRequired: true,
      onScreenHook: { enabled: true, text, startSec: context.start, endSec: context.end,
        position: 'TOP', style: 'TOP_HEADLINE' } } : { ...plan, hookRequired: true };
    return { plan: hooked, hookSource, hookScore: score, hookMechanism: mechanism,
      hookCandidates: scored, hookFinalText: text, hookScoreComponents: components,
      hookWordCount: wordCount, hookCandidateCount: scored.length,
      hookMechanismsOffered: [...new Set(scored.filter((item) => !item.rejected)
        .map((item) => item.mechanism))] };
  }

  /**
   * Re-picks the headline against the clip's FINAL boundaries (§35/§36).
   * Boundary optimisation can drop or add the very lines a headline was grounded
   * in, so the candidate pool that was already generated is re-scored against
   * the delivered transcript rather than shipping packaging written for a range
   * that no longer exists. No new model call is made, and when the boundaries
   * did not move the deterministic scorer simply returns the same line.
   */
  realignHook(plan: EditPlan, finalContext: EditContext,
    candidates: Array<{ text: string; source: HookSource }>) {
    return this.applyHook(plan, finalContext, candidates);
  }

  /**
   * Five deliberately different headline mechanisms from Luna, so the scorer has
   * a real choice instead of a single take-it-or-leave-it line. Humour is only
   * offered when the clip's subject can carry it; on serious material its slot
   * becomes an insight or consequence angle instead.
   */
  private async hookCandidates(context: EditContext): Promise<string[]> {
    const p = await creativeService(this.router).create({ external: context.aiMode === AiProcessingMode.ONLINE,
      hooksOnly: true, exclude: context.usedHookTexts, evidence: { transcript: context.transcript,
        sourceTitle: context.title, analysis: context.clipUnderstanding as Record<string, unknown> | undefined } });
    return p.hooks.map(h => h.text);
  }

  async create(context: EditContext): Promise<EditPlanResult> {
    if (!context.packaging?.sharedPackage) context = {...context,packaging:await new ContentPackagingService(this.router).create({
      aiMode:context.aiMode,transcript:context.transcript,title:context.title,synopsis:context.synopsis,wholeVideoSummary:context.wholeVideoSummary,
      startTime:context.start,endTime:context.end,analysis:context.clipUnderstanding as Record<string,unknown> | undefined})};
    const fallback = (reason: string, provider = '', model = ''): EditPlanResult => {
      const base = applyDeterministicEditorial(
        fallbackEditPlan(context.start, context.end, context.aspectRatio),
        context.words, context.transcript);
      // Luna is gone, but the headline is not optional: build one from the clip.
      const hook = this.applyHook(base, context, []);
      return { plan: hook.plan,
      source: 'DETERMINISTIC_FALLBACK', provider, model, fallbackReason: reason,
      warnings: [], hookOriginalText: '', hookValidationFailureReason: reason,
      hookRepairAttempted: false, hookRepairSucceeded: false,
      hookFinalText: hook.hookFinalText, hookSource: hook.hookSource,
      hookMechanism: hook.hookMechanism, hookScore: hook.hookScore,
      hookCandidates: hook.hookCandidates, hookCandidateCount: hook.hookCandidateCount,
      hookMechanismsOffered: hook.hookMechanismsOffered, hookWordCount: hook.hookWordCount,
      hookScoreComponents: hook.hookScoreComponents };
    };
    if (context.aiMode !== AiProcessingMode.ONLINE) return fallback('EDITING_LLM_UNAVAILABLE_IN_MODE');
    try {
      const result = await this.router.generate<EditPlan>({ role: 'editingPlan', request: {
        schemaName: 'clip_edit_plan_v2', schema: EDIT_PLAN_SCHEMA,
        systemPrompt: 'You are the editorial director for a professional short-form video. ' +
          'Return only a strict EditPlan. You decide editorial intent; deterministic code executes ' +
          'exact timing, geometry, captions, layout and audio, so never invent coordinates beyond ' +
          'the allowed fields. clipStartSec and clipEndSec must equal the selected candidate range. ' +
          'The editorial window around it provides context words. Judge the clip as one narrative ' +
          'unit - strong open, enough context, payoff, clean close - never as two independent ' +
          'timestamps. openingStrategy.hookStartSec may ' +
          'point to a later sentence start inside the first 4 seconds when that opens on a stronger ' +
          'claim, question, conflict, statistic or emotional beat without losing needed context; ' +
          'otherwise use clipStartSec. A strong opening a cold viewer cannot follow is worse than a ' +
          'slightly slower one that makes sense, so never open on a pronoun whose subject the viewer ' +
          'has not heard. openingStrategy.contextRequiredFromSec is the earliest second a viewer who ' +
          'never saw the full video needs in order to understand who and what is being discussed and ' +
          'why the moment matters; use clipStartSec when nothing earlier is needed. ' +
          'endingStrategy.payoffEndSec is the end of the sentence that ' +
          'completes the payoff, reveal or punchline; it may be up to 3 seconds after clipEndSec ' +
          'only to finish that thought. Never end on a conjunction, a setup phrase, an unresolved ' +
          'question, a dangling pronoun or an obvious continuation. Set endingStrategy.endingComplete ' +
          'true only when the thought genuinely finishes by payoffEndSec. Set ' +
          'endingStrategy.newTopicBeginsAfterSec to the second where the speaker moves on to a ' +
          'different subject after that payoff, so the edit can stop before it, or null when the ' +
          'speaker stays on the same subject; never extend the clip merely to reach punctuation. ' +
          'Never cut through a word. Remove only actual silence, dead ' +
          'air, or expendable lead-in; never cut speech that changes meaning. ' +
          'If removeWeakLeadIn is true, include a matching safe TRIM or REMOVE_SILENCE operation. ' +
          'Create one contextual TOP_HEADLINE hook: a complete, grammatically whole thought of ' +
          `at least ${HOOK_LENGTH.min} words, preferably ` +
          `${HOOK_LENGTH.preferredMin}-${HOOK_LENGTH.preferredMax} words and at most ` +
          `${HOOK_LENGTH.maxChars} characters; up to ${HOOK_LENGTH.max} words is fine when the ` +
          'meaning needs them. Never return a fragment, a noun pile, a transcript scrap or a ' +
          'tiny three-or-four-word line. The hook starts at the final clip beginning and stays ' +
          'visible until its end. ' +
          'It must expose a real tension from the clip without spoiling its payoff, repeating ' +
          'the title, inventing claims, or using generic clickbait such as This Changes Everything. ' +
          'Subtitles always use the exact spoken transcript: never rewrite words. ' +
          'Choose subtitleEmphasis only for spoken meaningful words (numbers, names, emotional or ' +
          'payoff words), with exact word timestamps; never emphasize articles, fillers, or conjunctions. ' +
          'Use 2–5 word semantic subtitle phrases, BOLD_SOCIAL or another restrained theme, ' +
          'and POP subtitles with 2–5 meaningful spoken keyword highlights when available. ' +
          'Zoom is the only motion device on these clips: there is no music and no sound design, ' +
          'so every beat has to be carried by the camera. Find LOCAL emphasis peaks across the ' +
          'whole delivered transcript rather than choosing one clip-global winner. As a guide, use ' +
          '2-3 meaningful events at 15-20 seconds, 3-5 at 20-30, 4-7 at 30-45, and 5-8 at ' +
          '45-60; these are targets, never quotas, and nearby words in one phrase are one event. ' +
          'A ZOOM pushes in on a strong word, key statistic, surprising phrase, ' +
          'emotional beat, contradiction, reaction or punchline. A ZOOM_OUT pulls back to reveal ' +
          'context: the wider scene, a second speaker, the environment, or the return from an ' +
          'intense moment to a neutral one; deterministic code only accepts a ZOOM_OUT that can be ' +
          'anchored to the clip opening, a removed-silence cut or a shot change, and rejects the ' +
          'rest. Choose NORMAL (1.18–1.24) for ordinary emphasis, STRONG (1.26–1.36) for a ' +
          'strong spoken beat, or VERY_STRONG (1.32–1.40) only for a stable single dominant face ' +
          'with safe headroom and no important burned-in text; set scale inside the chosen band ' +
          'and never exceed 1.40. ' +
          'Use pair or ' +
          'wide framing when both speakers matter, and never zoom on screens, documents, charts, ' +
          'slides or wide group shots - readability outranks motion. Every ZOOM and ZOOM_OUT needs ' +
          'triggerText equal to the exact consecutive spoken word(s) of that beat (the move starts ' +
          'on that word) and a `reason` naming the editorial beat in a few words, such as ' +
          '"statistic emphasis", "speaker reaction", "punchline" or "topic reveal". An operation ' +
          'whose reason names no beat is dropped. triggerText must name the actual strongest ' +
          'spoken moment of the beat - a strong action, emotional word, key noun, number, ' +
          'statistic, contradiction, reveal, punchline, named entity, consequence or strong ' +
          'adjective - and never a filler, an article, a weak verb or an ordinary connector: the ' +
          'push is timed onto that exact word. No music and no sound effects are mixed into these ' +
          'clips, so never ask for either. ' +
          'For retentionMoments choose KEEP or NONE when no effect helps. ' +
          'Use only a few supporting overlays that do not duplicate subtitles. ' +
          'Set preserveInformation true when the clip shows webpages, articles, documents, charts, ' +
          'slides, code or product detail that must stay fully visible. ' +
          'Recommend one full-video template from FULL_SCREEN_SOCIAL, EDITORIAL_FRAME, ' +
          'PODCAST_FRAME, DUAL_SPEAKER, CLEAN_DOCUMENTARY based on source aspect ratio, ' +
          'speakers, and visual context. Choose SOURCE_MATCH_GRADIENT, SOURCE_MATCH_SOLID or ' +
          'SOFT_BLUR_EXTENSION as backgroundMode; SOFT_BLUR_EXTENSION (a darkened ambient extension of ' +
          'the running footage) is the default, SOURCE_MATCH_SOLID only for very busy or flashing sources. ' +
          'Choose gradePreset as a mood: CLEAN_SOCIAL by default, WARM_TALKING_HEAD, ' +
          'COOL_DOCUMENTARY or NEUTRAL_EDUCATIONAL when content warrants it; the renderer keeps ' +
          'already-graded sources subtle. musicMood is currently ignored by the renderer - clips ship with dialogue ' +
          'audio only - so NONE is always an acceptable answer. When you do set it, treat it as ' +
          'an editorial decision, not a formality: ' +
          'SUBTLE_DOCUMENTARY for podcasts, interviews and news, DOCUMENTARY_TENSION for debate, ' +
          'politics or serious conflict, CLEAN_NEUTRAL for educational, MODERN_MINIMAL for technology, ' +
          'ENERGETIC_LIGHT for motivational, CALM_WARM for emotional, ATMOSPHERIC for documentary, or ' +
          'NONE when the content is serious, solemn, sensitive, or dense enough that any bed would ' +
          'compete with the voice - a clean NONE is a better result than music that does not fit. ' +
          'Also choose musicEnergy (LOW, MEDIUM or HIGH) and musicTexture (PAD for a sustained bed, ' +
          'DRONE for texture without motion, PULSE when the clip can carry rhythm). These describe ' +
          'editorial intent only: a deterministic library picks the actual track, so never name a ' +
          'file, artist or song. '+
          'Avoid cheesy or dramatic choices, and avoid picking the same mood on every clip from the ' +
          'same source unless it is clearly the strongest match. Set loopSuitable true ' +
          'only when the final line flows naturally back into the opening line. ' +
          'editorialIntent is one sentence describing the edit. ' +
          'All times are absolute source-video seconds inside the editorial window. ' +
          'Operation fields not relevant to a type must be null or empty arrays; ' +
          'triggerText must be an empty string and intensity NORMAL for operations that are ' +
          'neither ZOOM nor ZOOM_OUT. ' +
          'Do not add B-roll, fabricated text, stickers, or flashy effects.',
        userPrompt: JSON.stringify({ finalClip: { startSec: context.start, endSec: context.end,
          transcript: context.transcript, words: context.words, title: context.title,
          synopsis: context.synopsis, clipUnderstanding: context.clipUnderstanding },
          editorialWindow: { startSec: context.windowStart ?? context.start,
            endSec: context.windowEnd ?? context.end,
            words: (context.windowWords ?? []).filter((word) =>
              word.end <= context.start || word.start >= context.end) },
          wholeVideoSummary: context.wholeVideoSummary,
          visualEvidence: context.visualEvidence, requestedAspectRatio: context.aspectRatio,
          ...(context.targetPlatform ? { targetPlatform: context.targetPlatform,
            platformPreference: PLATFORM_EDITORIAL_GUIDANCE[context.targetPlatform] +
              ' These are preferences, not rules: content meaning and quality come first.' } : {}) }),
        maxOutputTokens: 4500, options: { temperature: 0.2 }
      } });
      if (result.metadata.provider !== 'openai' || result.metadata.model !== 'gpt-5.6-luna')
        return fallback('EDITING_PROVIDER_CONTRACT_VIOLATION',
          result.metadata.provider, result.metadata.model);
      const validated = this.validator.validate(result.data, context.start, context.end,
        context.aspectRatio, context.windowWords?.length ? context.windowWords : context.words,
        context.transcript, context.title,
        { start: context.windowStart ?? context.start, end: context.windowEnd ?? context.end });
      if (validated.fallback) return fallback(validated.warnings.join(','),
        result.metadata.provider, result.metadata.model);
      // --- Headline: three Luna mechanisms, the plan's own hook, and the
      // deterministic one, all scored together. The best grounded line wins. ---
      const candidates: Array<{ text: string; source: HookSource }> = [];
      if (!validated.hookValidationFailureReason && validated.plan.onScreenHook.enabled)
        candidates.push({ text: validated.plan.onScreenHook.text, source: 'LUNA_PLAN' });
      let hookRepairAttempted = false;
      let hookRepairSucceeded = false;
      // The edit plan and content package already supply grounded hook options.
      // Ask a second model only when those options fail the same hook scorer.
      const preliminary = this.applyHook(validated.plan, context, candidates);
      if (validated.hookValidationFailureReason || (preliminary.hookScore ?? 0) < 4) {
        try {
          const generated = await this.hookCandidates(context);
          if (generated.length) {
            hookRepairAttempted = Boolean(validated.hookValidationFailureReason);
            for (const text of generated) candidates.push({ text, source: 'LUNA_CANDIDATE' });
          }
        } catch { /* the deterministic hook below still guarantees a headline */ }
      }
      const hook = this.applyHook(validated.plan, context, candidates);
      hookRepairSucceeded = hookRepairAttempted && hook.hookSource === 'LUNA_CANDIDATE';
      // The chosen line still has to satisfy the plan validator's timing/style
      // contract; only a grounding disagreement is tolerated, since the scorer
      // already enforced grounding with a stricter rule.
      const timingFailure = validateHook(hook.plan.onScreenHook, context.start, context.end,
        context.transcript, context.title, true);
      // A revert still keeps hookRequired: a headline the renderer could not be
      // given is a loud gate failure, never a silently "not applicable" clip.
      const plan = timingFailure && !['NOT_CONTEXTUAL', 'INSUFFICIENT_CONTEXT', 'INVALID_LENGTH']
        .includes(timingFailure) ? { ...validated.plan, hookRequired: true } : hook.plan;
      return { plan, source: 'LUNA', provider: 'openai',
        model: 'gpt-5.6-luna', fallbackReason: '', warnings: validated.warnings,
        hookOriginalText: validated.hookOriginalText,
        hookValidationFailureReason: validated.hookValidationFailureReason,
        hookRepairAttempted, hookRepairSucceeded,
        hookFinalText: plan.onScreenHook.enabled ? plan.onScreenHook.text : '',
        hookSource: plan.onScreenHook.enabled ? hook.hookSource : 'NONE',
        hookMechanism: hook.hookMechanism, hookScore: hook.hookScore,
        hookCandidates: hook.hookCandidates, hookCandidateCount: hook.hookCandidateCount,
        hookMechanismsOffered: hook.hookMechanismsOffered, hookWordCount: hook.hookWordCount,
        hookScoreComponents: hook.hookScoreComponents };
    } catch (error) {
      return fallback(error instanceof Error ? error.message.slice(0, 200) : 'EDITING_PLAN_FAILED');
    }
  }
}
