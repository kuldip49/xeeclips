// Content-quality and hook-styling pass: headline scoring, long-hook layout,
// accent budgets, platform packaging and the deterministic fallback package.
// Pure logic against dist/ - no Docker stack, no network.
const assert = require('node:assert/strict');
const { scoreHook, chooseBestHook, deterministicHook, deterministicHookCandidates,
  solemnSubject, HOOK_LENGTH } = require('../dist/modules/editing/hook-generator');
const { hookAccentCandidates, hookAccentBudget, applyHookAccents, hookAccentFamily,
  HOOK_ACCENT_FAMILY_COLORS, HOOK_TEXT_COLOR } = require('../dist/modules/editing/hook-accent');
const { fitHookText, HOOK_TYPE, breakLines } = require('../dist/modules/editing/text-layout');
const { PLATFORM_LAYOUT_PRESETS } = require('../dist/modules/editing/platform-layout');
const { packagingFor, adaptHashtagsForPlatform, platformPackagingPrompt,
  packagingTelemetry } = require('../dist/modules/processing/platform-packaging');
const { fallbackContent } = require('../dist/modules/processing/openai-clip-judge.service');
const { applyDeterministicEditorial } = require('../dist/modules/editing/deterministic-editorial');

let passed = 0;
const failures = [];
function test(name, run) {
  try { run(); passed++; console.log('  ok  ' + name); }
  catch (error) { failures.push(name); console.log('FAIL  ' + name + '\n      ' + error.message); }
}

// --------------------------------------------------------------- fixtures
// One fixture per clip type the pass has to handle without forcing a register
// that does not belong to the material.
const CLIPS = {
  political: { transcript: 'There was a huge market for it and that was banned last year. ' +
      'The council said the rules protect residents, but traders lost their whole income.',
  title: 'Council market decision', synopsis: '' },
  funny: { transcript: 'So they built the entire booking system in a weekend and then somehow ' +
      'nobody could actually log in. It was ridiculous. We laughed for about an hour.',
  title: 'Weekend build', synopsis: '' },
  serious: { transcript: 'Three people died in the fire because the alarm had been disconnected ' +
      'for two months and nobody reported it.',
  title: 'Fire report', synopsis: '' },
  educational: { transcript: 'Dust on a solar panel blocks about 20 percent of the sunlight it ' +
      'would otherwise absorb, and a single wash restores most of that output.',
  title: 'Solar panel maintenance', synopsis: '' },
  technical: { transcript: 'The index was never used because the query planner saw a type ' +
      'mismatch, so every request scanned the whole table instead.',
  title: 'Database performance', synopsis: '' },
  story: { transcript: 'I quit the job on a Tuesday with nothing lined up, and three weeks later ' +
      'the same company called back with a better offer.',
  title: 'Career change', synopsis: '' },
  debate: { transcript: 'He argued the subsidy created jobs. She said the same money would have ' +
      'created twice as many jobs somewhere else, and neither side moved.',
  title: 'Subsidy debate', synopsis: '' }
};

const candidateFor = (key) => ({ videoId: 'video', rangeKey: '0:30', startTime: 0, endTime: 30,
  duration: 30, transcriptText: CLIPS[key].transcript, heuristicScore: 70,
  judgeSource: 'HEURISTIC_FALLBACK', rank: null, hookScore: 70, sourceHookScore: 70,
  standaloneScore: 70, payoffScore: 70, flowScore: 70, informationScore: 70, retentionScore: 70,
  shareabilityScore: 70, contentPotential: 70, overallScore: 70, reject: false,
  topic: CLIPS[key].title, reason: 'grounded', rejectionReason: '',
  relevantTopics: [CLIPS[key].title], evidence: {}, clipUnderstanding: {} });

// ------------------------------------------------------- hook generation
test('every clip type produces a grounded, non-plain headline', () => {
  for (const [name, context] of Object.entries(CLIPS)) {
    const hook = deterministicHook(context);
    assert(hook, `${name}: no headline produced`);
    assert.equal(hook.rejected, '');
    assert(hook.wordCount >= HOOK_LENGTH.min && hook.wordCount <= HOOK_LENGTH.max,
      `${name}: ${hook.wordCount} words - ${hook.text}`);
    // Never a slice cut out of the middle of a spoken sentence.
    assert.notEqual(scoreHook(hook.text, context).rejected, 'TRANSCRIPT_FRAGMENT');
  }
});

test('a rewrite beats a plain restatement whenever one exists', () => {
  // These clips all support a real recast (a question, a turn, a contrast), so
  // the winner must not be the transcript line itself.
  for (const name of ['political', 'funny', 'serious']) {
    const context = CLIPS[name];
    const hook = deterministicHook(context);
    assert(!context.transcript.toLowerCase()
      .includes(hook.text.toLowerCase().replace(/[?!.]+$/u, '')),
    `${name} restated the transcript: ${hook.text}`);
    assert.notEqual(hook.mechanism, 'PLAIN', `${name}: ${hook.text}`);
  }
});

test('the deterministic pool offers several real alternatives, not one line', () => {
  const pool = deterministicHookCandidates(CLIPS.political);
  assert(pool.length >= 3, `only ${pool.length} candidates`);
  assert.equal(new Set(pool).size, pool.length);
  const accepted = pool.map((text) => scoreHook(text, CLIPS.political))
    .filter((item) => !item.rejected);
  assert(accepted.length >= 2, 'fewer than two usable candidates');
  assert(new Set(accepted.map((item) => item.mechanism)).size >= 2, 'one mechanism only');
});

test('humour is never forced onto solemn material', () => {
  assert.equal(solemnSubject(CLIPS.serious), true);
  assert.equal(solemnSubject(CLIPS.funny), false);
  const hook = deterministicHook(CLIPS.serious);
  assert.notEqual(hook.mechanism, 'HUMOR');
  assert.notEqual(hook.mechanism, 'IRONY');
});

test('hard rejections cover the whole dishonesty list', () => {
  const context = CLIPS.political;
  const reject = (text) => scoreHook(text, context).rejected;
  assert.equal(reject('This Changes Everything About the Market and Its Traders'),
    'FABRICATED_CLICKBAIT');
  assert.equal(reject('"Nobody Will Ever Trade Here" Says the Council Leader Today'),
    'FABRICATED_QUOTE');
  assert.equal(reject('The Market Ban Explained Right Now So Please Hurry'), 'FALSE_URGENCY');
  assert.equal(reject('Quantum Lattice Divergence Protocol Rebalancing Itself Continuously Forever'),
    'NOT_GROUNDED');
  assert.equal(reject('Um Yeah the Market Was Banned and Nobody Objected'), 'TRANSCRIPT_FRAGMENT');
  assert.equal(reject('and the market was banned by the council last year'), 'INCOMPLETE_SENTENCE');
  assert.equal(reject(''), 'EMPTY_TEXT');
  // A headline shorter than a complete thought is rejected on length alone.
  assert.equal(reject('The Market Was Banned'), 'INVALID_LENGTH');
});

test('a noun pile with no predicate is not a headline', () => {
  // Seen on a real render before this rule: a window slice that stopped on a
  // name ("Reason Why Donald Trump") passed every other check.
  const context = { transcript: 'The reason why Donald Trump won that state was simple, ' +
      'and nobody in the room wanted to say it out loud.',
  title: 'Election analysis', synopsis: '' };
  assert.equal(scoreHook('Reason Why Donald Trump That State That Room', context).rejected,
    'INCOMPLETE_SENTENCE');
  assert.equal(scoreHook('Nobody in That Room Wanted to Say It Out Loud', context).rejected, '');
  assert.equal(scoreHook('Why Did Donald Trump Win That State So Easily?', context).rejected, '');
  // A possessive is not a predicate, and an ordinal is not an ending: both came
  // out of a real render as "PERIOD BETWEEN TRUMP'S FIRST".
  assert.equal(scoreHook("Period Between Trump's First Term and the Second",
    { transcript: 'The period between Trump\'s first term and the second one changed everything.',
      title: 'Terms', synopsis: '' }).rejected, 'INCOMPLETE_SENTENCE');
  const hook = deterministicHook(context);
  assert(hook, 'no headline produced');
  assert.equal(hook.rejected, '');
});

test('diversity spreads mechanisms across clips from one video', () => {
  const first = deterministicHook(CLIPS.political);
  const used = { ...CLIPS.political, usedMechanisms: [first.mechanism, first.mechanism],
    usedHooks: [first.text] };
  const repeat = scoreHook(first.text, used);
  assert.equal(repeat.rejected, 'DUPLICATE_ACROSS_CLIPS');
  const { best } = chooseBestHook(deterministicHookCandidates(used), used);
  if (best) assert.notEqual(best.text, first.text);
});

// ------------------------------------------------------ long-hook layout
const HOOKS_BY_LENGTH = {
  7: 'Why Was This Local Market Suddenly Banned?',
  8: 'The Council Banned the Market Traders Relied On',
  10: 'Nobody Expected This One Decision to Change the Whole Market',
  12: 'Nobody Expected This One Council Decision to Change Everything About the Local Market',
  15: 'Nobody Expected This One Council Decision to Change Everything About How the Local ' +
    'Market Was Actually Run'
};

test('hooks of 7 to 15 words all fit the header without breaking the layout', () => {
  for (const preset of Object.values(PLATFORM_LAYOUT_PRESETS)) {
    for (const [words, text] of Object.entries(HOOKS_BY_LENGTH)) {
      const zone = preset.hookZone;
      const fit = fitHookText(text, { ...zone, height: zone.height - 4 },
        { maxFont: HOOK_TYPE.maxFont, minFont: HOOK_TYPE.minFont });
      const label = `${preset.id}/${words}w`;
      assert(fit, `${label}: no fit`);
      // Inside the zone: no overlap with the video below, no top-edge collision.
      assert(fit.width <= zone.width, `${label}: width ${fit.width} > ${zone.width}`);
      assert(fit.height <= zone.height, `${label}: height ${fit.height} > ${zone.height}`);
      assert(zone.y + zone.height - Math.round(fit.height) >= zone.y - 2,
        `${label}: block starts above the safe top`);
      assert(fit.lines.length >= 1 && fit.lines.length <= HOOK_TYPE.maxLines,
        `${label}: ${fit.lines.length} lines`);
      assert(fit.fontSize >= HOOK_TYPE.longMinFont,
        `${label}: font ${fit.fontSize} below the readable floor`);
      // No awkward single-word final line, and no wildly uneven lines.
      if (fit.lines.length > 1) {
        assert(fit.lines[fit.lines.length - 1].split(' ').length > 1 ||
          text.split(' ').length <= 3, `${label}: orphan last word`);
        const lengths = fit.lines.map((line) => line.length);
        assert(Math.max(...lengths) - Math.min(...lengths) <= Math.max(14,
          Math.max(...lengths) * .6), `${label}: uneven lines ${fit.lines.join(' | ')}`);
      }
    }
  }
});

test('a long headline keeps its wording instead of being cut down', () => {
  const zone = PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS.hookZone;
  for (const words of [12, 15]) {
    const text = HOOKS_BY_LENGTH[words];
    const fit = fitHookText(text, { ...zone, height: zone.height - 4 },
      { maxFont: HOOK_TYPE.maxFont, minFont: HOOK_TYPE.minFont });
    assert.equal(fit.shortenLevel, 0, `${words}w was shortened to: ${fit.text}`);
    assert.equal(fit.text.split(' ').length, text.split(' ').length);
    // Space is used before size is sacrificed: a long hook takes more lines.
    assert(fit.lines.length >= 2, `${words}w rendered on ${fit.lines.length} line(s)`);
  }
});

test('a short headline is still set large and tight', () => {
  const zone = PLATFORM_LAYOUT_PRESETS.UNIVERSAL.hookZone;
  const fit = fitHookText(HOOKS_BY_LENGTH[7], { ...zone, height: zone.height - 4 },
    { maxFont: HOOK_TYPE.maxFont, minFont: HOOK_TYPE.minFont });
  assert(fit.fontSize >= HOOK_TYPE.minFont, `font ${fit.fontSize}`);
  assert(fit.lines.length <= 2, `${fit.lines.length} lines for a 5-word hook`);
});

test('line breaking prefers a balanced, semantic shape', () => {
  const lines = breakLines('Nobody Expected This One Decision to Change Everything'.split(' '), 3, 70);
  assert.equal(lines.length, 3);
  assert(lines[lines.length - 1].split(' ').length > 1, `orphan: ${lines.join(' | ')}`);
  for (const line of lines.slice(0, -1))
    assert(!/\b(the|a|an|to|of|for|and|or)$/iu.test(line), `weak break: ${line}`);
});

// -------------------------------------------------------- accent styling
test('accent count scales with headline length and stays controlled', () => {
  const expectations = [[7, 2], [8, 2], [10, 2], [12, 3], [15, 4]];
  for (const [words, budget] of expectations) {
    const text = HOOKS_BY_LENGTH[words];
    assert.equal(hookAccentBudget(text.split(' ').length), budget, `${words}w budget`);
    const accents = hookAccentCandidates(text);
    assert(accents.length >= 1, `${words}w: no accent`);
    assert(accents.length <= budget, `${words}w: ${accents.length} accents > ${budget}`);
    assert(accents.length < text.split(' ').length, `${words}w: whole headline coloured`);
    // Emphasis is spread, never a cluster of adjacent words.
    for (let index = 1; index < accents.length; index++)
      assert(accents[index].index - accents[index - 1].index > 1,
        `${words}w: adjacent accents ${accents.map((item) => item.word).join(',')}`);
  }
});

test('accent selection is deterministic and uses one colour family', () => {
  const text = HOOKS_BY_LENGTH[12];
  const first = hookAccentCandidates(text);
  const second = hookAccentCandidates(text);
  assert.deepEqual(first.map((item) => item.index), second.map((item) => item.index));
  // Accents come back in reading order; exactly one of them is the primary.
  const roles = first.map((item) => item.role);
  assert.equal(roles.filter((role) => role === 'PRIMARY').length, 1, roles.join(','));
  assert(first.every((item, index) => index === 0 || item.index > first[index - 1].index));
  const family = hookAccentFamily(text);
  const color = HOOK_ACCENT_FAMILY_COLORS[family];
  const rendered = applyHookAccents(['Nobody Expected This One Council Decision',
    'to Change Everything About the Local Market'], first, HOOK_TEXT_COLOR, (value) => value,
  color);
  const joined = rendered.lines.join(' ');
  assert(joined.includes(color), 'accent colour missing');
  // Never two families in one headline.
  for (const [other, otherColor] of Object.entries(HOOK_ACCENT_FAMILY_COLORS))
    if (other !== family) assert(!joined.includes(otherColor), `${family} mixed with ${other}`);
  assert.equal(rendered.accentedWordCount, first.length);
});

test('a strong word carries the accent, not a function word', () => {
  const accents = hookAccentCandidates('The Council Banned the Local Market Overnight');
  const words = accents.map((item) => item.word.toLowerCase());
  assert(!words.includes('the'), words.join(','));
  assert(words.some((word) => ['banned', 'overnight', 'council', 'market'].includes(word)),
    words.join(','));
});

// ----------------------------------------------------- platform packaging
test('each platform gets its own packaging contract', () => {
  const instagram = packagingFor('INSTAGRAM_REELS');
  const tiktok = packagingFor('TIKTOK');
  const shorts = packagingFor('YOUTUBE_SHORTS');
  assert.equal(instagram.captionStyle, 'CONVERSATIONAL_EMOTIONAL');
  assert.equal(tiktok.captionStyle, 'PUNCHY_CURIOSITY');
  assert.equal(shorts.captionStyle, 'CLEAR_SEARCHABLE');
  assert.equal(new Set([instagram.hashtagStrategy, tiktok.hashtagStrategy,
    shorts.hashtagStrategy]).size, 3);
  // Shorts deliberately carries the fewest tags; Instagram the most.
  assert(shorts.hashtags.target < tiktok.hashtags.target);
  assert(tiktok.hashtags.target < instagram.hashtags.target);
  assert.equal(packagingFor(null).captionStyle, 'PLATFORM_NEUTRAL');
  for (const platform of ['INSTAGRAM_REELS', 'TIKTOK', 'YOUTUBE_SHORTS'])
    assert(platformPackagingPrompt(platform).includes(platform));
});

test('hashtags are resized per platform without inventing tags', () => {
  const chosen = ['#LocalMarket', '#MarketBan', '#CouncilDecision', '#Traders', '#SmallBusiness'];
  const pool = ['#MarketRules', '#Residents', '#Unrelated'];
  const relevance = CLIPS.political.transcript + ' local market traders council residents rules';
  for (const platform of ['INSTAGRAM_REELS', 'TIKTOK', 'YOUTUBE_SHORTS']) {
    const { hashtags } = packagingFor(platform);
    const result = adaptHashtagsForPlatform(platform, chosen, pool, relevance);
    assert(result.length >= hashtags.min && result.length <= hashtags.max,
      `${platform}: ${result.length} tags`);
    assert.equal(new Set(result.map((tag) => tag.toLowerCase())).size, result.length);
    for (const tag of result)
      assert([...chosen, ...pool].includes(tag), `${platform}: invented ${tag}`);
  }
  assert(adaptHashtagsForPlatform('YOUTUBE_SHORTS', chosen, pool, relevance).length <
    adaptHashtagsForPlatform('INSTAGRAM_REELS', chosen, pool, relevance).length);
  // Spam tags never survive, whatever the platform asked for.
  assert.deepEqual(adaptHashtagsForPlatform('TIKTOK', ['#viral', '#fyp', '#MarketBan'], [],
    relevance), ['#MarketBan']);
});

test('packaging telemetry records the decisions analytics will need', () => {
  const telemetry = packagingTelemetry('TIKTOK', ['#A', '#B', '#C']);
  assert.equal(telemetry.platform, 'TIKTOK');
  assert.equal(telemetry.captionStyle, 'PUNCHY_CURIOSITY');
  assert.equal(telemetry.hashtagStrategy, 'TIGHT_TOPICAL');
  assert.equal(telemetry.hashtagCount, 3);
});

// ------------------------------------------------ deterministic fallback
const FILLER = /(this clip is interesting|watch what happens|you won'?t believe|wait for it)/iu;

test('the fallback package is complete and clip-specific for every clip type', () => {
  for (const key of Object.keys(CLIPS)) {
    const content = fallbackContent(candidateFor(key));
    assert(content.bestHook, `${key}: no hook`);
    assert(content.alternateHooks.length >= 1, `${key}: no alternate grounded framing`);
    assert(content.title, `${key}: no title`);
    assert(content.synopsis.length > 20 && content.synopsis.length < 1200, `${key}: concise specific synopsis`);
    assert(content.caption, `${key}: no caption`);
    assert(content.hashtags.length >= 3, `${key}: ${content.hashtags.length} hashtags`);
    for (const value of [content.bestHook, content.caption, content.synopsis])
      assert(!FILLER.test(value), `${key}: AI-broken filler in "${value}"`);
    // Specific to this clip: the caption shares real words with the transcript.
    const source = new Set(CLIPS[key].transcript.toLowerCase().match(/[a-z]{5,}/gu) ?? []);
    assert([...source].some((word) => content.caption.toLowerCase().includes(word)),
      `${key}: caption is not clip-specific - ${content.caption}`);
  }
});

test('the fallback caption changes register with the platform', () => {
  const candidate = candidateFor('educational');
  const captions = ['INSTAGRAM_REELS', 'TIKTOK', 'YOUTUBE_SHORTS']
    .map((platform) => fallbackContent(candidate, platform).caption);
  assert.equal(new Set(captions).size, 3, captions.join(' | '));
  for (const caption of captions) assert(caption.length > 0);
});

test('the package promises what the clip delivers', () => {
  const content = fallbackContent(candidateFor('educational'));
  const source = new Set(CLIPS.educational.transcript.toLowerCase().match(/[a-z]{4,}/gu) ?? []);
  const shares = (value) => (value.toLowerCase().match(/[a-z]{4,}/gu) ?? [])
    .some((word) => source.has(word));
  assert(shares(content.bestHook), content.bestHook);
  assert(shares(content.title), content.title);
  assert(shares(content.synopsis), 'synopsis');
  assert(content.hashtags.some(shares), content.hashtags.join(','));
});

// ------------------------------------------------------ subtitle emphasis
test('subtitle emphasis lands on meaningful words, never filler', () => {
  const words = ('So basically the council actually banned the entire market overnight and ' +
    'nobody warned the traders').split(' ').map((text, index) =>
    ({ text, start: index * 0.5, end: index * 0.5 + 0.4 }));
  const plan = { clipStartSec: 0, clipEndSec: words.length * 0.5, subtitleEmphasis: [],
    operations: [], subtitleStyle: { animationStyle: 'POP', highlightCurrentWord: false } };
  const result = applyDeterministicEditorial(plan, words, 'council banned market');
  assert(result.subtitleEmphasis.length >= 1, 'no emphasis chosen');
  const chosen = result.subtitleEmphasis.map((item) => item.word.toLowerCase());
  for (const filler of ['so', 'basically', 'the', 'and', 'actually'])
    assert(!chosen.includes(filler), `filler emphasised: ${filler}`);
  assert(chosen.some((word) => ['banned', 'overnight', 'nobody', 'council'].includes(word)),
    chosen.join(','));
});

console.log(`\n${passed}/${passed + failures.length} content-package tests passed`);
if (failures.length) {
  console.error('Failed: ' + failures.join(', '));
  process.exit(1);
}
