// Persistence + wiring check for the ending tail verification, against a DISPOSABLE PostgreSQL database.
//
//   docker run --rm -d --name xee-ending-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=ending_tail_verify -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgresql://postgres:x@localhost:55432/ending_tail_verify npx prisma db push --skip-generate
//   DATABASE_URL=postgresql://postgres:x@localhost:55432/ending_tail_verify node scripts/verify-ending-tail-persistence.cjs
//
// It exercises the REAL EndingTailProbe (shared by analysis and export) against a fake AI service that replays a real Delivery tail response,
// and proves that what is stored (TranscriptSegment.words, ClipCandidate.evidence) lets export and the editor reach the same ending verdict
// with no further AI call; that a stronger-model correction is stored WITH provenance (the base reading is never lost); and that both passes
// are cached by media identity, tail interval and model. All rows are removed at the end.
require('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const url = process.env.DATABASE_URL ?? '';
if (!/\/ending_tail_verify(\?|$)/.test(url)) { console.error('Refusing to run: DATABASE_URL must point at a disposable database named ending_tail_verify.'); process.exit(2); }
const { PrismaClient } = require('@prisma/client');
const { Logger } = require('@nestjs/common');
const { EndingTailProbe } = require('../dist/modules/processing/ending-tail-probe');
const { ClipBoundaryService, transcriptBoundaryWords } = require('../dist/modules/content-intelligence/clip-boundary.service');
const { retainedBoundaryQa } = require('../dist/modules/content-intelligence/edit-project-evidence');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/delivery-ending-asr.json'), 'utf8'));
const prisma = new PrismaClient({ datasources: { db: { url } } });
const service = new ClipBoundaryService();
const logger = new Logger('test');
const reviewer = { generate: async () => ({ data: { selectedIndex: 0, reason: 'complete' } }) };
// Rejects a payoff that reads "metal" (as the live reviewer did), accepts anything else.
const judging = { generate: async q => { const t = JSON.parse(q.request.userPrompt).transcript.map(w => w.text).join(' ');
  return { data: { selectedIndex: /\bmetal\b/.test(t) ? -1 : 0, rejectionKind: /\bmetal\b/.test(t) ? 'LEXICAL_UNCERTAINTY' : 'NONE', reason: 'x' } }; } };
const requests = [];
let mode = 'ok';
// A stronger model's answer for the same window: the words before the last agree, the last word is read as "Manuel." at p = 0.95.
const strongResponse = () => { const r = JSON.parse(JSON.stringify(fixture.tailResponse)); const last = r.words.at(-1);
  r.words[r.words.length - 1] = { ...last, text: 'Manuel.', confidence: 0.95 }; return { ...r, model: 'whisper-medium' }; };
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c);
  req.on('end', () => {
    const payload = JSON.parse(body || '{}'); requests.push({ url: req.url, body: payload });
    if (mode === 'error') { res.statusCode = 500; return res.end('boom'); }
    res.setHeader('content-type', 'application/json');
    res.end(mode === 'malformed' ? JSON.stringify({ words: 'nope' })
      : JSON.stringify(payload.model === 'strong' ? strongResponse() : { ...fixture.tailResponse, model: 'base' }));
  });
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
  const project = await prisma.project.create({ data: { name: 'ending-tail-verify' } });
  try {
    const video = await prisma.video.create({ data: { projectId: project.id, originalName: 'delivery.mp4', objectKey: `ending-tail-verify/${Date.now()}.mp4`,
      bucket: 'b', mimeType: 'video/mp4', sizeBytes: 1n, duration: fixture.sourceDuration, audioBucket: 'b', audioObjectKey: 'a.wav' } });
    const transcript = await prisma.transcript.create({ data: { videoId: video.id, text: 'x', language: 'en', duration: fixture.sourceDuration } });
    const segments = JSON.parse(JSON.stringify(fixture.segments));
    segments.at(-1).words.at(-1).text = 'metal...'; segments.at(-1).text = segments.at(-1).text.replace(/\S+$/u, 'metal...');
    for (const [position, s] of segments.entries())
      await prisma.transcriptSegment.create({ data: { transcriptId: transcript.id, position, start: s.start, end: s.end, text: s.text, words: s.words, confidence: .8 } });
    const load = () => prisma.transcriptSegment.findMany({ where: { transcript: { videoId: video.id } }, orderBy: { position: 'asc' },
      select: { id: true, start: true, end: true, text: true, words: true, speaker: true } });
    const candidate = (rows) => { const w = transcriptBoundaryWords(rows); return { w, c: { startTime: w[0].start, endTime: w.at(-1).end, transcriptText: '' } }; };
    const options = (extra) => ({ sourceDuration: fixture.sourceDuration, minDuration: 9, ...extra });

    // 0. Stored form carries the real word probabilities (nothing invented).
    let rows = await load();
    const stored = rows.at(-1).words.at(-1);
    assert.equal(stored.text, 'metal...'); assert.equal(typeof stored.confidence, 'number'); assert(!('tailPass' in stored));

    // 1. Failure modes first: no write, no throw, strict verdict stands. One request each, never a retry loop.
    for (const failure of ['error', 'malformed']) {
      mode = failure; requests.length = 0;
      const probe = new EndingTailProbe(prisma, logger);
      const { w, c } = candidate(rows);
      const r = await service.repairSemantic(c, w, reviewer, true, options({ verifyTail: probe.verifier(video, rows, w, 'base') }));
      assert.equal(r.valid, false, failure); assert.equal(requests.length, 1, `${failure}: exactly one request`);
      assert(r.reasons.includes('ENDING_NEEDS_TAIL_VERIFICATION'), failure);
      assert(!('tailPass' in (await load()).at(-1).words.at(-1)), `${failure}: nothing stored`);
    }
    process.env.ENDING_TAIL_VERIFICATION_ENABLED = 'false'; mode = 'ok'; requests.length = 0;
    { const probe = new EndingTailProbe(prisma, logger); const { w, c } = candidate(rows);
      const r = await service.repairSemantic(c, w, reviewer, true, options({ verifyTail: probe.verifier(video, rows, w, 'base') }));
      assert.equal(r.valid, false); assert.equal(requests.length, 0, 'disabled: no AI request'); }
    delete process.env.ENDING_TAIL_VERIFICATION_ENABLED;

    // 2. The real path: one bounded request, verdict flips, the pass is stored on exactly the final word.
    requests.length = 0;
    const probe = new EndingTailProbe(prisma, logger);
    const { w, c } = candidate(rows);
    const verify = probe.verifier(video, rows, w, 'base');
    const r1 = await service.repairSemantic(c, w, reviewer, true, options({ verifyTail: verify }));
    const r2 = await service.repairSemantic(c, w, reviewer, true, options({ verifyTail: verify })); // second candidate, same ending
    assert(r1.valid && r2.valid, JSON.stringify(r1.reasons));
    assert.equal(requests.length, 1, 'two candidates ending on the same word share ONE request');
    const body = requests[0].body;
    assert.equal(requests[0].url, '/tail-transcriptions'); assert.equal(body.task, 'transcribe'); assert.equal(body.language, 'en'); assert.equal(body.model, 'base');
    assert.equal(body.bucket, 'b'); assert.equal(body.object_key, 'a.wav');
    assert(body.window_end - body.window_start <= 9.01, 'a short window, not the whole source');
    assert.equal(body.final_word_end, stored.end);
    rows = await load();
    assert.equal(rows.flatMap(s => s.words).filter(x => x.tailPass).length, 1, 'only the final word carries the pass');
    assert.equal(rows.at(-1).words.at(-1).tailPass.words.at(-1).text, 'man'); assert.equal(rows.at(-1).words.at(-1).tailPass.model, 'base');
    assert.equal(rows.at(-1).words.at(-1).confidence, stored.confidence, 'original confidence untouched');
    assert.equal(rows.at(-1).words.at(-1).text, 'metal...', 'the ASR spelling is never rewritten by a normal tail pass');

    // 2b. A NEW probe (a later stage, a rerun) reuses the stored pass: no request at all.
    requests.length = 0;
    { const later = new EndingTailProbe(prisma, logger); const lw = transcriptBoundaryWords(rows);
      const hit = await later.verifier(video, rows, lw, 'base')({ wordStart: stored.start, wordEnd: stored.end, windowStart: stored.end - 8, windowEnd: stored.end + 1 });
      assert(hit && hit.words.length > 5); assert.equal(requests.length, 0, 'persistent cache hit'); }

    // 3. Candidate evidence is stored and read back for audit.
    const evidence = { boundaryRepair: { reasons: r1.reasons, endingEvidence: r1.endingEvidence } };
    const row = await prisma.clipCandidate.create({ data: { videoId: video.id, rangeKey: 'k', startTime: r1.startTime, endTime: r1.endTime, duration: r1.endTime - r1.startTime,
      transcriptText: r1.transcriptText, titleCandidate: '', hookCandidate: '', captionCandidate: '', synopsis: '', hashtags: [], reason: '', hookScore: 0, informationScore: 0,
      emotionScore: 0, controversyScore: 0, standaloneScore: 0, viralPotentialScore: 0, heuristicScore: 0, payoffScore: 0, flowScore: 0, retentionScore: 0,
      shareabilityScore: 0, overallScore: 0, topic: '', rejectionReason: '', judgeSource: 'test', evidence } });
    const back = (await prisma.clipCandidate.findUnique({ where: { id: row.id } })).evidence.boundaryRepair.endingEvidence;
    assert.equal(back.verdict, 'COMPLETE'); assert.equal(back.state, 'ASR_CONFLICTING'); assert.equal(back.tail.freshFinalToken, 'man');
    assert.deepEqual(back, JSON.parse(JSON.stringify(r1.endingEvidence)));

    // 4. Export-time and editor-time reads of the STORED transcript reproduce the verdict with no AI call.
    requests.length = 0;
    const again = candidate(rows);
    const exported = await service.repairSemantic(again.c, again.w, reviewer, true, options({}));
    assert(exported.valid, JSON.stringify(exported.reasons));
    const finalCheck = service.validate({ startTime: exported.startTime, endTime: exported.endTime, transcriptText: exported.transcriptText }, again.w, options({}));
    assert(finalCheck.valid, JSON.stringify([finalCheck.reasons, finalCheck.qa]));
    const editor = retainedBoundaryQa(rows, [{ start: exported.startTime, end: fixture.sourceDuration }], fixture.sourceDuration);
    assert(editor.END_COMPLETE && editor.THOUGHT_COMPLETE && editor.VIEWER_SATISFIED_END, JSON.stringify(editor));
    assert.equal(requests.length, 0, 'no AI call after the pass is stored');

    // 5. STRONGER TAIL: a reviewer that refuses the garbled payoff -> ONE stronger pass -> correction stored with provenance.
    requests.length = 0;
    const p5 = new EndingTailProbe(prisma, logger);
    { const { w: w5, c: c5 } = candidate(rows);
      const r = await service.repairSemantic(c5, w5, judging, true, options({ verifyTail: p5.verifier(video, rows, w5, 'base'), verifyStrongTail: p5.verifier(video, rows, w5, 'strong') }));
      assert(r.valid, JSON.stringify(r.reasons)); assert.equal(r.correction.kind, 'ADOPT'); assert(r.transcriptText.endsWith('Manuel.'), r.transcriptText.slice(-30));
      const strongRequests = requests.filter(q => q.body.model === 'strong');
      assert.equal(strongRequests.length, 1, 'exactly one stronger pass'); assert(strongRequests[0].body.window_end - strongRequests[0].body.window_start <= 9.01);
      await p5.persistCorrection(rows, w5, r.correction, r.strongTail); }
    rows = await load();
    const fixed = rows.at(-1).words.at(-1);
    assert.equal(fixed.text, 'Manuel.', 'captions and content read the corrected word'); assert.equal(fixed.asrText, 'metal...', 'the base reading is preserved');
    assert.equal(fixed.asrConfidence, stored.confidence); assert.equal(fixed.correction.kind, 'ADOPT'); assert.equal(fixed.correction.model, 'whisper-medium');
    assert.equal(fixed.correction.from, 'metal...'); assert.equal(fixed.strongTail.model, 'whisper-medium'); assert(fixed.tailPass, 'the normal tail pass is still there');
    assert(rows.at(-1).text.endsWith('Manuel.'), 'segment text updated too'); assert.equal(rows.flatMap(s => s.words).filter(x => x.correction).length, 1);
    const reread = transcriptBoundaryWords(rows).at(-1);
    assert.equal(reread.text, 'Manuel.'); assert.equal(reread.asrText, 'metal...'); assert.equal(reread.correction.to, 'Manuel.');

    // 5b. After the correction: export reads the corrected text, needs no AI call, and the reviewer accepts without escalating again.
    requests.length = 0;
    { const p6 = new EndingTailProbe(prisma, logger); const { w: w6, c: c6 } = candidate(rows);
      const r = await service.repairSemantic(c6, w6, judging, true, options({ verifyTail: p6.verifier(video, rows, w6, 'base'), verifyStrongTail: p6.verifier(video, rows, w6, 'strong') }));
      assert(r.valid && r.transcriptText.endsWith('Manuel.')); assert.equal(requests.length, 0, 'corrected word: nothing more to ask'); }

    // 5c. The stronger pass is cached per word and model: a word with a stored strongTail but no correction is not asked again.
    { const w7 = transcriptBoundaryWords(rows); delete w7.at(-1).correction;
      const p7 = new EndingTailProbe(prisma, logger);
      const hit = await p7.verifier(video, rows, w7, 'strong')({ wordStart: fixed.start, wordEnd: fixed.end, windowStart: fixed.end - 8, windowEnd: fixed.end + 1 });
      assert.equal(hit.model, 'whisper-medium'); assert.equal(requests.length, 0, 'stronger pass served from storage'); }

    // 6. Re-processing replaces the transcript (cascade): stored passes and corrections cannot outlive the words they belong to.
    // A different interval or model revision must miss the persistent cache, even for the same final word.
    requests.length = 0;
    { const lw = transcriptBoundaryWords(rows); const request = { wordStart: fixed.start, wordEnd: fixed.end,
        windowStart: fixed.end - 7, windowEnd: fixed.end + 1 };
      await new EndingTailProbe(prisma, logger).verifier(video, rows, lw, 'strong')(request);
      assert.equal(requests.length, 1, 'a different bounded interval is not the same cached request');
      process.env.WHISPER_TAIL_MODEL_VERSION = 'new-test-revision';
      try { await new EndingTailProbe(prisma, logger).verifier(video, rows, lw, 'strong')(request);
        assert.equal(requests.length, 2, 'model-version change invalidates persisted evidence');
      } finally { delete process.env.WHISPER_TAIL_MODEL_VERSION; } }
    await prisma.transcriptSegment.deleteMany({ where: { transcriptId: transcript.id } });
    assert.equal((await load()).length, 0);
    console.log('Ending tail persistence (real PostgreSQL, real EndingTailProbe): shared+cached passes, strict on failure, stored evidence reproduces the verdict, stronger-pass correction stored with provenance: PASS');
  } finally {
    await prisma.project.delete({ where: { id: project.id } }).catch(() => undefined);
    await prisma.$disconnect(); server.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
