// Step 22: measured long-source performance through the same HTTP API the UI uses.
//   upload -> analysis (stage timings from the job's own telemetry) -> N clips ->
//   a repeat request (cache/idempotency) -> a larger request (analysis reuse).
// Samples container memory (docker stats) the whole time. Disposable: removes
// everything it creates.
//   node scripts/perf-long-source.cjs --file <source.mp4> [--mode FALLBACK_ONLY] [--count 3]
//     [--out perf.json] [--timeout-min 180]
const { readFileSync, statSync, writeFileSync } = require('node:fs');
const { basename } = require('node:path');
const { execFile } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const api = arg('api', process.env.API_URL || 'http://localhost:4000');
const file = arg('file', '');
const mode = arg('mode', 'FALLBACK_ONLY');
const count = Number(arg('count', '3'));
const out = arg('out', '');
const timeoutMs = Number(arg('timeout-min', '180')) * 60000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CONTAINERS = ['ai-content-backend', 'ai-content-ai-service', 'ai-content-postgres', 'ai-content-minio'];

async function call(path, init = {}) {
  const response = await fetch(`${api}${path}`, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// --- memory sampling ---------------------------------------------------------
const memory = Object.fromEntries(CONTAINERS.map((name) => [name, { peakMiB: 0, samples: 0 }]));
let phase = 'idle';
const phasePeaks = {};
const toMiB = (value) => {
  const match = /([\d.]+)\s*([KMG]i?B)/u.exec(value);
  if (!match) return 0;
  const n = Number(match[1]);
  return match[2].startsWith('G') ? n * 1024 : match[2].startsWith('K') ? n / 1024 : n;
};
let sampling = true;
async function sampleMemory() {
  while (sampling) {
    await new Promise((resolve) => execFile('docker', ['stats', '--no-stream', '--format', '{{.Name}}|{{.MemUsage}}',
      ...CONTAINERS], { timeout: 20000 }, (error, stdout) => {
      if (!error) {
        for (const line of stdout.trim().split('\n')) {
          const [name, usage] = line.split('|');
          if (!memory[name]) continue;
          const mib = toMiB(usage.split('/')[0]);
          memory[name].peakMiB = Math.max(memory[name].peakMiB, mib);
          memory[name].samples += 1;
          const key = `${phase}:${name}`;
          phasePeaks[key] = Math.max(phasePeaks[key] ?? 0, mib);
        }
      }
      resolve();
    }));
    await sleep(3000);
  }
}

async function main() {
  if (!file) throw new Error('--file is required');
  const prisma = new PrismaClient();
  const report = { file: basename(file), sizeMiB: Number((statSync(file).size / 1048576).toFixed(1)), mode, count };
  const sampler = sampleMemory();
  let project = null;
  let video = null;
  try {
    project = await call('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `perf-${Date.now()} (disposable)` }) });
    phase = 'upload';
    const form = new FormData();
    form.set('file', new Blob([readFileSync(file)], { type: 'video/mp4' }), basename(file));
    form.set('aiMode', mode);
    form.set('processingType', 'EDITED_CLIPS');
    form.set('aspectRatio', '9:16');
    form.set('targetPlatform', 'INSTAGRAM_REELS');
    const uploadStarted = Date.now();
    video = await call(`/projects/${project.id}/videos`, { method: 'POST', body: form });
    report.uploadHttpMs = Date.now() - uploadStarted;

    // Progress milestones as the UI sees them.
    phase = 'analysis';
    const analysisStarted = Date.now();
    const milestones = [];
    let last = -1;
    let job = null;
    while (Date.now() - analysisStarted < timeoutMs) {
      job = (await call(`/videos?projectId=${project.id}`)).find((item) => item.id === video.id)?.processingJobs?.[0];
      if (job && job.progress !== last) {
        last = job.progress;
        milestones.push({ progress: job.progress, atSec: Math.round((Date.now() - analysisStarted) / 1000) });
      }
      if (job && ['COMPLETED', 'FAILED'].includes(job.status)) break;
      await sleep(3000);
    }
    report.analysisWallMs = Date.now() - analysisStarted;
    report.analysisStatus = job?.status;
    report.progressMilestones = milestones;
    if (job?.status !== 'COMPLETED') throw new Error(`analysis ${job?.status}: ${job?.error ?? ''}`);

    const row = await prisma.processingJob.findFirst({ where: { videoId: video.id }, orderBy: { createdAt: 'desc' } });
    const telemetry = row.telemetry ?? {};
    report.sourceDurationSec = Number((await prisma.video.findUnique({ where: { id: video.id } })).duration);
    report.stageMs = Object.fromEntries(Object.entries(telemetry)
      .filter(([key, value]) => /Ms$/u.test(key) && typeof value === 'number').sort(([a], [b]) => a.localeCompare(b)));
    report.counters = Object.fromEntries(['totalLlmCalls', 'totalCloudLlmCalls', 'cloudLlmCalls', 'localLlmCalls',
      'retryCount', 'failoverCount', 'cacheHits', 'analysisCacheHit', 'sourceCacheHit', 'rawCandidateCount',
      'finalCandidateCount', 'shortlistCount', 'deterministicFallbackUsed', 'effectiveAiMode']
      .filter((key) => key in telemetry).map((key) => [key, telemetry[key]]));
    report.rows = {
      transcriptSegments: await prisma.transcriptSegment.count({ where: { transcript: { videoId: video.id } } }),
      chunks: await prisma.transcriptChunk.count({ where: { videoId: video.id } }),
      visualAnalyses: await prisma.visualAnalysis.count({ where: { chunk: { videoId: video.id } } }),
      candidates: await prisma.clipCandidate.count({ where: { videoId: video.id } })
    };

    // Clip delivery.
    const analysis = await call(`/videos/${video.id}/clip-analysis`);
    const requested = Math.min(count, analysis.maxClipCount);
    const deliver = async (label, requestedClipCount) => {
      phase = label;
      const started = Date.now();
      await call(`/videos/${video.id}/clip-selection`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestedClipCount, outputStyle: 'NORMAL' }) });
      let results = null;
      while (Date.now() - started < timeoutMs) {
        results = await call(`/videos/${video.id}/clip-results`);
        if (results.status !== 'QUEUED' && results.status !== 'RENDERING') break;
        await sleep(2000);
      }
      const current = await prisma.processingJob.findFirst({ where: { videoId: video.id }, orderBy: { createdAt: 'desc' } });
      const selection = current.telemetry?.clipSelection ?? {};
      return { wallMs: Date.now() - started, status: results?.status, requested: requestedClipCount,
        delivered: results?.clips.length ?? 0, stopReason: selection.deliveryStopReason ?? null,
        candidatePoolSize: selection.candidatePoolSize ?? null, renderFailures: selection.renderFailures ?? null,
        replacementCandidateCount: selection.replacementCandidateCount ?? null,
        expansionTriggered: selection.candidateExpansionTriggered ?? null,
        renderConcurrency: selection.renderConcurrency ?? null, sourcePreparationMs: selection.sourcePreparationMs ?? null,
        perClip: (selection.candidatePerformance ?? []).filter((item) => item.finalDisposition === 'READY')
          .map((item) => ({ totalMs: item.totalMs, renderMs: item.renderMs, qaMs: item.qaMs, storageMs: item.storageMs })) };
    };
    report.delivery = await deliver('clips', requested);
    report.repeatRequest = await deliver('repeat', requested);
    const segmentsBefore = report.rows.transcriptSegments;
    report.largerRequest = await deliver('larger', Math.min(requested + 1, analysis.maxClipCount));
    report.analysisReused = {
      transcriptSegmentsUnchanged: await prisma.transcriptSegment.count({ where: { transcript: { videoId: video.id } } }) === segmentsBefore,
      jobsForVideo: await prisma.processingJob.count({ where: { videoId: video.id } })
    };
    report.totalWallMs = report.uploadHttpMs + report.analysisWallMs + report.delivery.wallMs;
    report.ratio = Number((report.totalWallMs / 1000 / report.sourceDurationSec).toFixed(3));
  } finally {
    sampling = false;
    await sampler;
    report.memoryPeakMiB = Object.fromEntries(Object.entries(memory).map(([name, value]) => [name, Math.round(value.peakMiB)]));
    report.memoryPeakByPhaseMiB = Object.fromEntries(Object.entries(phasePeaks).map(([key, value]) => [key, Math.round(value)]));
    if (video) {
      const linked = await prisma.editProject.findMany({ where: { generatedClip: { videoId: video.id } }, select: { id: true } })
        .catch(() => []);
      for (const row of linked) await call(`/edit-mode/projects/${row.id}`, { method: 'DELETE' }).catch(() => undefined);
      await call(`/videos/${video.id}`, { method: 'DELETE' }).catch((error) => console.error(`cleanup video: ${error.message}`));
    }
    if (project) await prisma.project.delete({ where: { id: project.id } }).catch(() => undefined);
    await prisma.$disconnect();
    const text = JSON.stringify(report, null, 2);
    console.log(text);
    if (out) writeFileSync(out, text);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
