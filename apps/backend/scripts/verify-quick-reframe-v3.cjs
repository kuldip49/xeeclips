/**
 * Quick Reframe V3 live acceptance: a fully manual crop first (no AI before Done Cropping), then StyleOne
 * or Manual, then one export. Runs against the live stack over HTTP like the browser and inspects the real
 * files: exact crop geometry and pixels vs the original, every aspect ratio, persistence (optionally across
 * a backend restart), no double crop, preview/export parity, black StyleOne canvas, captions, colour, audio.
 *
 *   node scripts/verify-quick-reframe-v3.cjs --plain <owned.mp4> --captioned <owned-with-subtitles.mp4> [--openai] [--restart]
 *
 * --restart runs `docker restart ai-content-backend` mid-run to prove the crop survives it.
 * Every session it creates is deleted at the end (KEEP=1 keeps them for browser checks).
 */
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const exec = promisify(execFile);
const base = process.env.API_BASE || 'http://127.0.0.1:4000';
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const created = [];
const log = (...m) => console.log('  ', ...m);
async function http(path, method = 'GET', body) {
  const r = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${typeof data === 'object' ? data.message : data}`);
  return data;
}
const qr = (path, method, body) => http('/quick-reframe' + path, method, body);
const command = (s, action, body = {}) => http(`/edit-mode/projects/${s.editProjectId}/commands/${action}`, 'POST', { revision: s.revision, ...body });
const ACTIVE = ['PLAYBACK', 'ANALYZE', 'PREPARE', 'PREVIEW', 'EXPORT', 'IMPORT'];
async function wait(id, ms = 900000) {
  const started = Date.now();
  for (;;) {
    const s = await qr('/' + id);
    if (s.status === 'FAILED') throw new Error(`Job failed: ${s.error}`);
    if (!ACTIVE.includes(s.status)) return s;
    if (Date.now() - started > ms) throw new Error('Timed out waiting for ' + s.status);
    await new Promise((r) => setTimeout(r, 1500));
  }
}
async function upload(path, name) {
  const file = await readFile(path); const s = await qr('', 'POST'); created.push(s.id);
  const u = await qr(`/${s.id}/upload`, 'POST', { name, size: file.length, mimeType: 'video/mp4' });
  for (let i = 0; i < u.chunks; i++) {
    const r = await fetch(`${base}/quick-reframe/uploads/${u.id}/chunks/${i}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file.subarray(i * u.chunkBytes, (i + 1) * u.chunkBytes) });
    assert.equal(r.status, 200);
  }
  return qr(`/uploads/${u.id}/complete`, 'POST');
}
async function download(url, path) { const r = await fetch(base + url); assert.equal(r.status, 200, `download ${url}`); await writeFile(path, Buffer.from(await r.arrayBuffer())); return path; }
async function probe(path) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', path]);
  const j = JSON.parse(stdout); const v = j.streams.find((s) => s.codec_type === 'video'); const a = j.streams.find((s) => s.codec_type === 'audio');
  return { width: v.width, height: v.height, video: v.codec_name, audio: a?.codec_name ?? null, duration: Number(j.format.duration) };
}
/** Raw RGB of one frame after a filter chain. */
async function frame(path, t, vf) {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', path, '-frames:v', '1', '-vf', `${vf},format=rgb24`, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
async function region(path, t, x, y, w, h, scale) {
  const px = await frame(path, t, `${scale ? `scale=${scale},` : ''}crop=${w}:${h}:${x}:${y}`);
  let r = 0, g = 0, b = 0, bright = 0, white = 0; const n = px.length / 3;
  for (let i = 0; i < px.length; i += 3) { r += px[i]; g += px[i + 1]; b += px[i + 2];
    const l = (px[i] + px[i + 1] + px[i + 2]) / 3; if (l > 40) bright++; if (px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200) white++; }
  return { r: r / n, g: g / n, b: b / n, luma: (r + g + b) / 3 / n, bright: bright / n, white, pixels: px };
}
const mae = (a, b) => { assert.equal(a.length, b.length, 'same frame size'); let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
async function pcm(path) { const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const out = new Float64Array(stdout.length / 2); for (let i = 0; i < out.length; i++) out[i] = stdout.readInt16LE(i * 2); return out; }
function aligned(a, b) { let best = { r: -1, lagMs: 0 };
  for (let lag = -2400; lag <= 2400; lag += 8) { const r = lag >= 0 ? correlation(a.subarray(lag), b) : correlation(a, b.subarray(-lag)); if (r > best.r) best = { r, lagMs: lag / 8 }; }
  for (let lag = best.lagMs * 8 - 8; lag <= best.lagMs * 8 + 8; lag++) { const r = lag >= 0 ? correlation(a.subarray(lag), b) : correlation(a, b.subarray(-lag)); if (r > best.r) best = { r, lagMs: lag / 8 }; }
  return best; }
function correlation(a, b) { const n = Math.min(a.length, b.length); let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let num = 0, da = 0, db = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; } return num / Math.sqrt(da * db); }
const project = (s) => http(`/edit-mode/projects/${s.editProjectId}`);
/** FRAMES_DIR=<dir> keeps PNG frames of the real outputs for visual review. */
async function keepFrame(file, t, name) { if (!process.env.FRAMES_DIR) return; await exec('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', join(process.env.FRAMES_DIR, name)]); }
const sameBox = (a, b, label) => { for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(a[k] - b[k]) < 1e-6, `${label}: ${k} ${a[k]} vs ${b[k]}`); };
const even = (n) => Math.floor(n / 2) * 2;
/** The exact source rectangle the bake cuts for a normalized crop (the same flooring as quickCleanRender). */
const pixels = (s, c) => { const w = Math.max(2, even(s.width * c.w)), h = Math.max(2, even(s.height * c.h));
  return { w, h, x: Math.min(s.width - w, even(s.width * c.x)), y: Math.min(s.height - h, even(s.height * c.y)) }; };

/** Upload -> deterministic playback prep -> whole-frame draft. Asserts that no AI ran or can run yet. */
async function open(file, name) {
  let s = await upload(file, name);
  assert.equal(s.plan, null); assert.equal(s.analysis, null);
  await qr(`/${s.id}/playback`, 'POST'); s = await wait(s.id);
  assert.equal(s.status, 'CROPPING'); sameBox(s.plan.crop, { x: 0, y: 0, w: 1, h: 1 }, 'first draft is the whole frame');
  assert.equal(s.plan.aspect, 'SOURCE'); assert.equal(s.plan.tracking, undefined);
  assert.equal(s.analysis, null, 'no detection before cropping'); assert.equal(s.hasTranscript, false, 'no transcription before cropping');
  await assert.rejects(() => qr(`/${s.id}/analyze`, 'POST', {}), /Confirm the crop/);
  await assert.rejects(() => qr(`/${s.id}/styleone`, 'POST', { revision: s.revision }), /Confirm the crop/);
  await assert.rejects(() => qr(`/${s.id}/hooks`, 'POST', { externalAiAuthorized: false }), /Check the video first/);
  await assert.rejects(() => qr(`/${s.id}/suggest`, 'POST', { aspect: '9:16' }), /404|Cannot POST/);
  return s;
}
/** Save a draft exactly, confirm it, and check the baked SOURCE is that exact rectangle of the original. */
async function crop(s, c, aspect, originalFile, label, pixelCheck = true) {
  s = await qr(`/${s.id}/plan`, 'PUT', { revision: s.revision, plan: { ...s.plan, aspect, crop: c } });
  sameBox(s.plan.crop, c, `${label}: saved draft`); assert.equal(s.plan.aspect, aspect);
  sameBox((await qr('/' + s.id)).plan.crop, c, `${label}: draft after refresh`);
  await qr(`/${s.id}/confirm-crop`, 'POST', { revision: s.revision }); s = await wait(s.id);
  assert.equal(s.cropConfirmed, true); sameBox(s.confirmed.crop, c, `${label}: confirmed exactly`);
  const r = pixels(s, c); const full = c.x < 1e-4 && c.y < 1e-4 && c.w > .9999 && c.h > .9999;
  assert.deepEqual([s.sourceWidth, s.sourceHeight], full ? [s.width, s.height] : [r.w, r.h], `${label}: baked ${s.sourceWidth}x${s.sourceHeight}`);
  let detail = `${r.w}x${r.h} at ${r.x},${r.y}`;
  if (pixelCheck && !full) {
    const src = await download(s.sourceUrl, join(dir, `${s.id}-${label.replace(/\W+/g, '-')}.mp4`)); const sp = await probe(src);
    assert.deepEqual([sp.width, sp.height], [r.w, r.h]); assert.ok(Math.abs(sp.duration - s.duration) < 0.1, `${label}: full duration`);
    const errors = [], shifted = [];
    for (const t of [0.6, s.duration / 2, s.duration - 1]) {
      const baked = await frame(src, t, 'null');
      errors.push(mae(baked, await frame(originalFile, t, `crop=${r.w}:${r.h}:${r.x}:${r.y}`)));
      const sx = Math.min(s.width - r.w, r.x + 24) === r.x ? Math.max(0, r.x - 24) : Math.min(s.width - r.w, r.x + 24);
      const sy = Math.min(s.height - r.h, r.y + 24) === r.y ? Math.max(0, r.y - 24) : Math.min(s.height - r.h, r.y + 24);
      shifted.push(mae(baked, await frame(originalFile, t, `crop=${r.w}:${r.h}:${sx}:${sy}`)));
    }
    assert.ok(errors.every((e) => e < 3), `${label}: pixels match the chosen rectangle (${errors.map((e) => e.toFixed(2))})`);
    assert.ok(Math.max(...errors) < Math.min(...shifted), `${label}: a 24 px shift is measurably different`);
    detail += `, MAE ${Math.max(...errors).toFixed(2)} (24 px shift ${Math.min(...shifted).toFixed(2)}) at start/middle/end`;
  }
  log(`${label}: ${aspect} -> ${detail}`);
  return { s, detail };
}
let dir;

async function main() {
  const plain = arg('plain'), captioned = arg('captioned');
  assert.ok(plain && captioned, 'Pass --plain and --captioned owned test videos');
  dir = await mkdtemp(join(tmpdir(), 'quick-reframe-v3-'));
  const results = [];
  try {
    // ---------------- Geometry: every shape, every edge, exact pixels, persistence ------------------------
    console.log('Geometry: free / presets / custom / each edge -> exact baked rectangles');
    let s = await open(plain, 'v3-geometry.mp4');
    const W = s.width, H = s.height;
    const cases = [
      ['Free crop (cuts headline, handle and captions)', { x: .137, y: .271, w: .611, h: .389 }, 'CUSTOM'],
      ['9:16', { x: .25, y: .2, w: .5, h: (.5 * W * 16 / 9) / H }, '9:16'],
      ['16:9', { x: 0, y: .33, w: 1, h: (W * 9 / 16) / H }, '16:9'],
      ['1:1', { x: .1, y: .3, w: .6, h: .6 * W / H }, '1:1'],
      ['4:5', { x: .2, y: .25, w: .5, h: (.5 * W * 5 / 4) / H }, '4:5'],
      ['Custom 7:5', { x: .15, y: .4, w: .7, h: (.7 * W * 5 / 7) / H }, '7:5'],
      ['Crop from top', { x: 0, y: .2, w: 1, h: .8 }, 'CUSTOM'],
      ['Crop from bottom', { x: 0, y: 0, w: 1, h: .75 }, 'CUSTOM'],
      ['Crop from left', { x: .3, y: 0, w: .7, h: 1 }, 'CUSTOM'],
      ['Crop from right', { x: 0, y: 0, w: .65, h: 1 }, 'CUSTOM'],
      ['Smallest (16 x 16 px)', { x: .5, y: .5, w: 16 / W, h: 16 / H }, 'CUSTOM']
    ];
    for (const [label, c, aspect] of cases) {
      const ratio = aspect.includes(':') ? aspect.split(':').map(Number) : null;
      if (ratio) assert.ok(Math.abs((c.w * W) / (c.h * H) - ratio[0] / ratio[1]) < 1e-9, `${label} test box has its ratio`);
      const r = await crop(s, c, aspect, plain, label, !label.startsWith('Smallest'));
      s = r.s; results.push(`${label}: ${r.detail}`);
    }
    // A crop below the technical minimum is refused; nothing else is.
    await assert.rejects(() => qr(`/${s.id}/plan`, 'PUT', { revision: s.revision, plan: { ...s.plan, crop: { x: 0, y: 0, w: 10 / W, h: .5 } } }), /at least 16/);
    // Grid is display-only: changing it keeps the confirmed crop.
    const confirmedKey = s.confirmed.crop;
    s = await qr(`/${s.id}/plan`, 'PUT', { revision: s.revision, plan: { ...s.plan, grid: 'GOLDEN' } });
    assert.equal(s.plan.grid, 'GOLDEN'); assert.equal(s.cropConfirmed, true, 'a grid change is not a crop change'); sameBox(s.plan.crop, confirmedKey, 'grid change keeps the crop');
    results.push('Grid change (Golden ratio): crop and confirmation unchanged; 10 px crop refused (technical minimum 16 px)');
    assert.equal(s.analysis, null, 'still no AI after many crops');

    // ---------------- StyleOne ---------------------------------------------------------------------------
    console.log('StyleOne: Free crop -> Done Cropping -> StyleOne (AI starts now) -> preview -> export');
    s = await open(plain, 'v3-styleone.mp4');
    const freeCrop = { x: .137, y: .271, w: .611, h: .389 };
    ({ s } = await crop(s, freeCrop, 'CUSTOM', plain, 'StyleOne free crop'));
    assert.equal(s.analysis, null, 'AI has not run after Done Cropping');
    s = await qr(`/${s.id}/styleone`, 'POST', { revision: s.revision });
    assert.equal(s.status, 'ANALYZE', 'choosing StyleOne starts the local analysis'); s = await wait(s.id);
    assert.ok(s.analysis, 'analysis exists only after choosing a mode'); assert.equal(s.editPath, 'STYLEONE'); assert.equal(s.styleOneApplied, true);
    sameBox(s.confirmed.crop, freeCrop, 'StyleOne kept the user crop'); assert.equal(s.cropConfirmed, true);
    let p = await project(s);
    assert.ok(p.elements.filter((e) => e.type === 'VIDEO').every((e) => e.properties.frameLayout === 'FIT'), 'whole crop fitted, no second crop');
    const hook = p.elements.find((e) => e.type === 'TEXT' && e.properties.fontFamily?.includes('Garamond')); assert.ok(hook, 'StyleOne serif hook');
    const captionCount = p.elements.filter((e) => e.type === 'SUBTITLE').length;
    log(`StyleOne hook: "${hook.properties.content}", captions ${captionCount}, subtitleState(crop)=${s.analysis.subtitleState}`);
    const previewFile = await download(s.previewUrl, join(dir, 'a-preview.mp4')); const pv = await probe(previewFile);
    assert.deepEqual([pv.width, pv.height], [540, 960]);
    await qr(`/${s.id}/export`, 'POST', { revision: s.revision, resolution: 1080 }); s = await wait(s.id);
    const exportA = await download(`${s.exports[0].url}?download=1`, join(dir, 'a-export.mp4')); const ea = await probe(exportA);
    assert.deepEqual([ea.width, ea.height, ea.video, ea.audio], [1080, 1920, 'h264', 'aac']); assert.ok(Math.abs(ea.duration - s.duration) < 0.25, `full duration ${ea.duration}`);
    for (const t of [1, s.duration / 2, s.duration - 1]) {
      assert.ok((await region(exportA, t, 0, 0, 1080, 300)).luma < 3, `black canvas top at ${t}s`);
      assert.ok((await region(exportA, t, 0, 1460, 1080, 460)).luma < 3, `black canvas bottom at ${t}s`);
    }
    assert.ok((await region(exportA, 2, 0, 470, 1080, 124)).white > 200, 'hook drawn above the media window');
    // No double crop: the window shows the whole baked crop, FIT inside 1080x700 (black bars beside it).
    const srcA = await download(s.sourceUrl, join(dir, 'a-source.mp4')); const sa = await probe(srcA);
    const aspectA = sa.width / sa.height, fw = aspectA > 1080 / 700 ? 1080 : Math.round(700 * aspectA / 2) * 2, fh = aspectA > 1080 / 700 ? Math.round(1080 / aspectA / 2) * 2 : 700;
    const fx = Math.round((1080 - fw) / 2), fy = 610 + Math.round((700 - fh) / 2);
    const windowErrors = [];
    for (const t of [0.6, s.duration / 2, s.duration - 1.2]) {
      // Captions sit in the lower half of the window; compare the upper 45% of the fitted picture.
      const out = await region(exportA, t, fx + 6, fy + 6, fw - 12, Math.round(fh * 0.45));
      const ref = await region(srcA, t, 6, 6, fw - 12, Math.round(fh * 0.45), `${fw}:${fh}`);
      windowErrors.push(mae(out.pixels, ref.pixels));
    }
    assert.ok(windowErrors.every((e) => e < 12), `window = confirmed crop (${windowErrors.map((e) => e.toFixed(2))})`);
    if (fx > 8) assert.ok((await region(exportA, 3, 0, 640, fx - 4, 640)).luma < 3, 'FIT pillarbox beside the narrower crop is black');
    // Preview/export framing parity: the 540x960 preview equals the export scaled down.
    const parity = [];
    for (const t of [1.5, s.duration / 2]) parity.push(mae(await frame(previewFile, t, 'null'), await frame(exportA, t, 'scale=540:960:flags=area')));
    assert.ok(parity.every((e) => e < 10), `preview/export parity (${parity.map((e) => e.toFixed(2))})`);
    const alignA = aligned(await pcm(plain), await pcm(exportA));
    assert.ok(alignA.r > 0.98 && Math.abs(alignA.lagMs) <= 50, `original audio preserved (${alignA.r})`);
    await keepFrame(plain, 6, 'styleone-original.png'); await keepFrame(srcA, 6, 'styleone-cropped-source.png'); await keepFrame(exportA, 6, 'styleone-export.png');
    const history = await qr('/history'); assert.ok(history.some((h) => h.id === s.id && h.editPath === 'STYLEONE'), 'History');
    results.push(`StyleOne: free crop ${sa.width}x${sa.height} kept exactly; 1080x1920 h264/aac ${ea.duration.toFixed(2)}s; window MAE ${Math.max(...windowErrors).toFixed(2)} (whole crop, FIT, no 2nd crop); preview/export MAE ${Math.max(...parity).toFixed(2)}; audio r=${alignA.r.toFixed(4)} lag ${alignA.lagMs} ms; ${captionCount} captions; History OK`);

    // ---------------- Manual -----------------------------------------------------------------------------
    console.log('Manual: 4:5 crop -> Done Cropping -> Manual (AI starts now) -> hook + captions + filter -> export');
    let m = await open(plain, 'v3-manual.mp4');
    const crop45 = { x: .2, y: .25, w: .5, h: (.5 * W * 5 / 4) / H };
    ({ s: m } = await crop(m, crop45, '4:5', plain, 'Manual 4:5 crop', false));
    m = await qr(`/${m.id}/path`, 'POST', { revision: m.revision, path: 'MANUAL' });
    assert.equal(m.editPath, 'MANUAL'); assert.equal(m.styleOneApplied, false); assert.equal(m.status, 'ANALYZE', 'Manual starts the local analysis');
    m = await wait(m.id); assert.ok(m.analysis && m.hasTranscript);
    p = await project(m);
    assert.equal(p.settings.resolvedVisualLayout ?? null, null, 'Manual has no StyleOne styling');
    assert.ok(!p.elements.some((e) => e.type === 'TEXT' || e.type === 'SUBTITLE'), 'Manual opens with no automatic creative elements');
    const openai = process.argv.includes('--openai');
    const suggested = await qr(`/${m.id}/hooks`, 'POST', { externalAiAuthorized: openai }); m = suggested.session;
    assert.ok(m.hooks.length >= 3); const chosen = m.hooks.find((h) => h.recommended);
    log(`${openai ? 'OpenAI' : 'local'} hooks:`, m.hooks.map((h) => `${h.category}${h.recommended ? '*' : ''}[${h.source}]`).join(' '), '->', chosen.text);
    p = await command(m, 'add-text', { textStyleId: 'HOOK', content: chosen.text, origin: 'ASSISTANT', presetRole: 'HOOK', fontSize: 40, height: 0.16 }); m = { ...m, revision: p.revision };
    const manualHook = p.elements.find((e) => e.type === 'TEXT');
    p = await command(m, 'move-element', { elementId: manualHook.id, x: manualHook.properties.x, y: 0.04 }); m = { ...m, revision: p.revision };
    p = await command(m, 'generate-captions'); m = { ...m, revision: p.revision };
    const captionsM = p.elements.filter((e) => e.type === 'SUBTITLE').length; assert.ok(captionsM > 3, 'captions generated');
    const video = p.elements.find((e) => e.type === 'VIDEO');
    p = await command(m, 'apply-color-filter', { elementId: video.id, filterId: 'WARM' }); m = { ...m, revision: p.revision };
    m = await qr('/' + m.id); sameBox(m.confirmed.crop, crop45, 'manual edits never touch the crop');
    await qr(`/${m.id}/export`, 'POST', { revision: m.revision, resolution: 1080 }); m = await wait(m.id);
    const exportB = await download(`${m.exports[0].url}?download=1`, join(dir, 'b-export.mp4')); const eb = await probe(exportB);
    const rb = pixels(m, crop45);
    assert.equal(Math.min(eb.width, eb.height), 1080); assert.ok(Math.abs(eb.width / eb.height - 4 / 5) < 0.01, `4:5 export (${eb.width}x${eb.height})`);
    assert.deepEqual([eb.video, eb.audio], ['h264', 'aac']); assert.ok(Math.abs(eb.duration - m.duration) < 0.25);
    // No double crop: the export's middle band is the crop itself (scaled), only warmer.
    const srcB = await download(m.sourceUrl, join(dir, 'b-source.mp4'));
    const band = async (file, w, h, t) => region(file, t, 0, Math.round(h * 0.3), w, Math.round(h * 0.25), `${eb.width}:${eb.height}`);
    const ref = await band(srcB, eb.width, eb.height, 6), out = await band(exportB, eb.width, eb.height, 6);
    const lumaDiff = Math.abs(out.luma - ref.luma), warm = (out.r - out.b) - (ref.r - ref.b);
    log(`manual band: source rgb(${ref.r.toFixed(0)},${ref.g.toFixed(0)},${ref.b.toFixed(0)}) export rgb(${out.r.toFixed(0)},${out.g.toFixed(0)},${out.b.toFixed(0)})`);
    assert.ok(warm > 4 && lumaDiff < 30, `WARM applied to the same framing (warm ${warm.toFixed(1)})`);
    assert.ok((await region(exportB, 2, 0, 0, eb.width, Math.round(eb.height * 0.25))).white > 100, 'hook near the top');
    await keepFrame(exportB, 6, 'manual-export.png');
    const alignB = aligned(await pcm(plain), await pcm(exportB)); assert.ok(alignB.r > 0.98 && Math.abs(alignB.lagMs) <= 50, 'audio preserved');
    results.push(`Manual: 4:5 crop ${rb.w}x${rb.h}; ${openai ? 'OpenAI' : 'local'} hook + ${captionsM} captions + WARM; export ${eb.width}x${eb.height} h264/aac ${eb.duration.toFixed(2)}s; audio r=${alignB.r.toFixed(4)}`);

    // Return to Crop, change it: every later edit is kept, the next export has the new shape.
    const before = await project(m); const sourceBefore = before.assets.find((x) => x.role === 'SOURCE');
    const crop169 = { x: 0, y: .3, w: 1, h: (W * 9 / 16) / H };
    ({ s: m } = await crop(m, crop169, '16:9', plain, 'Manual re-crop to 16:9', false));
    const after = await project(m); assert.equal(after.assets.find((x) => x.role === 'SOURCE').id, sourceBefore.id);
    assert.deepEqual(after.elements.map((e) => e.id).sort(), before.elements.map((e) => e.id).sort(), 'no edit lost on re-crop');
    assert.equal(after.elements.find((e) => e.id === manualHook.id).properties.content, chosen.text);
    assert.equal(m.exports[0].current, false, 'previous export marked stale');
    await qr(`/${m.id}/export`, 'POST', { revision: m.revision, resolution: 720 }); m = await wait(m.id);
    const exportC = await download(`${m.exports[0].url}?download=1`, join(dir, 'c-export.mp4')); const ec = await probe(exportC);
    assert.equal(ec.height, 720); assert.ok(Math.abs(ec.width / ec.height - 16 / 9) < 0.01, `16:9 at 720p (${ec.width}x${ec.height}; the 405 px crop height is floored to even 404)`);
    results.push(`Re-crop after Manual edits: same SOURCE and ${after.elements.length} elements kept, re-exported ${ec.width}x${ec.height}`);

    // ---------------- Persistence across a backend restart ------------------------------------------------
    if (process.argv.includes('--restart')) {
      console.log('Restarting the backend container…');
      await exec('docker', ['restart', 'ai-content-backend']);
      for (let i = 0; i < 80; i++) { try { const r = await fetch(base + '/health'); if (r.ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 3000)); }
      await new Promise((r) => setTimeout(r, 4000));
      const again = await qr('/' + m.id); sameBox(again.confirmed.crop, crop169, 'crop after restart'); sameBox(again.plan.crop, crop169, 'draft after restart');
      assert.equal(again.cropConfirmed, true); assert.equal(again.editPath, 'MANUAL'); assert.equal(again.plan.aspect, '16:9');
      const geo = await qr('/' + s.id); sameBox(geo.confirmed.crop, freeCrop, 'StyleOne crop after restart');
      const file = await fetch(`${base}${again.exports[0].url}`, { headers: { Range: 'bytes=0-99' } }); assert.equal(file.status, 206);
      results.push('Backend restart: confirmed crops, ratios, paths and exports all intact');
    }

    // ---------------- Existing captions follow the user's crop ------------------------------------------
    console.log('Captions: keep the burned-in captions vs crop them away');
    let d = await open(captioned, 'v3-captions-kept.mp4');
    ({ s: d } = await crop(d, { x: 0, y: .3, w: 1, h: .45 }, 'CUSTOM', captioned, 'Crop keeping captions', false));
    d = await qr(`/${d.id}/styleone`, 'POST', { revision: d.revision }); d = await wait(d.id);
    assert.equal(d.analysis.subtitleState, 'EXISTING_READABLE'); p = await project(d);
    assert.equal(p.elements.filter((e) => e.type === 'SUBTITLE').length, 0, 'no duplicate captions');
    let e = await open(captioned, 'v3-captions-cropped.mp4');
    ({ s: e } = await crop(e, { x: 0, y: .3, w: 1, h: .35 }, 'CUSTOM', captioned, 'Crop removing captions', false));
    e = await qr(`/${e.id}/styleone`, 'POST', { revision: e.revision }); e = await wait(e.id);
    assert.equal(e.analysis.subtitleState, 'MISSING', 'captions cropped away are no longer there'); p = await project(e);
    const generated = p.elements.filter((x) => x.type === 'SUBTITLE').length; assert.ok(generated > 3, 'StyleOne adds captions');
    sameBox(e.confirmed.crop, { x: 0, y: .3, w: 1, h: .35 }, 'crop that removed captions/handle was kept');
    results.push(`Captions follow the crop: kept in crop -> EXISTING_READABLE, 0 added; cropped out -> MISSING, ${generated} generated`);

    console.log('\nPASS');
    for (const r of results) console.log(' -', r);
  } finally {
    if (process.env.KEEP !== '1') for (const id of created) {
      const s = await qr('/' + id).catch(() => null);
      await qr('/' + id, 'DELETE').catch(() => undefined);
      if (s?.sourceUrl) { const r = await fetch(base + s.sourceUrl); assert.equal(r.status, 404, 'deleted media is gone'); }
    }
    else console.log('Kept sessions:', created.join(' '));
    await rm(dir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
