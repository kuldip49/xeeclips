import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import sharp from 'sharp';

// Opt-in only: the acceptance verifier creates disposable projects in the isolated QA stack.
test.skip(process.env.E2E_QUICK_REFRAME_QA !== '1', 'Requires the isolated Quick Reframe QA manifest.');
const output = resolve(__dirname, '../../../.real-qa-preview/quick-reframe-both-modes');
const api = 'http://localhost:4100';
type Fixture = { id: string; editProjectId: string; mode: string; style: string; export: string };
const fixtures = (): Fixture[] => JSON.parse(readFileSync(resolve(output, 'acceptance.json'), 'utf8')).cases;
const hideDevBadge = 'nextjs-portal{display:none!important}';

test.beforeEach(async ({ context }) => {
  const saved = JSON.parse(readFileSync(resolve(__dirname, '../../../.cache/quick-reframe-qa/browser-private.json'), 'utf8'));
  const [name, value] = saved.cookie.split('=');
  await context.addCookies([{ name, value, url: 'http://localhost:3100', httpOnly: true, sameSite: 'Lax' }]);
});

test('both modes and all styles open the canonical editor on desktop and phones', async ({ page }) => {
  const cases = fixtures(); expect(cases).toHaveLength(6);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  for (const width of [1440, 375, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const fixture of cases.filter(f => width === 1440 || f.style === 'STYLETWO')) {
      await page.goto(`/edit-mode/${fixture.editProjectId}`);
      await page.addStyleTag({ content: hideDevBadge });
      await expect(page.getByTestId('edit-preview-canvas')).toBeVisible();
      await expect(page.getByTestId('edit-preview-video')).toHaveAttribute('data-media-state', 'READY');
      const modes = page.getByRole('group', { name: 'Choose XeeFree or XeePro' });
      if (!await modes.isVisible()) await page.getByRole('button', { name: 'Hooks', exact: true }).click();
      await expect(modes).toBeVisible();
      await expect(modes.getByRole('button', { name: fixture.mode === 'XEEPRO' ? 'XeePro' : 'XeeFree', exact: true })).toHaveAttribute('aria-pressed', 'true');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      await page.screenshot({ path: resolve(output, `${fixture.mode}-${fixture.style}-${width}.png`), fullPage: true });
    }
  }
  expect(errors).toEqual([]);
});

test('crop, choices, explicit busy action and export stay usable at phone and desktop widths', async ({ page }) => {
  const fixture = fixtures().find(f => f.mode === 'XEEFREE' && f.style === 'STYLEONE')!;
  for (const width of [375, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/quick-reframe?video=${fixture.id}&step=crop`);
    await page.addStyleTag({ content: hideDevBadge });
    await expect(page.getByTestId('crop-box')).toBeVisible();
    expect(await page.locator('[aria-label^="Crop handle:"]:visible').count()).toBe(8);
    const done = page.getByRole('button', { name: 'Done Cropping', exact: true }).locator('visible=true').first();
    await expect(done).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.goto(`/quick-reframe?video=${fixture.id}&step=choose`);
    await page.addStyleTag({ content: hideDevBadge });
    await expect(page.getByRole('button', { name: 'XeePro', exact: true })).toBeEnabled();
    for (const style of ['stylezero', 'styleone', 'styletwo', 'manual']) await expect(page.getByTestId(`choose-${style}`)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: resolve(output, `choices-${width}.png`), fullPage: true });
    await page.goto(`/quick-reframe?video=${fixture.id}&step=export`);
    await expect(page.getByTestId('download-video')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  }
  const current = await (await page.request.get(`${api}/quick-reframe/${fixture.id}`)).json();
  const message = 'XeePro is busy right now. Try XeeFree or try again later.';
  await page.route(`${api}/quick-reframe/${fixture.id}`, async route => {
    if (route.request().method() === 'GET') await route.fulfill({ json: { ...current, mode: 'XEEPRO', status: 'FAILED', errorCode: 'XEEPRO_BUSY', error: message } });
    else await route.continue();
  });
  await page.setViewportSize({ width: 375, height: 1000 });
  await page.goto(`/quick-reframe?video=${fixture.id}&step=choose`);
  await expect(page.locator('p[role="alert"]').filter({ hasText: message })).toBeVisible();
  await expect(page.getByRole('button', { name: 'XeePro', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Use XeeFree', exact: true }).click();
  await expect(page.getByRole('button', { name: 'XeeFree', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('all six canonical previews match real exported frames', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const results: Array<{ mode: string; style: string; meanAbsoluteRgbError: number }> = [];
  for (const fixture of fixtures()) {
    await page.goto(`/edit-mode/${fixture.editProjectId}`);
    await page.addStyleTag({ content: hideDevBadge });
    await expect(page.getByTestId('edit-preview-video')).toHaveAttribute('data-media-state', 'READY');
    await page.getByLabel('Seek edited timeline').fill('2');
    await expect.poll(() => page.getByTestId('edit-preview-video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(3, 1);
    const fit = page.getByRole('group', { name: 'Preview view' }).getByRole('button', { name: 'Fit', exact: true });
    if (await fit.count()) await fit.click();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250); // Allow the paused decoded frame to be presented.
    const preview = await page.getByTestId('edit-preview-canvas').screenshot();
    const { width, height } = await sharp(preview).metadata();
    const exported = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '2', '-i', fixture.export,
      '-vf', `scale=${width}:${height}`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { maxBuffer: 20 * 1024 * 1024 });
    const a = await sharp(preview).removeAlpha().raw().toBuffer();
    const b = await sharp(exported).removeAlpha().raw().toBuffer();
    expect(a.length).toBe(b.length);
    let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    const meanAbsoluteRgbError = sum / a.length;
    results.push({ mode: fixture.mode, style: fixture.style, meanAbsoluteRgbError });
    writeFileSync(resolve(output, 'pixel-parity.json'), JSON.stringify(results, null, 2));
    writeFileSync(resolve(output, `${fixture.mode}-${fixture.style}-preview-frame.png`), preview);
    writeFileSync(resolve(output, `${fixture.mode}-${fixture.style}-export-frame.png`), exported);
    expect(meanAbsoluteRgbError, `${fixture.mode} ${fixture.style} RGB parity`).toBeLessThan(20);
  }
});

test('manual styled hooks preserve canonical typography in both modes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const fixture of fixtures().filter(f => f.style === 'STYLETWO')) {
    const url = `${api}/edit-mode/projects/${fixture.editProjectId}`;
    const before = await (await page.request.get(url)).json();
    const original = before.elements.find((e: any) => e.type === 'TEXT' && e.properties.presetRole === 'HOOK');
    expect(original).toBeTruthy();
    await page.goto(`/edit-mode/${fixture.editProjectId}?tool=hooks`);
    await page.addStyleTag({ content: hideDevBadge });
    const hooks = page.getByRole('region', { name: 'Suggested Hooks' });
    await hooks.getByLabel('Write your own hook').fill('Judge each argument on its own merits');
    await hooks.getByRole('button', { name: 'Use my hook' }).click();
    const current = async () => (await (await page.request.get(url)).json()).elements.find((e: any) => e.id === original.id);
    await expect.poll(async () => (await current()).properties.content).toBe('Judge each argument on its own merits');
    const edited = (await current()).properties;
    for (const key of ['fontFamily', 'fontSize', 'x', 'y', 'width', 'height']) expect(edited[key]).toEqual(original.properties[key]);
    expect(edited.manualHookText).toBe(true);
    await page.getByRole('banner').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await current()).properties.content).toBe(original.properties.content);
  }
});
