// Disposable creation sessions for browser E2E: the browser performs the user's steps, the API is
// only read to wait for state, and cleanup removes exactly what the test created - its own
// project (identified by id AND the e2e name prefix), videos, clips, edit projects and objects.
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
/** A short video with clear speech that you are allowed to upload (it is deleted afterwards). */
export const SOURCE = process.env.E2E_SOURCE ?? '';
export const DISPOSABLE_PREFIX = 'e2e-disposable-';

type Json = Record<string, any>;

export async function getJson(request: APIRequestContext, path: string): Promise<Json> {
  const response = await request.get(`${API}${path}`);
  expect(response.ok(), `${path} -> ${response.status()}`).toBeTruthy();
  return response.json();
}

export async function waitUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, minutes: number,
  everyMs = 5000): Promise<T> {
  const deadline = Date.now() + minutes * 60_000;
  let value = await read();
  while (!done(value)) {
    if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(value).slice(0, 400)}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
    value = await read();
  }
  return value;
}

/** Wait until the client router has hydrated, so the first clicks are not lost. */
export async function ready(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
  await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' }).catch(() => undefined);
}

export type SessionChoice = { mode: 'FALLBACK_ONLY' | 'ONLINE'; template: 'AUTOMATIC_1' | 'AUTOMATIC_2' | 'AUTOMATIC_RAW';
  count: number };

/**
 * Upload -> mode -> style -> count -> Generate from the home page, exactly as a user does.
 * Returns the creation session's project id (taken from the URL the app navigates to).
 */
export async function createSessionViaUi(page: Page, choice: SessionChoice) {
  const name = `${DISPOSABLE_PREFIX}${Date.now()}`;
  await page.goto('/');
  await ready(page);
  const form = page.getByRole('form', { name: 'Generate clips' });
  await expect(form).toBeVisible();
  // Create opens on the YouTube tab when importing is enabled; the file input lives on the other tab.
  const uploadTab = form.getByRole('tab', { name: 'Upload file' });
  if (await uploadTab.getAttribute('aria-selected') !== 'true') await uploadTab.click();
  await form.locator('input#file').setInputFiles({ name: `${name}.mp4`, mimeType: 'video/mp4',
    buffer: readFileSync(SOURCE) });
  await expect(form.getByText(`${name}.mp4`)).toBeVisible();
  await form.locator(`label[data-entry-template="${choice.template}"]`).click();
  await expect(form.locator(`input[value="${choice.template}"]`)).toBeChecked();
  await form.locator(`label[data-entry-mode="${choice.mode}"]`).click();
  const counter = form.getByTestId('entry-clip-count');
  while (Number(await counter.textContent()) > choice.count) await form.getByRole('button', { name: 'Fewer clips' }).click();
  while (Number(await counter.textContent()) < choice.count) await form.getByRole('button', { name: 'More clips' }).click();
  const label = `Generate ${choice.count} Clip${choice.count === 1 ? '' : 's'}`;
  await form.getByRole('button', { name: label }).click();
  await page.waitForURL(/\?session=[0-9a-f-]{36}/u, { timeout: 5 * 60_000 });
  const projectId = new URL(page.url()).searchParams.get('session')!;
  return { projectId, name };
}

/** Wait for analysis and delivery; for StyleOne also for every styled export. */
export async function waitForClips(request: APIRequestContext, projectId: string, choice: SessionChoice) {
  const videos = await waitUntil(() => getJson(request, `/videos?projectId=${projectId}`),
    (list) => Array.isArray(list) && ['COMPLETED', 'FAILED'].includes(list[0]?.processingJobs?.[0]?.status), 30) as unknown as Json[];
  expect(videos[0].processingJobs[0].status, 'analysis').toBe('COMPLETED');
  const videoId = videos[0].id as string;
  const results = await waitUntil(() => getJson(request, `/videos/${videoId}/clip-results`),
    (value) => ['COMPLETE', 'PARTIAL', 'FAILED'].includes(value.deliveryStatus) &&
      (choice.template !== 'AUTOMATIC_2' || (value.clips ?? []).every((clip: Json) =>
        clip.style?.playbackUrl || ['STYLE_FAILED', 'FAILED'].includes(clip.style?.status))), 30);
  expect(results.deliveryStatus, results.error).toBe('COMPLETE');
  expect(results.clips).toHaveLength(choice.count);
  return { videoId, results };
}

/**
 * Remove everything a disposable session created. Refuses any project not named by this helper,
 * or - for a session the app named itself (a YouTube import) - not carrying exactly that name.
 */
export async function cleanupSession(request: APIRequestContext, projectId: string | null, exactName?: string) {
  if (!projectId || !/^[0-9a-f-]{36}$/u.test(projectId)) return;
  const project = await request.get(`${API}/projects/${projectId}`).then((r) => r.ok() ? r.json() : null).catch(() => null);
  const name = String(project?.name ?? '');
  if (!project || (exactName ? name !== exactName : !name.startsWith(DISPOSABLE_PREFIX))) return;
  for (const video of project.videos ?? []) {
    const results = await request.get(`${API}/videos/${video.id}/clip-results`).then((r) => r.ok() ? r.json() : null)
      .catch(() => null);
    // Deleting a clip also removes its thumbnail, edit project and that project's own assets.
    for (const clip of results?.clips ?? []) await request.delete(`${API}/generated-clips/${clip.id}`).catch(() => undefined);
    await request.delete(`${API}/videos/${video.id}`).catch(() => undefined);
  }
  const sql = `DELETE FROM "Project" WHERE id = '${projectId}' AND name = '${name.replace(/'/gu, "''")}'`;
  try {
    execFileSync(process.env.E2E_DOCKER_BINARY ?? 'docker', ['exec', 'ai-content-postgres', 'psql', '-U', 'postgres',
      '-d', 'ai_content_platform', '-c', sql]);
  } catch { /* best effort: the row is empty and named as disposable */ }
}

/** The preview canvas shows the same backdrop the export draws: black unless the source is fitted,
 * then the fit background (white, black, or the blur stand-in). */
export async function expectExportBackdrop(page: Page) {
  const canvas = page.getByTestId('edit-preview-canvas');
  const expected: Record<string, string> = { NONE: 'rgb(0, 0, 0)', BLACK: 'rgb(0, 0, 0)',
    WHITE: 'rgb(255, 255, 255)', BLUR: 'rgb(38, 43, 54)' };
  const mode = await canvas.getAttribute('data-fit-background');
  expect(Object.keys(expected)).toContain(mode);
  await expect(canvas).toHaveCSS('background-color', expected[mode!]);
}
