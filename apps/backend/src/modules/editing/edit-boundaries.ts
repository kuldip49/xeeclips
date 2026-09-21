import type { TimedWord } from './edit-plan';
import type { Cut } from './timeline-remap';

// Deterministic editorial boundaries for EDITED_CLIPS.
//
// The selected candidate is source material, not a locked range: this module
// generates several openings and several endings inside the padded editorial
// window, scores each one, and picks the pair that reads as one narrative unit
// (strong open -> enough context -> payoff -> clean close). Luna may nominate a
// stronger opening, the payoff end, and where a new topic begins; every
// suggestion is only accepted when it lands on a word boundary and survives the
// same scoring the deterministic candidates go through.

export const BOUNDARY_TUNING = {
  preRollSec: .1, endTailSec: .28, loopTailSec: .1,
  maxLeadInRemovalSec: 2.5, maxLeadInTokens: 4, maxLunaOpeningShiftSec: 4,
  maxContextExtensionSec: 3, maxEndTrimSec: 8, sentenceGapSec: .6,
  internalPauseSec: .75, keptPauseBeforeSec: .2, keptPauseAfterSec: .15,
  maxInternalRemovalSec: 4, maxInternalRemovalRatio: .15,
  minDurationSec: 10, minDurationRatio: .7, maxExtensionSec: 6, maxDurationSec: 120,
  // Ending repair cascade: first the tight window, then progressively wider ones,
  // only escalating when the tighter window found no clean semantic closure.
  endSearchTiersSec: [3, 8, 15],
  // How far forward a stronger attention opening may be looked for when the
  // selected opening is itself weak.
  openingSearchSec: 6,
  // Resolving "it"/"they" is worth more source than an ordinary mid-sentence
  // fix, so pulling the opening back to the sentence that names the subject
  // gets its own, larger budget.
  maxPronounContextExtensionSec: 6,
  // An alternative boundary has to be clearly better than the selected one
  // before it is taken. Without a margin, scoring noise would move every clip
  // for no real editorial gain.
  openingWinMargin: .75, endingWinMargin: .75,
  // A first word whose onset sits this close to the cut sounds chopped.
  minFirstWordPreRollSec: .03
} as const;

const norm = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '').replace(/'/gu, '');
const terminal = (text: string) => /[.!?]["')\]]*$/u.test(text.trim());
const question = (text: string) => /\?["')\]]*$/u.test(text.trim());
const comma = (text: string) => /[,;:—–-]["')\]]*$/u.test(text.trim());
// Pure disfluencies are always removable. Discourse markers are removable only
// at the very start of the clip.
const DISFLUENCIES = new Set(['um', 'uh', 'uhm', 'umm', 'erm', 'er', 'hmm', 'mm', 'ah']);
const LEAD_MARKERS = new Set(['so', 'well', 'basically', 'okay', 'ok', 'anyway', 'alright', 'yeah', 'and', 'now']);
const COMMA_MARKERS = new Set(['look', 'listen', 'like', 'right', 'see', 'actually']);
const PAIR_MARKERS = [['you', 'know'], ['i', 'mean'], ['i', 'think'], ['kind', 'of'], ['sort', 'of']];
const TRAILING_FILLERS = new Set([...DISFLUENCIES, 'so', 'yeah', 'right', 'okay', 'ok', 'and', 'but']);
const KEEP_AFTER_SO = new Set(['many', 'much', 'far', 'long', 'few', 'little', 'good', 'bad',
  'hard', 'easy', 'big', 'important', 'called', 'that', 'what', 'too']);
const KEEP_AFTER_NOW_AND = new Set(['that', 'yet', 'then', 'so', 'if']);
const WEAK_STARTS = new Set(['and', 'but', 'because', 'which', 'or', 'then', 'also', 'that']);
// Trailing tokens/phrases that signal the clip cuts into another thought rather
// than closing one. These are signals, not grammar rules: a heuristic stand-in
// for "does this sound like it leads into more" without an LLM in the loop.
const CONTINUATION_TRAILING_WORDS = new Set(['because', 'but', 'and', 'so', 'when', 'if', 'which', 'who',
  'that', 'or', 'then', 'as', 'while', 'though', 'although', 'since']);
const CONTINUATION_TRAILING_PHRASES: string[][] = [['and', 'so'], ['so', 'that'], ['i', 'told'],
  ['i', 'think'], ['i', 'mean'], ['the', 'reason'], ['people', 'like'], ['guys', 'like'],
  ['what', 'happens', 'is'], ['the', 'thing', 'is'], ['kind', 'of'], ['sort', 'of'],
  ['which', 'means'], ['what', 'happened', 'was'], ['the', 'reason', 'is']];

// --- Editorial lexicons ----------------------------------------------------
// Deterministic stand-ins for the judgements Luna makes when it is available.
// They are deliberately coarse: they rank candidates against each other inside
// one clip and are never used as absolute quality claims.
const ATTENTION_WORDS = new Set(['never', 'always', 'nobody', 'everyone', 'everything', 'nothing',
  'impossible', 'wrong', 'shocking', 'crazy', 'insane', 'secret', 'mistake', 'problem', 'truth',
  'actually', 'biggest', 'worst', 'best', 'banned', 'illegal', 'failed', 'destroyed', 'lost',
  'won', 'died', 'stopped', 'refused', 'admitted', 'lied', 'hidden', 'million', 'billion',
  'percent', 'why', 'how', 'what']);
const PAYOFF_WORDS = new Set(['never', 'always', 'nobody', 'everyone', 'everything', 'nothing',
  'impossible', 'changed', 'changes', 'destroyed', 'doubled', 'tripled', 'collapsed', 'banned',
  'won', 'lost', 'died', 'saved', 'failed', 'result', 'answer', 'truth', 'point', 'worse',
  'better', 'best', 'worst', 'only', 'million', 'billion', 'percent']);
const EMOTION_WORDS = new Set(['love', 'hate', 'scared', 'afraid', 'angry', 'furious', 'sad',
  'cried', 'crying', 'heartbreaking', 'painful', 'hurt', 'proud', 'ashamed', 'terrified',
  'shocked', 'devastated', 'beautiful', 'incredible', 'amazing', 'awful', 'terrible', 'worried',
  'hope', 'fear', 'dream', 'grateful', 'lonely']);
const CURIOSITY_PHRASES: string[][] = [['what', 'if'], ['the', 'reason'], ['turns', 'out'],
  ['nobody', 'tells'], ['nobody', 'talks'], ['here', 'is', 'why'], ['heres', 'why'],
  ['the', 'problem', 'is'], ['what', 'nobody'], ['most', 'people', 'think']];
// Openings that spend the viewer's attention on nothing.
const HOUSEKEEPING_PHRASES: string[][] = [['let', 'me', 'explain'], ['as', 'i', 'said'],
  ['like', 'i', 'said'], ['hey', 'guys'], ['welcome', 'back'], ['real', 'quick'],
  ['let', 'me', 'start'], ['thanks', 'for'], ['before', 'we', 'get'],
  ['going', 'to', 'talk', 'about'], ['first', 'of', 'all'], ['as', 'we', 'discussed'],
  ['coming', 'back', 'to']];
// Personal pronouns always need an antecedent the viewer has not seen.
const OPENING_PRONOUNS = new Set(['it', 'they', 'them', 'he', 'she', 'him', 'her',
  'their', 'its', 'his', 'theirs', 'hers']);
// Demonstratives only dangle when nothing follows them: "that decision" names
// its own subject, "that was huge" does not.
const OPENING_DEMONSTRATIVES = new Set(['this', 'that', 'those', 'these']);
// A new subject starting right after a satisfying payoff: end before it (§16).
const NEW_TOPIC_WORDS = new Set(['anyway', 'anyways', 'meanwhile', 'separately', 'elsewhere']);
const NEW_TOPIC_PHRASES: string[][] = [['by', 'the', 'way'], ['moving', 'on'], ['another', 'thing'],
  ['speaking', 'of'], ['on', 'another', 'note'], ['switching', 'gears'], ['one', 'more', 'thing'],
  ['the', 'next', 'thing'], ['so', 'anyway'], ['but', 'anyway'], ['lets', 'talk', 'about'],
  ['now', 'lets'], ['which', 'reminds', 'me'], ['changing', 'the', 'subject'],
  ['let', 'me', 'tell', 'you', 'about'], ['the', 'other', 'thing'], ['back', 'to', 'the']];
// Phrasing that closes a thought rather than handing off to the next one.
const CONCLUSION_PHRASES: string[][] = [['thats', 'why'], ['thats', 'the'], ['in', 'the', 'end'],
  ['at', 'the', 'end', 'of', 'the', 'day'], ['bottom', 'line'], ['thats', 'it'], ['and', 'thats'],
  ['which', 'is', 'why'], ['so', 'thats'], ['thats', 'what'], ['end', 'of', 'story'],
  ['thats', 'how'], ['in', 'other', 'words']];
const CONCLUSION_WORDS = new Set(['finally', 'ultimately', 'forever', 'period', 'done', 'over',
  'gone', 'simple']);

const NUMBER_WORDS = /^(one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion|half|double|triple)$/u;
const hasNumber = (text: string) => /\d/u.test(text) || NUMBER_WORDS.test(norm(text));
// Does the token run start with this phrase?
const matchesPhrase = (tokens: string[], phrases: string[][]) => phrases.some((phrase) =>
  phrase.length <= tokens.length && phrase.every((token, index) => token === tokens[index]));
// Does the phrase occur anywhere in the token run?
const containsPhrase = (tokens: string[], phrases: string[][]) => phrases.some((phrase) =>
  tokens.some((_, offset) => phrase.length + offset <= tokens.length &&
    phrase.every((token, index) => token === tokens[offset + index])));

function endsWithContinuation(words: TimedWord[], index: number) {
  if (CONTINUATION_TRAILING_WORDS.has(norm(words[index].text))) return true;
  for (const phrase of CONTINUATION_TRAILING_PHRASES) {
    if (index - phrase.length + 1 < 0) continue;
    const tail = words.slice(index - phrase.length + 1, index + 1).map((word) => norm(word.text));
    if (tail.every((token, position) => token === phrase[position])) return true;
  }
  return false;
}

export type OpeningStrategy = 'COLD_OPEN_PAYOFF' | 'QUESTION_OPEN' | 'CONFLICT_OPEN' |
  'SURPRISE_OPEN' | 'STORY_OPEN' | 'INSIGHT_OPEN' | 'CONTEXT_OPEN';
export type EndingStrategy = 'PAYOFF_CLOSE' | 'CONCLUSION_CLOSE' | 'SENTENCE_CLOSE' |
  'NEW_TOPIC_TRIMMED' | 'SELECTED_CLOSE' | 'UNRESOLVED_CLOSE';
// How badly the ending misses a complete thought. SERIOUS means the clip stops
// mid-sentence or mid-thought, which §31 treats as a blocking editorial defect
// rather than a cosmetic one.
export type EndingDefectSeverity = 'NONE' | 'MINOR' | 'SERIOUS';

export type BoundaryHints = { hookStartSec?: number | null; payoffEndSec?: number | null;
  loopSuitable?: boolean;
  // Luna's editorial reading of the moment: the earliest second the viewer needs
  // for the clip to make sense, and where a new subject begins.
  contextRequiredFromSec?: number | null; newTopicBeginsAfterSec?: number | null };

export type ScoredBoundary = { sec: number; score: number; origin: string;
  components: Record<string, number> };

export type BoundaryDecision = {
  editedStart: number; editedEnd: number; cuts: Cut[];
  startWordIndex: number; endWordIndex: number;
  removedLeadIn: string[]; leadInRemovedMs: number;
  openingReason: string; endingReason: string;
  lunaOpeningApplied: boolean; lunaEndingApplied: boolean;
  contextExtendedStartMs: number; contextExtendedEndMs: number;
  internalPauseRemovedMs: number; fillerRemovedCount: number;
  clipStartStrong: boolean; clipStartNatural: boolean;
  clipEndComplete: boolean; clipEndNatural: boolean;
  deadAirAtEndMs: number; deadAirAtStartMs: number;
  tailSec: number;
  originalEndSec: number; optimizedEndSec: number; endAdjustmentSec: number;
  endSemanticComplete: boolean; endThoughtResolved: boolean; endNotContinuation: boolean;
  endNoWordCut: boolean; endRepairAttempted: boolean; endRepairSucceeded: boolean;
  // --- start quality (§28) ---
  originalStartSec: number; optimizedStartSec: number; startAdjustmentSec: number;
  clipStartContextComplete: boolean; clipFirstWordNotClipped: boolean;
  firstWordPreRollMs: number; firstWordPreRollAvailableMs: number;
  weakLeadInRemovedOrJustified: boolean;
  openingRepairAttempted: boolean; openingRepairSucceeded: boolean;
  // --- end quality (§29) ---
  clipEndNoNewTopicLeak: boolean; clipEndPayoffDelivered: boolean;
  endingDefectSeverity: EndingDefectSeverity;
  // --- telemetry (§40) ---
  openingStrategy: OpeningStrategy; openingScore: number;
  openingScoreComponents: Record<string, number>;
  endingStrategy: EndingStrategy; endingScore: number;
  endingScoreComponents: Record<string, number>;
  contextExpandedSec: number; weakLeadRemovedSec: number;
  payoffPreserved: boolean; newTopicTrimmed: boolean;
  openingCandidates: ScoredBoundary[]; endingCandidates: ScoredBoundary[];
};

export function isWeakOpeningWord(text: string) {
  const token = norm(text);
  return DISFLUENCIES.has(token) || LEAD_MARKERS.has(token) || WEAK_STARTS.has(token);
}

function sentenceStartAt(words: TimedWord[], index: number) {
  if (index <= 0) return true;
  const previous = words[index - 1];
  return terminal(previous.text) || words[index].start - previous.end >= BOUNDARY_TUNING.sentenceGapSec;
}

// The words of the sentence beginning at `index` (bounded, so a run-on does not
// drag the whole clip into the score).
function sentenceFrom(words: TimedWord[], index: number, limit = 22) {
  const out: TimedWord[] = [];
  for (let i = index; i < words.length && out.length < limit; i++) {
    out.push(words[i]);
    if (terminal(words[i].text)) break;
  }
  return out;
}

// The words of the sentence ending at `index`, walking back to its start.
function sentenceEndingAt(words: TimedWord[], index: number, limit = 22) {
  let start = index;
  while (start > 0 && !sentenceStartAt(words, start) && index - start < limit) start--;
  return words.slice(start, index + 1);
}

// Returns how many tokens at `index` form a removable lead-in marker (0 if none).
function leadInLength(words: TimedWord[], index: number): number {
  const word = words[index];
  const next = words[index + 1];
  if (!word || !next) return 0;
  const token = norm(word.text);
  const pause = next.start - word.end;
  if (DISFLUENCIES.has(token)) return 1;
  // "So many", "Now that", "And yet" carry meaning; keep them.
  if (token === 'so' && !comma(word.text) && KEEP_AFTER_SO.has(norm(next.text))) return 0;
  if ((token === 'now' || token === 'and') && !comma(word.text) &&
    KEEP_AFTER_NOW_AND.has(norm(next.text))) return 0;
  if (LEAD_MARKERS.has(token)) return 1;
  if (COMMA_MARKERS.has(token) && (comma(word.text) || pause >= .15)) return 1;
  for (const pair of PAIR_MARKERS) {
    const second = words[index + 1];
    const after = words[index + 2];
    if (token === pair[0] && second && norm(second.text) === pair[1] && after &&
      (comma(second.text) || after.start - second.end >= .15)) return 2;
  }
  return 0;
}

// The pre-roll the source can actually give: whisper sometimes ends the
// previous word after this one starts, and the window itself can begin later
// than the ideal pre-roll.
function availablePreRollSec(words: TimedWord[], index: number, windowStart: number) {
  const previousEnd = index > 0 ? words[index - 1].end + .02 : -Infinity;
  return words[index].start - Math.max(windowStart, previousEnd);
}

function clampStart(words: TimedWord[], index: number, windowStart: number) {
  const word = words[index];
  const previousEnd = index > 0 ? words[index - 1].end + .02 : -Infinity;
  // Never past the word's own onset: when the previous word's timestamp runs
  // into this one there is no room for pre-roll, and a short opening is far
  // better than a chopped consonant.
  return Math.min(word.start,
    Math.max(windowStart, previousEnd, word.start - BOUNDARY_TUNING.preRollSec));
}

function clampEnd(words: TimedWord[], index: number, windowEnd: number, tail: number) {
  const word = words[index];
  const nextStart = index + 1 < words.length ? words[index + 1].start - .03 : Infinity;
  return Math.min(windowEnd, nextStart, word.end + tail);
}

// Does the sentence starting here open on an unresolved pronoun? ("...and
// that's why they banned it." tells a cold viewer nothing about what "it" is.)
function opensOnUnresolvedPronoun(sentence: TimedWord[]) {
  const tokens = sentence.map((word) => norm(word.text));
  const lead = tokens.slice(0, 3);
  if (lead.some((token) => OPENING_PRONOUNS.has(token))) return true;
  const at = lead.findIndex((token) => OPENING_DEMONSTRATIVES.has(token));
  if (at < 0) return false;
  // A noun right after the demonstrative resolves it ("that number", "this
  // decision"); a verb or another pronoun leaves it dangling.
  const next = tokens[at + 1];
  return !(next && !OPENING_PRONOUNS.has(next) && !OPENING_DEMONSTRATIVES.has(next) &&
    next.length > 3 &&
    !['is', 'was', 'were', 'are', 'will', 'would', 'had', 'has', 'have', 'did', 'does',
      'said', 'says', 'went', 'got', 'just', 'also', 'really', 'never', 'always']
      .includes(next));
}

type OpeningOrigin = 'SELECTED' | 'CONTEXT_EXTENDED' | 'LUNA' | 'ATTENTION';

function openingStrategyFor(sentence: TimedWord[]): OpeningStrategy {
  const tokens = sentence.map((word) => norm(word.text));
  if (sentence.some((word) => question(word.text)) ||
    ['why', 'how', 'what', 'who', 'when'].includes(tokens[0] ?? '')) return 'QUESTION_OPEN';
  if (tokens.some((token) => ['wrong', 'disagree', 'nonsense', 'lie', 'lied', 'false', 'refuse',
    'refused'].includes(token))) return 'CONFLICT_OPEN';
  if (tokens.some((token) => ['never', 'nobody', 'impossible', 'shocking', 'crazy', 'insane',
    'secret', 'actually'].includes(token))) return 'SURPRISE_OPEN';
  if (sentence.some((word) => hasNumber(word.text)) ||
    tokens.some((token) => PAYOFF_WORDS.has(token))) return 'COLD_OPEN_PAYOFF';
  if (tokens.some((token) => EMOTION_WORDS.has(token)) ||
    tokens.some((token) => ['i', 'we', 'my', 'our'].includes(token))) return 'STORY_OPEN';
  if (containsPhrase(tokens, CURIOSITY_PHRASES)) return 'INSIGHT_OPEN';
  return 'CONTEXT_OPEN';
}

// An opening that spends the viewer's first seconds on throat-clearing.
function isHousekeepingOpening(sentence: TimedWord[]) {
  const tokens = sentence.map((word) => norm(word.text));
  return matchesPhrase(tokens, HOUSEKEEPING_PHRASES) ||
    containsPhrase(tokens.slice(0, 5), HOUSEKEEPING_PHRASES);
}

function scoreOpening(words: TimedWord[], index: number, context: {
  baseIndex: number; endIndex: number; origin: OpeningOrigin;
  contextRequiredIndex: number | null;
  // Where the candidate sat before its weak lead-in was trimmed. Trimming a
  // marker off the front of a sentence leaves a natural opening, so naturalness
  // is judged at the sentence the words came from, not at the trimmed word.
  anchorIndex: number;
}) {
  const sentence = sentenceFrom(words, index);
  const tokens = sentence.map((word) => norm(word.text));
  const lead = tokens.slice(0, 8);
  const first = words[index];
  const attentionHits = lead.filter((token) => ATTENTION_WORDS.has(token)).length +
    (sentence.slice(0, 8).some((word) => hasNumber(word.text)) ? 1 : 0);
  const naturalStart = sentenceStartAt(words, index) || sentenceStartAt(words, context.anchorIndex);
  const unresolved = opensOnUnresolvedPronoun(sentence);
  const housekeeping = isHousekeepingOpening(sentence);
  // Luna said the viewer needs context from here on; starting later loses it.
  const cutsRequiredContext = context.contextRequiredIndex != null &&
    index > context.contextRequiredIndex;
  const gapBefore = index > 0 ? Math.max(0, first.start - words[index - 1].end) : 0;
  const components = {
    attentionStrength: Math.min(2, attentionHits * .8),
    contextCompleteness: (naturalStart ? 1.2 : 0) + (unresolved ? 0 : .8) +
      (cutsRequiredContext ? -1.5 : 0),
    speechNaturalness: naturalStart ? 1 : /^[\p{Lu}\p{N}]/u.test(first.text.trim()) ? .5 : 0,
    firstSentenceStrength: (sentence.length >= 4 ? .6 : 0) + (housekeeping ? -1.6 : .4),
    curiosity: (sentence.some((word) => question(word.text)) ? .8 : 0) +
      (containsPhrase(lead, CURIOSITY_PHRASES) ? .7 : 0),
    emotionalPull: lead.some((token) => EMOTION_WORDS.has(token)) ? .6 : 0,
    // A start that still leaves room before the payoff can set it up; one that
    // lands on the last sentence has nothing left to build.
    payoffSetup: context.endIndex - index >= 8 ? .5 : 0,
    // Only the tokens the viewer hears first count: a discourse marker in the
    // middle of a sentence is normal speech, not a weak opening.
    fillerPenalty: -tokens.slice(0, 3).filter((token) => DISFLUENCIES.has(token) ||
      LEAD_MARKERS.has(token)).length * .5,
    silencePenalty: gapBefore > 1.2 ? -.4 : 0,
    continuationPenalty: WEAK_STARTS.has(tokens[0] ?? '') ? -1.2 : 0,
    pronounWithoutContextPenalty: unresolved ? -1.6 : 0,
    // Moving the opening away from the selected one has to earn its keep, and
    // moving it later is the expensive direction: going back adds context the
    // viewer needs, going forward throws away the setup the payoff rests on.
    shiftPenalty: (() => {
      const shift = first.start - words[context.baseIndex].start;
      return -Math.min(1.2, Math.abs(shift) * (shift > 0 ? .25 : .08));
    })(),
    // Luna's editorial read counts, but only as a preference among valid options.
    lunaBonus: context.origin === 'LUNA' ? 2 : 0
  };
  const score = Object.values(components).reduce((sum, value) => sum + value, 0);
  return { score: Number(score.toFixed(3)), components, strategy: openingStrategyFor(sentence),
    contextComplete: naturalStart && !unresolved && !cutsRequiredContext };
}

type EndingOrigin = 'SELECTED' | 'LUNA' | 'BACKWARD' | 'FORWARD' | 'NEW_TOPIC';

// Does a new subject start at `index` (i.e. right after a candidate ending)?
function newTopicStartsAt(words: TimedWord[], index: number) {
  if (index >= words.length) return false;
  const tokens = words.slice(index, index + 6).map((word) => norm(word.text));
  return NEW_TOPIC_WORDS.has(tokens[0] ?? '') || matchesPhrase(tokens, NEW_TOPIC_PHRASES);
}

// Whisper does not always punctuate: long stretches of a real transcript can
// arrive without a single full stop. A clear pause is then the only sentence
// boundary available, and it is a far better closure than stopping mid-breath.
function pauseClosureAt(words: TimedWord[], index: number) {
  if (index + 1 >= words.length) return true;
  return words[index + 1].start - words[index].end >= BOUNDARY_TUNING.sentenceGapSec;
}

function scoreEnding(words: TimedWord[], index: number, context: {
  baseIndex: number; origin: EndingOrigin; newTopicIndex: number | null;
}) {
  const sentence = sentenceEndingAt(words, index);
  const tokens = sentence.map((word) => norm(word.text));
  const last = words[index];
  const complete = terminal(last.text);
  const continuation = endsWithContinuation(words, index);
  // Partial credit only: a pause says the speaker stopped, not that the thought
  // finished, so it never scores as high as real punctuation.
  const paused = !complete && pauseClosureAt(words, index);
  const payoffHits = tokens.filter((token) => PAYOFF_WORDS.has(token)).length +
    (sentence.some((word) => hasNumber(word.text)) ? 1 : 0);
  const conclusion = containsPhrase(tokens, CONCLUSION_PHRASES) ||
    tokens.some((token) => CONCLUSION_WORDS.has(token));
  const unresolvedQuestion = question(last.text) && !conclusion;
  // Speech continuing straight past this point without a beat sounds cut off.
  const gapAfter = index + 1 < words.length ? words[index + 1].start - last.end : Infinity;
  // Keeping speech that belongs to the next subject leaks a new topic in (§16).
  const leaksNewTopic = context.newTopicIndex != null && index >= context.newTopicIndex;
  const components = {
    semanticCompleteness: complete ? 1.8 : paused ? .9 : 0,
    naturalCadence: (gapAfter >= .35 ? .8 : gapAfter >= .15 ? .3 : 0) +
      (TRAILING_FILLERS.has(norm(last.text)) ? -.6 : 0),
    payoffStrength: Math.min(1.6, payoffHits * .7),
    topicClosure: conclusion ? .9 : 0,
    contextResolution: sentence.length >= 4 ? .4 : 0,
    abruptnessPenalty: complete ? 0 : paused ? -.5 : -1.8,
    continuationPenalty: continuation ? -2 : 0,
    // A pause this long after the last word reads as dead air, not a beat.
    deadAirPenalty: gapAfter !== Infinity && gapAfter > 1.5 ? -.3 : 0,
    newTopicPenalty: leaksNewTopic ? -2.2 : 0,
    unresolvedQuestionPenalty: unresolvedQuestion ? -.8 : 0,
    // Same asymmetry at the end: trimming back drops delivered content, while
    // extending forward only finishes the thought the clip already started.
    shiftPenalty: (() => {
      const shift = last.end - words[context.baseIndex].end;
      return -Math.min(1.5, Math.abs(shift) * (shift < 0 ? .25 : .1));
    })(),
    // §16: stopping on the last clean closure before the speaker moves on is
    // the deliberate editorial choice, not a coincidence of proximity.
    newTopicBonus: context.origin === 'NEW_TOPIC' ? 1 : 0,
    lunaBonus: context.origin === 'LUNA' ? 1.8 : 0
  };
  const score = Object.values(components).reduce((sum, value) => sum + value, 0);
  const strategy: EndingStrategy = context.origin === 'NEW_TOPIC' ? 'NEW_TOPIC_TRIMMED' :
    !complete || continuation ? 'UNRESOLVED_CLOSE' :
      conclusion ? 'CONCLUSION_CLOSE' : payoffHits > 0 ? 'PAYOFF_CLOSE' : 'SENTENCE_CLOSE';
  return { score: Number(score.toFixed(3)), components, strategy, complete, paused,
    continuation, payoffDelivered: payoffHits > 0 || conclusion, leaksNewTopic };
}

export function optimizeEditBoundaries(input: {
  words: TimedWord[]; candidateStart: number; candidateEnd: number;
  windowStart: number; windowEnd: number; hints?: BoundaryHints; planCuts?: Cut[];
}): BoundaryDecision {
  const tuning = BOUNDARY_TUNING;
  const { candidateStart, candidateEnd, windowStart, windowEnd } = input;
  const words = input.words.filter((word) => Number.isFinite(word.start) &&
    Number.isFinite(word.end) && word.end > word.start && word.text.trim() &&
    word.start >= windowStart - .001 && word.end <= windowEnd + .001)
    .sort((a, b) => a.start - b.start);
  const rawDuration = candidateEnd - candidateStart;
  const minDuration = Math.min(rawDuration * .85, Math.max(tuning.minDurationSec, rawDuration * tuning.minDurationRatio));
  const maxDuration = Math.min(tuning.maxDurationSec, rawDuration + tuning.maxExtensionSec);
  const hints = input.hints ?? {};
  const inRaw = words.map((word, index) => ({ word, index })).filter(({ word }) =>
    word.end > candidateStart + .02 && word.start < candidateEnd - .02);
  if (!inRaw.length) {
    // No timed speech: keep the selected range untouched.
    return { editedStart: candidateStart, editedEnd: candidateEnd, cuts: [],
      startWordIndex: -1, endWordIndex: -1, removedLeadIn: [], leadInRemovedMs: 0,
      openingReason: 'NO_TIMED_WORDS', endingReason: 'NO_TIMED_WORDS',
      lunaOpeningApplied: false, lunaEndingApplied: false,
      contextExtendedStartMs: 0, contextExtendedEndMs: 0, internalPauseRemovedMs: 0,
      fillerRemovedCount: 0, clipStartStrong: false, clipStartNatural: true,
      clipEndComplete: false, clipEndNatural: true, deadAirAtEndMs: 0,
      deadAirAtStartMs: 0, tailSec: 0,
      originalEndSec: candidateEnd, optimizedEndSec: candidateEnd, endAdjustmentSec: 0,
      endSemanticComplete: false, endThoughtResolved: false, endNotContinuation: true,
      endNoWordCut: true, endRepairAttempted: false, endRepairSucceeded: false,
      originalStartSec: candidateStart, optimizedStartSec: candidateStart, startAdjustmentSec: 0,
      clipStartContextComplete: true, clipFirstWordNotClipped: true, firstWordPreRollMs: 0,
      firstWordPreRollAvailableMs: 0, weakLeadInRemovedOrJustified: true,
      openingRepairAttempted: false, openingRepairSucceeded: false,
      clipEndNoNewTopicLeak: true, clipEndPayoffDelivered: false,
      // Without word timings nothing can be verified; that is a known unknown,
      // not a clean pass, so it degrades rather than fails the clip.
      endingDefectSeverity: 'MINOR',
      openingStrategy: 'CONTEXT_OPEN', openingScore: 0, openingScoreComponents: {},
      endingStrategy: 'SELECTED_CLOSE', endingScore: 0, endingScoreComponents: {},
      contextExpandedSec: 0, weakLeadRemovedSec: 0, payoffPreserved: false,
      newTopicTrimmed: false, openingCandidates: [], endingCandidates: [] };
  }
  const baseStartIndex = inRaw[0].index;
  const baseEndIndex = inRaw[inRaw.length - 1].index;
  const loop = hints.loopSuitable === true;
  const tailSec = loop ? tuning.loopTailSec : tuning.endTailSec;

  const timeToIndex = (sec: number | null | undefined, tolerance: number) => {
    if (typeof sec !== 'number' || !Number.isFinite(sec)) return null;
    let best = -1;
    let bestDistance = tolerance;
    for (let index = 0; index < words.length; index++) {
      const distance = Math.abs(words[index].start - sec);
      if (distance <= bestDistance) { best = index; bestDistance = distance; }
    }
    return best >= 0 ? best : null;
  };
  const contextRequiredIndex = timeToIndex(hints.contextRequiredFromSec, .6);
  const lunaNewTopicIndex = timeToIndex(hints.newTopicBeginsAfterSec, .8);

  // ---------------------------------------------------------------- OPENINGS
  // openingA: the earliest clean contextual opening (back to the sentence start).
  // openingB: the strongest attention moment Luna or the lexicons can find.
  // openingC: the selected opening itself.
  // Each candidate has its weak lead-in trimmed before scoring, so the
  // comparison is between finished openings rather than raw ones.
  const rawOpenings: Array<{ index: number; origin: OpeningOrigin }> = [
    { index: baseStartIndex, origin: 'SELECTED' }];
  if (!sentenceStartAt(words, baseStartIndex)) {
    let back = baseStartIndex;
    while (back > 0 && !sentenceStartAt(words, back)) back--;
    const extension = words[baseStartIndex].start - words[back].start;
    if (sentenceStartAt(words, back) && extension <= tuning.maxContextExtensionSec)
      rawOpenings.push({ index: back, origin: 'CONTEXT_EXTENDED' });
  }
  // Luna's stronger opening, considered only at a sentence boundary.
  const hookStart = hints.hookStartSec;
  if (typeof hookStart === 'number' && Number.isFinite(hookStart) &&
    hookStart > words[baseStartIndex].start + .15) {
    const target = words.findIndex((word, index) => index > baseStartIndex &&
      Math.abs(word.start - hookStart) <= .35);
    if (target > baseStartIndex && sentenceStartAt(words, target) &&
      words[target].start - words[baseStartIndex].start <= tuning.maxLunaOpeningShiftSec)
      rawOpenings.push({ index: target, origin: 'LUNA' });
  }
  // The start of the sentence at or before `from`.
  const sentenceStartIndexAt = (from: number) => {
    let index = Math.max(0, Math.min(from, words.length - 1));
    while (index > 0 && !sentenceStartAt(words, index)) index--;
    return index;
  };
  const baseSentence = sentenceFrom(words, baseStartIndex);
  // §3/§25: a strong start the viewer cannot follow is a bad start. When the
  // opening leans on a pronoun with no antecedent, or Luna marked the required
  // context as starting earlier, the preceding sentences become candidates too.
  const needsEarlierContext = opensOnUnresolvedPronoun(baseSentence) ||
    (contextRequiredIndex != null && contextRequiredIndex < baseStartIndex);
  if (needsEarlierContext) {
    let index = baseStartIndex;
    while (index > 0) {
      index = sentenceStartIndexAt(index - 1);
      if (words[baseStartIndex].start - words[index].start > tuning.maxPronounContextExtensionSec) break;
      rawOpenings.push({ index, origin: 'CONTEXT_EXTENDED' });
      // One sentence past the required context is enough; nothing earlier helps.
      if (contextRequiredIndex != null && index <= contextRequiredIndex) break;
      if (!opensOnUnresolvedPronoun(sentenceFrom(words, index)) && contextRequiredIndex == null) break;
    }
  }
  // A deterministic attention opening, but only when the selected one is itself
  // weak: a clip that already opens well must not be shuffled for scoring noise.
  if (isWeakOpeningWord(words[baseStartIndex].text) ||
    opensOnUnresolvedPronoun(baseSentence) || isHousekeepingOpening(baseSentence))
    for (let index = baseStartIndex + 1; index < words.length; index++) {
      if (words[index].start - words[baseStartIndex].start > tuning.openingSearchSec) break;
      if (sentenceStartAt(words, index)) rawOpenings.push({ index, origin: 'ATTENTION' });
    }

  // Weak lead-in removal, applied per candidate (never more than a few tokens).
  const trimLeadIn = (from: number) => {
    let index = from;
    const removed: string[] = [];
    const leadStart = words[from].start;
    while (removed.length < tuning.maxLeadInTokens) {
      const length = leadInLength(words, index);
      if (!length || index + length > baseEndIndex) break;
      const next = words[index + length];
      if (next.start - leadStart > tuning.maxLeadInRemovalSec) break;
      removed.push(...words.slice(index, index + length).map((word) => word.text));
      index += length;
    }
    return { index, removed };
  };

  type Opening = { index: number; origin: OpeningOrigin; removed: string[]; fromIndex: number } &
    ReturnType<typeof scoreOpening>;
  const score = (index: number, origin: OpeningOrigin, anchorIndex = index) =>
    scoreOpening(words, index, { baseIndex: baseStartIndex, endIndex: baseEndIndex, origin,
      contextRequiredIndex, anchorIndex });
  const openings: Opening[] = [];
  const seenOpening = new Set<number>();
  for (const candidate of rawOpenings) {
    const trimmed = trimLeadIn(candidate.index);
    // Trimming is only taken when the clip that survives it is still viable.
    const keepTrim = words[baseEndIndex].end - words[trimmed.index].start >= minDuration;
    const index = keepTrim ? trimmed.index : candidate.index;
    const removed = keepTrim ? trimmed.removed : [];
    const span = words[baseEndIndex].end - words[index].start;
    if (span < minDuration * .6 || span > maxDuration) continue;
    if (seenOpening.has(index)) continue;
    seenOpening.add(index);
    openings.push({ index, origin: candidate.origin, removed, fromIndex: candidate.index,
      ...score(index, candidate.origin, candidate.index) });
  }
  if (!openings.length) openings.push({ index: baseStartIndex, origin: 'SELECTED', removed: [],
    fromIndex: baseStartIndex, ...score(baseStartIndex, 'SELECTED') });
  const selectedOpening = openings.find((item) => item.fromIndex === baseStartIndex &&
    item.origin === 'SELECTED');
  const bestOpening = [...openings].sort((a, b) => b.score - a.score)[0];
  const opening = selectedOpening && bestOpening !== selectedOpening &&
    bestOpening.score < selectedOpening.score + tuning.openingWinMargin ?
    selectedOpening : bestOpening;
  const startIndex = opening.index;
  const removedLeadIn = opening.removed;
  const contextExtendedStartMs = opening.origin === 'CONTEXT_EXTENDED' ?
    Math.round(Math.max(0, words[baseStartIndex].start - words[opening.fromIndex].start) * 1000) : 0;
  const lunaOpeningApplied = opening.origin === 'LUNA';
  const openingBase = opening.origin === 'CONTEXT_EXTENDED' ? 'CONTEXT_EXTENDED_TO_SENTENCE_START' :
    opening.origin === 'LUNA' ? 'LUNA_STRONGER_OPENING' :
      opening.origin === 'ATTENTION' ? 'STRONGER_ATTENTION_OPENING' : 'SELECTED_START';
  const openingReason = removedLeadIn.length ?
    (openingBase === 'SELECTED_START' ? 'WEAK_LEAD_IN_REMOVED' :
      `${openingBase}+WEAK_LEAD_IN_REMOVED`) : openingBase;
  const leadInRemovedMs = removedLeadIn.length ?
    Math.round((words[startIndex].start - words[opening.fromIndex].start) * 1000) : 0;
  // The opening was repaired when the selected one could not stand on its own.
  const selectedUsable = Boolean(selectedOpening && selectedOpening.contextComplete &&
    !isWeakOpeningWord(words[baseStartIndex].text));
  const openingRepairAttempted = !selectedUsable;
  const openingRepairSucceeded = openingRepairAttempted && opening.contextComplete &&
    !isWeakOpeningWord(words[startIndex].text);

  // ----------------------------------------------------------------- ENDINGS
  // "Clean" means terminal punctuation AND not a continuation phrase -
  // punctuation alone is not trusted, since a clip cut mid-thought can still
  // land on a Whisper-punctuated word.
  const isCleanEnding = (index: number) => terminal(words[index].text) && !endsWithContinuation(words, index);
  const durationOk = (index: number) => {
    const span = words[index].end - words[startIndex].start;
    return span >= minDuration && span <= maxDuration;
  };
  // Where the speaker moves on: Luna's read, or the first deterministic
  // new-topic marker that follows a clean closure.
  let newTopicIndex: number | null = lunaNewTopicIndex != null &&
    lunaNewTopicIndex > startIndex + 1 ? lunaNewTopicIndex : null;
  if (newTopicIndex == null)
    for (let index = startIndex + 2; index < words.length; index++) {
      if (words[index].start - words[baseEndIndex].end > tuning.endSearchTiersSec[2]) break;
      if (newTopicStartsAt(words, index) && sentenceStartAt(words, index) &&
        isCleanEnding(index - 1)) { newTopicIndex = index; break; }
    }

  const rawEndings: Array<{ index: number; origin: EndingOrigin }> = [
    { index: baseEndIndex, origin: 'SELECTED' }];
  const payoff = hints.payoffEndSec;
  if (typeof payoff === 'number' && Number.isFinite(payoff)) {
    const target = words.findIndex((word, index) => index > startIndex &&
      Math.abs(word.end - payoff) <= .35 && isCleanEnding(index));
    if (target > startIndex &&
      Math.abs(words[target].end - words[baseEndIndex].end) <= tuning.maxEndTrimSec)
      rawEndings.push({ index: target, origin: 'LUNA' });
  }
  if (newTopicIndex != null && newTopicIndex - 1 > startIndex && isCleanEnding(newTopicIndex - 1))
    rawEndings.push({ index: newTopicIndex - 1, origin: 'NEW_TOPIC' });
  const widest = tuning.endSearchTiersSec[tuning.endSearchTiersSec.length - 1];
  // Does the search window contain any punctuated closure at all? When it does
  // not, the transcript is unpunctuated here and pauses become the fallback.
  const punctuationAvailable = words.some((_, index) =>
    index > startIndex && Math.abs(words[index].end - words[baseEndIndex].end) <= widest &&
    isCleanEnding(index));
  const isUsableEnding = (index: number) => isCleanEnding(index) ||
    (!punctuationAvailable && pauseClosureAt(words, index) && !endsWithContinuation(words, index));
  // endingA/B/C: every clean closure inside the progressive search windows, in
  // both directions. Scoring, not proximity alone, then picks between them.
  for (let index = baseEndIndex - 1; index > startIndex; index--) {
    if (words[baseEndIndex].end - words[index].end > Math.min(widest, tuning.maxEndTrimSec)) break;
    if (isUsableEnding(index)) rawEndings.push({ index, origin: 'BACKWARD' });
  }
  for (let index = baseEndIndex + 1; index < words.length; index++) {
    // Only extend across natural speech: a long silence means the thought is over.
    if (words[index].start - words[index - 1].end >= 1.2) break;
    if (words[index].end - words[baseEndIndex].end > widest) break;
    if (isUsableEnding(index)) rawEndings.push({ index, origin: 'FORWARD' });
  }

  type Ending = { index: number; origin: EndingOrigin } & ReturnType<typeof scoreEnding>;
  const endings: Ending[] = [];
  const seenEnding = new Set<number>();
  for (const candidate of rawEndings) {
    // The selected ending always stays in the pool: even when nothing better
    // exists it has to be scored, not silently inherited.
    if (candidate.index !== baseEndIndex && !durationOk(candidate.index)) continue;
    if (seenEnding.has(candidate.index)) continue;
    seenEnding.add(candidate.index);
    endings.push({ index: candidate.index, origin: candidate.origin,
      ...scoreEnding(words, candidate.index,
        { baseIndex: baseEndIndex, origin: candidate.origin, newTopicIndex }) });
  }
  const selectedEnding = endings.find((item) => item.index === baseEndIndex);
  const bestEnding = [...endings].sort((a, b) => b.score - a.score)[0];
  const ending = selectedEnding && bestEnding !== selectedEnding &&
    bestEnding.score < selectedEnding.score + tuning.endingWinMargin ?
    selectedEnding : bestEnding;
  let endIndex = ending.index;
  const lunaEndingApplied = ending.origin === 'LUNA';
  const baseWasClean = isCleanEnding(baseEndIndex);
  const withinFirstTier = Math.abs(words[endIndex].end - words[baseEndIndex].end) <=
    tuning.endSearchTiersSec[0];
  const contextExtendedEndMs = endIndex > baseEndIndex ?
    Math.round((words[endIndex].end - words[baseEndIndex].end) * 1000) : 0;
  let endingReason: string;
  if (lunaEndingApplied) endingReason = 'LUNA_PAYOFF_END';
  else if (ending.origin === 'NEW_TOPIC') endingReason = 'ENDING_TRIMMED_BEFORE_NEW_TOPIC';
  else if (endIndex === baseEndIndex) endingReason = baseWasClean ? 'SELECTED_END' : 'SELECTED_END_UNRESOLVED';
  else if (endIndex > baseEndIndex) endingReason = baseWasClean ? 'ENDING_EXTENDED_TO_STRONGER_CLOSE' :
    withinFirstTier ? 'CONTEXT_EXTENDED_TO_COMPLETE_THOUGHT' : 'END_REPAIR_EXTENDED_TO_COMPLETE_THOUGHT';
  else endingReason = baseWasClean ? 'ENDING_TRIMMED_TO_STRONGER_CLOSE' :
    withinFirstTier ? 'INCOMPLETE_TAIL_TRIMMED' : 'END_REPAIR_TRIMMED_TO_COMPLETE_THOUGHT';
  const endRepairAttempted = !baseWasClean;
  const endRepairSucceeded = endRepairAttempted && ending.complete && !ending.continuation;

  // A trailing "so", "and" or "yeah" after a finished sentence is dead weight.
  while (endIndex > startIndex + 1 && TRAILING_FILLERS.has(norm(words[endIndex].text)) &&
    terminal(words[endIndex - 1].text) &&
    words[endIndex].end - words[startIndex].start > minDuration) {
    endIndex--;
    endingReason = 'TRAILING_FILLER_TRIMMED';
  }

  const editedStart = clampStart(words, startIndex, windowStart);
  const editedEnd = clampEnd(words, endIndex, windowEnd, tailSec);

  // -------------------------------------------------- internal dead air (§8)
  const cuts: Cut[] = [];
  let removed = 0;
  let fillerRemovedCount = 0;
  const budget = Math.min(tuning.maxInternalRemovalSec,
    (editedEnd - editedStart) * tuning.maxInternalRemovalRatio);
  const planCuts = (input.planCuts ?? []).filter((cut) => cut.start >= editedStart &&
    cut.end <= editedEnd && cut.end > cut.start);
  const overlapsPlanned = (cut: Cut) => planCuts.some((other) =>
    cut.start < other.end && other.start < cut.end);
  for (let index = startIndex + 1; index <= endIndex; index++) {
    const previous = words[index - 1];
    const word = words[index];
    let cut: Cut | null = null;
    if (DISFLUENCIES.has(norm(word.text)) && index < endIndex) {
      const next = words[index + 1];
      const start = Math.max(previous.end + .03, word.start - .03);
      const end = Math.min(next.start - .03, word.end + .03);
      if (end - start >= .18) { cut = { start, end }; fillerRemovedCount++; }
    } else if (word.start - previous.end > tuning.internalPauseSec) {
      cut = { start: previous.end + tuning.keptPauseBeforeSec,
        end: word.start - tuning.keptPauseAfterSec };
    }
    if (!cut || cut.end - cut.start < .18 || overlapsPlanned(cut)) continue;
    // Near the budget, shorten the pause instead of skipping it.
    if (removed + cut.end - cut.start > budget) cut = { start: cut.start, end: cut.start + budget - removed };
    if (cut.end - cut.start < .18) break;
    cuts.push(cut);
    removed += cut.end - cut.start;
  }
  for (const cut of planCuts) {
    if (removed + cut.end - cut.start > budget) continue;
    cuts.push(cut);
    removed += cut.end - cut.start;
  }
  cuts.sort((a, b) => a.start - b.start);
  const internalPauseRemovedMs = Math.round(removed * 1000);

  const first = words[startIndex];
  const last = words[endIndex];
  // The trailing-filler trim can move the end off the scored candidate, so the
  // delivered ending is re-read rather than assumed.
  const finalEnding = scoreEnding(words, endIndex,
    { baseIndex: baseEndIndex, origin: ending.origin, newTopicIndex });
  const notContinuation = !finalEnding.continuation;
  const clipEndComplete = finalEnding.complete && notContinuation;
  const firstWordPreRollMs = Math.round(Math.max(0, first.start - editedStart) * 1000);
  const clipEndNoNewTopicLeak = !finalEnding.leaksNewTopic;
  // §31: a clip cut mid-thought is a serious editorial defect, not a cosmetic
  // one - but only when the defect can actually be shown. Ending on a
  // continuation word proves it. An unpunctuated transcript does not: there the
  // best available evidence is the pause, and an unverifiable ending degrades
  // the clip rather than blocking a clip that may well be fine.
  const endingDefectSeverity: EndingDefectSeverity =
    finalEnding.continuation || (!finalEnding.complete && !finalEnding.paused) ? 'SERIOUS' :
      !clipEndComplete || !clipEndNoNewTopicLeak ? 'MINOR' : 'NONE';
  const asScored = (index: number, pick: 'start' | 'end', value: number, origin: string,
    components: Record<string, number>): ScoredBoundary => ({
    sec: Number((pick === 'start' ? words[index].start : words[index].end).toFixed(3)),
    score: value, origin, components });

  return { editedStart, editedEnd, cuts, startWordIndex: startIndex, endWordIndex: endIndex,
    removedLeadIn, leadInRemovedMs, openingReason, endingReason,
    lunaOpeningApplied, lunaEndingApplied, contextExtendedStartMs, contextExtendedEndMs,
    internalPauseRemovedMs, fillerRemovedCount,
    clipStartStrong: !isWeakOpeningWord(first.text),
    // A removed lead-in leaves the clip at the start of its (already natural) sentence.
    clipStartNatural: sentenceStartAt(words, startIndex) || /^[\p{Lu}\p{N}]/u.test(first.text.trim()) ||
      (removedLeadIn.length > 0 && sentenceStartAt(words, opening.fromIndex)),
    clipEndComplete,
    clipEndNatural: clipEndComplete && !TRAILING_FILLERS.has(norm(last.text)),
    deadAirAtEndMs: Math.round(Math.max(0, editedEnd - last.end) * 1000),
    deadAirAtStartMs: firstWordPreRollMs,
    tailSec,
    originalEndSec: candidateEnd, optimizedEndSec: editedEnd,
    endAdjustmentSec: Number((editedEnd - candidateEnd).toFixed(3)),
    endSemanticComplete: clipEndComplete, endThoughtResolved: clipEndComplete,
    endNotContinuation: notContinuation, endNoWordCut: true,
    endRepairAttempted, endRepairSucceeded,
    originalStartSec: candidateStart, optimizedStartSec: editedStart,
    startAdjustmentSec: Number((editedStart - candidateStart).toFixed(3)),
    clipStartContextComplete: opening.contextComplete,
    // The cut never lands inside the first word. How much pre-roll it managed to
    // keep is reported separately, since the source does not always offer any.
    clipFirstWordNotClipped: editedStart <= first.start + 1e-6,
    firstWordPreRollMs,
    firstWordPreRollAvailableMs: Math.round(
      Math.max(0, availablePreRollSec(words, startIndex, windowStart)) * 1000),
    // Either nothing weak was there, or what was removed was a marker this
    // module is allowed to remove - never a word carrying meaning.
    weakLeadInRemovedOrJustified: removedLeadIn.length > 0 || !isWeakOpeningWord(first.text),
    openingRepairAttempted, openingRepairSucceeded,
    clipEndNoNewTopicLeak, clipEndPayoffDelivered: finalEnding.payoffDelivered,
    endingDefectSeverity,
    openingStrategy: opening.strategy, openingScore: opening.score,
    openingScoreComponents: opening.components,
    endingStrategy: finalEnding.strategy, endingScore: ending.score,
    endingScoreComponents: ending.components,
    contextExpandedSec: Number(((contextExtendedStartMs + contextExtendedEndMs) / 1000).toFixed(3)),
    weakLeadRemovedSec: Number((leadInRemovedMs / 1000).toFixed(3)),
    payoffPreserved: finalEnding.payoffDelivered && clipEndComplete,
    newTopicTrimmed: ending.origin === 'NEW_TOPIC' ||
      (newTopicIndex != null && endIndex < newTopicIndex && baseEndIndex >= newTopicIndex),
    openingCandidates: openings.map((item) =>
      asScored(item.index, 'start', item.score, item.origin, item.components)),
    endingCandidates: endings.map((item) =>
      asScored(item.index, 'end', item.score, item.origin, item.components)) };
}
