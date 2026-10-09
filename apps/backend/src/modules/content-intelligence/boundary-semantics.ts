/** Conservative discourse evidence. Unknown or unfulfilled setups are never paid off by punctuation alone. */
export const newTopic = (text: string) => /^(?:next topic|moving on|another question|on a different note|anyway[, ]|अब अगला|दूसरी बात)/iu.test(text.trim());
export const storySetup = /\b(?:we (?:decided|started|wanted) to test|let['’]?s (?:see|find out)|to find out|the (?:story|test|experiment) (?:began|started)|what happened next|wait until|joke|setup|knock knock)\b|फिर क्या हुआ|पता लगाने|मजाक|मज़ाक/iu;
const payoff = /\b(?:the (?:result|punchline|answer|conclusion)|turns? out|proved|discovered|found out|realized|revealed|in the end|finally|that (?:conversation|experience|decision)|so we|that's (?:why|how))\b|नतीजा|पता चला|आखिर|इसलिए|अंत में/iu;
export function endingSignals(text: string, nextText: string, continues: boolean) {
  const sentences = text.split(/(?<=[.!?।॥])\s+/u).filter(Boolean);
  const last = sentences.at(-1) ?? text;
  const noClause = !/(?:\b(?:and|but|because|which|that|if|when|to|the|a|an|such as|for example|first|second|third|realized|discovered)|और|लेकिन|क्योंकि|अगर|तो)[,;:]?[.!?।॥]*\s*$/iu.test(last)
    && !/(?:\.{3}|…|[:,;])\s*$/u.test(last);
  const noPronoun = !/^(?:this|that|it|he|she|they|यह|वह)[.!?।॥]*$/iu.test(last.trim());
  const questionIndex = sentences.reduce((found, s, i) => /\?["'’”)]*$/u.test(s) && !/\b(?:right|okay|correct|huh)\?["'’”)]*$/iu.test(s) ? i : found, -1);
  const questionResolved = questionIndex < 0 || sentences.slice(questionIndex + 1).some(s => /[.!।॥]["'’”)]*$/u.test(s.trim()));
  const announced = text.match(/(?:\b(?:there are|for|these are)\s+(two|three|four|five|2|3|4|5)\s+(?:steps|reasons|things|rules)|(?<hindi>दो|तीन|चार|पांच)\s+(?:कारण|कदम|बातें))/iu);
  const expected = ({ two: 2, three: 3, four: 4, five: 5, '2': 2, '3': 3, '4': 4, '5': 5, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5 } as Record<string, number>)[announced?.[1]?.toLowerCase() ?? announced?.groups?.hindi ?? ''] ?? 0;
  const items = new Set((text.match(/\b(?:first|second|third|fourth|fifth|finally)\b|पहला|दूसरा|तीसरा|चौथा|पांचवां|आखिर/giu) ?? []).map(s => s.toLowerCase()));
  const listComplete = !expected || items.size >= expected;
  const setupIndex = sentences.reduce((found, s, i) => storySetup.test(s) ? i : found, -1);
  const storyComplete = setupIndex < 0 || sentences.slice(setupIndex).some(s => payoff.test(s));
  const joke = /\b(?:joke|setup|knock knock)\b|मजाक|मज़ाक/iu.test(text);
  const punchline = !joke || /\b(?:punchline|turns? out)\b|पंचलाइन/iu.test(text);
  const unresolved = /(?:here(?:'s| is) (?:why|how)|let me explain|the punchline is|asked (?:me )?(?:why|how)|पहला कारण)[.!?।॥]?$/iu.test(last)
    || (/\b(?:we (?:started|began) testing|we ordered .+ to (?:test|see)|we decided to test|(?:as|just as) a test)\b/iu.test(last) && !payoff.test(last));
  const conclusion = !continues || !/^(?:therefore|in conclusion|that['’]s (?:why|how|what)|which means|as a result|इसलिए|नतीजा)/iu.test(nextText);
  const claim = noClause && !unresolved && conclusion;
  const satisfied = questionResolved && listComplete && storyComplete && punchline && claim && noPronoun;
  return { QUESTION_RESOLVED: questionResolved, PUNCHLINE_INCLUDED: punchline,
    CONCLUSION_INCLUDED: conclusion, CLAIM_RESOLVED: claim, LIST_COMPLETE: listComplete,
    STORY_BEAT_COMPLETE: storyComplete, NO_DANGLING_CLAUSE: noClause, NO_DANGLING_PRONOUN: noPronoun,
    NO_UNRESOLVED_SETUP: !unresolved && storyComplete, VIEWER_SATISFIED_END: satisfied };
}

/** Text primitives shared by the boundary service and the ending-evidence assessment. */
export const terminal = (s: string) => /[.!?।॥]["'’”\])]*$/u.test(s.trim()) && !/\.{3}$/u.test(s.trim());
export const dangling = (s: string) => /(?:\b(?:and|but|because|which|that|if|when|to|the|a|an|such as|for example|first|second|third)|और|लेकिन|क्योंकि|अगर|तो)[,;:]?\s*$/iu.test(s.replace(/[.!?।]+$/u, ''));
export const continuation = (s: string) => /^(?:and|but|then|so|because|therefore|which means|in other words|as a result|second|third|finally|the answer|the punchline|the result|turns out|in the end|that conversation|that experience|that decision|that['’]s (?:why|how|what)|और|लेकिन|क्योंकि|इसलिए|मतलब|आखिर|नतीजा)[\s,:]/iu.test(s.trim());
export const CLAUSE_WORD = /^(?:is|are|was|were|am|be|been|being|has|have|had|do|does|did|will|would|can|could|should|shall|may|might|must|get|gets|got|go|goes|went|say|says|said|think|thinks|know|knows|mean|means|want|wants|need|needs|make|makes|made|take|takes|took|see|sees|saw|let|lets|let's|i|you|we|he|she|they|it)$|['’](?:s|re|m|ve|ll|d)$|n['’]t$/iu;
export const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}'’]/gu, '');
