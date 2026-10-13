const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { assertQaStack } = require('./xeefree-qa-safety.cjs');
const backend = assertQaStack().find(c => c.Name === '/xeeqa-backend');
assert(backend.Config.Env.some(line => line.startsWith('NODE_OPTIONS=') && line.includes('xeefree-provider-trap.cjs')));
const result = spawnSync('docker', ['logs', backend.Id], { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 });
assert.equal(result.status, 0);
const raw = result.stdout + result.stderr;
assert(raw.includes('xeefree_provider_trap_ready'));
const events = raw.replace(/\u001b\[[0-9;]*m/g, '').split('\n').flatMap(line => {
  try { return [JSON.parse(line.slice(line.indexOf('{')))]; } catch { return []; }
});
const summaries = events.filter(e => e.event === 'pipeline_performance_summary');
assert(summaries.length > 0, 'Actual Free jobs must have completed');
for (const summary of summaries) {
  assert.equal(summary.executionMode, 'XEEFREE');
  for (const key of ['openAiCalls', 'cloudLlmCalls', 'proEscalations', 'blockedProviderAttempts']) assert.equal(summary[key], 0, key);
}
assert(!events.some(e => ['xeefree_provider_trap', 'llm_request', 'llm_route'].includes(e.event)));
assert(!events.some(e => e.reason === 'XEEFREE_PROVIDER_VIOLATION'));
const report = { passed: true, backendImage: backend.Image, providerEntriesTrapped: 6,
  completedAnalysisJobs: summaries.length, openAiCalls: 0, cloudLlmCalls: 0,
  proEscalations: 0, blockedProviderAttempts: 0, providerEntryAttempts: 0,
  jobs: summaries.map(e => ({ videoId: e.videoId, executionMode: e.executionMode, totalMs: e.totalMs,
    openAiCalls: e.openAiCalls, cloudLlmCalls: e.cloudLlmCalls, proEscalations: e.proEscalations,
    blockedProviderAttempts: e.blockedProviderAttempts })) };
const target = process.argv[2];
if (target) { fs.writeFileSync(target, JSON.stringify(report, null, 2)); fs.writeFileSync(target + '.log', raw); }
console.log(JSON.stringify({ ...report, jobs: undefined }));
