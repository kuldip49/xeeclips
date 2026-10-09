// Persistence + wiring check for the ending tail verification, against a DISPOSABLE PostgreSQL database.
//
//   docker run --rm -d --name xee-ending-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=ending_tail_verify -p 55432:5432 postgres:16-alpine
//   DATABASE_URL=postgresql://postgres:x@localhost:55432/ending_tail_verify npx prisma db push --skip-generate
//   DATABASE_URL=postgresql://postgres:x@localhost:55432/ending_tail_verify node scripts/verify-ending-tail-persistence.cjs
//
// It exercises the REAL VideoProcessorService.requestTailPass against a fake AI service that replays the real Delivery
// /tail-transcriptions response, and proves that what is stored (TranscriptSegment.words, ClipCandidate.evidence) lets export
// and the editor reach the same ending verdict with no further AI call. All rows are removed at the end.
require('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const url = process.env.DATABASE_URL ?? '';
if (!/\/ending_tail_verify(\?|$)/.test(url)) { console.error('Refusing to run: DATABASE_URL must point at a disposable database named ending_tail_verify.'); process.exit(2); }
const { PrismaClient } = require('@prisma/client');
const { Logger } = require('@nestjs/common');
const { VideoProcessorService } = require('../dist/modules/processing/video-processor.service');
const { ClipBoundaryService, transcriptBoundaryWords } = require('../dist/modules/content-intelligence/clip-boundary.service');
const { retainedBoundaryQa } = require('../dist/modules/content-intelligence/edit-project-evidence');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/delivery-ending-asr.json'), 'utf8'));
const prisma = new PrismaClient({ datasources: { db: { url } } });
const service = new ClipBoundaryService();
const reviewer = { generate: async () => ({ data: { selectedIndex: 0, reason: 'complete' } }) };   // the semantic boundary review that follows the probe
const requests = [];
let mode = 'ok';
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c);
  req.on('end', () => {
    requests.push({ url: req.url, body: JSON.parse(body || '{}') });
    if (mode === 'error') { res.statusCode = 500; return res.end('boom'); }
    res.setHeader('content-type', 'application/json');
    res.end(mode === 'malformed' ? JSON.stringify({ words: 'nope' }) : JSON.stringify(fixture.tailResponse));
  });
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const project = await prisma.project.create({ data: { name: 'ending-tail-verify' } });
  try {
    const video = await prisma.video.create({ data: { projectId: project.id, originalName: 'delivery.mp4', objectKey: `ending-tail-verify/${Date.now()}.mp4`,
      bucket: 'b', mimeType: 'video/mp4', sizeBytes: 1n, duration: fixture.sourceDuration, audioBucket: 'b', audioObjectKey: 'a.wav' } });
    const transcript = await prisma.transcript.create({ data: { videoId: video.id, text: 'x', language: 'en', duration: fixture.sourceDuration } });
    // Store the production shape: the gate saw "metal..." on the last word.
    const segments = JSON.parse(JSON.stringify(fixture.segments));
    segments.at(-1).words.at(-1).text = 'metal...'; segments.at(-1).text = segments.at(-1).text.replace(/\S+$/u, 'metal...');
    for (const [position, s] of segments.entries())
      await prisma.transcriptSegment.create({ data: { transcriptId: transcript.id, position, start: s.start, end: s.end, text: s.text, words: s.words, confidence: .8 } });
    const load = () => prisma.transcriptSegment.findMany({ where: { transcript: { videoId: video.id } }, orderBy: { position: 'asc' },
      select: { id: true, start: true, end: true, text: true, words: true, speaker: true } });

    const processor = Object.create(VideoProcessorService.prototype);
    Object.assign(processor, { prisma, logger: new Logger('test'), aiServiceUrl: `http://127.0.0.1:${port}`, aiServiceTimeoutMs: 20000 });
    const candidate = (rows) => { const w = transcriptBoundaryWords(rows); return { w, c: { startTime: w[0].start, endTime: w.at(-1).end, transcriptText: '' } }; };
    const options = (verifyTail) => ({ sourceDuration: fixture.sourceDuration, minDuration: 9, verifyTail });

    // 0. Stored form carries the real word probabilities (nothing invented).
    let rows = await load();
    const stored = rows.at(-1).words.at(-1);
    assert.equal(stored.text, 'metal...'); assert.equal(typeof stored.confidence, 'number'); assert(!('tailPass' in stored));

    // 1. Failure modes first: no write, no throw, strict verdict stands. One request each, never a retry loop.
    for (const failure of ['error', 'malformed']) {
      mode = failure; requests.length = 0;
      let { w, c } = candidate(rows);
      const r = await service.repairSemantic(c, w, reviewer, true, options(req => processor.requestTailPass(video, req, rows, w)));
      assert.equal(r.valid, false, failure); assert.equal(requests.length, 1, `${failure}: exactly one request`);
      assert(r.reasons.includes('ENDING_NEEDS_TAIL_VERIFICATION'), failure);
      assert(!('tailPass' in (await load()).at(-1).words.at(-1)), `${failure}: nothing stored`);
    }
    process.env.ENDING_TAIL_VERIFICATION_ENABLED = 'false'; mode = 'ok'; requests.length = 0;
    { const { w, c } = candidate(rows);
      const r = await service.repairSemantic(c, w, reviewer, true, options(req => processor.requestTailPass(video, req, rows, w)));
      assert.equal(r.valid, false); assert.equal(requests.length, 0, 'disabled: no AI request'); }
    delete process.env.ENDING_TAIL_VERIFICATION_ENABLED;

    // 2. The real path: one bounded request, verdict flips, the pass is stored on exactly the final word.
    requests.length = 0;
    const { w, c } = candidate(rows);
    const checks = new Map();
    const verify = req => { const key = `${req.wordStart}:${req.wordEnd}`; if (!checks.has(key)) checks.set(key, processor.requestTailPass(video, req, rows, w)); return checks.get(key); };
    const r1 = await service.repairSemantic(c, w, reviewer, true, options(verify));
    const r2 = await service.repairSemantic(c, w, reviewer, true, options(verify)); // second candidate, same ending
    assert(r1.valid && r2.valid, JSON.stringify(r1.reasons));
    assert.equal(requests.length, 1, 'two candidates ending on the same word share ONE request');
    const body = requests[0].body;
    assert.equal(requests[0].url, '/tail-transcriptions'); assert.equal(body.task, 'transcribe'); assert.equal(body.language, 'en');
    assert.equal(body.bucket, 'b'); assert.equal(body.object_key, 'a.wav');
    assert(body.window_end - body.window_start <= 9.01, 'a short window, not the whole source');
    assert.equal(body.final_word_end, stored.end);
    rows = await load();
    const flat = rows.flatMap(s => s.words);
    assert.equal(flat.filter(x => x.tailPass).length, 1, 'only the final word carries the pass');
    assert.equal(rows.at(-1).words.at(-1).tailPass.words.at(-1).text, 'man');
    assert.equal(rows.at(-1).words.at(-1).confidence, stored.confidence, 'original confidence untouched');
    assert.equal(rows.at(-1).words.at(-1).text, 'metal...', 'the ASR spelling is never rewritten');

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
    const exported = await service.repairSemantic(again.c, again.w, null, false, options(undefined));
    assert(exported.valid, JSON.stringify(exported.reasons));
    const finalCheck = service.validate({ startTime: exported.startTime, endTime: exported.endTime, transcriptText: exported.transcriptText }, again.w, { sourceDuration: fixture.sourceDuration, minDuration: 9 });
    assert(finalCheck.valid, JSON.stringify([finalCheck.reasons, finalCheck.qa]));
    const editor = retainedBoundaryQa(rows, [{ start: exported.startTime, end: fixture.sourceDuration }], fixture.sourceDuration);
    assert(editor.END_COMPLETE && editor.THOUGHT_COMPLETE && editor.VIEWER_SATISFIED_END, JSON.stringify(editor));
    assert.equal(requests.length, 0, 'no AI call after the pass is stored');

    // 5. Re-processing replaces the transcript (cascade): the stored pass cannot outlive the words it belongs to.
    await prisma.transcriptSegment.deleteMany({ where: { transcriptId: transcript.id } });
    assert.equal((await load()).length, 0);
    console.log('Ending tail verification persistence (real PostgreSQL, real requestTailPass): 1 request shared, failures keep strict verdict, stored pass reproduces verdict for export + editor: PASS');
  } finally {
    await prisma.project.delete({ where: { id: project.id } }).catch(() => undefined);
    await prisma.$disconnect(); server.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
