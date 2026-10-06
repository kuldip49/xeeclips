import { expect, test, type APIRequestContext, type ConsoleMessage, type Response } from '@playwright/test';
import { cleanupSession, createSessionViaUi, expectExportBackdrop, SOURCE, waitForClips } from './support/disposable';

const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
const PROJECT_ID = process.env.E2E_EXISTING_PROJECT_ID ?? 'd59ac331-4c6f-4d7d-b2b7-232b77c3c58f';
const VIDEO_ID = process.env.E2E_EXISTING_VIDEO_ID ?? 'd6cacb27-31eb-4aa7-a73a-c63cad76d085';
const EDIT_PROJECT_ID = process.env.E2E_EXISTING_EDIT_PROJECT_ID ?? 'ff9b36cc-64c6-4004-8009-56183b6ec090';

// Runs on its own disposable session (E2E_SOURCE): it crops, AI-edits and exports, so it must
// never touch an existing project.
test('Results -> Edit shows and plays the real generated source', async ({ page, request }, testInfo) => {
  test.skip(!SOURCE, 'Set E2E_SOURCE to a short video with speech (it is uploaded and then deleted)');
  const choice = { mode: 'FALLBACK_ONLY', template: 'AUTOMATIC_1', count: 1 } as const;
  let projectId: string | null = null;
  try {
    const session = await createSessionViaUi(page, choice);
    projectId = session.projectId;
    const { results } = await waitForClips(request, projectId, choice);
    const clip = results.clips[0];

    const failedResponses: Array<{ method: string; url: string; status: number; body: string }> = [];
    const failedRequests: Array<{ method: string; url: string; error: string }> = [];
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('response', async (response: Response) => {
      if (response.status() < 400) return;
      failedResponses.push({ method: response.request().method(), url: response.url(),
        status: response.status(), body: (await response.text().catch(() => '')).slice(0, 500) });
    });
    page.on('requestfailed', (requestItem) => failedRequests.push({ method: requestItem.method(),
      url: requestItem.url(), error: requestItem.failure()?.errorText ?? 'unknown' }));
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(`${message.text()} @ ${JSON.stringify(message.location())}`);
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const card = page.getByTestId('clip-result').first();
    await expect(card).toBeVisible({ timeout: 120_000 });
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.waitForURL(/\/edit-mode\/[0-9a-f-]{36}$/u, { timeout: 120_000 });
    const editId = new URL(page.url()).pathname.split('/').pop()!;
    // Navigation legitimately aborts media ranges from the Results page. The P0
    // assertion starts once the editor owns the page.
    await page.waitForTimeout(1_000);
    failedResponses.length = 0; failedRequests.length = 0; consoleErrors.length = 0; pageErrors.length = 0;

    const video = page.getByTestId('edit-preview-video');
    const canvas = page.getByTestId('edit-preview-canvas');
    await expect(video).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(2);
    const media = await video.evaluate((element: HTMLVideoElement) => ({ width: element.videoWidth,
      height: element.videoHeight, src: element.currentSrc }));
    expect(media.width).toBeGreaterThan(0);
    expect(media.height).toBeGreaterThan(0);
    expect(media.src).toMatch(new RegExp(`^${API}/edit-mode/assets/[0-9a-f-]{36}/file$`, 'u'));
    await expectRangedVideo(request, media.src);
    await expectExportBackdrop(page);
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox?.width).toBeGreaterThan(100);
    expect(canvasBox?.height).toBeGreaterThan(100);
    expect(await canvas.locator('[data-testid="preview-element"]').count()).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Play preview' }).click();
    await expect.poll(async () => video.evaluate((element: HTMLVideoElement) => element.currentTime),
      { timeout: 15_000 }).toBeGreaterThan(0.05);
    await page.getByRole('button', { name: 'Pause preview' }).click();
    await expect.poll(async () => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
    const seekTo = Math.min(10, Math.floor(clip.durationSec / 2));
    await page.getByLabel('Seek edited timeline').fill(String(seekTo));
    await expect.poll(async () => video.evaluate((element: HTMLVideoElement) => element.currentTime),
      { timeout: 15_000 }).toBeGreaterThan(0.5);

    // One real manual command (crop 1:1) must persist as a new revision.
    const revision = async () => ((await (await request.get(`${API}/edit-mode/projects/${editId}`)).json()) as
      { revision: number }).revision;
    const beforeManual = await revision();
    await page.getByRole('button', { name: 'Crop', exact: true }).click();
    await page.getByRole('group', { name: 'Crop aspect ratio' }).getByRole('button', { name: '1:1' }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect.poll(revision, { timeout: 60_000 }).toBeGreaterThan(beforeManual);
    await expect(page.getByText(/Internal server error/u)).toHaveCount(0);

    await page.reload();
    await expect(video).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => video.evaluate((element: HTMLVideoElement) => element.readyState),
      { timeout: 60_000 }).toBeGreaterThanOrEqual(2);

    // The AI editor applies a real caption edit to the same canonical project.
    await page.getByRole('tab', { name: 'AI Editor' }).click();
    await page.getByTestId('ask-ai-consent').getByRole('button', { name: 'Allow Ask AI' }).click();
    const agent = page.getByTestId('agent-panel');
    await expect(agent).toBeVisible();
    const beforeAgent = await revision();
    await agent.getByLabel('Tell the AI editor what to change').fill('make captions larger');
    await agent.getByRole('button', { name: 'Edit with AI' }).click();
    const ledger = page.getByTestId('agent-ledger');
    await expect(ledger).toBeVisible({ timeout: 180_000 });
    await expect.poll(revision, { timeout: 120_000 }).toBeGreaterThan(beforeAgent);
    await expect(ledger).not.toContainText(/Failed|not verified/u);
    const canonical = await revision();
    await page.reload();
    await expect(video).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => video.evaluate((element: HTMLVideoElement) => element.readyState),
      { timeout: 60_000 }).toBeGreaterThanOrEqual(2);

    // Export from the editor and require the current revision's QA to pass.
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: 'Export video' }).click();
    await expect.poll(async () => {
      const response = await request.get(`${API}/edit-mode/projects/${editId}/exports`);
      const exports = await response.json() as Array<{ sourceRevision: number; current: boolean;
        metadata?: { qa?: { result?: string } } }>;
      return exports.find((item) => item.current && item.sourceRevision === canonical)
        ?.metadata?.qa?.result ?? null;
    }, { timeout: 10 * 60_000, intervals: [5_000] }).toBe('PASS');
    await page.screenshot({ path: testInfo.outputPath('p0-editor-preview.png') });

    expect({ failedResponses,
      failedRequests: failedRequests.filter((item) => item.error !== 'net::ERR_ABORTED'),
      consoleErrors, pageErrors }).toEqual({
      failedResponses: [], failedRequests: [], consoleErrors: [], pageErrors: []
    });
  } finally {
    await cleanupSession(request, projectId);
  }
});

async function expectRangedVideo(request: APIRequestContext, url: string) {
  const response = await request.get(url, { headers: { Range: 'bytes=0-1023' } });
  expect(response.status(), url).toBe(206);
  expect(response.headers()['content-type']).toMatch(/^video\//u);
}

test('media endpoint serves browser ranges and rejects unsatisfiable ranges', async ({ request }) => {
  const url = `${API}/edit-mode/assets/80ee052c-117f-4153-a7d2-c290297554ea/file`;
  const first = await request.get(url, { headers: { Range: 'bytes=0-1023' } });
  expect(first.status()).toBe(206);
  expect(first.headers()['accept-ranges']).toBe('bytes');
  expect(first.headers()['content-range']).toBe('bytes 0-1023/121519050');
  expect(first.headers()['content-length']).toBe('1024');
  expect(first.headers()['content-type']).toContain('video/mp4');
  const suffix = await request.get(url, { headers: { Range: 'bytes=-1024' } });
  expect(suffix.status()).toBe(206);
  expect(suffix.headers()['content-range']).toBe('bytes 121518026-121519049/121519050');
  const invalid = await request.get(url, { headers: { Range: 'bytes=999999999-' } });
  expect(invalid.status()).toBe(416);
  expect(invalid.headers()['content-range']).toBe('bytes */121519050');
  expect(await invalid.json()).toMatchObject({ code: 'MEDIA_RANGE_NOT_SATISFIABLE' });
});

test('generation style preview keeps the uploaded source visible under live overlays', async ({ page }) => {
  const failedResponses: Array<{ method: string; url: string; status: number }> = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failedResponses.push({
      method: response.request().method(), url: response.url(), status: response.status()
    });
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`/projects/${PROJECT_ID}`);
  const preview = page.getByTestId('style-preview');
  const source = page.getByLabel('Your source video style preview');
  await expect(preview).toBeVisible({ timeout: 60_000 });
  await expect(source).toBeVisible();
  await expect(source).toHaveAttribute('src', `${API}/videos/${VIDEO_ID}/file`);
  await expect(source).toHaveAttribute('poster', `${API}/videos/${VIDEO_ID}/poster`);
  await expect(source).toHaveAttribute('preload', 'none');

  const componentMix = page.locator('details').filter({ hasText: 'Mix individual styles' });
  if (!(await componentMix.getAttribute('open'))) await componentMix.locator('summary').click();
  await page.locator('select[data-component="BACKGROUND"]').selectOption('BG_BLACK');
  await page.locator('select[data-component="HOOK"]').selectOption('HOOK_CLEAN');
  await page.locator('select[data-component="CAPTIONS"]').selectOption('CAP_CLEAN_LOWER_THIRD');
  await page.getByTestId('creative-brief').fill(
    "Make it professional. Background black. Clean normal hook. Simple captions. Don't over-edit."
  );
  await expect.poll(async () => preview.getAttribute('data-loading'), { timeout: 30_000 }).toBe('false');
  await expect(page.getByTestId('style-preview-hook')).toBeVisible();
  await expect(page.getByTestId('style-preview-captions')).toBeVisible();
  expect(await preview.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(0, 0, 0)');
  await expect(source).toBeVisible();
  expect({ failedResponses, consoleErrors, pageErrors }).toEqual({
    failedResponses: [], consoleErrors: [], pageErrors: []
  });
});

test('final exact editor composition is visible', async ({ page }, testInfo) => {
  await page.goto(`/edit-mode/${EDIT_PROJECT_ID}`);
  const video = page.getByTestId('edit-preview-video');
  await expect(video).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => video.evaluate((element: HTMLVideoElement) => ({
    readyState: element.readyState, width: element.videoWidth, height: element.videoHeight
  })), { timeout: 60_000 }).toEqual({ readyState: 4, width: 1080, height: 1920 });
  await expect(page.getByTestId('edit-preview-canvas').getByText(
    'The traditional college formula no longer looks as simple as it once did.'
  )).toBeVisible();
  await expect(page.getByTestId('edit-preview-canvas').getByText('Why?')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('p0-current-final.png') });
});
