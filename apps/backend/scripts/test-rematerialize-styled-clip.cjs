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
const { resolveClipStyleRequest, readClipStyleSnapshot, clipTemplateId, clipRequestKey, jobRequestKey, clipBelongsToJobRequest } =
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
const REQUESTED_AT = new Date('2026-10-10T10:00:00.000Z');
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

  const seed = ({ id, templateId, hookEnabled, jobId = 'job-1', start = 100, end = 112, requestedAt = REQUESTED_AT, variantKey }) => {
    const videoId = `video-${id}`;
    const video = { id: videoId, projectId: 'source-project', originalName: `${id}.mp4`, bucket: 'original-bucket',
      objectKey: `original/${videoId}.mp4`, mimeType: 'video/mp4', sizeBytes: 100000n, duration: 2700, fps: 30,
      width: 1920, height: 1080, codec: 'h264', hasVideo: true, hasAudio: true,
      transcript: { segments: [{ start: 100, end: 112, text: 'One clear idea survives this edit', words: WORDS }] } };
    const clip = { id, videoId, video, sourceProjectId: 'source-project', candidateId: `candidate-${id}`,
      rangeKey: `${start}:${end}`, startTime: start, endTime: end, duration: 10, bucket: 'generated-bucket',
      objectKey: `generated/${id}.mp4`, mimeType: 'video/mp4', sizeBytes: 9n, width: 1080, height: 1920,
      codec: 'h264', processingType: 'EDITED_CLIPS', aspectRatio: '9:16', targetPlatform: 'YOUTUBE_SHORTS',
      variantKey: variantKey === undefined ? `EDITED_CLIPS:YOUTUBE_SHORTS:${templateId}:REQUEST:${jobId}:${requestedAt.toISOString()}` : variantKey, templateId, requestedTemplate: templateId,
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
  const setJob = (id, templateId, extra = {}, components = {}) => {
    const resolved = templateId === 'AUTOMATIC_1' ? resolveCreativeStyle({}) : resolveCreativeStyle({ templateId, components });
    rows.processingJobs.set(id, { id, generationSettings: { templateId, look: templateId, requestedTemplate: templateId,
      effectiveTemplate: templateId, components, interpreted: {}, resolved, referenceStyle: null, key: templateId },
    clipRequestedAt: REQUESTED_AT, ...extra });
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
    'resolutionSource', 'ref', 'elementId', 'ids'].includes(key) ? undefined : item));
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
  console.log('resolveClipStyleRequest: provenance, never recency');
  const one = resolveCreativeStyle({ templateId: 'AUTOMATIC_2' });
  const oneB = resolveCreativeStyle({ templateId: 'AUTOMATIC_2', components: { CAPTIONS: 'CAP_YELLOW_ACTIVE' } });
  const two = resolveCreativeStyle({ templateId: 'AUTOMATIC_3_STYLE_TWO' });
  const T0 = new Date('2026-10-01T00:00:00.000Z'), T1 = new Date('2026-10-05T00:00:00.000Z');
  const settings = (templateId, resolved) => ({ templateId, requestedTemplate: templateId, effectiveTemplate: templateId, resolved });
  const job = (templateId, resolved, at = T0, id = 'j') => ({ id, generationSettings: settings(templateId, resolved), clipRequestedAt: at });
  const key = (id, at) => `EDITED_CLIPS:YOUTUBE_SHORTS:AUTOMATIC_2:REQUEST:${id}:${at.toISOString()}`;
  const clip = (over = {}) => ({ generationJobId: 'j', templateId: 'AUTOMATIC_2', requestedTemplate: 'AUTOMATIC_2',
    effectiveTemplate: 'AUTOMATIC_2', variantKey: key('j', T0), editTelemetry: {}, ...over });
  const plain = JSON.stringify(resolveCreativeStyle({ templateId: 'AUTOMATIC_2' }));

  ok('the request key is read from the clip\'s variantKey', clipRequestKey(clip()) === 'j:' + T0.toISOString());
  ok('rows without a request segment have no request key', clipRequestKey({ variantKey: 'EDITED_CLIPS:YOUTUBE_SHORTS:AUTOMATIC_2' }) === null &&
    clipRequestKey({}) === null);
  ok('the job\'s request key is jobId:clipRequestedAt', jobRequestKey(job('AUTOMATIC_2', one)) === 'j:' + T0.toISOString() &&
    jobRequestKey({ id: 'j', clipRequestedAt: null }) === null);
  ok('provenance is tri-state: proven, disproven, unknown',
    clipBelongsToJobRequest(clip(), job('AUTOMATIC_2', one)) === true &&
    clipBelongsToJobRequest(clip(), job('AUTOMATIC_2', one, T1)) === false &&
    clipBelongsToJobRequest(clip({ variantKey: 'EDITED_CLIPS:YOUTUBE_SHORTS:AUTOMATIC_2' }), job('AUTOMATIC_2', one)) === null);

  // A. exact request provenance
  let r = resolveClipStyleRequest(clip(), job('AUTOMATIC_2', oneB));
  ok('A: exact request provenance uses that request\'s settings (components included)',
    r.source === 'EXACT_REQUEST' && r.templateId === 'AUTOMATIC_2' && r.resolved.components.CAPTIONS.styleId === 'CAP_YELLOW_ACTIVE');
  r = resolveClipStyleRequest(clip({ templateId: null, requestedTemplate: null, effectiveTemplate: null }), job('AUTOMATIC_2', oneB));
  ok('A: a legacy row without template fields takes the template of the request it provably belongs to', r.source === 'EXACT_REQUEST' && r.templateId === 'AUTOMATIC_2');

  // B. an unrelated NEWER request can never influence an older clip
  r = resolveClipStyleRequest(clip(), job('AUTOMATIC_2', oneB, T1));
  ok('B: a newer request with other components does not leak into an older clip',
    r.source === 'TEMPLATE_FALLBACK' && JSON.stringify(r.resolved) === plain && r.resolved.components.CAPTIONS.styleId !== 'CAP_YELLOW_ACTIVE');
  r = resolveClipStyleRequest(clip(), job('AUTOMATIC_3_STYLE_TWO', two, T1));
  ok('B: a newer request with another template does not change the older clip\'s template',
    r.source === 'TEMPLATE_FALLBACK' && r.templateId === 'AUTOMATIC_2' && r.resolved.templateId === 'AUTOMATIC_2');
  r = resolveClipStyleRequest(clip({ variantKey: key('another-job', T0) }), job('AUTOMATIC_2', oneB));
  ok('B: an identical timestamp on a different job is not the same request', r.source === 'TEMPLATE_FALLBACK');

  // C. no provenance => template fallback, no borrowing
  r = resolveClipStyleRequest(clip({ variantKey: 'EDITED_CLIPS:YOUTUBE_SHORTS:AUTOMATIC_2' }), job('AUTOMATIC_2', oneB));
  ok('C: no request provenance falls back to the clip\'s own template with default components',
    r.source === 'TEMPLATE_FALLBACK' && JSON.stringify(r.resolved) === plain);
  r = resolveClipStyleRequest(clip({ generationJobId: null, variantKey: null }), null);
  ok('C: no job at all still rebuilds the clip\'s own template', r.source === 'TEMPLATE_FALLBACK' && r.templateId === 'AUTOMATIC_2');

  // D. timestamps alone select nothing
  r = resolveClipStyleRequest(clip({ variantKey: 'EDITED_CLIPS:YOUTUBE_SHORTS:AUTOMATIC_2', updatedAt: new Date(T1.getTime() + 1000) }),
    job('AUTOMATIC_2', oneB, T0));
  ok('D: a clip updated after the request began, on the same job and template, is NOT adopted by it',
    r.source === 'TEMPLATE_FALLBACK' && r.resolved.components.CAPTIONS.styleId !== 'CAP_YELLOW_ACTIVE');

  // E. the snapshot outranks everything
  const snap = { snapshotVersion: 1, templateId: 'AUTOMATIC_2', styleHash: 'abc', requestKey: 'j:' + T0.toISOString(), resolved: oneB };
  r = resolveClipStyleRequest(clip({ editTelemetry: { generationStyle: snap } }), job('AUTOMATIC_2', one));
  ok('E: the clip snapshot beats an exact request that says otherwise', r.source === 'STYLE_SNAPSHOT' && r.resolved.components.CAPTIONS.styleId === 'CAP_YELLOW_ACTIVE');
  r = resolveClipStyleRequest(clip({ editTelemetry: { generationStyle: snap } }), job('AUTOMATIC_3_STYLE_TWO', two, T1));
  ok('E: the clip snapshot beats a job that has moved on to another template', r.source === 'STYLE_SNAPSHOT' && r.templateId === 'AUTOMATIC_2');
  r = resolveClipStyleRequest(clip({ templateId: 'AUTOMATIC_3_STYLE_TWO', requestedTemplate: 'AUTOMATIC_3_STYLE_TWO',
    effectiveTemplate: 'AUTOMATIC_3_STYLE_TWO', editTelemetry: { generationStyle: snap } }), null);
  ok('E: a snapshot of another template is ignored', r.source === 'TEMPLATE_FALLBACK' && r.templateId === 'AUTOMATIC_3_STYLE_TWO');
  ok('E: a malformed snapshot is ignored', readClipStyleSnapshot({ generationStyle: { snapshotVersion: 1, templateId: 'x' } }) === null &&
    readClipStyleSnapshot({ generationStyle: { ...snap, resolved: { styled: false, components: {} } } }) === null);

  // contradictions and non-styled clips
  r = resolveClipStyleRequest(clip(), job('AUTOMATIC_3_STYLE_TWO', two, T0));
  ok('a matching request key whose template contradicts the clip is not trusted', r.source === 'TEMPLATE_FALLBACK' && r.templateId === 'AUTOMATIC_2');
  ok('Automatic 1 without a styled request is plain', resolveClipStyleRequest(clip({ templateId: 'AUTOMATIC_1',
    requestedTemplate: 'AUTOMATIC_1', effectiveTemplate: 'AUTOMATIC_1' }), job('AUTOMATIC_1', resolveCreativeStyle({}))) === null);
  ok('raw / unknown templates are never styled', resolveClipStyleRequest(clip({ templateId: 'AUTOMATIC_RAW',
    requestedTemplate: 'AUTOMATIC_RAW', effectiveTemplate: 'AUTOMATIC_RAW' }), null) === null);
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
  ok(`${name}: the reconstruction source is recorded`, readGenerationStyle((await h.service.get(rebuilt.id)).settings).resolutionSource === 'STYLE_SNAPSHOT');
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

// Older clips: no snapshot, so the style must come from provable provenance or the clip's own template.
async function legacyClips() {
  const T0 = new Date('2026-10-10T10:00:00.000Z'), T1 = new Date('2026-10-12T10:00:00.000Z');
  const B = { CAPTIONS: 'CAP_YELLOW_ACTIVE' };
  const stripSnapshot = (h, id) => { const row = h.rows.generatedClips.get(id); const { generationStyle, ...rest } = row.editTelemetry; row.editTelemetry = rest; };
  const clipRow = (h, id) => ({ ...h.rows.generatedClips.get(id), candidate: null });
  const rebuild = async (h, clip) => {
    h.deleteProject(h.projectOf(clip.id).id);
    const opened = await h.styling.materializeStyled(clip.id); await h.settle(clip.id);
    return h.service.get(opened.editProjectId);
  };
  const stateOf = (project) => readGenerationStyle(project.settings);
  const canon = (h, project) => canonical(project, historyOf(h.rows, project.id));
  const captionsOf = (project) => project.elements.filter((e) => e.type === 'SUBTITLE').map((e) => e.properties.activeWord?.color);

  console.log('Legacy case A: no snapshot, exact originating request is provable');
  {
    const h = install();
    const clip = h.seed({ id: 'clip-la', templateId: 'AUTOMATIC_2', hookEnabled: false, requestedAt: T0 });
    const resolvedA = h.setJob('job-1', 'AUTOMATIC_2', { clipRequestedAt: T0 }, B);
    await h.styling.styleClip(clipRow(h, clip.id), resolvedA, 'AUTOMATIC_2');
    const original = await h.service.get(h.projectOf(clip.id).id);
    const before = canon(h, original);
    stripSnapshot(h, clip.id);
    ok('A: the original used the request\'s optional components', captionsOf(original).every((color) => color === '#ffd400'));
    const rebuilt = await rebuild(h, clip);
    assert.deepEqual(canon(h, rebuilt), before);
    ok('A: rebuilt from the exact originating request, identical to the original (components preserved)',
      stateOf(rebuilt).resolutionSource === 'EXACT_REQUEST' && headlines(rebuilt).length === 1);
    ok('A: a proven request is trusted enough to become the clip\'s snapshot', readClipStyleSnapshot(h.rows.generatedClips.get(clip.id).editTelemetry)?.requestKey === `job-1:${T0.toISOString()}`);
  }

  console.log('Legacy case B: no snapshot, no request provenance');
  {
    const h = install();
    const clip = h.seed({ id: 'clip-lb', templateId: 'AUTOMATIC_2', hookEnabled: false, variantKey: 'EDITED_CLIPS:YOUTUBE_SHORTS:AUTOMATIC_2' });
    const plainResolved = resolveCreativeStyle({ templateId: 'AUTOMATIC_2' });
    await h.styling.styleClip(clipRow(h, clip.id), plainResolved, 'AUTOMATIC_2', { snapshot: false });
    const original = await h.service.get(h.projectOf(clip.id).id);
    const before = canon(h, original);
    h.setJob('job-1', 'AUTOMATIC_2', { clipRequestedAt: T1 }, B); // the video has since had a request with other components
    ok('B: the clip carries no snapshot and no request key', !readClipStyleSnapshot(h.rows.generatedClips.get(clip.id).editTelemetry) && clipRequestKey(clip) === null);
    const rebuilt = await rebuild(h, clip);
    assert.deepEqual(canon(h, rebuilt), before);
    ok('B: falls back to the clip\'s own template with default components, identical to its original',
      stateOf(rebuilt).resolutionSource === 'TEMPLATE_FALLBACK' && captionsOf(rebuilt).every((color) => color !== '#ffd400'));
    ok('B: a fallback is never frozen as the clip\'s authoritative snapshot', !readClipStyleSnapshot(h.rows.generatedClips.get(clip.id).editTelemetry));
    const again = await rebuild(h, clip);
    ok('B: and stays stable on every later rebuild', stateOf(again).resolutionSource === 'TEMPLATE_FALLBACK' && JSON.stringify(canon(h, again).elements) === JSON.stringify(before.elements));
    // a persisted style's hash is not reproducible from code (key order / float digits change in the database),
    // so a fallback must not treat a differing hash as a reason to restyle a completed project
    const settled = h.projectOf(clip.id);
    h.rows.editProjects.set(settled.id, { ...settled, settings: { ...settled.settings,
      generationStyle: { ...settled.settings.generationStyle, styleHash: 'hash-from-the-persisted-request' } } });
    const revisionBefore = (await h.service.get(settled.id)).revision, historyBefore = historyOf(h.rows, settled.id).length;
    await h.styling.retryClip(clip.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterRetry = await h.service.get(settled.id);
    ok('B: retry-style on a fallback never restyles a project that already has a completed style (even if the hash differs)',
      afterRetry.revision === revisionBefore && historyOf(h.rows, settled.id).length === historyBefore &&
      headlines(afterRetry).length === 1 && readGenerationStyle(afterRetry.settings).styleHash === 'hash-from-the-persisted-request');
  }

  console.log('Legacy case: an unrelated NEWER request exists (old clip StyleOne/default, latest request StyleOne/B)');
  {
    const h = install();
    const oldClip = h.seed({ id: 'clip-old', templateId: 'AUTOMATIC_2', hookEnabled: false, requestedAt: T0, start: 100, end: 112 });
    const resolvedOld = h.setJob('job-1', 'AUTOMATIC_2', { clipRequestedAt: T0 });
    // generated the way every pre-fix clip was: no snapshot was ever written for it
    await h.styling.styleClip(clipRow(h, oldClip.id), resolvedOld, 'AUTOMATIC_2', { snapshot: false });
    const oldOriginal = canon(h, await h.service.get(h.projectOf(oldClip.id).id));
    // a later request on the same video rewrites the job's settings and request time
    const newClip = h.seed({ id: 'clip-new', templateId: 'AUTOMATIC_2', hookEnabled: false, requestedAt: T1 });
    const resolvedNew = h.setJob('job-1', 'AUTOMATIC_2', { clipRequestedAt: T1 }, B);
    await h.styling.styleClip(clipRow(h, newClip.id), resolvedNew, 'AUTOMATIC_2');
    const newOriginal = canon(h, await h.service.get(h.projectOf(newClip.id).id));
    ok('the two requests really did style differently', JSON.stringify(oldOriginal.elements) !== JSON.stringify(newOriginal.elements));
    stripSnapshot(h, oldClip.id); stripSnapshot(h, newClip.id);
    const oldRebuilt = await rebuild(h, oldClip);
    assert.deepEqual(canon(h, oldRebuilt), oldOriginal);
    ok('the old clip is rebuilt as it was: the newer request\'s components are NOT applied',
      stateOf(oldRebuilt).resolutionSource === 'TEMPLATE_FALLBACK' && captionsOf(oldRebuilt).every((color) => color !== '#ffd400'));
    const newRebuilt = await rebuild(h, newClip);
    assert.deepEqual(canon(h, newRebuilt), newOriginal);
    ok('the newer clip, which provably belongs to that request, still gets its own components',
      stateOf(newRebuilt).resolutionSource === 'EXACT_REQUEST' && captionsOf(newRebuilt).every((color) => color === '#ffd400'));
  }

  console.log('Legacy case C: an existing project that an older build left unstyled');
  {
    const h = install();
    const clip = h.seed({ id: 'clip-lc', templateId: 'AUTOMATIC_2', hookEnabled: false, requestedAt: T0 });
    const resolved = h.setJob('job-1', 'AUTOMATIC_2', { clipRequestedAt: T0 });
    await h.materializer.materialize(clip.id); // exactly what the pre-fix endpoint did
    const bare = h.projectOf(clip.id);
    const bareHistory = historyOf(h.rows, bare.id).length;
    const reopened = await h.styling.materializeStyled(clip.id);
    const after = await h.service.get(reopened.editProjectId);
    ok('C: reopening leaves the existing unstyled project untouched (no automatic restyle)',
      reopened.editProjectId === bare.id && after.revision === 1 && headlines(after).length === 0 &&
      readGenerationStyle(after.settings) === null && historyOf(h.rows, bare.id).length === bareHistory);
    await h.styling.retryClip(clip.id);
    await h.settle(clip.id);
    const restored = await h.service.get(bare.id);
    ok('C: retry-style remains the explicit recovery path', headlines(restored).length === 1 && restored.revision === 2 &&
      readGenerationStyle(restored.settings).resolutionSource === 'EXACT_REQUEST');
    void resolved;
  }

  console.log('retry-style uses the clip\'s own style');
  {
    const h = install();
    const clip = h.seed({ id: 'clip-rs', templateId: 'AUTOMATIC_2', hookEnabled: false, requestedAt: T0 });
    const resolvedOne = h.setJob('job-1', 'AUTOMATIC_2', { clipRequestedAt: T0 });
    await h.styling.styleClip(clipRow(h, clip.id), resolvedOne, 'AUTOMATIC_2');
    const original = canon(h, await h.service.get(h.projectOf(clip.id).id));
    h.setJob('job-1', 'AUTOMATIC_3_STYLE_TWO', { clipRequestedAt: T1 }); // the video moved on to StyleTwo
    h.deleteProject(h.projectOf(clip.id).id);
    await h.materializer.materialize(clip.id);
    await h.styling.retryClip(clip.id);
    await h.settle(clip.id);
    const restored = await h.service.get(h.projectOf(clip.id).id);
    assert.deepEqual(canon(h, restored), original);
    ok('retry-style restores the clip as StyleOne even though the latest request is StyleTwo',
      readGenerationStyle(restored.settings).templateId === 'AUTOMATIC_2' && readGenerationStyle(restored.settings).resolutionSource === 'STYLE_SNAPSHOT');
  }

  console.log('Snapshot hygiene');
  {
    const h = install();
    const clip = h.seed({ id: 'clip-sh', templateId: 'AUTOMATIC_2', hookEnabled: false, requestedAt: T0 });
    const resolved = h.setJob('job-1', 'AUTOMATIC_2', { clipRequestedAt: T0 });
    await h.styling.styleClip(clipRow(h, clip.id), resolved, 'AUTOMATIC_2', { snapshot: false });
    ok('a pass run with snapshot:false writes no snapshot', !readClipStyleSnapshot(h.rows.generatedClips.get(clip.id).editTelemetry));
    h.deleteProject(h.projectOf(clip.id).id);
    await h.styling.styleClip(clipRow(h, clip.id), resolved, 'AUTOMATIC_2');
    const snapshot = readClipStyleSnapshot(h.rows.generatedClips.get(clip.id).editTelemetry);
    ok('the default pass records the resolved style, its template, hash and originating request',
      snapshot && snapshot.templateId === 'AUTOMATIC_2' && snapshot.requestKey === `job-1:${T0.toISOString()}` && snapshot.resolved.styled === true);
    ok('the snapshot holds only what a rebuild needs (no brief, reference or provider state)',
      JSON.stringify(Object.keys(h.rows.generatedClips.get(clip.id).editTelemetry.generationStyle).sort()) === JSON.stringify(['requestKey', 'resolved', 'snapshotVersion', 'styleHash', 'templateId']));
  }

  console.log('Missing clip');
  {
    const h = install();
    await assert.rejects(() => h.styling.materializeStyled('missing-clip'), (error) => /not found/i.test(error.message));
    ok('a missing clip is still a 404');
  }
}

(async () => {
  unitTests();
  await styleZero();
  await reconstructionCycle('StyleOne', 'AUTOMATIC_2');
  await reconstructionCycle('StyleTwo', 'AUTOMATIC_3_STYLE_TWO');
  await legacyClips();
  console.log(`Rematerialization checks passed: ${checks}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
