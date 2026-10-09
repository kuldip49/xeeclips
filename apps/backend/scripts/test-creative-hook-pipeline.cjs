// Offline regression for the hook pipeline: objective screen -> per-hook semantic review -> failure-driven escalation.
// No network: the router is faked, so each rule is pinned deterministically.
require('reflect-metadata');
const assert = require('node:assert/strict');
const dist = '../dist/modules/content-intelligence/';
const { CreativeQualityService, HOOK_POLICY, HOOK_RUBRIC, inventedNames, reviewMisses, rejectionGuidance } = require(dist + 'creative-quality.service');
const { CreativePackageService } = require(dist + 'creative-package.service');
const { localUnderstanding } = require(dist + 'content-understanding.service');
const { hookFitsTemplates } = require(dist + 'hook-fit');
const q = new CreativeQualityService();
const evidence = { transcript: 'I kept saying yes to everything until I realized I had no time left for myself. Saying yes to everyone was leaving no time for focused work. Protecting my priorities means accepting that some people will be unhappy with my decisions.',
  analysis: { mainClaim: 'Saying yes to everything costs the speaker their own time.', conclusion: 'Protecting priorities means accepting some disapproval.' } };
const u = localUnderstanding(evidence);
const meta = { role: 'x', provider: 'test', model: 'test', attempts: [] };
const good = (over = {}) => ({ approved: true, clickability: 85, context: 90, grounding: 92, misleadingRisk: 6, specificity: 80, naturalness: 90, summaryLike: false, issue: '', why: 'supported by the clip', ...over });
const hook = (text, category = 'CURIOSITY') => ({ text, category, support: 'the speaker describes having no time left for themselves' });
const pool = [
  hook("The hidden cost of always being the 'nice' one", 'HIDDEN_TRUTH'),
  hook('What saying yes to everyone quietly takes from you', 'CURIOSITY'),
  hook('Why disappointing people can protect your priorities', 'TENSION'),
  hook('Is your yes costing you the work that matters?', 'QUESTION'),
  hook('Being agreeable can quietly empty your calendar', 'CONTRARIAN')];
const reviewsFor = (n, f = () => ({})) => ({ reviews: Array.from({ length: n }, (_, index) => ({ index, ...good(), ...f(index) })) });
function router(handlers) {
  const calls = [];
  return { calls, async generate(input) {
    calls.push(input);
    const h = handlers[input.role]; if (!h) throw new Error('unexpected role ' + input.role);
    const data = await h(input, calls.filter(c => c.role === input.role).length);
    return { data, metadata: { ...meta, role: input.role } };
  } };
}
const hooksOnly = { external: true, hooksOnly: true, evidence: { ...evidence, sourceId: 'unit' } };
const seq = [];
(async () => {
  // 1. Grounding means the implied claim is supported, not that transcript words are reused.
  const nice = pool[0];
  assert.equal(q.screen([nice], evidence, u).passed.length, 1, 'zero-overlap paraphrase passes the objective screen');
  assert.equal(q.rank([nice], evidence, u, 'OPENAI').length, 0, 'an UNREVIEWED zero-overlap hook still needs the conservative lexical rule');
  const ranked = q.rankDetailed([{ ...nice, review: good() }], evidence, u, 'OPENAI');
  assert.equal(ranked.kept.length, 1, 'a hook whose meaning was reviewed is kept even with no shared vocabulary');
  assert.equal(ranked.kept[0].review.grounding, 92);
  seq.push('paraphrase grounding');

  // 2. One flawed alternate must not sink a strong hook, and only approved hooks are returned.
  let flawedText = '';
  const r2 = router({ clipUnderstanding: () => ({}), creativeGeneration: () => ({ hooks: pool }),
    critic: input => { flawedText = JSON.parse(input.request.userPrompt).hooks[1].text;
      return reviewsFor(5, i => i === 1 ? { grounding: 40, misleadingRisk: 80, approved: false, issue: 'claims a cause the clip never states' } : {}); } });
  const p2 = await new CreativePackageService(r2).create(hooksOnly);
  assert.equal(p2.status, 'ACCEPTED'); assert.equal(p2.internal.escalations, 0);
  assert.equal(p2.hooks.length, 4); assert(flawedText && !p2.hooks.some(h => h.text === flawedText), 'flawed alternate is dropped');
  assert(p2.hooks.every(h => h.review && h.review.approved), 'only reviewed, approved hooks are returned');
  assert(p2.internal.trace[0].rejected.some(r => r.text === flawedText && (r.code === 'LOW_GROUNDING' || r.code === 'MISLEADING')));
  assert.equal(r2.calls.filter(c => c.role === 'critic').length, 1, 'one reviewer call for the whole pool');
  seq.push('flawed alternate does not sink the package');

  // 3. Writer and reviewer share ONE definition of a strong hook, and the writer plans the wider pool.
  const gen = r2.calls.find(c => c.role === 'creativeGeneration').request.systemPrompt, crit = r2.calls.find(c => c.role === 'critic').request.systemPrompt;
  assert(gen.includes(HOOK_RUBRIC) && crit.includes(HOOK_RUBRIC), 'identical rubric in generator and reviewer');
  for (const mix of ['3 CURIOSITY', '2 CONTRARIAN', '2 HIDDEN_TRUTH', '2 TENSION', '2 QUESTION', '2 STORY', '1 EMOTIONAL', '1 BOLD', 'exactly 15']) assert(gen.includes(mix), mix);
  assert(HOOK_RUBRIC.includes('does NOT mean the hook reuses') && HOOK_RUBRIC.includes('Inference is allowed, invention is not'));
  const schema = r2.calls.find(c => c.role === 'creativeGeneration').request.schema.properties.hooks;
  assert.equal(schema.minItems, 8); assert.equal(schema.maxItems, 15); assert(schema.items.required.includes('support'));
  seq.push('shared rubric and 15-candidate plan');

  // 4. Escalation happens only for a creative verdict and carries the exact reasons.
  let genCalls = 0;
  const r4 = router({ clipUnderstanding: () => ({}),
    creativeGeneration: i => ++genCalls === 1 ? { hooks: [hook('A talk about boundaries and saying yes', 'CURIOSITY'), hook('The hidden cost of always being the agreeable one', 'HIDDEN_TRUTH'), hook('Your manager is exploiting your constant yes', 'CONTRARIAN')] } : { hooks: pool },
    // verdicts are keyed by hook text: the reviewer's list order is deliberately shuffled
    critic: (i, n) => n === 1
      ? { reviews: JSON.parse(i.request.userPrompt).hooks.map(h => ({ index: h.index, ...(h.text.startsWith('A talk about') ? good({ clickability: 30, specificity: 30, summaryLike: true, issue: 'flat topic description' })
        : h.text.includes('manager') ? good({ grounding: 10, misleadingRisk: 95, approved: false, issue: 'invents a manager and exploitation' }) : good({ clickability: 50, specificity: 60 })) })) }
      : reviewsFor(5) });
  const p4 = await new CreativePackageService(r4).create({ ...hooksOnly, evidence: { ...evidence, sourceId: 'esc' } });
  assert.equal(p4.status, 'ACCEPTED'); assert.equal(p4.internal.escalations, 1);
  const gens = r4.calls.filter(c => c.role === 'creativeGeneration');
  assert.deepEqual(gens.map(c => c.creativeTier), ['PRIMARY', 'ESCALATION']);
  assert.equal(JSON.parse(gens[0].request.userPrompt).reviewerFeedback, undefined, 'first pass gets no feedback');
  const fb = JSON.parse(gens[1].request.userPrompt).reviewerFeedback;
  assert(fb.problems.some(x => x.hook.includes('manager') && x.verdict.includes('MISLEADING')), 'names the misleading hook');
  assert(fb.problems.some(x => x.hook.startsWith('A talk about') && x.verdict.includes('GENERIC_SUMMARY')));
  assert(fb.instructions.some(s => /too generic/u.test(s)) && fb.instructions.some(s => /misleading/u.test(s) && /remove the unsupported implication/u.test(s)));
  assert(/reviewerFeedback/u.test(gens[1].request.systemPrompt) && /do not repeat a rejected hook/u.test(gens[1].request.systemPrompt));
  assert(p4.internal.trace[1].feedbackSent.instructions.length >= 2);
  seq.push('escalation carries exact failure reasons');

  // 5. A reviewer fault is not a creative verdict: retry once on a larger budget, never escalate.
  let attempts = 0;
  const r5 = router({ clipUnderstanding: () => ({}), creativeGeneration: () => ({ hooks: pool }),
    critic: () => { attempts++; throw new Error('LLM response contained no output text'); } });
  const p5 = await new CreativePackageService(r5).create({ ...hooksOnly, evidence: { ...evidence, sourceId: 'down' } });
  assert.equal(p5.status, 'NEEDS_REVIEW'); assert.equal(p5.internal.escalations, 0, 'no stronger writer for a reviewer outage');
  assert(p5.quality.failures.includes('GROUNDING_REVIEW_UNAVAILABLE')); assert.equal(attempts, 2);
  const budgets = r5.calls.filter(c => c.role === 'critic').map(c => c.request.options.maxOutputTokens);
  assert.equal(budgets[1], budgets[0] * 2, 'retry doubles the budget');
  assert.equal(r5.calls.filter(c => c.role === 'creativeGeneration').length, 1);
  let tries = 0;
  const r5b = router({ clipUnderstanding: () => ({}), creativeGeneration: () => ({ hooks: pool }), critic: () => { if (++tries === 1) throw new Error('truncated'); return reviewsFor(5); } });
  const p5b = await new CreativePackageService(r5b).create({ ...hooksOnly, evidence: { ...evidence, sourceId: 'trunc' } });
  assert.equal(p5b.status, 'ACCEPTED'); assert.equal(p5b.internal.escalations, 0);
  seq.push('reviewer fault retried, never escalated');

  // 6. Objective screen: invented facts and copied transcript never reach the reviewer.
  const screen = q.screen([
    { text: 'Why 90% of people-pleasers burn out first', category: 'BOLD' },
    { text: 'What Jordan Rivera knows about saying yes', category: 'AUTHORITY' },
    { text: 'I kept saying yes to everything until I realized I had no time', category: 'STORY' },
    { text: 'How boundaries work at work', category: 'PROFESSIONAL' },
    { text: 'Hi', category: 'BOLD' }, { text: 'Fine hook about time', category: 'NOT_A_CATEGORY' }], evidence, u);
  assert.equal(screen.passed.length, 0);
  const codes = Object.fromEntries(screen.rejected.map(r => [r.text.slice(0, 8), r.code]));
  assert.equal(q.screen([{ text: 'You will not believe what happens when you stop saying yes', category: 'CURIOSITY' }], evidence, u).rejected[0].code, 'FACTUAL_FILTER', 'filler clickbait phrasing is refused');
  assert.equal(codes['Why 90% '], 'FACTUAL_FILTER'); assert.equal(codes['What Jor'], 'INVENTED_NAME'); assert.equal(codes['I kept s'], 'TRANSCRIPT_COPY');
  assert.equal(codes['How boun'], 'SUMMARY_STYLE'); assert.equal(codes['Hi'], 'LENGTH_POLICY'); assert.equal(codes['Fine hoo'], 'SCHEMA_INVALID');
  assert.deepEqual(inventedNames('Is that really the UberEats order?', { transcript: 'the Uber Eats order' }), [], 'brand spelling variants are supported');
  assert.deepEqual(inventedNames('Why DoorDash orders go missing', { transcript: 'a DoorDash order' }), []);
  assert.deepEqual(inventedNames('Why Netflix orders go missing', { transcript: 'a DoorDash order' }), ['Netflix']);
  assert.deepEqual(inventedNames('Why Somalia and America matter here', { transcript: 'being Somali and American' }), [], 'derivational forms are supported');
  assert.deepEqual(inventedNames('Why the FBI orders go missing', { transcript: 'a DoorDash order' }), ['FBI'], 'unsupported acronyms are flagged');
  assert.deepEqual(inventedNames('Somali-American identity, in food', { transcript: 'being Somali and American' }), []);
  seq.push('objective screen reasons');

  // 7. Every bar is enforced on reviewed hooks, with the right code.
  const miss = r => reviewMisses(good(r), .9).map(m => m.code);
  assert.deepEqual(miss({}), []);
  assert(miss({ clickability: 60 }).includes('LOW_CLICKABILITY') && miss({ grounding: 60 }).includes('LOW_GROUNDING') && miss({ misleadingRisk: 45 }).includes('MISLEADING'));
  assert(miss({ summaryLike: true }).includes('GENERIC_SUMMARY') && miss({ specificity: 30 }).includes('LOW_SPECIFICITY') && miss({ context: 50 }).includes('LOW_CONTEXT'));
  assert(reviewMisses(good(), .5).some(m => m.code === 'LOW_NOVELTY') && miss({ approved: false, issue: 'x' }).includes('REVIEW_NOT_APPROVED'));
  assert.equal(HOOK_POLICY.clickabilityThreshold, 70); assert.equal(HOOK_POLICY.contextThreshold, 65); assert.equal(HOOK_POLICY.noveltyThreshold, 60); assert.equal(HOOK_POLICY.specificityThreshold, 45);
  assert(rejectionGuidance([{ text: 't', code: 'LOW_GROUNDING', detail: 'grounding 40<70' }])[0].includes('remove the unsupported implication'));
  seq.push('thresholds unchanged, all bars enforced');

  // 8. One approved hook is a complete result; zero is not.
  const one = q.applyReviews(q.screen([pool[0]], evidence, u).passed, [{ index: 0, ...good() }], evidence);
  assert.equal(one.approved.length, 1);
  assert(q.evaluate({ hooks: [], synopsis: '', captions: [], hashtagSets: [], supportingLine: '' }, one.approved, evidence, true).passed, 'no three-hook requirement');
  assert(!q.evaluate({ hooks: [], synopsis: '', captions: [], hashtagSets: [], supportingLine: '' }, [], evidence, true).passed);
  const flat = q.applyReviews(q.screen([hook('The equipment cooling system measurements')], evidence, u).passed, [{ index: 0, ...good({ clickability: 40, specificity: 30 }) }], evidence);
  assert.equal(flat.approved.length, 0, 'a flat headline is rejected by the reviewer'); seq.push('single approved hook passes; flat fails');

  // 9. Reviewed hooks survive re-ranking elsewhere (edit plan) without losing their semantic scores.
  const reranked = q.rank(one.approved, evidence, u, 'OPENAI');
  assert.equal(reranked.length, 1); assert.equal(reranked[0].CLICKABILITY_SCORE, 85); assert.equal(reranked[0].review.why, 'supported by the clip');
  seq.push('reviewed hook survives re-rank');

  // 10. Full package: ONE reviewer call judges hooks and copy; copy that hard-fails spends no reviewer call.
  const copy = { hooks: pool, synopsis: 'The speaker explains that saying yes to everyone left no time for focused work and that protecting priorities means accepting disapproval.',
    supportingLine: '', captions: [{ style: 'Concise', text: 'Saying yes to everyone left no time for focused work.' }, { style: 'Engaging', text: 'Protecting your priorities means accepting that some people will be unhappy.' }, { style: 'Professional', text: 'Constant agreement costs focused work; priorities need protecting.' }],
    hashtagSets: [{ label: 'Focused', hashtags: ['#priorities', '#focusedwork'] }, { label: 'Niche', hashtags: ['#boundaries'] }, { label: 'Broad', hashtags: ['#time'] }] };
  const r10 = router({ clipUnderstanding: () => ({}), creativeGeneration: () => copy, critic: () => ({ ...reviewsFor(5), copy: { supported: true, failures: [] } }) });
  const p10 = await new CreativePackageService(r10).create({ external: true, evidence: { ...evidence, sourceId: 'full' } });
  assert.equal(p10.status, 'ACCEPTED'); assert.equal(r10.calls.filter(c => c.role === 'critic').length, 1);
  assert.equal(r10.calls.find(c => c.role === 'critic').request.schemaName, 'shared_creative_review_v2');
  const r10b = router({ clipUnderstanding: () => ({}), creativeGeneration: () => ({ ...copy, captions: [{ style: 'Concise', text: 'Boundaries saved 300 hours of work.' }, ...copy.captions] }), critic: () => ({ ...reviewsFor(5), copy: { supported: true, failures: [] } }) });
  const p10b = await new CreativePackageService(r10b).create({ external: true, evidence: { ...evidence, sourceId: 'full-hard' } });
  assert.equal(p10b.status, 'NEEDS_REVIEW'); assert(!JSON.stringify(p10b.captions).includes('300 hours'));
  assert.equal(r10b.calls.filter(c => c.role === 'critic').length, 0, 'hard-failing copy is not sent to the reviewer');
  // The full-package repair pass is lighter (smaller pool, relaxed schema floor) so the slower stronger model stays under its call ceiling.
  const escGen = r10b.calls.filter(c => c.role === 'creativeGeneration');
  assert.deepEqual(escGen.map(c => c.creativeTier), ['PRIMARY', 'ESCALATION']);
  assert.equal(escGen[0].request.schema.properties.hooks.minItems, 8); assert.equal(escGen[1].request.schema.properties.hooks.minItems, 4);
  assert(escGen[1].request.systemPrompt.includes('Write 6 fresh hook candidates') && !escGen[1].request.systemPrompt.includes('exactly 15'));
  assert(p4.internal.trace[1].tier === 'ESCALATION' && r4.calls.filter(c => c.role === 'creativeGeneration')[1].request.systemPrompt.includes('Write 10 fresh hook candidates'), 'hooks-only repair keeps 10');
  // A faithful synopsis that shares few words with the transcript is a question of meaning: the reviewer decides, not a word count.
  const paraphrasedSynopsis = { ...copy, synopsis: 'A speaker explains why constant agreeableness leaves little time for meaningful tasks, and why tolerating pushback matters.' };
  assert(q.copyFailures(paraphrasedSynopsis, [], evidence).includes('SYNOPSIS_LOW_OVERLAP'), 'low overlap is flagged as soft');
  assert(!q.copyFailures({ ...copy, synopsis: 'This video discusses mindset and success.' }, [], evidence).includes('SYNOPSIS_LOW_OVERLAP') && q.copyFailures({ ...copy, synopsis: 'This video discusses mindset and success.' }, [], evidence).includes('SYNOPSIS_NOT_SPECIFIC'), 'filler stays a hard failure');
  const rSyn = copyVerdict => router({ clipUnderstanding: () => ({}), creativeGeneration: () => paraphrasedSynopsis, critic: () => ({ ...reviewsFor(5), copy: copyVerdict }) });
  const pSyn = await new CreativePackageService(rSyn({ supported: true, failures: [] })).create({ external: true, evidence: { ...evidence, sourceId: 'syn-ok' } });
  assert.equal(pSyn.status, 'ACCEPTED', 'reviewer clears a faithful paraphrased synopsis');
  const pSynBad = await new CreativePackageService(rSyn({ supported: false, failures: ['The synopsis misses the takeaway.'] })).create({ external: true, evidence: { ...evidence, sourceId: 'syn-bad' } });
  assert.equal(pSynBad.status, 'NEEDS_REVIEW', 'and can still reject an unsupported one');
  seq.push('full package: single combined review, lighter repair, paraphrased synopsis');

  // 11. Template fit: the real fitters decide, a long hook is preferred-against, never rejected.
  assert(hookFitsTemplates('The hidden cost of always being the agreeable one').all);
  const unfit = 'Counterintuitively understanding extraordinarily complicated organizational dependencies fundamentally transforms administrative responsibilities communication expectations infrastructure investments';
  assert(unfit.split(' ').length <= HOOK_POLICY.maxWords && unfit.length <= HOOK_POLICY.maxCharacters);
  assert.equal(hookFitsTemplates(unfit).all, false, 'policy-valid but unfittable text is detected');
  const longText = 'Counterintuitively understanding extraordinarily complicated organizational dependencies fundamentally transforms administrative responsibilities';
  const mk = (text, over) => q.applyReviews(q.screen([hook(text)], evidence, u).passed, [{ index: 0, ...good(over) }], evidence).approved[0];
  const shortH = mk('What saying yes quietly takes from you', { clickability: 76 }), longH = mk(longText, { clickability: 80 });
  assert.equal(longH.components.templateFit, 0); assert.equal(shortH.components.templateFit, 1);
  assert(longH.score > shortH.score, 'the long hook has the higher appeal');
  const order = pair => q.rank(pair.map(h => ({ text: h.text, category: h.category, review: h.review })), evidence, u, 'OPENAI').map(h => h.text);
  assert.equal(order([longH, shortH])[0], shortH.text, 'near-equal appeal: the hook that fits every template leads');
  const longStar = mk(longText, { clickability: 100, specificity: 100, grounding: 100, context: 100, misleadingRisk: 0 }), shortWeak = mk('What saying yes quietly takes from you', { clickability: 71 });
  assert.equal(order([shortWeak, longStar])[0], longStar.text, 'a clearly stronger long hook still wins; length alone never rejects it');
  assert.equal(order([longH]).length, 1, 'the long hook is kept, not rejected');
  seq.push('template-fit preference');

  // 12. A model hook that opens with a pronoun has no antecedent for a viewer; locally shortened user wording is exempt.
  const pron = { text: 'They turned suspicious orders into a guessing game', category: 'STORY' };
  assert.equal(q.screen([pron], evidence, u, [], { strictReference: true }).rejected[0].code, 'UNRESOLVED_PRONOUN');
  assert.equal(q.screen([pron], evidence, u).passed.length, 1, 'not applied unless strict (local/user wording)');
  for (const ok of ['Hershey bars and boundaries explained badly', 'Theory of boundaries nobody tells you about', 'The people who say yes to everyone first'])
    assert.equal(q.screen([{ text: ok, category: 'CURIOSITY' }], evidence, u, [], { strictReference: true }).rejected.find(r => r.code === 'UNRESOLVED_PRONOUN'), undefined, ok);
  for (const bad of ["They're asking for another yes", 'Her boundaries ran out first', '— They keep asking for another yes'])
    assert.equal(q.screen([{ text: bad, category: 'CURIOSITY' }], evidence, u, [], { strictReference: true }).rejected[0]?.code, 'UNRESOLVED_PRONOUN', bad);
  assert(miss({ unclearReference: true }).includes('UNCLEAR_REFERENCE'), 'reviewer-flagged unresolved reference is refused');
  assert(miss({ naturalness: 65 }).includes('LOW_NATURALNESS'), 'unnatural wording is refused');
  assert.equal(HOOK_POLICY.naturalnessThreshold, 70);
  const flagged = q.applyReviews(q.screen([hook('What saying yes to everyone quietly takes from you')], evidence, u).passed, [{ index: 0, ...good({ unclearReference: true }) }], evidence);
  assert.equal(flagged.approved.length, 0); assert(flagged.rejected.some(r => r.code === 'UNCLEAR_REFERENCE'));
  assert(rejectionGuidance([{ text: 't', code: 'UNRESOLVED_PRONOUN', detail: '' }])[0].includes('Name the subject'));
  assert(r2.calls.find(c => c.role === 'creativeGeneration').request.systemPrompt.includes('Never open a hook with a pronoun'));
  assert(/no em dashes or en dashes/u.test(r2.calls.find(c => c.role === 'creativeGeneration').request.systemPrompt), 'writer is told to use plain punctuation');
  seq.push('unresolved pronoun / unclear reference / naturalness');

  // 13. Existing hook: a generated rewrite must beat it by a meaningful margin or solve a known problem.
  const EXISTING = 'What does saying yes to everyone cost your focused work?';
  const withExisting = async (existingScores, generatedScores, { existingText = EXISTING, writerHooks = pool, sourceId = 'existing' } = {}) => {
    const r = router({ clipUnderstanding: () => ({}), creativeGeneration: () => ({ hooks: writerHooks }),
      critic: input => { const listed = JSON.parse(input.request.userPrompt).hooks;
        return { reviews: listed.map(h => ({ index: h.index, ...good(h.text === existingText ? existingScores : generatedScores(h.text)) })) }; } });
    const pkg = await new CreativePackageService(r).create({ external: true, hooksOnly: true, evidence: { ...evidence, sourceId }, existingHook: { text: existingText, category: 'QUESTION' } });
    return { pkg, r, selection: pkg.internal.trace.at(-1).selection };
  };
  const kept = await withExisting({ clickability: 80, specificity: 85 }, () => ({ clickability: 85, grounding: 92, misleadingRisk: 6, specificity: 86 }), { sourceId: 'keep' });
  assert.equal(kept.pkg.selectedHook, EXISTING, 'a strong existing hook is kept when the rewrite is only slightly better');
  assert.equal(kept.selection.preserved, true); assert(/needs 8/u.test(kept.selection.reason));
  assert.equal(kept.pkg.status, 'ACCEPTED'); assert.equal(kept.pkg.internal.escalations, 0);
  assert.equal(kept.r.calls.filter(c => c.role === 'critic').length, 1, 'the existing hook rides in the same single reviewer call');
  assert(JSON.parse(kept.r.calls.find(c => c.role === 'critic').request.userPrompt).hooks.some(h => h.text === EXISTING));
  assert.equal(kept.pkg.hooks[0].text, EXISTING); assert.equal(kept.pkg.hooks[0].recommended, true); assert(kept.pkg.hooks.length > 1, 'approved alternates are still offered');
  const replaced = await withExisting({ clickability: 80, specificity: 85 }, () => ({ clickability: 97, context: 97, grounding: 98, misleadingRisk: 1, specificity: 97 }), { sourceId: 'replace' });
  assert.notEqual(replaced.pkg.selectedHook, EXISTING, 'a rewrite that is clearly better replaces it'); assert.equal(replaced.selection.preserved, false);
  assert(/beats the existing hook/u.test(replaced.selection.reason));
  const problem = await withExisting({ grounding: 50, misleadingRisk: 60, approved: false, issue: 'claims more than the clip' }, () => ({ clickability: 80 }), { sourceId: 'problem' });
  assert.notEqual(problem.pkg.selectedHook, EXISTING); assert(/known problem/u.test(problem.selection.reason), 'an existing hook that fails a bar is replaced');
  const weak = await withExisting({ clickability: 72, context: 66, grounding: 72, specificity: 46 }, () => ({ clickability: 80 }), { sourceId: 'weak' });
  assert(/composite .* below|known problem/u.test(weak.selection.reason) && weak.pkg.selectedHook !== EXISTING, 'passing every bar by a hair is not enough to be kept');
  const pronounExisting = await withExisting({}, () => ({}), { existingText: 'They turned suspicious orders into a guessing game', sourceId: 'pronoun-existing' });
  assert(/UNRESOLVED_PRONOUN/u.test(pronounExisting.selection.reason) && pronounExisting.pkg.selectedHook !== 'They turned suspicious orders into a guessing game', 'an existing hook with an unresolved pronoun is a known problem');
  const noneGenerated = await withExisting({}, () => ({ clickability: 30, grounding: 20, misleadingRisk: 90, approved: false }), { sourceId: 'no-generated' });
  assert.equal(noneGenerated.pkg.selectedHook, EXISTING); assert.equal(noneGenerated.pkg.status, 'ACCEPTED');
  assert.equal(noneGenerated.pkg.internal.escalations, 0, 'an acceptable existing hook needs no stronger-model repair');
  assert.equal(noneGenerated.r.calls.filter(c => c.role === 'creativeGeneration').length, 1);
  const echoed = await withExisting({}, () => ({}), { writerHooks: [...pool, { text: EXISTING, category: 'QUESTION', support: 'x' }], sourceId: 'echo' });
  assert.equal(echoed.pkg.hooks.filter(h => h.text === EXISTING).length, 1, 'a writer echo of the existing hook is not a second candidate');
  seq.push('existing hook kept unless clearly beaten or problematic');

  // Current wording is part of the cache identity: the same retained speech can have different user hooks.
  const SECOND_EXISTING = 'Is saying yes to everyone costing you your priorities?';
  const currentTexts = new Set([EXISTING, SECOND_EXISTING]);
  const cacheRouter = router({ clipUnderstanding: () => ({}), creativeGeneration: () => ({ hooks: pool }),
    critic: input => ({ reviews: JSON.parse(input.request.userPrompt).hooks.map(h => ({ index: h.index,
      ...good(currentTexts.has(h.text) ? { clickability: 90, specificity: 90 } : { clickability: 80 }) })) }) });
  const cacheService = new CreativePackageService(cacheRouter);
  const cacheRequest = { ...hooksOnly, evidence: { ...evidence, sourceId: 'current-cache' }, existingHook: { text: EXISTING } };
  assert.equal((await cacheService.create(cacheRequest)).selectedHook, EXISTING);
  assert.equal((await cacheService.create({ ...cacheRequest, existingHook: { text: SECOND_EXISTING } })).selectedHook, SECOND_EXISTING,
    'changing the current hook cannot reuse a prior preservation decision');
  const callCount = cacheRouter.calls.length;
  assert.equal((await cacheService.create(cacheRequest)).selectedHook, EXISTING);
  assert.equal(cacheRouter.calls.length, callCount, 'identical requests still reuse the package');
  seq.push('current hook cache isolation');

  // A strong hook must still change when a user requests it or explicitly excludes it.
  for (const action of [{ changeHook: true }, { direction: 'change my hook' }, { direction: 'rewrite my hook' },
    { direction: 'make it more clickbait' }, { direction: 'make it more interesting' }, { exclude: [EXISTING.toUpperCase()] }]) {
    const changed = await cacheService.create({ ...cacheRequest, ...action, selectedHook: EXISTING });
    assert.equal(changed.status, 'ACCEPTED');
    assert.notEqual(changed.selectedHook, EXISTING, 'explicit change beats preservation: ' + JSON.stringify(action));
    assert(!changed.hooks.some(h => h.text === EXISTING), 'current wording is not offered again');
  }
  seq.push('explicit hook change beats strong-hook preservation');
  const selectedOnly = await cacheService.create({ ...hooksOnly, changeHook: true, selectedHook: EXISTING });
  assert.equal(selectedOnly.status, 'ACCEPTED');
  assert.notEqual(selectedOnly.selectedHook, EXISTING, 'selectedHook alone cannot override an explicit rewrite');

  // The manual editor endpoint excludes canonical current wording on the FIRST suggestion request.
  const { EditModeController } = require('../dist/modules/edit-mode/edit-mode.controller');
  const editor = Object.create(EditModeController.prototype);
  let savedSuggestions;
  editor.llm = cacheRouter;
  editor.editMode = { async get() { return { revision: 3, assets: [], settings: {}, elements: [
    { type: 'TEXT', properties: { templateRole: 'HOOK', content: EXISTING } } ] }; },
    async saveCreativeSuggestions(id, revision, pkg) { savedSuggestions = pkg; } };
  // Reuse real retained-project evidence rather than the synthetic assets above for an accepted online result.
  editor.editMode.get = async () => ({ revision: 3, assets: [{ id: 'source', role: 'SOURCE', duration: 30,
    transcript: { segments: [{ start: 0, end: 30, text: evidence.transcript }] } }],
    settings: {}, elements: [{ type: 'VIDEO', startTime: 0, duration: 30, trimStart: 0, trimEnd: 30, assetId: 'source' },
      { type: 'TEXT', properties: { templateRole: 'HOOK', content: EXISTING } }] });
  const manualResult = await editor.sharedHooks('test', { revision: 3, externalAiAuthorized: true, direction: 'Rewrite' });
  assert.equal(manualResult.package.status, 'ACCEPTED');
  assert(manualResult.package.hooks.length > 0, 'a rewrite must provide an acceptable alternative');
  assert(!manualResult.package.hooks.some(h => h.text === EXISTING));
  const { editProjectEvidence } = require('../dist/modules/content-intelligence/edit-project-evidence');
  assert(!editProjectEvidence(await editor.editMode.get()).visibleText.includes(EXISTING), 'a current hook cannot supply facts for its own rewrite');
  assert.deepEqual(savedSuggestions, manualResult.package, 'the exact suggested package is saved for reopen');
  seq.push('manual editor first rewrite excludes canonical hook and persists suggestions');

  // 13b. Missing only the composite bar never trades reviewed hooks for a local template: still NEEDS_REVIEW, but the text is not downgraded.
  const belowBar = router({ clipUnderstanding: () => ({}), creativeGeneration: () => ({ hooks: pool }),
    critic: () => ({ reviews: Array.from({ length: 5 }, (_, index) => ({ index, ...good({ clickability: 72, context: 66, grounding: 72, specificity: 46, misleadingRisk: 20 }) })) }) });
  const pBelow = await new CreativePackageService(belowBar).create({ ...hooksOnly, evidence: { ...evidence, sourceId: 'below-bar' } });
  assert.equal(pBelow.status, 'NEEDS_REVIEW'); assert.equal(pBelow.internal.escalations, 1, 'the repair was tried once');
  assert(pBelow.hooks.length > 0 && pBelow.hooks.every(h => h.review && h.source === 'OPENAI'), 'reviewed hooks are retained');
  assert(!/what's behind|actually matters|through the lens/iu.test(pBelow.selectedHook), 'no weak template replaces them: ' + pBelow.selectedHook);
  seq.push('composite-bar miss keeps reviewed hooks');

  // 13c. Selection among approved hooks: comfortably grounded beats marginal; within a tier the more clickable hook wins.
  const approve = (text, over) => q.applyReviews(q.screen([hook(text)], evidence, u, [], { strictReference: true }).passed, [{ index: 0, ...good(over) }], evidence).approved[0];
  const slogan = approve('Sustainable boundaries require accepting disagreement', { clickability: 76, specificity: 70, grounding: 96, misleadingRisk: 4 });
  const realHook = approve('The hidden price of endless agreement', { clickability: 84, specificity: 82, grounding: 90, misleadingRisk: 10 });
  const punchyRisky = approve('Everyone who says yes eventually loses their own work', { clickability: 92, specificity: 90, grounding: 76, misleadingRisk: 24 });
  const pick = (...hs) => q.rank(hs.map(h => ({ text: h.text, category: h.category, review: h.review })), evidence, u, 'OPENAI')[0].text;
  assert.equal(pick(slogan, realHook), realHook.text, 'within the safe tier the more clickable hook beats a slogan');
  assert.equal(pick(punchyRisky, realHook), realHook.text, 'a punchier but marginally grounded claim never wins on appeal alone');
  assert.equal(pick(punchyRisky), punchyRisky.text, 'but it is still offered when nothing safer exists (it cleared every bar)');
  // Speed/intensity claims the clip never makes are refused objectively; the same word is fine when the clip says it.
  for (const bad of ['The check fails instantly and nobody notices', 'A name check that breaks within seconds'])
    assert.equal(q.screen([{ text: bad, category: 'TENSION' }], evidence, u).rejected[0]?.code, 'UNSUPPORTED_DETAIL', bad);
  assert.equal(q.screen([{ text: 'Why saying yes instantly costs you focus', category: 'CURIOSITY' }], { ...evidence, transcript: evidence.transcript + ' It happens instantly.' }, u).rejected.find(r => r.code === 'UNSUPPORTED_DETAIL'), undefined);
  assert(rejectionGuidance([{ text: 't', code: 'UNSUPPORTED_DETAIL', detail: '"instantly"' }])[0].includes('speed or intensity'));
  seq.push('two-tier selection and unsupported speed claims');

  // 13d. The reviewer's list is shuffled (no systematic position), deterministically, and the existing hook is not always last.
  const orders = new Set(); let lastCount = 0;
  for (let k = 0; k < 12; k++) {
    const r = router({ clipUnderstanding: () => ({}), creativeGeneration: () => ({ hooks: pool }), critic: input => reviewsFor(JSON.parse(input.request.userPrompt).hooks.length) });
    await new CreativePackageService(r).create({ ...hooksOnly, evidence: { ...evidence, sourceId: 'shuffle-' + k, transcript: evidence.transcript + (k ? ' Extra ' + k + '.' : '') }, existingHook: { text: EXISTING, category: 'QUESTION' } });
    const listed = JSON.parse(r.calls.find(c => c.role === 'critic').request.userPrompt).hooks.map(h => h.text);
    orders.add(listed.join('|')); if (listed.at(-1) === EXISTING) lastCount++;
  }
  assert(orders.size > 3, 'the listing order varies with the pool, not a fixed mechanism order');
  assert(lastCount < 12, 'the existing hook is not systematically last');
  const again = router({ clipUnderstanding: () => ({}), creativeGeneration: () => ({ hooks: pool }), critic: input => reviewsFor(JSON.parse(input.request.userPrompt).hooks.length) });
  const again2 = router({ clipUnderstanding: () => ({}), creativeGeneration: () => ({ hooks: pool }), critic: input => reviewsFor(JSON.parse(input.request.userPrompt).hooks.length) });
  await new CreativePackageService(again).create({ ...hooksOnly, evidence: { ...evidence, sourceId: 'det-a' } }); await new CreativePackageService(again2).create({ ...hooksOnly, evidence: { ...evidence, sourceId: 'det-a' } });
  const listOf = r => JSON.parse(r.calls.find(c => c.role === 'critic').request.userPrompt).hooks.map(h => h.text).join('|');
  assert.equal(listOf(again), listOf(again2), 'same pool, same order: reproducible');
  seq.push('reviewer list order is shuffled but deterministic');

  // 14. Stage timings are recorded for every attempt.
  const tr = kept.pkg.internal.trace[0];
  assert(tr.timings && ['generationMs', 'screenMs', 'reviewMs', 'attemptMs'].every(k => Number.isFinite(tr.timings[k]) && tr.timings[k] >= 0), 'per-stage timings');
  assert(tr.timings.attemptMs >= tr.timings.generationMs); assert(Number.isFinite(kept.pkg.internal.timings.understandingMs) && kept.pkg.internal.timings.totalMs >= tr.timings.attemptMs);
  assert(p4.internal.trace.every(t => t.timings) && p4.internal.trace[1].tier === 'ESCALATION', 'escalation attempts are timed too');
  seq.push('stage timings');

  console.log(JSON.stringify({ passed: seq.length, checks: seq }, null, 1));
})().catch(e => { console.error(e); process.exitCode = 1; });
