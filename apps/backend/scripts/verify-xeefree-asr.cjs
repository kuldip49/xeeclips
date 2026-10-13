// Offline harness on REAL ASR output (faster-whisper word timings): candidate windows -> moment scoring -> boundary repair -> selection with diversity -> hooks.
// It runs the same pure pipeline stages as the processor, with no database, storage or network, so the OLD and NEW XeeFree can be compared on identical transcripts.
//
//   node scripts/verify-xeefree-asr.cjs <asr.json> [<asr.json>...]            new XeeFree (this tree)
//   XEEFREE_DIST=<other-tree>/apps/backend/dist node scripts/verify-xeefree-asr.cjs ...   the same stages from another build (e.g. HEAD)
require('reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const dist = process.env.XEEFREE_DIST || path.resolve(__dirname, '../dist');
const m = (p) => require(path.join(dist, 'modules', p));
const { buildTranscriptChunks } = m('processing/transcript-chunks');
const { analyzeTranscriptChunk } = m('processing/chunk-analysis');
const candidatesMod = m('processing/clip-candidates');
const { rankUsableCandidates } = m('processing/clip-selection-policy');
const { ClipBoundaryService, transcriptBoundaryWords } = m('content-intelligence/clip-boundary.service');
const { LlmRouterService } = m('processing/llm-router.service');
const { createPerformanceTelemetry, performanceContext } = m('processing/performance-telemetry');
const { creativeService } = m('content-intelligence/creative-package.service');
let free = null; try { free = m('free/free-moments'); } catch { /* the old tree has no free engine */ }
const router = new LlmRouterService();
const boundary = new ClipBoundaryService();
const clipCount = Number(process.env.XEEFREE_CLIPS || 3);
const round = (v) => Math.round(v * 10) / 10;

async function run(file) {
  const asr = JSON.parse(fs.readFileSync(file, 'utf8'));
  const segments = asr.segments.map((s, i) => ({ position: i, start: s.start, end: s.end, text: s.text, words: s.words, speaker: s.speaker ?? null }));
  const words = transcriptBoundaryWords(segments);
  const freeIndex = free && words.length ? new free.FreeTranscriptIndex({ words }) : null;
  // The new tree builds its windows from reconstructed sentences; the old tree (no free engine) from Whisper chunks, exactly as the processor does.
  const chunks = (freeIndex ? free.sentenceChunks(freeIndex) : buildTranscriptChunks('v', segments)).map(c => ({ ...c, analysis: analyzeTranscriptChunk(c) }));
  const duration = asr.duration;
  let candidates = candidatesMod.generateCandidateRanges('v', chunks, null, free ? free.FREE_CANDIDATE_POOL : undefined);
  const rawCount = candidates.length;
  if (freeIndex) candidates = free.rescoreFreePool(candidates, freeIndex, candidatesMod.calculateContentPotential).slice(0, candidatesMod.MAX_CANDIDATES);
  const shortlist = candidatesMod.shortlistForUnderstanding(candidates, duration);
  const repaired = [];
  for (const c of shortlist) {
    const r = await boundary.repairSemantic(c, words, router, false, { sourceDuration: duration });
    repaired.push({ ...c, startTime: Math.round(r.startTime * 100) / 100, endTime: Math.round(r.endTime * 100) / 100, transcriptText: r.transcriptText,
      reject: c.reject || !r.valid, rejectionReason: r.reasons.join(','), boundary: r });
  }
  const ranked = candidatesMod.suppressOverlapAndRank(repaired).map(c => ({ ...c, id: c.rangeKey }));
  let ordered = rankUsableCandidates(ranked, duration).ordered;
  if (free) ordered = free.diversifyOrder(ordered);
  const picked = ordered.slice(0, clipCount);
  const clips = [];
  for (const c of picked) {
    const evidence = { transcript: c.transcriptText, sourceId: 'v', startTime: c.startTime, endTime: c.endTime };
    const telemetry = createPerformanceTelemetry('FALLBACK_ONLY');
    const pkg = await performanceContext.run(telemetry, () => creativeService(router).create({ evidence, external: false }));
    const b = c.boundary;
    clips.push({ start: c.startTime, end: c.endTime, duration: round(c.endTime - c.startTime), contentPotential: c.contentPotential, valid: b.valid, qaFailed: Object.entries(b.qa).filter(([, v]) => !v).map(([k]) => k),
      boundaryReasons: b.reasons.filter(r => /FREE_|ENDING|CONTEXT|START|NEEDS/u.test(r)).slice(0, 6), freeMoment: c.evidence?.freeMoment ? { composite: c.evidence.freeMoment.composite, angle: c.evidence.freeMoment.angle, hookability: c.evidence.freeMoment.hookability } : undefined,
      first: c.transcriptText.split(/\s+/u).slice(0, 14).join(' '), last: c.transcriptText.split(/\s+/u).slice(-14).join(' '),
      hooks: pkg.hooks.slice(0, 4).map(h => ({ text: h.text, category: h.category, score: h.score })), status: pkg.status, qualityFailures: pkg.quality.failures,
      synopsis: pkg.synopsis, captions: pkg.captions.slice(0, 2).map(x => x.text), hashtags: pkg.hashtagSets.find(s => s.label === 'Focused')?.hashtags,
      telemetry: { executionMode: telemetry.executionMode, openAiCalls: telemetry.openAiCalls, cloudLlmCalls: telemetry.cloudLlmCalls, proEscalations: telemetry.proEscalations } });
  }
  return { file: path.basename(file), language: asr.language, duration: round(duration), rawCandidates: rawCount, shortlist: shortlist.length, usable: ordered.length, clips };
}

(async () => {
  const out = [];
  for (const file of process.argv.slice(2)) out.push(await run(file));
  const target = process.env.XEEFREE_OUT;
  if (target) fs.writeFileSync(target, JSON.stringify(out, null, 2));
  for (const r of out) {
    console.log(`\n=== ${r.file}  (${r.language}, ${r.duration}s, candidates ${r.rawCandidates} -> shortlist ${r.shortlist} -> usable ${r.usable})`);
    for (const [i, c] of r.clips.entries()) {
      console.log(`  clip ${i + 1}: ${c.start}-${c.end}s (${c.duration}s) potential ${c.contentPotential}${c.freeMoment ? ` moment ${c.freeMoment.composite}/${c.freeMoment.angle}` : ''} valid=${c.valid} ${c.qaFailed.length ? 'QA!' + c.qaFailed.join(',') : ''}`);
      console.log(`     starts: "${c.first}"`); console.log(`     ends:   "${c.last}"`);
      for (const h of c.hooks) console.log(`     hook ${String(h.score).padStart(3)} ${h.category.padEnd(11)} ${h.text}`);
      if (!c.hooks.length) console.log(`     (no hook) ${c.qualityFailures.join(',')}`);
    }
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
