import { Injectable } from '@nestjs/common';

export type BoundaryWord = { start: number; end: number; text: string; speaker?: string | null };
export type BoundaryQa = { START_COMPLETE: boolean; END_COMPLETE: boolean; THOUGHT_COMPLETE: boolean;
  QUESTION_RESOLVED: boolean; PUNCHLINE_INCLUDED: boolean; CONTEXT_SUFFICIENT: boolean };
export type BoundaryRepair = { startTime: number; endTime: number; transcriptText: string;
  qa: BoundaryQa; valid: boolean; evidenceAvailable: boolean; reasons: string[];
  startAdjustment: number; endAdjustment: number; score: number };
export type BoundaryOptions = { preRoll?: number; extension?: number; minDuration?: number;
  maxDuration?: number; sourceDuration?: number };
const terminal = (s: string) => /[.!?।॥]["'’”\])]*$/u.test(s.trim()) && !/\.{3}$/u.test(s.trim());
const dangling = (s: string) => /(?:\b(?:and|but|because|which|that|if|when|to|the|a|an|such as|for example|first|second|third)|और|लेकिन|क्योंकि|अगर|तो)[,;:]?\s*$/iu.test(s.replace(/[.!?।]+$/u, ''));
// "So imagine you got...", "So let's look..." open a NEW thought; only a "so" that draws a consequence depends on
// what was said before it.
const topicOpener = (s: string) => /^so,?\s+(?:imagine|picture|suppose|consider|let['’]?s|let us|look|listen|think about|say)\b/iu.test(s.trim());
const dependent = (s: string) => !topicOpener(s) && /^(?:(?:and|but|because|so|then|that|this|it|they|he|she|which|that's why)\b|(?:और|लेकिन|क्योंकि|इसलिए|वह|ये|तो)(?:\s|[,।]))/iu.test(s.trim());
const continuation = (s: string) => /^(?:and|but|then|so|because|therefore|which means|in other words|as a result|second|third|finally|the answer|the punchline|that's why|और|लेकिन|क्योंकि|इसलिए|मतलब|आखिर)[\s,:]/iu.test(s.trim());
const unresolved = (s: string) => /(?:here(?:'s| is) (?:why|how)|let me explain|for (?:two|three|four) reasons|the punchline is|asked (?:me )?(?:why|how)|there are \w+ (?:steps|reasons)|पहला कारण)[.!?।]?$/iu.test(s.trim());

// A verbless noun/prepositional fragment ("A year through their labor, right?") is an appositive of the sentence
// spoken just before it. Closed-class heads and the common verb forms are enough to recognise one; no tagger needed.
const FRAGMENT_HEAD = /^(?:a|an|the|one|two|three|four|five|six|seven|eight|nine|ten|each|every|another|per|of|in|on|at|for|with|through|by|from|over|under|about|around|across|during|within|without|into|onto|upon|including|plus|as)$/iu;
const CLAUSE_WORD = /^(?:is|are|was|were|am|be|been|being|has|have|had|do|does|did|will|would|can|could|should|shall|may|might|must|get|gets|got|go|goes|went|say|says|said|think|thinks|know|knows|mean|means|want|wants|need|needs|make|makes|made|take|takes|took|see|sees|saw|let|lets|let's|i|you|we|he|she|they|it)$|['’](?:s|re|m|ve|ll|d)$|n['’]t$/iu;
const TAG = new Set(['right', 'okay', 'ok', 'yeah', 'huh', 'correct', 'no']);
const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}'’]/gu, '');

/**
 * Does the sentence opening at `index` only make sense as the tail of the sentence just before it?
 * Evidence (all from the transcript): the same voice (or no speaker labels), a breath-length gap to the previous
 * sentence (<0.5 s; <1.2 s after a question), and an opening that is a short verbless fragment. Without the earlier
 * words a cold viewer hears a dangling phrase. Shared by the boundary repair and the editorial opening planner.
 */
export function opensAsContinuation(words: Array<{ start: number; end: number; text: string; speaker?: string | null }>, index: number): boolean {
  if (index <= 0 || index >= words.length) return false;
  const previous = words[index - 1], open = words[index];
  if (previous.speaker && open.speaker && previous.speaker !== open.speaker) return false;
  const gap = open.start - previous.end;
  const afterQuestion = /\?["'’”\])]*$/u.test(previous.text.trim());
  if (gap < 0 || gap >= (afterQuestion ? 1.2 : .5)) return false;
  const sentence: string[] = [];
  for (let i = index; i < words.length && sentence.length < 12; i++) {
    sentence.push(bare(words[i].text));
    if (terminal(words[i].text)) break;
  }
  while (sentence.length && TAG.has(sentence[sentence.length - 1])) sentence.pop();
  if (!sentence.length || sentence.length > 6) return false;
  return FRAGMENT_HEAD.test(sentence[0]) && !sentence.some(token => CLAUSE_WORD.test(token));
}

/** Preserve actual word timing and speaker turns. Segment punctuation may close an otherwise unpunctuated final word. */
export function transcriptBoundaryWords(segments: Array<{ start?: number; end?: number; text?: string; speaker?: string | null; words?: unknown }>): BoundaryWord[] {
  return segments.flatMap(segment => {
    const raw = Array.isArray(segment.words) ? segment.words : [];
    const words: BoundaryWord[] = raw.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const w = item as Record<string, unknown>;
      const text = typeof w.text === 'string' ? w.text : typeof w.word === 'string' ? w.word : '';
      return typeof w.start === 'number' && typeof w.end === 'number' && text ? [{ start: w.start, end: w.end, text, speaker: segment.speaker }] : [];
    });
    if (words.length && terminal(segment.text ?? '') && !terminal(words.at(-1)!.text))
      words.at(-1)!.text += (segment.text ?? '').match(/[.!?।॥]["'’”\])]*$/u)?.[0] ?? '.';
    // Without word timings, use actual whole segments, never fabricated equal-width word timestamps.
    if (!words.length && typeof segment.start === 'number' && typeof segment.end === 'number' && segment.text)
      return [{ start: segment.start, end: segment.end, text: segment.text, speaker: segment.speaker }];
    return words;
  }).sort((a,b) => a.start - b.start);
}

@Injectable()
export class ClipBoundaryService {
  repair(candidate: { startTime: number; endTime: number; transcriptText: string }, raw: BoundaryWord[], options: BoundaryOptions = {}): BoundaryRepair {
    const words = raw.filter(w => Number.isFinite(w.start) && Number.isFinite(w.end) && w.start >= 0 && w.end > w.start && w.text.trim())
      .sort((a, b) => a.start - b.start);
    const before = options.preRoll ?? 6, after = options.extension ?? 12;
    const min = options.minDuration ?? 15, max = options.maxDuration ?? 120;
    const sourceEnd = options.sourceDuration ?? words.at(-1)?.end ?? candidate.endTime;
    const reasons: string[] = [];
    const finish = (startTime: number, endTime: number, transcriptText: string, qa: BoundaryQa, evidenceAvailable: boolean): BoundaryRepair => ({
      startTime, endTime, transcriptText, qa, evidenceAvailable,
      valid: evidenceAvailable && Object.values(qa).every(Boolean) && endTime - startTime >= min - .001 && endTime - startTime <= max + .001,
      reasons, startAdjustment: startTime - candidate.startTime, endAdjustment: endTime - candidate.endTime,
      score: Math.round(Object.values(qa).filter(Boolean).length / 6 * 100) });
    if (!words.length) {
      reasons.push('NO_TIMING_EVIDENCE');
      return finish(candidate.startTime, candidate.endTime, candidate.transcriptText,
        { START_COMPLETE: false, END_COMPLETE: false, THOUGHT_COMPLETE: false, QUESTION_RESOLVED: false, PUNCHLINE_INCLUDED: false, CONTEXT_SUFFICIENT: false }, false);
    }
    const naturalAfter = (i: number) => {
      const w = words[i], next = words[i + 1];
      if (dangling(w.text)) return false;
      return terminal(w.text) || (!!next && (next.start - w.end >= .8 ||
        (!!w.speaker && !!next.speaker && w.speaker !== next.speaker && next.start >= w.end))) ;
    };
    const starts: number[] = [0];
    words.forEach((_, i) => { if (i < words.length - 1 && naturalAfter(i)) starts.push(i + 1); });
    let first = words.findIndex(w => w.end > candidate.startTime + .001);
    if (first < 0) first = words.length - 1;
    // Include the complete sentence containing the proposed start, rather than dropping its first words.
    let startIndex = [...starts].reverse().find(i => i <= first) ?? 0;
    if (candidate.startTime - words[startIndex].start > before) {
      startIndex = starts.find(i => i >= first && words[i].start < candidate.endTime - min) ?? first;
      reasons.push('START_EXCEEDS_PREROLL');
    }
    if (dependent(words.slice(startIndex, startIndex + 6).map(w => w.text).join(' '))) {
      const previous = [...starts].reverse().find(i => i < startIndex && candidate.startTime - words[i].start <= before);
      if (previous !== undefined) startIndex = previous;
    }
    // A fragment that continues the preceding sentence needs that sentence: use the same bounded pre-roll, one
    // sentence at a time and only as far as needed. Each hop reaches back at most `before` seconds from the opening
    // it repairs (the dependent-start step above may already have moved the opening off the raw candidate start),
    // and the whole repair never reaches back more than two pre-rolls. When the setup is out of reach, the
    // fragment is dropped instead.
    for (let hops = 0; hops < 2 && opensAsContinuation(words, startIndex); hops++) {
      const previous = [...starts].reverse().find(i => i < startIndex &&
        words[startIndex].start - words[i].start <= before && candidate.startTime - words[i].start <= before * 2);
      if (previous !== undefined) { startIndex = previous; reasons.push('CONTEXT_PREROLL_CONTINUATION'); continue; }
      const forward = starts.find(i => i > startIndex && words[i].start < candidate.endTime - min);
      if (forward !== undefined) { startIndex = forward; reasons.push('CONTINUATION_FRAGMENT_DROPPED'); }
      break;
    }
    // 80 ms of room before the first word, but never inside the previous word: back-to-back words would
    // otherwise make the previous sentence's last word the first thing the editor and QA see.
    const previousEnd = startIndex > 0 ? words[startIndex - 1].end : 0;
    const startTime = Math.max(0, Math.min(words[startIndex].start, Math.max(previousEnd, words[startIndex].start - .08)));
    const endLimit = Math.min(sourceEnd, candidate.endTime + after, startTime + max);
    const textTo = (i: number) => words.slice(startIndex, i + 1).map(w => w.text.trim()).join(' ');
    const questionResolved = (i:number) => {
      const sentences=textTo(i).split(/(?<=[.!?।])\s+/u);
      const lastQuestion=sentences.map((s,j)=>/\?["'”]?$/u.test(s)?j:-1).reduce((a,b)=>Math.max(a,b),-1);
      if(lastQuestion<0)return true;
      if(!sentences.slice(lastQuestion+1).some(s=>s.trim()&&terminal(s)))return false;
      const nextText=words.slice(i+1,i+9).map(w=>w.text).join(' ');
      return !(words[i+1]?.speaker&&words[i].speaker===words[i+1].speaker&&words[i+1].start-words[i].end<1.2
        && !/^(?:next topic|moving on|another question)/iu.test(nextText));
    };
    const punchlineIncluded = (i:number) => !(/\b(?:joke|setup|knock knock)\b/iu.test(textTo(i)) &&
      /\b(?:punchline|turns out|but then)\b/iu.test(words.slice(i+1,i+9).map(w=>w.text).join(' ')));
    const thoughtResolved = (i: number) => {
      const text = textTo(i), nextText = words.slice(i + 1, i + 9).map(w => w.text).join(' ');
      if (dangling(text) || unresolved(text)) return false;
      // A question is setup, not a complete answer. Do not certify a question-only selection.
      if (!questionResolved(i)) return false;
      const list = text.match(/(?:\b(?:there are|for|these are)\s+(two|three|four|2|3|4)\s+(?:steps|reasons|things)|(?:दो|तीन|चार)\s+(?:कारण|कदम))/iu);
      if (list) {
        const expected = ({two:2,three:3,four:4,'2':2,'3':3,'4':4} as Record<string,number>)[list[1]?.toLowerCase()] ?? 3;
        const count = (text.match(/\b(?:first|second|third|fourth|finally)\b|पहला|दूसरा|तीसरा|आखिर/giu) ?? []).length;
        if (count < expected) return false;
      }
      if (words[i + 1] && words[i + 1].start - words[i].end < 1.2 && continuation(nextText)) return false;
      if (!punchlineIncluded(i)) return false;
      return true;
    };
    const ends = words.map((w, i) => ({ w, i })).filter(({w, i}) => i >= startIndex && w.end <= endLimit + .001 &&
      naturalAfter(i) && w.end - startTime >= min - .001 && thoughtResolved(i));
    // First complete thought at/after the target; if too long, choose the last complete earlier thought.
    const selected = ends.find(({w}) => w.end >= candidate.endTime - .001) ?? ends.at(-1);
    const endIndex = selected?.i ?? Math.max(startIndex, words.map((w, i) => w.end <= endLimit ? i : -1).reduce((a,b) => Math.max(a,b), -1));
    const last = words[endIndex], next = words[endIndex + 1];
    const endTime = Math.min(sourceEnd, last.end + Math.min(.15, Math.max(0, (next?.start ?? last.end + .15) - last.end)));
    const text = textTo(endIndex);
    const startComplete = starts.includes(startIndex);
    const endComplete = naturalAfter(endIndex) && last.end <= endLimit + .001;
    const context = startComplete && !dependent(text) && !opensAsContinuation(words, startIndex);
    const thought = endComplete && thoughtResolved(endIndex);
    if (!startComplete || !context) reasons.push('UNRESOLVED_START_CONTEXT');
    if (!endComplete) reasons.push('UNFINISHED_SENTENCE');
    if (!thought) reasons.push('UNRESOLVED_THOUGHT');
    if (endTime - startTime < min || endTime - startTime > max) reasons.push('DURATION_BOUNDS');
    return finish(startTime, endTime, text, { START_COMPLETE: startComplete, END_COMPLETE: endComplete,
      THOUGHT_COMPLETE: thought, QUESTION_RESOLVED: questionResolved(endIndex), PUNCHLINE_INCLUDED: punchlineIncluded(endIndex), CONTEXT_SUFFICIENT: context }, true);
  }

  /** Validate a renderer's FINAL range, including changes by the editing planner. No silent repair here. */
  validate(range: { startTime: number; endTime: number; transcriptText: string }, words: BoundaryWord[], options: BoundaryOptions = {}) {
    const repaired = this.repair(range, words, options);
    const spoken = words.filter(w => w.end > range.startTime && w.start < range.endTime);
    const first = spoken[0], last = spoken.at(-1);
    const sameStart = !first || repaired.startTime >= range.startTime - .15 && repaired.startTime <= first.start + .001;
    const sameEnd = !last || repaired.endTime <= range.endTime + .001 && repaired.endTime >= last.end - .001;
    return { ...repaired, valid: repaired.valid && sameStart && sameEnd,
      // Context is only sufficient for the range actually being validated: when the repair had to start earlier
      // than this range does, this range lacks the setup the repair found.
      qa: { ...repaired.qa, START_COMPLETE: repaired.qa.START_COMPLETE && sameStart,
        CONTEXT_SUFFICIENT: repaired.qa.CONTEXT_SUFFICIENT && sameStart,
        END_COMPLETE: repaired.qa.END_COMPLETE && sameEnd } };
  }
}
