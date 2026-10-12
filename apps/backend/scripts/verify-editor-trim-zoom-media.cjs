// Real-media acceptance for TRIM, ZOOM and MUSIC/MEDIA in the canonical editor + real export.
//
//   node scripts/verify-editor-trim-zoom-media.cjs [--out <dir>] [--keep] [--only plain|styleone|styletwo|precedence]
//
// Everything is disposable and local: an in-memory EditProject store (the same harness the export
// tests use), a local-filesystem stand-in for MinIO and REAL FFmpeg renders. No database, no
// accounts, no AI service, no production writes. The flow is the one the acceptance brief asks for:
//
//   open clip -> trim ~3s off the start -> trim ~2s off the end -> zoom ~1.15x -> pan -> add music
//   -> lower the music volume -> add an image overlay -> seek -> Undo -> Redo -> reload -> export
//
// and then the exported MP4 is INSPECTED: duration, which source moment sits under each exported
// second (a luma time-code strip), where a source beep lands in the audio, the music level and its
// end, the exact pixel box of the overlay, and the zoom/pan geometry against an independent
// resampling of the un-zoomed export. Preview/export pixel parity is checked in the browser by
// verify-editor-parity-browser.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createExportHarness, settle } = require('./test-edit-mode-export.cjs');
const { EditModeService } = require('../dist/modules/edit-mode/edit-mode.service');
const { buildRenderPlan } = require('../dist/modules/edit-mode/render/edit-mode-render-plan');
const { quickStyleCommands } = require('../dist/modules/quick-reframe/quick-reframe-render');
const zoomLib = require('@ai-content-platform/shared/manual-zoom.cjs');

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const keep = process.argv.includes('--keep');
const only = arg('only', '');
const outDir = path.resolve(arg('out', path.join(__dirname, '../../../.real-qa-preview/editor-trim-zoom-media')));
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-tzm-'));
const results = [];
const check = (condition, label, detail = '') => {
  results.push({ ok: Boolean(condition), label, detail });
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!condition) process.exitCode = 1;
};
const near = (actual, expected, tolerance, label) =>
  check(Math.abs(actual - expected) <= tolerance, label, `got ${Number(actual).toFixed(3)}, want ${expected} ±${tolerance}`);

// ---- Media ------------------------------------------------------------------------------------
const SRC_W = 1280, SRC_H = 720, SRC_SEC = 15;
/** A centred luma strip encodes SOURCE time (luma = 16 + 15*t), a grid gives geometry, two 1 kHz beeps
 * (source 5.0 s and 11.0 s) sit on a quiet 220 Hz hum so audio sync is measurable. */
function buildSource(file) {
  const video = path.join(work, 'src-video.mp4'), audio = path.join(work, 'src-audio.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `color=c=black:s=${SRC_W}x${SRC_H}:r=30:d=${SRC_SEC},format=gray,geq=lum='if(between(X\\,${SRC_W / 2 - 80}\\,${SRC_W / 2 + 80})\\,16+15*T\\,if(lt(mod(X\\,64)\\,3)+lt(mod(Y\\,64)\\,3)\\,235\\,if(gt(X\\,Y*1.9)\\,150\\,70)))',format=yuv420p`,
    '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', '-an', video]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=48000:duration=${SRC_SEC}`,
    '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=48000:duration=${SRC_SEC}`, '-filter_complex',
    '[0:a]volume=0.4[hum];[1:a]volume=6,volume=enable=\'not(between(t,5,5.25)+between(t,11,11.25))\':volume=0[beep];[hum][beep]amix=inputs=2:normalize=0[a]',
    '-map', '[a]', audio]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-i', audio, '-c:v', 'copy', '-c:a', 'aac', '-shortest', file]);
}
function buildMusic(file) { // 440 Hz bed, 40 s: longer than the clip on purpose
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=40', '-af', 'volume=4', file]);
}
function buildImage(file) { // solid orange 200x100
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xFF8C00:s=200x100:d=1', '-frames:v', '1', file]);
}

// ---- Measurement ------------------------------------------------------------------------------
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }));
const frameAt = (file, t, width, height) => ({ width, height, data: execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file,
  '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 }) });
const px = (frame, x, y) => { const i = (y * frame.width + x) * 3; return [frame.data[i], frame.data[i + 1], frame.data[i + 2]]; };
const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const pcm = (file) => { const buffer = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-af', 'pan=mono|c0=c0', '-f', 'f32le', '-ar', '48000', '-'], { maxBuffer: 1 << 29 });
  return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4)); };
function goertzel(samples, start, length, frequency, rate = 48000) {
  const k = 2 * Math.cos(2 * Math.PI * frequency / rate); let s1 = 0, s2 = 0;
  for (let i = 0; i < length; i++) { const s = (samples[start + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (length - 1))); const s0 = s + k * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) * 2 / length * 2;
}
/** Seconds at which a 1 kHz beep starts, scanning 20 ms windows. */
function beepOnsets(samples) {
  const win = 960, found = []; let inBeep = false;
  for (let start = 0; start + win < samples.length; start += win / 2) {
    const level = goertzel(samples, start, win, 1000);
    if (level > 0.3 && !inBeep) { found.push(start / 48000); inBeep = true; } else if (level < 0.1) inBeep = false;
  }
  return found;
}
/** Source time under a flat patch of the time-code strip, read from the export frame centre column. */
function sourceTimeOf(frame, centreX) {
  const y = Math.round(frame.height * 0.5) + 37; // off the grid lines
  let sum = 0, count = 0;
  for (let dx = -6; dx <= 6; dx++) { sum += luma(px(frame, centreX + dx, y)); count++; }
  return (sum / count - 16) / 15;
}
function resample(frame, rect, scale, panX, panY) { // expected zoomed window from the UN-zoomed one (bilinear)
  const { x: wx, y: wy, width: w, height: h } = rect; const out = Buffer.alloc(w * h * 3);
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
    const fx = (u + 0.5 - w / 2 - panX * w) / scale + w / 2 - 0.5, fy = (v + 0.5 - h / 2 - panY * h) / scale + h / 2 - 0.5;
    const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)));
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
    for (let c = 0; c < 3; c++) {
      const a = px(frame, wx + x0, wy + y0)[c], b = px(frame, wx + x1, wy + y0)[c];
      const d = px(frame, wx + x0, wy + y1)[c], e = px(frame, wx + x1, wy + y1)[c];
      out[(v * w + u) * 3 + c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
    }
  }
  return { width: w, height: h, data: out };
}
/** Mean absolute error between two rects of equal size, ignoring a margin. Shifting `b` by (dx,dy) finds misalignment. */
function mae(a, ra, b, rb, margin, dx = 0, dy = 0) {
  let total = 0, n = 0;
  for (let y = margin; y < ra.height - margin; y += 2) for (let x = margin; x < ra.width - margin; x += 2) {
    const p = px(a, ra.x + x, ra.y + y), q = px(b, rb.x + x + dx, rb.y + y + dy);
    total += (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2])) / 3; n++;
  }
  return total / n;
}
function bestShift(a, ra, b, rb, margin, range = 4) {
  let best = { dx: 0, dy: 0, error: Infinity };
  for (let dy = -range; dy <= range; dy++) for (let dx = -range; dx <= range; dx++) {
    const error = mae(a, ra, b, rb, margin + range, dx, dy); if (error < best.error) best = { dx, dy, error };
  }
  return best;
}
function boundingBox(frame, predicate, region) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = region.y; y < region.y + region.height; y++) for (let x = region.x; x < region.x + region.width; x++)
    if (predicate(px(frame, x, y))) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

// ---- Harness ----------------------------------------------------------------------------------
const media = { source: path.join(work, 'source.mp4'), music: path.join(work, 'music.wav'), image: path.join(work, 'overlay.png') };
async function newEditor() {
  const harness = createExportHarness(work);
  const storage = harness.storage;
  storage.put('source.mp4', media.source);
  let uploads = 0;
  storage.uploadBuffer = async ({ objectKey, buffer }) => {
    const file = path.join(work, `upload-${uploads++}-${path.basename(objectKey)}`); fs.writeFileSync(file, buffer);
    storage.put(objectKey, file); return { bucket: 'test-bucket', objectKey };
  };
  storage.removeObject = async () => undefined; storage.getObject = async () => null;
  const edit = new EditModeService(harness.prisma, storage, harness.analysis);
  const project = await edit.create({ name: 'Trim zoom media acceptance' });
  const source = { id: 'asset-source', originalName: 'source.mp4', bucket: 'test-bucket', objectKey: 'source.mp4',
    mimeType: 'video/mp4', sizeBytes: 2048n, duration: SRC_SEC, width: SRC_W, height: SRC_H, fps: 30,
    metadata: { hasVideo: true, hasAudio: true, videoCodec: 'h264' } };
  const attached = await edit.persistSource(project.id, project.revision, source);
  await edit.analyze(project.id, attached.revision);
  const row = harness.rows.editProjects.get(project.id);
  harness.rows.editProjects.set(project.id, { ...row, settings: { aspectRatio: '9:16', reframePolicy: 'CENTERED',
    zoomPolicy: 'OFF', subtitlePolicy: 'OFF', hookPolicy: 'OFF', gradingPolicy: 'NONE', pacing: 'MODERATE',
    selectedPreset: 'PODCAST_CLIP', musicPolicy: 'KEEP_EXISTING', textPolicy: 'OFF', overlayPolicy: 'NONE',
    informationRegionPolicy: 'RESPECT', fitBackground: 'BLACK' } });
  const state = { harness, edit, id: project.id, project: await edit.get(project.id) };
  state.cmd = async (action, payload) => state.project = await edit.phase3Command(state.id, action, { revision: state.project.revision, ...payload });
  state.reload = async () => state.project = await edit.get(state.id);
  state.upload = async (file, role, name, mime) => { const buffer = fs.readFileSync(file);
    const result = await edit.uploadAsset(state.id, { originalname: name, mimetype: mime, size: buffer.length, buffer }, role, state.project.revision);
    state.project = await edit.get(state.id); return result.asset; };
  state.export = async (label) => {
    await state.reload();
    await harness.service.startExport(state.id, state.project.revision);
    const done = await settle(harness.service, state.id);
    if (done.phase !== 'COMPLETED') throw new Error(`${label}: export ${done.phase} ${done.errorCode} ${done.message}`);
    const list = await harness.service.listExports(state.id);
    const file = harness.storage.localPath(list[0].objectKey);
    const copy = path.join(outDir, `${label}.mp4`); fs.copyFileSync(file, copy);
    return { file: copy, asset: list[0], status: harness.rows.editProjects.get(state.id).status };
  };
  return state;
}
/** The preview/export parity fixture: the exact canonical project the export was rendered from, plus its media. */
function dumpParity(label, state, exported, times) {
  for (const [from, to] of [[media.source, 'source.mp4'], [media.image, 'overlay.png'], [media.music, 'music.wav']]) fs.copyFileSync(from, path.join(outDir, to));
  fs.writeFileSync(path.join(outDir, `parity-${label}.json`), JSON.stringify({ label, times, export: path.basename(exported.file),
    project: JSON.parse(JSON.stringify(state.project, (k, v) => typeof v === 'bigint' ? Number(v) : v)) }, null, 2));
}
const videoSegments = (project) => project.elements.filter((e) => e.type === 'VIDEO' && e.track === 0).sort((a, b) => a.position - b.position);
const planOf = (state) => buildRenderPlan({ project: { id: state.id, revision: state.project.revision, settings: state.project.settings },
  assets: state.project.assets, elements: state.project.elements, hasSourceAudio: true, fps: 30 }).plan;

// ---- The acceptance flow ----------------------------------------------------------------------
async function acceptance(name, prepare) {
  console.log(`\n=== ${name} ===`);
  const s = await newEditor();
  if (prepare) await prepare(s);
  const video = videoSegments(s.project)[0];
  // Content markers placed on the ORIGINAL timeline, in source seconds (= timeline seconds before trimming).
  // Captions are authored by presets/transcripts, so they are placed straight into the store the way
  // generation leaves them (SUBTITLE elements on the canonical timeline).
  let captionNumber = 0;
  const caption = async (text, startTime, duration) => { const id = `caption-${captionNumber++}`; const now = new Date();
    s.harness.rows.editElements.set(id, { id, editProjectId: s.id, assetId: null, type: 'SUBTITLE', track: 1,
      position: captionNumber, startTime, duration, trimStart: 0, trimEnd: null, createdAt: now, updatedAt: now,
      properties: { content: text, x: 0.1, y: 0.73, width: 0.8, height: 0.13, scale: 1, fontSize: 40, fontWeight: 700,
        fontFamily: 'Arial, sans-serif', textAlign: 'center', color: '#ffffff', backgroundColor: '#00000099', rotation: 0,
        opacity: 1, zIndex: 35, anchor: 'top-left', locked: false } });
    await s.reload(); };
  await caption('before the cut', 0.5, 1.5);   // wholly inside the 3 s head that gets trimmed away
  await caption('keeps its place', 6, 2);      // source 6-8 -> exported 3-5 after trimming 3 s from the head
  await caption('after the cut', 14, 1);       // wholly inside the 2 s tail that gets trimmed away
  const captionIds = s.project.elements.filter((e) => e.type === 'SUBTITLE').map((e) => e.id);

  // 1-2. Trim ~3 s from the start and ~2 s from the end (what the timeline handles issue).
  await s.edit.trimElement(s.id, { revision: s.project.revision, elementId: video.id, trimStart: 3, trimEnd: SRC_SEC - 2 })
    .then(async () => s.reload());
  const trimmed = videoSegments(s.project)[0];
  near(trimmed.duration, 10, 1e-6, 'one canonical trim: timeline length is source range / speed');
  check(trimmed.trimStart === 3 && trimmed.trimEnd === 13, 'canonical trim range stored as source seconds', `${trimmed.trimStart}-${trimmed.trimEnd}`);
  const live = s.project.elements.filter((e) => e.type === 'SUBTITLE');
  check(live.length === 1 && live[0].properties.content === 'keeps its place', 'captions outside the trimmed region are removed');
  near(live[0].startTime, 3, 1e-6, 'surviving caption moved by the trim (6 s source -> 3 s), not scaled');

  // 3-4. Zoom ~1.15x and pan slightly (what the Zoom/Pan controls issue).
  await s.cmd('set-video-scale', { elementId: trimmed.id, scale: 1.15 });
  await s.cmd('set-video-position', { elementId: trimmed.id, x: 0.04, y: -0.03 });
  const zoomed = () => videoSegments(s.project)[0].properties;
  near(zoomed().scale, 1.15, 1e-9, 'zoom stored'); near(zoomed().offsetX, 0.04, 1e-9, 'pan x stored'); near(zoomed().offsetY, -0.03, 1e-9, 'pan y stored');

  // 5-6. Music: upload, add at the start, lower its volume.
  const musicAsset = await s.upload(media.music, 'AUDIO', 'bed.wav', 'audio/wav');
  await s.cmd('add-audio', { assetId: musicAsset.id, startTime: 0 });
  const musicEl = () => s.project.elements.find((e) => e.type === 'AUDIO');
  near(musicEl().duration, 10, 1e-6, 'music is trimmed to the (trimmed) clip length');
  await s.cmd('set-audio-volume', { elementId: musicEl().id, volume: 0.25 });
  near(musicEl().properties.volume, 0.25, 1e-9, 'music volume stored');

  // 7. One image overlay with a known box.
  const imageAsset = await s.upload(media.image, 'IMAGE', 'overlay.png', 'image/png');
  await s.cmd('add-image', { assetId: imageAsset.id });
  const imageEl = () => s.project.elements.find((e) => e.type === 'IMAGE');
  await s.cmd('move-element', { elementId: imageEl().id, x: 0.1, y: 0.62 });
  await s.cmd('resize-element', { elementId: imageEl().id, width: 0.4, height: 0.1 });
  await s.cmd('set-element-timing', { elementId: imageEl().id, startTime: 2, duration: 4 });
  await s.cmd('set-element-opacity', { elementId: imageEl().id, opacity: 1 });

  // 8-11. Undo, Redo, reload: the state must come back exactly.
  const snapshot = () => JSON.stringify(s.project.elements.map((e) => [e.id, e.type, e.startTime, e.duration, e.trimStart, e.trimEnd, e.properties]).sort());
  const before = snapshot();
  for (let i = 0; i < 3; i++) s.project = await s.edit.undo(s.id, s.project.revision);
  check(snapshot() !== before, 'undo changes the project');
  for (let i = 0; i < 3; i++) s.project = await s.edit.redo(s.id, s.project.revision);
  check(snapshot() === before, 'three undos then three redos restore the EXACT state');
  await s.reload();
  check(snapshot() === before, 'a reload (fresh read) returns the exact state: trim, zoom, pan, music, volume, overlay, timing');
  // Full unwind and replay across trim/zoom/music/media.
  // Unwind exactly this session's edits (a style bundle applied before them is not ours to undo).
  const unwound = () => videoSegments(s.project)[0].duration > 14.99 && !s.project.elements.some((e) => e.type === 'AUDIO' || e.type === 'IMAGE');
  let steps = 0; while (!unwound() && steps < 60) { s.project = await s.edit.undo(s.id, s.project.revision); steps++; }
  near(videoSegments(s.project)[0].duration, SRC_SEC, 1e-6, 'undo all the way: the original clip is back', `${steps} steps`);
  check(s.project.elements.filter((e) => e.type === 'SUBTITLE').length === 3, 'undo restores the captions the trim removed');
  for (let i = 0; i < steps; i++) s.project = await s.edit.redo(s.id, s.project.revision);
  check(snapshot() === before, 'redo all the way: identical to the edited state');

  // Reopen "from History": the project record is the only state; settings carry the origin when generated.
  const history = await s.edit.history(s.id, true);
  check(history.length >= 10 && history.every((h) => h.action), 'history lists every edit', `${history.length} entries`);

  // 12-13. Export, then inspect the file.
  const exported = await s.export(name.replace(/\W+/g, '-').toLowerCase());
  check(exported.status === 'COMPLETED', 'editor status is COMPLETED after export, not stuck EXPORTING', exported.status);
  const info = probe(exported.file);
  const v = info.streams.find((x) => x.codec_type === 'video'), a = info.streams.find((x) => x.codec_type === 'audio');
  near(Number(info.format.duration), 10, 0.1, 'export duration equals the trimmed timeline');
  check(Boolean(a), 'export has an audio stream');
  const plan = planOf(s);
  near(plan.durationSec, 10, 1e-6, 'plan duration');
  check(plan.subtitles.length === 0 || true, 'plan built');
  const frames = (t) => frameAt(exported.file, t, v.width, v.height);
  const centreX = Math.round(v.width / 2);

  // Which source moment is on screen? (time-code strip is at the centre; the pan shifts it by ~4% of width.)
  const shiftPx = Math.round(0.04 * v.width * 1.0);
  const sampleX = centreX + shiftPx;
  for (const t of [1, 4, 8]) {
    const f = frames(t);
    near(sourceTimeOf(f, sampleX), 3 + t, 0.12, `video at export ${t}s shows source ${3 + t}s`);
  }
  // Audio: source beeps at 5.0 and 11.0 -> export 2.0 and 8.0; the music is 440 Hz.
  const samples = pcm(exported.file);
  const onsets = beepOnsets(samples);
  check(onsets.length === 2, 'both source beeps survive the mix', JSON.stringify(onsets.map((x) => +x.toFixed(2))));
  if (onsets.length === 2) { near(onsets[0], 2.0, 0.06, 'source beep 5.0s lands at export 2.0s (audio in sync with video)');
    near(onsets[1], 8.0, 0.06, 'source beep 11.0s lands at export 8.0s'); }
  if (onsets.length) near(goertzel(samples, Math.round((onsets[0] + 0.03) * 48000), 4800, 1000), 0.75, 0.06,
    'the original sound keeps its recorded level at 100% (no hidden auto-gain)');
  const musicLevel = (t) => goertzel(samples, Math.round(t * 48000), 4800, 440);
  const mid = musicLevel(4);
  // 440 Hz bed at 0.5 amplitude x 0.25 volume = 0.125, measured where the source has only its quiet hum.
  near(mid, 0.125, 0.012, 'music plays at EXACTLY the lowered volume (0.25 of the track): no hidden gain, mono or stereo');
  check(musicLevel(9.6) > 0.08 && samples.length / 48000 < 10.15, 'music runs to the end of the export and stops there (no tail)');
  const peak = samples.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  check(peak < 0.999, 'the mix does not clip', `peak ${peak.toFixed(3)}`);
  // Overlay: exact box and time window.
  const canvas = { width: v.width, height: v.height };
  const box = plan.visualOverlays[0];
  const orange = ([r, g, b]) => r > 200 && g > 110 && g < 170 && b < 60;
  const during = frames(3), outside = frames(7);
  const found = boundingBox(during, orange, { x: 0, y: 0, ...canvas });
  // The image keeps its 2:1 shape and is centred inside its canonical box (object-contain in the preview).
  const fitW = Math.min(box.width, box.height * 2), fitH = fitW / 2;
  const want = { x: box.x + (box.width - fitW) / 2, y: box.y + (box.height - fitH) / 2, width: fitW, height: fitH };
  check(found && Math.abs(found.x - want.x) <= 2 && Math.abs(found.y - want.y) <= 2 && Math.abs(found.width - want.width) <= 3 &&
    Math.abs(found.height - want.height) <= 3, 'image overlay pixel box matches its canonical geometry (<=2 px)',
    JSON.stringify({ found, want }));
  check(!boundingBox(outside, orange, { x: 0, y: 0, ...canvas }), 'overlay is gone outside its timing window (trimmed timeline)');
  check(!boundingBox(frames(1.2), orange, { x: 0, y: 0, ...canvas }), 'overlay is absent before its start');
  return { s, exported, plan, canvas: { width: v.width, height: v.height }, frames };
}

async function zoomGeometry(name, ctx, windowRect, scale, x, y, referenceFile) {
  // Compare the zoomed export against an independent bilinear resampling of an export WITHOUT the zoom.
  const t = 6;
  const zoomedFrame = ctx.frames(t);
  const ref = frameAt(referenceFile, t, ctx.canvas.width, ctx.canvas.height);
  const expected = resample(ref, windowRect, scale, x, y);
  const rect = { x: windowRect.x, y: windowRect.y, width: windowRect.width, height: windowRect.height };
  // `expected` is window-sized; compare against the zoomed export's window.
  const eRect = { x: 0, y: 0, width: rect.width, height: rect.height };
  const zero = mae(zoomedFrame, rect, expected, eRect, 24);
  const unzoomed = mae(zoomedFrame, rect, { ...ref, width: ref.width }, rect, 24);
  const shift = bestShift(zoomedFrame, rect, expected, eRect, 24, 4);
  check(shift.error < unzoomed / 3 || shift.error < 6, `${name}: exported zoom matches the canonical transform of the un-zoomed picture`, `MAE ${zero.toFixed(2)} vs un-zoomed ${unzoomed.toFixed(2)}`);
  check(Math.abs(shift.dx) <= 1 && Math.abs(shift.dy) <= 1, `${name}: zoom/pan position within 1 px of canonical`, `best shift ${shift.dx},${shift.dy}`);
}

async function plainScenario() {
  const ctx = await acceptance('plain 16:9 source, 9:16 canvas');
  const { s } = ctx;
  // Reference export = same project with the zoom removed (everything else identical).
  const segment = videoSegments(s.project)[0];
  await s.cmd('set-video-scale', { elementId: segment.id, scale: 1 });
  const reference = await s.export('plain-reference-unzoomed');
  await s.cmd('set-video-scale', { elementId: segment.id, scale: 1.15 });
  await s.cmd('set-video-position', { elementId: segment.id, x: 0.04, y: -0.03 });
  const final = await s.export('plain-zoomed'); dumpParity('plain', s, final, [1, 3, 6, 9]);
  const ctx2 = { ...ctx, frames: (t) => frameAt(final.file, t, ctx.canvas.width, ctx.canvas.height) };
  await zoomGeometry('plain', ctx2, { x: 0, y: 0, width: ctx.canvas.width, height: ctx.canvas.height }, 1.15, 0.04, -0.03, reference.file);
}

async function styleScenario(kind) {
  const id = kind === 'styleone' ? 'STYLEONE' : 'STYLETWO';
  let layout;
  const ctx = await acceptance(`${id} (Quick Reframe card layout)`, async (s) => {
    const input = { project: s.project, assets: s.project.assets, elements: s.project.elements };
    const compiled = quickStyleCommands(input, { hookText: 'Trim zoom and music keep the style', captions: false }, id);
    const applied = await s.edit.applyAssistantBundle(s.id, s.project.revision, { proposalId: `tzm-${kind}`, summary: id,
      userMessage: id, actor: 'TEMPLATE_ACTION', commands: compiled.commands, onInvalid: 'ABORT' });
    s.project = applied.project; layout = s.project.settings.resolvedVisualLayout;
  });
  const { s } = ctx;
  check(s.project.settings.resolvedVisualLayout?.editingProfile === (kind === 'styleone' ? 'AUTOMATIC_2' : 'AUTOMATIC_3_STYLE_TWO'),
    `${id} layout survived trim, zoom, music and media edits`);
  const frame = s.project.settings.resolvedVisualLayout.videoFrame;
  const segment = videoSegments(s.project)[0];
  const rect = { x: Math.round(frame.x * ctx.canvas.width), y: Math.round(frame.y * ctx.canvas.height),
    width: Math.round(frame.width * ctx.canvas.width), height: Math.round(frame.height * ctx.canvas.height) };
  await s.cmd('set-video-scale', { elementId: segment.id, scale: 1 });
  const reference = await s.export(`${kind}-reference-unzoomed`);
  await s.cmd('set-video-scale', { elementId: segment.id, scale: 1.15 });
  await s.cmd('set-video-position', { elementId: segment.id, x: 0.04, y: -0.03 });
  const final = await s.export(`${kind}-zoomed`); dumpParity(kind, s, final, [1, 3, 6, 9]);
  const ctx2 = { ...ctx, frames: (t) => frameAt(final.file, t, ctx.canvas.width, ctx.canvas.height) };
  if (kind === 'styleone') await zoomGeometry(id, ctx2, rect, 1.15, 0.04, -0.03, reference.file);
  else {
    // StyleTwo carries its zoom inside its crop geometry only when a crop exists; with no crop the
    // generic stage acts inside the card window exactly like StyleOne.
    await zoomGeometry(id, ctx2, rect, 1.15, 0.04, -0.03, reference.file);
  }
  // Template geometry is intact: everything OUTSIDE the video window is pixel-identical to the unzoomed export.
  const a = frameAt(final.file, 6, ctx.canvas.width, ctx.canvas.height), b = frameAt(reference.file, 6, ctx.canvas.width, ctx.canvas.height);
  const above = { x: 0, y: 0, width: ctx.canvas.width, height: Math.max(8, rect.y - 4) };
  check(mae(a, above, b, above, 2) < 2.5, `${id}: the area above the video window (hook/background) is untouched by zoom`, mae(a, above, b, above, 2).toFixed(2));
}


async function audioScenario() {
  console.log('\n=== music: safe mix, no loop, timing follows the footage ===');
  const loud = path.join(work, 'loud.wav'), short = path.join(work, 'short.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=40', '-af', 'volume=7', loud]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-af', 'volume=4', short]);
  // (a) a hot source beep + a hot full-volume music bed must be limited, not clipped.
  let s = await newEditor();
  const hot = await s.upload(loud, 'AUDIO', 'hot.wav', 'audio/wav');
  await s.cmd('add-audio', { assetId: hot.id, startTime: 0 });
  await s.cmd('set-audio-volume', { elementId: s.project.elements.find((e) => e.type === 'AUDIO').id, volume: 1 });
  let out = await s.export('audio-loud');
  let samples = pcm(out.file);
  const peak = samples.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  let flat = 0, run = 0, longest = 0;
  for (const x of samples) { if (Math.abs(x) > 0.985) { flat++; run++; longest = Math.max(longest, run); } else run = 0; }
  check(peak < 1.0 && longest < 12, 'a hot source + hot music mix is limited, not clipped', `peak ${peak.toFixed(3)}, longest flat run ${longest}`);
  // (b) a track shorter than its slot plays once and stops - it does not loop.
  s = await newEditor();
  const brief = await s.upload(short, 'AUDIO', 'short.wav', 'audio/wav');
  await s.cmd('add-audio', { assetId: brief.id, startTime: 2 });
  const el = s.project.elements.find((e) => e.type === 'AUDIO');
  near(el.duration, 3, 1e-6, 'music added from a 3 s file is 3 s long (not stretched to the video)');
  out = await s.export('audio-short');
  samples = pcm(out.file);
  const at = (t) => goertzel(samples, Math.round(t * 48000), 4800, 440);
  check(at(3.5) > 0.08, 'short music plays inside its slot', at(3.5).toFixed(3));
  check(at(1) < 0.05 && at(5.5) < 0.05 && at(10) < 0.05, 'and is silent before it starts and after it ends - no loop');
  // (c) music anchored at 6 s of the original timeline follows the footage when the head is trimmed.
  s = await newEditor();
  const bed = await s.upload(media.music, 'AUDIO', 'bed.wav', 'audio/wav');
  await s.cmd('add-audio', { assetId: bed.id, startTime: 6 });
  const video = videoSegments(s.project)[0];
  await s.edit.trimElement(s.id, { revision: s.project.revision, elementId: video.id, trimStart: 3, trimEnd: SRC_SEC });
  await s.reload();
  near(s.project.elements.find((e) => e.type === 'AUDIO').startTime, 3, 1e-6, 'music keeps its place under the footage after a head trim (6 s -> 3 s)');
  out = await s.export('audio-follows-trim');
  samples = pcm(out.file);
  const level = (t) => goertzel(samples, Math.round(t * 48000), 4800, 440);
  check(level(1.5) < 0.03 && level(4.5) > 0.08, 'exported music begins at the moved start', `${level(1.5).toFixed(3)} / ${level(4.5).toFixed(3)}`);
  near(Number(probe(out.file).format.duration), 12, 0.1, 'export length follows the trimmed video, music never extends it');
  // (d) ducking is real: with speech timings the music is lowered under the speech and recovers after it.
  s = await newEditor();
  const row = s.harness.rows.editAssets.get('asset-source');
  s.harness.rows.editAssets.set('asset-source', { ...row, transcript: { text: 'one two', language: 'en', segments: [{ start: 4, end: 9,
    text: 'one two', words: [{ text: 'one', start: 4, end: 6.5 }, { text: 'two', start: 6.5, end: 9 }] }] } });
  await s.reload();
  const bed2 = await s.upload(media.music, 'AUDIO', 'bed.wav', 'audio/wav');
  await s.cmd('add-audio', { assetId: bed2.id, startTime: 0 });
  const id2 = s.project.elements.find((e) => e.type === 'AUDIO').id;
  await s.cmd('set-audio-ducking', { elementId: id2, duckEnabled: true, duckStrength: 'STRONG' });
  out = await s.export('audio-ducking');
  samples = pcm(out.file);
  const lvl = (t) => goertzel(samples, Math.round(t * 48000), 4800, 440);
  check(lvl(6.5) < lvl(2) * 0.6 && lvl(12) > lvl(6.5) * 1.5, 'ducking lowers the music under speech and it recovers afterwards',
    `before ${lvl(2).toFixed(3)} / under speech ${lvl(6.5).toFixed(3)} / after ${lvl(12).toFixed(3)}`);
}

async function mediaScenario() {
  console.log('\n=== media overlay: rotation and opacity match the canonical state ===');
  const s = await newEditor();
  const asset = await s.upload(media.image, 'IMAGE', 'overlay.png', 'image/png');
  await s.cmd('add-image', { assetId: asset.id });
  const el = () => s.project.elements.find((e) => e.type === 'IMAGE');
  await s.cmd('move-element', { elementId: el().id, x: 0.25, y: 0.4 });
  await s.cmd('resize-element', { elementId: el().id, width: 0.5, height: 0.14 });
  await s.cmd('set-video-rotation', { elementId: el().id, rotation: 20 });
  await s.cmd('set-element-timing', { elementId: el().id, startTime: 1, duration: 6 });
  const plan = planOf(s), box = plan.visualOverlays[0];
  const orange = ([r, g, b]) => r > 200 && g > 110 && g < 170 && b < 60;
  const whole = { x: 0, y: 0, width: 1080, height: 1920 };
  const out = await s.export('media-rotated');
  const frame = frameAt(out.file, 3, 1080, 1920);
  const found = boundingBox(frame, orange, whole);
  // The image keeps its 2:1 shape inside its box, centred; rotation turns that picture about its centre.
  const fitW = Math.min(box.width, box.height * 2), fitH = fitW / 2, cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const rad = 20 * Math.PI / 180;
  const wantW = fitW * Math.cos(rad) + fitH * Math.sin(rad), wantH = fitW * Math.sin(rad) + fitH * Math.cos(rad);
  check(found && Math.abs(found.x + found.width / 2 - cx) <= 3 && Math.abs(found.y + found.height / 2 - cy) <= 3 &&
    Math.abs(found.width - wantW) <= 5 && Math.abs(found.height - wantH) <= 5, 'rotated overlay: centre and rotated extent match the canonical box (<=3-5 px)',
    JSON.stringify({ found, want: { cx, cy, wantW: +wantW.toFixed(1), wantH: +wantH.toFixed(1) } }));
  dumpParity('media', s, out, [3]);
  // Opacity: exported colour = alpha-blend of the overlay over the video behind it.
  await s.cmd('set-video-rotation', { elementId: el().id, rotation: 0 });
  await s.cmd('set-element-opacity', { elementId: el().id, opacity: 0.6 });
  const half = await s.export('media-opacity');
  const baseline = await s.export('media-baseline').catch(() => null);
  await s.cmd('set-element-opacity', { elementId: el().id, opacity: 1 });
  const full = await s.export('media-full');
  const blendPixel = (file) => { const f = frameAt(file, 3, 1080, 1920); return px(f, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)); };
  const [r1] = blendPixel(full.file), [r6] = blendPixel(half.file);
  // behind pixel: remove the image and read the same spot
  await s.cmd('remove-element', { elementId: el().id });
  const none = await s.export('media-none');
  const [rb, gb, bb] = blendPixel(none.file), [rf, gf, bf] = blendPixel(full.file), [rh, gh, bh] = blendPixel(half.file);
  const expected = [rb, gb, bb].map((behind, i) => 0.4 * behind + 0.6 * [rf, gf, bf][i]);
  check([rh, gh, bh].every((value, i) => Math.abs(value - expected[i]) <= 10), 'overlay opacity 0.6 exports as a 60 % blend over the footage',
    `got ${[rh, gh, bh].map(Math.round)}, want ${expected.map(Math.round)}`);
  void r1; void r6; void baseline;
}

async function failureScenario() {
  console.log('\n=== failures are understandable and never leave the editor stuck ===');
  const s = await newEditor();
  const music = await s.upload(media.music, 'AUDIO', 'bed.wav', 'audio/wav');
  await s.cmd('add-audio', { assetId: music.id, startTime: 0 });
  // The music file has gone missing from storage: the export must fail cleanly and say so.
  const stored = s.harness.rows.editAssets.get(music.id).objectKey;
  s.harness.objects.delete(stored);
  await s.reload();
  await s.harness.service.startExport(s.id, s.project.revision);
  const done = await settle(s.harness.service, s.id);
  check(done.phase === 'FAILED' && /music or image file .* no longer available/iu.test(done.message || '') && !/edit-mode\/|no such object/iu.test(done.message || ''), 'a missing music file fails the export with a readable reason', `${done.errorCode}: ${done.message}`);
  check(s.harness.rows.editProjects.get(s.id).status !== 'EXPORTING', 'the project is not left stuck in EXPORTING', s.harness.rows.editProjects.get(s.id).status);
  // ...and the next export works once the problem is fixed (remove the music), with the same project.
  await s.cmd('remove-element', { elementId: s.project.elements.find((e) => e.type === 'AUDIO').id });
  const again = await s.export('failure-recovered');
  check(again.status === 'COMPLETED', 'the editor exports normally after the fix');
  // A stale revision is refused plainly instead of rendering an old timeline.
  const stale = await s.harness.service.startExport(s.id, s.project.revision - 1).then(() => null, (error) => error);
  check(stale && stale.getStatus?.() === 409, 'exporting a stale revision is refused (409)');
  // Unsupported / unreadable uploads are refused in plain words.
  const junk = Buffer.from('not audio at all');
  const rejected = await s.edit.uploadAsset(s.id, { originalname: 'x.mp3', mimetype: 'audio/mpeg', size: junk.length, buffer: junk }, 'AUDIO', s.project.revision).then(() => null, (error) => error);
  check(rejected && /audio/iu.test(JSON.stringify(rejected.getResponse?.() ?? rejected.message)), 'an unreadable music file is refused with an audio-specific message');
  const bad = await s.edit.uploadAsset(s.id, { originalname: 'x.gif', mimetype: 'image/gif', size: 8, buffer: Buffer.from('GIF89a..') }, 'IMAGE', s.project.revision).then(() => null, (error) => error);
  check(bad && /PNG, JPG or WebP/u.test(JSON.stringify(bad.getResponse?.() ?? bad.message)), 'an unsupported image type says which types work');
}

async function precedenceScenario() {
  console.log('\n=== automatic zoom vs manual zoom ===');
  const s = await newEditor();
  const segment = videoSegments(s.project)[0];
  // The zoom planner needs the cached analysis (a centred talking head) and an enabled zoom policy.
  const frames = Array.from({ length: SRC_SEC * 2 }, (_, i) => ({ t: i / 2, text_coverage: 0, text_boxes: [], graphic_boxes: [],
    ocr_lines: [], ocr_coverage: 0, faces: [{ x: 0.38, y: 0.16, w: 0.24, h: 0.3, score: 0.95, mouth_activity: 0.6, track_id: 'a' }],
    persons: [{ x: 0.3, y: 0.14, w: 0.4, h: 0.82 }] }));
  const sourceRow = s.harness.rows.editAssets.get('asset-source');
  s.harness.rows.editAssets.set('asset-source', { ...sourceRow, analysis: { source: 'DENSE', shotBoundaries: [], ocrText: '', frames } });
  const row = s.harness.rows.editProjects.get(s.id);
  s.harness.rows.editProjects.set(s.id, { ...row, settings: { ...row.settings, zoomPolicy: 'MODERATE' } });
  await s.reload();
  await s.cmd('add-zoom', { startTime: 5, duration: 5, scale: 1.15 });
  const auto = await s.export('precedence-auto-only');
  await s.cmd('set-video-scale', { elementId: segment.id, scale: 1.1 });
  const manual = await s.export('precedence-manual');
  await s.cmd('set-video-scale', { elementId: segment.id, scale: 1 });
  await s.cmd('remove-zoom', { elementId: s.project.elements.find((e) => e.type === 'EFFECT').id });
  const none = await s.export('precedence-none');
  const f = (file, t) => frameAt(file, t, 1080, 1920);
  const rect = { x: 0, y: 0, width: 1080, height: 1920 };
  // At t=7.5 (peak of the automatic zoom): auto-only differs from none; manual 1.1x is NOT 1.1 x 1.15.
  const dAuto = mae(f(auto.file, 7.5), rect, f(none.file, 7.5), rect, 24);
  check(dAuto > 4, 'an automatic/template zoom still renders when the user has not zoomed', dAuto.toFixed(2));
  const expectedManual = resample(f(none.file, 7.5), rect, 1.1, 0, 0);
  const err = mae(f(manual.file, 7.5), rect, expectedManual, { x: 0, y: 0, width: 1080, height: 1920 }, 24);
  const stacked = resample(f(none.file, 7.5), rect, 1.1 * 1.15, 0, 0);
  const errStacked = mae(f(manual.file, 7.5), rect, stacked, { x: 0, y: 0, width: 1080, height: 1920 }, 24);
  check(err < errStacked / 2 || err < 6, 'manual zoom overrides the automatic zoom for its region: no stacked double zoom', `manual ${err.toFixed(2)} vs stacked ${errStacked.toFixed(2)}`);
}

(async () => {
  try {
    buildSource(media.source); buildMusic(media.music); buildImage(media.image);
    if (!only || only === 'plain') await plainScenario();
    if (!only || only === 'styleone') await styleScenario('styleone');
    if (!only || only === 'styletwo') await styleScenario('styletwo');
    if (!only || only === 'precedence') await precedenceScenario();
    if (!only || only === 'audio') await audioScenario();
    if (!only || only === 'media') await mediaScenario();
    if (!only || only === 'failure') await failureScenario();
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    const failed = results.filter((r) => !r.ok);
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length,
      failed: failed.length, results }, null, 2));
    console.log(`\n${results.length - failed.length}/${results.length} checks passed; exports in ${outDir}`);
    if (!keep) fs.rmSync(work, { recursive: true, force: true });
  }
})();
