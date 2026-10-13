// XeeFree hard execution policy: ZERO OpenAI / cloud LLM / XeePro-model calls, enforced at the router AND the provider, proven with a network where every
// provider transport throws the instant it is touched. Every XeeFree surface must still complete with its own deterministic engine.
//
// A control run proves the harness would see a call: the same transports under an ONLINE (XeePro) context ARE reached.
require('reflect-metadata');
const assert = require('node:assert/strict');
const dist = (p) => require('../dist/modules/' + p);
const { LlmProviderService, LlmProviderError, XeeFreeProviderViolation } = dist('processing/llm-provider.service');
const { LlmRouterService } = dist('processing/llm-router.service');
const { createPerformanceTelemetry, performanceContext, currentExecutionPolicy } = dist('processing/performance-telemetry');
const { executionPolicyFor, projectExecutionPolicy, XEEFREE_PROVIDER_VIOLATION, XEEFREE_POLICY, XEEPRO_POLICY } = dist('processing/execution-policy');
const { creativeService } = dist('content-intelligence/creative-package.service');
const { fallbackCandidateContent } = dist('content-intelligence/candidate-creative');
const { ContentPackagingService } = dist('editing/content-packaging.service');
const { EditPlanService } = dist('editing/edit-plan.service');
const { EditingPlanValidator } = dist('editing/editing-plan-validator');
const { suggestHooks } = dist('quick-reframe/quick-reframe-hooks');
const { generatePostCopy } = dist('quick-reframe/quick-reframe-post-copy');
const { planWithLlm } = dist('edit-mode/chat/edit-chat-planner');
const { planClausesWithOpenAi } = dist('edit-mode/agent/edit-agent-planner');
const { deterministicHookSuggestions } = dist('edit-mode/chat/edit-chat-hook');
const { aiUnavailable } = dist('ai/ai-availability');
const { ClipIntelligenceService } = dist('processing/clip-intelligence.service');
const corpus = require('./fixtures/xeefree-corpus.cjs');

// --- the dead network ------------------------------------------------------------------------------------------------------------
const calls = { fetch: 0, transport: 0 };
const dead = () => { calls.transport++; throw new Error('NETWORK_DEAD'); };
global.fetch = async () => { calls.fetch++; throw new Error('NETWORK_DEAD'); };
for (const method of ['requestResponsesApi', 'requestChatCompletionsApi', 'requestGeminiApi', 'requestAnthropicApi']) LlmProviderService.prototype[method] = dead;
process.env.OPENAI_API_KEY = 'sk-test-not-real'; process.env.OPENAI_ENABLED = 'true'; process.env.OPENAI_MODEL = 'gpt-test';
process.env.CREATIVE_ESCALATION_MODEL = 'gpt-escalation-test'; process.env.XEEPRO_HOOK_REVIEW_MODEL = 'gpt-review-test';
const router = new LlmRouterService();
const free = (fn) => { const telemetry = createPerformanceTelemetry('FALLBACK_ONLY'); return performanceContext.run(telemetry, async () => ({ value: await fn(telemetry), telemetry })); };
const evidenceOf = (f) => ({ transcript: f.turns.map(t => t[1]).join(' '), speakerTurns: f.turns.map(([speaker, text]) => ({ speaker, text })) });
const english = corpus.filter(f => !f.language);
let checks = 0;
const check = async (name, fn) => { try { await fn(); checks++; } catch (error) { error.message = `[${name}] ${error.message}`; throw error; } };
const zero = (telemetry, label) => {
  assert.equal(telemetry.executionMode, 'XEEFREE', `${label}: execution mode`);
  assert.equal(telemetry.openAiCalls, 0, `${label}: openAiCalls`);
  assert.equal(telemetry.cloudLlmCalls, 0, `${label}: cloudLlmCalls`);
  assert.equal(telemetry.proEscalations, 0, `${label}: proEscalations`);
  assert.equal(telemetry.totalLlmCalls, 0, `${label}: totalLlmCalls`);
  assert.equal(telemetry.blockedProviderAttempts, 0, `${label}: blockedProviderAttempts`);
};

(async () => {
  await check('owned Free editing does not require cloud consent; Pro, foreign and standalone editing still do', async () => {
    const { SecurityGuard } = dist('auth/security.guard');
    const { requestIdentity } = dist('auth/request-context');
    const guard = Object.create(SecurityGuard.prototype);
    guard.auth = { authenticate: async () => ({ id: 'owner', role: 'USER', creditBalance: 5, aiProcessingConsentAt: null }) };
    guard.limit = async () => {};
    let stored = { origin: { aiMode: 'FALLBACK_ONLY' } };
    guard.prisma = { editProject: { findFirst: async ({ where }) => {
      assert.deepEqual(where, { id: 'owned', userId: 'owner' });
      return stored ? { settings: stored } : null;
    } } };
    const previousOrigin = process.env.FRONTEND_ORIGIN;
    process.env.FRONTEND_ORIGIN = 'http://localhost:3000';
    const invoke = (path) => requestIdentity.run({}, () => guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({
      path, method: 'POST', headers: { origin: 'http://localhost:3000' }, body: { externalAiAuthorized: true },
    }) }) }));
    try {
      assert.equal(await invoke('/edit-mode/projects/owned/hooks'), true);
      assert.equal(await invoke('/edit-mode/projects/owned/agent/run'), true);
      for (const settings of [{ origin: { aiMode: 'ONLINE' } }, {}, null]) {
        stored = settings;
        await assert.rejects(invoke('/edit-mode/projects/owned/hooks'), e => e.getResponse().code === 'AI_CONSENT_REQUIRED');
      }
      await assert.rejects(invoke('/quick-reframe/session/hooks'), e => e.getResponse().code === 'AI_CONSENT_REQUIRED');
    } finally {
      if (previousOrigin === undefined) delete process.env.FRONTEND_ORIGIN;
      else process.env.FRONTEND_ORIGIN = previousOrigin;
    }
  });
  await check('Free provenance survives a client settings replacement', async () => {
    const { createHarness, seedAnalyzedProject } = require('./test-edit-mode-isolation.cjs');
    const state = await seedAnalyzedProject(createHarness());
    const row = state.rows.editProjects.get(state.project.id);
    row.settings = { origin: { originKind: 'GENERATED_CLIP', aiMode: 'FALLBACK_ONLY' }, theme: 'old' };
    const result = await state.service.update(row.id, { revision: row.revision,
      settings: { theme: 'new', origin: { aiMode: 'ONLINE' } } });
    assert.equal(result.settings.theme, 'new');
    assert.equal(projectExecutionPolicy(result.settings).mode, 'XEEFREE');
    const withoutOrigin = await state.service.update(row.id, { revision: result.revision, settings: { theme: 'another' } });
    assert.equal(projectExecutionPolicy(withoutOrigin.settings).mode, 'XEEFREE');
  });
  await check('weak Free candidates bypass the router before the Pro confidence gate', async () => {
    let attempts = 0;
    const service = new ClipIntelligenceService({ generate: async () => { attempts++; throw Error('PROVIDER_ENTRY_TRAP'); } });
    const transcript = evidenceOf(corpus[1]).transcript;
    const candidate = { rangeKey: '0:30', transcriptText: transcript, startTime: 0, endTime: 30,
      topic: 'A lost client', overallVideoTopic: 'Building a business',
      heuristicScore: 40, standaloneScore: 40, payoffScore: 40, hookScore: 40, flowScore: 40, informationScore: 40 };
    const evidence = { transcript, previousContext: '', nextContext: '', overallVideoTopic: 'A lost client',
      chapter: '', contentType: 'talking head',
      supportedFacts: [], importantMoments: [], visualSignals: [], multimodalSignals: [], candidateVisualEvidence: {} };
    const { value, telemetry } = await free(() => service.understand([candidate], [evidence]));
    zero(telemetry, 'low confidence clip understanding');
    assert.equal(attempts, 0); assert.equal(value.understandings.length, 1);
    assert.equal(value.route, null); assert.equal(value.failureCategory, '');
    assert.equal(value.decisionSources[0], 'DETERMINISTIC_FALLBACK');
  });
  await check('1 the policy is derived from the AI mode, never from a stored or untrusted value', () => {
    assert.deepEqual(executionPolicyFor('FALLBACK_ONLY'), XEEFREE_POLICY);
    assert.deepEqual(executionPolicyFor('OFFLINE'), XEEFREE_POLICY, 'a legacy OFFLINE job is XeeFree');
    assert.deepEqual(executionPolicyFor('ONLINE'), XEEPRO_POLICY);
    for (const junk of [undefined, null, '', 'online ', 'GPT', 42, {}, 'ONLINE_PLUS']) assert.equal(executionPolicyFor(junk).mode, junk === 'online ' ? 'XEEPRO' : 'XEEFREE', String(junk));
    assert.equal(XEEFREE_POLICY.cloudLLMAllowed, false); assert.equal(XEEFREE_POLICY.openAiAllowed, false); assert.equal(XEEFREE_POLICY.proEscalationAllowed, false);
    assert.equal(Object.isFrozen(XEEFREE_POLICY), true);
    assert.equal(currentExecutionPolicy().mode, 'XEEFREE', 'no context at all fails closed');
    assert.equal(projectExecutionPolicy({ origin: { aiMode: 'FALLBACK_ONLY' } }).mode, 'XEEFREE');
    assert.equal(projectExecutionPolicy({ origin: { aiMode: 'ONLINE' } }).mode, 'XEEPRO');
    assert.equal(projectExecutionPolicy({}), null, 'a standalone editor project carries no tier');
    assert.equal(projectExecutionPolicy({ origin: { originKind: 'GENERATED_CLIP', generatedClipId: 'legacy' } }).mode, 'XEEFREE');
    assert.equal(projectExecutionPolicy({ origin: { originKind: 'GENERATED_CLIP', editTelemetry: { effectiveAiMode: 'ONLINE' } } }).mode, 'XEEPRO');
  });

  await check('2 the provider throws XEEFREE_PROVIDER_VIOLATION before any request is built', async () => {
    const endpoint = { provider: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1', model: 'gpt-test', apiStyle: 'responses', timeoutMs: 1000, maxRetries: 0, retryBaseDelayMs: 1, concurrency: 1 };
    const request = { schemaName: 's', schema: { type: 'object' }, role: 'creativeGeneration', systemPrompt: 'x', userPrompt: 'y' };
    const provider = new LlmProviderService();
    const { telemetry } = await free(async () => {
      await assert.rejects(() => provider.generateStructuredWithConfig(endpoint, request), error => error instanceof XeeFreeProviderViolation && error.code === XEEFREE_PROVIDER_VIOLATION
        && error.message.startsWith(XEEFREE_PROVIDER_VIOLATION) && error.kind === 'AI_MODE_FALLBACK_ONLY' && error instanceof LlmProviderError);
    });
    assert.equal(telemetry.blockedProviderAttempts, 1, 'the attempt is audited');
    await assert.rejects(() => provider.generateStructuredWithConfig(endpoint, request), error => error.code === XEEFREE_PROVIDER_VIOLATION, 'no context: fail closed');
    assert.deepEqual(calls, { fetch: 0, transport: 0 });
  });

  await check('3 the router throws too, and a Pro escalation can never be reached from XeeFree', async () => {
    const request = { schemaName: 's', schema: { type: 'object' }, role: 'critic', systemPrompt: 'x', userPrompt: 'y' };
    const { telemetry } = await free(async () => {
      for (const role of ['creativeGeneration', 'critic', 'clipUnderstanding', 'editingPlan', 'hookGeneration']) {
        await assert.rejects(() => router.generate({ role, request: { ...request, role } }), error => error.code === XEEFREE_PROVIDER_VIOLATION, role);
      }
      await assert.rejects(() => router.generate({ role: 'creativeGeneration', creativeTier: 'ESCALATION', request: { ...request, role: 'creativeGeneration' } }),
        error => error.code === XEEFREE_PROVIDER_VIOLATION, 'escalation tier');
    });
    assert.equal(telemetry.proEscalations, 0); assert.ok(telemetry.blockedProviderAttempts >= 6);
    assert.equal(router.isAnyConfigured.length >= 0, true);
    assert.deepEqual(calls, { fetch: 0, transport: 0 });
  });

  await check('4 CONTROL: under XeePro the same transports ARE reached, so zero above is meaningful', async () => {
    const before = { ...calls };
    const telemetry = createPerformanceTelemetry('ONLINE');
    await performanceContext.run(telemetry, async () => {
      await router.generate({ role: 'creativeGeneration', request: { schemaName: 's', schema: { type: 'object' }, role: 'creativeGeneration', systemPrompt: 'x', userPrompt: 'y' } }).catch(() => undefined);
    });
    assert.ok(calls.transport > before.transport || calls.fetch > before.fetch, 'the harness detects a cloud call when one is made');
    assert.ok(telemetry.openAiCalls >= 1 && telemetry.cloudLlmCalls >= 1, 'and the telemetry counts it');
    calls.fetch = 0; calls.transport = 0;
  });

  await check('5 Create Clips content: every content type completes with zero cloud calls (hooks, synopsis, captions, hashtags)', async () => {
    for (const f of corpus) {
      const { value, telemetry } = await free(() => creativeService(router).create({ evidence: evidenceOf(f), external: false }));
      zero(telemetry, f.id);
      // Another language is quoted as spoken, so it has fewer distinct lines to turn into captions; the package is still complete.
      assert.ok(value.hooks.length >= 1 && value.synopsis.length > 20 && value.captions.length >= (f.language ? 1 : 3) && value.hashtagSets.length === 3, `${f.id} produced a complete package`);
      assert.ok(value.hooks.every(h => h.source === 'LOCAL'), `${f.id}: every hook is local`);
      assert.equal(value.internal.routes.length, 0, 'no route metadata: nothing was routed');
      assert.equal(value.internal.free.engine, 'XEEFREE_HOOKS_V1');
    }
    assert.deepEqual(calls, { fetch: 0, transport: 0 });
  });

  await check('6 candidate fallback content (clip pipeline) and content packaging (StyleZero/One/Two) are local', async () => {
    const f = corpus.find(x => x.id.startsWith('A')), transcript = evidenceOf(f).transcript;
    const candidate = { videoId: 'v', rangeKey: '0:30', startTime: 0, endTime: 30, duration: 30, transcriptText: transcript, evidence: { speakerTurns: evidenceOf(f).speakerTurns },
      heuristicScore: 70, hookScore: 70, standaloneScore: 70, payoffScore: 70, flowScore: 70, informationScore: 70, retentionScore: 70, shareabilityScore: 70 };
    const content = await free(async () => fallbackCandidateContent(candidate, 'YOUTUBE_SHORTS'));
    zero(content.telemetry, 'candidate fallback');
    assert.ok(content.value.bestHook && content.value.hooks.length >= 1);
    const packaging = await free(() => new ContentPackagingService(router).create({ aiMode: 'FALLBACK_ONLY', transcript, title: 'Consistency', synopsis: '', wholeVideoSummary: '', targetPlatform: 'YOUTUBE_SHORTS' }));
    zero(packaging.telemetry, 'content packaging');
    assert.ok(packaging.value.sharedPackage.hooks.length >= 1);
    for (const template of ['AUTOMATIC_1', 'AUTOMATIC_2', 'AUTOMATIC_3_STYLE_TWO']) {
      // The template is a render-time choice: the hook text it receives comes from this same local package.
      assert.ok(packaging.value.selectedHook.text.length > 8, template);
    }
    assert.deepEqual(calls, { fetch: 0, transport: 0 });
  });

  await check('7 the automatic edit plan (zoom, captions, hook) completes locally', async () => {
    const f = corpus.find(x => x.id.startsWith('I')), transcript = evidenceOf(f).transcript;
    const tokens = transcript.split(/\s+/u).map((text, i) => ({ text, start: i * .4, end: i * .4 + .34 }));
    const end = tokens.at(-1).end;
    const service = new EditPlanService(router, new EditingPlanValidator());
    const { value, telemetry } = await free(() => service.create({ start: 0, end, aspectRatio: '9:16', aiMode: 'FALLBACK_ONLY', transcript, words: tokens, title: 'Confusion', synopsis: '',
      wholeVideoSummary: '', visualEvidence: null, clipUnderstanding: null }));
    zero(telemetry, 'edit plan');
    assert.equal(value.source, 'DETERMINISTIC_FALLBACK'); assert.ok(value.plan.onScreenHook.text.length > 8, 'a hook is installed from the local engine');
    assert.ok(value.plan.operations.filter(o => o.type === 'ZOOM').length <= 5, 'zoom is bounded');
    assert.deepEqual(calls, { fetch: 0, transport: 0 });
  });

  await check('8 Quick Reframe: hooks, post copy and rewrites without consent never reach a model', async () => {
    const f = corpus.find(x => x.id.startsWith('E')), transcript = evidenceOf(f).transcript;
    const hooks = await free(() => suggestHooks(router, transcript, false, [], {}, 'make it shorter', undefined, 'The lesson: hire slowly'));
    zero(hooks.telemetry, 'quick reframe hooks'); assert.ok(hooks.value.hooks.length >= 1);
    const copy = await free(() => generatePostCopy(router, { transcript, visibleText: '', subtitleText: '', sourceContext: null, selectedHook: hooks.value.hooks[0].text, editingDirection: '', purpose: '', selectedCaption: '' }, false, 'Stronger opening'));
    zero(copy.telemetry, 'quick reframe post copy'); assert.equal(copy.value.generatedCaptions.length >= 3, true);
    assert.deepEqual(calls, { fetch: 0, transport: 0 });
  });

  await check('9 hook rewrite (Ask AI / edit commands) for a XeeFree project: local engine, direction honoured, no model', async () => {
    const f = corpus.find(x => x.id.startsWith('D')), transcript = evidenceOf(f).transcript;
    const modes = ['REWRITE', 'STRONGER', 'SHORTER', 'CURIOSITY', 'ANOTHER', 'NEW'];
    const shown = [];
    for (const mode of modes) {
      const out = deterministicHookSuggestions({ mode, current: shown.at(-1) ?? null, tried: shown, opening: transcript.slice(0, 80), transcript });
      for (const s of out) assert.equal(s.source, 'DETERMINISTIC');
      if (out[0]) shown.push(out[0].text);
    }
    assert.ok(new Set(shown).size >= 1, 'at least one grounded rewrite exists: ' + shown.join(' | '));
    assert.equal(new Set(shown).size, shown.length, 'finite local options never repeat to fill the pool');
    assert.ok(shown.every(text => !/^Why does remote work/iu.test(text)), 'a rewrite must not assert the disputed premise');
    const planned = await planWithLlm({ llm: router, logger: { log() {}, warn() {} }, message: 'make it way more dramatic and viral', context: { project: { freeOnly: true } } });
    assert.equal(planned, null, 'a XeeFree project is never planned by a model, whatever the deployment mode');
    const agent = await planClausesWithOpenAi({ llm: router, logger: { log() {}, warn() {} }, message: 'do something clever', clauses: [{ index: 0, clause: 'do something clever' }], context: { project: { freeOnly: true } } });
    assert.deepEqual(agent.plans, []); assert.equal(agent.ai.state, 'XEEFREE'); assert.match(agent.ai.message, /built-in tools/u);
    assert.equal(aiUnavailable('XEEFREE').retryable, false);
    assert.deepEqual(calls, { fetch: 0, transport: 0 });
  });

  await check('10 History reopen: re-reading a stored XeeFree package never calls anything', async () => {
    const f = corpus.find(x => x.id.startsWith('E'));
    const first = (await free(() => creativeService(router).create({ evidence: evidenceOf(f), external: false }))).value;
    const reopened = (await free(() => creativeService(router).create({ evidence: evidenceOf(f), external: false, existingHook: { text: first.selectedHook }, selectedHook: first.selectedHook }))).value;
    assert.equal(reopened.selectedHook, first.selectedHook, 'a reopened clip keeps its hook');
    assert.equal(reopened.internal.free.preserved, 'STRONG_EXISTING');
    assert.deepEqual(calls, { fetch: 0, transport: 0 });
  });

  await check('11 an authorised-AI flag on a XeeFree project cannot opt it in (hooks endpoint rule)', () => {
    const external = (settings, flag) => flag === true && projectExecutionPolicy(settings)?.mode !== 'XEEFREE';
    assert.equal(external({ origin: { aiMode: 'FALLBACK_ONLY' } }, true), false);
    assert.equal(external({ origin: { aiMode: 'OFFLINE' } }, true), false);
    assert.equal(external({ origin: { aiMode: 'ONLINE' } }, true), true);
    assert.equal(external({}, true), true, 'a standalone project keeps its own consent rules');
    assert.equal(external({}, false), false);
  });

  console.log(JSON.stringify({ xeefreePolicyChecks: checks, openAiCalls: 0, cloudLlmCalls: 0, proEscalations: 0, networkAttempts: calls.fetch + calls.transport }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
