// Fresh end-to-end EDITED_CLIPS run through the same HTTP API the frontend uses:
// create project -> upload (processingType EDITED_CLIPS, 9:16) -> processing ->
// clip selection -> edit/render/quality gate -> generated clip download.
// Everything it creates (project, video, MinIO objects, clips) is removed at the end.
//   node scripts/verify-edited-ui-flow.cjs --file <video.mp4> [--mode FALLBACK_ONLY] [--count 1]
//     [--api http://localhost:4000] [--out /tmp/edited-ui-flow] [--timeout-min 45]
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { basename, join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const api = arg('api', process.env.API_URL || 'http://localhost:4000');
const file = arg('file', '');
const mode = arg('mode', 'FALLBACK_ONLY');
const count = Number(arg('count', '1'));
const outputDir = arg('out', '/tmp/edited-ui-flow');
const timeoutMs = Number(arg('timeout-min', '45')) * 60000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, init = {}) {
  const response = await fetch(`${api}${path}`, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  if (!file) throw new Error('--file is required');
  mkdirSync(outputDir, { recursive: true });
  const prisma = new PrismaClient();
  const started = Date.now();
  let project = null;
  let video = null;
  try {
    project = await call('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `edited-ui-flow-${Date.now()} (disposable)` }) });
    const form = new FormData();
    form.set('file', new Blob([readFileSync(file)], { type: 'video/mp4' }), basename(file));
    form.set('aiMode', mode);
    form.set('targetPlatform', process.env.TARGET_PLATFORM || 'INSTAGRAM_REELS');
    video = await call(`/projects/${project.id}/videos`, { method: 'POST', body: form });
    console.log(JSON.stringify({ step: 'uploaded', projectId: project.id, videoId: video.id, mode }));

    let lastProgress = -1;
    let job = null;
    while (Date.now() - started < timeoutMs) {
      const [current] = (await call(`/videos?projectId=${project.id}`)).filter((item) => item.id === video.id);
      job = current?.processingJobs?.[0];
      if (job && job.progress !== lastProgress) {
        lastProgress = job.progress;
        console.log(JSON.stringify({ step: 'processing', status: job.status, progress: job.progress,
          processingType: job.processingType, elapsedSec: Math.round((Date.now() - started) / 1000) }));
      }
      if (job && ['COMPLETED', 'FAILED'].includes(job.status)) break;
      await sleep(5000);
    }
    if (job?.status !== 'COMPLETED') throw new Error(`processing did not complete: ${job?.status} ${job?.error ?? ''}`);

    const analysis = await call(`/videos/${video.id}/clip-analysis`);
    const recommendations = await call(`/videos/${video.id}/clip-recommendations`);
    const candidates = await call(`/videos/${video.id}/clip-candidates?limit=100`);
    console.log(JSON.stringify({ step: 'candidates', count: candidates.length,
      scores: candidates.slice(0, 8).map((item) => item.contentPotential),
      recommendations: Object.fromEntries(Object.entries(recommendations ?? {})
        .map(([key, value]) => [key, Array.isArray(value) ? value.length : value])) }));

    const selectStarted = Date.now();
    console.log(JSON.stringify({ step: 'analysis', ...analysis }));
    await call(`/videos/${video.id}/clip-selection`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedClipCount: Math.min(count, analysis.maxClipCount),
        outputStyle: 'AI_EDITED' }) });
    let results = null;
    while (Date.now() - started < timeoutMs) {
      results = await call(`/videos/${video.id}/clip-results`);
      if (results.status !== 'QUEUED' && results.status !== 'RENDERING') break;
      await sleep(5000);
    }
    if (results?.status !== 'COMPLETED') throw new Error(`clip creation did not complete: ${results?.status} ${results?.error ?? ''}`);
    console.log(JSON.stringify({ step: 'selected', clips: results.clips.length,
      cards: results.clips.map(({ hook, hashtags, aiModeUsed }) => ({ hook, hashtags, aiModeUsed })),
      selectionSec: Math.round((Date.now() - selectStarted) / 1000) }));

    const listed = await call(`/videos/${video.id}/generated-clips`);
    for (const [index, clip] of listed.entries()) {
      const response = await fetch(`${api}${clip.playbackUrl}`);
      if (!response.ok) throw new Error(`download ${clip.playbackUrl} -> ${response.status}`);
      const local = join(outputDir, `ui-flow-${index + 1}.mp4`);
      writeFileSync(local, Buffer.from(await response.arrayBuffer()));
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format',
        '-of', 'json', local]).toString());
      const t = clip.editTelemetry ?? {};
      console.log(JSON.stringify({ step: 'clip', index: index + 1, file: local,
        processingType: clip.processingType, aspectRatio: clip.aspectRatio,
        candidateScore: clip.candidate?.contentPotential,
        probe: { duration: Number(probe.format.duration),
          streams: probe.streams.map((s) => `${s.codec_type}:${s.codec_name}:${s.width ?? ''}x${s.height ?? ''}`) },
        editSource: t.editDecisionSource, quality: t.editQualityStatus,
        failed: t.editQualityFailedChecks, degraded: t.editQualityDegradedChecks,
        attempts: t.editRenderAttempts, hook: [t.hookFinalText, t.hookFontSize, t.hookPositionStable],
        background: [t.backgroundMode, t.backgroundSourceMatched, t.backgroundTransitionSmooth,
          (t.backgroundSegments ?? []).length],
        collision: [t.subtitleCollisionDetected, t.subtitlePositionAdjusted, t.subtitleSourceGraphicCollisionRatio],
        music: t.music && { mood: t.music.musicMood, track: t.music.trackId, required: t.music.musicRequired,
          rendered: t.music.musicRendered, speechToMusicDb: t.music.speechToMusicDb },
        shots: (t.shots ?? []).map((shot) => `${shot.shotClass}/${shot.layout}`) }));
    }
    console.log(JSON.stringify({ step: 'done', totalSec: Math.round((Date.now() - started) / 1000) }));
  } finally {
    if (video) await call(`/videos/${video.id}`, { method: 'DELETE' })
      .catch((error) => console.error(`cleanup video: ${error.message}`));
    if (project) await prisma.project.delete({ where: { id: project.id } })
      .catch((error) => console.error(`cleanup project: ${error.message}`));
    await prisma.$disconnect();
    console.log('Cleaned up disposable project/video/objects. Downloaded clips kept in', outputDir);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
