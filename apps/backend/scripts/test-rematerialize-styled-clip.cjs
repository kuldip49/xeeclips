// GeneratedClip -> EditProject must be the SAME canonical project whether it is materialized during
// generation or rebuilt later because its EditProject was deleted. In-memory harness: the real
// adapter, styling compiler, edit-mode service and render-plan validation; only the renderer is faked.
const assert = require('node:assert/strict');
process.env.EDIT_MODE_CHAT_PROPOSAL_REDIS = 'false';
process.env.EDIT_MODE_CHAT_AI_MODE = 'FALLBACK_ONLY';
const { readFile, writeFile } = require('node:fs/promises');
const { GeneratedClipEditProjectMaterializerService } =
  require('../dist/modules/edit-mode/generated-clip-edit-project-materializer.service.js');
const { GenerationStylingService, readGenerationStyle } =
  require('../dist/modules/edit-mode/styles/generation-styling.service.js');
const { resolveClipStyleRequest, readClipStyleSnapshot, clipTemplateId } =
  require('../dist/modules/edit-mode/styles/clip-style-request.js');
const { resolveCreativeStyle } = require('../dist/modules/edit-mode/styles/creative-style-resolver.js');
const { buildRenderPlan } = require('../dist/modules/edit-mode/render/edit-mode-render-plan.js');
const { validateRenderPlan, validateHeadlineFit } =
  require('../dist/modules/edit-mode/render/edit-mode-render-validate.js');
const { buildEditModeAss } = require('../dist/modules/edit-mode/render/edit-mode-ass.js');
const { createHarness } = require('./test-edit-mode-isolation.cjs');
const { EditChatService } = require('../dist/modules/edit-mode/chat/edit-chat.service.js');
const { EditChatProposalStore } = require('../dist/modules/edit-mode/chat/edit-chat-proposal-store.js');
const { EditTemplateService } = require('../dist/modules/edit-mode/edit-template.service.js');

let checks = 0;
const ok = (label, condition = true) => { assert(condition, label); checks++; console.log('  ok ' + label); };
const HOOK = 'Three years ago I lost my biggest client overnight';
const SUPPORT = 'The call that rebuilt how this whole team sells';
const WORDS = [['One', 100], ['clear', 100.5], ['idea', 101], ['survives', 106], ['this', 106.5], ['edit', 107]]
  .map(([text, start]) => ({ start, end: start + 0.5, text }));
const visualAnalysis = { source: 'DENSE', frames: [{ t: 101, faces: [{ x: .1, y: .1, w: .2, h: .3,
  confidence: .9, trackId: 'speaker-1' }], persons: [], textBoxes: [], ocrLines: [], textCoverage: 0 }],
shotBoundaries: [], ocrText: '' };

function install() {
  const h = createHarness();
  const { prisma, rows, storage } = h;
  const objects = new Map();
  const originalCreate = prisma.editProject.create;
  const originalFindUnique = prisma.editProject.findUnique;
  prisma.project = { findUniqueOrThrow: async () => ({ userId: 'test-user' }) };
  prisma.editProject.create = async ({ data }) => {
    if (!data.generatedClipId) return originalCreate({ data });
    for (const project of rows.editProjects.values()) if (project.generatedClipId === data.generatedClipId) {
      const error = new Error('Unique constraint failed'); error.code = 'P2002'; throw error;
    }
    const now = new Date();
    const project = { id: data.id, name: data.name, sourceProjectId: data.sourceProjectId ?? null,
      generatedClipId: data.generatedClipId, originalVideoId: data.originalVideoId ?? null,
      status: data.status, settings: data.settings, revision: data.revision, createdAt: now, updatedAt: now };
    rows.editProjects.set(project.id, project);
    for (const value of [].concat(data.assets.create)) rows.editAssets.set(value.id,
      { ...value, transcript: value.transcript ?? null, analysis: value.analysis ?? null,
        editProjectId: project.id, createdAt: now, updatedAt: now });
    for (const value of [].concat(data.elements.create)) rows.editElements.set(value.id,
      { ...value, editProjectId: project.id, createdAt: now, updatedAt: now });
    for (const history of data.history.create) await prisma.editHistory.create({
      data: { ...history, editProjectId: project.id } });
    return { ...project };
  };
  prisma.editProject.findUnique = async (args) => {
    if (args.where.generatedClipId) {
      const row = [...rows.editProjects.values()].find((p) => p.generatedClipId === args.where.generatedClipId);
      return row ? originalFindUnique({ ...args, where: { id: row.id } }) : null;
    }
    return originalFindUnique(args);
  };
  prisma.generatedClip = {
    findUnique: async ({ where }) => {
      const clip = rows.generatedClips.get(where.id);
      if (!clip) return null;
      const project = [...rows.editProjects.values()].find((item) => item.generatedClipId === clip.id);
      return { ...clip, candidate: null, editProject: project ? { id: project.id } : null };
    },
    update: async ({ where, data }) => {
      const clip = rows.generatedClips.get(where.id);
      Object.assign(clip, data, { updatedAt: new Date() }); return { ...clip };
    }
  };
  prisma.processingJob = {
    findUnique: async ({ where }) => rows.processingJobs.get(where.id) ?? null,
    findFirst: async () => [...rows.processingJobs.values()].find((job) => job.generationSettings) ?? null
  };
  const history = prisma.editHistory;
  prisma.editHistory = { ...history, count: async ({ where }) => [...rows.editHistory.values()].filter((row) =>
    row.editProjectId === where.editProjectId && !where.action.notIn.includes(row.action)).length };
  storage.downloadToFile = async (bucket, key, file) => {
    const bytes = objects.get(`${bucket}/${key}`); if (!bytes) throw new Error('missing object');
    await writeFile(file, bytes);
  };
  storage.uploadFile = async ({ filePath, objectKey }) => {
    objects.set(`test-bucket/${objectKey}`, await readFile(filePath)); return { bucket: 'test-bucket', objectKey };
  };
  storage.statObject = async (bucket, key) => {
    const bytes = objects.get(`${bucket}/${key}`); if (!bytes) throw new Error('missing object');
    return { size: bytes.length };
  };
  storage.removeObject = async (bucket, key) => { objects.delete(`${bucket}/${key}`); };

  const materializer = new GeneratedClipEditProjectMaterializerService(prisma, storage, h.service);
  const chat = new EditChatService(prisma, h.service, new EditChatProposalStore(),
    { isAnyConfigured: () => false, generate: async () => { throw new Error('no model'); } },
    new EditTemplateService(prisma, h.service));
  let exportCount = 0;
  const render = {
    startExport: async () => ({ export: { exportId: 'export-' + (++exportCount), phase: 'COMPLETED' } }),
    progress: async () => ({ phase: 'COMPLETED' }),
    listExports: async () => [{ id: 'export-asset-' + exportCount, current: true }]
  };
  const styling = new GenerationStylingService(prisma, materializer, h.service, chat, render);
  styling.logger = { log() {}, warn() {} };

  const seed = ({ id, templateId, hookEnabled, jobId = 'job-1', start = 100, end = 112 }) => {
    const videoId = `video-${id}`;
    const video = { id: videoId, projectId: 'source-project', originalName: `${id}.mp4`, bucket: 'original-bucket',
      objectKey: `original/${videoId}.mp4`, mimeType: 'video/mp4', sizeBytes: 100000n, duration: 2700, fps: 30,
      width: 1920, height: 1080, codec: 'h264', hasVideo: true, hasAudio: true,
      transcript: { segments: [{ start: 100, end: 112, text: 'One clear idea survives this edit', words: WORDS }] } };
    const clip = { id, videoId, video, sourceProjectId: 'source-project', candidateId: `candidate-${id}`,
      rangeKey: `${start}:${end}`, startTime: start, endTime: end, duration: 10, bucket: 'generated-bucket',
      objectKey: `generated/${id}.mp4`, mimeType: 'video/mp4', sizeBytes: 9n, width: 1080, height: 1920,
      codec: 'h264', processingType: 'EDITED_CLIPS', aspectRatio: '9:16', targetPlatform: 'YOUTUBE_SHORTS',
      variantKey: `EDITED_CLIPS:${templateId}`, templateId, requestedTemplate: templateId,
      effectiveTemplate: templateId, generationJobId: jobId, styleVariant: templateId,
      createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(),
      editPlan: { version: 1, clipStartSec: start, clipEndSec: end, aspectRatio: '9:16',
        openingStrategy: { hookStartSec: start, removeWeakLeadIn: false, reason: 'Context' },
        endingStrategy: { payoffEndSec: end, reason: 'Payoff' }, musicMood: 'NONE', preserveInformation: false,
        onScreenHook: hookEnabled ? { enabled: true, text: 'One clear idea', startSec: 100, endSec: 103,
          position: 'TOP', style: 'CLEAN' } : { enabled: false, text: '', startSec: 100, endSec: 100,
          position: 'TOP', style: 'CLEAN' },
        operations: [], retentionMoments: [], onScreenText: [], subtitleStyle: { enabled: true,
          template: 'EDUCATION_CLEAN', position: 'BOTTOM', maxWordsPerLine: 5, highlightCurrentWord: true,
          animationStyle: 'WORD_HIGHLIGHT' }, subtitleTheme: 'CLEAN_WHITE', subtitleEmphasis: [],
        platformPreset: 'YOUTUBE_SHORTS', gradePreset: 'CLEAN_SOCIAL',
        audio: { normalize: false, removeLongPauses: true }, pacingNotes: [] },
      editTelemetry: { timelineSegments: [{ sourceStart: 100, sourceEnd: 104, finalStart: 0, finalEnd: 4 },
        { sourceStart: 106, sourceEnd: 112, finalStart: 4, finalEnd: 10 }],
      zoomEvents: [{ startSec: 4.3, endSec: 6, peakScale: 1.1, focusX: 0.5, focusY: 0.45,
        triggerText: 'survives', semanticReason: 'Key claim' }],
      grading: { selectedPreset: 'CLEAN_SOCIAL' }, reframeSource: 'FACE', visualAnalysis },
      contentPackaging: { sharedPackage: { selectedHook: HOOK, supportingLine: SUPPORT,
        hooks: [{ text: HOOK, category: 'CURIOSITY' }, { text: 'Why one call changed everything', category: 'QUESTION' }] } } };
    rows.generatedClips.set(id, clip);
    objects.set(`${clip.bucket}/${clip.objectKey}`, Buffer.from('fake-mp4!'));
    objects.set(`${video.bucket}/${video.objectKey}`, Buffer.from('fake-original-video'));
    return clip;
  };
  const setJob = (id, templateId, extra = {}) => {
    const resolved = templateId === 'AUTOMATIC_1' ? resolveCreativeStyle({}) : resolveCreativeStyle({ templateId });
    rows.processingJobs.set(id, { id, generationSettings: { templateId, look: templateId, requestedTemplate: templateId,
      effectiveTemplate: templateId, components: {}, interpreted: {}, resolved, referenceStyle: null, key: templateId },
    clipRequestedAt: new Date(Date.now() - 120_000), ...extra });
    return resolved;
  };
  const deleteProject = (projectId) => {
    rows.editProjects.delete(projectId);
    for (const [key, row] of rows.editAssets) if (row.editProjectId === projectId) rows.editAssets.delete(key);
    for (const [key, row] of rows.editElements) if (row.editProjectId === projectId) rows.editElements.delete(key);
    for (const [key, row] of rows.editHistory) if (row.editProjectId === projectId) rows.editHistory.delete(key);
  };
  const projectOf = (clipId) => [...rows.editProjects.values()].find((p) => p.generatedClipId === clipId);
  const settle = async (clipId) => {
    for (let i = 0; i < 200; i++) {
      const state = readGenerationStyle(projectOf(clipId)?.settings);
      if (state && ['EXPORT_READY', 'READY', 'STYLE_FAILED'].includes(state.status) && !styling.exporting.size) return state;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('style never settled');
  };
  return { ...h, objects, seed, setJob, deleteProject, projectOf, settle, materializer, styling, rows, prisma };
}

// Canonical, id-free view of a project: what the editor and the renderer actually see.
const strip = (value) => JSON.parse(JSON.stringify(value, (key, item) =>
  ['id', 'editProjectId', 'createdAt', 'updatedAt', 'assetId', 'sourceAssetId', 'startedAt', 'exportAssetId',
    'reconstruction', 'ref', 'elementId', 'ids'].includes(key) ? undefined : item));
const canonical = (project, history) => ({
  elements: project.elements.map((e) => strip({ type: e.type, track: e.track, position: e.position,
    startTime: e.startTime, duration: e.duration, trimStart: e.trimStart, trimEnd: e.trimEnd,
    properties: e.properties })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  settings: strip(project.settings), revision: project.revision,
  history: history.map((row) => row.action)
});
const historyOf = (rows, projectId) => [...rows.editHistory.values()].filter((row) => row.editProjectId === projectId)
  .sort((a, b) => a.revision - b.revision);
const headlines = (project) => project.elements.filter((e) => e.type === 'TEXT' &&
  String(e.properties.templateRole ?? e.properties.presetRole) === 'HOOK');
function exportPlan(project) {
  const plan = buildRenderPlan({ project, assets: project.assets, elements: project.elements }).plan;
  validateRenderPlan(plan, { assets: project.assets });
  const ass = buildEditModeAss(plan.canvas, [...plan.textOverlays, ...plan.subtitles]);
  validateHeadlineFit(project.elements, ass.overflowed);
  return plan;
}

function unitTests() {
  console.log('resolveClipStyleRequest');
  const two = resolveCreativeStyle({ templateId: 'AUTOMATIC_3_STYLE_TWO' });
  const settings = (templateId, resolved) => ({ templateId, requestedTemplate: templateId, effectiveTemplate: templateId, resolved });
  const job = (id, templateId, resolved, at = new Date('2026-10-01T00:00:00Z')) =>
    ({ id, generationSettings: settings(templateId, resolved), clipRequestedAt: at });
  const clip = (over = {}) => ({ generationJobId: 'j', templateId: 'AUTOMATIC_2', requestedTemplate: 'AUTOMATIC_2',
    effectiveTemplate: 'AUTOMATIC_2', editTelemetry: {}, updatedAt: new Date('2026-10-02T00:00:00Z'), ...over });
  const one = resolveCreativeStyle({ templateId: 'AUTOMATIC_2' });
  let r = resolveClipStyleRequest(clip(), job('j', 'AUTOMATIC_2', one));
  ok("request settings are used for a clip of the current request", r.source === "REQUEST_SETTINGS" && r.templateId === "AUTOMATIC_2" && !!r.resolved);
  const snap = { snapshotVersion: 1, templateId: 'AUTOMATIC_2', styleHash: 'abc', resolved: one };
  r = resolveClipStyleRequest(clip({ editTelemetry: { generationStyle: snap } }), job('j', 'AUTOMATIC_3_STYLE_TWO', two));
  ok('a clip snapshot beats a job that has since moved on to another template', r.source === 'CLIP_SNAPSHOT' && r.templateId === 'AUTOMATIC_2');
  r = resolveClipStyleRequest(clip({ generationJobId: 'j' }), job('j', 'AUTOMATIC_3_STYLE_TWO', two));
  ok('a clip is never restyled with another request\'s template (own template, default components)',
    r.source === 'TEMPLATE_DEFAULT' && r.templateId === 'AUTOMATIC_2' && r.resolved.templateId === 'AUTOMATIC_2');
  r = resolveClipStyleRequest(clip({ updatedAt: new Date('2026-09-01T00:00:00Z') }), job('j', 'AUTOMATIC_2', one));
  ok('a clip older than the job\'s current request does not inherit its components', r.source === 'TEMPLATE_DEFAULT');
  r = resolveClipStyleRequest(clip({ generationJobId: null }), null);
  ok('no job at all still rebuilds the clip\'s own template', r.source === 'TEMPLATE_DEFAULT' && r.templateId === 'AUTOMATIC_2');
  ok('Automatic 1 without a styled request is plain', resolveClipStyleRequest(clip({ templateId: 'AUTOMATIC_1',
    requestedTemplate: 'AUTOMATIC_1', effectiveTemplate: 'AUTOMATIC_1' }), job('j', 'AUTOMATIC_1', resolveCreativeStyle({}))) === null);
  ok('raw / unknown templates are never styled', resolveClipStyleRequest(clip({ templateId: 'AUTOMATIC_RAW',
    requestedTemplate: 'AUTOMATIC_RAW', effectiveTemplate: 'AUTOMATIC_RAW' }), null) === null);
  ok('a malformed snapshot is ignored', readClipStyleSnapshot({ generationStyle: { snapshotVersion: 1, templateId: 'x' } }) === null);
  ok('template identity comes from the clip row', clipTemplateId({ templateId: 'A', requestedTemplate: 'B', effectiveTemplate: 'C' }) === 'C');
}

async function reconstructionCycle(name, templateId) {
  console.log(`${name} (${templateId}): generate -> capture -> delete project -> reopen -> compare`);
  const h = install();
  const clip = h.seed({ id: `clip-${name}`, templateId, hookEnabled: false });
  const resolved = h.setJob('job-1', templateId);
  const row = () => h.rows.generatedClips.get(clip.id);

  // A. original generation: base materialization + the styling pass
  const state = await h.styling.styleClip({ ...row(), candidate: null }, resolved, templateId);
  ok(`${name}: generation styling reached EXPORT_READY`, state.status === 'EXPORT_READY');
  const original = await h.service.get(h.projectOf(clip.id).id);
  const originalHistory = historyOf(h.rows, original.id);
  const originalHeadline = headlines(original);
  ok(`${name}: styled project has the headline from the clip's own package`,
    originalHeadline.length === 1 && originalHeadline[0].properties.content === HOOK);
  ok(`${name}: the headline came from the styling revision, not the base materialization`,
    originalHistory.map((r) => r.action).length === 3 && original.revision === 2 && row().editPlan.onScreenHook.enabled === false);
  ok(`${name}: the exact resolved style was persisted on the clip`, readClipStyleSnapshot(row().editTelemetry)?.templateId === templateId);
  const before = canonical(original, originalHistory);
  exportPlan(original);

  // B. EditProject deleted, then reopened through the single entry point
  h.deleteProject(original.id);
  const reopened = await h.styling.materializeStyled(clip.id);
  const rebuilt = await h.service.get(reopened.editProjectId);
  ok(`${name}: a NEW canonical project was created`, rebuilt.id !== original.id && reopened.revision === 2);
  const settled = await h.settle(clip.id);
  ok(`${name}: rebuilt project is marked reconstructed, then exports in the background`, settled.status === 'EXPORT_READY');
  const after = canonical(await h.service.get(rebuilt.id), historyOf(h.rows, rebuilt.id));
  ok(`${name}: headline count > 0`, headlines(rebuilt).length === 1);
  ok(`${name}: headline text/timing/layout equal the original`,
    JSON.stringify(strip(headlines(rebuilt)[0])) === JSON.stringify(strip(originalHeadline[0])));
  assert.deepEqual(after.elements.length, before.elements.length);
  assert.deepEqual(after.elements, before.elements);
  ok(`${name}: every element (type, timing, properties) is identical`, true);
  ok(`${name}: revision and history actions are identical (styling is one TEMPLATE revision, not a user edit)`,
    after.revision === before.revision && JSON.stringify(after.history) === JSON.stringify(before.history));
  assert.deepEqual(after.settings, before.settings);
  ok(`${name}: settings (style state, origin, layout, camera) are identical`, true);
  ok(`${name}: the reconstruction source is recorded`, readGenerationStyle((await h.service.get(rebuilt.id)).settings).reconstruction === 'CLIP_SNAPSHOT');
  exportPlan(await h.service.get(rebuilt.id));
  ok(`${name}: the rebuilt project compiles to a valid export plan`, true);

  // C. idempotency and ownership
  const historyBefore = historyOf(h.rows, rebuilt.id).length;
  const again = await h.styling.materializeStyled(clip.id);
  const second = await h.styling.styleClip({ ...row(), candidate: null }, resolved, templateId);
  ok(`${name}: reopening / restyling again changes nothing (no duplicate headline, revision or history)`,
    again.editProjectId === rebuilt.id && second.status === 'EXPORT_READY' &&
    headlines(await h.service.get(rebuilt.id)).length === 1 && historyOf(h.rows, rebuilt.id).length === historyBefore);

  // D. user edits survive reopening and are never restyled
  let p = await h.service.get(rebuilt.id);
  p = await h.service.phase3Command(p.id, 'set-text-content', { revision: p.revision,
    elementId: headlines(p)[0].id, content: 'My own headline' });
  const edited = p.revision;
  const reopenedEdited = await h.styling.materializeStyled(clip.id);
  await h.styling.styleClip({ ...row(), candidate: null }, resolved, templateId);
  const kept = await h.service.get(rebuilt.id);
  ok(`${name}: a manual headline edit survives reopening and a later style pass`,
    reopenedEdited.editProjectId === rebuilt.id && headlines(kept)[0].properties.content === 'My own headline' &&
    kept.revision === edited && headlines(kept).length === 1);

  // E. concurrent opens of a missing project converge on one styled project
  h.deleteProject(rebuilt.id);
  const [a, b, c] = await Promise.all([h.styling.materializeStyled(clip.id), h.styling.materializeStyled(clip.id),
    h.styling.styleClip({ ...row(), candidate: null }, resolved, templateId).then(() => h.styling.materializeStyled(clip.id))]);
  await h.settle(clip.id);
  const projects = [...h.rows.editProjects.values()].filter((x) => x.generatedClipId === clip.id);
  const concurrent = await h.service.get(projects[0].id);
  ok(`${name}: concurrent opens produce one project with one headline and one style revision`,
    projects.length === 1 && a.editProjectId === b.editProjectId && b.editProjectId === c.editProjectId &&
    headlines(concurrent).length === 1 && concurrent.revision === 2 && historyOf(h.rows, concurrent.id).length === 3);

  // F. retry-style restores a project left unstyled by the old behaviour, once
  h.deleteProject(concurrent.id);
  await h.materializer.materialize(clip.id); // what the pre-fix endpoint did: base only
  const bare = await h.service.get(h.projectOf(clip.id).id);
  ok(`${name}: (pre-fix state) a base-only project has no headline`, headlines(bare).length === 0 && bare.revision === 1);
  await h.styling.retryClip(clip.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await h.settle(clip.id);
  const retried = await h.service.get(bare.id);
  ok(`${name}: retry-style restores the headline and style`, headlines(retried).length === 1 && retried.revision === 2);
  await h.styling.retryClip(clip.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const retriedAgain = await h.service.get(bare.id);
  ok(`${name}: retry-style twice does not duplicate headline, elements or revisions`,
    headlines(retriedAgain).length === 1 && retriedAgain.revision === 2 &&
    retriedAgain.elements.length === retried.elements.length);

  // G. headline-fit validation still behaves on the rebuilt project
  let fit = retriedAgain;
  fit = await h.service.phase3Command(fit.id, 'set-text-size', { revision: fit.revision, elementId: headlines(fit)[0].id, fontSize: 300 });
  fit = await h.service.phase3Command(fit.id, 'resize-element', { revision: fit.revision, elementId: headlines(fit)[0].id, width: .03, height: .02 });
  assert.throws(() => exportPlan(fit), (error) => error.code === 'HEADLINE_DOES_NOT_FIT' && !error.message.includes('timeline'));
  ok(`${name}: a genuine overflow on the rebuilt project is HEADLINE_DOES_NOT_FIT`, true);
}

async function styleZero() {
  console.log('StyleZero (AUTOMATIC_1): plan carries the headline, no styling layer');
  const h = install();
  const clip = h.seed({ id: 'clip-zero', templateId: 'AUTOMATIC_1', hookEnabled: true });
  h.setJob('job-1', 'AUTOMATIC_1');
  const first = await h.styling.materializeStyled(clip.id);
  const original = await h.service.get(first.editProjectId);
  const before = canonical(original, historyOf(h.rows, original.id));
  h.deleteProject(original.id);
  const second = await h.styling.materializeStyled(clip.id);
  const rebuilt = await h.service.get(second.editProjectId);
  ok('StyleZero: headline survives delete + reopen', headlines(rebuilt).length === 1 && second.editProjectId !== original.id);
  assert.deepEqual(canonical(rebuilt, historyOf(h.rows, rebuilt.id)), before);
  ok('StyleZero: rebuilt project is canonically identical and gets no styling pass', readGenerationStyle(rebuilt.settings) === null && rebuilt.revision === 1);
  ok('StyleZero: no style snapshot is written for an unstyled clip', readClipStyleSnapshot(h.rows.generatedClips.get(clip.id).editTelemetry) === null);
  exportPlan(rebuilt);
}

async function identity() {
  console.log('Style identity: the clip keeps its own template');
  const h = install();
  const clip = h.seed({ id: 'clip-old', templateId: 'AUTOMATIC_2', hookEnabled: false, jobId: 'job-1' });
  // The video's job has since moved to a StyleTwo request; this clip belongs to an older StyleOne one.
  h.setJob('job-1', 'AUTOMATIC_3_STYLE_TWO');
  const opened = await h.styling.materializeStyled(clip.id);
  await h.settle(clip.id);
  const project = await h.service.get(opened.editProjectId);
  const state = readGenerationStyle(project.settings);
  ok('older StyleOne clip is rebuilt as StyleOne, not as the job\'s current StyleTwo',
    state.templateId === 'AUTOMATIC_2' && state.reconstruction === 'TEMPLATE_DEFAULT' && headlines(project).length === 1);
  ok('its StyleOne identity is now snapshotted for exact future rebuilds',
    readClipStyleSnapshot(h.rows.generatedClips.get(clip.id).editTelemetry).templateId === 'AUTOMATIC_2');
  h.deleteProject(project.id);
  h.rows.processingJobs.delete('job-1');
  const again = await h.styling.materializeStyled(clip.id);
  await h.settle(clip.id);
  ok('the rebuild no longer needs the job at all (snapshot)', readGenerationStyle((await h.service.get(again.editProjectId)).settings).reconstruction === 'CLIP_SNAPSHOT');
  await assert.rejects(() => h.styling.materializeStyled('missing-clip'), (error) => /not found/i.test(error.message));
  ok('a missing clip is still a 404');
}

(async () => {
  unitTests();
  await styleZero();
  await reconstructionCycle('StyleOne', 'AUTOMATIC_2');
  await reconstructionCycle('StyleTwo', 'AUTOMATIC_3_STYLE_TWO');
  await identity();
  console.log(`Rematerialization checks passed: ${checks}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
