// Ending QA under ASR uncertainty. Regression for the V2 production-acceptance blocker: the fresh Delivery transcript
// ended "...more like a metal..." (the speaker said "Manuel") and the shared boundary gate refused the clip.
//
// Principle under test: a clip ending fails only when the COMBINED evidence says the thought is incomplete - never because
// one questionable final token looks wrong - while genuinely unfinished endings still fail.
//
// Synthetic transcripts use the same timing model as test-clip-boundary-continuation.cjs (0.34 s words, 0.04 s apart).
// The Delivery fixture is REAL faster-whisper output (see scripts/fixtures/delivery-ending-asr.json).
require('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ClipBoundaryService, transcriptBoundaryWords } = require('../dist/modules/content-intelligence/clip-boundary.service');
const { assessEnding, tailPassFromResponse, closeSentence, ASR_ENDING_POLICY } = require('../dist/modules/content-intelligence/ending-evidence');
const { retainedBoundaryQa } = require('../dist/modules/content-intelligence/edit-project-evidence');
const service = new ClipBoundaryService();
let checks = 0;
const check = (name, fn) => { try { fn(); checks++; } catch (error) { error.message = `[${name}] ${error.message}`; throw error; } };

/** sentences: {text, gap, p, base, speaker}. `p` = the LAST token's confidence; omit the key for "no confidence info". */
function build(sentences, origin = 0) {
  const words = []; let cursor = origin;
  for (const s of sentences) {
    cursor += s.gap ?? .3;
    const tokens = s.text.split(' ');
    tokens.forEach((token, i) => {
      const w = { text: token, start: Number(cursor.toFixed(3)), end: Number((cursor + .34).toFixed(3)), speaker: s.speaker ?? null };
      const p = i === tokens.length - 1 && 'p' in s ? s.p : (s.base ?? .95);
      if (typeof p === 'number') w.confidence = p;
      if (i === tokens.length - 1) w.segmentEnd = true;   // each synthetic sentence is one ASR segment, as real segments are
      words.push(w); cursor += .38;
    });
  }
  return words;
}
const LEAD = [{ text: 'We checked the names against the people at the door.', gap: 0 },
  { text: 'The first name did not match the face at all.', gap: .4 }];
const AFTER = { text: 'Then everybody moved on to talk about the parking situation outside.', gap: 1.3 };
const lastToken = (sentence) => sentence.text.split(' ').at(-1);

/**
 * Judge the clip that ends with `target`. inSource: more speech follows after a real pause. Otherwise the source ends
 * `pad` seconds after the last word. minDuration excludes earlier endings, so the verdict is about THIS boundary.
 */
function judge(target, { inSource = false, pad = .11, tail, follow = AFTER, lead = LEAD } = {}) {
  const sentences = [...lead, target, ...(inSource ? [follow] : [])];
  let words = build(sentences);
  const targetCount = build([...lead, target]).length, targetLast = words[targetCount - 1];
  if (tail) words = words.map((w, i) => i === targetCount - 1 ? { ...w, tailPass: typeof tail === 'function' ? tail(words.slice(0, targetCount)) : tail } : w);
  const sourceDuration = inSource ? words.at(-1).end + 1 : targetLast.end + pad;
  const result = service.repair({ startTime: words[0].start, endTime: targetLast.end, transcriptText: '' }, words,
    { sourceDuration, minDuration: targetLast.end - words[0].start - .01 });
  const atBoundary = result.valid && result.transcriptText.trim().endsWith(lastToken(target));
  return { result, words, targetLast, atBoundary, evidence: result.endingEvidence, sourceDuration, targetIndex: targetCount - 1 };
}
function tailFor(words, { finalText, finalP = .47, scramble = false, extra = null, speechContinues = null, endsMs = 110, stopped = false } = {}) {
  const last = words.at(-1);
  const fresh = words.slice(-8, -1).map(w => ({ text: scramble ? `zz${w.text}` : w.text, start: w.start, end: w.end, confidence: .9 }));
  fresh.push({ text: finalText, start: last.start, end: last.end + .05, confidence: finalP });
  if (extra) fresh.push({ text: extra, start: last.end + .3, end: last.end + .6, confidence: .9 });
  return tailPassFromResponse({ window_start: fresh[0].start, window_end: last.end + .11, language: 'en', words: fresh,
    acoustics: { final_word_end: last.end, stopped, speech_continues: speechContinues, audio_ends_ms: endsMs, post_silence_ms: 0 } }, last.end);
}
const S = (text, extra = {}) => ({ text, gap: .3, ...extra });
const PUNCH = 'It turns out it looks more like a';

// ---- 1. correct final word ----------------------------------------------------------------------------------------
check('1 correct word', () => {
  const j = judge(S(`${PUNCH} Manuel.`, { p: .95 }));
  assert(j.atBoundary, JSON.stringify(j.result.reasons));
  assert.equal(j.evidence, undefined, 'a plainly punctuated ending needs no ASR-uncertainty reasoning');
});

// ---- 2. wrong final proper noun ----------------------------------------------------------------------------------
check('2a wrong noun, plain full stop (the pass-through case)', () => {
  assert(judge(S(`${PUNCH} metal.`, { p: .42 })).atBoundary, 'a misspelt name with a full stop already passed and must keep passing');
});
check('2b wrong noun + ellipsis, speech follows after a pause: ACCEPTED on stored evidence alone', () => {
  const j = judge(S(`${PUNCH} metal...`, { p: .42 }), { inSource: true });
  assert(j.atBoundary, JSON.stringify([j.result.reasons, j.evidence]));
  assert.equal(j.evidence.verdict, 'COMPLETE'); assert.equal(j.evidence.state, 'ASR_UNCERTAIN');
  assert.equal(j.evidence.closure, 'PAUSE'); assert(j.evidence.realSignals.includes('FINAL_WORD_CONFIDENCE_LOW'));
  assert(j.evidence.realSignals.includes('FINAL_WORD_CONFIDENCE_DROP'));
  assert(j.evidence.inferredSignals.includes('TRAILING_ELLIPSIS'));
  assert(j.result.reasons.includes('ENDING_ASR_UNCERTAIN_ACCEPTED'));
  assert(j.result.transcriptText.endsWith('metal...'), 'the clip text keeps the ASR spelling; only the QA reads past it');
  assert(Object.values(j.result.qa).every(Boolean));
});
check('2b-ii a pause alone is not an utterance boundary: the decoder must have ended its segment there', () => {
  const j = judge(S(`${PUNCH} metal...`, { p: .42 }), { inSource: true });
  assert(j.atBoundary);
  const mid = j.words.map((w, i) => i === j.targetIndex ? { ...w, segmentEnd: false } : w);
  const e = assessEnding({ words: mid, index: j.targetIndex, startIndex: 0, sourceEnd: j.sourceDuration });
  assert.equal(e.verdict, 'INCOMPLETE'); assert(e.reasons.includes('NOT_AT_ASR_UTTERANCE_BOUNDARY'));
  const unknown = j.words.map((w, i) => { const { segmentEnd, ...rest } = w; return i === j.targetIndex ? rest : w; });
  assert.equal(assessEnding({ words: unknown, index: j.targetIndex, startIndex: 0, sourceEnd: j.sourceDuration }).verdict, 'INCOMPLETE', 'unknown is not evidence');
  // A speaker turn is its own closure and needs no segment flag.
  const turn = judge(S(`${PUNCH} metal...`, { p: .42, speaker: 'A' }), { inSource: true, follow: { text: 'Honestly nobody believed a single word of that story.', speaker: 'B', gap: .1 } });
  assert(turn.atBoundary, JSON.stringify([turn.result.reasons, turn.evidence]));
});
check('2c wrong noun + ellipsis at the END OF THE SOURCE: stored evidence is not enough (strict) until a tail pass', () => {
  const j = judge(S(`${PUNCH} metal...`, { p: .42 }));
  assert.equal(j.result.valid, false);
  assert.equal(j.evidence.verdict, 'INCONCLUSIVE'); assert.equal(j.evidence.closure, 'SOURCE_END');
  assert(j.result.reasons.includes('ENDING_NEEDS_TAIL_VERIFICATION'));
});
check('2c-ii the margin between the last word and the end of the audio is not evidence (real fresh-ASR run: 30 ms)', () => {
  // The isolated pipeline run on the real Delivery audio placed the final word's end 30 ms before the end of the audio.
  for (const pad of [0, .005, .03, .11, .5]) {
    const j = judge(S(`${PUNCH} metal...`, { p: .32 }), { pad });
    assert.equal(j.evidence.closure, 'SOURCE_END', `pad ${pad}`); assert.equal(j.evidence.verdict, 'INCONCLUSIVE', `pad ${pad}: needs the tail pass`);
    const ok = judge(S(`${PUNCH} metal...`, { p: .32 }), { pad, tail: words => tailFor(words, { finalText: 'man' }) });
    assert(ok.atBoundary, `pad ${pad}: ${JSON.stringify([ok.result.reasons, ok.evidence])}`);
  }
});
check('2d ... and ACCEPTED when a bounded tail pass agrees on everything but the last word', () => {
  const j = judge(S(`${PUNCH} metal...`, { p: .42 }), { tail: words => tailFor(words, { finalText: 'man' }) });
  assert(j.atBoundary, JSON.stringify([j.result.reasons, j.evidence]));
  assert.equal(j.evidence.state, 'ASR_CONFLICTING'); assert.equal(j.evidence.tail.finalOnlyDiffers, true);
  assert.equal(j.evidence.tail.agreement, 1); assert.equal(j.evidence.tail.freshFinalToken, 'man');
});

// ---- 3. wrong homophone / 8. punctuation missing -----------------------------------------------------------------
check('3 homophone: "knight" for "night", no punctuation', () => {
  const t = S('We stayed up talking about it until late that knight', { p: .45 });
  assert(judge(t, { inSource: true }).atBoundary, 'pause closure + complete clause + weak last token');
  assert(judge(t, { tail: words => tailFor(words, { finalText: 'night.' }) }).atBoundary, 'source end: the tail pass resolves it');
  assert.equal(judge(t).result.valid, false, 'source end without a tail pass stays strict');
});
check('8 answer complete, punctuation missing, confident last word', () => {
  const t = [S('What did the company decide?'), S('They decided to cancel the whole contract and move to another vendor', { p: .92 })];
  const lead = [...LEAD, t[0]];
  const j = judge(t[1], { inSource: true, lead });
  assert(j.atBoundary, JSON.stringify([j.result.reasons, j.evidence]));
  assert.equal(j.evidence.state, 'ASR_UNCERTAIN'); assert(j.evidence.inferredSignals.includes('NO_TERMINAL_PUNCTUATION'));
  // At the END OF THE AUDIO a confident, unpunctuated last word is not noise: Whisper punctuates a sentence it heard finish,
  // so the missing stop is evidence of a cut. Only doubt about the token itself can excuse it, whatever a tail pass says.
  for (const tail of [undefined, words => tailFor(words, { finalText: 'vendor.', finalP: .9 })]) {
    const cut = judge(t[1], { lead, tail });
    assert.equal(cut.result.valid, false, 'source end, confident unpunctuated last word');
    assert.equal(assessEnding({ words: cut.words, index: cut.targetIndex, startIndex: 0, sourceEnd: cut.sourceDuration }).reasons.at(-1),
      'SOURCE_END_WITHOUT_TOKEN_DOUBT');
  }
});

// ---- 4. truncated last word ---------------------------------------------------------------------------------------
check('4 truncated last word is a cut, never rescued', () => {
  const t = S(`${PUNCH} Manu-`, { p: .3 });
  assert(!judge(t, { inSource: true }).atBoundary);
  const sourceEnd = judge(t, { tail: words => tailFor(words, { finalText: 'Manuel.', finalP: .9 }) });
  assert.equal(sourceEnd.result.valid, false);
  assert(sourceEnd.evidence.reasons.includes('TRUNCATED_FINAL_WORD'));
});

// ---- 5. sentence genuinely cut off --------------------------------------------------------------------------------
check('5 genuinely cut off sentences still fail, even with a weak last token and a long pause', () => {
  for (const [text, p, why] of [
    ['The second person looked more like a', .9, 'dangling article'],
    ['The second person was the one who had been...', .4, 'unfinished auxiliary'],
    ['We checked everything and it was fine but then...', .5, 'connective'],
    ['The second name matched the face of the person who...', .4, 'relative pronoun']]) {
    const t = S(text, { p });
    assert(!judge(t, { inSource: true }).atBoundary, `${why}: in-source`);
    assert.equal(judge(t).result.valid, false, `${why}: source end`);
    assert.equal(judge(t, { tail: words => tailFor(words, { finalText: 'zzz', finalP: .5 }) }).result.valid, false, `${why}: even with a tail pass`);
  }
});

// ---- 6. speaker continues immediately after the boundary ----------------------------------------------------------
check('6 speech continues straight after the boundary', () => {
  const target = S(`${PUNCH} metal...`, { p: .42 });
  for (const [gap, reason] of [[.06, 'SPEECH_CONTINUES_IMMEDIATELY'], [.55, 'NO_PAUSE_OR_TURN_AFTER_FINAL_WORD']]) {
    const j = judge(target, { inSource: true, follow: { text: 'and then he left the building without saying anything more.', gap } });
    assert(!j.atBoundary, `gap ${gap}`);
    const words = j.words; const e = assessEnding({ words, index: j.targetIndex, startIndex: 0, sourceEnd: j.sourceDuration });
    assert.equal(e.verdict, 'INCOMPLETE'); assert(e.reasons.includes(reason), e.reasons.join());
  }
  const dependent = judge(target, { inSource: true, follow: { text: 'And because of that nobody could say who he really was.', gap: 1.0 } });
  assert(!dependent.atBoundary, 'a dependent continuation after a pause');
});

// ---- 7. punchline complete with noisy ASR -------------------------------------------------------------------------
check('7 punchline with a noisy last word', () => {
  const lead = [...LEAD, S('Why was the delivery so late?')];
  const j = judge(S('Because the driver had the wrong address and delivered it to a Manuel...', { p: .4 }), { inSource: true, lead });
  assert(j.atBoundary, JSON.stringify([j.result.reasons, j.evidence]));
  assert(j.result.qa.QUESTION_RESOLVED && j.result.qa.PUNCHLINE_INCLUDED && j.result.qa.CLAIM_RESOLVED);
});

// ---- 9. answer incomplete despite silence -------------------------------------------------------------------------
check('9 silence does not complete an unfinished answer', () => {
  const unanswered = judge(S('So what actually happened to all of the money...', { p: .5 }), { inSource: true });
  assert(!unanswered.atBoundary, 'a question whose mark was lost is still a question');
  assert(assessEnding({ words: unanswered.words, index: unanswered.targetIndex, startIndex: 0, sourceEnd: unanswered.sourceDuration })
    .reasons.includes('UNPUNCTUATED_QUESTION_END'));
  const list = judge(S('The first reason is simply the cost...', { p: .5 }), { inSource: true,
    lead: [...LEAD, S('There are three reasons for this.')] });
  assert.equal(assessEnding({ words: list.words, index: list.targetIndex, startIndex: 0, sourceEnd: list.sourceDuration }).verdict, 'COMPLETE',
    'the ASR evidence alone is satisfied...');
  assert(!list.atBoundary, '...but the announced three-reason list is incomplete, so the semantic gate still refuses');
  assert(!judge(S('Something happened last week and let me explain...', { p: .5 }), { inSource: true }).atBoundary, 'announced but unexplained');
  const trailing = judge(S(`${PUNCH} Manuel...`, { p: .96 }), { inSource: true });
  assert(!trailing.atBoundary, 'a CONFIDENT word marked as trailing off is a genuine trail-off');
  const trailingEvidence = assessEnding({ words: trailing.words, index: trailing.targetIndex, startIndex: 0, sourceEnd: trailing.sourceDuration });
  assert.equal(trailingEvidence.state, 'ASR_RELIABLE'); assert(trailingEvidence.reasons.includes('TRAILING_OFF_CONFIRMED'));
  assert.equal(judge(S(`${PUNCH} Manuel...`, { p: .96 })).result.valid, false);
});

// ---- 10. low-confidence / unstable tail transcription -------------------------------------------------------------
check('10 an unstable tail pass cannot certify an ending', () => {
  const target = S(`${PUNCH} metal...`, { p: .42 });
  const cases = [
    ['tail words disagree beyond the last token', words => tailFor(words, { finalText: 'man', scramble: true }), 'TAIL_UNSTABLE'],
    ['tail pass hears more speech after the cut', words => tailFor(words, { finalText: 'man', extra: 'and' }), 'FRESH_PASS_HEARS_MORE_SPEECH'],
    ['audio shows voice running on past the word', words => tailFor(words, { finalText: 'man', speechContinues: true }), 'ACOUSTIC_SPEECH_CONTINUES'],
    ['fresh pass ends on a function word', words => tailFor(words, { finalText: 'the' }), 'FRESH_PASS_INCOMPLETE']];
  for (const [label, tail, reason] of cases) {
    const j = judge(target, { tail });
    assert.equal(j.result.valid, false, label); assert(j.evidence.reasons.includes(reason), `${label}: ${j.evidence.reasons}`);
  }
  for (const [label, broken] of [['no acoustics', p => ({ ...p, acoustics: undefined })], ['a word without a time', p => ({ ...p, words: [{ text: 'x' }, ...p.words] })],
    ['wrong version', p => ({ ...p, version: 2 })], ['words not an array', p => ({ ...p, words: 'nope' })]]) {
    const j = judge(target, { tail: words => broken(tailFor(words, { finalText: 'man' })) });
    assert.equal(j.evidence.verdict, 'INCONCLUSIVE', `malformed stored pass (${label}) is ignored, never thrown`);
  }
  const unrelated = judge(target, { tail: words => { const p = tailFor(words, { finalText: 'man' }); return { ...p, finalWordEnd: p.finalWordEnd + 5 }; } });
  assert.equal(unrelated.evidence.verdict, 'INCONCLUSIVE', 'a pass taken at a different word is ignored');
});
// 10b. bounded: exactly one tail request, failures keep the strict verdict (async, below)
(async () => {
  const target = S(`${PUNCH} metal...`, { p: .42 });
  const words = build([...LEAD, target]); const end = words.at(-1).end;
  const reviewer = { generate: async () => ({ data: { selectedIndex: 0, reason: 'complete' } }) };
  const run = (verifyTail, external = true) => service.repairSemantic({ startTime: 0, endTime: end, transcriptText: '' }, words, external ? reviewer : null, external,
    { sourceDuration: end + .11, minDuration: end - .01, verifyTail });
  let calls = 0, request;
  const ok = await run(async (r) => { calls++; request = r; return tailFor(words, { finalText: 'man' }); });
  assert.equal(calls, 1); assert(ok.valid, JSON.stringify(ok.reasons));
  assert(request.windowEnd - request.windowStart <= 9.01, 'a short window: never the whole source');
  assert.equal(request.wordEnd, end);
  for (const [label, probe] of [['null', async () => null], ['throws', async () => { throw new Error('ai service down'); }]]) {
    let n = 0; const r = await run(async (q) => { n++; return probe(q); });
    assert.equal(n, 1, label); assert.equal(r.valid, false, label); assert(r.reasons.includes('ENDING_NEEDS_TAIL_VERIFICATION'), label);
  }
  assert.equal((await run(undefined)).valid, false, 'no verifier configured: strict');
  // Deterministic-only mode (no semantic reviewer to confirm): an unreliable last word at the end of the audio stays strict
  // and costs no AI request.
  let offline = 0;
  const strictOnly = await run(async () => { offline++; return tailFor(words, { finalText: 'man' }); }, false);
  assert.equal(offline, 0, 'no tail request without a semantic review to follow'); assert.equal(strictOnly.valid, false);
  // And the reviewer keeps the last word: if it rejects the range, the tail pass does not rescue it.
  const refusing = { generate: async () => ({ data: { selectedIndex: -1, reason: 'sentence is cut off' } }) };
  const refused = await service.repairSemantic({ startTime: 0, endTime: end, transcriptText: '' }, words, refusing, true,
    { sourceDuration: end + .11, minDuration: end - .01, verifyTail: async () => tailFor(words, { finalText: 'man' }) });
  assert.equal(refused.valid, false); assert(refused.reasons.includes('SEMANTIC_BOUNDARY_REJECTED'));
  let plain = 0;
  const fine = await service.repairSemantic({ startTime: 0, endTime: end, transcriptText: '' }, build([...LEAD, S(`${PUNCH} Manuel.`)]), null, false,
    { sourceDuration: end + .11, minDuration: 1, verifyTail: async () => { plain++; return null; } });
  assert.equal(plain, 0, 'a normally punctuated ending never triggers a tail request'); assert(fine.valid);
  checks++;

  // The boundary reviewer is told the last word may be a misreading (stub router captures the prompt).
  let prompt;
  const router = { generate: async (q) => { prompt = q.request; return { data: { selectedIndex: 0, reason: 'complete' } }; } };
  const allWords = build([...LEAD, target, AFTER]);
  const tgtEnd = build([...LEAD, target]).at(-1).end;
  const reviewed = await service.repairSemantic({ startTime: 0, endTime: tgtEnd, transcriptText: '' }, allWords, router, true,
    { sourceDuration: allWords.at(-1).end + 1, minDuration: tgtEnd - .01 });
  assert(reviewed.reasons.includes('SEMANTIC_BOUNDARY_REVIEWED'), JSON.stringify(reviewed.reasons));
  assert(/speech-recognition misreading/.test(prompt.systemPrompt));
  assert(JSON.parse(prompt.userPrompt).ranges[0].endingNote.verdict === 'COMPLETE');
  checks++;

  await realDelivery();
  console.log(`Ending ASR uncertainty: ${checks} checks - noisy final tokens no longer fail finished thoughts; unfinished endings still do: PASS`);
})().catch(error => { console.error(error); process.exitCode = 1; });

// ---- the REAL Delivery production-failure fixture ----------------------------------------------------------------
async function realDelivery() {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/delivery-ending-asr.json'), 'utf8'));
  const withFinal = (final) => {
    const segments = JSON.parse(JSON.stringify(fixture.segments));
    const lastSegment = segments.at(-1); lastSegment.words.at(-1).text = final;
    lastSegment.text = lastSegment.text.replace(/\S+$/u, final);
    return segments;
  };
  const range = (segments) => { const w = transcriptBoundaryWords(segments); return { w, start: w[0].start, end: w.at(-1).end }; };
  const run = async (segments, verifyTail) => {
    const { w, start, end } = range(segments);
    const reviewer = { generate: async () => ({ data: { selectedIndex: 0, reason: 'complete' } }) };
    return service.repairSemantic({ startTime: start, endTime: end, transcriptText: '' }, w, reviewer, true,
      { sourceDuration: fixture.sourceDuration, minDuration: 9, verifyTail });
  };
  const probe = async (req) => tailPassFromResponse(fixture.tailResponse, req.wordEnd);
  const finalWord = transcriptBoundaryWords(withFinal('metal...')).at(-1);
  assert.equal(finalWord.confidence, 0.422, 'the real word probability reaches the boundary gate');

  // BEFORE (production shape: the gate saw "metal..." with nothing else to go on): refused. This is the failure.
  const before = await run(withFinal('metal...'));
  assert.equal(before.valid, false);
  assert.equal(before.qa.END_COMPLETE, false); assert.equal(before.qa.START_COMPLETE, true, 'the repaired start is unaffected');
  assert.equal(before.endingEvidence.verdict, 'INCONCLUSIVE');
  // AFTER: one bounded tail pass of the real audio.
  let requests = 0;
  const after = await run(withFinal('metal...'), async (r) => { requests++; return probe(r); });
  assert.equal(requests, 1);
  assert(after.valid, JSON.stringify([after.reasons, after.qa, after.endingEvidence]));
  assert(Object.values(after.qa).every(Boolean), 'all 14 QA flags hold');
  assert.equal(after.endingEvidence.state, 'ASR_CONFLICTING'); assert.equal(after.endingEvidence.tail.finalOnlyDiffers, true);
  assert.equal(after.endingEvidence.tail.agreement, 1);
  assert(after.endingEvidence.finalConfidence < ASR_ENDING_POLICY.lowConfidence);
  assert.equal(after.startTime, before.startTime, 'start unchanged'); assert.equal(Math.round(after.endTime * 100), Math.round(fixture.sourceDuration * 100), 'ending kept');
  assert(after.transcriptText.endsWith('a metal...'), 'no hidden rewrite of the spoken words');
  // The two other shapes the same audio produced.
  for (const final of ['metal.', 'Manuel.']) assert((await run(withFinal(final))).valid, final);

  // Stored form (what export and the editor read): the tail pass lives on the transcript word, so they agree.
  const stored = withFinal('metal...'); stored.at(-1).words.at(-1).tailPass = tailPassFromResponse(fixture.tailResponse, finalWord.end);
  const persisted = await run(stored);
  assert(persisted.valid, 'export-time repair reproduces the verdict from the stored transcript alone');
  const exportRange = { startTime: persisted.startTime, endTime: persisted.endTime, transcriptText: persisted.transcriptText };
  const finalValidation = service.validate(exportRange, transcriptBoundaryWords(stored), { sourceDuration: fixture.sourceDuration, minDuration: 9 });
  assert(finalValidation.valid, JSON.stringify([finalValidation.reasons, finalValidation.qa]));
  const editor = retainedBoundaryQa(stored, [{ start: persisted.startTime, end: fixture.sourceDuration }], fixture.sourceDuration);
  assert(editor.END_COMPLETE && editor.THOUGHT_COMPLETE && editor.VIEWER_SATISFIED_END, 'the editor path agrees: ' + JSON.stringify(editor));
  const unverified = retainedBoundaryQa(withFinal('metal...'), [{ start: persisted.startTime, end: fixture.sourceDuration }], fixture.sourceDuration);
  assert.equal(unverified.END_COMPLETE, false, 'without the stored tail pass the editor stays strict');
  checks += 2;

  // ---- mechanics: confidence is carried, never invented ----
  check('confidence passthrough', () => {
    const w = transcriptBoundaryWords([{ start: 0, end: 3, text: 'a b c d', words: [
      { text: 'a', start: 0, end: .5, confidence: .9 }, { word: 'b', start: .5, end: 1, probability: .8 },
      { text: 'c', start: 1, end: 1.5 }, { text: 'd', start: 1.5, end: 2, confidence: 'high' }] }]);
    assert.deepEqual(w.map(x => x.confidence), [.9, .8, undefined, undefined]);
    assert(!('confidence' in w[2]) && !('confidence' in w[3]), 'absent or non-numeric confidence stays absent');
    const marker = transcriptBoundaryWords([{ start: 0, end: 2, text: 'it looks like a metal...', words: [
      { text: 'it', start: 0, end: .4 }, { text: 'metal', start: .5, end: 1 }] }]);
    assert.equal(marker.at(-1).text, 'metal...', 'a trail-off marker that only the segment text carries is kept');
  });
  check('closeSentence', () => {
    assert.equal(closeSentence('metal...'), 'metal.'); assert.equal(closeSentence('metal…'), 'metal.');
    assert.equal(closeSentence('metal'), 'metal.'); assert.equal(closeSentence('metal,'), 'metal.');
    assert.equal(closeSentence('"metal..."'), '"metal."'); assert.equal(closeSentence('metal?'), 'metal?');
  });
  check('legacy transcript without confidence: inferred signals only, nothing invented', () => {
    const legacy = build([...LEAD, { text: `${PUNCH} metal...`, gap: .3, base: 0 }]).map(w => { delete w.confidence; return w; });
    const e = assessEnding({ words: legacy, index: legacy.length - 1, startIndex: 0, sourceEnd: legacy.at(-1).end + 1 });
    assert.equal(e.confidenceSource, 'NONE'); assert.equal(e.finalConfidence, null); assert.deepEqual(e.realSignals, []);
    assert.equal(e.state, 'ASR_UNCERTAIN'); assert(e.inferredSignals.includes('TRAILING_ELLIPSIS'));
    const followed = build([...LEAD, { text: `${PUNCH} metal...`, gap: .3, base: 0 }, AFTER]).map(w => { delete w.confidence; return w; });
    const idx = legacy.length - 1;
    const assess = (words, i, pad) => assessEnding({ words, index: i, startIndex: 0, sourceEnd: words.at(-1).end + pad });
    // The ellipsis is the only doubt and nothing real backs it: neither a pause nor the end of the source settles it alone.
    assert.equal(assess(followed, idx, 1).verdict, 'INCONCLUSIVE', 'ellipsis alone, pause closure: needs the tail pass');
    assert.equal(assess(legacy, idx, .11).verdict, 'INCOMPLETE', 'ellipsis alone at the end of the audio: no doubt about the token itself');
    const withPass = (words, pass) => words.map((w, i) => i === idx ? { ...w, tailPass: pass } : w);
    const conflicting = assess(withPass(followed, tailFor(followed.slice(0, idx + 1), { finalText: 'man', finalP: .5 })), idx, 1);
    assert.equal(conflicting.verdict, 'COMPLETE'); assert.equal(conflicting.state, 'ASR_CONFLICTING');
    const stable = assess(withPass(followed, tailFor(followed.slice(0, idx + 1), { finalText: 'metal...', finalP: .9 })), idx, 1);
    assert.equal(stable.verdict, 'INCOMPLETE', 'the same word with the same trailing dots in two passes is a real trail-off');
    assert(stable.reasons.includes('TRAILING_OFF_STABLE_ACROSS_PASSES'));
    const weakStable = build([...LEAD, S(`${PUNCH} metal...`, { p: .4 }), AFTER]);
    const weak = assess(withPass(weakStable, tailFor(weakStable.slice(0, idx + 1), { finalText: 'metal...', finalP: .4 })), idx, 1);
    assert.equal(weak.verdict, 'INCOMPLETE', 'a low-confidence word whose ellipsis survives the second pass is still a trail-off');
  });
}
