// Workstream G: creative hook rewriting, grounded.
//
// "Change the hook", "make it shorter", "more curiosity based", "try another".
// Every one of these edits the SAME existing hook element through
// SET_TEXT_CONTENT - this module only decides the wording.
//
// Two sources, one gate:
//   * DETERMINISTIC candidates are built from the opening of the cached
//     transcript by the same grounded rewriter the auto-edit pipeline uses
//     (`deterministicHookCandidates`, read-only from the frozen editing module),
//     and "shorter" compresses the current line by removing words only.
//   * MODEL candidates (ONLINE only, through the EditMode-local editingPlan
//     route) are requested under a strict schema.
// Both are then run through `scoreHook` against the transcript, which rejects
// ungrounded lines, fabricated quotes, clickbait and false urgency. A candidate
// that fails the gate is never proposed, whichever path produced it.

import { Logger } from '@nestjs/common';
import type { LlmRouterService } from '../../processing/llm-router.service';
import { createPerformanceTelemetry,
  performanceContext } from '../../processing/performance-telemetry';
import { deterministicHookCandidates, HOOK_LENGTH, scoreHook, titleCase,
  type HookScore } from '../../editing/hook-generator';
import { CHAT_HOOK_SCHEMA } from './edit-chat-commands';
import { chatPlannerAiMode, CHAT_PLANNER_ROLE } from './edit-chat-planner';

export const HOOK_MODES = ['REWRITE', 'STRONGER', 'SHORTER', 'CURIOSITY', 'ANOTHER', 'NEW'] as const;
export type HookMode = typeof HOOK_MODES[number];

/** Mechanisms that read as curiosity rather than as a flat statement. */
const CURIOSITY_MECHANISMS = new Set(['CURIOSITY_GAP', 'STRONG_QUESTION', 'COUNTERINTUITIVE',
  'REVEAL', 'HIDDEN_CONSEQUENCE', 'CONTRADICTION']);

const MODE_BRIEF: Record<HookMode, string> = {
  REWRITE: 'Write a different, stronger version of the current headline.',
  STRONGER: 'Make the headline more compelling without exaggerating anything.',
  SHORTER: 'Make the headline noticeably shorter while keeping its meaning.',
  CURIOSITY: 'Make the headline create curiosity - a question or an open loop the video ' +
    'itself answers.',
  ANOTHER: 'Offer a genuinely different angle from the headlines already tried.',
  NEW: 'Write an opening headline for this video.'
};

export type HookSuggestion = { text: string; source: 'DETERMINISTIC' | 'LLM';
  mechanism: string; score: number };

const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const wordCount = (text: string) => text.split(/\s+/u).filter(Boolean).length;

/** Words that can be dropped from a headline without changing what it claims. */
const DROPPABLE = /\b(?:really|actually|just|very|basically|literally|simply|truly|even|still|so)\b\s*/giu;
const TRAILING = /\s*(?:[,;:—–-]\s+|\s+\b(?:because|which|when|while|since|so that|and then)\b\s+).*$/iu;

/**
 * Shorter versions of the current line, by REMOVING words only. Nothing is
 * added, so nothing new is claimed; the grounding gate still checks the result.
 */
function shorterVersions(current: string): string[] {
  const question = /\?\s*$/u.test(current);
  const base = current.replace(/[?!.]+\s*$/u, '').trim();
  const out = new Set<string>();
  const add = (text: string) => {
    const clean = text.replace(/\s+/gu, ' ').replace(/[,;:—–-]+$/u, '').trim();
    if (clean && wordCount(clean) < wordCount(base)) {
      out.add(`${titleCase(clean)}${question ? '?' : ''}`);
    }
  };
  // Only clause boundaries and droppable words: cutting at a word COUNT
  // produced "Paying the Hidden" - grounded, and broken.
  add(base.replace(TRAILING, ''));
  add(base.replace(DROPPABLE, ''));
  add(base.replace(TRAILING, '').replace(DROPPABLE, ''));
  // Whisper commonly renders a decimal as two tokens ("3 .4") and speakers
  // often finish a statistic with "in August on an annualized basis".  The
  // literal prefix is too short to clear the headline floor, even though a
  // five-word, equally grounded tightening exists.  Keep this rewrite narrow:
  // every content word comes from the current line, while "rate was" is
  // independently checked against the transcript by scoreHook below.
  const annualized = /^(\d+(?:\s*\.\s*\d+)?)\s+in\s+(.+?)\s+on\s+an\s+annuali[sz]ed\s+basis$/iu
    .exec(base);
  if (annualized) {
    add(`${annualized[2]} annualized rate was ${annualized[1].replace(/\s+/gu, '')}`);
  }
  // Stop in front of a word that opens a new phrase: "... the Hidden Cost |
  // every single month" is a clean cut; the same rule refuses the unclean ones.
  const words = base.split(/\s+/u).filter(Boolean);
  words.forEach((word, index) => {
    if (index >= HOOK_LENGTH.min && PHRASE_OPENERS.has(word.toLowerCase())) {
      add(words.slice(0, index).join(' '));
    }
  });
  return [...out];
}

const SHORTER_MIN_OVERLAP = 0.6;
const substance = (text: string) => normalized(text).split(' ').filter((word) => word.length >= 4);
/** Share of the candidate's substantial words that the reference also uses. */
function substanceOverlap(candidate: string, reference: string) {
  const words = substance(candidate);
  const known = new Set(substance(reference));
  return words.length ? words.filter((word) => known.has(word)).length / words.length : 0;
}

/** Words a phrase may legitimately stop in front of: a preposition, a
 *  conjunction or an adverbial opens a new phrase, so cutting there is clean. */
const PHRASE_OPENERS = new Set(['every', 'each', 'because', 'when', 'which', 'while', 'since',
  'and', 'but', 'so', 'or', 'in', 'on', 'at', 'for', 'to', 'with', 'by', 'from', 'after',
  'before', 'this', 'that', 'now', 'today', 'again', 'too', 'as', 'than', 'then', 'if',
  'until', 'without', 'into', 'over', 'even', 'yet', 'still', 'all']);
const LEADING_DISCOURSE = /^(?:but|and|so|well|now|okay|ok|also|then)\s+/u;
const norm = (text: string) => normalized(text).replace(LEADING_DISCOURSE, '');

/**
 * A candidate that is a sentence (or the current hook) cut off in the middle of
 * a phrase - "... the Hidden Cost Every Single" before "Month" - reads as broken
 * on screen even though every word is grounded. The frozen generator's width
 * cap can produce these, so they are refused here, where the chat owns them.
 */
function cutMidPhrase(candidate: string, sources: string[]) {
  const key = norm(candidate.replace(/[?!.]+$/u, ''));
  if (!key) return false;
  return sources.some((source) => {
    const full = norm(source);
    if (!full.startsWith(`${key} `)) return false;
    const next = full.slice(key.length + 1).split(' ')[0];
    return !PHRASE_OPENERS.has(next);
  });
}

/**
 * Ranks grounded candidates for one mode, excluding everything already shown.
 * Returns the best first; empty when nothing clears the gate.
 */
export function rankHookCandidates(input: { mode: HookMode; current: string | null;
  tried: string[]; transcript: string; candidates: Array<{ text: string;
    source: HookSuggestion['source'] }> }): HookSuggestion[] {
  const excluded = new Set([input.current ?? '', ...input.tried].map(normalized));
  // Shortening the user's own line may reuse its words: they already accepted
  // them, and removing words cannot introduce a claim.
  const context = { transcript: input.transcript, title: '', synopsis: '',
    ...(input.mode === 'SHORTER' && input.current ? { verifiedEntities: [input.current] } : {}) };
  const currentWords = input.current ? wordCount(input.current) : Infinity;
  const sources = [...input.transcript.split(/(?<=[.!?])\s+/u), ...(input.current ? [input.current] : [])];
  const scored: Array<HookScore & { source: HookSuggestion['source'] }> = [];
  for (const candidate of input.candidates) {
    const text = candidate.text.replace(/\s+/gu, ' ').trim();
    if (!text || excluded.has(normalized(text))) continue;
    excluded.add(normalized(text));
    if (cutMidPhrase(text, sources)) continue;
    const score = scoreHook(text, context);
    if (score.rejected) continue;
    if (input.mode === 'SHORTER' && score.wordCount >= currentWords) continue;
    // "Shorter" means the SAME headline, tighter - not a different line that
    // happens to be short. Most of its substance must come from the current one.
    if (input.mode === 'SHORTER' && input.current &&
      substanceOverlap(text, input.current) < SHORTER_MIN_OVERLAP) continue;
    scored.push({ ...score, source: candidate.source });
  }
  const bias = (item: HookScore) => {
    if (input.mode === 'CURIOSITY') {
      return (CURIOSITY_MECHANISMS.has(item.mechanism) ? 2 : 0) + (/\?$/u.test(item.text) ? 1 : 0);
    }
    if (input.mode === 'SHORTER') return -item.wordCount * 0.25;
    return 0;
  };
  return scored.sort((left, right) => (bias(right) + right.score) - (bias(left) + left.score) ||
    left.text.length - right.text.length)
    .map((item) => ({ text: item.text, source: item.source, mechanism: item.mechanism,
      score: item.score }));
}

/** Deterministic, source-grounded candidates for one mode. */
export function deterministicHookSuggestions(input: { mode: HookMode; current: string | null;
  tried: string[]; opening: string; transcript: string }): HookSuggestion[] {
  const pool = [
    ...(input.mode === 'SHORTER' && input.current ? shorterVersions(input.current) : []),
    ...deterministicHookCandidates({ transcript: input.opening || input.transcript,
      title: '', synopsis: '' }),
    // Past the opening, the rest of the transcript is still the speaker's own
    // words - a fallback pool when the opening is too thin to headline.
    ...(input.opening && input.opening !== input.transcript
      ? deterministicHookCandidates({ transcript: input.transcript, title: '', synopsis: '' }) : [])
  ].map((text) => ({ text, source: 'DETERMINISTIC' as const }));
  return rankHookCandidates({ mode: input.mode, current: input.current, tried: input.tried,
    transcript: input.transcript, candidates: pool });
}

/**
 * Asks the configured model for candidates, ONLINE only.
 *
 * Runs inside EditMode's own performance context (the Phase 7 fix), so it can
 * never inherit a processing job's AI mode. OFFLINE never reaches a model: the
 * frozen router does not allow the editingPlan role offline, and this module
 * does not change that. Every failure is "no model candidates".
 */
export async function modelHookSuggestions(input: { llm: LlmRouterService; logger: Logger;
  mode: HookMode; current: string | null; tried: string[]; opening: string;
  transcript: string }): Promise<{ suggestions: HookSuggestion[]; attempted: boolean;
    latencyMs: number; error?: string }> {
  const started = Date.now();
  if ((process.env.EDIT_MODE_CHAT_LLM_ENABLED ?? 'true').toLowerCase() === 'false') {
    return { suggestions: [], attempted: false, latencyMs: 0 };
  }
  try {
    const telemetry = createPerformanceTelemetry(chatPlannerAiMode());
    const result = await performanceContext.run(telemetry, async () => {
      if (!input.llm.isAnyConfigured(CHAT_PLANNER_ROLE)) return null;
      return input.llm.generate<{ candidates?: Array<{ text?: unknown }> }>({
        role: CHAT_PLANNER_ROLE,
        request: {
          schemaName: 'edit_mode_chat_hook', schema: CHAT_HOOK_SCHEMA, role: CHAT_PLANNER_ROLE,
          systemPrompt: [
            'You write one short on-screen opening headline for a vertical video.',
            'Use only facts that are stated in the transcript excerpt. Never invent names,',
            'numbers, quotes or claims. No clickbait, no false urgency, no meta phrasing',
            'about "this video". 5 to 12 words. Return up to five different candidates.'
          ].join('\n'),
          userPrompt: [
            `Task: ${MODE_BRIEF[input.mode]}`,
            input.current ? `Current headline: "${input.current}"` : 'There is no headline yet.',
            input.tried.length ? `Already shown (do not repeat): ${input.tried
              .map((line) => `"${line}"`).join('; ')}` : '',
            '', 'Transcript opening:', input.opening.slice(0, 1500)
          ].filter(Boolean).join('\n'),
          options: { temperature: input.mode === 'ANOTHER' ? 0.8 : 0.5, maxOutputTokens: 500 }
        }
      });
    });
    if (!result) return { suggestions: [], attempted: false, latencyMs: Date.now() - started };
    const candidates = (result.data?.candidates ?? []).map((item) => String(item?.text ?? ''))
      .filter(Boolean).map((text) => ({ text, source: 'LLM' as const }));
    input.logger.log(JSON.stringify({ event: 'edit_mode_chat_hook_model',
      provider: result.metadata.provider, model: result.metadata.model,
      candidates: candidates.length, ms: Date.now() - started }));
    return { suggestions: rankHookCandidates({ mode: input.mode, current: input.current,
      tried: input.tried, transcript: input.transcript, candidates }), attempted: true,
    latencyMs: Date.now() - started };
  } catch (error) {
    return { suggestions: [], attempted: true, latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error) };
  }
}
