// Real-media proof that a styled GeneratedClip reopens as the SAME canonical EditProject after its
// EditProject is deleted: generate -> capture -> delete ONLY the EditProject -> reopen -> compare state
// -> export both -> compare frames. Disposable account on the isolated QA stack; refuses anything else.
//   QA_API=http://127.0.0.1:4100 QA_MEDIA=<mp4> QA_OUT=<dir> node scripts/verify-rematerialize-styled-clips-live.cjs
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const BASE = process.env.QA_API || 'http://127.0.0.1:4100';
const ORIGIN = 'http://localhost:3000';
const MEDIA = process.env.QA_MEDIA || 'C:/projects/ai-content-platform/.real-qa-preview/xeefree/media/B-story.mp4';
const OUT = path.resolve(process.env.QA_OUT || path.join(__dirname, '..', '..', '..', '.real-qa-preview', 'rematerialize-fix-20261014', 'live'));
if (new URL(BASE).port !== '4100' || !/^(127\.0\.0\.1|localhost)$/.test(new URL(BASE).hostname))
  throw new Error('Refusing to run against anything but the isolated QA stack on :4100');
fs.mkdirSync(OUT, { recursive: true });
const report = { passed: false, base: BASE, styles: [] };
const save = () => fs.writeFileSync(path.join(OUT, 'live-report.json'), JSON.stringify(report, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = null;
async function api(url, method = 'GET', body, raw = false) {
  const form = body instanceof FormData;
  const r = await fetch(BASE + url, { method, headers: { Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}),
    ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? (form ? body : JSON.stringify(body)) : undefined });
  if (raw) return r;
  const x = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${method} ${url} ${r.status} ${x.message ?? ''}`), { status: r.status });
  return x;
}
async function wait(load, done, label, limitMs = 900000) {
  const start = Date.now();
  for (;;) {
    const x = await load();
    if (done(x)) return x;
    if (x && (x.status === 'FAILED' || x.analysisStatus === 'FAILED')) throw new Error(`${label} failed: ${x.error}`);
    if (Date.now() - start > limitMs) throw new Error(`${label} timed out`);
    await sleep(1500);
  }
}
const ffprobe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }));
const IGNORED = new Set(['id', 'editProjectId', 'createdAt', 'updatedAt', 'assetId', 'sourceAssetId', 'startedAt',
  'exportAssetId', 'exportId', 'reconstruction', 'objectKey', 'storageObjectKey', 'bucket', 'sourceVideoId', 'elementId', 'ids', 'userId']);
const strip = (value) => JSON.parse(JSON.stringify(value, (key, item) => IGNORED.has(key) ? undefined : item));
const canonical = (p) => ({
  revision: p.revision,
  elements: p.elements.map((e) => strip({ type: e.type, track: e.track, position: e.position, startTime: e.startTime,
    duration: e.duration, trimStart: e.trimStart, trimEnd: e.trimEnd, properties: e.properties }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  assets: p.assets.map((a) => strip({ role: a.role, mimeType: a.mimeType, duration: a.duration, width: a.width,
    height: a.height, storageOwnership: a.storageOwnership })).sort((a, b) => a.role.localeCompare(b.role)),
  settings: strip(p.settings)
});
function diff(a, b, at = '', out = []) {
  if (out.length > 25) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[key], b[key], `${at}/${key}`, out);
  } else out.push(`${at}: ${JSON.stringify(a)?.slice(0, 80)} != ${JSON.stringify(b)?.slice(0, 80)}`);
  return out;
}
const headlines = (p) => p.elements.filter((e) => e.type === 'TEXT' && String(e.properties.templateRole ?? e.properties.presetRole) === 'HOOK');
async function exportAndDownload(project, file) {
  await api(`/edit-mode/projects/${project.id}/export`, 'POST', { revision: project.revision });
  const progress = await wait(() => api(`/edit-mode/projects/${project.id}/export/progress`),
    (x) => ['FAILED', 'COMPLETED'].includes(x.phase), 'export ' + file);
  assert.equal(progress.phase, 'COMPLETED', `${file}: ${progress.errorCode} ${progress.message}`);
  assert.equal(progress.sourceRevision, project.revision);
  const asset = (await api(`/edit-mode/projects/${project.id}/exports`)).find((x) => x.current && x.sourceRevision === project.revision);
  assert(asset, file + ': no current export');
  const r = await api(`/edit-mode/assets/${asset.id}/file`, 'GET', undefined, true);
  assert(r.ok); const bytes = Buffer.from(await r.arrayBuffer()); assert(bytes.length > 10000);
  fs.writeFileSync(path.join(OUT, file), bytes);
  return path.join(OUT, file);
}
function ffmpegStats(a, b) {
  const r = require('node:child_process').spawnSync('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', '[0:v][1:v]ssim;[0:v][1:v]psnr', '-f', 'null', '-'], { encoding: 'utf8' });
  const text = r.stderr || '';
  return { ssimAll: Number((/SSIM.*All:([0-9.]+)/.exec(text) || [])[1]), psnrAvg: (/average:([0-9.inf]+)/.exec(text) || [])[1] };
}
function frame(file, t, out) {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', out]);
}

async function main() {
  assert.equal((await (await fetch(BASE + '/health')).json()).status, 'ok');
  const account = { email: `rematerialize-${Date.now()}@example.invalid`, password: crypto.randomBytes(24).toString('base64url') };
  const signup = await fetch(BASE + '/auth/signup', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...account, displayName: 'Rematerialization QA' }) });
  assert.equal(signup.status, 201); cookie = signup.headers.get('set-cookie').split(';')[0];
  await api('/auth/preferences', 'PATCH', { aiProcessingConsent: true }).catch(() => undefined);
  const project = await api('/projects', 'POST', { name: 'Rematerialization QA' });
  const form = new FormData();
  form.set('file', new Blob([fs.readFileSync(MEDIA)], { type: 'video/mp4' }), 'source.mp4');
  form.set('aiMode', 'FALLBACK_ONLY'); form.set('processingType', 'EDITED_CLIPS'); form.set('aspectRatio', '9:16');
  const video = await api(`/projects/${project.id}/videos`, 'POST', form); report.videoId = video.id; save();
  await wait(() => api(`/videos/${video.id}/clip-analysis`), (x) => x.analysisStatus === 'READY', 'source analysis');

  for (const [name, template] of [['StyleZero', 'AUTOMATIC_1'], ['StyleOne', 'AUTOMATIC_2'], ['StyleTwo', 'AUTOMATIC_3_STYLE_TWO']]) {
    const entry = { style: name, template, checks: [] }; report.styles.push(entry);
    const step = (label, data = {}) => { entry.checks.push({ label, passed: true, ...data }); save(); console.log(`PASS ${name} ${label}`); };
    await api(`/videos/${video.id}/clip-selection`, 'POST', { requestedClipCount: 1, outputStyle: 'AI_EDITED', generation: { templateId: template } });
    let results = await wait(() => api(`/videos/${video.id}/clip-results`), (x) => ['COMPLETED', 'PARTIAL'].includes(x.status) && x.clips.length, name + ' rendering');
    if (template !== 'AUTOMATIC_1') results = await wait(() => api(`/videos/${video.id}/clip-results`),
      (x) => x.clips.every((c) => c.style?.playbackUrl || c.style?.status === 'STYLE_FAILED'), name + ' styling');
    const clip = results.clips.find((c) => c.requestedTemplate === template) || results.clips[0];
    entry.clipId = clip.id;

    // A: the project as generation delivered it
    const opened = await api(`/edit-mode/projects/from-generated-clip/${clip.id}`, 'POST', {});
    let A = await api(`/edit-mode/projects/${opened.editProjectId}`);
    const styleA = A.settings.generationStyle ?? null;
    entry.original = { projectId: A.id, revision: A.revision, headlines: headlines(A).length, generationStyle: styleA && { status: styleA.status, templateId: styleA.templateId, lines: styleA.lines?.length } };
    assert(headlines(A).length >= 1, `${name}: generated project has no headline`);
    const headlineA = headlines(A)[0];
    step('original project captured', entry.original);
    const exportA = await exportAndDownload(A, `${name}-original-export.mp4`);
    step('original exports');

    // delete ONLY the canonical EditProject
    await api(`/edit-mode/projects/${A.id}`, 'DELETE');
    await assert.rejects(() => api(`/edit-mode/projects/${A.id}`), (e) => e.status === 404);
    assert.equal((await api(`/generated-clips/${clip.id}/file`, 'GET', undefined, true)).status, 200);
    step('only the EditProject was deleted (the generated clip file is intact)');

    // B: reopened through the real endpoint
    const t0 = Date.now();
    const reopened = await api(`/edit-mode/projects/from-generated-clip/${clip.id}`, 'POST', {});
    entry.reopenMs = Date.now() - t0;
    const B = await api(`/edit-mode/projects/${reopened.editProjectId}`);
    assert.notEqual(B.id, A.id);
    assert(headlines(B).length >= 1, `${name}: rebuilt project has no headline`);
    step(`reopened in ${entry.reopenMs} ms with a new project`, { projectId: B.id, revision: B.revision, headlines: headlines(B).length });
    const settledB = await wait(() => api(`/edit-mode/projects/${B.id}`), (p) => ['EXPORT_READY', 'READY', 'STYLE_FAILED', undefined].includes(p.settings.generationStyle?.status), name + ' background export', 600000);
    const finalB = await api(`/edit-mode/projects/${B.id}`);
    entry.rebuilt = { generationStyle: finalB.settings.generationStyle && { status: finalB.settings.generationStyle.status, reconstruction: finalB.settings.generationStyle.reconstruction, templateId: finalB.settings.generationStyle.templateId } };
    const differences = diff(canonical(A), canonical(finalB));
    entry.canonicalDifferences = differences; save();
    assert.equal(differences.length, 0, `${name}: canonical state differs:\n  ` + differences.join('\n  '));
    step('canonical state (elements, timing, headline, settings, revision) is identical');
    const headlineB = headlines(finalB)[0];
    assert.equal(headlineB.properties.content, headlineA.properties.content);
    assert.deepEqual(strip(headlineB.properties), strip(headlineA.properties));
    entry.headline = { content: headlineB.properties.content, startTime: headlineB.startTime, duration: headlineB.duration, fontSize: headlineB.properties.fontSize, width: headlineB.properties.width, height: headlineB.properties.height, origin: headlineB.properties.origin, textStyleId: headlineB.properties.textStyleId };
    step('headline text, timing, font, layout, origin and style are identical', entry.headline);

    // render parity: the actual pixels
    const exportB = await exportAndDownload(finalB, `${name}-rebuilt-export.mp4`);
    const cmp = ffmpegStats(exportA, exportB);
    const pa = ffprobe(exportA), pb = ffprobe(exportB);
    entry.render = { durationOriginal: +pa.format.duration, durationRebuilt: +pb.format.duration, ...cmp };
    assert(Math.abs(entry.render.durationOriginal - entry.render.durationRebuilt) < 0.1, 'duration parity');
    assert(entry.render.ssimAll > 0.995, `${name}: frames differ (SSIM ${entry.render.ssimAll})`);
    const mid = entry.render.durationOriginal / 2;
    for (const [label, t] of [['start', 0.4], ['mid', mid]]) { frame(exportA, t, path.join(OUT, `${name}-original-${label}.png`)); frame(exportB, t, path.join(OUT, `${name}-rebuilt-${label}.png`)); }
    step('exported video of the rebuilt project matches the original frame for frame', entry.render);

    // a clip generated BEFORE snapshots existed (every clip already in production): no per-clip snapshot,
    // so the rebuild falls back to the request's own settings and must still match the original exactly
    let cur = finalB;
    if (template !== 'AUTOMATIC_1') {
      execFileSync('docker', ['exec', 'xeeeditor-postgres', 'psql', '-U', 'postgres', '-d', 'ai_content_platform', '-c',
        `update "GeneratedClip" set "editTelemetry" = "editTelemetry" - 'generationStyle' where id = '${clip.id}'`], { encoding: 'utf8' });
      await api(`/edit-mode/projects/${cur.id}`, 'DELETE');
      const legacyOpen = await api(`/edit-mode/projects/from-generated-clip/${clip.id}`, 'POST', {});
      await wait(() => api(`/edit-mode/projects/${legacyOpen.editProjectId}`), (p) => ['EXPORT_READY', 'READY', 'STYLE_FAILED'].includes(p.settings.generationStyle?.status), name + ' legacy background export', 600000);
      cur = await api(`/edit-mode/projects/${legacyOpen.editProjectId}`);
      assert.equal(cur.settings.generationStyle.reconstruction, 'REQUEST_SETTINGS');
      const legacyDiff = diff(canonical(A), canonical(cur));
      entry.legacyCanonicalDifferences = legacyDiff; save();
      assert.equal(legacyDiff.length, 0, name + ': legacy rebuild differs: ' + legacyDiff.join(' | '));
      const legacyExport = await exportAndDownload(cur, `${name}-legacy-rebuilt-export.mp4`);
      entry.legacyRender = ffmpegStats(exportA, legacyExport);
      assert(entry.legacyRender.ssimAll > 0.995, name + ': legacy rebuild frames differ');
      step('a clip with no snapshot (generated before this fix) rebuilds identically from the request settings', entry.legacyRender);
    }

    // idempotency / user edits / retry-style
    const countBefore = cur.elements.length, revBefore = cur.revision;
    await api(`/edit-mode/generation/clips/${clip.id}/retry-style`, 'POST', {}).catch((e) => { if (template === 'AUTOMATIC_1') return; throw e; });
    await sleep(4000);
    const afterRetry = await api(`/edit-mode/projects/${cur.id}`);
    assert.equal(afterRetry.elements.length, countBefore); assert.equal(afterRetry.revision, revBefore);
    assert.equal(headlines(afterRetry).length, headlines(cur).length);
    step('retry-style on the rebuilt project does not duplicate elements or revisions');
    const edited = await api(`/edit-mode/projects/${cur.id}/commands/set-text-content`, 'POST', { revision: afterRetry.revision, elementId: headlines(afterRetry)[0].id, content: 'My own edited headline' });
    const reopenedAgain = await api(`/edit-mode/projects/from-generated-clip/${clip.id}`, 'POST', {});
    const kept = await api(`/edit-mode/projects/${cur.id}`);
    assert.equal(reopenedAgain.editProjectId, cur.id); assert.equal(headlines(kept)[0].properties.content, 'My own edited headline'); assert.equal(kept.revision, edited.revision);
    step('a manual headline edit survives reopening (existing project is never restyled)');
    entry.passed = true; save();
  }
  report.passed = report.styles.every((s) => s.passed);
  // best-effort cleanup of this disposable account's data
  for (const p of await api('/edit-mode/projects').catch(() => [])) await api(`/edit-mode/projects/${p.id}`, 'DELETE').catch(() => undefined);
  for (const v of await api('/videos').catch(() => [])) await api(`/videos/${v.id}`, 'DELETE').catch(() => undefined);
  report.timestamp = new Date().toISOString(); save();
  console.log(report.passed ? 'PASS rematerialization live verification (StyleZero, StyleOne, StyleTwo)' : 'FAILED');
}
main().catch((e) => { report.error = e.stack || e.message; save(); console.error(e.stack || e.message); process.exitCode = 1; });
