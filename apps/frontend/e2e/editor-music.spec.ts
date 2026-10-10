import { expect, test, type Page, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Drive the real editor and canonical backend service with synthetic audio.
// Routes replace only persistence/storage/auth, so no user projects are touched.
const { createHarness, seedAnalyzedProject } = require('../../backend/scripts/test-edit-mode-isolation.cjs');
let directory: string;
let source: Buffer;
let music: Buffer;
const musicFormats = new Map<string, Buffer>();
test.beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'editor-music-browser-'));
  const video = join(directory, 'source.mp4');
  const audio = join(directory, 'music.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc2=size=320x180:rate=30:duration=12.5', '-c:v', 'libx264', '-pix_fmt',
    'yuv420p', '-an', '-movflags', '+faststart', video]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    'sine=frequency=880:duration=10', audio]);
  source = readFileSync(video); music = readFileSync(audio);
  musicFormats.set('wav', music);
  for (const extension of ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'webm']) {
    const file = join(directory, `music.${extension}`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      'sine=frequency=880:duration=3', file]);
    musicFormats.set(extension, readFileSync(file));
  }
});
test.afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

async function editor(page: Page, tool = 'Audio') {
  const state = await seedAnalyzedProject(createHarness());
  const objects = new Map<string, Buffer>();
  state.storage.uploadBuffer = async (input: { objectKey: string; buffer: Buffer }) => {
    objects.set(input.objectKey, input.buffer);
    return { bucket: 'test-bucket', objectKey: input.objectKey };
  };
  let projectReads = 0;
  let delayHistory = false;
  let failMedia = false;
  let delayedMedia = false;
  const commands: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(/https?:\/\/(?:(?:localhost|127\.0\.0\.1):4000|api\.xeeclip\.me)\//, async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const headers = { 'access-control-allow-origin': new URL(page.url()).origin,
      'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type' };
    const json = (value: unknown, status = 200) => route.fulfill({ status, headers,
      contentType: 'application/json', body: JSON.stringify(value) });
    try {
      if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
      if (path === '/auth/session') {
        await json({ id: 'test-user', email: 'test@example.invalid', displayName: 'Music QA',
          role: 'USER', creditBalance: 10, creditsConsumed: 0, aiProcessingConsentAt: null }); return;
      }
      if (path === `/edit-mode/projects/${state.project.id}`) {
        projectReads++; await json(await state.service.get(state.project.id)); return;
      }
      if (path.endsWith('/history')) {
        const history = await state.service.history(state.project.id);
        if (delayHistory) await new Promise((resolve) => setTimeout(resolve, 5000));
        await json(history); return;
      }
      if (path.endsWith('/assets/upload')) {
        const form = await new Response(route.request().postDataBuffer(), { headers: {
          'content-type': route.request().headers()['content-type'] } }).formData();
        const file = form.get('file') as File;
        const buffer = Buffer.from(await file.arrayBuffer());
        const result = await state.service.uploadAsset(state.project.id,
          { originalname: file.name, mimetype: file.type, buffer, size: buffer.length },
          form.get('role'), form.get('revision'));
        await json(result); return;
      }
      if (path.includes('/commands/')) {
        const action = path.split('/').at(-1)!;
        commands.push(action);
        await json(await state.service.phase3Command(state.project.id, action,
          route.request().postDataJSON())); return;
      }
      if (path.endsWith('/undo') || path.endsWith('/redo')) {
        const action = path.endsWith('/undo') ? 'undo' : 'redo';
        await json(await state.service[action](state.project.id, route.request().postDataJSON().revision)); return;
      }
      if (path.endsWith('/export/progress')) { await json(null); return; }
      if (/\/assets\/[^/]+\/file$/u.test(path)) {
        const id = path.split('/').at(-2)!;
        const asset = state.rows.editAssets.get(id);
        const buffer = asset?.role === 'SOURCE' ? source : objects.get(asset?.objectKey);
        if (!buffer || (failMedia && asset?.role === 'AUDIO')) { await json({ message: 'Fixture unavailable' }, 404); return; }
        if (delayedMedia && asset?.role === 'AUDIO') await new Promise((resolve) => setTimeout(resolve, 1500));
        const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/u);
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(buffer.length - 1, Number(range[2])) : buffer.length - 1;
        await route.fulfill({ status: range ? 206 : 200, contentType: asset.mimeType,
          headers: { ...headers, 'accept-ranges': 'bytes',
            ...(range ? { 'content-range': `bytes ${start}-${end}/${buffer.length}` } : {}) },
          body: buffer.subarray(start, end + 1) }); return;
      }
      await json([]);
    } catch (error) {
      const failure = error as { getStatus?: () => number; message?: string };
      await json({ message: failure.message }, failure.getStatus?.() ?? 500);
    }
  });
  await page.goto(`/edit-mode/${state.project.id}`);
  await expect.poll(() => page.getByTestId('edit-preview-video').evaluate(
    (video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: tool, exact: true }).click();
  return { state, commands, errors, projectReads: () => projectReads,
    delayHistory: () => { delayHistory = true; },
    failMedia: (value: boolean) => { failMedia = value; },
    delayedMedia: () => { delayedMedia = true; } };
}

async function upload(page: Page) {
  await page.getByText('Upload music', { exact: true }).locator('input').setInputFiles({
    name: 'test-music.wav', mimeType: 'application/octet-stream', buffer: music });
  await expect(page.getByTestId('edit-preview-audio')).toHaveCount(1);
}

test('upload adds music without project readback or waiting for history; controls persist', async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = await editor(page);
  await page.getByLabel('Seek edited timeline').fill('2');
  const readsBefore = fixture.projectReads();
  fixture.delayHistory();
  await upload(page);
  const audio = page.getByTestId('edit-preview-audio');
  expect(fixture.projectReads()).toBe(readsBefore);
  expect(fixture.commands).toContain('add-audio');
  await expect(page.locator('#music-volume')).toBeEnabled({ timeout: 2000 });
  await expect(audio).toHaveAttribute('data-start-time', '2');
  await expect(page.getByRole('button', { name: 'Delete test-music.wav', exact: true })).toBeDisabled();
  await page.locator('#music-volume').fill('0.6');
  await page.locator('#music-volume').press('ArrowRight');
  await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.volume)).toBeCloseTo(0.61);
  await expect.poll(() => fixture.commands.includes('set-audio-volume')).toBe(true);
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.muted)).toBe(true);
  await expect(page.getByRole('button', { name: 'Muted', exact: true })).toBeEnabled({ timeout: 2000 });
  await page.getByRole('button', { name: 'Muted', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Audio panel', exact: true });
  await panel.getByRole('spinbutton', { name: 'Fade in', exact: true }).fill('0.5');
  await panel.getByRole('spinbutton', { name: 'Fade in', exact: true }).press('Tab');
  await expect.poll(() => fixture.commands.includes('set-audio-fade')).toBe(true);
  await page.getByRole('spinbutton', { name: 'End in track', exact: true }).fill('6');
  await page.getByRole('spinbutton', { name: 'End in track', exact: true }).press('Tab');
  await expect.poll(async () => (await fixture.state.service.get(fixture.state.project.id)).elements
    .find((item: { type: string }) => item.type === 'AUDIO')?.duration).toBe(6);
  await page.getByRole('button', { name: 'Play preview' }).click();
  await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => !node.paused && node.currentTime > 0.1)).toBe(true);
  await page.getByRole('button', { name: 'Pause preview' }).click();
  await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.paused)).toBe(true);
  await page.reload();
  await expect(page.getByTestId('edit-preview-audio')).toHaveCount(1);
  await page.getByLabel('Seek edited timeline').fill('3');
  await expect.poll(() => page.getByTestId('edit-preview-audio').evaluate((node: HTMLAudioElement) => node.volume)).toBe(0.61);
  await page.getByRole('banner').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await fixture.state.service.get(fixture.state.project.id)).elements
    .find((item: { type: string }) => item.type === 'AUDIO')?.duration).toBe(10);
  await page.getByRole('banner').getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(async () => (await fixture.state.service.get(fixture.state.project.id)).elements
    .find((item: { type: string }) => item.type === 'AUDIO')?.duration).toBe(6);
  expect(fixture.errors).toEqual([]);
});

test('delayed music loads at the correct source offset and survives live seeks', async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = await editor(page);
  await page.getByLabel('Seek edited timeline').fill('0');
  fixture.delayedMedia();
  await upload(page);
  const audio = page.getByTestId('edit-preview-audio');
  await audio.evaluate((node) => { (window as unknown as { originalAudio: Element }).originalAudio = node; });
  await page.getByLabel('Seek edited timeline').fill('4');
  await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.currentTime)).toBeCloseTo(4, 1);
  await page.getByRole('button', { name: 'Play preview' }).click();
  await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => !node.paused && node.currentTime > 4.1)).toBe(true);
  await page.getByLabel('Seek edited timeline').fill('7');
  const video = page.getByTestId('edit-preview-video');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(7);
  await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.currentTime)).toBeGreaterThan(7);
  const drift = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('[data-testid="edit-preview-video"]')!;
    const audio = document.querySelector<HTMLAudioElement>('[data-testid="edit-preview-audio"]')!;
    return Math.abs(video.currentTime - audio.currentTime);
  });
  expect(drift).toBeLessThan(0.35);
  await page.getByRole('button', { name: 'Pause preview' }).click();
  await page.getByLabel('Seek edited timeline').fill('11');
  await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.paused)).toBe(true);
  await page.getByLabel('Seek edited timeline').fill('1');
  expect(await audio.evaluate((node) => node === (window as unknown as { originalAudio: Element }).originalAudio)).toBe(true);
  await page.getByRole('button', { name: 'Play preview' }).click();
  await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => !node.paused)).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test('music load failures are visible and retryable', async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = await editor(page);
  fixture.failMedia(true);
  await upload(page);
  await expect(page.getByRole('alert').filter({ hasText: 'Music could not be loaded' })).toBeVisible();
  fixture.failMedia(false);
  await page.getByRole('button', { name: 'Retry music' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Music could not be loaded' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Play preview' }).click();
  await expect.poll(() => page.getByTestId('edit-preview-audio').evaluate((node: HTMLAudioElement) => !node.paused)).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test('phone music uploads, starts at its timeline position and remains controllable', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await editor(page);
  await page.getByLabel('Seek edited timeline').fill('2');
  await upload(page);
  await expect(page.locator('#music-volume')).toBeEnabled();
  await page.getByRole('button', { name: 'Close Audio', exact: true }).click();
  await page.getByLabel('Seek edited timeline').fill('0');
  const audio = page.getByTestId('edit-preview-audio');
  await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.readyState)).toBeGreaterThanOrEqual(1);
  await page.getByRole('button', { name: 'Play preview' }).click();
  expect(await audio.evaluate((node: HTMLAudioElement) => node.paused)).toBe(true);
  await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => !node.paused && node.currentTime > 0.1)).toBe(true);
  await page.getByRole('button', { name: 'Pause preview' }).click();
  await page.getByRole('button', { name: 'Audio', exact: true }).click();
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.muted)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('phone-music.png') });
  expect(fixture.errors).toEqual([]);
});

test('all supported music formats decode and play in Chrome', async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = await editor(page);
  await page.getByLabel('Seek edited timeline').fill('0');
  let count = 0;
  for (const [extension, buffer] of musicFormats) {
    await page.getByText('Upload music', { exact: true }).locator('input').setInputFiles({
      name: `test-music.${extension}`, mimeType: 'application/octet-stream', buffer });
    await expect(page.getByTestId('edit-preview-audio')).toHaveCount(++count);
    await expect(page.locator('#music-volume')).toBeEnabled();
  }
  const audio = page.getByTestId('edit-preview-audio');
  await expect.poll(() => audio.evaluateAll((nodes) => nodes.every((node) =>
    (node as HTMLAudioElement).readyState >= 2))).toBe(true);
  await page.getByRole('button', { name: 'Play preview' }).click();
  await expect.poll(() => audio.evaluateAll((nodes) => nodes.every((node) =>
    !(node as HTMLAudioElement).paused && (node as HTMLAudioElement).currentTime > 0.1))).toBe(true);
  await expect(page.getByRole('alert').filter({ hasText: /Music (could not|playback failed)/u })).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test('phone Media + Music accepts mobile MP3 metadata, inserts immediately and plays after reload', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await editor(page, 'Media');
  await page.getByLabel('Seek edited timeline').fill('0');
  const reads = fixture.projectReads();
  fixture.delayHistory();
  for (const [index, mimeType] of ['application/octet-stream', 'audio/mpeg3', ''].entries()) {
    // Exercise the exact + Music entry point in the reported screenshot.
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '+ Music', exact: true }).click();
    await (await chooser).setFiles({ name: `phone-${index}.MP3`, mimeType, buffer: musicFormats.get('mp3')! });
    await expect(page.getByTestId('edit-preview-audio')).toHaveCount(index + 1);
    await expect(page.getByRole('button', { name: '+ Music', exact: true })).toBeEnabled({ timeout: 2000 });
    expect(fixture.projectReads()).toBe(reads);
  }
  await expect(page.getByRole('alert').filter({ hasText: /Unsupported|upload failed/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close Media', exact: true }).click();
  await page.getByRole('button', { name: 'Play preview' }).click();
  await expect.poll(() => page.getByTestId('edit-preview-audio').evaluateAll((nodes) => nodes.every((node) =>
    !(node as HTMLAudioElement).paused && (node as HTMLAudioElement).currentTime > 0.1))).toBe(true);
  await page.getByRole('button', { name: 'Pause preview' }).click();
  await page.reload();
  await expect(page.getByTestId('edit-preview-audio')).toHaveCount(3);
  await expect(page.getByTestId('edit-preview-audio').first()).toHaveAttribute('data-start-time', '0');
  expect(fixture.errors).toEqual([]);
});
