import type { SubtitleEmphasis } from './edit-plan';

// Premium headline accenting: the hook sits in dark charcoal on a white plate and
// a controlled number of genuinely strong words carry ONE accent colour. A
// headline never mixes colour families - two red words read as deliberate
// emphasis, a red word next to a green one reads as a template. The selection is
// deterministic so a re-render of the same hook always picks the same family and
// the same words: the clip and its thumbnail therefore agree by construction.
export type HookAccentFamily = 'RED' | 'BLUE' | 'GREEN';
// ASS is &HAABBGGRR. Chosen for a white/near-white plate, so every one of them
// clears 4.5:1 against #FFFFFF: red #C62828, blue #1552B8, green #1B7A3C.
export const HOOK_ACCENT_FAMILY_COLORS: Record<HookAccentFamily, string> = {
  RED: '&H002828C6', BLUE: '&H00B85215', GREEN: '&H003C7A1B' };
// The headline's own colour on the plate: very dark charcoal, never pure black.
export const HOOK_TEXT_COLOR = '&H00111111';
export type HookAccentRole = 'PRIMARY' | 'SECONDARY' | 'TERTIARY';
export type HookAccent = { index: number; word: string; role: HookAccentRole; score: number };

// Tone -> family. Readability is identical across the three, so this only picks
// the register: conflict and stakes read red, growth and money read green, and
// everything analytical or merely informational reads blue (the default).
const FAMILY_WORDS: Array<[HookAccentFamily, RegExp]> = [
  ['RED', /\b(banned|illegal|blocked|seized|arrested|jailed|fined|sued|crisis|collapse|crash|danger|threat|warning|disaster|emergency|fraud|scam|stolen|lie|lied|lies|wrong|mistake|failure|failed|refused|denied|attacked|fight|fought|battle|clash|protest|dispute|blamed|shut|stop|stopped|killed|died|war|risk|worst|never|nobody)\b/iu],
  ['GREEN', /\b(grew|growth|growing|profit|profits|revenue|earned|earnings|gains?|gained|boom|booming|record|surge|surged|doubled|tripled|success|succeeded|winning|won|saved|savings|cheaper|improved|improvement|better|best|breakthrough|rebuilt|recovered|rich|richest|billion|billions|million|millions|dollars?)\b/iu]
];

/** The single accent family this headline uses, chosen deterministically. */
export function hookAccentFamily(text: string): HookAccentFamily {
  for (const [family, pattern] of FAMILY_WORDS) if (pattern.test(text)) return family;
  return 'BLUE';
}

/**
 * How many words may be coloured, by headline length (§24). Colouring too much
 * of a line destroys the emphasis, so the budget grows slowly with length. The
 * upper bound is a budget, not a quota: a word still has to be strong enough to
 * claim it.
 */
export function hookAccentBudget(wordCount: number) {
  if (wordCount <= 6) return 1;
  if (wordCount <= 10) return 2;
  if (wordCount <= 15) return 3;
  return 4;
}

// Words that carry no meaning on their own and must never be the accent.
const FUNCTION_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or',
  'but', 'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'it', 'its',
  'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'his', 'her', 'their',
  'our', 'my', 'your', 'me', 'him', 'them', 'us', 'do', 'does', 'did', 'has', 'have', 'had',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'not', 'no', 'so', 'if', 'than',
  'then', 'there', 'here', 'what', 'why', 'how', 'who', 'when', 'where', 'which', 'just', 'about',
  'into', 'over', 'out', 'up', 'down', 'all', 'more', 'most', 'very', 'really']);
// Long enough to pass the content-word filter, empty enough to be a bad accent.
const WEAK_ACCENTS = new Set(['again', 'also', 'still', 'even', 'ever', 'quite', 'rather',
  'maybe', 'perhaps', 'somehow', 'anyway', 'else', 'another', 'other', 'many', 'much',
  'some', 'such', 'those', 'these', 'thing', 'things', 'stuff', 'going', 'doing', 'being',
  'today', 'tonight', 'later', 'soon', 'then']);
// Short, irregular past-tense verbs the -ed/-ing test cannot see.
const ACTIONS = new Set(['rose', 'fell', 'won', 'lost', 'built', 'broke', 'sold', 'bought',
  'quit', 'died', 'grew', 'shrank', 'cut', 'paid', 'ran', 'beat', 'hit', 'sent', 'took',
  'gave', 'made', 'kept', 'left', 'held', 'found', 'chose', 'sued', 'fled']);
const normalize = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}%$]/gu, '');
const isNumeric = (word: string) => /[0-9]/u.test(word);
// Words that make a headline land: numbers already score, these carry the claim.
const CHARGED = new Set(['never', 'always', 'nobody', 'everyone', 'everything', 'nothing',
  'secret', 'truth', 'lie', 'lies', 'wrong', 'right', 'worst', 'best', 'first', 'last', 'only',
  'real', 'fake', 'stop', 'start', 'dead', 'win', 'lost', 'lose', 'free', 'proof', 'biggest',
  'fastest', 'hardest', 'impossible', 'guaranteed', 'banned', 'illegal', 'billion', 'million',
  'trillion', 'crisis', 'collapse', 'shock', 'danger', 'mistake', 'failure',
  // Contradiction, consequence and reveal words: the turn of a headline is as
  // worth colouring as its loudest noun.
  'instead', 'despite', 'until', 'backfired', 'reversed', 'opposite', 'refused', 'denied',
  'cost', 'consequence', 'forced', 'meant', 'ended', 'exposed', 'revealed', 'admitted',
  'hidden', 'quietly', 'ignored', 'blocked', 'seized', 'arrested', 'fined', 'sued',
  'changed', 'transformed', 'became', 'overnight', 'record', 'largest', 'fought', 'blamed']);

export function hookAccentCandidates(text: string, emphasis: SubtitleEmphasis[] = []): HookAccent[] {
  const words = text.split(/\s+/u).filter(Boolean);
  const strong = new Set(emphasis.filter((item) => item.strength === 'STRONG')
    .map((item) => normalize(item.word)).filter(Boolean));
  const any = new Set(emphasis.map((item) => normalize(item.word)).filter(Boolean));
  const allCaps = text === text.toLocaleUpperCase('en-US');
  const contentIndexes = words.map((word, index) => ({ word, index, key: normalize(word) }))
    .filter((item) => item.key && !FUNCTION_WORDS.has(item.key) &&
      (item.key.length >= 3 || isNumeric(item.key)));
  if (!contentIndexes.length) return [];
  const lastContent = contentIndexes[contentIndexes.length - 1].index;
  const scored = contentIndexes.map((item) => {
    let score = 0;
    if (isNumeric(item.key)) score += 3;
    if (strong.has(item.key)) score += 2;
    else if (any.has(item.key)) score += 1;
    if (CHARGED.has(item.key)) score += 1.5;
    // A named entity that the headline is actually about carries the claim; the
    // test only works on a headline that kept its case (short hooks are set in
    // uppercase, where numbers and charged words already do the work).
    if (!allCaps && item.index > 0 && /^\p{Lu}/u.test(item.word) && item.key.length >= 4) score += 1.2;
    score += Math.min(2, Math.max(0, item.key.length - 3) * .4);
    // Generic adverbs carry no claim: they may sit in a headline but colouring
    // one wastes the accent on the least meaningful word in the line.
    if (WEAK_ACCENTS.has(item.key)) score -= 2.5;
    // The main action is what the headline claims happened.
    if (ACTIONS.has(item.key) ||
      (item.key.length > 4 && /(?:ed|ing)$/u.test(item.key) && !WEAK_ACCENTS.has(item.key)))
      score += 1.2;
    // The payoff word of a headline usually sits at the end.
    if (item.index === lastContent) score += 1;
    if (item.index === 0) score -= 1;
    return { index: item.index, word: item.word, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const letters = (value: string) => normalize(value).length;
  const total = words.reduce((sum, word) => sum + letters(word), 0);
  const budget = Math.min(hookAccentBudget(words.length), contentIndexes.length - 1 || 1);
  const roles: HookAccentRole[] = ['PRIMARY', 'SECONDARY', 'TERTIARY', 'TERTIARY'];
  const accents: HookAccent[] = [{ ...scored[0], role: 'PRIMARY' }];
  let coloured = letters(scored[0].word);
  // Further accents must each be strong in their own right, sit away from the
  // words already coloured so the eye can scan the line, and keep the total
  // amount of coloured text visually controlled.
  for (const item of scored.slice(1)) {
    if (accents.length >= budget) break;
    // The bar rises as the headline fills up: the fourth accent has to be a
    // genuinely strong word, not merely the next one down the list.
    if (item.score < 2 + (accents.length - 1) * .5) continue;
    if (accents.some((accent) => Math.abs(accent.index - item.index) <= 1)) continue;
    if ((coloured + letters(item.word)) / Math.max(1, total) > .45) continue;
    accents.push({ ...item, role: roles[accents.length] });
    coloured += letters(item.word);
  }
  // A single accent on a five-word-plus headline is the old behaviour and stays
  // valid; nothing is coloured just to reach the budget.
  return accents.sort((a, b) => a.index - b.index);
}

// Rebuilds the fitted hook lines with ASS colour tags around the accent words.
// Every accent uses the SAME colour: one family per headline. `escape` is
// applied to the plain text; the returned lines are ASS-ready.
export function applyHookAccents(lines: string[], accents: HookAccent[], baseColor: string,
  escape: (value: string) => string, accentColor: string) {
  const byIndex = new Map(accents.map((accent) => [accent.index, accent]));
  let index = 0;
  const out = lines.map((line) => line.split(/\s+/u).filter(Boolean).map((word) => {
    const accent = byIndex.get(index++);
    if (!accent) return escape(word);
    return `{\\1c${accentColor}&}${escape(word)}{\\1c${baseColor}&}`;
  }).join(' '));
  return { lines: out, accentedWordCount: Math.min(accents.length, index) };
}
