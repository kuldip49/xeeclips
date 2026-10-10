// Real-media acceptance: transcripts must first be extracted from the exact downloaded clips.
// Uses configured OpenAI routing; no database writes, deployment or production changes.
require('reflect-metadata');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
process.loadEnvFile(path.join(root, '.env'));
const dist = path.join(root, 'apps/backend/dist/modules');
const { CreativePackageService } = require(path.join(dist, 'content-intelligence/creative-package.service'));
const { LlmRouterService } = require(path.join(dist, 'processing/llm-router.service'));
const { performanceContext, createPerformanceTelemetry } = require(path.join(dist, 'processing/performance-telemetry'));
const { sharedQuality } = require(path.join(dist, 'content-intelligence/creative-quality.service'));
const { localUnderstanding } = require(path.join(dist, 'content-intelligence/content-understanding.service'));
const { hookFitsTemplates } = require(path.join(dist, 'content-intelligence/hook-fit'));
const output = path.join(root, '.real-qa-preview/xeepro-hook-grammar');
const fullPackage = process.argv.includes('--social-style');
(async () => {
  const results = [];
  for (const [id, oldHook] of [['file24', "What’s behind tell and reason?"], ['file23', "What’s behind puffing and agree?"]]) {
    const words = JSON.parse(fs.readFileSync(path.join(output, `${id}-words.json`), 'utf8'));
    const evidence = { sourceId: id, transcript: words.map(w => w.text).join(' ') };
    const old = sharedQuality.screen([{ text: oldHook, category: 'CURIOSITY' }], evidence,
      localUnderstanding(evidence), [], { strictLanguage: true, strictReference: true });
    assert.equal(old.passed.length, 0);
    const svc = new CreativePackageService(new LlmRouterService());
    let attributionControl;
    if (id === 'file24') {
      attributionControl = await performanceContext.run(createPerformanceTelemetry('ONLINE'), () =>
        svc.scoreHooks(evidence, [{text:'Why introduce Professor Randall Kennedy as a college dropout?',category:'CURIOSITY'}]));
      assert.equal(attributionControl[0].approved, false, 'must not attach the first-person self-description to Kennedy');
    }
    const p = await performanceContext.run(createPerformanceTelemetry('ONLINE'), () => svc.create({
      external: true, hooksOnly: !fullPackage, evidence, existingHook: { text: oldHook },
      direction: fullPackage
        ? 'Use the requested audience-facing social-video style: an interesting direct question and a specific reason to watch the exchange, not an editorial takeaway. Generate a detailed faithful synopsis and five relevant recommended hashtags. Use the actual speaker contrast or conversational turn; do not guess identities.'
        : 'Write a clear, bold, specific English hook grounded only in this exact clip. Prefer a clear subject and strong verb with its actual contrast or tension; preserve a complete sentence or headline. Avoid flat descriptions.' }));
    const selected = p.hooks.find(h => h.text === p.selectedHook);
    const result = { id, oldHook, transcript: evidence.transcript, oldRejections: old.rejected, attributionControl,
      newHook: p.selectedHook, status: p.status, quality: p.quality, selected, package: p,
      ...(fullPackage ? {synopsis:p.synopsis,socialHook:p.captions.find(c=>c.style==='Engaging')?.text,
        hashtags:p.hashtagSets.find(s=>s.label==='Focused')?.hashtags} : {}),
      grammar: selected?.review?.language?.GRAMMAR_OK, clarity: selected?.review?.language?.MEANING_CLEAR,
      grounding: selected?.review?.grounding, clickability: selected?.review?.clickability,
      context: selected?.review?.context, naturalness: selected?.review?.naturalness,
      templateFit: hookFitsTemplates(p.selectedHook) };
    results.push(result);
    fs.writeFileSync(path.join(output, fullPackage ? 'real-style-results.json' : 'real-results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ id, oldHook, newHook: result.newHook, status: p.status, grammar: result.grammar,
      clarity: result.clarity, grounding: result.grounding, clickability: result.clickability, context: result.context,
      naturalness: result.naturalness, templateFit: result.templateFit }));
    assert.ok(selected && result.grammar && result.clarity && result.templateFit.all, `${id}: acceptance incomplete`);
    if(fullPackage) {
      console.log(JSON.stringify({id,socialHook:result.socialHook,synopsis:result.synopsis,hashtags:result.hashtags}));
      assert.equal(p.status,'ACCEPTED',`${id}: full package failed review`);
      assert.ok(result.socialHook && result.synopsis);
      assert.equal(result.hashtags?.length,5,`${id}: exactly five relevant hashtags required`);
    }
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
