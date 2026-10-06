import { expect, test, type Page } from '@playwright/test';
import { statSync } from 'node:fs';
/**
 * Real browser journeys against the live stack with an owned/authorized video (E2E_REFRAME_SOURCE):
 * crop first -> StyleOne -> export -> download -> History -> re-edit, and crop -> Manual editor ->
 * suggested hook -> captions -> filter -> shared export -> download. Sessions are deleted afterwards.
 */
const source = process.env.E2E_REFRAME_SOURCE;
const api = process.env.E2E_API_URL ?? 'http://localhost:4000';
const created: string[] = [];
test.describe.configure({ mode: 'serial', timeout: 25 * 60 * 1000 });
test.skip(!source, 'Set E2E_REFRAME_SOURCE to an owned test video.');
test.afterAll(async ({ request }) => { if (process.env.KEEP !== '1') for (const id of created) await request.delete(`${api}/quick-reframe/${id}`).catch(() => undefined); });

async function uploadAndCrop(page: Page) {
  await page.goto('/quick-reframe?new=1');
  await page.evaluate(() => localStorage.removeItem('quick-reframe-session'));
  await page.goto('/quick-reframe');
  await page.getByLabel('Upload video').setInputFiles(source!);
  await page.locator('button', { hasText: 'Upload video' }).click();
  await expect(page.getByTestId('crop-stage')).toBeVisible({ timeout: 15 * 60 * 1000 });
  const id = new URL(page.url()).searchParams.get('video')!; created.push(id);
  // Nothing but crop tools before Done.
  await expect(page.getByRole('button', { name: 'Apply StyleOne' })).toHaveCount(0);
  // Crop from the sides with the edge sliders, and drag the box's top handle down a little.
  await page.getByLabel('From left', { exact: true }).fill('0.02');
  await page.getByLabel('From right', { exact: true }).fill('0.02');
  const handle = page.getByLabel('Crop handle n', { exact: true }); const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 6, { steps: 4 }); await page.mouse.up();
  await page.getByRole('button', { name: 'Preview result' }).click();
  await expect(page.getByTestId('crop-result')).toBeVisible();
  await page.getByRole('button', { name: 'Adjust crop' }).click();
  await page.waitForTimeout(1200); // let the debounced draft save land, as a user would
  await page.reload(); await expect(page.getByTestId('crop-stage')).toBeVisible();
  await expect(page.getByLabel('From left', { exact: true })).toHaveValue(/^0\.02/);
  await page.locator('[data-testid^="crop-done"]:visible').click();
  await expect(page.getByRole('heading', { name: 'How would you like to edit your video?' })).toBeVisible({ timeout: 10 * 60 * 1000 });
  return id;
}
async function exportAndDownload(page: Page, quality: '720p' | '1080p') {
  await expect(page.getByRole('heading', { name: 'Export video' })).toBeVisible();
  await page.getByRole('button', { name: quality, exact: true }).click();
  await page.getByTestId('export-video').click();
  const download = page.getByTestId('download-video');
  await expect(download).toBeVisible({ timeout: 15 * 60 * 1000 });
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  const path = await file.path(); expect(statSync(path).size).toBeGreaterThan(100_000);
  return path;
}

test('StyleOne: crop -> Done -> StyleOne -> preview -> export -> download -> History -> re-edit', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1366, height: 900 });
  const id = await uploadAndCrop(page);
  await page.getByTestId('choose-styleone').click();
  const preview = page.getByLabel('StyleOne preview');
  await expect(preview).toBeVisible({ timeout: 15 * 60 * 1000 });
  await expect.poll(() => preview.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30000 }).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: 'test-results/qr-flow-styleone.png', fullPage: true });
  await page.getByTestId('go-export').click();
  await exportAndDownload(page, '1080p');
  await page.screenshot({ path: 'test-results/qr-flow-styleone-export.png', fullPage: true });
  await page.getByRole('link', { name: 'Open History' }).click();
  const card = page.getByTestId('quick-reframe-history-item').filter({ has: page.locator(`a[href*="${id}"]`) });
  await expect(card.getByText('StyleOne', { exact: true })).toBeVisible();
  await card.getByRole('link', { name: 'Re-edit' }).click();
  await expect(page.getByLabel('StyleOne preview').or(page.getByRole('button', { name: 'Render preview' }))).toBeVisible({ timeout: 60000 });
  expect(errors).toEqual([]);
});

test('Manual: crop -> Manual editor -> suggested hook -> captions -> filter -> export -> download -> refresh', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1366, height: 900 });
  await uploadAndCrop(page);
  await page.getByTestId('choose-manual').click();
  await expect(page).toHaveURL(/\/edit-mode\//, { timeout: 60000 });
  const hooks = page.getByRole('region', { name: 'Suggested Hooks' });
  await expect(hooks).toBeVisible({ timeout: 60000 });
  await hooks.getByTestId('generate-hooks').click();
  const first = hooks.getByTestId('hook-card').first(); await expect(first).toBeVisible({ timeout: 120000 });
  await expect(hooks.getByText('Recommended')).toHaveCount(1);
  const hookText = (await first.locator('p').first().textContent())!.trim();
  await first.getByRole('button', { name: 'Apply' }).click();
  await expect(first.getByRole('button', { name: 'Applied' })).toBeVisible({ timeout: 60000 });
  await page.getByRole('button', { name: 'Top inside video' }).click();
  await page.getByTestId('generate-captions').click();
  await expect(page.getByText('Captions added to your video.')).toBeVisible({ timeout: 60000 });
  await page.getByRole('navigation', { name: 'Editing tools' }).getByRole('button', { name: 'Filters' }).click();
  // The filter applies to the selected video segment.
  await page.getByTestId('timeline-band').locator('[data-element-type="VIDEO"]').first().click().catch(() => undefined);
  await page.getByRole('button', { name: 'Warm' }).click();
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Suggested Hooks' })).toBeVisible({ timeout: 60000 });
  await expect(page.getByText(hookText).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/qr-flow-manual-editor.png' });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page).toHaveURL(/step=export/);
  await exportAndDownload(page, '720p');
  await page.reload(); await expect(page.getByTestId('download-video')).toBeVisible();
  expect(errors).toEqual([]);
});

test('phones: crop handles, editor hooks drawer and export fit at 320-768px', async ({ page }) => {
  const id = created[created.length - 1]; test.skip(!id, 'needs the Manual session');
  const s = await (await page.request.get(`${api}/quick-reframe/${id}`)).json();
  for (const width of [320, 375, 390, 430, 768]) {
    await page.setViewportSize({ width, height: width < 768 ? 800 : 1024 });
    await page.goto(`/quick-reframe?video=${id}&step=crop`);
    await expect(page.getByTestId('crop-stage')).toBeVisible();
    await expect(page.getByLabel('Crop handle se', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.goto(`/edit-mode/${s.editProjectId}?tool=hooks`);
    if (width < 768) {
      await expect(page.getByTestId('mobile-editor-toolbar')).toBeVisible({ timeout: 60000 });
      await expect(page.getByRole('region', { name: 'Hooks & captions' })).toBeVisible();
      await page.getByLabel('Write your own hook').fill('My own hook line');
      await expect(page.getByLabel('Write your own hook')).toBeInViewport();
    } else await expect(page.getByRole('region', { name: 'Suggested Hooks' })).toBeVisible({ timeout: 60000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: `test-results/qr-flow-editor-${width}.png` });
    await page.goto(`/quick-reframe?video=${id}&step=export`);
    await expect(page.getByTestId('export-preview')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  }
});
