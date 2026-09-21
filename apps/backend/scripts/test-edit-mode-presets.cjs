// EditMode Phase 4 - presets + no-prompt auto edit.
//
// Offline unit coverage over the in-memory EditMode harness: preset catalogue,
// content-aware planning per preset, PREVIEW/APPLY semantics, one-revision
// history with actor PRESET, undo/redo, manual-edit preservation across a
// reapply, generated-command validation, and isolation from the frozen
// auto-pipeline.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./test-edit-mode-isolation.cjs');
const { EditModePresetService } = require('../dist/modules/edit-mode/edit-mode-preset.service.js');
const { EDIT_PRESETS, EDIT_PRESET_IDS,
  readEditProjectStyle } = require('../dist/modules/edit-mode/presets/edit-preset-policy.js');
const {
  validatePresetCommands
} = require('../dist/modules/edit-mode/presets/edit-preset-commands.js');

const expectStatus = async (promise, status) => assert.rejects(promise,
  (error) => typeof error.getStatus === 'function' && error.getStatus() === status,
  `expected HTTP ${status}`);

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const file = (originalname, mimetype, buffer) => ({ originalname, mimetype, buffer, size: buffer.length });

const SOURCE_DURATION = 30;
const SPEECH = ('Most investors lose money because they try to time the market instead of ' +
  'staying invested. Compound interest returned 11 percent annually over the last 40 years, ' +
  'and missing only 10 of the best trading days cut that return almost in half. The discipline ' +
  'beats the forecast every single time.').split(/\s+/u);

/** Word timings start after 1.2s of silence and end well before the source does,
 * so the lead-in and tail trim paths are actually exercised. */
function transcriptFixture() {
  let cursor = 1.2;
  const words = SPEECH.map((text) => {
    const start = Number(cursor.toFixed(3));
    cursor += 0.4;
    return { start, end: Number((cursor - 0.05).toFixed(3)), text };
  });
  return { text: SPEECH.join(' '), language: 'en', language_probability: 0.99,
    duration: SOURCE_DURATION,
    segments: [{ position: 0, start: words[0].start, end: words[words.length - 1].end,
      text: SPEECH.join(' '), words }] };
}

const frames = (build) => Array.from({ length: SOURCE_DURATION }, (_, index) => ({
  t: index, text_coverage: 0, text_boxes: [], graphic_boxes: [], ocr_lines: [], ocr_coverage: 0,
  faces: [], persons: [], ...build(index) }));

/** One large, centred face for the whole source: a talking head. */
const talkingHeadAnalysis = () => ({ source: 'DENSE',
  frames: frames(() => ({ faces: [{ x: 0.38, y: 0.18, w: 0.25, h: 0.3, score: 0.95,
    mouth_activity: 0.6, track_id: 'a' }], persons: [{ x: 0.3, y: 0.15, w: 0.4, h: 0.8 }] })),
  shotBoundaries: [], ocrText: '',
  summary: { sampledFrameCount: SOURCE_DURATION, faceDetections: SOURCE_DURATION,
    mouthActivitySamples: SOURCE_DURATION, shotCount: 1, ocrRegionCount: 0 } });

/** Two comparable faces close enough together to survive a 9:16 crop. */
const twoPersonAnalysis = () => ({ source: 'DENSE',
  frames: frames(() => ({ faces: [
    { x: 0.38, y: 0.3, w: 0.1, h: 0.12, score: 0.9, mouth_activity: 0.5, track_id: 'a' },
    { x: 0.52, y: 0.3, w: 0.1, h: 0.12, score: 0.9, mouth_activity: 0.4, track_id: 'b' }],
  persons: [{ x: 0.3, y: 0.25, w: 0.18, h: 0.7 }, { x: 0.5, y: 0.25, w: 0.18, h: 0.7 }] })),
  shotBoundaries: [], ocrText: '',
  summary: { sampledFrameCount: SOURCE_DURATION, faceDetections: SOURCE_DURATION * 2,
    mouthActivitySamples: SOURCE_DURATION * 2, shotCount: 1, ocrRegionCount: 0 } });

/** A full-frame slide: dense text above the caption band and no usable face. */
const slideAnalysis = () => ({ source: 'DENSE',
  frames: frames(() => ({ text_coverage: 0.42, ocr_coverage: 0.42,
    text_boxes: [{ x: 0.08, y: 0.12, w: 0.84, h: 0.5 }],
    ocr_lines: ['Annualised real return by decade', 'Equities 6.8 percent', 'Bonds 2.1 percent',
      'Cash minus 0.4 percent', 'Source: long run market study'] })),
  shotBoundaries: [], ocrText: 'Annualised real return by decade',
  summary: { sampledFrameCount: SOURCE_DURATION, faceDetections: 0, mouthActivitySamples: 0,
    shotCount: 1, ocrRegionCount: SOURCE_DURATION } });

const offlineLlm = () => ({ calls: 0, isAnyConfigured() { return false; },
  async generate() { throw new Error('should not be reached'); } });

async function seed(analysisPayload, options = {}) {
  const harness = createHarness();
  harness.analysis.analyze = async () => {
    harness.analysis.calls++;
    return { transcript: options.transcript === null ? null : transcriptFixture(),
      analysis: analysisPayload };
  };
  const project = await harness.service.create({ name: 'Preset project' });
  const attached = await harness.service.persistSource(project.id, project.revision, {
    id: 'asset-source', originalName: 'source.mp4', bucket: 'test-bucket',
    objectKey: `edit-mode/${project.id}/asset-source/source.mp4`, mimeType: 'video/mp4',
    sizeBytes: 4096n, duration: SOURCE_DURATION, width: 1920, height: 1080, fps: 30,
    metadata: { hasVideo: true, hasAudio: true, videoCodec: 'h264' }
  });
  let current = attached;
  if (!options.skipAnalysis) current = await harness.service.analyze(project.id, attached.revision);
  const llm = options.llm ?? offlineLlm();
  const presets = new EditModePresetService(harness.prisma, harness.service, llm);
  return { ...harness, llm, presets, projectId: project.id, project: current };
}

const fingerprint = (elements) => JSON.stringify([...elements]
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((element) => [element.id, element.type, element.track, element.position,
    element.startTime, element.duration, element.trimStart, element.trimEnd,
    JSON.stringify(element.properties)]));

const commandActions = (plan) => plan.commands.map((command) => command.action);
const presetElements = (project) => (project.elements ?? [])
  .filter((element) => element.properties?.origin === 'PRESET');
const userElements = (project) => (project.elements ?? [])
  .filter((element) => element.properties?.origin !== 'PRESET' && element.type !== 'VIDEO');

// --- 1. the catalogue -------------------------------------------------------
async function testCatalogue() {
  const state = await seed(talkingHeadAnalysis());
  const list = state.presets.list();
  assert.equal(list.length, 8, 'all eight presets are exposed');
  assert.deepEqual(list.map((preset) => preset.id), [...EDIT_PRESET_IDS]);
  assert.deepEqual(list.map((preset) => preset.displayName), [
    'Instagram Reel — Professional', 'Podcast Clip', 'Educational', 'Product Promo',
    'Motivational', 'Clean Business', 'Minimal', 'Source / Manual']);
  for (const preset of list) {
    assert(preset.description.length > 20, `${preset.id} documents itself`);
    // Typed policy fields, not opaque strings.
    for (const [field, options] of [
      ['aspectRatio', ['9:16', '16:9', '1:1', 'SOURCE']],
      ['subtitlePolicy', ['OFF', 'AUTO', 'ALWAYS']],
      ['hookPolicy', ['OFF', 'AUTO', 'RECOMMENDED']],
      ['zoomPolicy', ['OFF', 'SUBTLE', 'MODERATE', 'STRONG']],
      ['reframingPolicy', ['SOURCE', 'AUTO', 'FACE_FOCUSED', 'INFORMATION_PRESERVING']],
      ['audioPolicy', ['OFF', 'KEEP_EXISTING', 'OPTIONAL_USER_ASSET']],
      ['gradingPolicy', ['NONE', 'SUBTLE', 'CLEAN', 'WARM', 'CONTRAST']]
    ]) {
      assert(options.includes(preset[field]), `${preset.id}.${field} is a typed enum value`);
    }
  }
  assert.equal(EDIT_PRESETS.SOURCE_MANUAL.automatic, false);
  assert(EDIT_PRESET_IDS.filter((id) => EDIT_PRESETS[id].automatic).length === 7);
}

// --- 2. invalid preset ------------------------------------------------------
async function testInvalidPreset() {
  const state = await seed(talkingHeadAnalysis());
  await expectStatus(state.presets.preview(state.projectId, { presetId: 'NOT_A_PRESET' }), 400);
  await expectStatus(state.presets.preview(state.projectId, { presetId: 42 }), 400);
  await expectStatus(state.presets.apply(state.projectId, { presetId: undefined }), 400);
  await expectStatus(state.presets.preview('missing-project',
    { presetId: 'MINIMAL' }), 404);
}

// --- 3. SOURCE_MANUAL applies no automatic transformation -------------------
async function testSourceManual() {
  const state = await seed(talkingHeadAnalysis());
  const before = await state.service.get(state.projectId);
  const plan = await state.presets.preview(state.projectId, { presetId: 'SOURCE_MANUAL' });
  assert.deepEqual(commandActions(plan), ['SET_PROJECT_STYLE'],
    'Source / Manual emits only the selection record');
  assert.equal(plan.estimatedChanges.trims, 0);
  assert.equal(plan.estimatedChanges.overlays, 0);
  assert.equal(plan.estimatedChanges.subtitles, 0);

  const applied = await state.presets.apply(state.projectId, { presetId: 'SOURCE_MANUAL' });
  assert.equal(fingerprint(applied.project.elements), fingerprint(before.elements),
    'Source / Manual leaves the timeline byte-identical');
  const style = readEditProjectStyle(applied.project.settings);
  assert.equal(style.selectedPreset, 'SOURCE_MANUAL');
  const untouched = readEditProjectStyle({});
  for (const key of Object.keys(untouched)) {
    if (key === 'selectedPreset') continue;
    assert.deepEqual(style[key], untouched[key], `${key} is not changed by Source / Manual`);
  }
}

// --- 4 / 9 / 11. talking-head presets --------------------------------------
async function testTalkingHeadPresets() {
  const instagram = await seed(talkingHeadAnalysis());
  const plan = await instagram.presets.preview(instagram.projectId,
    { presetId: 'INSTAGRAM_REEL_PROFESSIONAL' });
  assert.equal(plan.style.aspectRatio, '9:16', 'a 16:9 source is retargeted to vertical');
  assert.equal(plan.style.subtitlePolicy, 'ALWAYS');
  assert.equal(plan.style.reframePolicy, 'AUTO');
  assert.equal(plan.style.zoomPolicy, 'SUBTLE', 'a talking head with real peaks allows zoom');
  assert.equal(plan.style.gradingPolicy, 'SUBTLE');
  assert(plan.evidence.semanticPeakCount > 0, 'semantic peaks were detected in the transcript');
  assert(plan.plannedZoomMoments.length > 0 && plan.plannedZoomMoments.length <= 8,
    'zoom beats are evidence-driven and bounded, not a fixed count');
  assert(plan.estimatedChanges.subtitles > 0, 'transcript-exact captions are planned');
  assert(plan.estimatedChanges.trims === 1, 'silent lead-in and tail are trimmed');
  assert(commandActions(plan).includes('TRIM_ELEMENT'));
  assert(commandActions(plan).includes('ADD_SUBTITLE'));

  const applied = await instagram.presets.apply(instagram.projectId,
    { presetId: 'INSTAGRAM_REEL_PROFESSIONAL' });
  const video = applied.project.elements.find((element) => element.type === 'VIDEO');
  assert(video.trimStart > 0.9 && video.trimStart < 1.2, 'trim starts just before the first word');
  assert(video.trimEnd < SOURCE_DURATION - 1, 'the silent tail is removed');
  const captions = applied.project.elements.filter((element) => element.type === 'SUBTITLE');
  assert(captions.length > 0);
  for (const caption of captions) {
    assert(caption.startTime + caption.duration <= video.duration + 1e-6,
      'captions stay inside the trimmed timeline');
    // Caption text must be words the transcript actually contains.
    for (const word of String(caption.properties.content).split(/\s+/u)) {
      assert(SPEECH.includes(word.replace(/\n/gu, '')),
        `caption word "${word}" comes from the transcript`);
    }
  }

  const motivational = await seed(talkingHeadAnalysis());
  const motivationalPlan = await motivational.presets.preview(motivational.projectId,
    { presetId: 'MOTIVATIONAL' });
  assert.equal(motivationalPlan.style.pacing, 'STRONG');
  assert.equal(motivationalPlan.style.subtitlePolicy, 'ALWAYS');
  assert.equal(motivationalPlan.style.zoomPolicy, 'MODERATE');
  assert.equal(motivationalPlan.style.reframePolicy, 'FACE_FOCUSED');
  assert.equal(motivationalPlan.style.gradingPolicy, 'CONTRAST');

  const minimal = await seed(talkingHeadAnalysis());
  const minimalPlan = await minimal.presets.preview(minimal.projectId, { presetId: 'MINIMAL' });
  assert.equal(minimalPlan.style.aspectRatio, 'SOURCE', 'Minimal preserves the source frame');
  assert.equal(minimalPlan.style.zoomPolicy, 'OFF');
  assert.equal(minimalPlan.style.hookPolicy, 'OFF');
  assert.equal(minimalPlan.style.hookText, null, 'Minimal never adds a hook');
  assert.equal(minimalPlan.style.pacing, 'SOURCE');
  assert.equal(minimalPlan.estimatedChanges.trims, 0, 'Minimal does not trim the source');
  assert.equal(minimalPlan.style.musicPolicy, 'KEEP_EXISTING', 'Minimal adds no music');
  assert(!commandActions(minimalPlan).includes('ADD_AUDIO'));

  const business = await seed(talkingHeadAnalysis());
  const businessPlan = await business.presets.preview(business.projectId,
    { presetId: 'CLEAN_BUSINESS' });
  assert.equal(businessPlan.style.hookPolicy, 'OFF');
  assert.equal(businessPlan.style.hookText, null);
  assert.equal(businessPlan.style.gradingPolicy, 'NONE', 'Clean Business grades neutrally');
  assert.equal(businessPlan.style.aspectRatio, 'SOURCE');
  assert.equal(businessPlan.style.textPolicy, 'OFF', 'Clean Business adds no callouts');
  assert(!commandActions(businessPlan).includes('ADD_TEXT'));
}

// --- 5. podcast: pair composition, no invented speakers --------------------
async function testPodcastPlan() {
  const state = await seed(twoPersonAnalysis());
  const plan = await state.presets.preview(state.projectId, { presetId: 'PODCAST_CLIP' });
  assert.equal(plan.style.reframePolicy, 'FACE_FOCUSED');
  assert.equal(plan.style.subtitlePolicy, 'ALWAYS', 'dialogue is always captioned');
  assert.equal(plan.style.overlayPolicy, 'NONE', 'podcast stays minimal');
  assert(plan.evidence.pairShotRatio > 0.5, 'pair framing is detected from the analysis');
  assert(plan.warnings.some((warning) => /pair composition/iu.test(warning)),
    'the plan states that pair composition is preserved');
  assert.equal(plan.estimatedChanges.overlays, plan.style.hookText ? 1 : 0,
    'podcast adds no overlay beyond an optional headline');

  const applied = await state.presets.apply(state.projectId, { presetId: 'PODCAST_CLIP' });
  const texts = applied.project.elements.filter((element) => element.type === 'TEXT');
  for (const text of texts) {
    assert(!/\b(host|guest|speaker\s*\d)\b/iu.test(String(text.properties.content)),
      'no speaker identity is invented without diarization');
  }

  // A single visible speaker uses single-speaker framing instead.
  const single = await seed(talkingHeadAnalysis());
  const singlePlan = await single.presets.preview(single.projectId, { presetId: 'PODCAST_CLIP' });
  assert.equal(singlePlan.evidence.pairShotRatio, 0);
  assert(!singlePlan.warnings.some((warning) => /pair composition/iu.test(warning)));
}

// --- 6. educational preserves information regions --------------------------
async function testEducationalPlan() {
  const state = await seed(slideAnalysis());
  const plan = await state.presets.preview(state.projectId, { presetId: 'EDUCATIONAL' });
  assert(plan.evidence.informationShotRatio >= 0.5,
    'slides are classified as information shots from the cached analysis');
  assert.equal(plan.style.reframePolicy, 'INFORMATION_PRESERVING');
  assert.equal(plan.style.informationRegionPolicy, 'PRESERVE');
  assert.equal(plan.style.zoomPolicy, 'OFF', 'no punch-in over information-heavy content');
  assert.equal(plan.style.aspectRatio, 'SOURCE',
    'the source frame shape is kept so the slide stays readable');
  assert(plan.warnings.some((warning) => /readab/iu.test(warning)));
  assert.equal(plan.plannedZoomMoments.length, 0);

  // A talking head under the same preset is still allowed a moderate edit, but
  // Educational refuses zoom by policy - proving the policy is not a template.
  const head = await seed(talkingHeadAnalysis());
  const headPlan = await head.presets.preview(head.projectId, { presetId: 'EDUCATIONAL' });
  assert.equal(headPlan.style.zoomPolicy, 'OFF');
  assert.equal(headPlan.style.aspectRatio, '9:16', 'no slides means the vertical target applies');
  assert(headPlan.evidence.informationShotRatio < 0.5);
}

// --- 7 / 8. product promo, with and without assets -------------------------
async function testProductPromo() {
  const withoutAssets = await seed(talkingHeadAnalysis());
  const bare = await withoutAssets.presets.preview(withoutAssets.projectId,
    { presetId: 'PRODUCT_PROMO' });
  assert(!commandActions(bare).includes('ADD_IMAGE'), 'no product image is fabricated');
  assert(!commandActions(bare).includes('ADD_LOGO'));
  assert.equal(bare.style.overlayPolicy, 'MINIMAL', 'the overlay policy degrades honestly');
  assert(bare.warnings.some((warning) => /no product image or logo/iu.test(warning)));

  const state = await seed(talkingHeadAnalysis());
  state.service.probeAssetMedia = async () => ({ hasVideo: true, hasAudio: false,
    videoCodec: 'png', audioCodec: null, videoStreamIndex: 0, audioStreamIndex: null,
    durationSec: null, formatName: 'image2', fps: 25, width: 1, height: 1 });
  let revision = state.project.revision;
  const image = await state.service.uploadAsset(state.projectId,
    file('product.png', 'image/png', png), 'IMAGE', revision);
  revision = image.revision;
  const logo = await state.service.uploadAsset(state.projectId,
    file('brand.png', 'image/png', png), 'LOGO', revision);

  const plan = await state.presets.preview(state.projectId, { presetId: 'PRODUCT_PROMO' });
  assert.equal(plan.style.overlayPolicy, 'PRODUCT_FORWARD');
  assert(commandActions(plan).includes('ADD_IMAGE'));
  assert(commandActions(plan).includes('ADD_LOGO'));
  assert.equal(plan.style.pacing, 'TIGHT');
  assert.equal(plan.style.zoomPolicy, 'MODERATE');

  const applied = await state.presets.apply(state.projectId, { presetId: 'PRODUCT_PROMO' });
  const product = applied.project.elements.find((element) =>
    element.assetId === image.asset.id && element.properties.presetRole === 'PRODUCT');
  assert(product, 'the uploaded product image is placed');
  assert(product.properties.x >= 0.55 && product.properties.y >= 0.5,
    'the product plate sits clear of the centre subject');
  assert(applied.project.elements.some((element) => element.assetId === logo.asset.id));
  // No external asset was invented: every overlay references an uploaded asset
  // or carries transcript-grounded text.
  for (const element of presetElements(applied.project)) {
    if (element.type === 'IMAGE') assert(element.assetId, 'image overlays reference real bytes');
  }
}

// --- 12 / 13. cached transcript and analysis are reused --------------------
async function testCachedAnalysisReuse() {
  const state = await seed(talkingHeadAnalysis());
  assert.equal(state.analysis.calls, 1, 'analysis ran once, during Analyze source');
  for (const presetId of EDIT_PRESET_IDS) {
    const plan = await state.presets.preview(state.projectId, { presetId });
    assert.equal(plan.evidence.usedCachedAnalysis, presetId !== 'SOURCE_MANUAL' ? true
      : plan.evidence.usedCachedAnalysis, 'plans report cached-analysis reuse');
  }
  await state.presets.apply(state.projectId, { presetId: 'PODCAST_CLIP' });
  await state.presets.preview(state.projectId, { presetId: 'EDUCATIONAL' });
  assert.equal(state.analysis.calls, 1,
    'no preset preview or apply re-transcribes or re-analyses the source');

  const plan = await state.presets.preview(state.projectId, { presetId: 'MOTIVATIONAL' });
  assert.equal(plan.evidence.transcriptAvailable, true);
  assert.equal(plan.evidence.analysisAvailable, true);
  assert.equal(plan.evidence.analysisSource, 'DENSE');
  assert(plan.evidence.shotCount >= 1);

  // A source that was never analysed still plans - policy only - and says so.
  const unanalysed = await seed(talkingHeadAnalysis(), { skipAnalysis: true });
  const cold = await unanalysed.presets.preview(unanalysed.projectId,
    { presetId: 'INSTAGRAM_REEL_PROFESSIONAL' });
  assert.equal(unanalysed.analysis.calls, 0, 'previewing never triggers analysis');
  assert.equal(cold.evidence.transcriptAvailable, false);
  assert.equal(cold.estimatedChanges.subtitles, 0);
  assert.equal(cold.style.subtitlePolicy, 'OFF');
  assert(cold.warnings.some((warning) => /Analyze source/iu.test(warning)));
}

// --- 14-17. isolation from the frozen auto-pipeline ------------------------
async function testIsolation() {
  const state = await seed(talkingHeadAnalysis());
  const before = { jobs: state.rows.processingJobs.size,
    candidates: state.rows.clipCandidates.size, clips: state.rows.generatedClips.size };
  for (const presetId of EDIT_PRESET_IDS) {
    await state.presets.preview(state.projectId, { presetId });
  }
  await state.presets.apply(state.projectId, { presetId: 'INSTAGRAM_REEL_PROFESSIONAL' });
  assert.equal(state.rows.processingJobs.size, before.jobs, 'no ProcessingJob is created');
  assert.equal(state.rows.clipCandidates.size, before.candidates, 'no ClipCandidate is created');
  assert.equal(state.rows.generatedClips.size, before.clips, 'no GeneratedClip is created');

  const forbidden = ['ProcessingQueueService', 'VideoProcessorService', 'ClipRenderQueueService',
    'ClipSelectionService', 'ClipExportService'];
  const root = path.join(__dirname, '../src/modules/edit-mode');
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.name.endsWith('.ts')) files.push(target);
    }
  };
  walk(root);
  assert(files.length >= 10, 'the EditMode module tree was found');
  for (const target of files) {
    const source = fs.readFileSync(target, 'utf8');
    for (const name of forbidden) {
      assert(!source.includes(name),
        `${path.relative(root, target)} must not reference ${name}`);
    }
  }
  // Project and Video rows are never touched by preset code.
  for (const target of files) {
    const source = fs.readFileSync(target, 'utf8');
    assert(!/prisma\.(?:project|video)\.(?:create|update|delete|upsert)/u.test(source),
      `${path.relative(root, target)} must not write Project or Video rows`);
  }
}

// --- 18 / 19. PREVIEW does not mutate; APPLY does -------------------------
async function testPreviewAndApply() {
  const state = await seed(talkingHeadAnalysis());
  const before = await state.service.get(state.projectId);
  const historyBefore = (await state.service.history(state.projectId)).length;

  const plan = await state.presets.preview(state.projectId, { presetId: 'PODCAST_CLIP' });
  assert.equal(plan.mode, 'PREVIEW');
  assert(Array.isArray(plan.commands) && plan.commands.length > 0);
  const afterPreview = await state.service.get(state.projectId);
  assert.equal(afterPreview.revision, before.revision, 'PREVIEW does not bump the revision');
  assert.equal(fingerprint(afterPreview.elements), fingerprint(before.elements),
    'PREVIEW writes no elements');
  assert.deepEqual(afterPreview.settings, before.settings, 'PREVIEW writes no settings');
  assert.equal((await state.service.history(state.projectId)).length, historyBefore,
    'PREVIEW writes no history');
  // Repeated previews stay side-effect free.
  await state.presets.preview(state.projectId, { presetId: 'MOTIVATIONAL' });
  await state.presets.preview(state.projectId, { presetId: 'EDUCATIONAL' });
  assert.equal((await state.service.get(state.projectId)).revision, before.revision);

  const applied = await state.presets.apply(state.projectId,
    { presetId: 'INSTAGRAM_REEL_PROFESSIONAL' });
  assert.equal(applied.mode, 'APPLY');
  assert(applied.presetRunId);
  assert.equal(applied.plan.commands, undefined, 'raw commands are not surfaced to the UI');
  assert.equal(applied.project.revision, before.revision + 1,
    'APPLY advances the canonical revision by exactly one');
  assert(applied.project.elements.length > before.elements.length);
  const style = readEditProjectStyle(applied.project.settings);
  assert.equal(style.selectedPreset, 'INSTAGRAM_REEL_PROFESSIONAL');
  assert.equal(style.aspectRatio, '9:16');
  assert.equal(style.subtitlePolicy, 'ALWAYS');
  assert.equal(applied.project.settings.presetRun.presetRunId, applied.presetRunId);
  assert.equal(applied.project.settings.presetRun.appliedAtRevision, applied.project.revision);
  for (const element of presetElements(applied.project)) {
    assert.equal(element.properties.presetId, 'INSTAGRAM_REEL_PROFESSIONAL');
    assert.equal(element.properties.presetRunId, applied.presetRunId);
    assert.equal(element.properties.createdAtRevision, applied.project.revision);
  }
}

// --- 20 / 21. one revision, actor PRESET ----------------------------------
async function testOneHistoryRevision() {
  const state = await seed(talkingHeadAnalysis());
  const before = await state.service.history(state.projectId);
  const applied = await state.presets.apply(state.projectId, { presetId: 'MOTIVATIONAL' });
  const after = await state.service.history(state.projectId);
  assert.equal(after.length, before.length + 1,
    'many internal commands produce exactly one history revision');
  const entry = after.find((item) => item.revision === applied.project.revision);
  assert.equal(entry.actor, 'PRESET');
  assert.equal(entry.action, 'APPLY_PRESET');
  assert.equal(entry.command.presetId, 'MOTIVATIONAL');
  assert(entry.command.commandCount > 3, 'the entry records how many commands it folded');
  assert(Array.isArray(entry.beforeState.elements) && entry.beforeState.settings);
  assert(Array.isArray(entry.afterState.elements) && entry.afterState.settings);
}

// --- 22 / 23. undo and redo a whole preset --------------------------------
async function testUndoRedo() {
  const state = await seed(talkingHeadAnalysis());
  const before = await state.service.get(state.projectId);
  const applied = await state.presets.apply(state.projectId, { presetId: 'PODCAST_CLIP' });
  const appliedFingerprint = fingerprint(applied.project.elements);
  const appliedStyle = readEditProjectStyle(applied.project.settings);

  const undone = await state.service.undo(state.projectId, applied.project.revision);
  assert.equal(fingerprint(undone.elements), fingerprint(before.elements),
    'one undo restores the complete pre-preset timeline');
  assert.deepEqual(readEditProjectStyle(undone.settings), readEditProjectStyle(before.settings),
    'one undo restores the pre-preset project settings');

  const redone = await state.service.redo(state.projectId, undone.revision);
  assert.equal(fingerprint(redone.elements), appliedFingerprint,
    'redo restores the applied timeline exactly');
  assert.deepEqual(readEditProjectStyle(redone.settings), appliedStyle,
    'redo restores the applied settings exactly');

  // Manual editing still works after a preset, and undoes independently.
  const afterManual = await state.service.phase3Command(state.projectId, 'add-text',
    { revision: redone.revision });
  const manualText = afterManual.elements.find((element) =>
    element.type === 'TEXT' && element.properties.origin === 'USER');
  assert(manualText, 'a manual add is stamped USER');
  const manualUndone = await state.service.undo(state.projectId, afterManual.revision);
  assert(!manualUndone.elements.some((element) => element.id === manualText.id));
  assert.equal(fingerprint(manualUndone.elements), appliedFingerprint,
    'undoing the manual edit leaves the preset result intact');
}

// --- 24 / 25 / 26. manual work survives a reapply -------------------------
async function testReapplyPreservesManualWork() {
  const state = await seed(talkingHeadAnalysis());
  state.service.probeAssetMedia = async () => ({ hasVideo: true, hasAudio: false,
    videoCodec: 'png', audioCodec: null, videoStreamIndex: 0, audioStreamIndex: null,
    durationSec: null, formatName: 'image2', fps: 25, width: 1, height: 1 });

  const first = await state.presets.apply(state.projectId,
    { presetId: 'INSTAGRAM_REEL_PROFESSIONAL' });
  const firstPresetIds = presetElements(first.project).map((element) => element.id);
  const firstSubtitles = first.project.elements.filter((element) => element.type === 'SUBTITLE').length;
  assert(firstSubtitles > 0);

  // The user then adds a logo and a custom text line, and edits the text.
  let project = first.project;
  const logo = await state.service.uploadAsset(state.projectId,
    file('mine.png', 'image/png', png), 'LOGO', project.revision);
  project = await state.service.get(state.projectId);
  project = await state.service.phase3Command(state.projectId, 'add-logo',
    { revision: project.revision, assetId: logo.asset.id });
  const manualLogo = project.elements.find((element) => element.assetId === logo.asset.id);
  project = await state.service.phase3Command(state.projectId, 'add-text',
    { revision: project.revision });
  const manualText = project.elements.find((element) =>
    element.type === 'TEXT' && element.properties.origin === 'USER');
  project = await state.service.phase3Command(state.projectId, 'update-text',
    { revision: project.revision, elementId: manualText.id, content: 'My own caption' });
  const manualSnapshot = fingerprint(userElements(project));
  assert.equal(userElements(project).length, 2, 'the user owns exactly two elements');

  const second = await state.presets.apply(state.projectId,
    { presetId: 'INSTAGRAM_REEL_PROFESSIONAL' });
  assert.equal(fingerprint(userElements(second.project)), manualSnapshot,
    'a reapply leaves every manual element untouched');
  const keptLogo = second.project.elements.find((element) => element.id === manualLogo.id);
  assert(keptLogo && keptLogo.assetId === logo.asset.id, 'the manual logo survives the reapply');
  const keptText = second.project.elements.find((element) => element.id === manualText.id);
  assert.equal(keptText.properties.content, 'My own caption',
    'the manual text and its wording survive the reapply');

  const secondPresetIds = presetElements(second.project).map((element) => element.id);
  assert.equal(second.project.elements.filter((element) => element.type === 'SUBTITLE').length,
    firstSubtitles, 'preset elements are replaced, not duplicated');
  assert.equal(secondPresetIds.filter((id) => firstPresetIds.includes(id)).length, 0,
    'the previous run’s elements were removed rather than kept alongside new ones');
  assert.equal(second.plan.estimatedChanges.removedPresetElements, firstPresetIds.length,
    'the plan accounts for exactly the elements the previous run owned');

  // A third application of a different preset again replaces only preset work.
  const third = await state.presets.apply(state.projectId, { presetId: 'PODCAST_CLIP' });
  assert.equal(fingerprint(userElements(third.project)), manualSnapshot);
  assert(!third.project.elements.some((element) => secondPresetIds.includes(element.id)));

  // The trim the preset authored is recognised as its own on reapply, so the
  // clip length does not creep with each run.
  const video = third.project.elements.find((element) => element.type === 'VIDEO');
  const fourth = await state.presets.apply(state.projectId, { presetId: 'PODCAST_CLIP' });
  const videoAgain = fourth.project.elements.find((element) => element.type === 'VIDEO');
  assert(Math.abs(video.trimStart - videoAgain.trimStart) < 1e-6 &&
    Math.abs(video.duration - videoAgain.duration) < 1e-6,
  'reapplying a preset is idempotent for the source trim');

  // A trim the USER made is never overwritten.
  const manual = await seed(talkingHeadAnalysis());
  let manualProject = await manual.service.get(manual.projectId);
  const manualVideo = manualProject.elements.find((element) => element.type === 'VIDEO');
  manualProject = await manual.service.trimElement(manual.projectId, {
    revision: manualProject.revision, elementId: manualVideo.id, trimStart: 4, trimEnd: 20 });
  const plan = await manual.presets.preview(manual.projectId,
    { presetId: 'INSTAGRAM_REEL_PROFESSIONAL' });
  assert.equal(plan.estimatedChanges.trims, 0);
  assert(plan.warnings.some((warning) => /trimmed by hand/iu.test(warning)));
  const reapplied = await manual.presets.apply(manual.projectId,
    { presetId: 'INSTAGRAM_REEL_PROFESSIONAL' });
  const keptVideo = reapplied.project.elements.find((element) => element.type === 'VIDEO');
  assert.equal(keptVideo.trimStart, 4);
  assert.equal(keptVideo.trimEnd, 20);
}

// --- 27. generated commands are validated ---------------------------------
async function testCommandValidation() {
  assert.deepEqual(validatePresetCommands([]), []);
  const cases = [
    'not-an-array',
    [{ kind: 'ELEMENT', action: 'ADD_TEXT', payload: {} }],                     // no reason
    [{ kind: 'ELEMENT', action: 'ADD_TEXT', reason: 'x' }],                     // no payload
    [{ kind: 'ELEMENT', action: 'DROP_DATABASE', payload: {}, reason: 'x' }],   // unknown action
    [{ kind: 'SETTINGS', action: 'SET_EVERYTHING', payload: {}, reason: 'x' }],
    [{ kind: 'WHATEVER', action: 'ADD_TEXT', payload: {}, reason: 'x' }],
    [{ kind: 'SETTINGS', action: 'SET_ASPECT_RATIO', payload: { aspectRatio: '4:3' }, reason: 'x' }],
    [{ kind: 'SETTINGS', action: 'SET_ASPECT_RATIO', payload: { zoomPolicy: 'OFF' }, reason: 'x' }],
    [{ kind: 'SETTINGS', action: 'SET_HOOK', payload: { hookText: 'x'.repeat(500) }, reason: 'x' }],
    [{ kind: 'ELEMENT', action: 'UPDATE_TEXT', payload: { ref: 'ghost' }, reason: 'x' }],
    [{ kind: 'ELEMENT', action: 'UPDATE_TEXT', payload: { content: 'x' }, reason: 'x' }]
  ];
  for (const value of cases) {
    assert.throws(() => validatePresetCommands(value),
      (error) => typeof error.getStatus === 'function' && error.getStatus() === 400,
      `rejected: ${JSON.stringify(value).slice(0, 80)}`);
  }
  // A well-formed ref chain is accepted.
  assert.equal(validatePresetCommands([
    { kind: 'ELEMENT', action: 'ADD_TEXT', ref: 'hook', payload: {}, reason: 'add' },
    { kind: 'ELEMENT', action: 'UPDATE_TEXT', payload: { ref: 'hook', content: 'Hi' }, reason: 'set' }
  ]).length, 2);

  // The canonical layer refuses a bundle whose ref was never created, and a
  // bundle carrying an action outside the element vocabulary.
  const state = await seed(talkingHeadAnalysis());
  const revision = state.project.revision;
  await expectStatus(state.service.applyPresetBundle(state.projectId, revision, {
    presetId: 'MINIMAL', presetRunId: 'run-1', summary: 's', plannedZoomMoments: [],
    commands: [{ kind: 'ELEMENT', action: 'UPDATE_TEXT',
      payload: { ref: 'never-made', content: 'x' }, reason: 'r' }]
  }), 400);
  await expectStatus(state.service.applyPresetBundle(state.projectId, revision, {
    presetId: 'MINIMAL', presetRunId: 'run-2', summary: 's', plannedZoomMoments: [],
    commands: [{ kind: 'ELEMENT', action: 'SET_ANYTHING', payload: { elementId: 'x' }, reason: 'r' }]
  }), 400);
  await expectStatus(state.service.applyPresetBundle(state.projectId, revision, {
    presetId: 'NOT_A_PRESET', presetRunId: 'run-3', summary: 's', plannedZoomMoments: [],
    commands: []
  }), 400);
  // A subtitle outside the timeline is rejected by the same validation the
  // manual editor is held to.
  await expectStatus(state.service.applyPresetBundle(state.projectId, revision, {
    presetId: 'MINIMAL', presetRunId: 'run-4', summary: 's', plannedZoomMoments: [],
    commands: [{ kind: 'ELEMENT', action: 'ADD_SUBTITLE',
      payload: { content: 'late', startTime: 1000, duration: 2 }, reason: 'r' }]
  }), 400);
  // ADD_SUBTITLE is not reachable as a manual command.
  await expectStatus(state.service.phase3Command(state.projectId, 'add-subtitle',
    { revision, content: 'x', startTime: 0, duration: 1 }), 400);
  assert.equal((await state.service.get(state.projectId)).revision, revision,
    'every rejected bundle left the project untouched');
}

// --- 28. stale revisions --------------------------------------------------
async function testStaleRevision() {
  const state = await seed(talkingHeadAnalysis());
  const stale = state.project.revision - 1;
  await expectStatus(state.presets.preview(state.projectId,
    { presetId: 'MINIMAL', revision: stale }), 400);
  await expectStatus(state.presets.apply(state.projectId,
    { presetId: 'MINIMAL', revision: stale }), 400);
  await expectStatus(state.service.applyPresetBundle(state.projectId, stale, {
    presetId: 'MINIMAL', presetRunId: 'run-x', summary: 's', plannedZoomMoments: [], commands: []
  }), 409);
  // The current revision is accepted.
  const applied = await state.presets.apply(state.projectId,
    { presetId: 'MINIMAL', revision: state.project.revision });
  assert.equal(applied.project.revision, state.project.revision + 1);
}

// --- 29 / 30. no-prompt flow and the deterministic fallback ---------------
async function testNoPromptAndFallback() {
  // No prompt is passed anywhere: a preset id is the entire input.
  const state = await seed(talkingHeadAnalysis());
  const plan = await state.presets.preview(state.projectId,
    { presetId: 'INSTAGRAM_REEL_PROFESSIONAL' });
  assert.equal(plan.generation, 'DETERMINISTIC',
    'with no provider configured the planner is fully deterministic');
  assert(plan.summary.length > 10 && plan.plannedChanges.length > 0,
    'the no-prompt plan is a real professional transformation, not a no-op');
  const applied = await state.presets.apply(state.projectId,
    { presetId: 'INSTAGRAM_REEL_PROFESSIONAL' });
  assert(applied.project.elements.length > 1);
  assert.equal(state.llm.calls, 0, 'FALLBACK_ONLY / unconfigured routing calls no provider');

  // Two runs of the deterministic planner on the same evidence agree.
  const repeat = await seed(talkingHeadAnalysis());
  const first = await repeat.presets.preview(repeat.projectId, { presetId: 'PODCAST_CLIP' });
  const second = await repeat.presets.preview(repeat.projectId, { presetId: 'PODCAST_CLIP' });
  assert.deepEqual(first.style, second.style, 'deterministic planning is reproducible');
  assert.deepEqual(commandActions(first), commandActions(second));

  // A configured provider that fails falls back to the deterministic path
  // instead of failing the plan.
  const failing = await seed(talkingHeadAnalysis(), { llm: { calls: 0,
    isAnyConfigured() { return true; },
    async generate() { this.calls++; throw new Error('provider down'); } } });
  const resilient = await failing.presets.preview(failing.projectId,
    { presetId: 'MOTIVATIONAL' });
  assert.equal(failing.llm.calls, 1, 'the configured provider was attempted');
  assert.equal(resilient.generation, 'DETERMINISTIC', 'a provider failure degrades, never throws');
  await failing.presets.apply(failing.projectId, { presetId: 'MOTIVATIONAL' });

  // A provider returning clickbait or claims the source never makes is
  // discarded by the same grounding rules the deterministic path uses, and the
  // plan falls back to the deterministic headline instead.
  const ungrounded = await seed(talkingHeadAnalysis(), { llm: { calls: 0,
    isAnyConfigured() { return true; },
    async generate() {
      this.calls++;
      return { data: { hooks: [
        { text: 'You Won’t Believe This Shocking Truth' },
        { text: 'Hovercraft Telepathy Fizzbuzz Quibble Zeppelin Marmalade' },
        { text: 'and' }] },
      metadata: {} };
    } } });
  const rejected = await ungrounded.presets.preview(ungrounded.projectId,
    { presetId: 'MOTIVATIONAL' });
  assert(!/shocking truth|won.t believe|hovercraft|fizzbuzz/iu
    .test(String(rejected.style.hookText ?? '')),
  'clickbait and ungrounded claims never reach the timeline');
  assert.equal(rejected.generation, 'DETERMINISTIC',
    'a fully rejected model proposal falls back to the deterministic path');
  // Whatever headline survives is built from words the source actually says.
  if (rejected.style.hookText) {
    const spoken = new Set(SPEECH.map((word) => word.toLowerCase().replace(/[^a-z0-9]/gu, '')));
    const content = String(rejected.style.hookText).toLowerCase()
      .match(/[a-z0-9]+/gu).filter((word) => word.length >= 4);
    assert(content.some((word) => spoken.has(word) || spoken.has(word.replace(/s$/u, ''))),
      'the surviving headline is grounded in the transcript');
  }

  // A grounded provider headline is accepted and marked as LLM-assisted.
  const grounded = 'Compound Interest Beats Timing The Market';
  const assisted = await seed(talkingHeadAnalysis(), { llm: { calls: 0,
    isAnyConfigured() { return true; },
    async generate() { this.calls++; return { data: { hooks: [{ text: grounded }] },
      metadata: {} }; } } });
  const assistedPlan = await assisted.presets.preview(assisted.projectId,
    { presetId: 'MOTIVATIONAL' });
  assert.equal(assistedPlan.style.hookText, grounded, 'a grounded headline is used verbatim');
  assert.equal(assistedPlan.generation, 'LLM_ASSISTED');
  const assistedApplied = await assisted.presets.apply(assisted.projectId,
    { presetId: 'MOTIVATIONAL' });
  const hookElement = assistedApplied.project.elements.find((element) =>
    element.properties.presetRole === 'HOOK');
  assert(hookElement, 'the headline is placed as a preset-owned TEXT element');
  assert.equal(hookElement.properties.content, grounded);
  assert.equal(hookElement.startTime, 0);
  assert.equal(readEditProjectStyle(assistedApplied.project.settings).hookText, grounded);

  // A source with no transcript can never produce a hook.
  const silent = await seed({ source: 'NONE', frames: [], shotBoundaries: [], ocrText: '' },
    { transcript: null });
  const silentPlan = await silent.presets.preview(silent.projectId,
    { presetId: 'MOTIVATIONAL' });
  assert.equal(silentPlan.style.hookText, null);
  assert.equal(silentPlan.style.hookPolicy, 'OFF');
  assert.equal(silentPlan.style.subtitlePolicy, 'OFF');
  assert.equal(silentPlan.style.zoomPolicy, 'OFF');
  assert.equal(silentPlan.estimatedChanges.trims, 0);
}

async function main() {
  const suites = [
    ['preset catalogue', testCatalogue],
    ['invalid preset rejected', testInvalidPreset],
    ['SOURCE_MANUAL applies nothing', testSourceManual],
    ['talking-head presets', testTalkingHeadPresets],
    ['podcast plan', testPodcastPlan],
    ['educational information preservation', testEducationalPlan],
    ['product promo with and without assets', testProductPromo],
    ['cached transcript and analysis reuse', testCachedAnalysisReuse],
    ['auto-pipeline isolation', testIsolation],
    ['PREVIEW does not mutate, APPLY does', testPreviewAndApply],
    ['one preset application is one revision', testOneHistoryRevision],
    ['undo and redo a preset', testUndoRedo],
    ['reapply preserves manual work', testReapplyPreservesManualWork],
    ['generated command validation', testCommandValidation],
    ['stale revision rejected', testStaleRevision],
    ['no-prompt flow and deterministic fallback', testNoPromptAndFallback]
  ];
  for (const [name, suite] of suites) {
    await suite();
    console.log(`  ok  ${name}`);
  }
  console.log('EditMode Phase 4 tests passed: presets, content-aware planning, PREVIEW/APPLY, ' +
    'single-revision PRESET history, undo/redo, manual-edit preservation, command validation, ' +
    'and frozen-pipeline isolation.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
