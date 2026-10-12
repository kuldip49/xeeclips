// Real-clip acceptance of the focused editor fixes on a real talking-head recording, with the REAL style
// compilers (StyleOne = AUTOMATIC_2 with its face-following camera, StyleTwo) and the real render path.
//
//   node scripts/verify-editor-real-clip.cjs [--file <mp4>] [--style styleone|styletwo] [--out <dir>]
//
// The clip is a local QA recording (40 s, 1280x720). Everything is disposable: an in-memory EditProject
// (the same harness the other editor tests use), a project built ONLY through ordinary commands, and
// FFmpeg renders into <out>. No database, accounts, AI service or production write.
//
// Flow (the brief's acceptance flow): style the clip -> trim ~3 s off the start -> trim ~2 s off the end
// -> zoom ~1.15x -> pan -> lower the music -> add an image overlay -> seek -> Undo -> Redo -> reload ->
// export. The export is compared with the REAL preview component in a browser by
// `verify-editor-parity-browser.cjs --dir <out>` (the parity-*.json fixtures are written here).
process.env.EDIT_MODE_CHAT_PROPOSAL_REDIS = 'false';
process.env.EDIT_MODE_CHAT_AI_MODE = 'FALLBACK_ONLY';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { seedRichProject } = require('./lib-edit-mode-ai-fixture.cjs');
const { resolveCreativeStyle } = require('../dist/modules/edit-mode/styles/creative-style-resolver.js');
const { compileCreativeStyle } = require('../dist/modules/edit-mode/styles/creative-style-commands.js');
const { buildRenderPlan } = require('../dist/modules/edit-mode/render/edit-mode-render-plan.js');
const { buildEditModeAss } = require('../dist/modules/edit-mode/render/edit-mode-ass.js');
const { buildFfmpegArgs } = require('../dist/modules/edit-mode/render/edit-mode-filtergraph.js');
const { STYLE_TWO_ID } = require('@ai-content-platform/shared/style-two.cjs');

const root = path.resolve(__dirname, '../../..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const sourceFile = path.resolve(arg('file', path.join(root, '.real-qa-preview/final-camera-cleanup/real-talking-head-40s.mp4')));
const outDir = path.resolve(arg('out', path.join(root, '.real-qa-preview/editor-real-clip')));
const styles = arg('style', 'styleone,styletwo').split(',');
fs.mkdirSync(outDir, { recursive: true });
if (fs.existsSync(path.join(root, '.real-qa-preview/fonts'))) fs.cpSync(path.join(root, '.real-qa-preview/fonts'), path.join(outDir, 'fonts'), { recursive: true });
const results = [];
const check = (ok, label, detail = '') => { results.push({ ok: Boolean(ok), label, detail }); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`); if (!ok) process.exitCode = 1; };
const near = (actual, expected, tolerance, label) => check(Math.abs(actual - expected) <= tolerance, label, `got ${Number(actual).toFixed(3)}, want ${expected} ±${tolerance}`);
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }));

async function scenario(kind) {
  const label = kind === 'styleone' ? 'STYLEONE (AUTOMATIC_2, face camera)' : 'STYLETWO';
  console.log(`\n=== real clip - ${label} ===`);
  const info = probe(sourceFile);
  const videoStream = info.streams.find((stream) => stream.codec_type === 'video');
  const hasAudio = info.streams.some((stream) => stream.codec_type === 'audio');
  const media = path.join(outDir, `media-${kind}`); fs.mkdirSync(media, { recursive: true });
  const music = path.join(media, 'music.wav'), image = path.join(media, 'overlay.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=90', '-af', 'volume=4', music]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xFF8C00:s=200x100:d=1', '-frames:v', '1', image]);

  const fixture = await seedRichProject({ split: false });
  const { service, id, rows } = fixture;
  const sourceRow = rows.editAssets.get('asset-source');
  Object.assign(sourceRow, { width: videoStream.width, height: videoStream.height, fps: 29.97, duration: Number(info.format.duration),
    metadata: { hasAudio, hasVideo: true } });
  rows.editAssets.set('asset-image', { ...rows.editAssets.get('asset-logo'), id: 'asset-image', role: 'IMAGE', originalName: 'overlay.png',
    mimeType: 'image/png', width: 200, height: 100 });
  let project = await fixture.refresh();
  const apply = async (summary, commands, actor = 'SYSTEM_ACTION') => (project = (await service.applyAssistantBundle(id, project.revision, {
    proposalId: summary, summary, userMessage: summary, actor, onInvalid: 'FAIL', commands })).project);
  await apply('portrait output', [{ kind: 'SETTINGS', payload: { aspectRatio: '9:16' } }]);
  const { context } = await fixture.chat.loadContext(id, 'apply style', {});
  const resolved = resolveCreativeStyle({ templateId: kind === 'styleone' ? 'AUTOMATIC_2' : STYLE_TWO_ID });
  const hooks = [{ text: 'Why Are Interest Rates Still So High?', style: 'question' },
    { text: 'The Hidden Cost Mortgage Holders Pay Every Month', style: 'strong claim' },
    { text: 'Savings Accounts Quietly Pay More Now', style: 'value' }];
  const compiled = compileCreativeStyle(resolved, context, { hookOptions: hooks, hasWordTimings: true });
  await apply(`${kind} style`, compiled.commands, 'TEMPLATE_ACTION');
  const profile = project.settings.resolvedVisualLayout.editingProfile;
  check(profile === (kind === 'styleone' ? 'AUTOMATIC_2' : 'AUTOMATIC_3_STYLE_TWO'), 'the real style compiler applied', profile);
  const path0 = project.settings.resolvedVisualLayout.cameraPath;
  check(path0.length > 20, 'the style persisted the face camera path the preview follows', `${path0.length} keyframes`);

  // The "generated clip": source 4-16 s. Then the user's own trims on top of it.
  const videoOf = () => project.elements.find((e) => e.type === 'VIDEO' && e.track === 0);
  const trim = async (start, end) => (project = await service.trimElement(id, { revision: project.revision, elementId: videoOf().id, trimStart: start, trimEnd: end }));
  await trim(4, 16);
  const generated = { start: videoOf().trimStart, end: videoOf().trimEnd };
  const generatedPath = JSON.stringify(project.settings.resolvedVisualLayout.cameraPath);
  await trim(generated.start + 3, generated.end - 2);
  near(videoOf().duration, 7, 1e-6, 'trimmed 3 s from the start and 2 s from the end: 7 s remain');
  const cam = project.settings.resolvedVisualLayout.cameraPath;
  check(cam[0].t === 0 && cam.at(-1).t >= 6.9 && cam.every((k) => k.t >= 0 && k.t <= 7.01), 'the camera path now spans exactly the trimmed timeline', `${cam[0].t}..${cam.at(-1).t}`);
  const run = async (action, payload) => (project = await service.phase3Command(id, action, { revision: project.revision, ...payload }));
  await run('set-video-scale', { elementId: videoOf().id, scale: 1.15 });
  await run('set-video-position', { elementId: videoOf().id, x: 0.04, y: -0.03 });
  const musicEl = () => project.elements.find((e) => e.type === 'AUDIO');
  await run('set-audio-volume', { elementId: musicEl().id, volume: 0.15 });
  await run('add-image', { assetId: 'asset-image' });
  const imageEl = () => project.elements.find((e) => e.type === 'IMAGE' && e.assetId === 'asset-image');
  await run('move-element', { elementId: imageEl().id, x: 0.1, y: 0.66 });
  await run('resize-element', { elementId: imageEl().id, width: 0.4, height: 0.1 });
  await run('set-element-timing', { elementId: imageEl().id, startTime: 1, duration: 4 });
  check(musicEl().startTime + musicEl().duration <= 7 + 1e-6, 'music follows the trimmed clip', `${musicEl().startTime}+${musicEl().duration}`);
  check(!project.elements.some((e) => e.startTime + e.duration > 7 + 1e-6), 'nothing on the timeline extends past the trimmed clip');
  check(project.elements.filter((e) => e.type === 'SUBTITLE').every((e) => e.startTime >= 0 && e.startTime + e.duration <= 7 + 1e-6), 'every caption sits inside the trimmed clip');

  const snapshot = () => JSON.stringify([project.settings.resolvedVisualLayout.cameraPath.length, project.elements.map((e) => [e.id, e.type, e.startTime, e.duration, e.trimStart, e.trimEnd, e.properties]).sort()]);
  const edited = snapshot();
  let steps = 0;
  for (; steps < 40; steps++) { if (videoOf().duration > 11.99 && !project.elements.some((e) => e.id === imageEl()?.id)) break; project = await service.undo(id, project.revision); }
  check(steps >= 6, 'undo steps back through zoom, music, image and both trims', `${steps} steps`);
  near(videoOf().trimStart, generated.start, 1e-6, 'undo restores the generated clip start exactly');
  check(JSON.stringify(project.settings.resolvedVisualLayout.cameraPath) === generatedPath, 'and the generated clip camera path with it, keyframe for keyframe');
  for (let i = 0; i < steps; i++) project = await service.redo(id, project.revision);
  check(snapshot() === edited, 'redo restores the exact edited state');
  await fixture.refresh();
  check(snapshot() === edited, 'a reload returns the exact state');

  // ---- export through the real plan/graph ----
  const state = JSON.parse(JSON.stringify(project, (k, v) => typeof v === 'bigint' ? Number(v) : v));
  const source = state.assets.find((a) => a.role === 'SOURCE');
  const built = buildRenderPlan({ project: state, assets: state.assets.map((a) => a.id === source.id ? { ...a, ...source } : a),
    elements: state.elements, hasSourceAudio: hasAudio, fps: 30 });
  near(built.plan.durationSec, 7, 1e-6, 'the export plan is the trimmed length');
  check(built.plan.canvas.visualLayout.videoFrame.mode === 'CARD', 'the card layout is intact');
  const ass = buildEditModeAss(built.plan.canvas, [...built.plan.textOverlays, ...built.plan.subtitles]);
  const assName = `${kind}.ass`; fs.writeFileSync(path.join(outDir, assName), ass.content);
  const overlayPaths = Object.fromEntries(state.elements.filter((e) => e.type === 'IMAGE').map((e) => [e.id, image]));
  const audioPaths = Object.fromEntries(state.elements.filter((e) => e.type === 'AUDIO').map((e) => [e.id, music]));
  const output = path.join(outDir, `${kind}-edited.mp4`);
  const args = buildFfmpegArgs({ plan: built.plan, sourcePath: sourceFile, overlayPaths, audioPaths, audioChannels: { source: 2, tracks: {} },
    assFileName: assName, outputPath: output, fontsDir: fs.existsSync(path.join(outDir, 'fonts')) ? 'fonts' : undefined,
    informationCrop: built.evidence.informationCrop, fitExpression: built.evidence.fitExpression,
    informationFitExpression: built.evidence.informationFitExpression, cameraFilter: built.evidence.cameraFilter });
  execFileSync('ffmpeg', args, { cwd: outDir, stdio: 'pipe' });
  const exported = probe(output);
  near(Number(exported.format.duration), 7, 0.1, 'exported duration equals the trimmed timeline');
  check(exported.streams.some((s) => s.codec_type === 'audio'), 'export carries source + music audio');
  check(built.plan.zoomEvents.length === 0, 'automatic zoom stood aside for the manual zoom', `${built.plan.zoomEvents.length} auto zooms`);
  // Fixture for the browser parity check.
  fs.copyFileSync(sourceFile, path.join(outDir, 'source.mp4')); fs.copyFileSync(image, path.join(outDir, 'overlay.png')); fs.copyFileSync(music, path.join(outDir, 'music.wav'));
  fs.writeFileSync(path.join(outDir, `parity-realclip-${kind}.json`), JSON.stringify({ label: `realclip-${kind}`, times: [1, 2, 3.5, 5, 6.5],
    export: path.basename(output), project: state }, null, 2));
  // Preview/export camera agreement over the trimmed timeline (the persisted path vs the render's own camera).
  let worst = 0;
  for (const t of [0.5, 1.5, 3, 4.5, 6]) {
    const keys = state.settings.resolvedVisualLayout.cameraPath;
    const after = keys.findIndex((k) => k.t >= t);
    const right = keys[Math.max(0, after)], left = keys[Math.max(0, after - 1)];
    const mix = right.t === left.t ? 0 : (t - left.t) / (right.t - left.t);
    const preview = { x: left.x + (right.x - left.x) * mix, y: left.y + (right.y - left.y) * mix, w: left.w + (right.w - left.w) * mix };
    const renderCam = built.evidence.cropAt(t);
    if (process.env.DEBUG_CAMERA) console.log('   cam', t, JSON.stringify(preview), JSON.stringify({ x: renderCam.x, y: renderCam.y, w: renderCam.w, h: renderCam.h }));
    worst = Math.max(worst, Math.abs(preview.x - renderCam.x), Math.abs(preview.y - renderCam.y), Math.abs(preview.w - renderCam.w));
  }
  check(worst < 0.01, 'the preview camera path equals the export camera on the TRIMMED timeline', `worst error ${worst.toFixed(4)} of the frame`);
}

(async () => {
  try { for (const kind of styles) await scenario(kind); }
  catch (error) { console.error(error); process.exitCode = 1; }
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; output in ${outDir}`);
})();
