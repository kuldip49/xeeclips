// Regression for the source19 acceptance failure: the selected opening was the dangling fragment
// "A year through their labor, right?" (a 0.12 s-gap continuation of "...millions of dollars, right?"), and
// START_COMPLETE / CONTEXT_SUFFICIENT both passed because it follows terminal punctuation.
// The shared ClipBoundaryService now treats a tight-gap verbless fragment as a continuation and uses the
// existing bounded pre-roll to start at the sentence that sets it up. Synthetic words with the same structure.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { ClipBoundaryService, opensAsContinuation } = require('../dist/modules/content-intelligence/clip-boundary.service');
const { optimizeEditBoundaries } = require('../dist/modules/editing/edit-boundaries');

/** sentences: [text, gapBeforeSec, speaker?]; every word lasts 0.34 s with 0.04 s between words. */
function transcript(sentences, origin = 20) {
  const words = []; let cursor = origin;
  for (const [text, gap, speaker] of sentences) {
    cursor += gap;
    for (const token of text.split(' ')) {
      words.push({ text: token, start: Number(cursor.toFixed(3)), end: Number((cursor + .34).toFixed(3)), speaker: speaker ?? null });
      cursor += .38;
    }
  }
  return words;
}
const at = (words, text, nth = 0) => words.findIndex((w, i) => w.text === text && words.slice(0, i).filter(x => x.text === text).length === nth);
const service = new ClipBoundaryService();

const SOURCE19_SHAPE = [
  ['It is not a fair comparison.', 1.0],
  ['So imagine you own two hundred cars and they sell for thousands, right?', .3],
  ['A year through their sales, right?', .12],                       // the dangling appositive
  ['So what happens is nobody has any profit left because the costs were never counted.', .3],
  ['Well, let us look at it like this.', .35],
  ['This is an era where cars were a fact in reality around the world.', .4]
];
const words = transcript(SOURCE19_SHAPE);
const fragment = at(words, 'A');
const setup = at(words, 'So');                                       // "So imagine..." (first "So")
const last = words.at(-1);

// 1. The detector: only the tight-gap verbless fragment is a continuation.
assert.equal(opensAsContinuation(words, fragment), true, 'the source19 fragment is a continuation');
assert.equal(opensAsContinuation(words, setup), false, 'a full sentence after a pause is standalone');
assert.equal(opensAsContinuation(words, at(words, 'Well,')), false);
assert.equal(opensAsContinuation(words, 0), false);

// 2. A selection that starts on the fragment is invalid as-is...
const selected = { startTime: words[fragment].start - .02, endTime: last.end + .1, transcriptText: '' };
const asSelected = service.validate({ ...selected }, words, { sourceDuration: last.end + 5 });
assert.equal(asSelected.valid, false, 'the source19 opening must fail boundary QA');
assert.equal(asSelected.qa.CONTEXT_SUFFICIENT, false);

// 3. ...and repair moves back to the setup sentence, the smallest natural earlier start.
const repaired = service.repair(selected, words, { sourceDuration: last.end + 5 });
assert(repaired.reasons.includes('CONTEXT_PREROLL_CONTINUATION'));
assert(Math.abs(repaired.startTime - (words[setup].start - .08)) < 1e-6, `starts at the setup sentence, got ${repaired.startTime}`);
assert(repaired.startTime < words[fragment].start - 3, 'moved back to the sentence that introduces the fragment');
assert(repaired.startTime > words[setup - 1].end - .001, 'but no further than that sentence (smallest natural boundary, not the full pre-roll)');
assert.deepEqual(repaired.qa, { START_COMPLETE: true, END_COMPLETE: true, THOUGHT_COMPLETE: true,
  QUESTION_RESOLVED: true, PUNCHLINE_INCLUDED: true, CONTEXT_SUFFICIENT: true });
assert.equal(repaired.valid, true);
assert(Math.abs(repaired.endTime - service.repair({ ...selected, startTime: words[setup].start }, words, { sourceDuration: last.end + 5 }).endTime) < 1e-6,
  'the complete ending is untouched by the opening repair');
assert(repaired.endTime >= last.end, 'final sentence still complete');
// Re-validating the repaired range passes (this is the QA the exporter re-runs on the final range).
assert.equal(service.validate({ startTime: repaired.startTime, endTime: repaired.endTime, transcriptText: repaired.transcriptText }, words,
  { sourceDuration: last.end + 5 }).valid, true);

// 4. The editorial opening planner agrees: it does not pick the fragment, and extends back when handed it.
const window = { windowStart: words[0].start - 1, windowEnd: last.end + 2 };
const planned = optimizeEditBoundaries({ words, candidateStart: selected.startTime, candidateEnd: selected.endTime, ...window });
assert(planned.editedStart < words[fragment].start - 3, `planner start ${planned.editedStart} must include the setup`);
assert.equal(planned.clipStartContextComplete, true);
const fromRepaired = optimizeEditBoundaries({ words, candidateStart: repaired.startTime, candidateEnd: repaired.endTime, ...window });
assert(fromRepaired.editedStart < words[fragment].start - 3, 'the planner never moves the repaired start forward onto the fragment');

// 5. Controls: nothing changes when the evidence is absent.
const control = (mutate) => {
  const copy = JSON.parse(JSON.stringify(SOURCE19_SHAPE)); mutate(copy);
  const w = transcript(copy); return { w, i: at(w, 'A') };
};
let c = control(s => { s[2][1] = 1.5; });                            // a real pause (>1.2 s after a question): standalone
assert.equal(opensAsContinuation(c.w, c.i), false, 'a real pause makes the fragment standalone');
c = control(s => { s[1][2] = 'A'; s[2][2] = 'B'; });                 // another speaker
assert.equal(opensAsContinuation(c.w, c.i), false, 'a different speaker is not a continuation');
c = control(s => { s[2][0] = 'In the end we sold them all, right?'; });
assert.equal(opensAsContinuation(c.w, at(c.w, 'In')), false, 'a clause with a verb phrase is standalone');
c = control(s => { s[2][0] = 'It was a year through their sales, right?'; });
assert.equal(opensAsContinuation(c.w, at(c.w, 'It', 1)), false);
const plain = transcript([['Our first sentence stands alone and explains the plan clearly to everyone watching today.', 0],
  ['A second full sentence follows it and finishes the thought with a clear conclusion for viewers.', .3],
  ['And a third sentence closes the whole idea so the clip ends naturally for people.', .3]]);
const normal = service.repair({ startTime: plain[0].start, endTime: plain.at(-1).end, transcriptText: '' }, plain);
assert.equal(normal.valid, true); assert.deepEqual(normal.reasons, [], 'ordinary clips are not touched');

// 6. Setup out of pre-roll reach: the fragment is dropped, not the whole clip rejected.
const far = transcript([['It is not a fair comparison.', 0], ['Many many words fill a very long sentence here so the setup is far away from the fragment by the time it ends, right?', .3],
  ['A year through their sales, right?', .12], ['The result is that nobody keeps any profit because the costs were never counted anywhere.', .45],
  ['That is the whole story of what happened to everyone involved in that long process.', .45]]);
const farFragment = at(far, 'A');
const farRepair = service.repair({ startTime: far[farFragment].start, endTime: far.at(-1).end, transcriptText: '' }, far, { preRoll: 2, minDuration: 5 });
assert(farRepair.reasons.includes('CONTINUATION_FRAGMENT_DROPPED'));
assert(farRepair.startTime > far[farFragment].start, 'unreachable setup: start moves past the fragment');

// 7. "So imagine ..." is a topic opener, but a consequence "So what happens..." still depends on earlier context.
const imagine = transcript([['So imagine you own two hundred cars on a lot and every one of them sells today.', 0],
  ['That is a lot of money for a single year and nobody can really argue with it today.', .3]]);
assert.equal(service.repair({ startTime: imagine[0].start, endTime: imagine.at(-1).end, transcriptText: '' }, imagine, { minDuration: 5 }).qa.CONTEXT_SUFFICIENT, true);
const consequence = transcript([['So what happens is nobody keeps any profit because the costs were never counted anywhere.', 0],
  ['That is a lot of money for a single year and nobody can really argue with it today.', .3]]);
assert.equal(service.repair({ startTime: consequence[0].start, endTime: consequence.at(-1).end, transcriptText: '' }, consequence, { minDuration: 5 }).qa.CONTEXT_SUFFICIENT, false);

// 8. The real source19 chain: the raw candidate starts on the dependent "So what happens is..." (itself a consequence of
//    the fragment, which is a tail of the setup). Hop one reaches the fragment (existing rule), hop two the setup. Each hop
//    stays within one pre-roll of the opening it repairs and the total within two, so the setup 8 s before the raw start is
//    reached; a setup beyond two pre-rolls is not.
const consequenceAt = at(words, 'So', 1);
const chain = service.repair({ startTime: words[consequenceAt].start, endTime: last.end + .1, transcriptText: '' }, words, { sourceDuration: last.end + 5 });
assert(Math.abs(chain.startTime - (words[setup].start - .08)) < 1e-6 || Math.abs(chain.startTime - words[setup].start) < 1e-6, `two-hop chain starts at the setup, got ${chain.startTime}`);
assert.equal(chain.valid, true); assert.deepEqual(Object.values(chain.qa).every(Boolean), true);
assert(words[consequenceAt].start - chain.startTime > 5, 'the setup is further than one pre-roll from the raw start, but each hop is within one');
const tooFar = service.repair({ startTime: words[consequenceAt].start, endTime: last.end + .1, transcriptText: '' }, words, { sourceDuration: last.end + 5, preRoll: 2.4 });
assert.equal(tooFar.valid, false, 'a setup beyond two pre-rolls of the raw start is out of reach: the candidate is not silently stretched');
console.log('Boundary continuation: tight-gap fragment detected, bounded pre-roll to the setup sentence, complete ending kept, planner agrees, controls unchanged: PASS');
console.log(JSON.stringify({ original: selected.startTime, repaired: repaired.startTime, end: repaired.endTime, reasons: repaired.reasons, qa: repaired.qa }));
