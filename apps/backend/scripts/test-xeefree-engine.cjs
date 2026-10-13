// XeeFree engine tests: sentence reconstruction, structured understanding, boundary repair, moment scoring and diversity, the typed-slot hook engine and its
// twelve-point gate, manual hook preservation, caption cleanup, speaker stabilisation, sentence-aware zoom emphasis, template fit, and honest non-English handling.
// Pure and offline: nothing here touches a network, a database or a model.
require('reflect-metadata');
const assert = require('node:assert/strict');
const dist = (p) => require('../dist/modules/' + p);
const { reconstructSentences, sentencesFromText } = dist('free/free-sentences');
const { analyzeEvidence, framesOf, cleanClause, isClause, isBaseVerbPhrase } = dist('free/free-analysis');
const { generateFreeHooks, gateHook, evaluateExistingHook, invertClause, FREE_HOOK_GATES } = dist('free/free-hooks');
const { freeCreative } = dist('free/free-creative');
const { FreeTranscriptIndex, scoreMoment, diversifyOrder, momentSimilarity } = dist('free/free-moments');
const { cleanCaptionWords } = dist('free/free-captions');
const { stabilizeSpeakerChanges, shortestShot } = dist('free/free-speakers');
const { freeEmphasisPicks } = dist('free/free-emphasis');
const { sentenceBoundaryQa } = dist('free/free-boundary');
const { ClipBoundaryService } = dist('content-intelligence/clip-boundary.service');
const { tailPassFromResponse } = dist('content-intelligence/ending-evidence');
const { hookFitsTemplates } = dist('content-intelligence/hook-fit');
const { hookLanguageProblems } = dist('content-intelligence/hook-language');
const { inventedNames } = dist('content-intelligence/creative-quality.service');
const corpus = require('./fixtures/xeefree-corpus.cjs');
const boundary = new ClipBoundaryService();
let checks = 0;
const check = (name, fn) => { try { fn(); checks++; } catch (error) { error.message = `[${name}] ${error.message}`; throw error; } };
const checkAsync = async (name, fn) => { try { await fn(); checks++; } catch (error) { error.message = `[${name}] ${error.message}`; throw error; } };
const words = (text) => text.split(/\s+/u).filter(Boolean);
const evidenceOf = (f) => ({ transcript: f.turns.map(t => t[1]).join(' '), sceneType: f.sceneType, speakerTurns: f.turns.map(([speaker, text]) => ({ speaker, text })) });
const hookTexts = (f, options) => freeCreative(evidenceOf(f), options).hooks.map(h => h.text);

/** Word-timed transcript: each sentence is one segment, 0.34 s per word, `gap` seconds of silence before it. */
function build(sentences, origin = 0) {
  const out = []; let cursor = origin;
  for (const s of sentences) {
    cursor += s.gap ?? .3;
    const tokens = s.text.split(' ');
    tokens.forEach((token, i) => {
      const w = { text: token, start: Number(cursor.toFixed(3)), end: Number((cursor + .34).toFixed(3)), speaker: s.speaker ?? null };
      if (typeof s.base === 'number' || typeof s.p === 'number') w.confidence = i === tokens.length - 1 && typeof s.p === 'number' ? s.p : (s.base ?? .95);
      if (i === tokens.length - 1) w.segmentEnd = true;
      out.push(w); cursor += .38;
    });
  }
  return out;
}

// ---- 1. sentence reconstruction -------------------------------------------------------------------------------------------
check('1a fragments are flagged, not offered as thoughts', () => {
  const s = sentencesFromText('So the reason most startups fail is simple. Because the reason. And then what? We shipped it in March and nobody noticed.');
  const byText = (needle) => s.find(x => x.text.includes(needle));
  assert.equal(byText('most startups fail').complete, true);
  assert.equal(byText('Because the reason').complete, false, 'a fragment with no verb is not complete');
  assert.equal(byText('Because the reason').kind, 'FRAGMENT');
  assert.equal(byText('We shipped').complete, true);
});
check('1b a dangling clause never ends a sentence', () => {
  const s = sentencesFromText('He was saying that the market is changing, and honestly nobody saw it coming.');
  assert.equal(s.length, 1); assert.equal(s[0].complete, true);
  const cut = sentencesFromText('I think the.');
  assert.equal(cut[0].complete, false);
});
check('1c a continuation joins the sentence before it only when it is itself a finished clause', () => {
  const merged = sentencesFromText('They never talk to customers. Because they build in secret.');
  assert.equal(merged.length, 1, 'a finished "because" clause continues its sentence');
  assert.ok(/customers, because they build/u.test(merged[0].text), merged[0].text);
  const kept = sentencesFromText('Why does this happen? Because people build what they want.');
  assert.equal(kept.length, 2, 'an answer to a question stays its own sentence');
});
check('1d tag questions and abbreviations do not split or ask', () => {
  const s = sentencesFromText('Dr. Smith said no. You can see the problem, right?');
  assert.equal(s.length, 2); assert.equal(s[1].kind, 'STATEMENT', '"..., right?" tags a statement');
});
check('1e pauses and speaker turns propose boundaries', () => {
  const timed = build([{ text: 'We shipped it in March', gap: 0 }, { text: 'and nobody noticed for weeks', gap: 1.4 }, { text: 'Why did that happen', gap: .5, speaker: 'b' }]);
  const s = reconstructSentences(timed.map(w => ({ text: w.text, start: w.start, end: w.end, speaker: w.speaker })));
  assert.ok(s.length >= 2, 'a long pause splits the run');
  assert.equal(s.at(-1).speaker, 'b');
});
check('1f non-English text is not judged by English fragment rules', () => {
  const s = sentencesFromText('हर किसी की पसंद बनने की कोशिश में अपनी सीमाएं भूलना आसान है।');
  assert.equal(s[0].complete, true);
});
check('1g an ASR "-ups" fragment rejoins its word', () => {
  const w = ['There', 'are', 'three', 'reasons', 'start', '-ups', 'fail.'].map((text, i) => ({ text, start: i * .3, end: i * .3 + .25 }));
  const s = reconstructSentences(w);
  assert.equal(s.length, 1); assert.ok(/start-ups fail\.$/u.test(s[0].text), s[0].text);
});

// ---- 2. structured understanding ---------------------------------------------------------------------------------------------
check('2a typed frames come from the sentences', () => {
  const a = analyzeEvidence(evidenceOf(corpus.find(f => f.id.startsWith('A'))));
  assert.ok(a.frames.some(f => f.type === 'QA'), 'question and its answer');
  assert.ok(a.question.startsWith('Why do most people'), a.question);
  assert.ok(a.answer.length > 10);
  const lead = analyzeEvidence({ transcript: 'The biggest mistake is hiring too fast before finding product market fit.' });
  assert.ok(lead.frames.some(f => f.type === 'LEAD' && f.slots.rest.text.startsWith('hiring too fast')));
  const reason = analyzeEvidence({ transcript: 'The reason most startups fail is that they never talk to their customers.' });
  assert.deepEqual(reason.frames.find(f => f.type === 'REASON').slots.effect.text, 'most startups fail');
});
check('2a gerund subjects keep their finite predicate', () => {
  assert.equal(isClause("Being Somali isn't just eating bananas with rice"), true);
  assert.equal(isClause('being in the room'), false);
});
check('rambling clauses use a plain literal hook without weakening any gate', () => {
  const evidence = { transcript: "To me, being Somali isn't just eating bananas with rice, it's like, it's an interesting thing, it's very hard to describe what it means to be Somali and what it means to be American, it's like a cultural fusion, it's kind of like the bananas in rice. Yeah, but it's not just that." };
  const result = freeCreative(evidence);
  assert.equal(result.hooks[0]?.text, "Being Somali isn't just eating bananas with rice");
  assert.equal(result.trace.simpleFallback, true);
  assert(result.draft.synopsis.includes('Being Somali'));
  assert(!result.draft.captions.some(c => c.text === "It's not just that."));
  const judged = evaluateExistingHook(result.hooks[0].text, result.analysis, evidence);
  assert.deepEqual(judged.failed, []);
});
check('clause extraction retains uncertainty and unresolved pronoun safeguards', () => {
  for (const transcript of [
    'Maybe, remote work kills creativity, you know, it is kind of complicated.',
    'If the plan fails, everyone loses their investment, so we cannot be certain.',
    'He did it, they loved that, it was like, you know, that thing.'
  ]) assert(!freeCreative({ transcript }).hooks.some(h => h.text === 'Remote work kills creativity' || h.text === 'Everyone loses their investment'));
});
check('a plain complete quote is preferred over no hook on a rambling monologue', () => {
  const evidence = { transcript: 'The skill you are really building is patience with your own ignorance.' };
  const result = freeCreative(evidence);
  assert.equal(result.hooks[0]?.text, 'The skill you are really building is patience with your own ignorance');
  assert.equal(result.trace.simpleFallback, true);
  assert.deepEqual(evaluateExistingHook(result.hooks[0].text, result.analysis, evidence).failed, []);
  assert(!freeCreative({ transcript: 'When I started I used to copy answers from tutorials without understanding them.' }).hooks.length);
});
check('2b numbers and entities appear only when written in the evidence', () => {
  const a = analyzeEvidence({ transcript: 'We raised 2.5 million dollars. Professor Randall Kennedy joined us from Yale.', visibleText: 'THE DEBATE SHOW' });
  assert.ok(a.numbers.some(n => n.text.includes('2.5')));
  assert.ok(a.entities.some(e => /Randall Kennedy/u.test(e)) && a.entities.includes('Yale'));
  assert.ok(!a.entities.some(e => /^Well$|^Now$/u.test(e)), 'discourse openers are not names');
  const none = analyzeEvidence({ transcript: 'well, the plan changed and we moved on.' });
  assert.deepEqual(none.entities, []);
});
check('2c an opposite-meaning inversion is never invented: "they never talk to customers" is not advice', () => {
  const a = analyzeEvidence({ transcript: 'The reason most startups fail is that they never talk to their customers.' });
  assert.ok(!a.frames.some(f => f.type === 'WARNING' && f.slots.lead), 'a third-person negation is not turned into an imperative');
});
check('2d spoken scaffolding is removed without touching content', () => {
  assert.equal(cleanClause('Um, you know, so the market tells you what to build'), 'the market tells you what to build');
  assert.equal(cleanClause("I don't, I don't believe that money was stolen"), "I don't believe that money was stolen");
  assert.equal(isClause('what happens is there is no money'), false, 'a wh-clause cannot follow "Why"');
  assert.equal(isClause("there's no market for bonds"), true);
  assert.equal(isBaseVerbPhrase('talk to ten customers every week'), true);
  assert.equal(isBaseVerbPhrase('they never talk to customers'), false);
});

// ---- 3. hooks: every content type ------------------------------------------------------------------------------------------
for (const f of corpus) {
  check(`3 hooks for ${f.id}`, () => {
    const c = freeCreative(evidenceOf(f));
    assert.ok(c.hooks.length >= 1, `${f.id} has at least one hook`);
    const evidence = evidenceOf(f);
    for (const h of c.hooks) {
      assert.ok(words(h.text).length <= 22, `${h.text} is within 22 words`);
      if (!f.language) {
        const gated = generateFreeHooks(c.analysis, evidence).gated.find(g => g.text === h.text.replace(/\?$/u, '') || g.text === h.text);
        assert.ok(gated && gated.passed && gated.failed.length === 0, `${h.text} passes every gate`);
        assert.deepEqual(hookLanguageProblems(h.text).filter(p => p !== 'NO_DANGLING_PRONOUN'), [], h.text);
        if (c.analysis.speakers.length > 1) assert.ok(!/\b(?:I|my|me|we|our)\b/u.test(h.text), `${h.text}: no first person in a multi-speaker clip`);
      }
      assert.ok(!/what['’]s behind|through the lens of|what actually matters/iu.test(h.text), 'the old template baseline is gone');
    }
    assert.equal(c.hooks.filter(h => h.recommended).length, 1);
  });
}
check('3b the hooks are specific to the content type', () => {
  const by = (id) => hookTexts(corpus.find(f => f.id.startsWith(id)));
  assert.ok(by('A').includes('Why do most people struggle to stay consistent with exercise?'), 'the clip\'s own answered question leads');
  assert.equal(by('A')[0], 'Why do most people struggle to stay consistent with exercise?');
  assert.ok(by('E').some(h => /^The lesson: hire slowly and fire quickly$/u.test(h)), 'a LEAD frame becomes "The lesson: ..."');
  assert.ok(by('G').includes('Three reasons startups fail'), 'a counted list becomes a list hook');
  assert.ok(!by('G').some(h => /founders stop trusting/u.test(h)), 'one list item is never the headline of the whole list');
  assert.ok(by('H').every(h => /^How to /u.test(h)), 'tutorial steps become how-to hooks');
  assert.ok(by('C').some(h => /^Never answer email/u.test(h)), 'an imperative prohibition stays a prohibition');
  assert.ok(by('D').some(h => /^Is it true that remote work kills creativity/u.test(h)) || by('D').some(h => /^Here's why remote work kills creativity$/u.test(h)));
});

// ---- 4. grammar / the old failure modes -------------------------------------------------------------------------------
const gateOf = (text, transcript = 'tell reason agree puffing Scott said the reason people agree is that you tell them.') => {
  const analysis = analyzeEvidence({ transcript });
  const candidate = { text, category: 'CURIOSITY', family: 'Curiosity Gap', template: 'X', slots: [{ type: 'NP', text: 'tell', sentence: 0 }], frame: 'REASON', hedged: false, copyAllowed: false, firstPerson: false };
  return gateHook(candidate, analysis, { transcript });
};
check('4a "What\'s behind tell and reason?" and its relatives cannot pass', () => {
  for (const salad of ["What's behind tell and reason?", "What's behind puffing and agree?", 'tell and reason through the lens of man and find', 'Why does think say?', 'The reason behind and']) {
    const g = gateOf(salad);
    assert.ok(Object.values(g.gate).some(v => v === false), `${salad} fails the gate`);
  }
});
check('4b slot types are enforced', () => {
  const analysis = analyzeEvidence({ transcript: 'Startups fail when founders stop talking to customers.' });
  const mk = (text, type, slotText) => gateHook({ text, category: 'CURIOSITY', family: 'Curiosity Gap', template: 'X', slots: [{ type, text: slotText, sentence: 0 }], frame: 'REASON', hedged: false, copyAllowed: false, firstPerson: false }, analysis, { transcript: analysis.evidenceText });
  assert.equal(mk('Why talking to', 'CLAUSE', 'talking to').gate.GRAMMAR_OK, false, 'a clause slot needs a clause');
  assert.equal(mk('How to founders stop talking', 'VP', 'founders stop talking').gate.GRAMMAR_OK, false, 'a verb-phrase slot starts with a base verb');
  assert.equal(mk('The real reason of', 'NP', 'of').gate.GRAMMAR_OK, false, 'a noun-phrase slot needs a noun head');
});
check('4c clauses placed after "Why" must be clauses; inversion is only done for known verbs', () => {
  assert.equal(invertClause('most startups fail'), 'do most startups fail');
  assert.equal(invertClause('the market is changing'), 'is the market changing');
  assert.equal(invertClause('the plan backfired'), null, 'unknown base form: embedded form is used instead of a guess');
  assert.equal(invertClause('founders never listen'), null, 'an adverb between subject and verb is not inverted');
});

// ---- 5. grounding ----------------------------------------------------------------------------------------------------
check('5a unsupported names, numbers and intensity are rejected', () => {
  const transcript = 'The reason most startups fail is that they never talk to their customers.';
  const analysis = analyzeEvidence({ transcript });
  const mk = (text) => gateHook({ text, category: 'BOLD', family: 'Bold Claim', template: 'X', slots: [{ type: 'CLAUSE', text: 'most startups fail', sentence: 0 }], frame: 'CLAIM', hedged: false, copyAllowed: true, firstPerson: false }, analysis, { transcript });
  assert.equal(mk('Why Elon Musk says most startups fail').gate.NO_UNSUPPORTED_NAME, false);
  assert.equal(mk('Why 90 percent of startups fail').gate.NO_UNSUPPORTED_NUMBER, false);
  assert.equal(mk('The shocking secret behind why startups fail').gate.NO_MISLEADING_CLAIM, false, 'intensity words must be said in the clip');
  assert.equal(mk('Why most startups fail').gate.NO_UNSUPPORTED_NAME, true);
});
check('5b hedged and negated source lines are not turned into bold or inverted claims', () => {
  const hedged = freeCreative({ transcript: 'I think maybe remote work might hurt creativity in some teams.' });
  assert.ok(!hedged.hooks.some(h => /^remote work hurts creativity/iu.test(h.text)), 'a hedge is never stated as fact');
  const a = analyzeEvidence({ transcript: 'You should never skip the warm-up before heavy lifting.' });
  assert.ok(a.frames.some(f => f.type === 'WARNING'), 'a negated instruction remains negated');
});
check('saved idiomatic contrast keeps the generation grammar rule while referential pronouns still fail', () => {
  const evidence = { transcript: 'What separates experienced engineers is not talent but a habit of shrinking the problem. They delete code until the bug has nowhere to hide.' };
  const analysis = analyzeEvidence(evidence);
  assert.deepEqual(evaluateExistingHook("It's not talent, it's a habit of shrinking the problem", analysis, evidence).failed, []);
  assert.equal(evaluateExistingHook('It makes engineers work on the problem', analysis, evidence).passed, false);
  assert.equal(evaluateExistingHook("It's not talent, it's a guaranteed million dollars", analysis, evidence).passed, false);
});
check('explicit disagreement never becomes a presupposed fact, with or without speaker labels', () => {
  for (const evidence of [{ transcript: 'Remote work kills creativity because people stop bumping into each other. I disagree. Creativity needs time to think, not a shared hallway.' },
    { transcript: 'Remote work kills creativity because people stop bumping into each other. I disagree. Creativity needs time to think, not a shared hallway.',
      speakerTurns: [{ speaker: 'a', text: 'Remote work kills creativity because people stop bumping into each other.' },
        { speaker: 'b', text: 'I disagree. Creativity needs time to think, not a shared hallway.' }] }]) {
    const analysis = analyzeEvidence(evidence);
    const hooks = generateFreeHooks(analysis, evidence).hooks;
    assert.ok(hooks.some(h => h.text === 'Does remote work kill creativity?'));
    assert.ok(!hooks.some(h => /^Why does remote work/iu.test(h.text)));
    assert.ok(evaluateExistingHook('Why does remote work kill creativity?', analysis, evidence).failed.includes('NO_MISLEADING_CLAIM'));
    assert.ok(evaluateExistingHook('Remote work kills creativity', analysis, evidence).failed.includes('NO_MISLEADING_CLAIM'));
  }
  const ordinary = { transcript: 'Remote work kills creativity because people stop bumping into each other. Informal conversations create unexpected ideas.' };
  assert.ok(generateFreeHooks(analyzeEvidence(ordinary), ordinary).hooks.some(h => h.text === 'Why does remote work kill creativity?'));
});
check('5c existing-name check', () => {
  assert.deepEqual(inventedNames('Why Princeton matters', { transcript: 'Princeton and Yale' }), []);
  assert.ok(inventedNames('Why Harvard matters', { transcript: 'Princeton and Yale' }).length);
});

// ---- 6. dedup / clarity / dangling pronouns --------------------------------------------------------------------------
check('6a no near-duplicate hooks in one result', () => {
  for (const f of corpus.filter(f => !f.language)) {
    const hooks = hookTexts(f);
    for (let i = 0; i < hooks.length; i++) for (let j = i + 1; j < hooks.length; j++) {
      const a = new Set(words(hooks[i].toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ''))), b = new Set(words(hooks[j].toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '')));
      const shared = [...a].filter(w => b.has(w)).length / Math.max(a.size, b.size);
      assert.ok(shared < .9, `${hooks[i]} ~ ${hooks[j]}`);
    }
  }
});
check('6b an excluded hook is never returned again', () => {
  const f = corpus.find(x => x.id.startsWith('A'));
  const first = hookTexts(f)[0];
  assert.ok(!hookTexts(f, { exclude: [first] }).includes(first));
});
check('6c dangling pronouns and unresolved references fail', () => {
  const analysis = analyzeEvidence({ transcript: 'They never talk to customers because they build in secret.' });
  const mk = (text) => gateHook({ text, category: 'CURIOSITY', family: 'Curiosity Gap', template: 'X', slots: [{ type: 'CLAUSE', text: 'they never talk to customers', sentence: 0 }], frame: 'REASON', hedged: false, copyAllowed: false, firstPerson: false }, analysis, { transcript: analysis.evidenceText });
  assert.equal(mk('Why they never talk to customers').gate.NO_DANGLING_PRONOUN, false);
  assert.equal(mk('They copy competitors instead of listening').gate.NO_DANGLING_PRONOUN, false);
  assert.equal(mk('Why it matters so much to customers').gate.NO_DANGLING_PRONOUN, false);
  assert.equal(mk('Why Where is that equalizing mechanism').gate.CONTEXT_COMPLETE, false, '"that <noun>" with no introduction is unresolved');
  assert.equal(mk('Here is why the opposite is true').gate.CONTEXT_COMPLETE, false);
});
check('6d profanity, filler and hedges never reach a headline', () => {
  const analysis = analyzeEvidence({ transcript: 'I did not want to like offend her because I wanted to laugh at shit.' });
  const mk = (text) => gateHook({ text, category: 'BOLD', family: 'Bold Claim', template: 'X', slots: [{ type: 'CLAUSE', text, sentence: 0 }], frame: 'CLAIM', hedged: false, copyAllowed: true, firstPerson: false }, analysis, { transcript: analysis.evidenceText });
  assert.equal(mk('I wanted to laugh at shit').gate.NATURAL_HEADLINE, false);
  assert.equal(mk('They were going to be like').gate.GRAMMAR_OK, false);
  assert.equal(mk('I did not want to like offend her').gate.NATURAL_HEADLINE, false);
});

// ---- 7. clip boundaries ------------------------------------------------------------------------------------------------
check('a debate cannot end just before immediate explicit pushback', () => {
  const w = build([{ text: 'Remote work kills creativity because people stop bumping into each other.', gap: 0 },
    { text: 'I disagree.', gap: .4 }, { text: 'Our best ideas came from written proposals that everyone could read.', gap: .4 }]);
  const claimEnd = w.find(word => word.text === 'other.').end;
  const qa = sentenceBoundaryQa(w, 0, claimEnd + .12);
  assert.equal(qa.endComplete, false);
  assert.ok(qa.reasons.includes('FREE_END_BEFORE_DISAGREEMENT_RESPONSE'));
  assert.equal(qa.laterEnd, w.at(-1).end, 'the substantive response, not the short marker, resolves the ending');
  assert.equal(sentenceBoundaryQa(w, 0, w.at(-1).end + .12).endComplete, true);
  const ordinary = build([{ text: 'Remote work kills creativity because people stop bumping into each other.', gap: 0 },
    { text: 'Informal conversations create unexpected ideas.', gap: .4 }]);
  assert.equal(sentenceBoundaryQa(ordinary, 0, ordinary.find(w => w.text === 'other.').end + .12).endComplete, true);
});
const SOURCE = [
  { text: 'Most startups fail because they never talk to their customers.', gap: 0 },
  { text: 'Because they build in secret for a year.', gap: .35 },
  { text: 'They ignore feedback until the money is gone.', gap: .5 },
  { text: 'The lesson is simple: talk to users every single week.', gap: .6 },
  { text: 'Anyway, the next topic is hiring.', gap: 1.4 }];
check('7a start repair: a clip cannot open on "Because ..." without its setup', () => {
  const w = build(SOURCE), second = w.findIndex(x => x.text === 'Because');
  const r = boundary.repair({ startTime: w[second].start, endTime: w[second + 18].end, transcriptText: '' }, w, { minDuration: 5 });
  assert.ok(r.startTime <= w[0].start + .001, `start moved back to the sentence it depends on (${r.startTime})`);
  assert.equal(r.qa.START_COMPLETE, true);
});
check('7b end repair: a clip ending mid-sentence is extended to the sentence end', () => {
  const w = build(SOURCE), third = w.findIndex(x => x.text === 'ignore');
  const r = boundary.repair({ startTime: w[0].start, endTime: w[third + 2].end, transcriptText: '' }, w, { minDuration: 5 });
  assert.ok(r.endTime >= w.find(x => x.text === 'gone.').end - .001, `end moved to the sentence end (${r.endTime})`);
  assert.equal(r.qa.END_COMPLETE, true);
});
check('7b Free final validation preserves a complete ending with existing post-word room', () => {
  const words = build([
    { text: 'Email feels productive but email answers other peoples priorities.', gap: 0 },
    { text: 'The next task requires a completely different approach.', gap: 1 }
  ]);
  const last = words.find(word => word.text === 'priorities.');
  const range = { startTime: 0, endTime: last.end + 0.28, transcriptText: '' };
  const options = { minDuration: 1, preserveCompleteTargetEnd: true };
  const checked = boundary.validate(range, words, options);
  assert.equal(checked.valid, true);
  assert.equal(checked.qa.END_COMPLETE, true);
  const repairedAgain = boundary.repair(checked, words, options);
  assert.equal(repairedAgain.endTime, checked.endTime);
  assert.equal(boundary.validate({ ...range, endTime: last.end - 0.03 }, words, options).valid, false,
    'a word cut still fails; the padding fix cannot certify it');
  assert(boundary.repair(range, words, { minDuration: 1 }).endTime > range.endTime,
    'the default Pro repair behavior is unchanged');
});
check('7c sentence QA proposes one bounded step for a clip that stops inside a thought', () => {
  const w = build(SOURCE), third = w.findIndex(x => x.text === 'feedback');
  const qa = sentenceBoundaryQa(w, w[0].start, w[third].end);
  assert.equal(qa.endComplete, false); assert.ok(qa.reasons.some(r => r === 'FREE_END_MID_SENTENCE'), qa.reasons.join());
  assert.ok(qa.laterEnd > w[third].end);
});
check('7d a list is not cut in half', () => {
  const list = build([{ text: 'There are three reasons startups fail.', gap: 0 }, { text: 'First, they build something nobody wants.', gap: .4 },
    { text: 'Second, they run out of cash before they find customers.', gap: .4 }, { text: 'Third, the founders stop trusting each other.', gap: .4 }]);
  const secondEnd = list.find(x => x.text === 'customers.').end, thirdEnd = list.at(-1).end;
  const idx = new FreeTranscriptIndex({ words: list.map(w => ({ text: w.text, start: w.start, end: w.end })) });
  const partial = scoreMoment(idx, 0, secondEnd), whole = scoreMoment(idx, 0, thirdEnd);
  assert.ok(partial.reasons.includes('LIST_INCOMPLETE'));
  assert.ok(whole.dims.semanticCompleteness > partial.dims.semanticCompleteness + 20 && whole.dims.endQuality > partial.dims.endQuality);
  const qa = sentenceBoundaryQa(list, 0, secondEnd);
  assert.ok(qa.reasons.includes('FREE_END_MID_LIST') && qa.endComplete === false);
});
check('7e a question without its answer is incomplete; with it, complete', () => {
  const qa = build([{ text: 'Why do most people struggle to stay consistent?', gap: 0, speaker: 'h' }, { text: 'Because they rely on motivation instead of routine.', gap: .5, speaker: 'g' },
    { text: 'Motivation fades after two weeks but a routine keeps going.', gap: .4, speaker: 'g' }]);
  const idx = new FreeTranscriptIndex({ words: qa.map(w => ({ text: w.text, start: w.start, end: w.end, speaker: w.speaker })) });
  const qOnly = scoreMoment(idx, 0, qa.find(x => x.text === 'consistent?').end), withAnswer = scoreMoment(idx, 0, qa.at(-1).end);
  assert.ok(qOnly.reasons.includes('QUESTION_WITHOUT_ANSWER') || qOnly.reasons.includes('ENDS_ON_QUESTION'));
  assert.ok(withAnswer.dims.semanticCompleteness > qOnly.dims.semanticCompleteness && withAnswer.dims.questionAnswerStrength >= 85);
});
check('7f a story needs its outcome', () => {
  const story = build([{ text: 'Three years ago I lost my biggest client overnight.', gap: 0 }, { text: 'I remember sitting in my car staring at the invoice.', gap: .4 },
    { text: 'That night I called every old friend in my network.', gap: .4 }, { text: 'One of them offered me a project the next morning and it turned into my entire business.', gap: .4 }]);
  const idx = new FreeTranscriptIndex({ words: story.map(w => ({ text: w.text, start: w.start, end: w.end })) });
  const setupOnly = scoreMoment(idx, 0, story.find(x => x.text === 'invoice.').end), full = scoreMoment(idx, 0, story.at(-1).end);
  assert.ok(setupOnly.reasons.includes('STORY_WITHOUT_PAYOFF'));
  assert.ok(full.dims.payoffStrength > setupOnly.dims.payoffStrength + 10, `${full.dims.payoffStrength} vs ${setupOnly.dims.payoffStrength}`);
});

// ---- 8. noisy ending: bounded local escalation, no model -------------------------------------------------------------
const tailFor = (ws, { finalText, finalP = .47, speechContinues = null, stopped = false } = {}) => {
  const last = ws.at(-1), fresh = ws.slice(-8, -1).map(w => ({ text: w.text, start: w.start, end: w.end, confidence: .9 }));
  fresh.push({ text: finalText, start: last.start, end: last.end + .05, confidence: finalP });
  return tailPassFromResponse({ window_start: fresh[0].start, window_end: last.end + .11, language: 'en', words: fresh,
    acoustics: { final_word_end: last.end, stopped, speech_continues: speechContinues, audio_ends_ms: 110, post_silence_ms: 0 } }, last.end);
};
const NOISY = [{ text: 'We checked the names against the people at the door.', gap: 0 }, { text: 'The first name did not match the face at all.', gap: .4 },
  { text: 'It turns out it looks more like a metal...', gap: .3, p: .42 }];
(async () => {
  await checkAsync('a disagreement response outside the repair budget is held, never silently accepted', async () => {
    const w = build([{ text: 'Remote work kills creativity because people stop bumping into each other.', gap: 0 },
      { text: 'I disagree.', gap: .4 }, { text: 'Our best ideas came from written proposals that everyone could read.', gap: .4 }]);
    const end = w.find(word => word.text === 'other.').end + .1;
    const router = { generate: async () => { throw new Error('No cloud call is permitted'); } };
    const input = { startTime: 0, endTime: end, transcriptText: '' };
    const options = { minDuration: 1, maxDuration: 90, sourceDuration: w.at(-1).end + 1 };
    const held = await boundary.repairSemantic(input, w, router, false, { ...options, extension: .1 });
    assert.equal(held.valid, false);
    assert.equal(held.qa.END_COMPLETE, false);
    assert.ok(held.reasons.includes('FREE_END_BEFORE_DISAGREEMENT_RESPONSE'));
    const complete = await boundary.repairSemantic(input, w, router, false, { ...options, extension: 25 });
    assert.equal(complete.valid, true);
    assert.ok(complete.endTime >= w.at(-1).end);
  });
  await checkAsync('8 XeeFree: base tail pass once, then ONE local stronger pass only for an uncertain accepted ending', async () => {
    const w = build(NOISY), end = w.at(-1).end;
    const router = { generate() { throw new Error('XeeFree must never call a model'); } };
    const run = (verifyTail, verifyStrongTail) => boundary.repairSemantic({ startTime: 0, endTime: end, transcriptText: '' }, w, router, false,
      { sourceDuration: end + .11, minDuration: end - .01, verifyTail, verifyStrongTail });
    let base = 0, strong = 0;
    const confirmed = await run(async () => { base++; return tailFor(w, { finalText: 'Manuel.', finalP: .91 }); }, async () => { strong++; return tailFor(w, { finalText: 'Manuel.', finalP: .93 }); });
    assert.ok(base <= 1 && strong <= 1, `bounded: base=${base} strong=${strong}`);
    assert.ok(typeof confirmed.valid === 'boolean');
    let probes = 0;
    const down = await run(async () => { probes++; return null; }, async () => { probes++; return null; });
    assert.ok(probes <= 2); assert.equal(down.valid, false, 'no local evidence available: the clip is held, never shipped with a doubtful word');
    const verdictReasons = (r) => r.reasons.join(',');
    assert.ok(!/OPENAI|LLM_REVIEW/u.test(verdictReasons(down)));
  });

  // ---- 9. manual hook preservation ---------------------------------------------------------------------------------------
  await checkAsync('9 a manual hook wins; a rewrite request replaces it; a strong generated hook is kept', async () => {
    const f = corpus.find(x => x.id.startsWith('A')), ev = evidenceOf(f);
    const manual = freeCreative(ev, { existingHook: { text: 'My own words, exactly as I typed them', manual: true } });
    assert.equal(manual.hooks[0].text, 'My own words, exactly as I typed them'); assert.equal(manual.trace.preserved, 'MANUAL');
    const rewritten = freeCreative(ev, { existingHook: { text: 'My own words, exactly as I typed them', manual: true }, rewrite: true });
    assert.notEqual(rewritten.hooks[0].text, 'My own words, exactly as I typed them'); assert.equal(rewritten.trace.preserved, 'NONE');
    const generated = freeCreative(ev).hooks[0].text;
    const again = freeCreative(ev, { existingHook: { text: generated } });
    assert.equal(again.hooks[0].text, generated); assert.equal(again.trace.preserved, 'STRONG_EXISTING');
    const weak = freeCreative(ev, { existingHook: { text: 'They talk about stuff and things' } });
    assert.notEqual(weak.hooks[0].text, 'They talk about stuff and things', 'a hook that fails the gate is replaced');
    const judged = evaluateExistingHook('They talk about stuff and things', analyzeEvidence(ev), ev);
    assert.equal(judged.passed, false);
  });
  runSync();
})().catch((error) => { console.error(error); process.exitCode = 1; });

function runSync() {
  // ---- 10. multiple clips: diversity -----------------------------------------------------------------------------------
  check('10 diversity: near-identical moments are separated, strong distinct ones keep their order', () => {
    const mk = (id, start, text, score, extra = {}) => ({ id, startTime: start, endTime: start + 30, transcriptText: text, contentPotential: score,
      evidence: { freeMoment: { angle: extra.angle ?? 'GENERAL', keyPhrases: extra.keyPhrases ?? [], speakers: extra.speakers ?? [] } } });
    const a = mk('a', 0, 'Most startups fail because founders never talk to customers and build in secret for a year', 90, { angle: 'REASON', keyPhrases: ['most startups fail'] });
    const b = mk('b', 35, 'Most startups fail because founders never talk to customers and build in secret for a year again', 89, { angle: 'REASON', keyPhrases: ['most startups fail'] });
    const c = mk('c', 600, 'Hiring too fast destroys culture before you find product market fit and you cannot undo it', 84, { angle: 'LEAD', keyPhrases: ['hiring too fast'] });
    assert.ok(momentSimilarity(a, b) > .6 && momentSimilarity(a, c) < .3);
    assert.deepEqual(diversifyOrder([a, b, c]).map(x => x.id), ['a', 'c', 'b'], 'the near-duplicate drops behind the distinct moment');
    assert.deepEqual(diversifyOrder([a, c, b]).slice(0, 2).map(x => x.id), ['a', 'c']);
    const ordered = diversifyOrder([a, b, c]), prefix = diversifyOrder([a, b, c]).slice(0, 2);
    assert.deepEqual(ordered.slice(0, 2).map(x => x.id), prefix.map(x => x.id), 'the first N never change when more are requested');
    const far = mk('d', 2000, 'Hiring too fast destroys culture before you find product market fit and you cannot undo it', 83, { angle: 'LEAD', keyPhrases: ['hiring too fast'] });
    assert.ok(momentSimilarity(c, far) < momentSimilarity(c, mk('e', 640, c.transcriptText, 83, { angle: 'LEAD', keyPhrases: ['hiring too fast'] })), 'temporal nearness raises similarity');
  });
  check('10b moments: the fifteen weights sum to one and no dimension dominates', () => {
    const { FREE_MOMENT_WEIGHTS, FREE_MOMENT_DIMENSIONS } = dist('free/free-moments');
    const total = FREE_MOMENT_DIMENSIONS.reduce((s, d) => s + FREE_MOMENT_WEIGHTS[d], 0);
    assert.ok(Math.abs(total - 1) < 1e-9, String(total)); assert.ok(Math.max(...Object.values(FREE_MOMENT_WEIGHTS)) <= .14);
    assert.equal(FREE_MOMENT_DIMENSIONS.length, 15);
  });

  // ---- 11. captions ----------------------------------------------------------------------------------------------------
  check('11 caption cleanup repairs only safe defects and never invents or reorders words', () => {
    const tw = (t, s, e, c) => ({ text: t, start: s, end: e, ...(c !== undefined ? { confidence: c } : {}) });
    const input = [tw('The', 0, .2, .6), tw('the', .22, .4, .9), tw('market', .45, .9), tw(',', .9, .92), tw('looked', 1, 1.3), tw('safe.', 1.3, 1.7),
      tw('i', 1.8, 1.9), tw('think', 1.95, 2.2), tw('it', 2.25, 2.4), tw('it', 2.42, 2.6), tw('was', 2.65, 2.8), tw('very', 2.85, 3), tw('very', 3.02, 3.2), tw('bad', 3.25, 3.5)];
    const { words: out, fixes } = cleanCaptionWords(input);
    const text = out.map(w => w.text).join(' ');
    assert.ok(/^The market, looked safe\. I think it was very very bad$/u.test(text), text);
    assert.deepEqual([...new Set(fixes.map(f => f.kind))].sort(), ['DUPLICATE_WORD', 'PUNCTUATION_TOKEN', 'SENTENCE_CASE']);
    assert.ok(out.every((w, i) => i === 0 || w.start >= out[i - 1].start), 'timings stay ordered');
    assert.equal(out.find(w => w.text === 'The').start, 0, 'the merged word keeps the first start');
    const emphatic = cleanCaptionWords([tw('no', 0, .3), tw('no', .32, .6), tw('no', .62, .9)]);
    assert.equal(emphatic.words.length, 3, 'a real emphatic repeat is kept');
    const hindi = [tw('हर', 0, .3), tw('हर', .31, .6), tw('किसी', .7, 1)];
    assert.equal(cleanCaptionWords(hindi).words.length, 3, 'other languages are left exactly as recognised');
    const frag = cleanCaptionWords([tw('the', 0, .2), tw('market', .22, .5), tw('the', .52, .7), tw('market', .72, 1), tw('crashed.', 1.05, 1.5)]);
    assert.equal(frag.words.map(w => w.text).join(' '), 'the market crashed.');
    const contentBefore = input.map(w => w.text.toLowerCase().replace(/[^a-z]/gu, '')).filter(Boolean), contentAfter = out.map(w => w.text.toLowerCase().replace(/[^a-z]/gu, '')).filter(Boolean);
    assert.ok(contentAfter.every(w => contentBefore.includes(w)), 'no word is invented');
  });

  // ---- 12. speakers + emphasis -----------------------------------------------------------------------------------------
  check('12a speaker changes: blips cancel, real turns survive, no shot under the minimum', () => {
    const r = stabilizeSpeakerChanges([2, 2.6, 8, 8.4, 8.9, 15]);
    // 2 and 2.6 reverse each other within 1.6 s (a blip) and cancel; 8, 8.4 and 8.9 are three flips in under 1.6 s, leaving one change; 15 is a real turn.
    assert.ok(r.times.includes(15) && !r.times.includes(2) && !r.times.includes(2.6), JSON.stringify(r));
    assert.equal(r.times.filter(t => t >= 8 && t < 9).length, 1, 'three rapid flips reduce to the single net change');
    assert.ok(shortestShot(r.times) >= 1.6 || r.times.length < 2);
    assert.deepEqual(stabilizeSpeakerChanges([5, 12, 20]).times, [5, 12, 20], 'well separated turns are untouched');
    assert.equal(stabilizeSpeakerChanges([5, 5.5]).dropped, 2);
  });
  check('12b emphasis lands on sentence beats, spaced, never at the very start or end', () => {
    const talk = build([{ text: 'Most startups fail for one reason.', gap: 0 }, { text: 'They build something nobody wants because they never ask.', gap: .4 },
      { text: 'Revenue grew forty percent after one conversation.', gap: .4 }, { text: 'The market tells you what to build, not your ego.', gap: .5 },
      { text: 'So talk to ten customers this week.', gap: .5 }]);
    const picks = freeEmphasisPicks(talk, 0, talk.at(-1).end, 5);
    assert.ok(picks.length >= 2 && picks.length <= 5, String(picks.length));
    assert.ok(picks.every((p, i) => i === 0 || p.word.start - picks[i - 1].word.start >= 4), 'spaced at least four seconds apart');
    assert.ok(picks.every(p => p.word.start > 1.5 && p.word.end < talk.at(-1).end - 1.2));
    assert.equal(new Set(picks.map(p => p.sentence)).size, picks.length, 'one pick per sentence');
    assert.ok(picks.some(p => ['NUMBER', 'CONTRAST', 'PAYOFF', 'CONCLUSION', 'REASON'].includes(p.kind)));
  });

  // ---- 13. StyleZero / StyleOne / StyleTwo ---------------------------------------------------------------------------------
  check('13 every English hook fits StyleZero, StyleOne and StyleTwo without being shortened', () => {
    for (const f of corpus.filter(x => !x.language)) for (const text of hookTexts(f)) {
      const fit = hookFitsTemplates(text);
      assert.ok(fit.styleZero && fit.styleOne && fit.styleTwo, `${text}: ${JSON.stringify(fit)}`);
    }
  });

  // ---- 14. languages: honest, not certified ------------------------------------------------------------------------------
  check('14 Hindi and Hinglish: verbatim lines, held below the bar, never an English template', () => {
    for (const id of ['J', 'K']) {
      const c = freeCreative(evidenceOf(corpus.find(f => f.id.startsWith(id))));
      assert.equal(c.hooks.length, 1);
      assert.ok(c.trace.languageUnverified, 'the trace says the language path is unverified');
      assert.ok(c.hooks[0].CLICKABILITY_SCORE < 70, 'held below the acceptance bar so the package is flagged for review');
      assert.ok(!/^(?:Why|How to|Is it true|What happens|The lesson|Here's)/u.test(c.hooks[0].text), 'no English template wording on another language');
      assert.ok(!/\b(?:What do you think|Key point|Agree or disagree)\b/u.test(c.draft.captions.map(x => x.text).join(' ')), 'no English decoration on another language');
    }
  });

  // ---- 15. nothing invented when there is nothing -----------------------------------------------------------------------
  check('15 no evidence, no hooks', () => {
    assert.deepEqual(freeCreative({ transcript: '' }).hooks, []);
    assert.deepEqual(freeCreative({ transcript: 'Um. Uh. Yeah.' }).hooks, []);
  });
  check('16 determinism: the same evidence always gives the same hooks', () => {
    for (const f of corpus) assert.deepEqual(hookTexts(f), hookTexts(f));
  });
  check('17 gates: all twelve names exist and are used', () => {
    assert.deepEqual([...FREE_HOOK_GATES].sort(), ['CLICKABLE_ENOUGH', 'CONTEXT_COMPLETE', 'GRAMMAR_OK', 'GROUNDED', 'MEANING_CLEAR', 'NATURAL_HEADLINE', 'NO_DANGLING_PRONOUN',
      'NO_MISLEADING_CLAIM', 'NO_TRANSCRIPT_COPY', 'NO_UNSUPPORTED_NAME', 'NO_UNSUPPORTED_NUMBER', 'NO_WORD_SALAD'].sort());
  });
  console.log(JSON.stringify({ xeefreeEngineChecks: checks, contentTypes: corpus.length }));
}
void framesOf; void sentencesFromText;
