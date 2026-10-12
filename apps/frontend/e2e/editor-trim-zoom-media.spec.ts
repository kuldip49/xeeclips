import { expect, test, type Page, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// TRIM, ZOOM/PAN, MUSIC and MEDIA driven through the real editor UI against the canonical backend
// service. Routes replace only persistence/storage/auth, so no user project is touched. Export pixels are
// verified separately on real media (apps/backend/scripts/verify-editor-trim-zoom-media.cjs).
const { createHarness, seedAnalyzedProject } = require('../../backend/scripts/test-edit-mode-isolation.cjs');
let directory: string;
let source: Buffer;
let music: Buffer;
let image: Buffer;
test.beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'editor-tzm-browser-'));
  const video = join(directory, 'source.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=12.5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', video]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=10', join(directory, 'music.wav')]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xFF8C00:s=200x100:d=1', '-frames:v', '1', join(directory, 'overlay.png')]);
  source = readFileSync(video); music = readFileSync(join(directory, 'music.wav')); image = readFileSync(join(directory, 'overlay.png'));
});
test.afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

async function openEditor(page: Page, existing?: Awaited<ReturnType<typeof newState>>) {
  const state = existing ?? await newState();
  const commands: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(/https?:\/\/(?:(?:localhost|127\.0\.0\.1):4000|api\.xeeclip\.me)\//, async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = { 'access-control-allow-origin': new URL(page.url()).origin,
      'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type' };
    const json = (value: unknown, status = 200) => route.fulfill({ status, headers,
      contentType: 'application/json', body: JSON.stringify(value) });
    try {
      if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
      if (path === '/auth/session') {
        await json({ id: 'test-user', email: 'test@example.invalid', displayName: 'Trim QA', role: 'USER',
          creditBalance: 10, creditsConsumed: 0, aiProcessingConsentAt: null }); return;
      }
      if (path === `/edit-mode/projects/${state.project.id}`) { await json(await state.service.get(state.project.id)); return; }
      if (path.endsWith('/history')) { await json(await state.service.history(state.project.id, true)); return; }
      if (path.endsWith('/assets/upload')) {
        const form = await new Response(route.request().postDataBuffer(), { headers: {
          'content-type': route.request().headers()['content-type'] } }).formData();
        const file = form.get('file') as File;
        const buffer = Buffer.from(await file.arrayBuffer());
        await json(await state.service.uploadAsset(state.project.id,
          { originalname: file.name, mimetype: file.type, buffer, size: buffer.length },
          form.get('role'), form.get('revision'))); return;
      }
      if (path.includes('/commands/')) {
        const action = path.split('/').at(-1)!;
        commands.push(action);
        const body = route.request().postDataJSON();
        const run = action === 'trim' ? state.service.trimElement(state.project.id, body)
          : action === 'split' ? state.service.splitElement(state.project.id, body)
            : state.service.phase3Command(state.project.id, action, body);
        await json(await run); return;
      }
      if (path.endsWith('/undo') || path.endsWith('/redo')) {
        const action = path.endsWith('/undo') ? 'undo' : 'redo';
        commands.push(action);
        await json(await state.service[action](state.project.id, route.request().postDataJSON().revision)); return;
      }
      if (path.endsWith('/export/progress')) { await json(null); return; }
      if (/\/assets\/[^/]+\/file$/u.test(path)) {
        const id = path.split('/').at(-2)!;
        const asset = state.rows.editAssets.get(id);
        const buffer = asset?.role === 'SOURCE' ? source : state.objects.get(asset?.objectKey);
        if (!buffer) { await json({ message: 'Fixture unavailable' }, 404); return; }
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
      const failure = error as { getStatus?: () => number; message?: string; getResponse?: () => { message?: string } };
      await json({ message: failure.getResponse?.()?.message ?? failure.message }, failure.getStatus?.() ?? 500);
    }
  });
  await page.goto(`/edit-mode/${state.project.id}`);
  await expect.poll(() => page.getByTestId('edit-preview-video').evaluate(
    (video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  return { state, commands, errors };
}
async function newState() {
  const state = await seedAnalyzedProject(createHarness());
  const objects = new Map<string, Buffer>();
  state.storage.uploadBuffer = async (input: { objectKey: string; buffer: Buffer }) => {
    objects.set(input.objectKey, input.buffer);
    return { bucket: 'test-bucket', objectKey: input.objectKey };
  };
  return Object.assign(state, { objects });
}
const snapshot = (project: { elements: Array<Record<string, unknown>> }) => JSON.stringify(project.elements
  .map((e) => [e.id, e.type, e.startTime, e.duration, e.trimStart, e.trimEnd, e.properties]).sort());

test('trim, zoom, pan, music and media edit through the UI, survive undo/redo/reload and reopen', async ({ page }) => {
  test.setTimeout(180_000);
  const { state, commands, errors } = await openEditor(page);
  const service = state.service, id = state.project.id;
  const project = async () => service.get(id);
  const video = async () => (await project()).elements.find((e: { type: string }) => e.type === 'VIDEO');

  // ---- TRIM: drag both timeline handles --------------------------------------------------------
  const block = page.locator('[data-testid="timeline-block"][data-element-type="VIDEO"]').first();
  await block.click();
  await expect(page.getByText('Selected segment')).toBeVisible();
  const drag = async (edge: 'left' | 'right', deltaFraction: number) => {
    const box = (await block.boundingBox())!;
    const handle = block.getByTestId(`timeline-trim-${edge}`);
    await handle.scrollIntoViewIfNeeded();
    const hb = (await handle.boundingBox())!;
    const before = commands.filter((c) => c === 'trim').length;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 + box.width * deltaFraction, hb.y + hb.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => commands.filter((c) => c === 'trim').length, { timeout: 15_000 }).toBeGreaterThan(before);
  };
  // A caption, a text and a zoom placed on the content BEFORE trimming, in source seconds.
  const rows = state.rows.editElements;
  rows.set('cap-keep', { id: 'cap-keep', editProjectId: id, assetId: null, type: 'SUBTITLE', track: 1, position: 1,
    startTime: 6, duration: 2, trimStart: 0, trimEnd: null, createdAt: new Date(), updatedAt: new Date(),
    properties: { content: 'keeps its place', x: 0.1, y: 0.73, width: 0.8, height: 0.13, scale: 1, fontSize: 40,
      fontWeight: 700, fontFamily: 'Arial, sans-serif', textAlign: 'center', color: '#ffffff',
      backgroundColor: '#00000099', rotation: 0, opacity: 1, zIndex: 35, anchor: 'top-left', locked: false } });
  await page.reload();
  await expect.poll(() => page.getByTestId('edit-preview-video').evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await page.locator('[data-testid="timeline-block"][data-element-type="VIDEO"]').first().click();

  await drag('left', 3 / 12.5);
  let v = await video();
  expect(v.trimStart).toBeGreaterThan(2.4); expect(v.trimStart).toBeLessThan(3.6);
  const headCut = v.trimStart;
  await drag('right', -2 / 12.5);
  v = await video();
  expect(v.trimEnd).toBeLessThan(11.0); expect(v.trimEnd).toBeGreaterThan(9.8);
  expect(v.duration).toBeCloseTo(v.trimEnd - v.trimStart, 4);
  const caption = (await project()).elements.find((e: { id: string }) => e.id === 'cap-keep');
  // Moved by the head trim (content-anchored), not rescaled by the new length.
  expect(caption.startTime).toBeCloseTo(6 - headCut, 3);
  expect(caption.duration).toBeCloseTo(2, 3);
  const afterTrim = snapshot(await project());

  // ---- ZOOM + PAN through the Inspector ---------------------------------------------------------
  await page.locator('[data-testid="timeline-block"][data-element-type="VIDEO"]').first().click();
  const zoomSlider = page.getByLabel('Scale', { exact: true });
  await zoomSlider.fill('1.15'); await zoomSlider.blur();
  await expect.poll(async () => (await video()).properties.scale).toBe(1.15);
  await expect(page.getByLabel('Pan X')).toBeEnabled();
  await page.getByLabel('Pan X').fill('0.04'); await page.getByLabel('Pan X').blur();
  await expect.poll(async () => (await video()).properties.offsetX).toBeCloseTo(0.04, 3);
  // The pan slider's range IS the stored limit: a pan the picture could not cover cannot be entered.
  expect(Number(await page.getByLabel('Pan X').getAttribute('max'))).toBeCloseTo(0.075, 3);
  // Zoom out / in buttons commit immediately and re-clamp the pan in the same revision.
  await page.getByRole('button', { name: 'Zoom picture out', exact: true }).click();
  await expect.poll(async () => (await video()).properties.scale).toBeCloseTo(1.1, 3);
  await page.getByRole('button', { name: 'Zoom picture in', exact: true }).click();
  await expect.poll(async () => (await video()).properties.scale).toBeCloseTo(1.15, 3);
  // Drag the zoomed picture in the preview.
  const preview = page.getByTestId('edit-preview-video');
  const pb = (await preview.boundingBox())!;
  const panBefore = (await video()).properties.offsetY ?? 0;
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await page.mouse.down(); await page.mouse.move(pb.x + pb.width / 2 + 30, pb.y + pb.height / 2 - 30, { steps: 6 }); await page.mouse.up();
  await expect.poll(async () => (await video()).properties.offsetY).not.toBe(panBefore);
  v = await video();
  expect(Math.abs(v.properties.offsetX)).toBeLessThanOrEqual(0.075 + 1e-6);
  expect(Math.abs(v.properties.offsetY)).toBeLessThanOrEqual(0.075 + 1e-6);
  const zoomed = { scale: v.properties.scale, x: v.properties.offsetX, y: v.properties.offsetY };

  // ---- MUSIC ------------------------------------------------------------------------------------
  await page.getByRole('button', { name: 'Audio', exact: true }).click();
  await page.getByText('Upload music', { exact: true }).locator('input').setInputFiles({
    name: 'bed.wav', mimeType: 'application/octet-stream', buffer: music });
  await expect(page.getByTestId('edit-preview-audio')).toHaveCount(1);
  let audio = (await project()).elements.find((e: { type: string }) => e.type === 'AUDIO');
  expect(audio.startTime + audio.duration).toBeLessThanOrEqual((await video()).duration + 1e-6);
  const musicSlider = page.locator('#music-volume');
  await musicSlider.fill('0.25'); await musicSlider.blur();
  await expect.poll(async () => (await project()).elements.find((e: { type: string }) => e.type === 'AUDIO').properties.volume).toBe(0.25);

  // Mute / unmute, then remove the music and bring it back with Undo.
  const musicProps = async () => (await project()).elements.find((e: { type: string }) => e.type === 'AUDIO')?.properties;
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect.poll(async () => (await musicProps()).muted).toBe(true);
  await page.getByRole('button', { name: 'Muted', exact: true }).click();
  await expect.poll(async () => (await musicProps()).muted).toBe(false);
  await page.locator('[data-testid="timeline-block"][data-element-type="AUDIO"]').first().click();
  await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
  await expect.poll(async () => (await project()).elements.some((e: { type: string }) => e.type === 'AUDIO')).toBe(false);
  await expect(page.getByTestId('edit-preview-audio')).toHaveCount(0);
  await page.getByTestId('timeline-tool-undo').click();
  await expect.poll(async () => (await project()).elements.some((e: { type: string }) => e.type === 'AUDIO')).toBe(true);
  await expect(page.getByTestId('edit-preview-audio')).toHaveCount(1);
  expect((await musicProps()).volume).toBe(0.25);

  // ---- MEDIA: upload an image and add it to the timeline ------------------------------------------
  await page.getByRole('button', { name: 'Media', exact: true }).click();
  await page.getByLabel('Upload media asset').setInputFiles({ name: 'overlay.png', mimeType: 'image/png', buffer: image });
  await expect(page.getByText('overlay.png', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Add to timeline/ }).last().click();
  await expect.poll(async () => (await project()).elements.filter((e: { type: string }) => e.type === 'IMAGE').length).toBe(1);
  // Overlay opacity from the Inspector (a keyboard/blur commit, not only a mouse release).
  await page.locator('[data-testid="timeline-block"][data-element-type="IMAGE"]').first().click();
  const opacity = page.getByLabel('Opacity', { exact: true });
  await opacity.fill('0.6'); await opacity.blur();
  await expect.poll(async () => (await project()).elements.find((e: { type: string }) => e.type === 'IMAGE').properties.opacity).toBeCloseTo(0.6, 3);

  // ---- SEEK, then UNDO everything and REDO everything ------------------------------------------
  await page.getByLabel('Seek edited timeline').fill('2');
  const edited = snapshot(await project());
  const undoButton = page.getByTestId('timeline-tool-undo'), redoButton = page.getByTestId('timeline-tool-redo');
  let undone = 0; const undoBase = commands.filter((c) => c === 'undo').length;
  // After each step wait for the editor to finish (the buttons are disabled while it saves) before deciding.
  const settled = async () => { await page.waitForTimeout(250); await expect(page.getByTestId('edit-preview-video')).toBeVisible(); };
  while (undone < 40) { await settled(); if (!(await undoButton.isEnabled())) break; await undoButton.click(); undone++; await expect.poll(async () => commands.filter((c) => c === 'undo').length).toBe(undoBase + undone); }
  expect(undone).toBeGreaterThan(6);
  const original = await video();
  expect(original.duration).toBeCloseTo(12.5, 3); // untrimmed again
  expect((await project()).elements.some((e: { type: string }) => e.type === 'AUDIO' || e.type === 'IMAGE')).toBe(false);
  let redone = 0;
  while (redone < 40) { await settled(); if (!(await redoButton.isEnabled())) break; await redoButton.click(); redone++; await expect.poll(async () => commands.filter((c) => c === 'redo').length).toBe(redone); }
  expect(redone).toBe(undone);
  expect(snapshot(await project())).toBe(edited);

  // ---- RELOAD, and REOPEN in a fresh page (the History route) ------------------------------------
  await page.reload();
  await expect.poll(() => page.getByTestId('edit-preview-video').evaluate((x: HTMLVideoElement) => x.readyState)).toBeGreaterThanOrEqual(2);
  expect(snapshot(await project())).toBe(edited);
  await page.locator('[data-testid="timeline-block"][data-element-type="VIDEO"]').first().click();
  await expect(page.getByLabel('Scale', { exact: true })).toHaveValue(String(zoomed.scale));
  await expect(page.getByTestId('edit-preview-audio')).toHaveCount(1);
  const reopened = await page.context().newPage();
  await reopened.route(/https?:\/\/(?:(?:localhost|127\.0\.0\.1):4000|api\.xeeclip\.me)\//, async (route) => {
    // The same canonical service answers a fresh page: nothing is kept in the first page's memory.
    const path = new URL(route.request().url()).pathname;
    const headers = { 'access-control-allow-origin': new URL(reopened.url() || 'http://localhost:3100').origin, 'access-control-allow-credentials': 'true' };
    if (path === '/auth/session') return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ id: 'u', email: 'a@example.invalid', displayName: 'QA', role: 'USER', creditBalance: 1, creditsConsumed: 0, aiProcessingConsentAt: null }) });
    if (path === `/edit-mode/projects/${id}`) return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(await service.get(id)) });
    return route.fulfill({ status: 200, headers, contentType: 'application/json', body: '[]' });
  });
  await reopened.goto(`/edit-mode/${id}`);
  await expect(reopened.locator('[data-testid="timeline-block"][data-element-type="VIDEO"]').first()).toBeVisible();
  await expect(reopened.locator('[data-testid="timeline-block"][data-element-type="AUDIO"]')).toHaveCount(1);
  await expect(reopened.locator('[data-testid="timeline-block"][data-element-type="IMAGE"]')).toHaveCount(1);
  await reopened.close();
  expect(afterTrim).not.toBe(edited);
  expect(errors).toEqual([]);
});

test('phone: trim, zoom/pan, music and media edit and persist in the docked editor', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const { state, commands, errors } = await openEditor(page);
  const service = state.service, id = state.project.id;
  const project = async () => service.get(id);
  const video = async () => (await project()).elements.find((e: { type: string }) => e.type === 'VIDEO');

  // Trim with the timeline handle on a phone.
  const block = page.locator('[data-testid="timeline-block"][data-element-type="VIDEO"]').first();
  await block.click();
  const box = (await block.boundingBox())!;
  const handle = block.getByTestId('timeline-trim-left');
  await handle.scrollIntoViewIfNeeded();
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + box.width * 0.2, hb.y + hb.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => commands.filter((c) => c === 'trim').length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect((await video()).trimStart).toBeGreaterThan(1);

  // Zoom and pan in the Inspector drawer.
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  const zoomSlider = page.getByLabel('Scale', { exact: true });
  await zoomSlider.fill('1.15'); await zoomSlider.blur();
  await expect.poll(async () => (await video()).properties.scale).toBe(1.15);
  await page.getByLabel('Pan Y').fill('-0.03'); await page.getByLabel('Pan Y').blur();
  await expect.poll(async () => (await video()).properties.offsetY).toBeCloseTo(-0.03, 3);
  await page.getByRole('button', { name: 'Close Inspector', exact: true }).click();

  // Music.
  await page.getByRole('button', { name: 'Audio', exact: true }).click();
  await page.getByText('Upload music', { exact: true }).locator('input').setInputFiles({
    name: 'bed.wav', mimeType: 'application/octet-stream', buffer: music });
  await expect(page.getByTestId('edit-preview-audio')).toHaveCount(1);
  await page.locator('#music-volume').fill('0.3'); await page.locator('#music-volume').blur();
  await expect.poll(async () => (await project()).elements.find((e: { type: string }) => e.type === 'AUDIO').properties.volume).toBe(0.3);
  await page.getByRole('button', { name: 'Close Audio', exact: true }).click();

  // Media.
  await page.getByRole('button', { name: 'Media', exact: true }).click();
  await page.getByLabel('Upload media asset').setInputFiles({ name: 'overlay.png', mimeType: 'image/png', buffer: image });
  await expect(page.getByText('overlay.png', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Add to timeline/ }).last().click();
  await expect.poll(async () => (await project()).elements.filter((e: { type: string }) => e.type === 'IMAGE').length).toBe(1);

  const edited = snapshot(await project());
  await page.reload();
  await expect.poll(() => page.getByTestId('edit-preview-video').evaluate((x: HTMLVideoElement) => x.readyState)).toBeGreaterThanOrEqual(2);
  expect(snapshot(await project())).toBe(edited);
  await expect(page.getByTestId('edit-preview-audio')).toHaveCount(1);
  expect(errors).toEqual([]);
});
