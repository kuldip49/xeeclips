import { expect, test, type ConsoleMessage, type Response } from '@playwright/test';

const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
const PROJECT_ID = process.env.E2E_EXISTING_PROJECT_ID ?? 'd59ac331-4c6f-4d7d-b2b7-232b77c3c58f';
const VIDEO_ID = process.env.E2E_EXISTING_VIDEO_ID ?? 'd6cacb27-31eb-4aa7-a73a-c63cad76d085';
const EDIT_PROJECT_ID = process.env.E2E_EXISTING_EDIT_PROJECT_ID ?? 'ff9b36cc-64c6-4004-8009-56183b6ec090';

test('Results -> Edit shows and plays the real generated source', async ({ page, request }, testInfo) => {
  const failedResponses: Array<{ method: string; url: string; status: number; body: string }> = [];
  const failedRequests: Array<{ method: string; url: string; error: string }> = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const mediaResponses: Array<{ url: string; status: number; range?: string;
    contentRange?: string; length?: string }> = [];
  page.on('response', async (response: Response) => {
    if (response.url().includes('/file')) mediaResponses.push({ url: response.url(),
      status: response.status(), range: response.request().headers()['range'],
      contentRange: response.headers()['content-range'], length: response.headers()['content-length'] });
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

  const resultsResponse = await request.get(`${API}/videos/${VIDEO_ID}/clip-results`);
  expect(resultsResponse.ok()).toBeTruthy();
  const results = await resultsResponse.json() as { clips: Array<{ editProjectId?: string }> };
  const cardIndex = results.clips.findIndex((clip) => clip.editProjectId === EDIT_PROJECT_ID);
  expect(cardIndex).toBeGreaterThanOrEqual(0);

  await page.goto(`/projects/${PROJECT_ID}`);
  const cards = page.getByTestId('clip-result');
  await expect(cards.nth(cardIndex)).toBeVisible({ timeout: 60_000 });
  await cards.nth(cardIndex).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.waitForURL(new RegExp(`/edit-mode/${EDIT_PROJECT_ID}$`), { timeout: 60_000 });
  // Navigation legitimately aborts media ranges from the Results page. The P0
  // assertion starts once the editor owns the page.
  await page.waitForTimeout(1_000);
  failedResponses.length = 0; failedRequests.length = 0; consoleErrors.length = 0;
  pageErrors.length = 0; mediaResponses.length = 0;

  const video = page.getByTestId('edit-preview-video');
  const canvas = page.getByTestId('edit-preview-canvas');
  await expect(video).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(15_000);
  const initialMediaState = await video.evaluate((element: HTMLVideoElement) => ({
    readyState: element.readyState, networkState: element.networkState,
    width: element.videoWidth, height: element.videoHeight,
    error: element.error ? { code: element.error.code, message: element.error.message } : null }));
  console.log(JSON.stringify({ initialMediaState, editorMediaResponses: mediaResponses.length,
    failedResponses, failedRequests: failedRequests.filter((item) => item.error !== 'net::ERR_ABORTED'),
    consoleErrors, pageErrors }, null, 2));
  expect(initialMediaState.readyState).toBeGreaterThanOrEqual(2);
  expect(initialMediaState.width).toBeGreaterThan(0);
  expect(initialMediaState.height).toBeGreaterThan(0);
  expect(await video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox?.width).toBeGreaterThan(100);
  expect(canvasBox?.height).toBeGreaterThan(100);
  expect(await video.getAttribute('src')).toBe(`${API}/edit-mode/assets/cb89e4df-4ff4-48ab-8c9b-f6843735e2f1/file`);
  expect(await canvas.locator('[data-testid="preview-element"]').count()).toBeGreaterThan(0);

  const play = page.getByRole('button', { name: 'Play preview' });
  await play.click();
  await expect.poll(async () => video.evaluate((element: HTMLVideoElement) => element.currentTime),
    { timeout: 15_000 }).toBeGreaterThan(0.05);
  await page.getByRole('button', { name: 'Pause preview' }).click();
  await expect.poll(async () => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);

  const seek = page.getByLabel('Seek edited timeline');
  await seek.fill('20');
  await expect.poll(async () => video.evaluate((element: HTMLVideoElement) => element.currentTime),
    { timeout: 15_000 }).toBeCloseTo(20, 1);

  // One real manual command exercises the caption-heavy transaction and must
  // finish without the former P2028/Internal server error.
  const beforeManual = await (await request.get(`${API}/edit-mode/projects/${EDIT_PROJECT_ID}`)).json() as
    { revision: number };
  await page.getByRole('button', { name: 'Crop', exact: true }).click();
  await page.getByRole('group', { name: 'Crop aspect ratio' }).getByRole('button', { name: '1:1' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect.poll(async () => {
    const response = await request.get(`${API}/edit-mode/projects/${EDIT_PROJECT_ID}`);
    return ((await response.json()) as { revision: number }).revision;
  }, { timeout: 60_000 }).toBeGreaterThan(beforeManual.revision);
  await expect(page.getByText(/Internal server error/u)).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'AI Editor' })).toBeVisible();

  await page.reload();
  await expect(video).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => video.evaluate((element: HTMLVideoElement) => element.readyState),
    { timeout: 60_000 }).toBeGreaterThanOrEqual(2);

  // The AI editor applies a real deterministic caption edit to the same
  // canonical project, then a reload proves both the edit and media survive.
  await page.getByRole('tab', { name: 'AI Editor' }).click();
  const agent = page.getByTestId('agent-panel');
  await expect(agent).toBeVisible();
  const beforeAgent = await (await request.get(`${API}/edit-mode/projects/${EDIT_PROJECT_ID}`)).json() as
    { revision: number };
  await agent.getByLabel('Tell the AI editor what to change').fill('make captions larger');
  await agent.getByRole('button', { name: 'Edit with AI' }).click();
  const ledger = page.getByTestId('agent-ledger');
  await expect(ledger).toBeVisible({ timeout: 120_000 });
  await expect.poll(async () => {
    const response = await request.get(`${API}/edit-mode/projects/${EDIT_PROJECT_ID}`);
    return ((await response.json()) as { revision: number }).revision;
  }, { timeout: 120_000 }).toBeGreaterThan(beforeAgent.revision);
  await expect(ledger).not.toContainText(/Failed|not verified/u);
  const canonical = await (await request.get(`${API}/edit-mode/projects/${EDIT_PROJECT_ID}`)).json() as
    { revision: number };
  await page.reload();
  await expect(video).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => video.evaluate((element: HTMLVideoElement) => element.readyState),
    { timeout: 60_000 }).toBeGreaterThanOrEqual(2);

  // Export from the editor and require the current revision's QA to pass.
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Export video' }).click();
  await expect.poll(async () => {
    const response = await request.get(`${API}/edit-mode/projects/${EDIT_PROJECT_ID}/exports`);
    const exports = await response.json() as Array<{ sourceRevision: number; current: boolean;
      metadata?: { qa?: { result?: string } } }>;
    return exports.find((item) => item.current && item.sourceRevision === canonical.revision)
      ?.metadata?.qa?.result ?? null;
  }, { timeout: 10 * 60_000, intervals: [5_000] }).toBe('PASS');
  await page.screenshot({ path: testInfo.outputPath('p0-editor-preview.png') });

  expect({ failedResponses,
    failedRequests: failedRequests.filter((item) => item.error !== 'net::ERR_ABORTED'),
    consoleErrors, pageErrors }).toEqual({
    failedResponses: [], failedRequests: [], consoleErrors: [], pageErrors: []
  });
});

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
