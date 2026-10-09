// Isolated pre-production acceptance for the Delivery ending (ASR-uncertain final word).
// Runs the REAL pipeline from scratch against the isolated QA stack on :4100 only: upload -> fresh ASR -> Content Intelligence ->
// boundary QA -> creative package -> StyleTwo render. No transcript is injected. Mirrors the configuration that failed production:
// ONLINE, EDITED_CLIPS, 9:16, YOUTUBE_SHORTS, AUTOMATIC_3_STYLE_TWO, one clip.
//
//   QA_MEDIA=<mp4> QA_OUT=<dir> node scripts/verify-ending-delivery-isolated.cjs
//
// Prints a JSON result (ids, statuses, download paths). Ending/ASR evidence is then read from the QA database by the caller.
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { basename, resolve } = require('node:path');
const { randomBytes } = require('node:crypto');
const base = process.env.QA_URL || 'http://127.0.0.1:4100', origin = 'http://localhost:3100';
if (!/^http:\/\/(?:127\.0\.0\.1|localhost):4100$/u.test(base)) throw Error('Only the isolated QA stack on port 4100 is allowed.');
const mediaPath = process.env.QA_MEDIA; if (!mediaPath) throw Error('QA_MEDIA is required');
const out = resolve(process.env.QA_OUT || '.real-qa-preview/ending-qa'); mkdirSync(out, { recursive: true });
const media = readFileSync(mediaPath), mediaName = basename(mediaPath); let cookie = '';
async function api(path, method = 'GET', body) {
  const form = body instanceof FormData;
  const r = await fetch(base + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: form ? body : body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  assert.ok(r.ok, `${method} ${path}: ${r.status} ${data.message || data.error || ''}`);
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0]; return data;
}
async function wait(load, done, label, ms = 900000) {
  const start = Date.now();
  for (;;) {
    const s = await load();
    if (done(s)) return s;
    if (s.status === 'FAILED' || s.analysisStatus === 'FAILED') throw Error(`${label} failed: ${s.error || s.message || JSON.stringify(s).slice(0, 600)}`);
    if (Date.now() - start > ms) throw Error(`${label} timed out`);
    await new Promise(r => setTimeout(r, 2000));
  }
}
(async () => {
  await api('/auth/signup', 'POST', { email: `ending-qa-${Date.now()}@example.invalid`, password: randomBytes(24).toString('base64url'), displayName: 'Ending QA' });
  await api('/auth/preferences', 'PATCH', { aiProcessingConsent: true });
  const project = await api('/projects', 'POST', { name: 'Ending QA (disposable)', description: 'Isolated acceptance: ' + mediaName });
  const form = new FormData();
  form.set('file', new Blob([media], { type: 'video/mp4' }), mediaName); form.set('aiMode', 'ONLINE');
  form.set('processingType', 'EDITED_CLIPS'); form.set('aspectRatio', '9:16'); form.set('targetPlatform', 'YOUTUBE_SHORTS');
  const video = await api(`/projects/${project.id}/videos`, 'POST', form);
  console.error('uploaded', video.id);
  const analysis = await wait(() => api(`/videos/${video.id}/clip-analysis`), s => s.analysisStatus === 'READY', 'analysis');
  console.error('analysis READY');
  if (process.env.QA_ANALYSIS_ONLY === '1') {   // negative controls: the boundary decision is in the analysis, no render needed
    writeFileSync(resolve(out, 'run-summary.json'), JSON.stringify({ videoId: video.id, analysisStatus: analysis.analysisStatus }, null, 2));
    console.log(JSON.stringify({ videoId: video.id, analysisStatus: analysis.analysisStatus })); return;
  }
  const selectionStarted = Date.now();
  await api(`/videos/${video.id}/clip-selection`, 'POST', { requestedClipCount: 1, outputStyle: 'AI_EDITED',
    generation: { look: 'AUTOMATIC_3_STYLE_TWO', brief: '', components: {}, templateId: 'AUTOMATIC_3_STYLE_TWO', referenceId: null } });
  const result = await wait(() => api(`/videos/${video.id}/clip-results`), s => ['COMPLETED', 'PARTIAL', 'FAILED'].includes(s.status), 'render');
  const clip = result.clips?.[0];
  const summary = { videoId: video.id, projectId: project.id, analysisStatus: analysis.analysisStatus, resultStatus: result.status,
    deliveredClips: result.clips?.length ?? 0, selectionMs: Date.now() - selectionStarted, clip: clip && { id: clip.id, hook: clip.hook, caption: clip.caption,
      synopsis: clip.synopsis, hashtags: clip.hashtags, startTime: clip.startTime, endTime: clip.endTime, playbackUrl: clip.playbackUrl ?? clip.style?.playbackUrl ?? null }, raw: result };
  const url = clip?.playbackUrl ?? clip?.style?.playbackUrl ?? clip?.downloadUrl ?? null;
  if (url) {
    const r = await fetch(base + url, { headers: { Cookie: cookie } });
    if (r.ok) { writeFileSync(resolve(out, 'delivery-rendered.mp4'), Buffer.from(await r.arrayBuffer())); summary.renderedFile = resolve(out, 'delivery-rendered.mp4'); }
  }
  writeFileSync(resolve(out, 'run-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, raw: undefined }, null, 1));
  console.error('result keys:', Object.keys(result), clip ? Object.keys(clip) : 'no clip');
})().catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; });
