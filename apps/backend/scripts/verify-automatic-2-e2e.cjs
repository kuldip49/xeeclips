// Real end-to-end Automatic 2 (street3 template) run through the same HTTP API the frontend uses.
//   node scripts/verify-automatic-2-e2e.cjs --file <video.mp4> [--count 1] [--out /tmp/a2-e2e]
//        [--api http://localhost:4000] [--timeout-min 45]
// Creates a disposable project/video, requests Automatic 2, records what a result card would show
// while the final render is pending (base playable media, must not be a black card), downloads the
// final styled export, and removes all disposable data afterwards.
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { basename, join } = require('node:path');
const { PrismaClient } = require('@prisma/client');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const api = arg('api', process.env.API_URL || 'http://localhost:4000');
const file = arg('file', '');
const existingProjectId = arg('project-id', '');
const existingVideoId = arg('video-id', '');
const count = Number(arg('count', '1'));
const outputDir = arg('out', '/tmp/a2-e2e');
const timeoutMs = Number(arg('timeout-min', '45')) * 60000;
const keep = process.argv.includes('--keep'); // leave the disposable project for a manual browser check
const observeOnly = process.argv.includes('--observe-only');
const browserCheck = process.argv.includes('--browser');
const frontend = arg('frontend', 'http://localhost:3000');
const brief = arg('brief', '');
// AUTOMATIC_1 runs the same flow as a regression check: its base clip is the deliverable.
const template = arg('template', 'AUTOMATIC_2');
const automatic2 = template === 'AUTOMATIC_2';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, init = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(`${api}${path}`, init);
      const text = await response.text();
      if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    } catch (error) {
      if (init.method && init.method !== 'GET' || attempt === 3) throw error;
      await sleep(1000 * (attempt + 1));
    }
  }
}

async function main() {
  if (!file) throw new Error('--file is required');
  mkdirSync(outputDir, { recursive: true });
  const prisma = new PrismaClient();
  const started = Date.now();
  let project = null;
  let video = null;
  let browser = null;
  let page = null;
  try {
    if (existingProjectId && existingVideoId) {
      project = { id: existingProjectId };
      video = { id: existingVideoId };
      console.log(JSON.stringify({ step: 'resumed-existing-upload', videoId: video.id }));
    } else {
      project = await call('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `a2-e2e-${Date.now()} (disposable)` }) });
      const form = new FormData();
      form.set('file', new Blob([readFileSync(file)], { type: 'video/mp4' }), basename(file));
      form.set('aiMode', process.env.AI_MODE || 'FALLBACK_ONLY');
      form.set('targetPlatform', process.env.TARGET_PLATFORM || 'INSTAGRAM_REELS');
      video = await call(`/projects/${project.id}/videos`, { method: 'POST', body: form });
      console.log(JSON.stringify({ step: 'uploaded', videoId: video.id }));
    }

    let job = null;
    while (Date.now() - started < timeoutMs) {
      const [current] = (await call(`/videos?projectId=${project.id}`)).filter((item) => item.id === video.id);
      job = current?.processingJobs?.[0];
      if (job && ['COMPLETED', 'FAILED'].includes(job.status)) break;
      await sleep(5000);
    }
    if (job?.status !== 'COMPLETED') throw new Error(`processing did not complete: ${job?.status} ${job?.error ?? ''}`);
    const analysis = await call(`/videos/${video.id}/clip-analysis`);
    const existingJob = observeOnly ? await prisma.processingJob.findFirst({
      where: { videoId: video.id }, orderBy: { createdAt: 'desc' },
      select: { clipRequestedAt: true } }) : null;
    const generationStarted = existingJob?.clipRequestedAt?.getTime() ?? Date.now();
    if (!observeOnly) await call(`/videos/${video.id}/clip-selection`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedClipCount: Math.min(count, analysis.maxClipCount),
        outputStyle: 'AI_EDITED',
        generation: { templateId: template, look: template, components: {}, brief, referenceId: null } }) });
    if (browserCheck) {
      const { chromium } = require('@playwright/test');
      browser = await chromium.launch({ channel: 'chrome', headless: true });
      page = await browser.newPage();
      await page.goto(`${frontend}/projects/${project.id}`);
      console.log(JSON.stringify({ step: 'results-browser-opened', url: page.url() }));
    }

    const temporary = [];
    const firstPlayableAt = new Map();
    const finalReadyAt = new Map();
    const browserBaseSrc = new Map();
    let results = null;
    while (Date.now() - started < timeoutMs) {
      results = await call(`/videos/${video.id}/clip-results`);
      for (const [clipIndex, clip] of (results.clips ?? []).entries()) {
        const ready = ['EXPORT_READY', 'READY', 'LEGACY_STYLE_READY'].includes(clip.style?.status ?? '');
        if (automatic2 && !ready && clip.playbackUrl && !temporary.some((entry) => entry.id === clip.id)) {
          temporary.push({ id: clip.id, styleStatus: clip.style?.status ?? null, basePlayable: true });
          firstPlayableAt.set(clip.id, Date.now());
          if (page) {
            // Pending Automatic 2 cards show only progress in the Automatic 2 frame: no stand-in
            // media at all (neither the Automatic 1 base render nor the raw source).
            const card = page.getByTestId('clip-result').nth(clipIndex);
            await card.getByTestId('automatic-2-pending').waitFor({ timeout: 30000 });
            if (await card.locator('video').count())
              throw new Error('Pending Automatic 2 card shows playable stand-in media');
            browserBaseSrc.set(clip.id, null);
            await card.scrollIntoViewIfNeeded();
            await card.screenshot({ path: join(outputDir, `pending-${clip.id}.png`) });
            console.log(JSON.stringify({ step: 'browser-pending-progress', clipId: clip.id }));
          }
        }
        if (ready && clip.style?.playbackUrl && !finalReadyAt.has(clip.id)) {
          finalReadyAt.set(clip.id, Date.now());
          if (page && browserBaseSrc.has(clip.id)) {
            const card = page.getByTestId('clip-result').nth(clipIndex);
            await card.locator(`video[src$="/edit-mode/assets/${clip.style.playbackUrl.split('/')[3]}/file"]`)
              .waitFor({ timeout: 30000 });
            if (await card.getByTestId('automatic-2-pending').count())
              throw new Error('Pending card remained after the final styled export was ready');
            const finalSrc = await card.locator('video').getAttribute('src');
            if (!finalSrc) throw new Error('Results browser did not show the final styled media');
            await card.scrollIntoViewIfNeeded();
            await card.screenshot({ path: join(outputDir, `final-${clip.id}.png`) });
            console.log(JSON.stringify({ step: 'browser-final-auto-swapped', clipId: clip.id }));
          }
        }
      }
      const allDone = (results.clips ?? []).length > 0 && results.clips.every((clip) => !automatic2
        ? !!clip.playbackUrl && !['STYLE_APPLYING', 'STYLE_READY', 'STYLING', 'RENDERING'].includes(clip.style?.status ?? '')
        : ['EXPORT_READY', 'READY', 'LEGACY_STYLE_READY', 'STYLE_FAILED', 'FAILED'].includes(clip.style?.status ?? ''));
      if (results.status === 'COMPLETED' && allDone) break;
      if (!['QUEUED', 'RENDERING'].includes(results.status) && (results.clips ?? []).length === 0) {
        console.log(JSON.stringify({ step: 'no-clips', status: results.status, reason: results.error ?? results.partialReason ?? null }));
        break;
      }
      await sleep(4000);
    }
    console.log(JSON.stringify({ step: 'temporary-preview-observed', temporary }));
    for (const [index, clip] of (results.clips ?? []).entries()) {
      const status = clip.style?.status;
      console.log(JSON.stringify({ step: 'clip', index: index + 1, status, hook: clip.hook,
        applied: clip.style?.applied?.slice(0, 12), skipped: clip.style?.skipped, error: clip.style?.error }));
      const storedClip = await prisma.generatedClip.findUnique({ where: { id: clip.id },
        select: { editTelemetry: true, createdAt: true } });
      const base = storedClip?.editTelemetry && typeof storedClip.editTelemetry === 'object'
        ? storedClip.editTelemetry : {};
      const exportAssetId = typeof clip.style?.playbackUrl === 'string'
        ? clip.style.playbackUrl.match(/\/edit-mode\/assets\/([^/]+)\/file/u)?.[1] : null;
      const exportAsset = exportAssetId ? await prisma.editAsset.findUnique({
        where: { id: decodeURIComponent(exportAssetId) },
        select: { metadata: true, createdAt: true } }) : null;
      const final = exportAsset?.metadata && typeof exportAsset.metadata === 'object'
        ? exportAsset.metadata : {};
      console.log(JSON.stringify({ step: 'timing', index: index + 1,
        baseRenderMs: Number(base.baseRenderMs) || null,
        baseQaMs: Number(base.qualityCheckMs) || null,
        finalRenderAndQaMs: Number(final.renderDurationMs) || null,
        firstPlayableMs: storedClip?.createdAt
          ? storedClip.createdAt.getTime() - generationStarted : null,
        finalReadyMs: exportAsset?.createdAt
          ? exportAsset.createdAt.getTime() - generationStarted : null,
        browserFirstObservedMs: firstPlayableAt.has(clip.id)
          ? firstPlayableAt.get(clip.id) - generationStarted : null,
        browserFinalObservedMs: finalReadyAt.has(clip.id)
          ? finalReadyAt.get(clip.id) - generationStarted : null,
        baseRenderRole: base.baseRenderRole ?? null, baseRenderEncode: base.baseRenderEncode ?? null }));
      if (final.camera) console.log(JSON.stringify({ step: 'camera', index: index + 1,
        ...final.camera, speakerSegments: (final.camera.speakerSegments ?? []).length,
        shots: (final.camera.shots ?? []).map((shot) => `${shot.start.toFixed(1)}-${shot.end.toFixed(1)} ` +
          `${shot.shotClass}/${shot.layout}${shot.informationMode ? '/INFO' : ''} faces=${shot.faceCount}`) }));
      if (final.zoom) console.log(JSON.stringify({ step: 'zoom', index: index + 1, ...final.zoom }));
      if (final.qa) console.log(JSON.stringify({ step: 'final-qa', index: index + 1, result: final.qa.result,
        nonPass: (final.qa.checks ?? []).filter((check) => check.result !== 'PASS') }));
      const deliverable = automatic2 ? clip.style?.playbackUrl : clip.style?.playbackUrl ?? clip.playbackUrl;
      if (!deliverable) continue;
      const response = await fetch(`${api}${deliverable}`);
      if (!response.ok) throw new Error(`download ${deliverable} -> ${response.status}`);
      const local = join(outputDir, `${automatic2 ? 'a2' : 'a1'}-${basename(file, '.mp4').replace(/\W+/gu, '_')}-${index + 1}.mp4`);
      writeFileSync(local, Buffer.from(await response.arrayBuffer()));
      console.log(JSON.stringify({ step: 'downloaded', file: local, editUrl: clip.editUrl }));
    }
    console.log(JSON.stringify({ step: 'done', totalSec: Math.round((Date.now() - started) / 1000) }));
  } finally {
    if (browser) await browser.close();
    if (keep) console.log(JSON.stringify({ step: 'kept', projectId: project?.id, videoId: video?.id }));
    else if (video) await call(`/videos/${video.id}`, { method: 'DELETE' })
      .catch((error) => console.error(`cleanup video: ${error.message}`));
    if (project && !keep) await prisma.project.delete({ where: { id: project.id } })
      .catch((error) => console.error(`cleanup project: ${error.message}`));
    await prisma.$disconnect();
    console.log('Cleaned up disposable project/video/objects. Downloads kept in', outputDir);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
