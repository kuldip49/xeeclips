/**
 * Quick Reframe V2 live acceptance: crop first -> StyleOne or Manual -> one export, against the running
 * stack (HTTP only, like the browser), with the real outputs inspected: codecs, geometry, black canvas,
 * media-window parity with the confirmed crop, hook/caption pixels, colour change and audio correlation.
 *
 *   node scripts/verify-quick-reframe-v2.cjs --plain <owned.mp4> --captioned <owned-with-subtitles.mp4> [--openai]
 *
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
async function wait(id, ms = 900000) {
  const started = Date.now();
  for (;;) {
    const s = await qr('/' + id);
    if (s.status === 'FAILED') throw new Error(`Job failed: ${s.error}`);
    if (!['ANALYZE', 'PREPARE', 'PREVIEW', 'EXPORT', 'IMPORT'].includes(s.status)) return s;
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
/** Mean RGB of a region of one frame (raw pixels via FFmpeg). */
async function region(path, t, x, y, w, h, scale) {
  const vf = `${scale ? `scale=${scale},` : ''}crop=${w}:${h}:${x}:${y},format=rgb24`;
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', path, '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  let r = 0, g = 0, b = 0, bright = 0, white = 0; const n = stdout.length / 3;
  for (let i = 0; i < stdout.length; i += 3) { r += stdout[i]; g += stdout[i + 1]; b += stdout[i + 2];
    const l = (stdout[i] + stdout[i + 1] + stdout[i + 2]) / 3; if (l > 40) bright++; if (stdout[i] > 200 && stdout[i + 1] > 200 && stdout[i + 2] > 200) white++; }
  return { r: r / n, g: g / n, b: b / n, luma: (r + g + b) / 3 / n, bright: bright / n, white, pixels: stdout };
}
async function frameRgb(path, t, width, height) {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', path, '-frames:v', '1', '-vf', `scale=${width}:${height}:flags=area,format=rgb24`, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
const mae = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
async function pcm(path) { const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const out = new Float64Array(stdout.length / 2); for (let i = 0; i < out.length; i++) out[i] = stdout.readInt16LE(i * 2); return out; }
/** Best Pearson correlation within +-300 ms, reporting the lag (AAC priming can shift a re-encode). */
function aligned(a, b) { let best = { r: -1, lagMs: 0 };
  for (let lag = -2400; lag <= 2400; lag += 8) { const r = lag >= 0 ? correlation(a.subarray(lag), b) : correlation(a, b.subarray(-lag)); if (r > best.r) best = { r, lagMs: lag / 8 }; }
  for (let lag = best.lagMs * 8 - 8; lag <= best.lagMs * 8 + 8; lag++) { const r = lag >= 0 ? correlation(a.subarray(lag), b) : correlation(a, b.subarray(-lag)); if (r > best.r) best = { r, lagMs: lag / 8 }; }
  return best; }
function correlation(a, b) { const n = Math.min(a.length, b.length); let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let num = 0, da = 0, db = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; } return num / Math.sqrt(da * db); }
const project = (s) => http(`/edit-mode/projects/${s.editProjectId}`);
/** JSONB normalizes float noise (0.21000000000000002 -> 0.21), so boxes compare within 1e-6. */
const sameBox = (a, b, label) => { for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(a[k] - b[k]) < 1e-6, `${label}: ${k} ${a[k]} vs ${b[k]}`); };

/** Upload, analyze, then crop: the suggestion, then a user tweak from the top and sides, then Done. */
async function cropFirst(file, name, tweak = true) {
  let s = await upload(file, name);
  assert.equal(s.cropConfirmed, false); assert.equal(s.editPath, null);
  await qr(`/${s.id}/analyze`, 'POST', { externalAiAuthorized: false }); s = await wait(s.id);
  assert.equal(s.status, 'ANALYZED'); assert.ok(s.plan, 'crop suggestion exists after analysis'); assert.equal(s.cropConfirmed, false);
  // No editing path or StyleOne render can start before the crop is confirmed.
  await assert.rejects(() => qr(`/${s.id}/styleone`, 'POST', { revision: s.revision }), /Confirm the crop/);
  await assert.rejects(() => qr(`/${s.id}/preview`, 'POST', { revision: s.revision }), /Confirm the crop/);
  const suggestion = s.plan.crop; log(`${name}: suggestion crop`, JSON.stringify(suggestion), `subtitles=${s.analysis.subtitleState}`, `regions=${s.analysis.regions.length}`);
  let crop = { ...suggestion };
  if (tweak) crop = { x: suggestion.x + 0.02, y: suggestion.y + 0.01, w: suggestion.w - 0.04, h: suggestion.h - 0.01 };
  s = await qr(`/${s.id}/plan`, 'PUT', { revision: s.revision, plan: { ...s.plan, aspect: 'CUSTOM', crop, tracking: undefined } });
  sameBox(s.plan.crop, crop, 'saved draft');
  // The draft survives a reload before Done.
  sameBox((await qr('/' + s.id)).plan.crop, crop, 'reloaded draft');
  await qr(`/${s.id}/confirm-crop`, 'POST', { revision: s.revision }); s = await wait(s.id);
  assert.equal(s.status, 'CROPPED'); assert.equal(s.cropConfirmed, true); sameBox(s.confirmed.crop, crop, 'confirmed crop');
  const p = await project(s);
  const source = p.assets.find((a) => a.role === 'SOURCE'), original = p.assets.find((a) => a.metadata?.quickReframeKind === 'ORIGINAL');
  assert.ok(original, 'the uploaded original is kept for re-cropping');
  assert.equal(original.width, s.width); assert.equal(source.duration, original.duration, 'timeline length unchanged');
  const expectW = Math.floor(s.width * crop.w / 2) * 2, expectH = Math.floor(s.height * crop.h / 2) * 2;
  assert.ok(Math.abs(source.width / source.height - expectW / expectH) < 0.02, `baked source has the crop shape (${source.width}x${source.height} vs ${expectW}x${expectH})`);
  log(`${name}: crop baked ${s.width}x${s.height} -> ${source.width}x${source.height}; original kept`);
  return { s, crop, original, source };
}

async function main() {
  const plain = arg('plain'), captioned = arg('captioned');
  assert.ok(plain && captioned, 'Pass --plain and --captioned owned test videos');
  const dir = await mkdtemp(join(tmpdir(), 'quick-reframe-v2-'));
  const results = [];
  try {
    // ---------------- Test A: StyleOne --------------------------------------------------------------
    console.log('Test A: Upload -> crop top/sides -> Done -> StyleOne -> preview -> export -> download -> History -> re-edit');
    let { s, crop } = await cropFirst(plain, 'test-a-styleone.mp4');
    const hooks = await qr(`/${s.id}/hooks`, 'POST', { externalAiAuthorized: false });
    s = hooks.session; assert.ok(s.hooks.length >= 3, `>=3 local hooks (${s.hooks.length})`); assert.equal(s.hooks.filter((h) => h.recommended).length, 1);
    log('local hooks:', s.hooks.map((h) => `${h.category}${h.recommended ? '*' : ''}: ${h.text}`).join(' | '));
    s = await qr(`/${s.id}/styleone`, 'POST', { revision: s.revision }); s = await wait(s.id);
    assert.equal(s.editPath, 'STYLEONE'); assert.equal(s.styleOneApplied, true); assert.equal(s.previewRevision, s.revision);
    let p = await project(s);
    assert.equal(p.settings.resolvedVisualLayout.editingProfile, 'AUTOMATIC_2');
    assert.ok(p.elements.filter((e) => e.type === 'VIDEO').every((e) => e.properties.frameLayout === 'FIT'), 'whole confirmed frame, no second crop');
    const captionCount = p.elements.filter((e) => e.type === 'SUBTITLE').length; assert.ok(captionCount > 3, 'captions generated for a captionless video');
    const hook = p.elements.find((e) => e.type === 'TEXT' && e.properties.fontFamily?.includes('Garamond'));
    assert.ok(hook, 'StyleOne serif hook'); assert.equal(hook.properties.content, s.hooks.find((h) => h.recommended).text);
    const previewFile = await download(s.previewUrl, join(dir, 'a-preview.mp4')); const pv = await probe(previewFile);
    assert.deepEqual([pv.width, pv.height], [540, 960]);
    await qr(`/${s.id}/export`, 'POST', { revision: s.revision, resolution: 1080 }); s = await wait(s.id);
    assert.equal(s.status, 'COMPLETE'); assert.ok(s.exports[0].current);
    const exportA = await download(`${s.exports[0].url}?download=1`, join(dir, 'a-export.mp4')); const ea = await probe(exportA);
    assert.deepEqual([ea.width, ea.height, ea.video, ea.audio], [1080, 1920, 'h264', 'aac']); assert.ok(Math.abs(ea.duration - s.duration) < 0.25, `full duration ${ea.duration}`);
    // Geometry: black canvas outside the window, content inside it, serif hook above it, captions inside it.
    for (const t of [1, s.duration / 2, s.duration - 1]) {
      const corner = await region(exportA, t, 0, 0, 1080, 300); assert.ok(corner.luma < 3, `black canvas top at ${t}s (${corner.luma})`);
      const bottom = await region(exportA, t, 0, 1460, 1080, 460); assert.ok(bottom.luma < 3, `black canvas bottom at ${t}s (${bottom.luma})`);
      const windowArea = await region(exportA, t, 0, 610, 1080, 700); assert.ok(windowArea.bright > 0.2, `media window has content at ${t}s`);
    }
    const hookInk = await region(exportA, 2, 0, 470, 1080, 124); assert.ok(hookInk.white > 200, 'hook text drawn above the media window');
    // Media-window parity: the window shows exactly the confirmed (baked) source, fitted whole.
    const srcFile = await download(s.sourceUrl, join(dir, 'a-source.mp4')); const sp = await probe(srcFile);
    const a = sp.width / sp.height, fw = a > 1080 / 700 ? 1080 : Math.round(700 * a / 2) * 2, fh = a > 1080 / 700 ? Math.round(1080 / a / 2) * 2 : 700;
    const fx = Math.round((1080 - fw) / 2), fy = 610 + Math.round((700 - fh) / 2);
    const errors = [];
    for (const t of [0.5, s.duration / 2, s.duration - 1.2]) {
      const exp = await region(exportA, t, fx + 8, fy + 8, fw - 16, Math.round(fh * 0.45));
      const ref = await region(srcFile, t, 8, 8, fw - 16, Math.round(fh * 0.45), `${fw}:${fh}`);
      errors.push(mae(exp.pixels, ref.pixels));
    }
    log('media window vs confirmed crop MAE (0-255):', errors.map((e) => e.toFixed(2)).join(', ')); assert.ok(errors.every((e) => e < 12), 'window matches the confirmed crop');
    const original = await pcm(plain), exported = await pcm(exportA); const alignA = aligned(original, exported); const corrA = alignA.r;
    log('original/export audio correlation', corrA.toFixed(6), `lag ${alignA.lagMs} ms`); assert.ok(corrA > 0.98 && Math.abs(alignA.lagMs) <= 50, 'original audio preserved and in sync');
    const history = await qr('/history'); const entry = history.find((h) => h.id === s.id);
    assert.ok(entry && entry.editPath === 'STYLEONE' && entry.exports.length === 1, 'saved to History with its path');
    const reopened = await qr('/' + s.id); assert.equal(reopened.cropConfirmed, true); sameBox(reopened.confirmed.crop, crop, 'reopened crop'); assert.equal(reopened.editPath, 'STYLEONE');
    results.push(`A StyleOne: 1080x1920 h264/aac ${ea.duration.toFixed(2)}s, black canvas, window MAE ${Math.max(...errors).toFixed(2)}, audio r=${corrA.toFixed(4)}, ${captionCount} captions, History+re-edit OK`);

    // Re-crop after styling keeps every edit: same SOURCE id, same elements, previous export becomes stale.
    const before = await project(s); const sourceBefore = before.assets.find((x) => x.role === 'SOURCE');
    // Cutting off the creator handle is refused; trimming more from the top is allowed.
    await assert.rejects(() => qr(`/${s.id}/plan`, 'PUT', { revision: s.revision, plan: { ...s.plan, crop: { ...crop, w: crop.w - 0.06 } } }), /attribution/);
    const recrop = { x: crop.x, y: crop.y + 0.02, w: crop.w, h: crop.h - 0.02 };
    s = await qr(`/${s.id}/plan`, 'PUT', { revision: s.revision, plan: { ...s.plan, crop: recrop } });
    assert.equal(s.cropConfirmed, false, 'a changed draft is not the confirmed crop');
    await qr(`/${s.id}/confirm-crop`, 'POST', { revision: s.revision }); s = await wait(s.id);
    const after = await project(s); const sourceAfter = after.assets.find((x) => x.role === 'SOURCE');
    assert.equal(sourceAfter.id, sourceBefore.id); assert.notEqual(sourceAfter.objectKey, sourceBefore.objectKey);
    assert.deepEqual(after.elements.map((e) => e.id).sort(), before.elements.map((e) => e.id).sort(), 'no edit lost on re-crop');
    assert.equal(s.styleOneApplied, true); assert.equal(s.exports[0].current, false, 'the earlier export is now stale, still in History');
    const oldSource = await fetch(`${base}/edit-mode/assets/${sourceBefore.id}/file`); assert.equal(oldSource.status, 200);
    results.push('Re-crop: SOURCE id and all elements kept, previous export marked stale');

    // ---------------- Test B + C: Manual ----------------------------------------------------------
    console.log('Test B/C: Upload -> crop -> Done -> Manual -> AI hook -> captions -> colour/filter -> export -> download -> refresh');
    ({ s } = await cropFirst(plain, 'test-b-manual.mp4'));
    s = await qr(`/${s.id}/path`, 'POST', { revision: s.revision, path: 'MANUAL' });
    assert.equal(s.editPath, 'MANUAL'); assert.equal(s.styleOneApplied, false, 'Manual never applies StyleOne');
    const openai = process.argv.includes('--openai');
    const suggested = await qr(`/${s.id}/hooks`, 'POST', { externalAiAuthorized: openai }); s = suggested.session;
    log(`${openai ? 'OpenAI' : 'local'} hooks:`, s.hooks.map((h) => `${h.category}${h.recommended ? '*' : ''}[${h.source}]: ${h.text}`).join(' | '), suggested.warnings.join(' '));
    assert.ok(s.hooks.length >= 3); const chosen = s.hooks.find((h) => h.recommended);
    if (openai) { assert.ok(s.hooks.some((h) => h.source === 'OPENAI'), 'OpenAI suggestions present'); assert.ok(new Set(s.hooks.map((h) => h.category)).size >= 4, 'several categories'); }
    p = await command(s, 'add-text', { textStyleId: 'HOOK', content: chosen.text, origin: 'ASSISTANT', presetRole: 'HOOK', fontSize: 56, height: 0.2 }); s = { ...s, revision: p.revision };
    const manualHook = p.elements.find((e) => e.type === 'TEXT' && e.properties.presetRole === 'HOOK'); assert.ok(manualHook);
    assert.equal(manualHook.properties.fontSize, 56, 'fitted hook size stored'); assert.equal(manualHook.properties.height, 0.2);
    p = await command(s, 'move-element', { elementId: manualHook.id, x: manualHook.properties.x, y: 0.05 }); s = { ...s, revision: p.revision };
    p = await command(s, 'generate-captions'); s = { ...s, revision: p.revision };
    assert.ok(p.elements.filter((e) => e.type === 'SUBTITLE').length > 3, 'captions generated (Test C)');
    const video = p.elements.find((e) => e.type === 'VIDEO');
    p = await command(s, 'apply-color-filter', { elementId: video.id, filterId: 'WARM' }); s = { ...s, revision: p.revision };
    p = await command(s, 'set-video-saturation', { elementId: video.id, saturation: 0.35 }); s = { ...s, revision: p.revision };
    // Refresh: everything is canonical, so a reload returns the same edit.
    const reloaded = await project(s); assert.equal(reloaded.revision, s.revision);
    assert.equal(reloaded.elements.find((e) => e.id === manualHook.id).properties.content, chosen.text);
    assert.equal(reloaded.elements.find((e) => e.id === video.id).properties.colorAdjustments.saturation, 0.35);
    s = await qr('/' + s.id); assert.equal(s.styleOneApplied, false);
    await qr(`/${s.id}/export`, 'POST', { revision: s.revision, resolution: 720 }); s = await wait(s.id);
    const exportB = await download(`${s.exports[0].url}?download=1`, join(dir, 'b-export.mp4')); const eb = await probe(exportB);
    const srcB = await download(s.sourceUrl, join(dir, 'b-source.mp4')); const sb = await probe(srcB);
    assert.equal(Math.min(eb.width, eb.height), 720, '720p export'); assert.ok(Math.abs(eb.width / eb.height - sb.width / sb.height) < 0.02, 'canvas is the confirmed crop shape');
    assert.deepEqual([eb.video, eb.audio], ['h264', 'aac']); assert.ok(Math.abs(eb.duration - s.duration) < 0.25);
    assert.deepEqual([s.outputs[720].width, s.outputs[720].height], [eb.width, eb.height], 'export screen shows the real resolution');
    // The left edge strip (x 1-7%) is picture only: the hook plate spans x 8-92% and captions are centred.
    const strip = (file, w, h) => region(file, 6, Math.round(w * 0.01), Math.round(h * 0.3), Math.max(2, Math.round(w * 0.06)), Math.round(h * 0.3));
    const plainRef = await strip(srcB, sb.width, sb.height); const graded = await strip(exportB, eb.width, eb.height);
    log(`colour: source rgb(${plainRef.r.toFixed(0)},${plainRef.g.toFixed(0)},${plainRef.b.toFixed(0)}) -> export rgb(${graded.r.toFixed(0)},${graded.g.toFixed(0)},${graded.b.toFixed(0)})`);
    // A saturation boost deepens this blue scene more than WARM shifts it, so check chroma and a clear change.
    const chroma = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
    const shift = (Math.abs(graded.r - plainRef.r) + Math.abs(graded.g - plainRef.g) + Math.abs(graded.b - plainRef.b)) / 3;
    assert.ok(shift > 6 && chroma(graded) / Math.max(1, (graded.r + graded.g + graded.b) / 3) > chroma(plainRef) / Math.max(1, (plainRef.r + plainRef.g + plainRef.b) / 3), `filter + saturation applied (shift ${shift.toFixed(1)})`);
    const topInk = await region(exportB, 2, 0, 0, eb.width, Math.round(eb.height * 0.25)); assert.ok(topInk.white > 100, 'hook text near the top');
    const captionInk = []; for (const t of [3, 9, 15, 21]) captionInk.push((await region(exportB, t, 0, Math.round(eb.height * 0.55), eb.width, Math.round(eb.height * 0.45))).white);
    assert.ok(captionInk.filter((w) => w > 150).length >= 3, `captions visible in the export (${captionInk.join(',')})`);
    const alignB = aligned(await pcm(plain), await pcm(exportB)); const corrB = alignB.r; log('manual audio', corrB.toFixed(6), `lag ${alignB.lagMs} ms`); assert.ok(corrB > 0.98 && Math.abs(alignB.lagMs) <= 50, 'audio preserved and in sync');
    results.push(`B/C Manual: ${eb.width}x${eb.height} 720p, ${openai ? 'OpenAI' : 'local'} hook applied, ${p.elements.filter((e) => e.type === 'SUBTITLE').length} captions, WARM+saturation verified, audio r=${corrB.toFixed(4)}, refresh OK`);

    // ---------------- Test E: mode switching -------------------------------------------------------
    console.log('Test E: Manual edits -> StyleOne (checkpoint) -> undo restores manual, crop preserved');
    const keyBefore = (await project(s)).assets.find((x) => x.role === 'SOURCE').metadata.quickReframeKey;
    s = await qr(`/${s.id}/styleone`, 'POST', { revision: s.revision }); s = await wait(s.id);
    assert.equal(s.editPath, 'STYLEONE'); assert.equal(s.styleOneApplied, true);
    p = await project(s); assert.equal(p.settings.resolvedVisualLayout.editingProfile, 'AUTOMATIC_2');
    const undone = await http(`/edit-mode/projects/${s.editProjectId}/undo`, 'POST', { revision: p.revision });
    assert.equal(undone.settings.resolvedVisualLayout?.editingProfile, undefined, 'undo removes StyleOne');
    assert.equal(undone.elements.find((e) => e.id === manualHook.id)?.properties.content, chosen.text, 'manual hook restored');
    assert.equal(undone.elements.find((e) => e.id === video.id).properties.colorAdjustments.saturation, 0.35, 'manual colour restored');
    assert.equal(undone.assets.find((x) => x.role === 'SOURCE').metadata.quickReframeKey, keyBefore, 'confirmed crop untouched');
    s = await qr('/' + s.id);
    s = await qr(`/${s.id}/path`, 'POST', { revision: s.revision, path: 'MANUAL' }); assert.equal(s.editPath, 'MANUAL');
    results.push('E Switching: StyleOne applied as one revision; undo restored the manual hook/colour; crop key unchanged');

    // ---------------- Test D: existing captions ----------------------------------------------------
    console.log('Test D: footage with readable subtitles -> no duplicate caption layer');
    let d; ({ s: d } = await cropFirst(captioned, 'test-d-captions.mp4', false));
    assert.equal(d.analysis.subtitleState, 'EXISTING_READABLE', 'readable subtitles detected');
    assert.ok(d.analysis.regions.filter((r) => r.kind === 'CAPTION').every((r) => r.y >= d.confirmed.crop.y - 0.001 && r.y + r.h <= d.confirmed.crop.y + d.confirmed.crop.h + 0.001), 'original captions kept inside the crop');
    d = await qr(`/${d.id}/styleone`, 'POST', { revision: d.revision }); d = await wait(d.id);
    p = await project(d); assert.equal(p.elements.filter((e) => e.type === 'SUBTITLE').length, 0, 'no generated captions over existing ones');
    const autoHook = p.elements.find((e) => e.type === 'TEXT' && e.properties.fontFamily?.includes('Garamond'));
    assert.ok(autoHook && autoHook.properties.content.length > 10, 'StyleOne writes a hook even when none was requested'); log('auto StyleOne hook:', autoHook.properties.content);
    await qr(`/${d.id}/export`, 'POST', { revision: d.revision, resolution: 1080 }); d = await wait(d.id);
    const exportD = await download(`${d.exports[0].url}?download=1`, join(dir, 'd-export.mp4')); const ed = await probe(exportD);
    assert.deepEqual([ed.width, ed.height], [1080, 1920]);
    results.push(`D Existing captions: ${d.analysis.regions.filter((r) => r.kind === 'CAPTION').length} caption regions kept in crop, 0 generated captions, 1080x1920 export`);

    // ---------------- Identity crop: back to the uploaded pixels ------------------------------------
    d = await qr(`/${d.id}/plan`, 'PUT', { revision: d.revision, plan: { ...d.plan, aspect: 'SOURCE', crop: { x: 0, y: 0, w: 1, h: 1 }, cleanup: [] } });
    await qr(`/${d.id}/confirm-crop`, 'POST', { revision: d.revision }); d = await wait(d.id);
    p = await project(d); assert.ok(!p.assets.some((x) => x.metadata?.quickReframeKind === 'ORIGINAL'), 'full frame uses the original directly');
    assert.equal(p.assets.find((x) => x.role === 'SOURCE').width, d.width);
    results.push('Identity crop: SOURCE points back at the uploaded original; no extra encode');

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
