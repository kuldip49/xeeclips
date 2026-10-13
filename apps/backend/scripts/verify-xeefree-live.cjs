// XeeFree real-media acceptance against the ISOLATED QA stack (port 4100). Never run against production.
//
//   XEEFREE_QA_MEDIA=a.mp4,b.mp4  XEEFREE_QA_MODE=FALLBACK_ONLY|ONLINE  XEEFREE_QA_OUT=.real-qa-preview/xeefree/free  node scripts/verify-xeefree-live.cjs
//
// For each source: Create Clips under StyleZero (AUTOMATIC_1), StyleOne (AUTOMATIC_2) and StyleTwo (AUTOMATIC_3_STYLE_TWO), History reopen, the editor hook
// rewrite endpoint (with the AI-authorised flag deliberately SET, which a XeeFree project must ignore), Ask AI (a deterministic command and an open-ended
// request), and Quick Reframe. It records, per clip, everything a reviewer needs (range, transcript, hook, alternates, captions, tags, export) and downloads the
// real exports. The QA backend is started with api.openai.com blackholed for a XeeFree run, so a cloud call would fail loudly rather than quietly succeed.
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { basename, resolve } = require('node:path');
const { randomBytes } = require('node:crypto');
const { assertQaStack, topUpQaUser } = require('./xeefree-qa-safety.cjs');
const root = resolve(__dirname, '../../..');
const mode = process.env.XEEFREE_QA_MODE === 'ONLINE' ? 'ONLINE' : 'FALLBACK_ONLY';
const label = mode === 'ONLINE' ? 'pro' : 'free';
const out = resolve(root, process.env.XEEFREE_QA_OUT || `.real-qa-preview/xeefree/${label}`);
const base = process.env.XEEFREE_QA_URL || 'http://127.0.0.1:4100', origin = 'http://localhost:3100';
if (!/^http:\/\/(?:127\.0\.0\.1|localhost):4100$/u.test(base)) throw Error('Only the isolated QA stack on port 4100 is allowed.');
const mediaList = (process.env.XEEFREE_QA_MEDIA || '').split(',').map(s => s.trim()).filter(Boolean).map(p => resolve(root, p));
if (!mediaList.length) throw Error('Set XEEFREE_QA_MEDIA to one or more authorised media files.');
const clipCount = Number(process.env.XEEFREE_QA_CLIPS || 2);
const templates = (process.env.XEEFREE_QA_TEMPLATES || 'AUTOMATIC_1,AUTOMATIC_2,AUTOMATIC_3_STYLE_TWO').split(',');
const styleName = { AUTOMATIC_1: 'StyleZero', AUTOMATIC_2: 'StyleOne', AUTOMATIC_3_STYLE_TWO: 'StyleTwo' };
// Optional private manifest resumes an interrupted disposable QA account's saved exports.
// Never print or put its credentials into the public report.
const resume = process.env.XEEFREE_QA_RESUME ? JSON.parse(readFileSync(resolve(root, process.env.XEEFREE_QA_RESUME), 'utf8')) : null;
if (resume) assert.match(resume.email, /^xeefree-qa-\d+@example\.invalid$/);
let cookie = '';
let activeReport = null;

async function api(path, method = 'GET', body, allowFail = false) {
  const form = body instanceof FormData;
  const r = await fetch(base + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
    body: form ? body : body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok && !allowFail) throw Error(`${method} ${path}: ${r.status} ${data.message || data.error || JSON.stringify(data).slice(0, 200)}`);
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
  return allowFail ? { ok: r.ok, status: r.status, data } : data;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function wait(load, done, what, limit = 900000, allowDeliveryFailure = false) {
  const start = Date.now();
  for (;;) {
    const s = await load();
    if ((s.status === 'FAILED' && !allowDeliveryFailure) || s.analysisStatus === 'FAILED') throw Error(`${what} failed: ${s.error || s.message || JSON.stringify(s).slice(0, 300)}`);
    if (done(s)) return s;
    if (Date.now() - start > limit) throw Error(`${what} timed out`);
    await sleep(2000);
  }
}
async function download(url, file) {
  const r = await fetch(base + url, { headers: { Cookie: cookie } });
  assert.ok(r.ok, `download ${url}: ${r.status}`);
  writeFileSync(resolve(out, file), Buffer.from(await r.arrayBuffer()));
}
const words = (text) => (String(text).toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);

async function runSource(mediaPath, index) {
  const media = readFileSync(mediaPath), mediaName = basename(mediaPath), tag = `${index}-${basename(mediaPath, '.mp4').replace(/[^\w-]+/gu, '_')}`;
  const savedSource = resume?.sources.find(s => s.report.source === mediaName);
  const report = savedSource ? savedSource.report : { source: mediaName, mode, clips: [], checks: {} };
  activeReport = report;
  const started = Date.now();
  let videoId = savedSource?.videoId;
  if (!videoId) {
    const project = await api('/projects', 'POST', { name: `XeeFree QA ${mode} ${mediaName}`.slice(0, 80), description: 'Disposable acceptance source' });
    const form = new FormData();
    form.set('file', new Blob([media], { type: 'video/mp4' }), mediaName); form.set('aiMode', mode); form.set('processingType', 'EDITED_CLIPS'); form.set('aspectRatio', '9:16');
    videoId = (await api(`/projects/${project.id}/videos`, 'POST', form)).id;
  }
  report.videoId = videoId;
  const analysis = await wait(() => api(`/videos/${videoId}/clip-analysis`), s => s.analysisStatus === 'READY', 'clip analysis');
  if (!savedSource) report.analysisMs = Date.now() - started;
  report.analysis = { candidateCount: analysis.candidates?.length ?? analysis.candidateCount ?? null, aiModeLabel: analysis.aiModeUsed ?? null };
  const transcript = await api(`/videos/${videoId}/transcript`);
  report.language = transcript.language; report.transcript = transcript.text;
  writeFileSync(resolve(out, `${tag}-transcript.json`), JSON.stringify(transcript, null, 2));

  for (const templateId of savedSource ? [] : templates) {
    const name = styleName[templateId] ?? templateId, t0 = Date.now();
    await api(`/videos/${videoId}/clip-selection`, 'POST', { requestedClipCount: clipCount, outputStyle: 'AI_EDITED', generation: { templateId } });
    let result = await wait(() => api(`/videos/${videoId}/clip-results`), s => ['COMPLETED', 'PARTIAL', 'FAILED'].includes(s.status), `${name} render`, 900000, true);
    if (templateId !== 'AUTOMATIC_1' && result.clips?.length) result = await wait(() => api(`/videos/${videoId}/clip-results`), s => s.clips?.length && s.clips.every(c => c.style?.playbackUrl || c.style?.status === 'STYLE_FAILED'), `${name} styling`, 900000, true);
    const clips = (result.clips ?? []).filter(c => !c.requestedTemplate || c.requestedTemplate === templateId || c.templateId === templateId);
    const exported = clips.filter(c => templateId === 'AUTOMATIC_1' || c.style?.playbackUrl);
    report.checks[name] = { renderMs: Date.now() - t0, clips: exported.length, baseClips: clips.length, requested: clipCount,
      failedStyles: clips.filter(c => c.style?.status === 'STYLE_FAILED').map(c => ({ id: c.id, error: c.style.error })),
      deliveryStatus: result.status, message: result.message ?? result.error ?? null };
    for (const [i, clip] of clips.entries()) {
      const ready = exported.includes(clip);
      const url = ready ? clip.style?.playbackUrl || clip.playbackUrl || `/generated-clips/${clip.id}/file` : null;
      const file = ready ? `${tag}-${name}-${i + 1}.mp4` : null;
      if (url) await download(url, file);
      report.clips.push({ style: name, file, id: clip.id, start: clip.sourceRange?.startTime ?? clip.startTime,
        end: clip.sourceRange?.endTime ?? clip.endTime, duration: clip.durationSec ?? clip.duration, hook: clip.hook, alternates: clip.alternateHooks ?? clip.hookOptions,
        synopsis: clip.synopsis, caption: clip.caption, hashtags: clip.hashtags, title: clip.title, status: clip.style?.status ?? clip.status, aiModeUsed: clip.aiModeUsed,
        quality: { contentPotential: clip.contentPotential, generationQuality: clip.generationQuality, confidence: clip.confidence }, editUrl: clip.editUrl });
    }
  }

  // History reopen: the saved clips come back with the same hook and the product label for the tier.
  const history = await api('/history/clips');
  const saved = history.filter(c => report.clips.some(k => k.id === c.id));
  for (const [i, clip] of report.clips.entries()) {
    const entry = saved.find(c => c.id === clip.id);
    clip.historyHook = entry?.hook ?? null;
    clip.exportUrl = entry?.playbackUrl ?? null;
    if (savedSource) {
      clip.file = `${tag}-${clip.style}-${i + 1}.mp4`;
      assert(entry?.playbackUrl, `saved ${clip.style} export must be ready`);
      await download(entry.playbackUrl, clip.file);
    }
  }
  report.checks.history = { saved: saved.length, labels: [...new Set(saved.map(c => c.mode))] };
  if (report.clips.length) assert.ok(saved.length >= 1, 'History persists the generated clips');
  if (mode !== 'ONLINE') assert.ok(saved.every(c => c.mode === 'XeeFree'), 'History labels XeeFree clips as XeeFree');
  assert.ok(!JSON.stringify(saved).includes('"model"'), 'History hides internal model details');

  // Editor: hook rewrite with the AI-authorised flag SET, and Ask AI.
  const firstSaved = saved.find(c => c.editUrl);
  const first = firstSaved ? { editUrl: firstSaved.editUrl } : report.clips.find(c => c.editUrl);
  if (first) {
    const editId = String(first.editUrl).split('/').filter(Boolean).pop().split('?')[0];
    let project = await api(`/edit-mode/projects/${editId}`);
    if (mode !== 'ONLINE') {
      const recordedMode = project.settings.origin.aiMode;
      project = await api(`/edit-mode/projects/${editId}`, 'PATCH', { revision: project.revision,
        settings: { origin: { aiMode: 'ONLINE' } } });
      assert.equal(project.settings.origin.aiMode, recordedMode, 'client settings cannot change Free provenance');
      report.checks.provenanceImmutable = true;
    }
    const rewrite = await api(`/edit-mode/projects/${editId}/hooks`, 'POST', { revision: project.revision, externalAiAuthorized: true, direction: 'make it shorter', hooksOnly: true });
    report.checks.hookRewrite = { hooks: rewrite.package.hooks.map(h => ({ text: h.text, source: h.source, category: h.category })), warnings: rewrite.warnings };
    if (mode !== 'ONLINE') assert.ok(rewrite.package.hooks.every(h => h.source === 'LOCAL'), 'a XeeFree project ignores the AI-authorised flag: hooks are local');
    const agentState = await api(`/edit-mode/projects/${editId}/agent`);
    report.checks.askAiState = agentState.ai;
    if (mode !== 'ONLINE') assert.equal(agentState.ai.state, 'XEEFREE');
    const direct = await api(`/edit-mode/projects/${editId}/agent/run`, 'POST', { message: 'mute the music and change the hook', aiConsent: false }, true);
    const openEnded = await api(`/edit-mode/projects/${editId}/agent/run`, 'POST', { message: 'make this feel more viral and emotional somehow', aiConsent: false }, true);
    report.checks.askAi = { direct: { ok: direct.ok, summary: direct.data?.summary ?? direct.data?.message ?? null, ledger: (direct.data?.ledger ?? []).map(l => ({ status: l.status, intent: l.intent })) },
      openEnded: { ok: openEnded.ok, ledger: (openEnded.data?.ledger ?? []).map(l => ({ status: l.status, message: l.message })), summary: openEnded.data?.summary ?? openEnded.data?.message ?? null } };
    if (mode !== 'ONLINE') assert.ok(openEnded.ok === false || (openEnded.data?.ledger ?? []).every(l => ['UNSUPPORTED', 'NEEDS_INPUT'].includes(l.status)), 'an open-ended request is declined, never escalated');
  }

  // Quick Reframe (manual path, no AI consent).
  let q = await api('/quick-reframe', 'POST', {}); const qid = q.id;
  const upload = await api(`/quick-reframe/${qid}/upload`, 'POST', { name: mediaName, size: media.length, mimeType: 'video/mp4' });
  for (let i = 0; i < upload.chunks; i++) {
    const r = await fetch(`${base}/quick-reframe/uploads/${upload.id}/chunks/${i}`, { method: 'PUT', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/octet-stream' },
      body: media.subarray(i * upload.chunkBytes, Math.min(media.length, (i + 1) * upload.chunkBytes)) });
    assert.ok(r.ok, 'quick reframe chunk');
  }
  await api(`/quick-reframe/uploads/${upload.id}/complete`, 'POST', {}); await api(`/quick-reframe/${qid}/playback`, 'POST', {});
  const active = ['PLAYBACK', 'ANALYZE', 'PREPARE', 'PREVIEW', 'EXPORT', 'IMPORT'];
  const settle = () => wait(() => api(`/quick-reframe/${qid}`), s => !active.includes(s.status), 'Quick Reframe');
  q = await settle(); await api(`/quick-reframe/${qid}/confirm-crop`, 'POST', { revision: q.revision }); q = await settle();
  await api(`/quick-reframe/${qid}/path`, 'POST', { revision: q.revision, path: 'MANUAL' }); q = await settle();
  const qh = await api(`/quick-reframe/${qid}/hooks`, 'POST', { externalAiAuthorized: false }); q = qh.session;
  report.checks.quickReframe = { hooks: q.hooks.map(h => ({ text: h.text, category: h.category, source: h.source })), warnings: qh.warnings };
  const qc = await api(`/quick-reframe/${qid}/post-copy`, 'POST', { revision: q.revision, version: q.postCopy.version, externalAiAuthorized: false }); q = qc.session;
  report.checks.quickReframe.postCopy = { synopsis: q.postCopy.synopsis, captions: q.postCopy.generatedCaptions, tags: q.postCopy.generatedHashtagSets };
  await api(`/quick-reframe/${qid}/export`, 'POST', { revision: q.revision, resolution: 720 }); q = await settle();
  assert.ok(q.exports?.[0]?.current, 'Quick Reframe export'); await download(q.exports[0].url, `${tag}-quick-reframe.mp4`);
  if (index === 1 && process.env.XEEFREE_QA_QUICK_STYLES === '1') {
    report.checks.quickReframe.styles = {};
    for (const [endpoint, style] of [['styleone', 'StyleOne'], ['styletwo', 'StyleTwo']]) {
      await api(`/quick-reframe/${qid}/${endpoint}`, 'POST', { revision: q.revision, captions: 'GENERATE' }); q = await settle();
      await api(`/quick-reframe/${qid}/export`, 'POST', { revision: q.revision, resolution: 720 }); q = await settle();
      assert(q.exports?.[0]?.current, `${style} Quick Reframe export`);
      await download(q.exports[0].url, `${tag}-quick-reframe-${style}.mp4`);
      report.checks.quickReframe.styles[style] = { preview: true, export: true };
    }
  }
  report.totalMs = Date.now() - started;
  return report;
}

(async () => {
  mkdirSync(out, { recursive: true });
  assertQaStack();
  const email = resume?.email || `xeefree-qa-${Date.now()}@example.invalid`;
  const user = resume ? await api('/auth/login', 'POST', { email, password: resume.password }) :
    await api('/auth/signup', 'POST', { email, password: randomBytes(24).toString('base64url'), displayName: 'Disposable XeeFree QA' });
  assert.equal(user.email, email);
  await api('/auth/preferences', 'PATCH', { aiProcessingConsent: mode === 'ONLINE' });
  // The disposable user starts with a small balance; top it up in the disposable QA database only (compose project xeeqa, never the production stack).
  topUpQaUser(user);
  const reports = [];
  for (const [index, mediaPath] of mediaList.entries()) {
    try { reports.push(await runSource(mediaPath, index + 1)); console.log(`ok   ${basename(mediaPath)}`); }
    catch (error) { reports.push({ ...(activeReport || { source: basename(mediaPath), mode }), error: error.message }); console.error(`FAIL ${basename(mediaPath)}: ${error.message}`); }
    writeFileSync(resolve(out, 'report.json'), JSON.stringify({ date: new Date().toISOString(), mode, reports }, null, 2));
  }
  assert.ok(reports.every(r => !r.error), 'every source completed');
  console.log(JSON.stringify({ mode, sources: reports.length, clips: reports.reduce((n, r) => n + r.clips.length, 0) }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
