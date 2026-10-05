// Steps 7 + 8 - the AI editor agent: tool registry, instruction ledger,
// execution through canonical commands, verification from reloaded state,
// correction, self-review, autonomy gating, constraints, follow-ups and the
// OpenAI planner (with a scripted fake model). Offline / in-memory.
process.env.EDIT_MODE_CHAT_PROPOSAL_REDIS = 'false';
process.env.EDIT_MODE_CHAT_AI_MODE = 'FALLBACK_ONLY';
const assert = require('node:assert/strict');
const { seedRichProject } = require('./lib-edit-mode-ai-fixture.cjs');
const { EditAgentService, genericVerify } = require('../dist/modules/edit-mode/agent/edit-agent.service.js');
const { agentTools, toolCatalog } = require('../dist/modules/edit-mode/agent/edit-agent-tools.js');
const { fastPath, normalizeRequest } = require('../dist/modules/edit-mode/agent/edit-agent-fastpath.js');
const { AGENT_PLAN_SCHEMA } = require('../dist/modules/edit-mode/agent/edit-agent-planner.js');
const { EditReviewService } = require('../dist/modules/edit-mode/review/edit-review.service.js');
const { EditReviewStore } = require('../dist/modules/edit-mode/review/edit-review-store.js');
const { LlmProviderError } = require('../dist/modules/processing/llm-provider.service.js');

let checks = 0;
const ok = (label, condition = true) => { assert.ok(condition, label); checks += 1;
  console.log(`  ok  ${label}`); };
const els = (p, type) => p.elements.filter((e) => e.type === type);

async function agentFor(options = {}) {
  const s = await seedRichProject(options);
  const reviews = new EditReviewService(s.harness.prisma, new EditReviewStore(), s.chat);
  const exports = [];
  const render = { startExport: async (id, revision) => { exports.push({ id, revision });
    return { export: { exportId: `export-${exports.length}` } }; } };
  const llm = options.llm ?? { isAnyConfigured: () => false,
    generate: async () => { throw new Error('no model'); } };
  const agent = new EditAgentService(s.harness.prisma, s.service, s.chat, s.templates, reviews,
    render, llm);
  const run = async (message, extra = {}) => {
    const project = await s.refresh();
    return agent.run(s.id, { message, revision: project.revision, playheadSec: 14, ...extra });
  };
  return { s, agent, run, exports };
}

const statusOf = (result, fragment) => result.ledger.find((entry) =>
  entry.clause.toLowerCase().includes(fragment));

async function main() {
  console.log('Steps 7/8 - AI editor agent\n');

  // ---- registry ---------------------------------------------------------------
  const names = agentTools().map((tool) => tool.name);
  for (const category of ['VIDEO', 'TEXT', 'HOOK', 'CAPTIONS', 'COLOR', 'AUDIO', 'ZOOM', 'OVERLAYS',
    'TEMPLATES', 'REVIEW', 'EXPORT']) {
    ok(`tool registry covers ${category}`, agentTools().some((tool) => tool.category === category));
  }
  ok('no tool can run shell/FFmpeg/SQL/DOM', !JSON.stringify(toolCatalog()).match(/shell|ffmpeg|sql|dom|exec/iu));
  ok('the OpenAI plan schema only allows registered tool names',
    JSON.stringify(AGENT_PLAN_SCHEMA).includes('"enum"') &&
    names.every((name) => JSON.stringify(AGENT_PLAN_SCHEMA).includes(`"${name}"`)));

  // ---- the brief's 8-clause example, no AI -------------------------------------
  {
    const { s, run } = await agentFor();
    const before = await s.refresh();
    const cuts = JSON.stringify(els(before, 'VIDEO').map((e) => [e.trimStart, e.trimEnd]));
    const captionWords = JSON.stringify(els(before, 'SUBTITLE').map((e) => e.properties.content));
    const result = await run('Crop whole video to 9:16, make captions white with yellow active words, ' +
      'move them lower, shorten hook, add subtle zooms, set music to 15%, warm the color, put logo top right');
    const after = await s.refresh();
    ok('every clause is accounted for in the ledger (8 entries, in order)', result.ledger.length === 8 &&
      result.ledger.every((entry, index) => entry.index === index && entry.clause.length > 0));
    ok('every ledger entry has an explicit status and verification',
      result.ledger.every((entry) => entry.status && entry.verification));
    ok('crop whole video 9:16 -> canonical framing, verified', statusOf(result, 'crop').status === 'DONE' &&
      statusOf(result, 'crop').verification === 'VERIFIED' && after.settings.aspectRatio === '9:16' &&
      els(after, 'VIDEO').every((e) => e.properties.frameLayout === 'FILL'));
    ok('captions white + yellow active words, verified on every caption',
      statusOf(result, 'white').verification === 'VERIFIED' &&
      els(after, 'SUBTITLE').every((e) => String(e.properties.color).toUpperCase() === '#FFFFFF' &&
        e.properties.activeWord?.enabled === true));
    ok('"move them lower" chains onto the captions', statusOf(result, 'lower').status === 'DONE' &&
      els(after, 'SUBTITLE').every((e) => e.properties.y > els(before, 'SUBTITLE')[0].properties.y));
    const hook = statusOf(result, 'hook');
    ok('shorten hook is accounted (done or an honest question)', ['DONE', 'NEEDS_INPUT'].includes(hook.status));
    ok('add subtle zooms -> zoom events at emphasis moments (or honest question)',
      (statusOf(result, 'zoom').status === 'DONE' && els(after, 'EFFECT').length > 0) ||
      statusOf(result, 'zoom').status === 'NEEDS_INPUT');
    ok('music to 15% verified on the music clip', statusOf(result, 'music').verification === 'VERIFIED' &&
      els(after, 'AUDIO').every((e) => e.properties.volume === 0.15));
    ok('warm the color verified', statusOf(result, 'warm').status === 'DONE' &&
      els(after, 'VIDEO').every((e) => e.properties.colorAdjustments?.temperature > 0));
    ok('logo top right done', statusOf(result, 'logo').status === 'DONE' &&
      els(after, 'IMAGE')[0].properties.x > 0.5 && els(after, 'IMAGE')[0].properties.y < 0.1);
    ok('cuts and caption wording preserved', JSON.stringify(els(after, 'VIDEO').map((e) =>
      [e.trimStart, e.trimEnd])) === cuts && JSON.stringify(els(after, 'SUBTITLE').map((e) =>
      e.properties.content)) === captionWords);
    ok('the element edits are ONE revision (one undo step)', result.revisions.length === 1 &&
      after.revision === before.revision + 1);
    ok('a substantial task gets a self-review with evidence separate from suggestions',
      result.review && result.review.items.every((item) => Array.isArray(item.evidence)));
    ok('no fake viral score anywhere', !JSON.stringify(result).match(/viral|guaranteed/iu));
    const undone = await s.service.undo(s.id, after.revision);
    ok('one undo restores the whole agent edit', undone.settings.aspectRatio !== '9:16' &&
      els(undone, 'AUDIO')[0].properties.volume === 0.2);
    await s.service.redo(s.id, undone.revision);

    // ---- follow-up conversation ------------------------------------------------
    let current = await s.refresh();
    const zoomBefore = els(current, 'EFFECT').map((e) => e.properties.scale);
    const zooms = await run('zooms too strong');
    current = await s.refresh();
    ok('"zooms too strong" -> canonical zooms weaker (verified)', zoomBefore.length === 0 ||
      (zooms.ledger[0].verification === 'VERIFIED' &&
        els(current, 'EFFECT').every((e, i) => e.properties.scale < zoomBefore[i])));
    const sizeBefore = els(current, 'SUBTITLE')[0].properties.fontSize;
    const captions = await run('captions still too big');
    current = await s.refresh();
    ok('"captions still too big" -> global captions smaller', captions.ledger[0].status === 'DONE' &&
      els(current, 'SUBTITLE').every((e) => e.properties.fontSize < sizeBefore));
    const music = await run('music a little lower');
    current = await s.refresh();
    ok('"music a little lower" -> the current music lower', music.ledger[0].status === 'DONE' &&
      els(current, 'AUDIO')[0].properties.volume < 0.15);
    const hookEl = () => els(current, 'TEXT').find((e) => e.properties.presetRole === 'HOOK');
    const hookX = hookEl().properties.x;
    const moveHook = await run('move hook left');
    current = await s.refresh();
    ok('"move hook left" -> the SAME hook moves left', moveHook.ledger[0].status === 'DONE' &&
      hookEl().properties.x <= hookX);
    const finish = await run('finish it');
    ok('"finish it" inspects the project and reports completion honestly',
      finish.ledger.length >= 1 && finish.review !== undefined &&
      finish.ledger.every((entry) => entry.status && entry.detail !== undefined));
  }

  // ---- Hinglish fallback, vague without AI --------------------------------------
  {
    ok('Hinglish normalization is small and plain', normalizeRequest('music thoda kam karo') === 'music a little lower' &&
      normalizeRequest('captions niche rakho') === 'captions lower');
    const { s, run } = await agentFor();
    const before = await s.refresh();
    const hinglish = await run('music thoda kam karo');
    let after = await s.refresh();
    ok('"music thoda kam karo" lowers the music without AI', hinglish.ledger[0].status === 'DONE' &&
      els(after, 'AUDIO')[0].properties.volume < els(before, 'AUDIO')[0].properties.volume);
    const niche = await run('captions niche rakho');
    after = await s.refresh();
    ok('"captions niche rakho" moves captions lower without AI', niche.ledger[0].status === 'DONE');
    const vague = await run('make it premium');
    ok('vague creative request without AI is honestly UNSUPPORTED (no fake understanding)',
      vague.ledger[0].status === 'UNSUPPORTED' && /AI editor/u.test(vague.ledger[0].detail) &&
      /Manual editing and automatic generation are still available/u.test(vague.ledger[0].detail));
  }

  // ---- OpenAI planner (scripted fake model) --------------------------------------
  {
    process.env.EDIT_MODE_CHAT_AI_MODE = 'ONLINE';
    const seen = [];
    const llm = { isAnyConfigured: () => true,
      async generate({ request }) {
        seen.push(JSON.parse(request.userPrompt));
        const payload = JSON.parse(request.userPrompt);
        return { data: { clauses: payload.clausesToPlan.map((clause) => ({ index: clause.index,
          intent: 'Premium, clean look', question: '', unsupported: '', calls: [
            { tool: 'color.filter', args: [{ name: 'filterId', number: null, text: 'CINEMATIC', flag: null },
              { name: 'strength', number: 0.5, text: null, flag: null }] },
            { tool: 'captions.style', args: [{ name: 'fontWeight', number: 600, text: null, flag: null },
              { name: 'color', number: null, text: '#FFFFFF', flag: null }] },
            { tool: 'audio.music_volume', args: [{ name: 'factor', number: 0.7, text: null, flag: null }] },
            { tool: 'not.a.tool', args: [] }] })) },
        metadata: { provider: 'openai', model: 'test' } };
      } };
    const { s, run } = await agentFor({ llm });
    const result = await run('professional bana do, cinematic but natural');
    const after = await s.refresh();
    ok('vague/Hinglish clauses go to OpenAI with a bounded context and the tool catalogue',
      seen.length === 1 && seen[0].tools.length === agentTools().length &&
      JSON.stringify(seen[0].project).length < 20000 && !JSON.stringify(seen[0]).includes('asset-source'));
    ok('the model plan is executed through canonical tools and verified',
      result.ledger[0].planSource === 'OPENAI' && result.ledger[0].status === 'DONE' &&
      result.ledger[0].verification === 'VERIFIED' &&
      result.ledger.every((entry) => entry.status === 'DONE') &&
      els(after, 'SUBTITLE').every((e) => e.properties.fontWeight === 600));
    ok('invented tool names are dropped, never executed',
      result.ledger.every((entry) => entry.toolCalls.every((call) => call.tool !== 'not.a.tool')));
    const failing = { isAnyConfigured: () => true, async generate() {
      throw new LlmProviderError('RATE_LIMIT_FAILURE', 'slow down', 429); } };
    const { run: run429 } = await agentFor({ llm: failing });
    const limited = await run429('make it more energetic');
    ok('OpenAI 429 -> honest RATE_LIMITED message, nothing faked', limited.ledger[0].status === 'UNSUPPORTED' &&
      /rate-limited/u.test(limited.ledger[0].detail) && limited.ai.state !== 'AVAILABLE');
    const mixed = await run429('make captions yellow and make it more energetic');
    ok('with AI down, simple clauses still execute deterministically',
      mixed.ledger[0].status === 'DONE' && mixed.ledger[1].status === 'UNSUPPORTED');
    process.env.EDIT_MODE_CHAT_AI_MODE = 'FALLBACK_ONLY';
  }

  // ---- constraints, autonomy, destructive confirmation ---------------------------
  {
    const { s, run, agent } = await agentFor();
    const blocked = await run('crop whole video to 9:16', { constraints: [{ type: 'PROTECT_CROP' }] });
    let after = await s.refresh();
    ok('task constraint "don\'t change crop" blocks the AI crop', blocked.ledger[0].status === 'BLOCKED_BY_CONSTRAINT' &&
      (after.settings.aspectRatio ?? 'SOURCE') !== '9:16');
    after = await s.service.phase3Command(s.id, 'set-video-framing', { revision: after.revision,
      mode: 'ASPECT', aspectRatio: '9:16' });
    ok('...but the user can still crop manually afterwards', after.settings.aspectRatio === '9:16');

    const words = JSON.stringify(els(after, 'SUBTITLE').map((e) => e.properties.content));
    const protectedText = await run('make captions yellow and regenerate captions',
      { constraints: [{ type: 'PROTECT_CAPTION_TEXT' }], autonomy: 'AI_AUTONOMOUS' });
    after = await s.refresh();
    ok('PROTECT_CAPTION_TEXT: style allowed, regeneration blocked',
      protectedText.ledger[0].status === 'DONE' && protectedText.ledger[1].status === 'BLOCKED_BY_CONSTRAINT' &&
      JSON.stringify(els(after, 'SUBTITLE').map((e) => e.properties.content)) === words);

    const durationBefore = els(after, 'VIDEO').reduce((t, e) => t + e.duration, 0);
    const destructive = await run('remove from 2 seconds to 5 seconds');
    after = await s.refresh();
    ok('a destructive cut waits for confirmation (AI_ASSISTED)',
      destructive.ledger[0].status === 'NEEDS_CONFIRMATION' &&
      Math.abs(els(after, 'VIDEO').reduce((t, e) => t + e.duration, 0) - durationBefore) < 1e-6);
    const confirmed = await run('yes, do it');
    after = await s.refresh();
    ok('"yes, do it" executes the held cut', confirmed.ledger[0].status === 'DONE' &&
      els(after, 'VIDEO').reduce((t, e) => t + e.duration, 0) < durationBefore - 2.5);

    const manual = await run('make captions red', { autonomy: 'MANUAL' });
    after = await s.refresh();
    ok('MANUAL autonomy plans but never applies', manual.ledger[0].status === 'NEEDS_CONFIRMATION' &&
      !els(after, 'SUBTITLE').some((e) => String(e.properties.color).toUpperCase() === '#FF3B30'));
    const autonomousCut = await run('remove from 1 seconds to 2 seconds', { autonomy: 'AI_AUTONOMOUS' });
    ok('AI_AUTONOMOUS executes destructive work when granted', autonomousCut.ledger[0].status === 'DONE');
    const state = await agent.state(s.id);
    ok('runs persist on the project (reload-safe)', state.runs.length >= 1);
  }

  // ---- manual correction survives the agent --------------------------------------
  {
    const { s, run } = await agentFor();
    let project = await s.refresh();
    const caption = els(project, 'SUBTITLE')[0];
    project = await s.service.phase3Command(s.id, 'set-caption-text', { revision: project.revision,
      elementId: caption.id, content: 'OpenAI fixed wording' });
    await run('make captions smaller and make captions yellow');
    project = await s.refresh();
    ok('a manual caption correction survives AI caption styling',
      project.elements.find((e) => e.id === caption.id).properties.content === 'OpenAI fixed wording');
  }

  // ---- verification is real ------------------------------------------------------
  {
    const commands = [{ kind: 'ELEMENT', action: 'SET_AUDIO_VOLUME', payload: { elementId: 'a', volume: 0.3 } }];
    const results = [{ index: 0, action: 'SET_AUDIO_VOLUME', status: 'DONE', scope: 'SELECTED_ELEMENT',
      affectedElementIds: ['a'], affectedCount: 1 }];
    const good = genericVerify(commands, results, { revision: 2, settings: {}, elements: [
      { id: 'a', type: 'AUDIO', startTime: 0, duration: 1, trimStart: 0, trimEnd: 1, properties: { volume: 0.3 } }] });
    const bad = genericVerify(commands, results, { revision: 2, settings: {}, elements: [
      { id: 'a', type: 'AUDIO', startTime: 0, duration: 1, trimStart: 0, trimEnd: 1, properties: { volume: 0.9 } }] });
    ok('tool success != task success: verification reads the reloaded value', good.ok && !bad.ok &&
      /volume=0.3 on 0\/1/u.test(bad.evidence.join(' ')));
  }

  ok('fast path claims "finish it" and confirmations', fastPath('finish it').intent === 'FINISH' &&
    fastPath('yes, do it').intent === 'CONFIRM');
  console.log(`\nSteps 7/8 agent tests passed (${checks} checks).`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
