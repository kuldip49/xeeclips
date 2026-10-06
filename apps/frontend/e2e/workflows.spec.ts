// Complete user journeys against the live stack, with disposable data only.
//
//   E2E_SOURCE=<short video with speech you may upload> npx playwright test e2e/workflows.spec.ts
//   (optional) E2E_YOUTUBE_URL=<a public video you are authorised to import>
//
// The browser performs every user action; the API is read only to wait for state, and afterAll
// removes the projects, videos, clips, edit projects and objects these tests created. Existing
// user content is never opened for editing or deleted.
import { expect, request as requestFactory, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, SOURCE, cleanupSession, createSessionViaUi, expectExportBackdrop, getJson, ready, waitForClips, waitUntil,
  type SessionChoice } from './support/disposable';

const YOUTUBE_URL = process.env.E2E_YOUTUBE_URL ?? '';
const FREE: SessionChoice = { mode: 'FALLBACK_ONLY', template: 'AUTOMATIC_1', count: 2 };
const PRO: SessionChoice = { mode: 'ONLINE', template: 'AUTOMATIC_2', count: 1 };

test.describe.configure({ mode: 'serial' });
test.skip(!SOURCE, 'Set E2E_SOURCE to a short video with speech (it is uploaded and then deleted)');

// project id -> the exact name cleanup must find (disposable prefix for uploads, the import name for YouTube)
const created = new Map<string, string | undefined>();
let free: { projectId: string; name: string; videoId: string; clipIds: string[] } | null = null;

test.afterAll(async () => {
  const request = await requestFactory.newContext();
  for (const [projectId, name] of created) await cleanupSession(request, projectId, name);
  await request.dispose();
});

async function expectRangedVideo(request: APIRequestContext, url: string) {
  const response = await request.get(url, { headers: { Range: 'bytes=0-1023' } });
  expect(response.status(), url).toBe(206);
  expect(response.headers()['content-type']).toMatch(/^video\//u);
}

/** Real playback: the player mounts near the viewport (preload none), so start it and watch time move. */
async function expectPlays(page: Page, video: ReturnType<Page['locator']>) {
  await video.scrollIntoViewIfNeeded();
  await expect(video).toBeAttached({ timeout: 30_000 });
  await video.evaluate((node: HTMLVideoElement) => { node.muted = true; return node.play(); });
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(0.2);
  await video.evaluate((node: HTMLVideoElement) => node.pause());
}

test('Upload -> XeeFree -> StyleZero -> Generate -> Export', async ({ page, request }) => {
  const session = await createSessionViaUi(page, FREE);
  created.set(session.projectId, undefined);
  const { videoId, results } = await waitForClips(request, session.projectId, FREE);
  expect(results.clips.every((clip: any) => clip.aiModeUsed !== 'Online')).toBeTruthy();
  free = { ...session, videoId, clipIds: results.clips.map((clip: any) => clip.id) };

  // The open session picks up the delivered clips by itself (no reload).
  const cards = page.getByTestId('clip-result');
  await expect(cards).toHaveCount(FREE.count, { timeout: 120_000 });
  const first = cards.first();
  await expect(first.getByText('XeeFree')).toBeVisible();
  await first.scrollIntoViewIfNeeded();
  await expectPlays(page, first.locator('video'));

  const exportLink = first.getByRole('link', { name: /Export clip/ });
  await expect(exportLink).toBeVisible();
  const href = await exportLink.getAttribute('href');
  expect(href).toMatch(/download=1/u);
  await expectRangedVideo(request, href!);
});

test('Upload -> XeePro -> StyleOne -> Generate -> Export', async ({ page, request }) => {
  const session = await createSessionViaUi(page, PRO);
  created.set(session.projectId, undefined);
  const { results } = await waitForClips(request, session.projectId, PRO);
  const clip = results.clips[0];
  expect(clip.templateId).toBe('AUTOMATIC_2');
  expect(clip.style?.playbackUrl, 'StyleOne export').toBeTruthy();

  const card = page.getByTestId('clip-result').first();
  await expect(card.getByRole('link', { name: /Export clip/ })).toBeVisible({ timeout: 120_000 });
  await expect(card.getByText('Ready')).toBeVisible();
  const href = await card.getByRole('link', { name: /Export clip/ }).getAttribute('href');
  // StyleOne previews and exports the styled render, never the unstyled base clip.
  expect(href).toContain(clip.style.playbackUrl);
  await expectRangedVideo(request, href!);
  await expectPlays(page, card.locator('video'));
});

test('YouTube URL -> XeePro -> StyleOne -> Generate -> Export', async ({ page, request }) => {
  test.skip(!YOUTUBE_URL, 'Set E2E_YOUTUBE_URL to a public video you are authorised to import');
  const capabilities = await getJson(request, '/videos/import-capabilities');
  test.skip(!capabilities.youtubeEnabled, 'YouTube importing is disabled on this stack');
  await page.goto('/');
  await ready(page);
  const form = page.getByRole('form', { name: 'Generate clips' });
  await form.getByRole('tab', { name: 'YouTube link' }).click();
  await form.getByLabel('Paste a public YouTube link').fill(YOUTUBE_URL);
  await form.locator('label[data-entry-template="AUTOMATIC_2"]').click();
  await form.locator('label[data-entry-mode="ONLINE"]').click();
  while (Number(await form.getByTestId('entry-clip-count').textContent()) > 1) {
    await form.getByRole('button', { name: 'Fewer clips' }).click();
  }
  await page.getByRole('checkbox', { name: /I have the right to process this video/ }).check();
  await form.getByRole('button', { name: 'Generate 1 Clip' }).click();
  await page.waitForURL(/\?session=[0-9a-f-]{36}/u, { timeout: 5 * 60_000 });
  const projectId = new URL(page.url()).searchParams.get('session')!;
  // An imported session is named after the video id, not the e2e prefix; clean up by that exact name.
  const youtubeId = /(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/u.exec(YOUTUBE_URL)?.[1];
  created.set(projectId, youtubeId ? `YouTube · ${youtubeId}` : 'YouTube clips');
  const { results } = await waitForClips(request, projectId, PRO);
  await expectRangedVideo(request, `${API}${results.clips[0].style.playbackUrl}`);
});

test('History -> Preview -> Edit -> Ask AI -> Undo -> Export', async ({ page, request }) => {
  test.skip(!free, 'needs the XeeFree session');
  await page.goto('/history');
  await ready(page);
  const card = page.locator('article', { hasText: `${free!.name}.mp4` }).first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expectPlays(page, card.locator('video'));

  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.waitForURL(/\/edit-mode\/[0-9a-f-]{36}$/u, { timeout: 120_000 });
  const editId = new URL(page.url()).pathname.split('/').pop()!;
  const video = page.getByTestId('edit-preview-video');
  await expect(video).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(2);
  await expectExportBackdrop(page);

  const revision = async () => Number((await getJson(request, `/edit-mode/projects/${editId}`)).revision);
  const start = await revision();
  await page.getByRole('tab', { name: 'AI Editor' }).click();
  const consent = page.getByTestId('ask-ai-consent');
  await expect(consent).toBeVisible();
  await consent.getByRole('button', { name: 'Allow Ask AI' }).click();
  const agent = page.getByTestId('agent-panel');
  await expect(agent).toBeVisible();
  await agent.getByLabel('Tell the AI editor what to change').fill('make the captions larger');
  await agent.getByRole('button', { name: 'Edit with AI' }).click();
  await expect(agent.getByTestId('agent-ledger')).toBeVisible({ timeout: 180_000 });
  await expect(agent.getByTestId('agent-ledger')).not.toContainText(/Failed|not verified/u);
  const edited = await waitUntil(revision, (value) => value > start, 2, 2000);

  // The AI edit is one undoable step: the top bar's Undo becomes available and reverts it.
  const undo = page.getByRole('banner').getByRole('button', { name: 'Undo' });
  await expect(undo).toBeEnabled({ timeout: 30_000 });
  await undo.click();
  const undone = await waitUntil(revision, (value) => value > edited, 2, 2000);
  const history = await getJson(request, `/edit-mode/projects/${editId}/history`) as unknown as Array<Record<string, any>>;
  expect(JSON.stringify(history).toUpperCase()).toContain('UNDO');

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Export video' }).click();
  const exports = await waitUntil(() => getJson(request, `/edit-mode/projects/${editId}/exports`),
    (value) => Array.isArray(value) && value.some((item: any) => item.current && item.sourceRevision === undone &&
      ['PASS', 'FAIL'].includes(item.metadata?.qa?.result)), 15) as unknown as Array<Record<string, any>>;
  const current = exports.find((item) => item.current && item.sourceRevision === undone)!;
  expect(current.metadata.qa.result).toBe('PASS');
  await expectRangedVideo(request, `${API}/edit-mode/assets/${current.id}/file`);
});

test('History -> Delete clip -> Refresh -> Confirm deletion', async ({ page, request }) => {
  test.skip(!free, 'needs the XeeFree session');
  const target = free!.clipIds[free!.clipIds.length - 1];
  await page.goto('/history');
  await ready(page);
  const cards = page.locator('article', { hasText: `${free!.name}.mp4` });
  await expect(cards).toHaveCount(free!.clipIds.length, { timeout: 60_000 });
  const before = await getJson(request, '/history/clips') as unknown as Array<{ id: string }>;
  const index = before.filter((clip) => free!.clipIds.includes(clip.id)).findIndex((clip) => clip.id === target);
  await cards.nth(index).getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete this clip?' });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('confirm-dialog-confirm').click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect(cards).toHaveCount(free!.clipIds.length - 1);

  await page.reload();
  await ready(page);
  await expect(page.locator('article', { hasText: `${free!.name}.mp4` })).toHaveCount(free!.clipIds.length - 1,
    { timeout: 60_000 });
  const after = await getJson(request, '/history/clips') as unknown as Array<{ id: string }>;
  expect(after.some((clip) => clip.id === target)).toBeFalsy();
  expect((await request.get(`${API}/generated-clips/${target}/file`)).status()).toBe(404);
  free!.clipIds = free!.clipIds.filter((id) => id !== target);
});

test('Backend offline -> frontend stays usable; recovery -> generation available again', async ({ page }) => {
  let offline = true;
  await page.route(`${API}/**`, (route) => offline ? route.abort('connectionrefused') : route.fallback());
  await page.goto('/');
  await ready(page);
  const notice = page.getByTestId('offline-notice');
  await expect(notice).toBeVisible({ timeout: 30_000 });
  const form = page.getByRole('form', { name: 'Generate clips' });
  const uploadTab = form.getByRole('tab', { name: 'Upload file' });
  if (await uploadTab.getAttribute('aria-selected') !== 'true') await uploadTab.click();
  await form.locator('input#file').setInputFiles({ name: 'offline-check.mp4', mimeType: 'video/mp4',
    buffer: Buffer.alloc(4096) });
  const generate = form.getByRole('button', { name: /^Generate \d+ Clips?$/u });
  await expect(generate).toBeDisabled();
  for (const route of ['/history', '/edit', '/settings']) {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if (route !== '/settings') await expect(page.getByTestId('offline-notice')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/TypeError|Failed to fetch|ECONNREFUSED/u)).toHaveCount(0);
  }

  // The server comes back: Create re-checks (Retry, or by itself within 15 s) and unlocks Generate.
  await page.goto('/');
  await ready(page);
  await expect(page.getByTestId('offline-notice')).toBeVisible({ timeout: 30_000 });
  if (await uploadTab.getAttribute('aria-selected') !== 'true') await uploadTab.click();
  await form.locator('input#file').setInputFiles({ name: 'offline-check.mp4', mimeType: 'video/mp4',
    buffer: Buffer.alloc(4096) });
  offline = false;
  await page.getByTestId('offline-notice').getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('offline-notice')).toBeHidden({ timeout: 30_000 });
  await expect(generate).toBeEnabled();
  // Nothing is submitted: the 4 KB file is never uploaded.
});
