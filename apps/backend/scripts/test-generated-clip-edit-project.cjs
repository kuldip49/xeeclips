const assert = require('node:assert/strict');
process.env.EDIT_MODE_CHAT_PROPOSAL_REDIS = 'false';
process.env.EDIT_MODE_CHAT_AI_MODE = 'FALLBACK_ONLY';
const { readFile, writeFile } = require('node:fs/promises');
const { GeneratedClipEditProjectMaterializerService } =
  require('../dist/modules/edit-mode/generated-clip-edit-project-materializer.service.js');
const { buildRenderPlan } =
  require('../dist/modules/edit-mode/render/edit-mode-render-plan.js');
const { buildOriginalSourceMap } =
  require('../dist/modules/edit-mode/generated-clip-lineage.js');
const { createHarness } = require('./test-edit-mode-isolation.cjs');
const { EditChatService } = require('../dist/modules/edit-mode/chat/edit-chat.service.js');
const { EditChatProposalStore } =
  require('../dist/modules/edit-mode/chat/edit-chat-proposal-store.js');
const { EditTemplateService } = require('../dist/modules/edit-mode/edit-template.service.js');

function installBridgeHarness() {
  const harness = createHarness();
  const { prisma, rows, storage } = harness;
  const originalCreate = prisma.editProject.create;
  const originalFindUnique = prisma.editProject.findUnique;
  const objects = new Map();

  prisma.editProject.create = async ({ data }) => {
    if (!data.generatedClipId) return originalCreate({ data });
    for (const project of rows.editProjects.values()) {
      if (project.generatedClipId === data.generatedClipId) {
        const error = new Error('Unique constraint failed');
        error.code = 'P2002';
        throw error;
      }
    }
    const now = new Date();
    const project = { id: data.id, name: data.name, sourceProjectId: data.sourceProjectId ?? null,
      generatedClipId: data.generatedClipId, originalVideoId: data.originalVideoId ?? null,
      status: data.status, settings: data.settings,
      revision: data.revision, createdAt: now, updatedAt: now };
    rows.editProjects.set(project.id, project);
    const assets = Array.isArray(data.assets.create) ? data.assets.create : [data.assets.create];
    for (const value of assets) {
      const asset = { ...value, transcript: value.transcript ?? null,
        analysis: value.analysis ?? null,
        editProjectId: project.id, createdAt: now, updatedAt: now };
      rows.editAssets.set(asset.id, asset);
    }
    const elements = Array.isArray(data.elements.create) ? data.elements.create :
      [data.elements.create];
    for (const value of elements) {
      const element = { ...value, editProjectId: project.id,
        createdAt: now, updatedAt: now };
      rows.editElements.set(element.id, element);
    }
    for (const history of data.history.create) {
      await prisma.editHistory.create({ data: { ...history, editProjectId: project.id } });
    }
    return { ...project };
  };
  prisma.editProject.findUnique = async (args) => {
    if (args.where.generatedClipId) {
      const row = [...rows.editProjects.values()].find((project) =>
        project.generatedClipId === args.where.generatedClipId);
      if (!row) return null;
      return originalFindUnique({ ...args, where: { id: row.id } });
    }
    return originalFindUnique(args);
  };
  prisma.generatedClip = {
    findUnique: async ({ where }) => {
      const clip = rows.generatedClips.get(where.id);
      if (!clip) return null;
      const project = [...rows.editProjects.values()].find((item) => item.generatedClipId === clip.id);
      return { ...clip, video: clip.video,
        editProject: project ? { id: project.id } : null };
    }
  };
  storage.downloadToFile = async (bucket, objectKey, filePath) => {
    const bytes = objects.get(`${bucket}/${objectKey}`);
    if (!bytes) throw new Error('missing object');
    await writeFile(filePath, bytes);
  };
  storage.uploadFile = async ({ filePath, objectKey }) => {
    const bytes = await readFile(filePath);
    objects.set(`test-bucket/${objectKey}`, bytes);
    return { bucket: 'test-bucket', objectKey };
  };
  storage.statObject = async (bucket, objectKey) => {
    const bytes = objects.get(`${bucket}/${objectKey}`);
    if (!bytes) throw new Error('missing object');
    return { size: bytes.length };
  };
  storage.removeObject = async (bucket, objectKey) => {
    storage.removed.push({ bucket, objectKey });
    objects.delete(`${bucket}/${objectKey}`);
  };

  const seedClip = (over) => {
    const videoId = `video-${over.id}`;
    const video = { id: videoId, projectId: 'source-project', originalName: `${over.id}-original.mp4`,
      bucket: 'original-bucket', objectKey: `original/${videoId}.mp4`, mimeType: 'video/mp4',
      sizeBytes: 100000n, duration: 2700, fps: 30, width: 1920, height: 1080,
      codec: 'h264', hasVideo: true, hasAudio: true,
      transcript: { segments: over.transcriptSegments ?? [] } };
    const startTime = over.startTime ?? 1112;
    const endTime = over.endTime ?? 1154;
    const duration = over.duration ?? 42;
    const clip = { id: over.id, videoId, video, sourceProjectId: 'source-project',
      candidateId: `candidate-${over.id}`, rangeKey: `${startTime.toFixed(3)}:${endTime.toFixed(3)}`,
      startTime, endTime, duration, bucket: 'generated-bucket',
      objectKey: `generated/${over.id}.mp4`, mimeType: 'video/mp4', sizeBytes: 9n,
      width: 1080, height: 1920, codec: 'h264', processingType: over.processingType,
      aspectRatio: '9:16', targetPlatform: 'YOUTUBE_SHORTS', variantKey: over.variantKey,
      templateId: over.templateId ?? null,
      editPlan: over.editPlan ?? null, editTelemetry: over.editTelemetry ?? null,
      contentPackaging: over.contentPackaging ?? null };
    rows.generatedClips.set(clip.id, clip);
    objects.set(`${clip.bucket}/${clip.objectKey}`, Buffer.from('fake-mp4!'));
    objects.set(`${video.bucket}/${video.objectKey}`, Buffer.from('fake-original-video'));
    return clip;
  };
  const materializer = new GeneratedClipEditProjectMaterializerService(prisma, storage,
    harness.service);
  return { ...harness, objects, seedClip, materializer };
}

async function main() {
  const h = installBridgeHarness();
  const normal = h.seedClip({ id: 'normal-clip', processingType: 'NORMAL_CLIPS',
    variantKey: 'NORMAL_CLIPS:YT' });
  const edited = h.seedClip({ id: 'edited-clip', processingType: 'EDITED_CLIPS',
    variantKey: 'EDITED_CLIPS:YT', editPlan: { cuts: [{ start: 10, end: 22 }] },
    editTelemetry: { editQualityStatus: 'PASSED' },
    contentPackaging: { title: 'A useful clip' } });
  const reconstructed = h.seedClip({ id: 'reconstructed-clip', processingType: 'EDITED_CLIPS',
    variantKey: 'EDITED_CLIPS:YT:RECONSTRUCTED', startTime: 100, endTime: 112, duration: 10,
    transcriptSegments: [{ start: 100, end: 112, text: 'One clear idea survives this edit',
      words: [{ start: 100, end: 100.5, text: 'One' },
        { start: 100.5, end: 101, text: 'clear' }, { start: 101, end: 101.5, text: 'idea' },
        { start: 106, end: 106.5, text: 'survives' }, { start: 106.5, end: 107, text: 'this' },
        { start: 107, end: 107.5, text: 'edit' }] }],
    editPlan: { version: 1, clipStartSec: 100, clipEndSec: 112, aspectRatio: '9:16',
      openingStrategy: { hookStartSec: 100, removeWeakLeadIn: false, reason: 'Context' },
      endingStrategy: { payoffEndSec: 112, reason: 'Payoff' }, musicMood: 'NONE',
      preserveInformation: false,
      onScreenHook: { enabled: true, text: 'One clear idea', startSec: 100, endSec: 103,
        position: 'TOP', style: 'CLEAN' }, operations: [], retentionMoments: [],
      onScreenText: [], subtitleStyle: { enabled: true, template: 'EDUCATION_CLEAN',
        position: 'BOTTOM', maxWordsPerLine: 5, highlightCurrentWord: true,
        animationStyle: 'WORD_HIGHLIGHT' }, subtitleTheme: 'CLEAN_WHITE',
      subtitleEmphasis: [], platformPreset: 'YOUTUBE_SHORTS', gradePreset: 'CLEAN_SOCIAL',
      audio: { normalize: false, removeLongPauses: true }, pacingNotes: [] },
    editTelemetry: { timelineSegments: [
      { sourceStart: 100, sourceEnd: 104, finalStart: 0, finalEnd: 4 },
      { sourceStart: 106, sourceEnd: 112, finalStart: 4, finalEnd: 10 }
    ], zoomEvents: [{ startSec: 4.3, endSec: 6, peakScale: 1.1, focusX: 0.5,
      focusY: 0.45, triggerText: 'survives', semanticReason: 'Key claim' }],
    grading: { selectedPreset: 'CLEAN_SOCIAL' }, reframeSource: 'FACE' } });
  const visualAnalysis = { source: 'DENSE', frames: [{ t: 101, faces: [
    { x: .1, y: .1, w: .2, h: .3, confidence: .9, trackId: 'speaker-1' }
  ], persons: [], textBoxes: [], ocrLines: [], textCoverage: 0 }],
    shotBoundaries: [], ocrText: '' };
  const automatic2 = h.seedClip({ id: 'automatic2-clip', processingType: 'EDITED_CLIPS',
    templateId: 'AUTOMATIC_2', variantKey: 'EDITED_CLIPS:A2', startTime: 100,
    endTime: 112, duration: 12, transcriptSegments: reconstructed.video.transcript.segments,
    editPlan: reconstructed.editPlan,
    editTelemetry: { ...reconstructed.editTelemetry, visualAnalysis } });
  const frozenCounts = { jobs: h.rows.processingJobs.size,
    candidates: h.rows.clipCandidates.size, clips: h.rows.generatedClips.size };

  const normalResult = await h.materializer.materialize(normal.id);
  const repeated = await h.materializer.materialize(normal.id);
  assert.equal(repeated.editProjectId, normalResult.editProjectId, 'repeat must return canonical project');
  assert.equal([...h.rows.editProjects.values()].filter((p) => p.generatedClipId === normal.id).length, 1);

  const [editedFirst, editedSecond] = await Promise.all([
    h.materializer.materialize(edited.id), h.materializer.materialize(edited.id)
  ]);
  assert.equal(editedFirst.editProjectId, editedSecond.editProjectId,
    'concurrent requests must converge on one project');
  assert.equal([...h.rows.editProjects.values()].filter((p) => p.generatedClipId === edited.id).length, 1);

  const reconstructedResult = await h.materializer.materialize(reconstructed.id);
  const reconstructedRepeat = await h.materializer.materialize(reconstructed.id);
  assert.equal(reconstructedRepeat.editProjectId, reconstructedResult.editProjectId,
    'a reconstructed edit must reopen the same project');
  let reconstructedProject = await h.service.get(reconstructedResult.editProjectId);
  assert.equal(reconstructedProject.settings.origin.reconstructionMode, 'CANONICAL');
  assert.equal(reconstructedProject.settings.origin.sourceMode, 'ORIGINAL_VIDEO');
  assert.equal(reconstructedProject.assets.filter((asset) => asset.role === 'SOURCE').length, 1);
  assert.equal(reconstructedProject.assets.filter((asset) => asset.role === 'REFERENCE').length, 1);
  assert.deepEqual(reconstructedProject.elements.filter((item) => item.type === 'VIDEO')
    .map((item) => [item.trimStart, item.trimEnd]), [[100, 104], [106, 112]]);
  assert(reconstructedProject.elements.some((item) => item.type === 'TEXT' &&
    item.properties.presetRole === 'HOOK'));
  assert(reconstructedProject.elements.some((item) => item.type === 'SUBTITLE'));
  assert(reconstructedProject.elements.some((item) => item.type === 'EFFECT'));
  const automatic2Result = await h.materializer.materialize(automatic2.id);
  const automatic2Project = await h.service.get(automatic2Result.editProjectId);
  assert.equal(automatic2Project.settings.origin.reconstructionMode, 'CANONICAL',
    JSON.stringify(automatic2Project.settings.origin.reconstructionFallback));
  assert.deepEqual(automatic2Project.assets.find((asset) => asset.role === 'SOURCE').analysis,
    visualAnalysis, 'Automatic 2 must retain source face tracks for the final camera');
  await assert.rejects(() => h.service.adjustSourceRange(reconstructedProject.id, {
    revision: reconstructedProject.revision, startDelta: -1
  }), (error) => error?.response?.code === 'COMPLEX_SOURCE_RANGE_UNSUPPORTED',
  'the outer boundary command must refuse to absorb an internal automatic cut');

  const initialReconstructedVideo = reconstructedProject.elements.find((item) => item.type === 'VIDEO');
  const splitReconstructed = await h.service.splitElement(reconstructedProject.id, {
    revision: reconstructedProject.revision, elementId: initialReconstructedVideo.id,
    playheadSec: 2 });
  assert.equal(splitReconstructed.elements.filter((item) => item.type === 'VIDEO').length, 3);
  reconstructedProject = await h.service.undo(reconstructedProject.id, splitReconstructed.revision);
  const trimmedReconstructed = await h.service.trimElement(reconstructedProject.id, {
    revision: reconstructedProject.revision, elementId: initialReconstructedVideo.id,
    trimStart: 100.5, trimEnd: 104 });
  assert.equal(trimmedReconstructed.elements.find((item) => item.id === initialReconstructedVideo.id)
    .trimStart, 100.5);
  reconstructedProject = await h.service.undo(reconstructedProject.id, trimmedReconstructed.revision);

  const reconstructedHook = reconstructedProject.elements.find((item) => item.type === 'TEXT');
  const reconstructedCaption = reconstructedProject.elements.find((item) => item.type === 'SUBTITLE');
  const reconstructedZoom = reconstructedProject.elements.find((item) => item.type === 'EFFECT');
  const reconstructedVideo = reconstructedProject.elements.find((item) => item.type === 'VIDEO');
  const correctedCaptionWording = 'One corrected caption';
  const reconstructedEdit = await h.service.applyAssistantBundle(reconstructedProject.id,
    reconstructedProject.revision, { proposalId: 'reconstructed-edit',
      summary: 'Edit reconstructed canonical objects', userMessage: 'Update the hook and look',
      commands: [
        { kind: 'ELEMENT', facet: 'TEXT', elementId: reconstructedHook.id,
          action: 'SET_TEXT_CONTENT', payload: { elementId: reconstructedHook.id,
            content: 'A clearer opening' } },
        { kind: 'ELEMENT', facet: 'CAPTIONS', elementId: reconstructedCaption.id,
          action: 'SET_CAPTION_TEXT', payload: { elementId: reconstructedCaption.id,
            content: correctedCaptionWording } },
        { kind: 'ELEMENT', facet: 'CAPTIONS', elementId: reconstructedCaption.id,
          action: 'SET_CAPTION_STYLE', payload: { elementId: reconstructedCaption.id,
            captionStyleId: 'HIGH_CONTRAST' } },
        { kind: 'ELEMENT', facet: 'ZOOM', elementId: reconstructedZoom.id,
          action: 'SET_ZOOM_SCALE', payload: { elementId: reconstructedZoom.id, scale: 1.12 } },
        { kind: 'ELEMENT', facet: 'COLOR', elementId: reconstructedVideo.id,
          action: 'SET_VIDEO_TEMPERATURE', payload: { elementId: reconstructedVideo.id,
            temperature: 0.18 } },
        { kind: 'ELEMENT', facet: 'AUDIO', elementId: reconstructedVideo.id,
          action: 'SET_SOURCE_AUDIO_VOLUME', payload: { elementId: reconstructedVideo.id,
            volume: 0.85 } }
      ] });
  reconstructedProject = reconstructedEdit.project;
  assert.equal(reconstructedProject.elements.find((item) => item.id === reconstructedHook.id)
    .properties.content, 'A clearer opening');
  assert.equal(reconstructedProject.elements.find((item) => item.id === reconstructedCaption.id)
    .properties.content, correctedCaptionWording,
  'global caption styling must preserve manually corrected wording');
  assert.equal(reconstructedProject.elements.find((item) => item.id === reconstructedCaption.id)
    .properties.manualEdited, true);
  assert.equal(reconstructedProject.elements.find((item) => item.id === reconstructedCaption.id)
    .properties.captionStyleId, 'HIGH_CONTRAST');
  assert.equal(reconstructedProject.elements.find((item) => item.id === reconstructedZoom.id)
    .properties.scale, 1.12);
  assert.equal(reconstructedProject.elements.find((item) => item.id === reconstructedVideo.id)
    .properties.sourceVolume, 0.85);
  const reconstructedUndo = await h.service.undo(reconstructedProject.id,
    reconstructedProject.revision);
  assert.equal(reconstructedUndo.elements.find((item) => item.id === reconstructedHook.id)
    .properties.content, 'One clear idea');
  const reconstructedRedo = await h.service.redo(reconstructedProject.id,
    reconstructedUndo.revision);
  assert.equal(reconstructedRedo.elements.find((item) => item.id === reconstructedHook.id)
    .properties.content, 'A clearer opening');
  const chat = new EditChatService(h.prisma, h.service, new EditChatProposalStore(),
    { isAnyConfigured: () => false, generate: async () => { throw new Error('no model'); } },
    new EditTemplateService(h.prisma, h.service));
  let aiProject = reconstructedRedo;
  const sayAndApply = async (message) => {
    const planned = await chat.plan(aiProject.id, { message, revision: aiProject.revision,
      selectedElementId: null, selectedTimeRange: null, playheadSec: 4.5 });
    assert.equal(planned.proposal.needsClarification, false,
      `existing deterministic AI should understand: ${message}`);
    const applied = await chat.apply(aiProject.id, { proposalId: planned.proposal.proposalId,
      revision: aiProject.revision });
    aiProject = applied.project;
  };
  const hookBeforeAi = aiProject.elements.find((item) => item.id === reconstructedHook.id)
    .properties.content;
  await sayAndApply('change the on screen hook');
  assert.notEqual(aiProject.elements.find((item) => item.id === reconstructedHook.id)
    .properties.content, hookBeforeAi);
  const captionTextBeforeAi = aiProject.elements.filter((item) => item.type === 'SUBTITLE')
    .map((item) => item.properties.content);
  await sayAndApply('make captions smaller');
  assert.deepEqual(aiProject.elements.filter((item) => item.type === 'SUBTITLE')
    .map((item) => item.properties.content), captionTextBeforeAi,
  'AI caption styling must not rewrite reconstructed wording');
  await sayAndApply('remove most zooms');
  assert(aiProject.elements.filter((item) => item.type === 'EFFECT').length <
    reconstructedRedo.elements.filter((item) => item.type === 'EFFECT').length);
  const temperatureBeforeAi = aiProject.elements.find((item) => item.type === 'VIDEO')
    .properties.colorAdjustments.temperature;
  await sayAndApply('make the color warmer');
  assert(aiProject.elements.find((item) => item.type === 'VIDEO')
    .properties.colorAdjustments.temperature > temperatureBeforeAi);
  const reconstructedRender = buildRenderPlan({ project: aiProject,
    assets: aiProject.assets, elements: aiProject.elements,
    hasSourceAudio: true, fps: 30 });
  assert.deepEqual(reconstructedRender.plan.videoSegments.map((item) =>
    [item.sourceStart, item.sourceEnd]), [[100, 104], [106, 112]]);
  assert(reconstructedRender.plan.textOverlays.length >= 1);
  assert(reconstructedRender.plan.subtitles.length >= 1);

  const loaded = await h.service.get(normalResult.editProjectId);
  const reloaded = await h.service.get(normalResult.editProjectId);
  assert.equal(loaded.generatedClipId, normal.id);
  assert.equal(loaded.originalVideoId, normal.videoId);
  assert.equal(loaded.assets.length, 2);
  assert.equal(loaded.elements.length, 1);
  assert.equal(loaded.elements[0].startTime, 0);
  assert.equal(loaded.elements[0].trimStart, normal.startTime);
  assert.equal(loaded.elements[0].trimEnd, normal.endTime);
  assert.deepEqual(reloaded.settings.origin, loaded.settings.origin);
  assert.equal(loaded.settings.origin.sourceMode, 'ORIGINAL_VIDEO');
  assert.equal(loaded.settings.origin.fullVideoSourceStart, 1112);
  assert.equal(loaded.settings.origin.fullVideoSourceEnd, 1154);
  const source = loaded.assets.find((asset) => asset.role === 'SOURCE');
  const reference = loaded.assets.find((asset) => asset.role === 'REFERENCE');
  assert.equal(source.storageOwnership, 'SHARED');
  assert.equal(source.storageObjectKey, normal.video.objectKey);
  assert.equal(reference.storageOwnership, 'OWNED');
  assert.notEqual(reference.objectKey, normal.objectKey);

  const initialMap = buildOriginalSourceMap(loaded.settings, loaded.elements);
  assert.equal(initialMap.toOriginal(0), 1112);
  assert.equal(initialMap.toOriginal(42), 1154);

  const now = new Date();
  h.rows.editAssets.set('logo-asset', { id: 'logo-asset', editProjectId: loaded.id,
    role: 'LOGO', originalName: 'logo.png', bucket: 'test-bucket', objectKey: 'owned/logo.png',
    storageOwnership: 'OWNED', mimeType: 'image/png', sizeBytes: 10n, duration: null,
    width: 100, height: 100, fps: null, metadata: {}, transcript: null, analysis: null,
    createdAt: now, updatedAt: now });
  h.rows.editAssets.set('audio-asset', { id: 'audio-asset', editProjectId: loaded.id,
    role: 'AUDIO', originalName: 'music.mp3', bucket: 'test-bucket', objectKey: 'owned/music.mp3',
    storageOwnership: 'OWNED', mimeType: 'audio/mpeg', sizeBytes: 10n, duration: 60,
    width: null, height: null, fps: null, metadata: {}, transcript: null, analysis: null,
    createdAt: now, updatedAt: now });
  const dependent = [
    { id: 'dependent-text', assetId: null, type: 'TEXT', track: 1, position: 0,
      startTime: 1, duration: 4, trimStart: 0, trimEnd: null, properties: { content: 'Manual' } },
    { id: 'dependent-logo', assetId: 'logo-asset', type: 'IMAGE', track: 2, position: 0,
      startTime: 5, duration: 15, trimStart: 0, trimEnd: null, properties: { role: 'LOGO' } },
    { id: 'dependent-audio', assetId: 'audio-asset', type: 'AUDIO', track: 3, position: 0,
      startTime: 0, duration: 10, trimStart: 0, trimEnd: 10, properties: {} },
    { id: 'dependent-zoom', assetId: null, type: 'EFFECT', track: 4, position: 0,
      startTime: 10, duration: 2, trimStart: 0, trimEnd: null,
      properties: { effect: 'ZOOM', scale: 1.1, enabled: true, claimsMoment: null,
        triggerText: '' } },
    { id: 'dependent-subtitle', assetId: null, type: 'SUBTITLE', track: 1, position: 1,
      startTime: 39, duration: 3, trimStart: 0, trimEnd: null, properties: { content: 'Tail' } }
  ];
  for (const element of dependent) h.rows.editElements.set(element.id,
    { ...element, editProjectId: loaded.id, createdAt: now, updatedAt: now });

  const editedProject = await h.service.get(editedFirst.editProjectId);
  assert.equal(editedProject.settings.origin.sourceMode, 'FLATTENED_GENERATED_OUTPUT');
  assert.equal(editedProject.assets.length, 1);
  assert.equal(editedProject.elements[0].trimStart, 0);
  assert.equal(editedProject.elements[0].trimEnd, edited.duration);
  assert.deepEqual(editedProject.settings.origin.editPlan, edited.editPlan);
  assert.deepEqual(editedProject.settings.origin.editTelemetry, edited.editTelemetry);
  assert.deepEqual(editedProject.settings.origin.contentPackaging, edited.contentPackaging);
  const editedManual = await h.service.trimElement(editedProject.id, {
    revision: editedProject.revision, elementId: editedProject.elements[0].id,
    trimStart: 1, trimEnd: 41 });
  const editedUndo = await h.service.undo(editedProject.id, editedManual.revision);
  assert.equal(editedUndo.elements[0].trimStart, 0);
  const editedRedo = await h.service.redo(editedProject.id, editedUndo.revision);
  assert.equal(editedRedo.elements[0].trimStart, 1);
  assert.equal(buildRenderPlan({ project: editedRedo, assets: editedRedo.assets,
    elements: editedRedo.elements, hasSourceAudio: false, fps: 30 })
    .plan.videoSegments[0].sourceStart, 1, 'AI_EDITED flattened fallback still exports');

  const manual = await h.service.adjustSourceRange(loaded.id, { revision: loaded.revision,
    startDelta: 2 });
  assert.equal(manual.revision, loaded.revision + 1);
  assert.equal(manual.elements[0].trimStart, 1114);
  assert.equal(manual.elements[0].trimEnd, 1154);
  assert.equal(manual.elements[0].duration, 40);
  assert.equal(buildOriginalSourceMap(manual.settings, manual.elements).toOriginal(0), 1114);
  assert.deepEqual(manual.elements.find((item) => item.id === 'dependent-text') &&
    [manual.elements.find((item) => item.id === 'dependent-text').startTime,
      manual.elements.find((item) => item.id === 'dependent-text').duration], [0, 3]);
  assert.equal(manual.elements.find((item) => item.id === 'dependent-logo').startTime, 3);
  assert.deepEqual([manual.elements.find((item) => item.id === 'dependent-audio').startTime,
    manual.elements.find((item) => item.id === 'dependent-audio').duration,
    manual.elements.find((item) => item.id === 'dependent-audio').trimStart], [0, 8, 2]);
  assert.equal(manual.elements.find((item) => item.id === 'dependent-zoom').startTime, 8);
  await assert.rejects(() => h.service.adjustSourceRange(loaded.id, {
    revision: loaded.revision, startDelta: 1 }), /stale/i);

  const undone = await h.service.undo(loaded.id, manual.revision);
  assert.equal(undone.elements[0].trimStart, 1112);
  assert.equal(undone.elements.find((item) => item.id === 'dependent-logo').startTime, 5);
  assert.equal(undone.generatedClipId, normal.id);
  assert.deepEqual(undone.settings.origin, loaded.settings.origin);
  const redone = await h.service.redo(loaded.id, undone.revision);
  assert.equal(redone.elements[0].trimStart, 1114);
  assert.equal(redone.generatedClipId, normal.id);

  const backAtInitial = await h.service.undo(loaded.id, redone.revision);
  let ranged = await h.service.adjustSourceRange(loaded.id, { revision: backAtInitial.revision,
    startDelta: -3 });
  assert.equal(ranged.elements[0].trimStart, 1109, 'start can extend before rendered output');
  assert.equal(ranged.elements[0].duration, 45);
  assert.equal(ranged.elements.find((item) => item.id === 'dependent-logo').startTime, 8,
    'manual overlays remain attached to their original content when start extends');
  ranged = await h.service.adjustSourceRange(loaded.id, { revision: ranged.revision,
    start: 1112, endDelta: 4 });
  assert.equal(ranged.elements[0].trimEnd, 1158);
  assert.equal(ranged.elements[0].duration, 46);
  ranged = await h.service.adjustSourceRange(loaded.id, { revision: ranged.revision,
    end: 1152 });
  assert.equal(ranged.elements[0].trimEnd, 1152);
  assert.equal(ranged.elements[0].duration, 40);
  assert.equal(ranged.elements.find((item) => item.id === 'dependent-subtitle').duration, 1,
    'an element crossing the shortened end is trimmed');
  for (const element of ranged.elements) {
    assert(Number.isFinite(element.startTime) && element.startTime >= 0);
    assert(Number.isFinite(element.duration) && element.duration > 0);
    assert(Number.isFinite(element.trimStart) && element.trimStart >= 0);
    assert(element.startTime + element.duration <= 40 + 1e-6);
  }
  await assert.rejects(() => h.service.adjustSourceRange(loaded.id, {
    revision: ranged.revision, start: -1 }), /zero or more/i);
  await assert.rejects(() => h.service.adjustSourceRange(loaded.id, {
    revision: ranged.revision, end: 2701 }), /exceeds/i);
  await assert.rejects(() => h.service.adjustSourceRange(loaded.id, {
    revision: ranged.revision, start: 1200 }), /after source start/i);

  const aiResult = await h.service.applyAssistantBundle(loaded.id, ranged.revision, {
    proposalId: 'deterministic-warmth', summary: 'Make the video slightly warmer',
    userMessage: 'make the video slightly warmer', commands: [{ kind: 'ELEMENT',
      action: 'SET_VIDEO_TEMPERATURE', payload: { elementId: redone.elements[0].id,
        temperature: 0.12 } }]
  });
  const aiEdited = aiResult.project;
  assert.equal(aiEdited.elements[0].properties.colorAdjustments.temperature, 0.12);

  const built = buildRenderPlan({ project: aiEdited, assets: aiEdited.assets,
    elements: aiEdited.elements, hasSourceAudio: false, fps: 30 });
  assert.equal(built.plan.videoSegments.length, 1);
  assert.equal(built.plan.videoSegments[0].sourceStart, 1112);
  assert.equal(built.plan.videoSegments[0].sourceEnd, 1152);
  assert(built.plan.durationSec > 0, 'materialized project must produce an export plan');
  assert.equal(built.plan.output.videoCodec, 'h264');
  assert.equal(built.plan.output.audioCodec, 'aac');

  const otherBefore = JSON.stringify(await h.service.get(editedProject.id));
  assert.equal(JSON.stringify(await h.service.get(editedProject.id)), otherBefore,
    'editing project A must not mutate project B');
  assert.deepEqual(frozenCounts, { jobs: h.rows.processingJobs.size,
    candidates: h.rows.clipCandidates.size, clips: h.rows.generatedClips.size },
  'materialization must not trigger the automatic processing pipeline');

  const legacy = await h.service.create({ name: 'Legacy upload project' });
  assert.equal((await h.service.get(legacy.id)).generatedClipId, undefined,
    'legacy projects still load without a generated clip');
  assert.equal((await h.prisma.generatedClip.findUnique({ where: { id: normal.id } })).id, normal.id,
    'legacy generated clips still load through nullable linkage');

  // A row materialized by Step 2 has no originalVideoId/storageOwnership and
  // keeps its local flattened 0..duration representation. Ordinary load must
  // not rewrite it into Step 3.
  const legacyFlat = await h.service.create({ name: 'Legacy Step 2 flattened project',
    settings: { origin: { mapping: 'FLATTENED_GENERATED_CLIP', generatedClipId: 'old-clip',
      fullVideoSourceStart: 50, fullVideoSourceEnd: 62 } } });
  const legacyNow = new Date();
  h.rows.editAssets.set('legacy-flat-source', { id: 'legacy-flat-source',
    editProjectId: legacyFlat.id, sourceVideoId: 'old-video', role: 'SOURCE',
    originalName: 'old-copy.mp4', bucket: 'test-bucket', objectKey: 'old-copy.mp4',
    mimeType: 'video/mp4', sizeBytes: 100n, duration: 12, width: 640, height: 360,
    fps: 30, metadata: { ownership: 'EDIT_PROJECT_COPY' }, transcript: null, analysis: null,
    createdAt: legacyNow, updatedAt: legacyNow });
  h.rows.editElements.set('legacy-flat-video', { id: 'legacy-flat-video',
    editProjectId: legacyFlat.id, assetId: 'legacy-flat-source', type: 'VIDEO', track: 0,
    position: 0, startTime: 0, duration: 12, trimStart: 0, trimEnd: 12,
    properties: {}, createdAt: legacyNow, updatedAt: legacyNow });
  const legacyReloaded = await h.service.get(legacyFlat.id);
  assert.equal(legacyReloaded.originalVideoId, undefined);
  assert.equal(legacyReloaded.elements[0].trimStart, 0);
  assert.equal(legacyReloaded.settings.origin.mapping, 'FLATTENED_GENERATED_CLIP');

  const originalObject = `${normal.bucket}/${normal.objectKey}`;
  const originalVideoObject = `${normal.video.bucket}/${normal.video.objectKey}`;
  const copiedObject = `${reference.bucket}/${reference.objectKey}`;
  await h.service.remove(loaded.id);
  assert(h.rows.generatedClips.has(normal.id), 'deleting editor project must retain GeneratedClip');
  assert(h.objects.has(originalObject), 'deleting editor project must retain original rendered MP4');
  assert(h.objects.has(originalVideoObject), 'deleting editor project must retain original Video object');
  assert(!h.objects.has(copiedObject), 'deleting editor project should remove only its owned copy');

  const editedSource = editedProject.assets.find((asset) => asset.role === 'SOURCE');
  const editedCopy = `${editedSource.bucket}/${editedSource.objectKey}`;
  const editedRendered = `${edited.bucket}/${edited.objectKey}`;
  await h.service.remove(editedProject.id);
  assert(h.rows.generatedClips.has(edited.id), 'AI_EDITED project deletion retains GeneratedClip');
  assert(h.objects.has(editedRendered), 'AI_EDITED project deletion retains generated MP4');
  assert(!h.objects.has(editedCopy), 'AI_EDITED project deletion removes editor-owned copy');

  const reconstructedReference = reconstructedRedo.assets.find((asset) => asset.role === 'REFERENCE');
  const reconstructedSource = reconstructedRedo.assets.find((asset) => asset.role === 'SOURCE');
  const reconstructedReferenceObject = `${reconstructedReference.bucket}/${reconstructedReference.objectKey}`;
  const reconstructedOriginalObject = `${reconstructedSource.bucket}/${reconstructedSource.storageObjectKey}`;
  await h.service.remove(reconstructedRedo.id);
  assert(h.rows.generatedClips.has(reconstructed.id), 'reconstructed deletion retains GeneratedClip');
  assert(h.objects.has(reconstructedOriginalObject), 'reconstructed deletion retains shared original Video');
  assert(!h.objects.has(reconstructedReferenceObject),
    'reconstructed deletion removes only the owned reference copy');

  // Found on real media: the rendered MP4 is a few frames longer/shorter than its
  // source interval (encoder rounding). The timeline length must be the interval,
  // or the 1e-4 duration validator refuses every later command on the project.
  const rounded = h.seedClip({ id: 'rounded-clip', processingType: 'NORMAL_CLIPS',
    variantKey: 'NORMAL_CLIPS:ROUNDED', startTime: 89.91, endTime: 124.21, duration: 34.32394 });
  const roundedResult = await h.materializer.materialize(rounded.id);
  let roundedProject = await h.service.get(roundedResult.editProjectId);
  const roundedVideo = roundedProject.elements.find((element) => element.type === 'VIDEO');
  assert(Math.abs(roundedVideo.duration - (124.21 - 89.91)) < 1e-6,
    `NORMAL timeline length must equal the source interval, got ${roundedVideo.duration}`);
  roundedProject = await h.service.trimElement(roundedProject.id, { revision: roundedProject.revision,
    elementId: roundedVideo.id, trimStart: 90.5, trimEnd: 124.21 });
  assert.equal(roundedProject.revision, 2, 'a rounded-duration clip accepts later commands');
  await h.service.remove(roundedProject.id);

  console.log('GeneratedClip -> EditProject tests passed: NORMAL, AI_EDITED fallback and canonical ' +
    'reconstruction, concurrent idempotency, lineage, persistence, isolation, manual/AI edits, ' +
    'caption wording preservation, stale revisions, undo/redo, export plan, delete safety, frozen ' +
    'pipeline counts, and legacy compatibility.');
}

module.exports = { installBridgeHarness };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
