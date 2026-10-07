// Live check that a quality-rejected creative draft escalates to CREATIVE_ESCALATION_MODEL.
// The primary draft is intentionally weak (injected, no provider call); the escalation and the
// grounding review go through the real router and OpenAI. Makes no database/storage writes.
// Usage: npm run build && node scripts/verify-creative-escalation-live.cjs
require('reflect-metadata');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
process.loadEnvFile(resolve(__dirname, '../../../.env'));
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { CreativePackageService, publicCreativePackage } =
  require('../dist/modules/content-intelligence/creative-package.service');
const { performanceContext, createPerformanceTelemetry } =
  require('../dist/modules/processing/performance-telemetry');

const escalationModel = process.env.CREATIVE_ESCALATION_MODEL?.trim();
const primaryModel = process.env.CREATIVE_PRIMARY_MODEL?.trim() || process.env.LLM_MODEL?.trim()
  || process.env.OPENAI_MODEL?.trim();
// Authored two-speaker exchange; no third-party media or personal data.
const turns = [
  ['SPEAKER_00', 'Why do so many people say yes to things they already know they cannot keep up with?'],
  ['SPEAKER_01', 'Because they are chasing approval. When every decision depends on what other people think, '
    + 'you agree to requests you cannot sustain. Protecting focused work means saying no, and accepting '
    + 'that some people will disagree with you. That is how your boundaries become sustainable.']];
const transcript = turns.map(t => t[1]).join(' ');
const evidence = { sourceId: 'escalation-live-check', transcript,
  speakerTurns: turns.map(([speaker, text]) => ({ speaker, text })) };
// Copied transcript lines, filler synopsis and spam tags: CreativeQualityService must reject this.
const weakDraft = { hooks: [
  { text: 'Because they are chasing approval', category: 'BOLD' },
  { text: 'You agree to requests you cannot sustain', category: 'WARNING' }],
  synopsis: 'This video discusses mindset and success.', supportingLine: '',
  captions: [{ style: 'Concise', text: 'Watch till the end!' }],
  hashtagSets: [{ label: 'Focused', hashtags: ['#viral', '#fyp'] }, { label: 'Niche', hashtags: ['#trending'] },
    { label: 'Broad', hashtags: ['#shorts'] }] };

async function main() {
  assert.ok(escalationModel, 'CREATIVE_ESCALATION_MODEL must be configured');
  assert.notEqual(escalationModel, primaryModel, 'escalation must be a distinct model');
  const metrics = createPerformanceTelemetry('ONLINE');
  await performanceContext.run(metrics, async () => {
    const router = new LlmRouterService();
    const calls = [];
    const observed = { async generate(input) {
      const call = { role: input.role, tier: input.creativeTier ?? null, started: Date.now() };
      calls.push(call);
      if (input.role === 'creativeGeneration' && input.creativeTier === 'PRIMARY') {
        call.injected = true;
        return { data: structuredClone(weakDraft), metadata: { role: input.role, provider: 'injected-weak-draft',
          model: 'none', attempts: [] } };
      }
      const result = await router.generate(input);
      if (input.creativeTier === 'ESCALATION') call.draft = result.data;
      Object.assign(call, { provider: result.metadata.provider, model: result.metadata.model,
        latencyMs: Date.now() - call.started });
      return result;
    } };
    const pkg = await new CreativePackageService(observed).create({ evidence, external: true });
    const creative = calls.filter(c => c.role === 'creativeGeneration');
    const escalated = creative.find(c => c.tier === 'ESCALATION');
    const report = { checkedAt: new Date().toISOString(), primaryModel, escalationModel,
      calls: calls.map(({ started, ...c }) => c), escalations: pkg.internal.escalations, status: pkg.status,
      quality: pkg.quality, hooks: pkg.hooks.map(h => h.text), synopsis: pkg.synopsis,
      captions: pkg.captions.map(c => c.text), hashtagSets: pkg.hashtagSets, supportingLine: pkg.supportingLine,
      cloudLlmCalls: metrics.cloudLlmCalls };
    const out = resolve(__dirname, '../../../.real-qa-preview/content-intelligence');
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, 'escalation-live.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));

    assert.deepEqual(creative.map(c => c.tier), ['PRIMARY', 'ESCALATION'], 'weak draft must escalate once');
    assert.equal(pkg.internal.escalations, 1);
    assert.equal(escalated.provider, 'openai');
    assert.equal(escalated.model, escalationModel, 'escalation must use the configured stronger model');
    // Only text roles run; understanding happens once before generation and is never repeated.
    assert.ok(calls.every(c => ['clipUnderstanding', 'creativeGeneration', 'critic'].includes(c.role)), 'creative-only roles');
    assert.ok(calls.filter(c => c.role === 'clipUnderstanding').length <= 1);
    assert.ok(!calls.slice(calls.indexOf(creative[0])).some(c => c.role === 'clipUnderstanding'));
    for (const c of calls.filter(c => c.role !== 'creativeGeneration'))
      assert.notEqual(c.model, escalationModel, c.role + ' must stay on the default model');
    assert.ok(!pkg.hooks.some(h => weakDraft.hooks.some(w => w.text === h.text)), 'weak hooks never surface');
    const visible = JSON.stringify(publicCreativePackage(pkg));
    assert.ok(!visible.includes(escalationModel) && !visible.includes(String(primaryModel)), 'no model names in public package');
    console.log(JSON.stringify({ verified: true, escalatedTo: escalationModel, status: pkg.status,
      escalationLatencyMs: escalated.latencyMs }));
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
