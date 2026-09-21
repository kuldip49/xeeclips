const assert = require('node:assert/strict');
const { ContentPackagingService, EntityResolutionService, ContentCategoryService,
  FirstFramePackagingValidator } = require('../dist/modules/editing/content-packaging.service');
const { buildSubtitlePhrases } = require('../dist/modules/editing/subtitle-phrases');
const { fitHookText } = require('../dist/modules/editing/text-layout');
const { placeAroundSourceText, PODCAST_BOLD_STYLE } =
  require('../dist/modules/editing/subtitle-renderer.service');
const { hookMetaLanguageFree } = require('../dist/modules/editing/editing-plan-validator');

const packaging = new ContentPackagingService();
const identity = new EntityResolutionService();
const categories = new ContentCategoryService();
const firstFrame = new FirstFramePackagingValidator();
const base = (input = {}) => ({ aiMode: 'FALLBACK_ONLY',
  transcript: 'The market looked safe, but the hidden cost changed the entire decision. ' +
    'That mistake meant investors paid twice for the same risk.',
  title: 'The Hidden Cost of Safe Investments', synopsis: 'A warning about investment risk.',
  wholeVideoSummary: 'A finance podcast about risk, markets and investment decisions.',
  targetPlatform: 'YOUTUBE_SHORTS', ...input });
const timed = (text, step = .18) => text.split(' ').map((word, index) =>
  ({ text: word, start: index * step, end: index * step + step * .8 }));

async function main() {
  let passed = 0;
  const test = async (name, fn) => { await fn(); passed++; console.log(`ok   ${name}`); };

  await test('1 known host name is safe when explicit introduction supplies strong evidence', () => {
    const result = identity.resolve(base({ title: 'Maya Chen Podcast',
      transcript: "I'm Maya Chen and today we explain the market risk.", speakerTrackIds: ['spk-1'] }));
    const maya = result.entities.find((entity) => entity.name === 'Maya Chen');
    assert(maya?.safeToUse); assert.equal(result.speakers[0].resolvedEntityId, maya.id);
  });
  await test('2 known guest name is resolved from agreeing title and transcript evidence', () => {
    const result = identity.resolve(base({ title: 'A Conversation With Daniel Ruiz',
      transcript: 'Welcome Daniel Ruiz. Daniel Ruiz built the company after the crash.' }));
    assert(result.entities.some((entity) => entity.name === 'Daniel Ruiz' && entity.safeToUse));
  });
  await test('3 unknown speaker never receives an invented name', () => {
    const result = identity.resolve(base({ title: 'A Market Lesson',
      transcript: 'I learned the lesson after the market changed.', speakerTrackIds: ['unknown'] }));
    assert.equal(result.entities.filter((entity) => entity.safeToUse).length, 0);
    assert.equal(result.speakers[0].resolvedEntityId, undefined);
    const headline = identity.resolve(base({ title: 'Why Bond Prices Change',
      originalName: 'Why Bond Prices Change', transcript: 'Bond prices changed after demand fell.' }));
    assert.equal(headline.entities.length, 0);
  });
  await test('4 ambiguous single-source identity is retained as unsafe evidence', () => {
    const result = identity.resolve(base({ title: 'Jordan Blake on Markets',
      originalName: 'Jordan Blake on Markets',
      transcript: 'The market changed quickly and nobody expected the cost.' }));
    const jordan = result.entities.find((entity) => entity.name === 'Jordan Blake');
    assert(jordan); assert.equal(jordan.safeToUse, false);
  });
  await test('5 comedy clip detects source humor rather than forcing it', async () => {
    const result = await packaging.create(base({ title: 'A Comedian Explains the Awkward Joke',
      transcript: 'The joke was so absurd that everyone laughed at the ridiculous punchline.',
      wholeVideoSummary: 'A comedy podcast with jokes and punchlines.' }));
    assert.equal(result.primaryCategory, 'COMEDY'); assert.equal(result.humor.detected, true);
  });
  await test('6 serious podcast stays serious', async () => {
    const result = await packaging.create(base({ title: 'The Policy Interview Podcast',
      transcript: 'The interview examines a serious policy consequence for local families.',
      wholeVideoSummary: 'A podcast interview about public policy.' }));
    assert(['PODCAST', 'POLITICS'].includes(result.primaryCategory));
    assert.equal(result.humor.detected, false);
  });
  await test('7 finance numbers create finance packaging and specific tags', async () => {
    const result = await packaging.create(base({ transcript:
      'The portfolio lost 20 percent because the interest rate changed the bond market.' }));
    assert.equal(result.primaryCategory, 'FINANCE');
    assert(result.hashtags.youtubeShorts.some((tag) => /finance|invest/i.test(tag)));
  });
  await test('8 AI and tech discussion receives AI category', () => {
    assert.equal(categories.classify('OpenAI built a new artificial intelligence model for developers').primaryCategory, 'AI');
  });
  await test('9 sports clip receives sports category', () => {
    assert.equal(categories.classify('The player broke the league record during the championship match').primaryCategory, 'SPORTS');
  });
  await test('10 gaming reaction receives gaming category', () => {
    assert.equal(categories.classify('The gamer reached the final boss fight on PlayStation').primaryCategory, 'GAMING');
  });
  await test('11 two-person podcast never guesses name-to-track order', () => {
    const result = identity.resolve(base({ title: 'Maya Chen With Daniel Ruiz',
      transcript: 'Welcome Maya Chen and Daniel Ruiz to the podcast interview.',
      speakerTrackIds: ['spk-a', 'spk-b'] }));
    assert(result.speakers.every((speaker) => !speaker.resolvedEntityId));
  });
  await test('12 OCR lower third can corroborate a real name', () => {
    const result = identity.resolve(base({ title: 'Interview With Priya Shah', ocrText: 'PRIYA SHAH',
      transcript: 'Priya Shah explains the investment decision.' }));
    assert(result.entities.some((entity) => /Priya Shah/i.test(entity.name) && entity.safeToUse));
  });
  await test('13 a long grounded hook fits a balanced two-line header', () => {
    const fit = fitHookText('The Hidden Market Cost Changed Every Investment Decision Overnight',
      { x: 100, y: 64, width: 880, height: 260 }, { maxLines: 2 });
    assert(fit); assert.equal(fit.lines.length, 2);
  });
  await test('14 fast speech stays in semantic phrases of at most six words', () => {
    const phrases = buildSubtitlePhrases(timed('This important number changed the entire investment decision very quickly', .09), 5);
    assert(phrases.length > 1); assert(Math.max(...phrases.map((phrase) => phrase.words.length)) <= 6);
  });
  await test('15 source lower third collision selects a safe alternate position', () => {
    const result = placeAroundSourceText(1300, [{ x: 100, y: 1180, width: 800, height: 180 }], [],
      { x: 540, width: 700, height: 150 }, { x: 0, y: 360, width: 1080, height: 1180 });
    assert(result.collided); assert.notEqual(result.bottom, 1300);
  });
  await test('16 first-frame hook collision fails honestly', () => {
    const result = firstFrame.validate({ hookVisible: true, hookReadable: true,
      hookInsideSafeZone: false, subjectVisible: true, hookContrastRatio: 6,
      subtitleFirstStartSec: .2, firstSpeechSec: .2 });
    assert.equal(result.valid, false); assert.equal(result.noVisualCollision, false);
  });
  await test('17 unsupported provocative hooks are rejected', async () => {
    const result = await packaging.create(base({ existingHooks: [
      'This Secret Cost Investors 99 Billion Dollars Overnight',
      'They Changed the Entire Investment Decision Overnight'] }));
    const provocative = result.hookCandidates.find((hook) => hook.text.includes('99 Billion'));
    assert(provocative?.rejected);
    assert.equal(result.hookCandidates.find((hook) => hook.text.startsWith('They Changed'))?.rejected,
      'UNRESOLVED_PRONOUN');
  });
  await test('18 generic speaker meta-language is rejected', async () => {
    assert.equal(hookMetaLanguageFree('The Speaker Explains Why This Market Failed'), false);
    const result = await packaging.create(base({ existingHooks: ['The Speaker Explains Why This Market Failed'] }));
    assert.equal(result.hookCandidates.find((hook) => /speaker/i.test(hook.text))?.rejected, 'META_LANGUAGE');
  });
  await test('19 humorous source permits humorous packaging candidates', async () => {
    const result = await packaging.create(base({ transcript:
      'The joke was ridiculous, the punchline was absurd, and everybody laughed.',
      title: 'The Ridiculous Punchline Everyone Remembered' }));
    assert(result.humor.detected); assert(result.hookCandidates.some((hook) =>
      hook.style === 'HUMOROUS' && !hook.rejected));
  });
  await test('20 non-humorous source does not force jokes', async () => {
    const result = await packaging.create(base());
    assert.equal(result.humor.detected, false);
    assert(result.hookCandidates.filter((hook) => hook.style === 'HUMOROUS')
      .every((hook) => Boolean(hook.rejected)));
    assert(result.hookCandidates.length >= 5);
    assert.notEqual(result.captions.youtubeShorts.toLowerCase(), result.selectedHook.text.toLowerCase());
    assert.equal(result.subtitleTemplate, 'PODCAST_BOLD');
    assert.equal(PODCAST_BOLD_STYLE.baselineFontPx, 72);
    assert.equal(PODCAST_BOLD_STYLE.outlinePx, 6);
    assert.equal(PODCAST_BOLD_STYLE.activeColor, '#FFD400');
  });
  await test('21 social-native hook critic outranks weak policy-memo wording', async () => {
    const weak = 'Housing policy may have turned homeownership into a much harder path to stability.';
    const strong = 'Housing Policy Made Homeownership Harder';
    const result = await packaging.create(base({ title: 'A New Housing Argument',
      transcript: 'Housing policy turned homeownership into a much harder path to stability and families now pay the cost.',
      synopsis: 'Housing policy made the path to stable homeownership harder.',
      existingHooks: [weak, strong] }));
    const weakScore = result.hookCandidates.find((hook) => hook.text === weak)?.score ?? 0;
    const strongScore = result.hookCandidates.find((hook) => hook.text === strong)?.score ?? 0;
    assert(strongScore > weakScore, `${strongScore} must beat ${weakScore}`);
  });
  await test('22 verified identities receive a grounded entity-led variant', async () => {
    const result = await packaging.create(base({ title: 'Maya Chen on Housing Costs',
      transcript: "I'm Maya Chen and housing policy made homeownership harder for local families.",
      synopsis: 'Maya Chen explains the cost of housing policy.', speakerTrackIds: ['spk-1'] }));
    assert(result.hookCandidates.some((hook) => hook.style === 'ENTITY_NAME_LED' &&
      /Maya Chen/u.test(hook.text) && !hook.rejected));
  });
  console.log(`${passed}/${passed} content-packaging scenarios passed`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
