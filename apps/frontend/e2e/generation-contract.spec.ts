import { expect, test, type APIRequestContext } from '@playwright/test';

const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
const PROJECT_ID = process.env.E2E_GENERATION_PROJECT_ID ?? '6428a8e4-967c-47b3-86c2-825e1828f46f';
const VIDEO_ID = process.env.E2E_GENERATION_VIDEO_ID ?? 'f3e42210-7f74-4ca0-9f19-357a6fa1de11';

type Json = Record<string, any>;
async function json(request: APIRequestContext, path: string): Promise<Json> {
  const response = await request.get(`${API}${path}`);
  expect(response.ok(), `${path} -> ${response.status()}`).toBeTruthy();
  return response.json();
}

async function waitForFinal(request: APIRequestContext) {
  const deadline = Date.now() + 42 * 60 * 1000;
  let result = await json(request, `/videos/${VIDEO_ID}/clip-results`);
  while (!['COMPLETE', 'PARTIAL', 'FAILED'].includes(result.deliveryStatus)) {
    if (Date.now() > deadline) throw new Error(`Generation timed out: ${JSON.stringify(result).slice(0, 500)}`);
    await new Promise((resolve) => setTimeout(resolve, 8000));
    result = await json(request, `/videos/${VIDEO_ID}/clip-results`);
  }
  return result;
}

test('Automatic 2 + 8 persists, returns asynchronously, reloads, and delivers eight', async ({ page, request }) => {
  await page.goto(`/projects/${PROJECT_ID}`);
  await expect(page.getByRole('heading', { name: 'Create clips' })).toBeVisible({ timeout: 120_000 });
  let accepted = await json(request, `/videos/${VIDEO_ID}/clip-analysis`);
  const matchingRequest = accepted.clipRequest?.requestedClipCount === 8 &&
    accepted.clipRequest?.requestedTemplate === 'AUTOMATIC_2' &&
    ['QUEUED', 'RENDERING', 'COMPLETED'].includes(accepted.clipRequest?.status);
  if (!matchingRequest) {
    await page.locator("label[data-look='AUTOMATIC_2']").click();
    const create = page.getByRole('button', { name: /^Create \d+ Clips?$/ });
    while (!/^Create 8 Clips$/u.test((await create.textContent())?.trim() ?? ''))
      await page.getByRole('button', { name: 'More clips' }).click();

    const requestPromise = page.waitForRequest((candidate) =>
      candidate.method() === 'POST' && candidate.url().endsWith(`/videos/${VIDEO_ID}/clip-selection`));
    const started = Date.now();
    await create.click();
    const generationRequest = await requestPromise;
    const response = await generationRequest.response();
    expect(response?.ok()).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(generationRequest.postDataJSON()).toMatchObject({
      requestedClipCount: 8,
      outputStyle: 'AI_EDITED',
      generation: { templateId: 'AUTOMATIC_2', look: 'AUTOMATIC_2' }
    });
    accepted = await json(request, `/videos/${VIDEO_ID}/clip-analysis`);
  }

  expect(accepted.clipRequest).toMatchObject({ requestedClipCount: 8,
    requestedTemplate: 'AUTOMATIC_2', effectiveTemplate: 'AUTOMATIC_2' });
  expect(['QUEUED', 'RENDERING', 'COMPLETED']).toContain(accepted.clipRequest.status);

  await page.reload();
  await expect(page.locator("input[value='AUTOMATIC_2']")).toBeChecked({ timeout: 60_000 });
  await expect(page.getByText(/Rendering clip|generated/u).first()).toBeVisible({ timeout: 60_000 });

  const result = await waitForFinal(request);
  expect(result).toMatchObject({ deliveryStatus: 'COMPLETE', requestedClipCount: 8,
    deliveredClipCount: 8, requestedTemplate: 'AUTOMATIC_2', effectiveTemplate: 'AUTOMATIC_2' });
  expect(result.clips).toHaveLength(8);
  expect(result.clips.every((clip: Json) => clip.templateId === 'AUTOMATIC_2' &&
    clip.generationJobId && clip.requestedClipIndex >= 1 && clip.requestedClipIndex <= 8 &&
    ['EXPORT_READY', 'READY'].includes(clip.style?.status))).toBeTruthy();

  await page.reload();
  await expect(page.getByTestId('clip-result')).toHaveCount(8, { timeout: 120_000 });
  await expect(page.getByText('8 of 8 clips generated.')).toBeVisible();
});
