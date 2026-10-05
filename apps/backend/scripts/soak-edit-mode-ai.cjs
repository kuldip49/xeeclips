// Workstream G - live provider soak for the object-aware AI editor.
//
// Runs representative requests through the REAL EditChatService with the REAL
// LlmRouterService in the chosen AI mode, on the in-memory project fixture (so
// no one's work is touched and nothing is applied - plan only). Every model
// call is observed through a transparent proxy, and each raw response is judged
// by the production validator and resolver - not by the soak - so a reported
// success is a real schema-valid, grounded plan from a real provider.
//
//   node scripts/soak-edit-mode-ai.cjs [--mode ONLINE|OFFLINE] [--runs 1]
//
// Run inside the backend container, where the provider keys live.

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
process.env.EDIT_MODE_CHAT_AI_MODE = arg('mode', 'ONLINE');
const runs = Number(arg('runs', '1'));

const { seedRichProject } = require('./lib-edit-mode-ai-fixture.cjs');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { validateChatIntent, CHAT_MAX_MODEL_COMMANDS } =
  require('../dist/modules/edit-mode/chat/edit-chat-commands');

/** [area, message]. The second half is phrased so the deterministic layer does
 *  not recognise it, which is what actually exercises the model. */
const REQUESTS = [
  ['hook', 'change the hook'], ['hook', 'make the hook more curiosity based'],
  ['hook', 'give the headline more punch without overselling it'],
  ['text', 'make the hook bigger'], ['text', 'the opening title should be in yellow'],
  ['logo', 'make the logo smaller'], ['logo', 'the brand mark feels too dominant, tone it down'],
  ['audio', 'music is too loud'], ['audio', 'the backing track is overpowering my voice'],
  ['caption', 'make captions bigger'], ['caption', 'the subtitles are hard to read on a phone'],
  ['color', 'make it warmer'], ['color', 'give the footage a moodier, filmic feel'],
  ['zoom', 'zoom in here'], ['zoom', 'push in on me a touch when I start the second point'],
  ['crop', 'crop tighter'], ['crop', 'frame me a bit closer'],
  ['rotation', 'rotate 5 degrees'], ['rotation', 'the shot is slightly crooked, level it off'],
  ['template', 'use Clean Reel'], ['template', 'style it like a podcast clip']
];

async function main() {
  const base = new LlmRouterService();
  const calls = [];
  // Transparent: every property is the real router's; generate is timed.
  const llm = new Proxy(base, { get(target, key) {
    if (key !== 'generate') return typeof target[key] === 'function'
      ? target[key].bind(target) : target[key];
    return async (input) => {
      const started = Date.now();
      const record = { schema: input.request.schemaName, ms: 0, ok: false, error: null,
        provider: null, model: null, data: null };
      calls.push(record);
      try {
        const result = await target.generate(input);
        Object.assign(record, { ok: true, provider: result.metadata.provider,
          model: result.metadata.model, data: result.data });
        return result;
      } catch (error) {
        record.error = error instanceof Error ? error.message.slice(0, 160) : String(error);
        throw error;
      } finally { record.ms = Date.now() - started; }
    };
  } });

  const rows = [];
  for (let run = 0; run < runs; run += 1) {
    for (const [area, message] of REQUESTS) {
      const s = await seedRichProject({ llm });
      await s.templates.create({ name: 'Finance Reel', description: '' });
      const before = calls.length;
      const started = Date.now();
      let planned = null; let failure = null;
      try { planned = await s.say(message, { playheadSec: 7 }); }
      catch (error) { failure = error instanceof Error ? error.message : String(error); }
      const mine = calls.slice(before);
      const plans = mine.filter((call) => call.schema === 'edit_mode_chat_plan');
      const judged = plans.map((call) => {
        if (!call.ok) return 'CALL_FAILED';
        try { validateChatIntent(call.data, { maxCommands: CHAT_MAX_MODEL_COMMANDS }); return 'VALID'; }
        catch (error) { return `INVALID:${error.getResponse?.().code ?? 'SCHEMA'}`; }
      });
      const proposal = planned?.proposal;
      rows.push({ area, message, route: proposal?.route ?? 'ERROR', ms: Date.now() - started,
        modelCalls: mine.length, modelMs: mine.reduce((total, call) => total + call.ms, 0),
        providers: [...new Set(mine.filter((call) => call.ok)
          .map((call) => `${call.provider}/${call.model}`))].join(','),
        callErrors: mine.filter((call) => !call.ok).map((call) => call.error),
        planValidity: judged.join(','),
        outcome: failure ? `ERROR ${failure}` : proposal.needsClarification
          ? `ASK${proposal.code ? `(${proposal.code})` : ''}: ${proposal.clarificationQuestion.slice(0, 90)}`
          : `PROPOSE: ${(proposal.changes ?? []).map((change) =>
            `${change.label} ${change.before}->${change.after}`).join('; ').slice(0, 110) ||
            proposal.plannedChanges.join('; ').slice(0, 110)}` });
    }
  }

  for (const row of rows) {
    console.log(`[${row.area}] "${row.message}"\n    route=${row.route} ${row.ms}ms modelCalls=${
      row.modelCalls} modelMs=${row.modelMs} ${row.providers}${row.planValidity
      ? ` plan=${row.planValidity}` : ''}${row.callErrors.length ? ` callErrors=${
        JSON.stringify(row.callErrors)}` : ''}\n    ${row.outcome}`);
  }
  const modelRows = rows.filter((row) => row.modelCalls > 0);
  const planCalls = calls.filter((call) => call.schema === 'edit_mode_chat_plan');
  const hookCalls = calls.filter((call) => call.schema === 'edit_mode_chat_hook');
  const validPlans = planCalls.filter((call) => {
    if (!call.ok) return false;
    try { validateChatIntent(call.data, { maxCommands: CHAT_MAX_MODEL_COMMANDS }); return true; }
    catch { return false; }
  });
  const latencies = calls.filter((call) => call.ok).map((call) => call.ms).sort((a, b) => a - b);
  const pct = (p) => latencies.length ? latencies[Math.min(latencies.length - 1,
    Math.floor(p * latencies.length))] : 0;
  const summary = {
    mode: process.env.EDIT_MODE_CHAT_AI_MODE, requests: rows.length,
    routes: rows.reduce((acc, row) => ({ ...acc, [row.route]: (acc[row.route] ?? 0) + 1 }), {}),
    turnsThatCalledAModel: modelRows.length,
    planCalls: planCalls.length, planCallsSucceeded: planCalls.filter((call) => call.ok).length,
    planSchemaValid: validPlans.length,
    hookCalls: hookCalls.length, hookCallsSucceeded: hookCalls.filter((call) => call.ok).length,
    callFailures: calls.filter((call) => !call.ok).length,
    proposed: rows.filter((row) => row.outcome.startsWith('PROPOSE')).length,
    asked: rows.filter((row) => row.outcome.startsWith('ASK')).length,
    errors: rows.filter((row) => row.outcome.startsWith('ERROR')).length,
    modelLatencyMs: { p50: pct(0.5), p90: pct(0.9), max: latencies.at(-1) ?? 0 },
    providers: [...new Set(calls.filter((call) => call.ok)
      .map((call) => `${call.provider}/${call.model}`))]
  };
  console.log(`\nSUMMARY ${JSON.stringify(summary, null, 2)}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
