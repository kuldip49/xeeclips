// End-of-source acoustics + stronger-tail escalation.
//
// Two defects this pins down (isolated pre-production acceptance, 2026-10-09):
//  1. A source cut mid-speech ("oh,") came back from Whisper as "you know." at p = 0.07 and the strict path trusted the full stop.
//     At the end of the audio the WAVEFORM decides (TRAILING_SILENCE / VOICE_CONTINUING / INDETERMINATE); punctuation never overrides it.
//  2. When an ending is accepted only through an unreliable last word, ONE stronger-model pass over the bounded tail may resolve it
//     (with provenance); without consensus the clip is held for review instead of carrying a doubtful word into captions.
//
// The reviewer and the AI service are test doubles; the real ones are exercised by the isolated-stack acceptance run.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { ClipBoundaryService } = require('../dist/modules/content-intelligence/clip-boundary.service');
const { assessEnding, tailPassFromResponse, eofClassOf, decideTailCorrection, applyCorrection } = require('../dist/modules/content-intelligence/ending-evidence');
const service = new ClipBoundaryService();
let checks = 0;
const check = (name, fn) => { try { fn(); checks++; } catch (e) { e.message = `[${name}] ${e.message}`; throw e; } };
const acheck = async (name, fn) => { try { await fn(); checks++; } catch (e) { e.message = `[${name}] ${e.message}`; throw e; } };

function build(sentences, origin = 0) {
  const words = []; let cursor = origin;
  for (const s of sentences) {
    cursor += s.gap ?? .3;
    const tokens = s.text.split(' ');
    tokens.forEach((token, i) => {
      const w = { text: token, start: Number(cursor.toFixed(3)), end: Number((cursor + .34).toFixed(3)), speaker: null };
      const p = i === tokens.length - 1 && 'p' in s ? s.p : .95;
      if (typeof p === 'number') w.confidence = p;
      if (i === tokens.length - 1) w.segmentEnd = true;
      words.push(w); cursor += .38;
    });
  }
  return words;
}
const LEAD = [{ text: 'We checked the names against the people at the door.', gap: 0 }, { text: 'The first name did not match the face at all.', gap: .4 }];
const AFTER = { text: 'Honestly nobody believed a single word of that story.', gap: 1.3 };
const S = (text, extra = {}) => ({ text, gap: .3, ...extra });
const PUNCH = 'It turns out it looks more like a';

/** A tail pass over the last words of `words` with the given final reading and end-of-file acoustics. */
function pass(words, { finalText, finalP = .9, eof = null, model = 'base', extra = null, scramble = false } = {}) {
  const last = words.at(-1);
  const fresh = words.slice(-8, -1).map(w => ({ text: scramble ? `zz${w.text}` : w.text, start: w.start, end: w.end, confidence: .9 }));
  fresh.push({ text: finalText ?? last.text, start: last.start, end: last.end + .05, confidence: finalP });
  if (extra) fresh.push({ text: extra, start: last.end + .3, end: last.end + .6, confidence: .9 });
  return tailPassFromResponse({ window_start: fresh[0].start, window_end: last.end + .11, model, words: fresh, acoustics_version: 2,
    acoustics: { stopped: eof === 'TRAILING_SILENCE', speech_continues: eof === 'VOICE_CONTINUING' ? true : null, audio_ends_ms: 110, post_silence_ms: 0,
      ...(eof ? { eof, eof_level_db: -5, eof_body_drop_db: eof === 'VOICE_CONTINUING' ? 1.5 : eof === 'TRAILING_SILENCE' ? -14 : -8.5 } : {}) } }, last.end);
}
const withPass = (words, p) => words.map((w, i) => i === words.length - 1 ? { ...w, tailPass: p } : w);
const run = (words, o = {}) => service.repair({ startTime: words[0].start, endTime: words.at(-1).end, transcriptText: '' }, words,
  { sourceDuration: words.at(-1).end + .03, minDuration: words.at(-1).end - words[0].start - .01, ...o });
const EOF = { eofAcoustics: { required: true } };
const atEnd = (r, token) => r.valid && r.transcriptText.trim().endsWith(token);

(async () => {
  // ==== A. End-of-source acoustics ===================================================================================
  const cutOh = build([...LEAD, S('I never know what happens when you order something, you know.', { p: .07 })]);
  const confident = build([...LEAD, S('I never know what happens when you order something, you know.', { p: .99 })]);

  check('A1 a full stop at the end of the audio is not proof: the waveform is needed', () => {
    const r = run(cutOh, EOF);
    assert.equal(r.valid, false); assert.equal(r.endingEvidence.verdict, 'INCONCLUSIVE'); assert(r.endingEvidence.reasons.includes('NEEDS_EOF_ACOUSTICS'));
  });
  check('A2 VOICE_CONTINUING fails regardless of punctuation or confidence (the hallucinated "you know." case)', () => {
    for (const [label, words] of [['p=.07', cutOh], ['p=.99', confident]]) {
      const r = run(withPass(words, pass(words, { eof: 'VOICE_CONTINUING' })), EOF);
      assert.equal(r.valid, false, label); assert(r.reasons.includes('VOICE_CONTINUING_AT_EOF'), label + JSON.stringify(r.reasons));
    }
  });
  check('A3 TRAILING_SILENCE lets the punctuation contribute', () => {
    const r = run(withPass(confident, pass(confident, { eof: 'TRAILING_SILENCE' })), EOF);
    assert(atEnd(r, 'know.'), JSON.stringify([r.reasons, r.endingEvidence])); assert.equal(r.endingEvidence.eof, 'TRAILING_SILENCE');
  });
  check('A9 outdated acoustic evidence is refreshed before accepting source EOF', () => {
    const old = pass(confident, { eof: 'TRAILING_SILENCE' }); delete old.acousticsVersion;
    const r = run(withPass(confident, old), EOF);
    assert(!r.valid); assert(r.endingEvidence.reasons.includes('NEEDS_EOF_ACOUSTICS'));
  });
  check('A4 INDETERMINATE needs a semantic reviewer; punctuation alone is insufficient', () => {
    const w = withPass(confident, pass(confident, { eof: 'INDETERMINATE' }));
    assert(atEnd(run(w, { ...EOF, reviewAvailable: true }), 'know.'));
    const r = run(w, { ...EOF, reviewAvailable: false });
    assert.equal(r.valid, false); assert(r.endingEvidence.reasons.includes('EOF_INDETERMINATE_WITHOUT_REVIEW'));
  });
  check('A5 callers without audio keep the legacy behaviour; a word with more speech after it is not at the end', () => {
    assert(atEnd(run(confident), 'know.'), 'rule is opt-in');
    const mid = build([...LEAD, S('I never know what happens when you order something, you know.', { p: .07 }), AFTER]);
    const r = service.repair({ startTime: 0, endTime: mid[LEAD.length * 0 + 22].end, transcriptText: '' }, mid, { sourceDuration: mid.at(-1).end + 1, minDuration: 5, ...EOF });
    assert(!r.reasons.includes('VOICE_CONTINUING_AT_EOF'));
  });
  check('A6 an unpunctuated, confident last word is excused only by audible trailing silence', () => {
    const t = build([...LEAD, S('They decided to cancel the whole contract and move to another vendor', { p: .92 })]);
    assert(atEnd(run(withPass(t, pass(t, { eof: 'TRAILING_SILENCE', finalText: 'vendor' })), EOF), 'vendor'), 'trailing silence');
    const r = run(withPass(t, pass(t, { eof: 'INDETERMINATE', finalText: 'vendor' })), EOF);
    assert.equal(r.valid, false); assert(r.endingEvidence.reasons.includes('SOURCE_END_WITHOUT_TOKEN_DOUBT'));
    const cut = run(withPass(t, pass(t, { eof: 'VOICE_CONTINUING', finalText: 'vendor' })), EOF);
    assert.equal(cut.valid, false); assert(cut.reasons.includes('VOICE_CONTINUING_AT_EOF'));
  });
  check('A7 the classification travels with the stored pass and maps old acoustics', () => {
    const p = pass(cutOh, { eof: 'VOICE_CONTINUING' });
    assert.equal(p.acoustics.eof, 'VOICE_CONTINUING'); assert.equal(p.acoustics.eofBodyDropDb, 1.5);
    assert.equal(eofClassOf({ stopped: true, speechContinues: false, audioEndsMs: 500, postSilenceMs: 300 }), 'TRAILING_SILENCE');
    assert.equal(eofClassOf({ stopped: false, speechContinues: true, audioEndsMs: 500, postSilenceMs: 0 }), 'VOICE_CONTINUING');
    assert.equal(eofClassOf({ stopped: false, speechContinues: null, audioEndsMs: 40, postSilenceMs: 0 }), 'INDETERMINATE');
  });
  const probeCalls = [];
  const reviewer = { generate: async () => ({ data: { selectedIndex: 0, reason: 'complete' } }) };
  await acheck('A8 the waveform probe runs once even without a semantic reviewer, and a cut is still refused', async () => {
    for (const eof of ['VOICE_CONTINUING', 'TRAILING_SILENCE']) {
      probeCalls.length = 0;
      const r = await service.repairSemantic({ startTime: 0, endTime: confident.at(-1).end, transcriptText: '' }, confident, null, false,
        { sourceDuration: confident.at(-1).end + .03, minDuration: 5, ...EOF, verifyTail: async req => { probeCalls.push(req); return pass(confident, { eof }); } });
      assert.equal(probeCalls.length, 1, eof); assert((eof === 'TRAILING_SILENCE') === atEnd(r, 'know.'), eof + JSON.stringify([r.valid, r.endTime, r.reasons]));
    }
  });

  // ==== B. Stronger-tail escalation ==================================================================================
  const garbled = build([...LEAD, S(`${PUNCH} metal...`, { p: .42 }), AFTER]);        // accepted by pause closure only through the weak last word
  const idx = build([...LEAD, S(`${PUNCH} metal...`, { p: .42 })]).length - 1;
  const targetEnd = garbled[idx].end;
  const strongPass = (o) => pass(garbled.slice(0, idx + 1), { model: 'whisper-medium', ...o });
  // A reviewer that, like the live one, judges the words it is shown: it refuses a payoff that reads "metal".
  const makeReviewer = () => { const seen = []; return { seen, generate: async q => {
    const text = JSON.parse(q.request.userPrompt).transcript.map(w => w.text).join(' '); seen.push(text);
    return { data: { selectedIndex: /\bmetal\b/.test(text) ? -1 : 0, rejectionKind: /\bmetal\b/.test(text) ? 'LEXICAL_UNCERTAINTY' : 'NONE', reason: /\bmetal\b/.test(text) ? 'payoff unresolved' : 'complete' } }; } }; };
  const semantic = (words, rv, o = {}) => service.repairSemantic({ startTime: 0, endTime: targetEnd, transcriptText: '' }, words, rv, true,
    { sourceDuration: words.at(-1).end + 1, minDuration: targetEnd - 0.01,
      verifyTail: async () => pass(words.slice(0, idx + 1), { finalText: 'man', finalP: .46, eof: 'TRAILING_SILENCE' }), ...o });
  const strongStub = (result) => { const calls = []; return { calls, fn: async req => { calls.push(req); if (result instanceof Error) throw result; return result; } }; };

  await acheck('B1 the reviewer refuses the garbled payoff; ONE stronger pass resolves it with provenance; the reviewer then accepts', async () => {
    const rv = makeReviewer(), strong = strongStub(strongPass({ finalText: 'Manuel.', finalP: .95 }));
    const r = await semantic(garbled, rv, { verifyStrongTail: strong.fn });
    assert.equal(strong.calls.length, 1, 'one stronger escalation'); assert.equal(rv.seen.length, 2, 'reviewed again after the correction');
    assert(r.valid, JSON.stringify(r.reasons)); assert(r.transcriptText.trim().endsWith('Manuel.'), r.transcriptText.slice(-40));
    assert.equal(r.correction.kind, 'ADOPT'); assert.equal(r.correction.from, 'metal...'); assert.equal(r.correction.to, 'Manuel.');
    assert.equal(r.correction.model, 'whisper-medium'); assert.equal(r.correction.originalConfidence, .42); assert.equal(r.correction.confidence, .95);
    assert(r.reasons.includes('STRONG_TAIL_RESOLVES_FINAL_WORD')); assert.equal(r.strongTail.model, 'whisper-medium');
    assert(/\bmetal\b/.test(rv.seen[0]) && !/\bmetal\b/.test(rv.seen[1]));
    assert(strong.calls[0].windowEnd - strong.calls[0].windowStart <= 9.01, 'bounded window');
  });
  check('B2 the original reading is preserved next to the correction', () => {
    const d = decideTailCorrection(garbled, idx, strongPass({ finalText: 'Manuel.', finalP: .95 }));
    const fixed = applyCorrection(garbled, d.correction, strongPass({ finalText: 'Manuel.', finalP: .95 }));
    assert.equal(fixed[idx].text, 'Manuel.'); assert.equal(fixed[idx].asrText, 'metal...'); assert.equal(fixed[idx].asrConfidence, .42);
    assert.equal(garbled[idx].text, 'metal...', 'the input words are not mutated');
    assert.equal(fixed[idx - 1].text, garbled[idx - 1].text);
  });
  await acheck('B3 no consensus: a rejected clip stays rejected and a second review is not wasted', async () => {
    for (const [label, strongResult, reason] of [
      ['stronger model unsure', strongPass({ finalText: 'man', finalP: .46 }), 'STRONG_TAIL_LOW_CONFIDENCE'],
      ['stronger model disagrees on the words before', strongPass({ finalText: 'Manuel.', finalP: .95, scramble: true }), 'STRONG_TAIL_DISAGREES_BROADLY'],
      ['stronger model hears more speech', strongPass({ finalText: 'Manuel.', finalP: .95, extra: 'and' }), 'STRONG_TAIL_HEARS_MORE_SPEECH'],
      ['stronger model unavailable', null, 'STRONG_TAIL_UNAVAILABLE']]) {
      const rv = makeReviewer(), strong = strongStub(strongResult);
      const r = await semantic(garbled, rv, { verifyStrongTail: strong.fn });
      assert.equal(r.valid, false, label); assert.equal(strong.calls.length, 1, label); assert.equal(rv.seen.length, 1, label);
      assert(r.reasons.includes(reason) && r.reasons.includes('LEXICAL_UNCERTAINTY_UNRESOLVED'), label + JSON.stringify(r.reasons));
      assert.equal(r.correction, undefined, label);
    }
    const rv = makeReviewer(), strong = strongStub(new Error('ai service down'));
    const r = await semantic(garbled, rv, { verifyStrongTail: strong.fn });
    assert.equal(r.valid, false); assert.equal(strong.calls.length, 1); assert(r.reasons.includes('STRONG_TAIL_UNAVAILABLE'));
  });
  await acheck('B4 a stronger model that CONFIRMS the same word changes nothing and does not rescue it', async () => {
    const rv = makeReviewer(), strong = strongStub(strongPass({ finalText: 'metal...', finalP: .9 }));
    const r = await semantic(garbled, rv, { verifyStrongTail: strong.fn });
    assert.equal(r.correction.kind, 'CONFIRM'); assert.equal(r.valid, false, 'the reviewer still sees a garbled payoff');
    assert(r.transcriptText.trim().endsWith('metal...'), 'no silent rewrite');
  });
  await acheck('B5 an accepted but unresolved last word is held without stronger escalation', async () => {
    const accept = { generate: async () => ({ data: { selectedIndex: 0, reason: 'complete' } }) };
    const held = await semantic(garbled, accept, { verifyStrongTail: strongStub(strongPass({ finalText: 'man', finalP: .46 })).fn });
    assert.equal(held.valid, false); assert(held.reasons.includes('NEEDS_REVIEW_UNVERIFIED_FINAL_WORD'), JSON.stringify(held.reasons));
    const strong = strongStub(strongPass({ finalText: 'Manuel.', finalP: .95 }));
    const fixed = await semantic(garbled, accept, { verifyStrongTail: strong.fn });
    assert(!fixed.valid && !fixed.correction); assert.equal(strong.calls.length, 0);
    assert((await semantic(garbled, accept, {})).valid, 'callers without a stronger model keep the earlier behaviour');
  });
  await acheck('B8 a nonlexical semantic rejection never escalates', async () => {
    const strong = strongStub(strongPass({ finalText: 'Manuel.', finalP: .95 }));
    const r = await semantic(garbled, { generate: async () => ({ data: { selectedIndex: -1,
      reason: 'missing answer', rejectionKind: 'INCOMPLETE_THOUGHT' } }) }, { verifyStrongTail: strong.fn });
    assert.equal(r.valid, false); assert.equal(strong.calls.length, 0);
  });
  await acheck('B6 the escalation fires only when the ending was accepted through an unreliable last word, and at most once per call', async () => {
    const strong = strongStub(strongPass({ finalText: 'Manuel.', finalP: .95 }));
    const reliable = build([...LEAD, S(`${PUNCH} Manuel.`, { p: .95 }), AFTER]);
    assert((await semantic(reliable, makeReviewer(), { verifyStrongTail: strong.fn })).valid);
    assert.equal(strong.calls.length, 0, 'a reliable ending never escalates');
    const already = garbled.map((w, i) => i === idx ? { ...w, correction: { kind: 'CONFIRM' } } : w);
    await semantic(already, makeReviewer(), { verifyStrongTail: strong.fn });
    assert.equal(strong.calls.length, 0, 'an already-resolved word is not escalated again');
    const cut = build([...LEAD, S(`${PUNCH} metal...`, { p: .42 })]);
    await semantic(withPass(cut, pass(cut, { eof: 'VOICE_CONTINUING', finalText: 'man', finalP: .46 })), makeReviewer(), { ...EOF, verifyStrongTail: strong.fn });
    assert.equal(strong.calls.length, 0, 'a waveform that says the voice continues is final: no stronger model can recover a word that is not in the audio');
  });
  check('B7 decisions are deterministic and generic (no word list)', () => {
    for (const to of ['Manuel.', 'Gregory.', 'Lisa.', 'Okonkwo.']) {
      const d = decideTailCorrection(garbled, idx, strongPass({ finalText: to, finalP: .8 }));
      assert.equal(d.kind, 'ADOPT', to); assert.equal(d.correction.to, to);
    }
    assert.equal(decideTailCorrection(garbled, idx, strongPass({ finalText: 'x', finalP: .99 })).kind, 'UNRESOLVED', 'single-letter token');
  });
  console.log(`End-of-source acoustics + stronger-tail escalation: ${checks} checks: PASS`);
})().catch(e => { console.error(e); process.exitCode = 1; });
