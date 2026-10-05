// Workstream G: a realistic, disposable EditMode project for AI chat tests.
//
// Built entirely through the real EditModeService on the in-memory harness from
// test-edit-mode-isolation.cjs - every element exists because an ordinary
// canonical command created it, exactly as it would in the editor. Nothing here
// talks to Postgres, Redis, MinIO or a model.

process.env.EDIT_MODE_CHAT_PROPOSAL_REDIS = 'false';
process.env.EDIT_MODE_CHAT_AI_MODE = process.env.EDIT_MODE_CHAT_AI_MODE || 'FALLBACK_ONLY';

const { createHarness, seedAnalyzedProject } = require('./test-edit-mode-isolation.cjs');
const { EditChatService } = require('../dist/modules/edit-mode/chat/edit-chat.service.js');
const { EditChatProposalStore } = require('../dist/modules/edit-mode/chat/edit-chat-proposal-store.js');
const { EditTemplateService } = require('../dist/modules/edit-mode/edit-template.service.js');

/** An opening that the grounded hook writer has real material in. */
const SPEECH = [
  'Interest rates are still high even though inflation has cooled.',
  'The central bank raised the overnight rate eleven times in a row.',
  'Most people never noticed that savings accounts quietly pay more now.',
  'But mortgage holders are paying the hidden cost every single month.',
  'Here is why the bank refused to cut rates this year.',
  'Later I will explain what that means for your savings and your debt.'
];

function transcript(durationSec) {
  let cursor = 0.4;
  const segments = SPEECH.map((sentence) => {
    const words = sentence.split(/\s+/u).map((text) => {
      const start = Number(cursor.toFixed(3));
      cursor += 0.42;
      return { text, start, end: Number((cursor - 0.06).toFixed(3)) };
    });
    cursor += 0.5;
    return { text: sentence, start: words[0].start, end: words[words.length - 1].end, words };
  });
  if (cursor > durationSec) throw new Error('fixture transcript overruns the source');
  return { text: SPEECH.join(' '), language: 'en', segments };
}

/** Face samples centred slightly right of frame, so "keep the person centred" has evidence. */
function analysis(durationSec) {
  const frames = [];
  for (let t = 0; t < durationSec; t += 1) {
    frames.push({ t, faces: [{ x: 0.52, y: 0.2, w: 0.16, h: 0.28, confidence: 0.9 }],
      textBoxes: [], motion: 0.1, brightness: 0.5 });
  }
  return { source: 'DENSE', frames, shotBoundaries: [],
    summary: { sampledFrameCount: frames.length, faceDetections: frames.length,
      mouthActivitySamples: 0, shotCount: 1, ocrRegionCount: 0 } };
}

const DURATION = 36;

/**
 * Hook (preset role) + logo + music + captions + three video segments, with a
 * template available by name. Returns the service graph and small helpers.
 */
async function seedRichProject(options = {}) {
  const harness = createHarness();
  const seeded = await seedAnalyzedProject(harness);
  const { service, rows } = harness;
  const id = seeded.project.id;
  const source = rows.editAssets.get('asset-source');
  Object.assign(source, { duration: DURATION, transcript: transcript(DURATION),
    analysis: analysis(DURATION) });
  // The seed's single VIDEO element is 12.5s; stretch it to the fixture source.
  const video = [...rows.editElements.values()].find((row) => row.type === 'VIDEO');
  Object.assign(video, { duration: DURATION, trimStart: 0, trimEnd: DURATION });

  const now = new Date();
  const asset = (idValue, role, originalName, extra = {}) => rows.editAssets.set(idValue, {
    id: idValue, editProjectId: id, role, originalName, bucket: 'test-bucket',
    objectKey: `edit-mode/${id}/${idValue}/${originalName}`, mimeType: 'application/octet-stream',
    sizeBytes: 1024n, duration: null, width: null, height: null, fps: null, metadata: {},
    transcript: null, analysis: null, createdAt: now, updatedAt: now, ...extra });
  asset('asset-logo', 'LOGO', 'brand-logo.png', { width: 400, height: 200 });
  asset('asset-music', 'AUDIO', 'lofi-beat.mp3', { duration: 90 });
  if (options.secondLogo) asset('asset-logo2', 'LOGO', 'intro-logo.png', { width: 300, height: 300 });

  let project = await service.get(id);
  const run = async (action, input) => {
    project = await service.phase3Command(id, action, { revision: project.revision, ...input });
    return project;
  };
  const byType = (type) => project.elements.filter((element) => element.type === type);

  // Three segments: split at 12s and 24s (`split: false` keeps one contiguous clip).
  if (options.split !== false) {
    project = await service.splitElement(id, { revision: project.revision,
      elementId: byType('VIDEO')[0].id, playheadSec: 12 });
    project = await service.splitElement(id, { revision: project.revision,
      elementId: byType('VIDEO').find((element) => element.startTime === 12).id, playheadSec: 24 });
  }

  // The hook, exactly as a preset writes one: presetRole HOOK on a TEXT element.
  if (options.hook !== false) {
    await run('ADD_TEXT', { textStyleId: 'HOOK', content: 'Why Are Rates Still So High?',
      origin: 'PRESET', presetId: 'MOTIVATIONAL', presetRole: 'HOOK' });
    const hook = byType('TEXT').at(-1);
    await run('SET_ELEMENT_TIMING', { elementId: hook.id, startTime: 0, duration: 3.5 });
  }
  await run('ADD_LOGO', { assetId: 'asset-logo' });
  if (options.secondLogo) await run('ADD_LOGO', { assetId: 'asset-logo2' });
  await run('ADD_AUDIO', { assetId: 'asset-music' });
  await run('SET_AUDIO_VOLUME', { elementId: byType('AUDIO')[0].id, volume: 0.2 });
  await run('GENERATE_CAPTIONS', { captionStyleId: 'CLEAN' });

  const llm = options.llm ?? { isAnyConfigured: () => false,
    generate: async () => { throw new Error('no model in this test'); }, calls: 0 };
  const templates = new EditTemplateService(harness.prisma, service);
  const chat = new EditChatService(harness.prisma, service, new EditChatProposalStore(), llm,
    templates);

  /** Plans one message and (optionally) applies it, with the editor's live state. */
  const say = async (message, extra = {}) => {
    project = await service.get(id);
    const planned = await chat.plan(id, { message, revision: project.revision,
      selectedElementId: extra.selectedElementId ?? null,
      selectedTimeRange: extra.selectedTimeRange ?? null,
      playheadSec: extra.playheadSec ?? 0 });
    return planned;
  };
  const apply = async (planned) => {
    project = await service.get(id);
    const result = await chat.apply(id, { proposalId: planned.proposal.proposalId,
      revision: project.revision });
    project = await service.get(id);
    return result;
  };
  const sayAndApply = async (message, extra = {}) => {
    const planned = await say(message, extra);
    if (planned.proposal.needsClarification) {
      throw new Error(`"${message}" asked instead of proposing: ${
        planned.proposal.clarificationQuestion}`);
    }
    const applied = await apply(planned);
    return { planned, applied };
  };
  const refresh = async () => { project = await service.get(id); return project; };

  return { harness, service, rows, id, chat, templates, llm, say, apply, sayAndApply, refresh,
    get project() { return project; }, byType, DURATION };
}

module.exports = { seedRichProject, SPEECH, DURATION };
