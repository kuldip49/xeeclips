// EditMode Phase 7 - live chat planner soak.
//
// Puts representative real requests through the whole planning path against a
// really configured provider and reports the rates that matter for trusting it:
// how often the model returns schema-valid JSON, how often its grounding
// survives the transcript check, how often it honestly asks instead of
// guessing, how often it emits something malformed, and what it costs in
// latency. Nothing is applied - this calls plan only, so it writes no edit.
//
//   node scripts/soak-edit-mode-chat.cjs [--mode ONLINE|OFFLINE] [--runs 2]
//
// It uses an in-memory project fixture, never a real EditProject, so it cannot
// touch anyone's work. Run it inside the backend container, where the provider
// keys live.

const { Logger } = require('@nestjs/common');
const { buildChatContext } = require('../dist/modules/edit-mode/chat/edit-chat-context');
const { planDeterministicChat } = require('../dist/modules/edit-mode/chat/edit-chat-deterministic');
const { planWithLlm, chatPlannerAiMode } =
  require('../dist/modules/edit-mode/chat/edit-chat-planner');
const { resolveChatPlan } = require('../dist/modules/edit-mode/chat/edit-chat-resolver');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { wordsFromCache } = require('../dist/modules/edit-mode/presets/edit-preset-evidence');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const SPEECH = 'Welcome back everyone. Today I want to talk about our pricing model and why ' +
  'we changed it. The old plan charged per seat which punished growing teams. Our new pricing ' +
  'is usage based instead. Later I will explain compound interest and how it applies to ' +
  'reinvesting your savings over many years.';

function transcript() {
  const sentences = SPEECH.split(/(?<=[.])\s+/u);
  let cursor = 0.5;
  const segments = sentences.map((sentence) => {
    const words = sentence.split(/\s+/u).map((text) => {
      const start = Number(cursor.toFixed(3));
      cursor += 0.4;
      return { word: text, start, end: Number((cursor - 0.05).toFixed(3)) };
    });
    cursor += 0.3;
    return { text: sentence, start: words[0].start, end: words[words.length - 1].end, words };
  });
  return { text: SPEECH, language: 'en', segments };
}

const SOURCE_DURATION = 40;
const STYLE = {
  selectedPreset: 'SOURCE_MANUAL', aspectRatio: 'SOURCE', pacing: 'SOURCE',
  subtitlePolicy: 'OFF', hookPolicy: 'OFF', zoomPolicy: 'OFF', reframePolicy: 'SOURCE',
  musicPolicy: 'KEEP_EXISTING', gradingPolicy: 'NONE', textPolicy: 'OFF',
  overlayPolicy: 'NONE', informationRegionPolicy: 'RESPECT', hookText: null
};

function contextFor(message, selection = {}) {
  const parsed = wordsFromCache(transcript());
  return buildChatContext({
    revision: 4, settings: {}, style: STYLE,
    elements: [
      { id: 'video-1', type: 'VIDEO', track: 0, position: 0, startTime: 0, duration: 20,
        assetId: 'asset-source', trimStart: 0, trimEnd: 20, properties: {} },
      { id: 'video-2', type: 'VIDEO', track: 0, position: 1, startTime: 20, duration: 20,
        assetId: 'asset-source', trimStart: 20, trimEnd: 40, properties: {} },
      { id: 'logo-1', type: 'IMAGE', track: 2, position: 0, startTime: 0, duration: 40,
        assetId: 'asset-logo', trimStart: 0, trimEnd: null,
        properties: { role: 'LOGO', x: 0.76, y: 0.04, width: 0.2, height: 0.12, opacity: 1,
          zIndex: 20, origin: 'USER' } },
      { id: 'audio-1', type: 'AUDIO', track: 3, position: 0, startTime: 0, duration: 20,
        assetId: 'asset-audio', trimStart: 0, trimEnd: 20,
        properties: { volume: 0.4, muted: false, fadeInSec: 0, fadeOutSec: 0 } }
    ],
    assets: [
      { id: 'asset-source', role: 'SOURCE', originalName: 'source.mp4',
        duration: SOURCE_DURATION, width: 1280, height: 720 },
      { id: 'asset-logo', role: 'LOGO', originalName: 'logo.png', duration: null,
        width: 400, height: 240 },
      { id: 'asset-audio', role: 'AUDIO', originalName: 'music.mp3', duration: 60,
        width: null, height: null },
      { id: 'asset-product', role: 'IMAGE', originalName: 'product-shot.png', duration: null,
        width: 800, height: 800 }
    ],
    evidence: {
      sourceDurationSec: SOURCE_DURATION, sourceWidth: 1280, sourceHeight: 720,
      sourceAspect: 16 / 9, hasAudioStream: true,
      transcriptAvailable: true, wordTimingsAvailable: true, analysisAvailable: true,
      analysisSource: 'DENSE', transcriptText: parsed.text, words: parsed.words,
      phrases: [], frames: [], shots: [], informationRegion: null, semanticPeaks: [],
      informationShotRatio: 0.2, faceShotRatio: 0.6, pairShotRatio: 0.3,
      leadInSilenceSec: 0.5, tailSilenceSec: 0.4, ocrText: ''
    },
    thread: { messages: [], lastAffectedElementIds: [], lastAppliedSummary: '',
      lastAppliedAtRevision: -1 },
    selection: { selectedElementId: null, selectedTimeRange: null, playheadSec: 0, ...selection },
    message
  });
}

/** The prompt set Phase 7 asks for, one per representative shape. */
const PROMPTS = [
  { kind: 'simple deterministic', message: 'mute the music' },
  { kind: 'simple deterministic', message: 'remove the first 3 seconds' },
  { kind: 'selection-aware', message: 'make this smaller',
    selection: { selectedElementId: 'logo-1' } },
  { kind: 'selection-aware', message: 'delete this section',
    selection: { selectedTimeRange: { startSec: 12, endSec: 18 }, playheadSec: 12 } },
  { kind: 'asset-aware', message: 'add my logo in the top right corner' },
  { kind: 'asset-aware', message: 'show the product image for the last 3 seconds' },
  { kind: 'transcript semantic cut', message: 'cut the part where I discuss pricing' },
  { kind: 'transcript semantic cut', message: 'remove the bit about compound interest' },
  { kind: 'ambiguous follow-up', message: 'make it smaller' },
  { kind: 'ambiguous follow-up', message: 'move that up a bit' },
  { kind: 'multi-command', message: 'remove the first 2 seconds and mute the music' },
  { kind: 'multi-command', message: 'make it 9:16 and turn subtitles on' },
  { kind: 'style', message: 'give it a cinematic look' },
  { kind: 'style', message: "don't crop the slides" }
];

async function main() {
  const mode = arg('mode', '').toUpperCase();
  // The planner resolves its own mode; --mode just sets the same setting, so
  // the soak measures exactly what a real chat turn would do.
  if (mode) process.env.EDIT_MODE_CHAT_AI_MODE = mode;
  const effective = chatPlannerAiMode();
  const runs = Math.max(1, Number(arg('runs', 1)));
  const llm = new LlmRouterService();
  const logger = new Logger('soak');
  const routesAvailable = llm.routesFor('editingPlan', effective);
  const configured = routesAvailable.length > 0;

  console.log(`EditMode chat planner soak — mode ${effective}, ${runs} run(s) per prompt`);
  console.log(`editingPlan routing configured: ${configured}`);
  if (!configured) {
    console.log('\nNo provider serves editingPlan in this mode, so every non-deterministic ' +
      'request falls back. That is the documented OFFLINE/FALLBACK_ONLY behaviour.');
  }
  const routes = llm.routesFor('editingPlan', mode);
  console.log(`routes: ${routes.map((route) => `${route.provider}:${route.model}`).join(', ') ||
    'none'}\n`);

  const results = [];
  for (const prompt of PROMPTS) {
    for (let run = 0; run < runs; run += 1) {
      const context = contextFor(prompt.message, prompt.selection ?? {});
      const started = Date.now();
      const record = { ...prompt, run, planner: 'DETERMINISTIC', ms: 0,
        schemaValid: true, malformed: false, clarification: false, grounded: false,
        commands: 0, fellBack: false, error: '' };

      const deterministic = planDeterministicChat(prompt.message, context);
      if (deterministic) {
        record.ms = Date.now() - started;
        record.clarification = deterministic.needsClarification;
        record.commands = deterministic.commands.length;
        record.grounded = deterministic.grounding.length > 0;
        if (!record.clarification && deterministic.commands.length) {
          const resolution = resolveChatPlan(deterministic.commands, deterministic.grounding,
            context);
          if (!resolution.ok) { record.clarification = true; record.commands = 0; }
        }
        results.push(record);
        continue;
      }

      // Nothing deterministic matched: this is a real model turn.
      record.planner = 'LLM';
      try {
        const planned = await planWithLlm({ llm, logger, message: prompt.message, context });
        record.ms = Date.now() - started;
        if (!planned) {
          record.planner = 'FALLBACK';
          record.fellBack = true;
          results.push(record);
          continue;
        }
        const intent = planned.intent;
        record.provider = planned.provider;
        record.model = planned.model;
        record.clarification = intent.needsClarification;
        record.commands = intent.commands.length;
        record.grounded = intent.grounding.some((entry) => entry.confidence >= 0.45);
        if (!record.clarification && intent.commands.length) {
          const resolution = resolveChatPlan(intent.commands, intent.grounding, context);
          if (!resolution.ok) {
            record.clarification = true;
            record.commands = 0;
            record.resolutionQuestion = resolution.question.slice(0, 60);
          }
        }
      } catch (error) {
        record.ms = Date.now() - started;
        record.schemaValid = false;
        record.malformed = true;
        record.error = (error?.response?.message ?? error.message ?? String(error)).slice(0, 90);
      }
      results.push(record);
    }
  }

  // --- Report --------------------------------------------------------------
  const llmTurns = results.filter((record) => record.planner === 'LLM');
  const rate = (count, total) => total ? `${((count / total) * 100).toFixed(0)}%` : 'n/a';
  const median = (values) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  console.log('kind                    | message                                   | planner     | cmds | outcome');
  console.log('------------------------+-------------------------------------------+-------------+------+---------');
  for (const record of results) {
    const outcome = record.malformed ? `MALFORMED (${record.error})`
      : record.clarification ? 'clarify'
        : record.fellBack ? 'fallback' : 'plan';
    console.log(`${record.kind.padEnd(23)} | ${record.message.slice(0, 41).padEnd(41)} | ` +
      `${record.planner.padEnd(11)} | ${String(record.commands).padStart(4)} | ` +
      `${outcome} ${record.ms}ms`);
  }

  console.log('\nRates');
  console.log(`  total turns              ${results.length}`);
  console.log(`  handled deterministically ${results.filter((r) => r.planner === 'DETERMINISTIC')
    .length} (${rate(results.filter((r) => r.planner === 'DETERMINISTIC').length,
    results.length)}) - free, instant, no provider`);
  console.log(`  reached the model         ${llmTurns.length}`);
  if (llmTurns.length) {
    console.log(`  schema-valid responses    ${rate(llmTurns.filter((r) => r.schemaValid).length,
      llmTurns.length)}`);
    console.log(`  malformed / rejected      ${rate(llmTurns.filter((r) => r.malformed).length,
      llmTurns.length)}`);
    console.log(`  produced a plan           ${rate(llmTurns.filter((r) => !r.malformed &&
      !r.clarification && r.commands > 0).length, llmTurns.length)}`);
    console.log(`  asked for clarification   ${rate(llmTurns.filter((r) => r.clarification)
      .length, llmTurns.length)}`);
    console.log(`  grounded (>=0.45 conf)    ${rate(llmTurns.filter((r) => r.grounded).length,
      llmTurns.length)}`);
    console.log(`  latency median            ${median(llmTurns.map((r) => r.ms))}ms`);
    console.log(`  latency max               ${Math.max(...llmTurns.map((r) => r.ms))}ms`);
  }
  console.log(`  fell back to deterministic ${results.filter((r) => r.fellBack).length}`);
  console.log('\nNo edit was applied: this run calls plan only.');
}

void main().catch((error) => { console.error(error); process.exit(1); });
