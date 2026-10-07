import { test, expect, type Page } from '@playwright/test';
const now = new Date().toISOString();
const original = { sourcePlatform: 'instagram', sourcePostUrl: 'https://instagram.com/reel/owned/', sourcePostText: 'Original garden advice. #Garden', sourceHashtags: ['#Garden'] };
const postCopy = { version: 0, generatedCaptions: [], generatedHashtagSets: [], selectedCaption: '', selectedHashtags: [] };
const analysis = { regions: [], frames: [], boundaries: [], subtitleState: 'MISSING', warnings: [], bars: { top: 0, bottom: 0, left: 0, right: 0 } };
const base = { id: 'copy-fixture', editProjectId: 'project-fixture', revision: 4, name: 'owned.mp4', duration: 30, width: 720, height: 1280, originalUrl: '/fixture.mp4', sourceUrl: '/fixture.mp4', sourceWidth: 720, sourceHeight: 1280,
  cropConfirmed: true, confirmed: { aspect: 'SOURCE', crop: { x: 0, y: 0, w: 1, h: 1 }, framing: 'CROP', cleanup: [], denoise: false }, editPath: 'STYLEONE', styleOneApplied: true,
  previewUrl: '/fixture.mp4', previewRevision: 4, exportUrl: null, exportRevision: null, exports: [], status: 'STYLED', progress: 100, message: '', error: null, analysis, plan: null, hooks: [],
  outputs: {720: { width: 720, height: 1280 }, 1080: { width: 1080, height: 1920 }}, hasAudio: true, hasTranscript: true, captionCount: 0, createdAt: now, sourceContext: original, postCopy };
async function serve(page: Page, overrides: Record<string, unknown> = {}) {
  let current: any = { ...base, ...overrides, postCopy: { ...postCopy } }; const calls: any[] = [];
  await page.addInitScript(() => { (window as any).copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { (window as any).copied.push(text); } } }); });
  await page.route('**/auth/session', r => r.fulfill({ json: { id: 'qa', email: 'qa@example.com', displayName: 'QA', role: 'ADMIN', creditBalance: 5, creditsConsumed: 0, aiProcessingConsentAt: now } }));
  await page.route('**/fixture.mp4', r => r.fulfill({ status: 204, body: '' }));
  await page.route(/\/quick-reframe\/(?:copy-fixture|history|project\/project-fixture)(?:\/[^?]*)?(?:\?.*)?$/, async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname.endsWith('/post-copy')) {
      const body = req.postDataJSON(); calls.push({ method: req.method(), body });
      if (req.method() === 'PUT') current = { ...current, postCopy: { ...current.postCopy, version: current.postCopy.version + 1, selectedCaption: body.selectedCaption, selectedHashtags: body.selectedHashtags,
        generatedCaptions: current.postCopy.generatedCaptions.map((c: any) => c.style === body.captionStyle ? { ...c, text: body.selectedCaption } : c) } };
      else current = { ...current, postCopy: { ...current.postCopy, version: current.postCopy.version + 1, contextRevision: 4, selectedCaption: current.postCopy.selectedCaption || 'Healthy soil helps plants grow.', selectedHashtags: ['#soil', '#garden'],
        generatedCaptions: ['Concise', 'Engaging', 'Professional', 'Conversational', 'Bold'].map((style, i) => ({ style, text: `${style}: Healthy soil helps plants grow.`, recommended: i === 0 })),
        generatedHashtagSets: ['Focused', 'Broad', 'Niche'].map(label => ({ label, hashtags: ['#soil', '#garden', '#plants'] })) } };
      return route.fulfill({ json: req.method() === 'PUT' ? current : { session: current, warnings: [] } });
    }
    if (url.pathname.endsWith('/history')) return route.fulfill({ json: [{ ...current, exports: [{ id: 'export', url: '/fixture.mp4', current: true, width: 1080, height: 1920, duration: 30, createdAt: now }] }] });
    return route.fulfill({ json: current });
  });
  await page.route('**/history/clips', r => r.fulfill({ json: [] }));
  const project = { id: 'project-fixture', name: 'Owned garden video', status: 'READY', settings: { feature: 'QUICK_REFRAME', aspectRatio: 'SOURCE' }, revision: 4, assets: [], elements: [], createdAt: now, updatedAt: now };
  await page.route('**/edit-mode/projects/project-fixture**', r => r.fulfill({ json: r.request().url().endsWith('/history') ? [] : project }));
  return { calls, current: () => current };
}
test.describe.configure({ timeout: 60000 });
for (const width of [375, 390, 1280]) test(`social copy edits, rewrite, hashtag controls and History restore at ${width}px`, async ({ page }) => {
  const fixture = await serve(page); await page.setViewportSize({ width, height: 900 });
  await page.goto('/quick-reframe?video=copy-fixture&step=edit');
  const panel = page.getByTestId('post-copy-panel'); await expect(panel).toBeVisible();
  await panel.getByText('Original post caption & hashtags', { exact: true }).click(); await expect(panel.getByText(original.sourcePostText)).toBeVisible();
  await panel.getByRole('button', { name: 'Generate social copy', exact: true }).click();
  await expect(panel.getByText('Recommended', { exact: true })).toBeVisible();
  expect(fixture.calls[0].body.externalAiAuthorized).toBe(false);
  for (const style of ['Concise', 'Engaging', 'Professional', 'Conversational', 'Bold']) await expect(panel.getByLabel(`${style} social caption`, { exact: true })).toBeVisible();
  await panel.getByLabel('Engaging social caption', { exact: true }).fill('My editable soil advice.');
  await panel.locator('article').filter({ has: page.getByLabel('Engaging social caption', { exact: true }) }).getByRole('button', { name: 'Use', exact: true }).click();
  await expect(panel.getByLabel('Selected Social Caption', { exact: true })).toHaveValue('My editable soil advice.');
  await expect(panel.getByLabel('Engaging social caption', { exact: true })).toHaveValue('My editable soil advice.');
  await panel.getByRole('button', { name: 'Use Niche', exact: true }).click();
  await panel.getByRole('button', { name: 'Remove #plants', exact: true }).click();
  await panel.getByLabel('Add hashtag', { exact: true }).fill('#compost'); await panel.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Remove #compost', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Copy Caption + Hashtags', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).copied.at(-1))).toBe('My editable soil advice.\n\n#soil #garden #compost');
  await panel.getByLabel('Rewrite direction', { exact: true }).selectOption('Stronger opening');
  await panel.getByRole('checkbox').check(); await panel.getByRole('button', { name: 'Rewrite original', exact: true }).click();
  await expect.poll(() => fixture.calls.at(-1)?.body.rewrite).toBe('Stronger opening');
  expect(fixture.calls.at(-1).body.externalAiAuthorized).toBe(true);
  await panel.getByRole('button', { name: 'Generate hashtags', exact: true }).click();
  await expect.poll(() => fixture.calls.filter(c => c.method === 'POST').length).toBe(3);
  expect(fixture.calls.at(-1).body.hashtagsOnly).toBe(true);
  await page.reload(); await expect(panel.getByLabel('Selected Social Caption', { exact: true })).toHaveValue('My editable soil advice.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `../../storage/reframe-post-copy-qa/copy-${width}.png`, fullPage: true });
  await page.goto('/quick-reframe?video=copy-fixture&step=export'); await expect(panel).toBeVisible();
  await page.goto('/history'); const history = page.getByTestId('quick-reframe-history-item'); await expect(history).toBeVisible();
  await history.getByRole('button', { name: 'Copy Caption', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).copied.at(-1))).toBe('My editable soil advice.');
  expect(fixture.current().revision).toBe(4);
});
test('missing post text continues; local uploads have no Original section', async ({ page }) => {
  await serve(page, { sourceContext: { ...original, sourcePostText: '', sourceHashtags: [] } });
  await page.goto('/quick-reframe?video=copy-fixture&step=export');
  await page.getByText('Original post caption & hashtags', { exact: true }).click();
  await expect(page.getByText("Post text wasn't available. XeeClip can still generate a new caption from the video.")).toBeVisible();
  await page.getByRole('button', { name: 'Generate social copy', exact: true }).click();
  await expect(page.getByText('Recommended', { exact: true })).toBeVisible();
  await page.unroute(/\/quick-reframe\/(?:copy-fixture|history|project\/project-fixture)(?:\/[^?]*)?(?:\?.*)?$/); await serve(page, { sourceContext: null }); await page.reload();
  await expect(page.getByText('Original post caption & hashtags', { exact: true })).toHaveCount(0);
});
for (const width of [375, 390, 1280]) test(`Manual canonical editor exposes separate social copy tool at ${width}px`, async ({ page }) => {
  await serve(page, { editPath: 'MANUAL', styleOneApplied: false }); await page.setViewportSize({ width, height: 900 });
  await page.goto('/edit-mode/project-fixture?tool=post-copy');
  await expect(page.getByTestId('post-copy-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Generate social copy', exact: true }).click();
  await expect(page.getByText('Recommended', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `../../storage/reframe-post-copy-qa/manual-${width}.png`, fullPage: true });
});
