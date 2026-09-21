// Editorial hook generation and scoring.
//
// An AI_EDITED clip must always carry a headline, so two paths exist and both
// have to produce something worth reading:
//   * Luna proposes five candidates with deliberately different mechanisms.
//   * When Luna is unavailable, `deterministicHook` builds one from the clip's
//     own words using grounded rewrites only - never a copied transcript line.
// `scoreHook` ranks whatever arrives from either path, so the selection rule is
// identical in both cases.

export type HookContext = { transcript: string; title: string; synopsis: string;
  topic?: string;
  // Packaging intent. Never changes what is true about the clip - only which
  // truthful angle reads best on the chosen surface.
  platform?: 'INSTAGRAM_REELS' | 'YOUTUBE_SHORTS' | 'TIKTOK' | null;
  // Mechanisms and headlines already spent on earlier clips of the same source,
  // so five clips do not all open with the same "Why ...?" construction.
  usedMechanisms?: string[];
  usedHooks?: string[];
  // Identity resolver evidence is trusted input to grounding, but only names
  // that passed its confidence policy are supplied here.
  verifiedEntities?: string[] };
export type HookScore = { text: string; score: number; rejected: string; mechanism: string;
  wordCount: number; components: Record<string, number> };

const WORDS = /[\p{L}\p{N}'’%$-]+/gu;
const tokens = (value: string) => value.match(WORDS) ?? [];
const norm = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}%$]/gu, '');

// Words that carry no meaning alone: they may appear in a hook but never count
// as its substance.
const FUNCTION_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or',
  'but', 'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'it', 'its',
  'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'his', 'her', 'their',
  'our', 'my', 'your', 'me', 'him', 'them', 'us', 'do', 'does', 'did', 'has', 'have', 'had',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'not', 'no', 'so', 'if', 'than',
  'then', 'there', 'here', 'just', 'about', 'into', 'over', 'out', 'up', 'down', 'all', 'more',
  'most', 'very', 'really', 'get', 'got', 'go', 'going', 'know', 'think', 'like', 'want']);
// Spoken-only noise: never acceptable inside a headline.
const FILLERS = new Set(['um', 'uh', 'erm', 'hmm', 'yeah', 'yep', 'okay', 'ok', 'gonna', 'wanna',
  'kinda', 'sorta', 'basically', 'literally', 'honestly', 'anyway', 'whatever']);
// Words that make a headline land - the editorial mechanisms in lexical form.
// The vocabulary is deliberately wide so the scorer can tell one mechanism from
// another and the diversity rule has something real to spread across clips.
const CHARGED = new Map<string, string>(([
  [['banned', 'illegal', 'blocked', 'shut', 'seized', 'arrested', 'jailed', 'fined', 'sued',
    'blacklisted', 'suspended', 'revoked'], 'STAKES'],
  [['never', 'nobody', 'nothing', 'none', 'refused', 'denied', 'failed', 'failure',
    'nobody\'s', 'neither'], 'CONTRADICTION'],
  [['secret', 'hidden', 'quietly', 'unknown', 'buried', 'ignored', 'overlooked',
    'unnoticed', 'undisclosed'], 'CURIOSITY_GAP'],
  [['actually', 'turns', 'instead', 'however', 'despite', 'although', 'until', 'backfired',
    'reversed', 'opposite', 'contrary'], 'COUNTERINTUITIVE'],
  [['billion', 'million', 'trillion', 'thousand', 'percent', 'record', 'biggest', 'largest',
    'fastest', 'worst', 'best', 'first', 'double', 'half'], 'UNUSUAL_FACT'],
  [['collapse', 'crisis', 'crash', 'danger', 'threat', 'risk', 'warning', 'disaster',
    'emergency', 'shortage'], 'EMOTIONAL_TENSION'],
  [['mistake', 'wrong', 'lie', 'lied', 'lies', 'fraud', 'scam', 'cheated', 'stolen',
    'exposed', 'admitted', 'revealed', 'confirmed'], 'REVEAL'],
  [['ridiculous', 'absurd', 'insane', 'crazy', 'weird', 'bizarre', 'awkward', 'hilarious',
    'somehow', 'apparently'], 'HUMOR'],
  [['ironically', 'irony', 'supposedly', 'allegedly'], 'IRONY'],
  [['fight', 'clash', 'battle', 'protest', 'dispute', 'opposed', 'against', 'rivals',
    'blamed', 'attacked'], 'CONFLICT'],
  [['became', 'turned', 'changed', 'transformed', 'rebuilt', 'grew', 'shrank', 'replaced',
    'overnight'], 'TRANSFORMATION'],
  [['cost', 'costs', 'consequence', 'consequences', 'result', 'results', 'meant', 'means',
    'forced', 'ends', 'ended'], 'HIDDEN_CONSEQUENCE'],
  [['everyone', 'everybody', 'millions', 'thousands', 'nationwide', 'worldwide'], 'SOCIAL_PROOF'],
  [['proof', 'truth', 'reason', 'why', 'because', 'caused', 'led'], 'CURIOSITY_GAP']
] as Array<[string[], string]>).flatMap(([list, mechanism]) =>
  list.map((word) => [word, mechanism] as [string, string])));

/** Every mechanism the scorer can attribute, for diversity bookkeeping. */
export const HOOK_MECHANISMS = ['CURIOSITY_GAP', 'CONTRADICTION', 'SURPRISE', 'STAKES',
  'HIDDEN_CONSEQUENCE', 'STRONG_QUESTION', 'UNUSUAL_FACT', 'EMOTIONAL_TENSION', 'HUMOR',
  'IRONY', 'CONFLICT', 'TRANSFORMATION', 'REVEAL', 'SOCIAL_PROOF', 'COUNTERINTUITIVE',
  'PLAIN'] as const;

// Platform packaging preferences. Small nudges only: a stronger, truer headline
// always outranks a merely better-fitting one.
const PLATFORM_HOOK_FIT: Record<string, { mechanisms: string[]; idealWords: [number, number] }> = {
  INSTAGRAM_REELS: { mechanisms: ['EMOTIONAL_TENSION', 'CURIOSITY_GAP', 'REVEAL', 'TRANSFORMATION'],
    idealWords: [5, 10] },
  TIKTOK: { mechanisms: ['STRONG_QUESTION', 'HUMOR', 'IRONY', 'CONFLICT', 'SURPRISE'],
    idealWords: [5, 10] },
  YOUTUBE_SHORTS: { mechanisms: ['UNUSUAL_FACT', 'CURIOSITY_GAP', 'HIDDEN_CONSEQUENCE',
    'COUNTERINTUITIVE'], idealWords: [5, 10] }
};
// Subjects where a witty headline would be tasteless, whatever the clip's tone.
const SOLEMN = /\b(death|died|dying|killed|murder|suicide|funeral|grief|mourning|tragedy|victims?|abuse|assault|trauma|genocide|massacre|terminal|cancer|famine|refugees?)\b/u;

export function solemnSubject(context: HookContext) {
  return SOLEMN.test(`${context.transcript} ${context.title} ${context.synopsis}`.toLowerCase());
}

// --- Scoring ---------------------------------------------------------------
// Rejections are hard: a rejected candidate is never chosen while any accepted
// one exists. The score then ranks what survives.
// A headline has to be a complete, interesting thought: five words is the floor,
// 5-10 is the first-frame target band, and a longer line up to `max` is allowed
// when the meaning needs it. The renderer
// is responsible for fitting it (see text-layout's long-hook ladder), never the
// scorer - shortening a strong headline is the last thing tried, not the first.
export const HOOK_LENGTH = { min: 5, preferredMin: 5, preferredMax: 10, good: 16,
  max: 20, maxChars: 120 } as const;

// Light predicate detection: an auxiliary/common verb, or an inflected form.
// Deliberately permissive - it only has to catch a headline with no verb at all.
const AUXILIARIES = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had',
  'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must',
  'got', 'get', 'go', 'went', 'made', 'make', 'take', 'took', 'lost', 'lose', 'won', 'win',
  'cut', 'put', 'set', 'said', 'told', 'gave', 'built', 'broke', 'sold', 'bought', 'paid',
  'left', 'kept', 'came', 'ran', 'held', 'sent', 'spent', 'found', 'felt', 'knew', 'saw',
  'quit', 'hit', 'beat', 'fell', 'rose', 'grew', 'shut', 'ban', 'banned', 'meant',
  // Common base-form verbs: without these a perfectly good headline like
  // "I Believe in the Sun" would read as a noun pile to the rule above.
  'believe', 'think', 'know', 'see', 'say', 'mean', 'need', 'want', 'come', 'keep', 'stop',
  'start', 'help', 'show', 'tell', 'ask', 'live', 'die', 'work', 'change', 'matter', 'happen',
  'look', 'feel', 'call', 'try', 'use', 'move', 'turn', 'run', 'build', 'sell', 'buy', 'pay',
  'wait', 'watch', 'learn', 'teach', 'argue', 'claim', 'refuse', 'admit', 'fight', 'vote',
  'protect', 'blame', 'become', 'bring', 'choose', 'give', 'grow', 'hold', 'leave', 'let',
  'read', 'send', 'spend', 'stand', 'understand', 'write']);
// Plural nouns and adverbs that would otherwise read as verbs to the rule above.
const NOT_VERBS = new Set(['always', 'perhaps', 'across', 'business', 'press', 'news', 'boss',
  'crisis', 'access', 'process', 'series', 'analysis', 'progress', 'success', 'less', 'plus',
  'this', 'thing', 'nothing', 'everything', 'anything', 'something', 'during', 'morning',
  'evening', 'ceiling', 'billions', 'millions', 'thousands', 'years', 'months', 'days',
  'hours', 'minutes', 'seconds', 'dollars', 'percent', 'rules', 'traders', 'residents',
  'people', 'jobs', 'numbers', 'others', 'others\'', 'times', 'ways', 'kinds', 'types']);

/** Content-word overlap, used for "is this the same headline as that one". */
function overlapRatio(left: string[], right: Set<string>) {
  if (!left.length || !right.size) return 0;
  return left.filter((key) => right.has(key)).length / left.length;
}

export function scoreHook(text: string, context: HookContext): HookScore {
  const trimmed = String(text ?? '').replace(/\s+/gu, ' ').trim();
  const words = tokens(trimmed);
  const keys = words.map(norm).filter(Boolean);
  const content = keys.filter((key) => !FUNCTION_WORDS.has(key) && key.length >= 3);
  const source = new Set(tokens(`${context.transcript} ${context.title} ${context.synopsis} ${
    (context.verifiedEntities ?? []).join(' ')}`).map(norm));
  const grounded = content.filter((key) =>
    source.has(key) || source.has(key.replace(/s$/u, '')) || source.has(`${key}s`));
  const charged = keys.map((key) => CHARGED.get(key)).filter(Boolean) as string[];
  // A question frame is the mechanism only when no stronger lexical one is used,
  // so "Why Was This Market Banned?" counts as STAKES rather than a bare question.
  const mechanism = charged[0] ?? (/\?$/u.test(trimmed) ? 'STRONG_QUESTION' : 'PLAIN');
  const components: Record<string, number> = {};
  const reject = (reason: string): HookScore => ({ text: trimmed, score: -1, rejected: reason,
    mechanism, wordCount: words.length, components });
  if (!trimmed) return reject('EMPTY_TEXT');
  if (words.length < HOOK_LENGTH.min || words.length > HOOK_LENGTH.max)
    return reject('INVALID_LENGTH');
  if (trimmed.length > HOOK_LENGTH.maxChars) return reject('TOO_LONG');
  if (content.length < 2) return reject('NO_SUBSTANCE');
  if (keys.some((key) => FILLERS.has(key))) return reject('TRANSCRIPT_FRAGMENT');
  // A headline is about the subject, not about the clip. "This Clip Examines
  // Why ..." is a synopsis sentence that happens to be grounded, and it reads on
// screen as a description of the video rather than a reason to watch it.
  // The determiner is often gone by the time a compressed line is scored
  // ("Clip Discusses How ..."), so a bare leading noun counts too.
  if (/^(?:in |on )?(?:this |the )?(?:clip|video|segment|episode|excerpt)\s+(?:examines|explores|discusses|covers|shows|explains|looks|breaks|is|was)\b/iu.test(trimmed) ||
    /^(?:in |on )?(?:this|the) (?:clip|video|segment|episode|excerpt|section|part)\b/iu.test(trimmed) ||
    /\b(?:this|the) (?:clip|video|segment|episode) (?:examines|explores|discusses|covers|shows|explains|looks at|breaks down)\b/iu.test(trimmed) ||
    /^(?:here|we|i) (?:we |)?(?:examine|explore|discuss|cover|explain|break down|look at)\b/iu.test(trimmed))
    return reject('META_FRAMING');
  // An incomplete sentence: a headline may not open or close on a connective.
  if (/^(and|but|so|or|because|which|that|then|also|of|to|in|for|with)\b/iu.test(trimmed) ||
    /\b(and|but|so|or|because|which|that|of|to|in|for|with|the|a|an)$/iu.test(trimmed.replace(/[?!.]$/u, '')))
    return reject('INCOMPLETE_SENTENCE');
  if (/(this changes everything|you won'?t believe|wait for it|watch until the end|you need to see this|shocking truth|will shock you|nobody is talking about|doctors hate|before it'?s too late|breaking the internet)/iu.test(trimmed))
    return reject('FABRICATED_CLICKBAIT');
  // False urgency is a promise the clip cannot keep.
  if (/\b(?:right now|today only|hurry|last chance|act fast|urgent|breaking)\b/iu.test(trimmed) &&
    !/\b(?:right now|today|hurry|urgent|breaking)\b/iu.test(context.transcript))
    return reject('FALSE_URGENCY');
  // A quoted phrase has to be a phrase the clip actually contains.
  const quoted = /[“"']([^“”"']{6,})[”"']/u.exec(trimmed)?.[1];
  if (quoted && !context.transcript.toLowerCase().includes(quoted.toLowerCase().trim()))
    return reject('FABRICATED_QUOTE');
  if (grounded.length < Math.min(2, content.length)) return reject('NOT_GROUNDED');
  const titleKeys = new Set(tokens(context.title).map(norm));
  if (content.length >= 2 && content.every((key) => titleKeys.has(key))) return reject('DUPLICATES_TITLE');
  // A headline has to say something happened. Without a predicate the line is a
  // noun pile the window slicer happened to stop on - "Reason Why Donald Trump"
  // reads as a broken caption, not a headline. A question mark carries its own
  // completeness ("Why Was This Market Banned?").
  if (!/\?$/u.test(trimmed) && !words.some((word, index) => {
    const key = keys[index] ?? norm(word);
    // A possessive ("Trump's") is not a verb, however much its normalised form
    // looks like one.
    if (/['’]s$/u.test(word)) return false;
    return AUXILIARIES.has(key) ||
      (key.length > 3 && /(?:ed|ing|es|s)$/u.test(key) && !NOT_VERBS.has(key));
  })) return reject('INCOMPLETE_SENTENCE');
  // A slice taken out of the middle of a spoken sentence is a fragment, not a
  // headline. A verbatim line that at least starts where the speaker started is
  // a (weak) summary: it stays in the pool and is heavily penalised below, so a
  // real rewrite always beats it while the fallback never runs out of material.
  const bare = trimmed.toLowerCase().replace(/[?!.]+$/u, '');
  const spoken = context.transcript.toLowerCase();
  const at = words.length >= 5 ? spoken.indexOf(bare) : -1;
  const verbatim = at >= 0;
  // Only the scaffolding a headline legitimately drops (a leading article or
  // discourse marker) may sit between the sentence's start and the match.
  const lead = verbatim ? spoken.slice(spoken.slice(0, at).search(/[^.!?]*$/u), at).trim() : '';
  // What matters is that only scaffolding was dropped, not how many words of it:
  // "Um so the ..." is three tokens of pure noise, and a headline that starts
  // where the speaker's claim starts is a summary, not a spliced-out fragment.
  const fromSentenceStart = verbatim && (!lead ||
    (tokens(lead).length <= 4 && tokens(lead).every((word) =>
      LEADING_STRIP.has(norm(word)) || FILLERS.has(norm(word)))));
  if (verbatim && !fromSentenceStart)
    return reject('TRANSCRIPT_FRAGMENT');
  // Already used, near-verbatim, by an earlier clip of the same source.
  for (const used of context.usedHooks ?? []) {
    const usedKeys = new Set(tokens(used).map(norm).filter((key) =>
      !FUNCTION_WORDS.has(key) && key.length >= 3));
    if (overlapRatio(content, usedKeys) >= .75) return reject('DUPLICATE_ACROSS_CLIPS');
  }

  let score = 0;
  const add = (name: string, value: number) => { components[name] = Number(value.toFixed(3)); score += value; };
  // Length fit: 5-10 words is the first-frame target band. A longer line is
  // is allowed for a headline whose wording would be damaged by cutting it down.
  add('brevity', words.length >= HOOK_LENGTH.preferredMin && words.length <= HOOK_LENGTH.preferredMax ?
    3 : words.length <= HOOK_LENGTH.good ? 2.2 : 1.2);
  // Curiosity / retention: the editorial mechanism actually used.
  // A mechanism only pays off when the headline has enough substance to carry it:
  // a three-word line with one charged adverb is not a curiosity gap.
  add('curiosity', (mechanism !== 'PLAIN' ? (content.length >= 3 ? 2.5 : 1.1) : 0) +
    (/\?$/u.test(trimmed) ? 1.2 : 0) + (charged.length > 1 ? .4 : 0));
  add('specificity', (keys.some((key) => /\d/u.test(key)) ? 1 : 0) +
    // A named entity the clip actually discusses makes the promise concrete.
    (words.some((word, index) => index > 0 && /^[A-Z]/u.test(word) &&
      source.has(norm(word))) ? .6 : 0));
  // Relevance: how much of the headline is anchored in the clip's own language.
  add('grounding', Math.min(2, grounded.length * .6));
  // Standalone readability: proportion of real content, penalising scaffolding.
  add('readability', Math.min(1.5, content.length / Math.max(1, words.length) * 2.5));
  // Clarity: a long line still has to scan. Gentle, so a strong long headline
  // is not beaten by a bland short one.
  // Clarity floor only: a headline is expected to be a full sentence now, so the
  // penalty starts well past the target band rather than at every long line.
  add('length', -Math.min(1.6, Math.max(0, trimmed.length - 108) * .035));
  // Revealing the whole payoff kills the reason to keep watching.
  add('payoffPreservation', words.length >= HOOK_LENGTH.good && mechanism !== 'PLAIN' &&
    !/\?$/u.test(trimmed) ? -.6 : 0);
  // Platform fit: which mechanism and length read as native on the surface.
  const fit = context.platform ? PLATFORM_HOOK_FIT[context.platform] : null;
  add('platformFit', !fit ? 0 : (fit.mechanisms.includes(mechanism) ? .8 : 0) +
    (words.length >= fit.idealWords[0] && words.length <= fit.idealWords[1] ? .4 : -.2));
  // A verbatim line is a summary of the clip rather than a headline for it.
  add('originality', verbatim ? -3 : 0);
  // Diversity: the same mechanism twice in one video is allowed, but it has to
  // earn it against a comparable candidate using a fresh one.
  const reuse = (context.usedMechanisms ?? []).filter((item) => item === mechanism).length;
  add('diversity', -Math.min(1.8, reuse * .9));
  const academicQuestionStyle = /^(?:does|do|did|can|could|should|would|is|are|has|have|whether)\b.*\?$/iu.test(trimmed);
  const policyMemoStyle = /\b(?:policy|framework|implications?|stability|outcomes?|assessment)\b/iu.test(trimmed) &&
    mechanism === 'PLAIN';
  const genericExplanationStyle = /\b(?:discusses|talks about|overview|an explanation of|understanding)\b/iu.test(trimmed);
  const weakModal = /\b(?:may have|could potentially|might be)\b/iu.exec(trimmed)?.[0] ?? '';
  const uncertaintyGrounded = weakModal && context.transcript.toLowerCase().includes(weakModal.toLowerCase());
  add('academicQuestionStyle', academicQuestionStyle ? -1.8 : 0);
  add('policyMemoStyle', policyMemoStyle ? -1.4 : 0);
  add('genericExplanationStyle', genericExplanationStyle ? -1.5 : 0);
  // Necessary uncertainty remains valid and receives only a small native-style
  // cost; unsupported hedging receives the full penalty.
  add('weakModalLanguage', weakModal ? (uncertaintyGrounded ? -.35 : -1.4) : 0);
  return { text: trimmed, score: Number(score.toFixed(3)), rejected: '', mechanism,
    wordCount: words.length, components };
}

/** Best accepted candidate, or null when every candidate was rejected. */
export function chooseBestHook(candidates: string[], context: HookContext) {
  const scored = candidates.map((candidate) => scoreHook(candidate, context));
  const accepted = scored.filter((item) => !item.rejected)
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length);
  return { best: accepted[0] ?? null, scored };
}

// --- Deterministic generation ----------------------------------------------
// Grounded rewrites only: every content word of the result comes from the clip.
// The only additions are the question scaffolding ("Why Was ... ?") that the
// rewrite itself requires, which asks about the clip's claim rather than
// asserting anything new.
// Spoken scaffolding stripped from the front of a clause. Hesitation sounds are
// included: a headline that still carries "Um" is rejected outright as a
// transcript scrap, so leaving them in would throw away usable material.
const DISCOURSE = /^(?:um|uh|erm|hmm|so|and|but|well|okay|ok|now|yeah|yep|right|see|look|listen|i mean|you know|like|basically|actually|anyway)\b[,\s]*/iu;
// The same sounds anywhere inside the clause; they are never part of a claim.
const SPOKEN_NOISE = /\b(?:um|uh|erm|hmm)\b[,\s]*/giu;
const TRAILING_CLAUSE = /\s+\b(?:because|which|when|while|after|before|since|although|though|unless|whereas|and then|so that)\b.*$/iu;
const HEDGES = /\b(?:kind of|sort of|you know|i mean|i think|i guess|a little bit|pretty much|or something|or whatever)\b/giu;
const EXISTENTIAL = /^(?:there(?:'s| is| was| were| are)|it(?:'s| is| was)|this (?:is|was)|that (?:is|was))\s+/iu;
const PASSIVE = /\b(?:was|were|got|is|are|has been|have been|had been)\s+([a-z]+(?:ed|en))\b/iu;

// Raw ASR transcripts often carry no sentence punctuation at all, which would
// leave the compressor one 200-word "sentence" to work with and reduce the whole
// fallback to slicing a window out of the middle of it. When punctuation is
// missing, spoken discourse boundaries stand in for it.
const CLAUSE_BREAK = /\s+\b(?:and then|but then|because|so that|and|but|so|then|which|where|when|while|although|though|until|after|before|since)\b\s+/giu;
const splitSpoken = (text: string) => {
  const parts: string[] = [];
  let start = 0;
  for (const match of text.matchAll(CLAUSE_BREAK)) {
    const end = match.index! + match[0].length;
    // Only break where both sides can stand as a clause.
    if (tokens(text.slice(start, match.index!)).length < 6) continue;
    parts.push(text.slice(start, match.index!));
    start = end;
  }
  parts.push(text.slice(start));
  return parts;
};
const sentences = (text: string) => {
  const flat = text.replace(/\s+/gu, ' ');
  const split = flat.split(/(?<=[.!?])\s+/u).map((part) => part.trim())
    .filter((part) => tokens(part).length >= 4);
  const unpunctuated = split.filter((part) => tokens(part).length > 30);
  if (!unpunctuated.length) return split;
  return [...split.filter((part) => tokens(part).length <= 30),
    ...unpunctuated.flatMap(splitSpoken)]
    .map((part) => part.trim()).filter((part) => tokens(part).length >= 4);
};

const MINOR = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'but',
  'with', 'by', 'from', 'as', 'is', 'it', 'its', 'into', 'than', 'that', 'about', 'over', 'up',
  'off', 'out', 'per', 'via', 'onto', 'upon', 'within', 'without', 'after', 'before']);
// A headline may never end on one of these: the thought would be unfinished.
// A bare quantity counts too - a number needs the noun it counts.
const DANGLING = new Set([...MINOR, 'this', 'these', 'those', 'their', 'his', 'her', 'our', 'your',
  'my', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'will', 'would', 'could', 'should',
  'between', 'against', 'through', 'during', 'under', 'above', 'across', 'toward', 'towards',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'few', 'several',
  // An ordinal or a bare qualifier needs the noun it modifies: "Trump's First"
  // is not an ending, it is a cut.
  'first', 'second', 'third', 'next', 'last', 'final', 'other', 'another', 'same', 'whole',
  'entire', 'own', 'more', 'most', 'every', 'each', 'own']);
// Only scaffolding is stripped from the front; a subject pronoun is the subject.
const LEADING_STRIP = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or',
  'but', 'with', 'by', 'from', 'as', 'so', 'then', 'that', 'just', 'about', 'into', 'over']);
const danglingTail = (word: string) => DANGLING.has(norm(word)) || /^\d+$/u.test(norm(word));
/**
 * A new subject after a completed predicate means the next clause has started,
 * even once compression has removed the punctuation and the conjunction that
 * used to mark it ("...that was banned you can get delta...").
 *
 * Nominative pronouns only. "it" is excluded because it is far more often the
 * object of the clause already in hand ("a huge market for it"), and bare
 * auxiliaries are excluded because they continue a predicate ("that was banned")
 * at least as often as they open a new one.
 */
const CLAUSE_STARTERS = new Set(['i', 'you', 'we', 'they', 'he', 'she', 'there']);
/**
 * Drops a trailing word that leaves the thought unfinished - a preposition, a
 * bare auxiliary, a participle with nothing after it - while the line still has
 * `min` words left. A headline that stops on "... Are Challenging" reads as a
 * caption that was cut off, which is exactly what §17 rejects.
 */
export function trimDanglingTail(words: string[], min: number) {
  const kept = [...words];
  while (kept.length > min) {
    const last = norm(kept[kept.length - 1]);
    if (!danglingTail(kept[kept.length - 1]) && !FUNCTION_WORDS.has(last) &&
      !/(?:ing|ed)$/u.test(last)) break;
    kept.pop();
  }
  return kept;
}
/** Editorial title case: minor words stay lower unless they open or close the line. */
export function titleCase(text: string) {
  const parts = text.split(/\s+/u).filter(Boolean);
  return parts.map((word, index) => {
    const key = norm(word);
    // Acronyms and stylised capitals keep their own spelling.
    if (/^[A-Z0-9][A-Z0-9'’.-]*$/u.test(word) && word.length > 1) return word;
    const lower = word.toLocaleLowerCase('en-US');
    if (index > 0 && index < parts.length - 1 && MINOR.has(key)) return lower;
    return lower.replace(/\p{L}/u, (letter) => letter.toLocaleUpperCase('en-US'));
  }).join(' ');
}

/**
 * Strips spoken scaffolding from one sentence without changing its claim.
 * `keepTrailing` preserves the second half of a two-part sentence, which is
 * where the turn of a contrast headline lives.
 */
function compress(sentence: string, keepTrailing = false) {
  let value = sentence.replace(/[“”"]/gu, '').replace(SPOKEN_NOISE, ' ')
    .replace(/\s+/gu, ' ').trim();
  let previous = '';
  while (previous !== value) { previous = value; value = value.replace(DISCOURSE, '').trim(); }
  value = value.replace(HEDGES, ' ').replace(/\s+/gu, ' ').trim();
  // "X and that was banned" / "X, which was banned" -> one reduced clause.
  value = value.replace(/\s*,?\s+(?:and|but)\s+(?:that|which|it|this)\s+(was|were|is|are|got)\s+/iu, ' that $1 ');
  value = value.replace(EXISTENTIAL, '').trim();
  if (!keepTrailing) value = value.replace(TRAILING_CLAUSE, '').trim();
  // Trailing pronoun prepositional phrases carry nothing on their own.
  value = value.replace(/\s+\b(?:for|to|about|with|of|from)\s+(?:it|them|him|her|us|me|that|this)\b/giu, '');
  // Hedge and clause removal can leave orphan punctuation behind.
  return value.replace(/\s*([,;:])(?:\s*[,;:])+/gu, '$1').replace(/^[\s,;:.-]+/u, '')
    .replace(/\s*[,;:]\s*$/u, '').replace(/\s+([,;:])/gu, '$1').replace(/\s+/gu, ' ').trim();
}

/** Value of a sentence as raw material: charge, numbers, contrast, concreteness. */
function sentenceScore(sentence: string) {
  const keys = tokens(sentence).map(norm);
  let score = 0;
  for (const key of keys) {
    if (CHARGED.has(key)) score += 2.5;
    if (/\d/u.test(key)) score += 1.5;
    if (!FUNCTION_WORDS.has(key) && key.length >= 5) score += .25;
    if (FILLERS.has(key)) score -= 1.5;
  }
  // Mid-length sentences carry a complete thought without a second one attached.
  const count = keys.length;
  score += count >= 6 && count <= 24 ? 1 : -1;
  return score;
}

/**
 * Trims a compressed clause to `limit` words around its strongest word. Cutting
 * happens at clause boundaries first, so the result is a whole thought rather
 * than a window sliced out of the middle of a sentence.
 */
function focus(clause: string, limit: number) {
  const anchorOf = (words: string[]) => {
    const keys = words.map(norm);
    const index = keys.findIndex((key) => CHARGED.has(key) || /\d/u.test(key));
    return index < 0 ? keys.length - 1 : index;
  };
  let words = clause.split(/\s+/u).filter(Boolean);
  if (words.length > limit) {
    const segments = clause.split(/\s*[,;:]\s*/u).map((part) => part.trim()).filter(Boolean);
    if (segments.length > 1) {
      const anchorWord = norm(words[anchorOf(words)]);
      const owner = segments.find((segment) => segment.split(/\s+/u).map(norm).includes(anchorWord));
      const picked = (owner ?? segments[segments.length - 1]).split(/\s+/u).filter(Boolean);
      if (picked.length >= 3) words = picked;
    }
  }
  words = words.map((word) => word.replace(/[,;:.!]+$/u, '')).filter(Boolean);
  // Spoken sentences run several clauses together with no punctuation and no
  // conjunction ("...that was banned you can get delta..."). Once a predicate
  // has been stated, a new subject or a fresh auxiliary starts the next clause,
  // and a headline must stop there rather than splice two thoughts together.
  const verbAt = words.findIndex((word) => {
    const key = norm(word);
    return AUXILIARIES.has(key) ||
      (key.length > 3 && /(?:ed|ing|es|s)$/u.test(key) && !NOT_VERBS.has(key));
  });
  if (verbAt >= 0) {
    const next = words.findIndex((word, index) =>
      index > verbAt + 1 && CLAUSE_STARTERS.has(norm(word)));
    if (next >= 3) words = words.slice(0, next);
  }
  if (words.length <= limit) {
    const kept = [...words];
    while (kept.length > 3 && LEADING_STRIP.has(norm(kept[0]))) kept.shift();
    while (kept.length > 3 && (danglingTail(kept[kept.length - 1]) ||
      FUNCTION_WORDS.has(norm(kept[kept.length - 1])))) kept.pop();
    return kept;
  }
  const anchor = anchorOf(words);
  const start = Math.max(0, Math.min(words.length - limit, anchor - limit + 2));
  const window = words.slice(start, start + limit);
  // Never open or close a headline on a function word.
  while (window.length > 3 && LEADING_STRIP.has(norm(window[0]))) window.shift();
  while (window.length > 3 && (danglingTail(window[window.length - 1]) ||
    FUNCTION_WORDS.has(norm(window[window.length - 1])))) window.pop();
  return window;
}

/**
 * Deterministic fallback hook: the strongest clause in the clip, compressed and
 * re-cast into a headline. Used whenever Luna is unavailable, and never a plain
 * copy of the first transcript sentence.
 *
 *   "There was a huge market for it and that was banned."
 *     -> compress -> "a huge market that was banned"
 *     -> passive question frame -> "Why Was This Huge Market Banned?"
 */
export function deterministicHookCandidates(context: HookContext): string[] {
  const pool = [...sentences(context.transcript), ...sentences(context.synopsis)];
  const ranked = pool.map((sentence) => ({ sentence, value: sentenceScore(sentence) }))
    .sort((a, b) => b.value - a.value).slice(0, 6);
  const candidates: string[] = [];
  for (const { sentence } of ranked) {
    const clause = compress(sentence);
    if (!clause) continue;
    // Two widths of the same clause: the tight headline and the fuller one that
    // keeps a qualifier the tight version would have dropped.
    const words = focus(clause, 12);
    if (words.length < 3) continue;
    const statement = words.join(' ');
    candidates.push(titleCase(statement));
    const wide = focus(clause, 18);
    if (wide.length > words.length) candidates.push(titleCase(wide.join(' ')));
    // A short spoken line compresses below the headline's word floor - "a huge
    // market that was banned" is five words - and the tight form is then no
    // headline at all. The widest grounded form of the same sentence, with only
    // hesitation noise removed, keeps the generator from starving on material
    // that is perfectly usable.
    if (words.length < HOOK_LENGTH.min) {
      const full = focus(sentence.replace(SPOKEN_NOISE, ' ').replace(/\s+/gu, ' ').trim(),
        HOOK_LENGTH.preferredMax);
      if (full.length >= HOOK_LENGTH.min) candidates.push(titleCase(full.join(' ')));
    }
    // Contrast frame: a sentence that contains its own reversal reads as a turn
    // rather than a statement. The turn usually lives in the trailing clause the
    // tight compression drops, so this looks at the sentence that kept it. Only
    // the clip's own words are used.
    const whole = compress(sentence, true);
    const turn = /\s+\b(?:but|however|instead|then|until|despite|although)\b\s+/iu.exec(whole);
    if (turn) {
      const left = focus(whole.slice(0, turn.index), 8);
      const right = focus(whole.slice(turn.index + turn[0].length), 8);
      // Both halves must be substantial and actually different: "Not Only
      // Seeing — Then Seeing Everything Else" is a turn on paper and a stutter
      // on screen.
      const leftKeys = new Set(left.map(norm).filter((key) => !FUNCTION_WORDS.has(key)));
      const repeats = right.map(norm).some((key) => leftKeys.has(key));
      if (left.length >= 3 && right.length >= 3 && !repeats)
        candidates.push(`${titleCase(left.join(' '))} — Then ${titleCase(right.join(' '))}`);
    }
    // Question frame: a passive clause becomes "Why Was This <subject>
    // <participle>?", which asks about the clip's own claim instead of
    // restating it flatly. The cause the speaker gives is usually in the
    // subordinate clause the tight compression drops, so that clause is offered
    // the same frame - "... because the alarm had been disconnected" becomes
    // "Why Was This Alarm Disconnected?".
    const cause = /\s+\b(?:because|after|since|when|once)\b\s+/iu.exec(whole);
    for (const source of [statement, cause ? whole.slice(cause.index + cause[0].length) : '']) {
      if (!source) continue;
      const passive = PASSIVE.exec(source);
      if (!passive) continue;
      const subjectWords = source.slice(0, passive.index).split(/\s+/u).filter(Boolean);
      // The relative pronoun and any determiner belonged to the clause the
      // question frame replaces, so they are dropped with the clause.
      while (subjectWords.length && /^(?:that|which|who|it|this|a|an|the)$/iu.test(norm(subjectWords[subjectWords.length - 1])))
        subjectWords.pop();
      // "Why Was This the Alarm ...": the frame supplies its own determiner, so
      // the subject may not bring one of its own.
      while (subjectWords.length && /^(?:a|an|the|this|that|these|those)$/iu.test(norm(subjectWords[0])))
        subjectWords.shift();
      const subject = subjectWords.slice(-6);
      if (!subject.length || danglingTail(subject[subject.length - 1]) ||
        subject.length + 3 > HOOK_LENGTH.max) continue;
      // "Why Was This <subject> <participle>" is four words plus the subject, so
      // a short subject leaves the question below the headline floor. The rest of
      // the speaker's own clause ("... for two months") carries it the rest of
      // the way rather than letting a good frame be thrown away on length.
      const tail: string[] = [];
      if (subject.length + 4 < HOOK_LENGTH.min) {
        // Only the rest of THIS clause may extend the question: crossing a
        // clause boundary produces a line that reads as two spliced sentences
        // ("Why Was This Market Banned You Can Get Delta?"). Punctuation and
        // conjunctions mark the boundary in the raw clause; in the compressed
        // one both are already gone, so a new subject (a pronoun) or a fresh
        // auxiliary is what betrays the next clause.
        const rest = source.slice(passive.index + passive[0].length)
          .split(/\s*[,;:.!?]|\s+\b(?:and|but|so|because|which|when|while|then|though|although|if|or)\b\s+/iu)[0];
        for (const word of (rest ?? '').split(/\s+/u).filter(Boolean)) {
          // A little past the floor, because trimming a dangling tail below
          // removes words again and the frame still has to clear it.
          if (subject.length + 4 + tail.length >= HOOK_LENGTH.min + 3) break;
          if (CLAUSE_STARTERS.has(norm(word))) break;
          tail.push(word.replace(/[,;:.!?]+$/u, ''));
        }
        while (tail.length && (danglingTail(tail[tail.length - 1]) ||
          FUNCTION_WORDS.has(norm(tail[tail.length - 1])))) tail.pop();
      }
      // Title-cased as one line, so a minor word inside the tail stays lower.
      candidates.push(`${titleCase(['Why Was This', ...subject, passive[1], ...tail].join(' '))}?`);
    }
    // A charged clause already reads as a headline; keep a tighter claim too.
    const charged = words.find((word) => CHARGED.has(norm(word)));
    if (charged && words.length > 9) candidates.push(titleCase(focus(clause, 9).join(' ')));
  }
  // Last resort: the clip's own title, compressed the same way.
  if (context.title.trim()) {
    const titleWords = focus(compress(context.title), 14);
    if (titleWords.length >= 3) candidates.push(titleCase(titleWords.join(' ')));
  }
  return [...new Set(candidates)];
}

/** The strongest grounded deterministic headline, or null when none survives. */
export function deterministicHook(context: HookContext): HookScore | null {
  return chooseBestHook(deterministicHookCandidates(context), context).best;
}
