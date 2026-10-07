const assert = require('node:assert/strict');
const { socialSource, socialPostContext } = require('../dist/modules/quick-reframe/social-source');
const { generatePostCopy, groundedCaption, normalizeHashtags, emptyPostCopy } = require('../dist/modules/quick-reframe/quick-reframe-post-copy');
const { QuickReframeService } = require('../dist/modules/quick-reframe/quick-reframe.service');
const { defaultPlan } = require('../dist/modules/quick-reframe/quick-reframe-plan');
const source = socialSource('https://www.instagram.com/reel/owned_video/?tracking=1');
const imported = socialPostContext({ description: 'Plan your garden. #Gardening #gardening #Soil', tags: ['Soil', 'PlantCare'], uploader: 'Owned fixture', title: 'Spring garden', url: 'SECRET_MEDIA', cookies: 'SECRET_COOKIE' }, source);
assert.equal(imported.sourcePostText, 'Plan your garden. #Gardening #gardening #Soil');
assert.deepEqual(imported.sourceHashtags, ['#Gardening', '#Soil', '#PlantCare']);
assert.equal(imported.sourcePostUrl, 'https://www.instagram.com/reel/owned_video/');
assert.ok(!JSON.stringify(imported).includes('SECRET'));
assert.equal(socialPostContext({}, source).sourcePostText, '');
assert.equal(socialPostContext({ description: 42, tags: [null, {}, '#ok'] }, socialSource('https://x.com/owned/status/123')).sourcePlatform, 'x');
assert.deepEqual(normalizeHashtags(['soil', '#Soil', '#bad tag', '#植物']), ['#Soil', '#植物']);
const actual = 'Healthy soil helps plants grow. Water the garden early to protect roots. Compost improves the soil.';
assert.equal(groundedCaption('Healthy soil guarantees 500 plants overnight!', actual, ''), false);
assert.equal(groundedCaption('Plan your garden.', actual, 'Plan your garden.'), false);
assert.equal(groundedCaption('Healthy soil helps plants grow.', actual, ''), true);
const context = { transcript: actual, visibleText: 'Compost and gardening', subtitleText: 'Protect plant roots', sourceContext: imported,
  selectedHook: 'Healthy soil helps plants grow', editingDirection: 'Practical gardening advice', purpose: 'New gardeners', selectedCaption: 'Compost improves soil' };
let requests = 0;
const router = { generate: async () => { requests++; throw new Error('AI unavailable'); } };
async function run() {
  const local = await generatePostCopy(router, context, false);
  assert.equal(requests, 0, 'no consent means zero OpenAI calls');
  assert.equal(local.generatedCaptions.length, 5);
  assert.equal(new Set(local.generatedCaptions.map(v => v.text)).size, 5);
  assert.equal(local.generatedCaptions.filter(c => c.recommended).length, 1);
  assert.deepEqual(local.generatedHashtagSets.map(s => s.label), ['Focused', 'Broad', 'Niche']);
  assert.ok(local.generatedHashtagSets.every(s => s.hashtags.length <= 8));
  const fallback = await generatePostCopy(router, context, true);
  assert.equal(requests, 1); assert.equal(fallback.generatedCaptions.length, 5); assert.match(fallback.warnings.join(' '), /unavailable/);
  const noVideo = await generatePostCopy(router, { ...context, transcript: '', visibleText: '', subtitleText: '' }, true);
  assert.equal(noVideo.generatedCaptions.length, 0); assert.equal(requests, 1, 'original caption alone must never drive copy');
  let sent;
  const aiRouter = { generate: async ({ request }) => { sent = JSON.parse(request.userPrompt); return { data: {
    captions: [{ style: 'Bold', text: 'Healthy soil grows 500 plants overnight!' }],
    hashtagSets: [{ label: 'Focused', hashtags: ['#Gardening', '#soil', '#plants', '#Crypto', '#Viral'] }], understanding: local.understanding } }; } };
  const rewritten = await generatePostCopy(aiRouter, context, true, 'Stronger opening');
  assert.equal(sent.rewriteOriginal, 'Stronger opening'); assert.ok(!('sourcePostUrl' in sent)); assert.ok(!('sourceAuthor' in sent));
  assert.ok(!JSON.stringify(sent).includes('SECRET'));
  assert.ok(!rewritten.generatedCaptions.some(c => /500/u.test(c.text)));
  assert.ok(!rewritten.generatedHashtagSets.some(s => s.hashtags.includes('#Crypto') || s.hashtags.includes('#Viral')));
  const service = Object.create(QuickReframeService.prototype);
  const plan = defaultPlan(); plan.crop = { x: 0, y: .4, w: 1, h: .6 };
  const q = { id: 'fixture', editPath: 'MANUAL', status: 'EDITING', operationId: null, postCopy: {}, sourceContext: imported, plan, confirmed: plan,
    analysis: { regions: [
      { x: .2, y: .1, w: .5, h: .1, kind: 'DECORATIVE', text: 'EXCLUDED PROMO', confidence: .9, start: 0, end: 10 },
      { x: .2, y: .7, w: .5, h: .1, kind: 'CAPTION', text: 'Kept roots', confidence: .9, start: 0, end: 10 },
      { x: .2, y: .7, w: .5, h: .1, kind: 'CAPTION', text: 'Trimmed speech', confidence: .9, start: 15, end: 20 }
    ] }, editProject: { revision: 4, assets: [{ id: 'source', role: 'SOURCE', metadata: { quickReframeKey: require('../dist/modules/quick-reframe/quick-reframe-render').preparationFingerprint(require('../dist/modules/quick-reframe/quick-reframe-plan').preparationOf(plan)) }, duration: 20,
      transcript: { segments: [{ start: 0, end: 8, text: actual }, { start: 15, end: 20, text: 'EXCLUDED TRANSCRIPT' }] } }],
      elements: [{ type: 'VIDEO', assetId: 'source', trimStart: 0, trimEnd: 10, duration: 10, properties: {} }, { type: 'TEXT', properties: { presetRole: 'HOOK', content: 'Healthy soil' } }] } };
  const filtered = service.postCopyContext(q, {});
  assert.ok(!filtered.visibleText.includes('EXCLUDED')); assert.ok(!filtered.transcript.includes('EXCLUDED'));
  assert.equal(filtered.subtitleText, 'Kept roots'); assert.equal(filtered.selectedHook, 'Healthy soil');
  service.load = async () => q;
  q.editPath = null;
  await assert.rejects(service.generateCopy('fixture', { revision: 4, version: 0 }), /Choose StyleOne/);
  q.editPath = 'MANUAL'; service.cropConfirmed = () => false;
  await assert.rejects(service.generateCopy('fixture', { revision: 4, version: 0 }), /Confirm the crop/);
  await assert.rejects(service.hooks('fixture', {}), /Confirm the crop/, 'cached hook analysis cannot authorize OpenAI during re-crop');
  service.cropConfirmed = () => true;
  await assert.rejects(service.saveCopy('fixture', { revision: 4, version: 1, selectedCaption: '', selectedHashtags: [] }), /Post copy changed/);
  let written;
  service.prisma = { quickReframe: { updateMany: async ({ data }) => { written = data; return { count: 1 }; } } };
  service.get = async () => written;
  await service.saveCopy('fixture', { revision: 4, version: 0, selectedCaption: 'My garden', selectedHashtags: ['Soil'] });
  assert.deepEqual(Object.keys(written), ['postCopy'], 'copy saves do not touch media, revision, credits or exports');
  assert.equal(written.postCopy.version, 1); assert.equal(written.postCopy.selectedCaption, 'My garden');
  q.postCopy = { ...emptyPostCopy(), generatedCaptions: [{ style: 'Concise', text: 'Original suggestion', recommended: true }] };
  await service.saveCopy('fixture', { revision: 4, version: 0, selectedCaption: 'Edited suggestion', selectedHashtags: ['Soil'], captionStyle: 'Concise' });
  assert.equal(written.postCopy.generatedCaptions[0].text, 'Edited suggestion', 'an edited variant persists as well as the selected caption');
  service.prisma.quickReframe.updateMany = async () => ({ count: 0 });
  await assert.rejects(service.saveCopy('fixture', { revision: 4, version: 0, selectedCaption: '', selectedHashtags: [] }), /changed/);
  console.log('Quick Reframe post copy: import metadata, missing metadata, video grounding, AI consent/fallback, rewrite, crop/trim filtering, version conflicts and media separation passed.');
}
run().catch(e => { console.error(e); process.exitCode = 1; });
