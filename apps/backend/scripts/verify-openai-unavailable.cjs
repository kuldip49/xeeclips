// Step 21: the product with OpenAI UNAVAILABLE, on real media, through the live HTTP API.
// Run it against a backend whose OpenAI key is invalid (or unreachable) - never against a
// working key. It asserts that everything that does not need semantic AI still works, that
// semantic requests say honestly that AI is unavailable, and that nothing is routed to a
// local LLM. Disposable: removes everything it creates.
//   node scripts/verify-openai-unavailable.cjs --file <talk.mp4> [--expect AUTH_FAILED]
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { basename, join } = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const api = arg('api', process.env.API_URL || 'http://localhost:4000');
const file = arg('file', '');
const expectState = arg('expect', 'AUTH_FAILED');
const timeoutMs = Number(arg('timeout-min', '40')) * 60000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
const ok = (condition, label, detail) => {
  assert.ok(condition, `${label}${detail ? ` :: ${JSON.stringify(detail).slice(0, 500)}` : ''}`);
  checks += 1; console.log(`  ok  ${label}`);
};
async function call(path, init = {}) {
  const response = await fetch(`${api}${path}`, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const post = (path, body) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body) });
async function waitFor(label, read, done, everyMs = 5000) {
  const started = Date.now();
  let value = null;
  while (Date.now() - started < timeoutMs) {
    value = await read();
    if (done(value)) return value;
    await sleep(everyMs);
  }
  throw new Error(`${label} did not finish: ${JSON.stringify(value).slice(0, 300)}`);
}
function probe(path) {
  const data = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,width,height:format=duration', '-of', 'json', path], { encoding: 'utf8' }));
  const video = data.streams.find((stream) => stream.codec_type === 'video');
  return { width: video?.width, height: video?.height, duration: Number(data.format.duration),
    audio: data.streams.some((stream) => stream.codec_type === 'audio') };
}

async function main() {
  if (!file) throw new Error('--file is required');
  const prisma = new PrismaClient();
  const work = mkdtempSync(join(tmpdir(), 'openai-down-'));
  let project = null; let video = null; const editIds = new Set();
  try {
    console.log('-- the semantic layer reports the outage honestly');
    const probeAi = await post('/edit-mode/creative/resolve', { brief: 'make it feel premium and find the funny bits', useAi: true });
    console.log(`     ai: ${JSON.stringify(probeAi.interpreted.ai)}`);
    ok(probeAi.interpreted.ai.state === expectState && probeAi.interpreted.source === 'DETERMINISTIC',
      `the brief falls back to built-in rules and says why (${expectState})`, probeAi.interpreted.ai);
    ok(/still available/iu.test(probeAi.interpreted.ai.message), 'the message says manual editing and generation still work');
    ok(probeAi.interpreted.intent.modes.includes('FUNNY'), 'deterministic intent is still read');

    console.log('\n-- upload + analysis with the AI mode the UI defaults to (OpenAI)');
    project = await post('/projects', { name: `openai-down-${Date.now()} (disposable)` });
    const form = new FormData();
    form.set('file', new Blob([readFileSync(file)], { type: 'video/mp4' }), basename(file));
    form.set('aiMode', 'ONLINE');
    form.set('processingType', 'EDITED_CLIPS');
    form.set('aspectRatio', '9:16');
    form.set('targetPlatform', 'INSTAGRAM_REELS');
    video = await call(`/projects/${project.id}/videos`, { method: 'POST', body: form });
    const job = await waitFor('analysis', async () => (await call(`/videos?projectId=${project.id}`))
      .find((item) => item.id === video.id)?.processingJobs?.[0],
    (current) => current && ['COMPLETED', 'FAILED'].includes(current.status));
    ok(job.status === 'COMPLETED', 'analysis completes without OpenAI', job);
    const row = await prisma.processingJob.findFirst({ where: { videoId: video.id }, orderBy: { createdAt: 'desc' } });
    const telemetry = row.telemetry ?? {};
    console.log(`     ${JSON.stringify({ effectiveAiMode: telemetry.effectiveAiMode, deterministicFallbackUsed: telemetry.deterministicFallbackUsed,
      fallbackReason: telemetry.fallbackReason, cloudLlmCalls: telemetry.totalCloudLlmCalls ?? telemetry.cloudLlmCalls,
      localLlmCalls: telemetry.localLlmCalls, failedCallsByProvider: telemetry.failedCallsByProvider })}`);
    ok(!telemetry.localLlmCalls && !JSON.stringify(telemetry.successfulCallsByProvider ?? {}).match(/ollama|local|qwen/iu) &&
      !JSON.stringify(telemetry.failedCallsByProvider ?? {}).match(/ollama|local|qwen/iu),
      'nothing was routed to a local LLM');
    ok(!JSON.stringify(telemetry.successfulCallsByProvider ?? {}).match(/openai/iu),
      'no OpenAI call succeeded (the outage is real, not bypassed)', telemetry.successfulCallsByProvider);

    console.log('\n-- automatic generation + a template still deliver');
    const analysis = await call(`/videos/${video.id}/clip-analysis`);
    await post(`/videos/${video.id}/clip-selection`, { requestedClipCount: Math.min(2, analysis.maxClipCount), outputStyle: 'NORMAL',
      generation: { templateId: 'CLEAN_REEL', components: { COLOR: 'COLOR_WARM' }, brief: 'find the funny moments',
        referenceId: null, look: 'CLEAN_REEL' } });
    const results = await waitFor('clips + styling', () => call(`/videos/${video.id}/clip-results`),
      (current) => current.status === 'FAILED' || (current.status === 'COMPLETED' && current.clips.every((clip) =>
        clip.style && ['READY', 'FAILED', 'SKIPPED'].includes(clip.style.status))), 8000);
    ok(results.status === 'COMPLETED' && results.clips.length > 0, `clips delivered (${results.clips.length})`, results.error);
    ok(results.clips.every((clip) => clip.style.status === 'READY'), 'the template/colour styling applied without OpenAI',
      results.clips.map((clip) => clip.style));
    results.clips.forEach((clip) => clip.editProjectId && editIds.add(clip.editProjectId));

    console.log('\n-- manual editing: trim, split, crop, captions, text, colour, audio');
    const id = results.clips[0].editProjectId;
    let edit = await call(`/edit-mode/projects/${id}`);
    const cmd = async (action, payload) => {
      edit = await post(`/edit-mode/projects/${id}/commands/${action}`, { revision: edit.revision, ...payload });
      return edit;
    };
    const firstVideo = () => edit.elements.filter((element) => element.type === 'VIDEO').sort((a, b) => a.position - b.position)[0];
    const captions = () => edit.elements.filter((element) => element.type === 'SUBTITLE');
    let v = firstVideo();
    await cmd('trim', { elementId: v.id, trimStart: v.trimStart + 0.5, trimEnd: v.trimEnd });
    ok(Math.abs(firstVideo().trimStart - (v.trimStart + 0.5)) < 1e-6, 'trim');
    v = firstVideo();
    await cmd('split', { elementId: v.id, playheadSec: v.startTime + v.duration / 2 });
    ok(edit.elements.filter((element) => element.type === 'VIDEO').length === 2, 'split');
    await cmd('set-video-framing', { mode: 'FILL', scope: 'ALL_VIDEO_SEGMENTS' });
    ok(edit.elements.filter((element) => element.type === 'VIDEO').every((element) => element.properties.frameLayout === 'FILL'),
      'whole-clip crop (every segment)');
    const caption = captions()[0];
    if (caption) {
      await cmd('set-caption-text', { elementId: caption.id, content: 'Corrected by hand' });
      await cmd('set-text-color', { elementId: caption.id, color: '#FFD400', scope: 'TRACK' });
      const colours = [...new Set(captions().map((element) => String(element.properties.color).toUpperCase()))];
      ok(colours.length === 1 && colours[0] === '#FFD400' &&
        captions().find((element) => element.id === caption.id)?.properties.content === 'Corrected by hand',
      'captions: text correction + global style, wording kept',
      { colours, count: captions().length, content: captions().find((element) => element.id === caption.id)?.properties.content });
    }
    await cmd('add-text', { textStyleId: 'BASIC', content: 'Made by hand' });
    ok(edit.elements.some((element) => element.type === 'TEXT' && element.properties.content === 'Made by hand'), 'text');
    await cmd('apply-color-filter', { elementId: firstVideo().id, filterId: 'COOL', strength: 1, scope: 'ALL_VIDEO_SEGMENTS' });
    ok(edit.elements.filter((element) => element.type === 'VIDEO').every((element) => element.properties.colorFilterId === 'COOL'),
      'colour (whole clip)');
    await cmd('set-source-audio-volume', { volume: 0.7 });
    ok(edit.elements.filter((element) => element.type === 'VIDEO').every((element) => Math.abs(Number(element.properties.sourceVolume) - 0.7) < 1e-6),
      'source audio volume');

    console.log('\n-- the AI editor: rules still work, semantic requests are honest');
    const zoom = await post(`/edit-mode/projects/${id}/agent/run`, { message: 'add a zoom here', revision: edit.revision, playheadSec: 1 });
    edit = await call(`/edit-mode/projects/${id}`);
    ok(zoom.ledger[0].status === 'DONE' && edit.elements.some((element) => element.type === 'EFFECT'),
      'zoom via deterministic rules', zoom.ledger);
    const vague = await post(`/edit-mode/projects/${id}/agent/run`, { message: 'make it feel more premium and cinematic but natural', revision: edit.revision });
    console.log(`     ${JSON.stringify({ ledger: vague.ledger.map((entry) => [entry.status, entry.planSource]), ai: vague.ai })}`);
    ok(vague.ai?.state === expectState && vague.ai?.retryable === false &&
      vague.ledger.every((entry) => entry.planSource !== 'OPENAI'),
    `a vague creative request reports ${expectState} and is not attributed to OpenAI`, vague.ai);
    ok(!vague.ledger.some((entry) => entry.status === 'DONE' && entry.planSource === 'OPENAI'),
      'nothing claims an OpenAI-understood edit');
    edit = await call(`/edit-mode/projects/${id}`);

    console.log('\n-- render + export');
    await post(`/edit-mode/projects/${id}/export`, { revision: edit.revision });
    const exported = await waitFor('export', () => call(`/edit-mode/projects/${id}/exports`),
      (list) => Array.isArray(list) && list.some((item) => item.current));
    const current = exported.find((item) => item.current);
    const out = join(work, 'edited.mp4');
    writeFileSync(out, Buffer.from(await (await fetch(`${api}/edit-mode/assets/${current.id}/file`)).arrayBuffer()));
    const media = probe(out);
    console.log(`     ${JSON.stringify(media)}`);
    ok(media.width === 1080 && media.height === 1920 && media.audio && media.duration > 3, 'export is real 1080x1920 video with audio');
    console.log(`\nOpenAI-unavailable verification passed (${checks} checks).`);
  } finally {
    const linked = video ? await prisma.editProject.findMany({ where: { generatedClip: { videoId: video.id } },
      select: { id: true } }).catch(() => []) : [];
    for (const editId of new Set([...editIds, ...linked.map((item) => item.id)])) {
      await call(`/edit-mode/projects/${editId}`, { method: 'DELETE' }).catch(() => undefined);
    }
    if (video) await call(`/videos/${video.id}`, { method: 'DELETE' }).catch(() => undefined);
    if (project) await prisma.project.delete({ where: { id: project.id } }).catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
    await prisma.$disconnect();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
