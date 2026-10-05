import { expect, test } from '@playwright/test';

const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
const PROJECT_ID = process.env.E2E_CROP_PROJECT_ID ?? 'ff9b36cc-64c6-4004-8009-56183b6ec090';
type Json = Record<string, any>;

const kept = (element: Json) => {
  const crop = element.properties.crop ?? { left: 0, right: 0, top: 0, bottom: 0 };
  return { x: crop.left, y: crop.top, width: 1 - crop.left - crop.right,
    height: 1 - crop.top - crop.bottom };
};

const semanticElements = (project: Json) => JSON.stringify(project.elements
  .filter((element: Json) => element.type !== 'VIDEO')
  .map((element: Json) => ({ id: element.id, assetId: element.assetId, type: element.type,
    track: element.track, position: element.position, startTime: element.startTime,
    duration: element.duration, trimStart: element.trimStart, trimEnd: element.trimEnd,
    properties: element.properties })));

test('manual crop drags, locks aspect, persists, travels history, and renders', async ({ page, request }, testInfo) => {
  const load = async () => (await (await request.get(`${API}/edit-mode/projects/${PROJECT_ID}`)).json()) as Json;
  const original = await load();
  const videos = (project: Json) => project.elements.filter((element: Json) => element.type === 'VIDEO');
  const target = videos(original)[0];
  const originalCrop = JSON.stringify(target.properties.crop ?? null);

  await page.goto(`/edit-mode/${PROJECT_ID}`);
  const previewVideo = page.getByTestId('edit-preview-video');
  await expect(previewVideo).toHaveAttribute('data-media-state', 'READY', { timeout: 60_000 });
  await page.getByTestId('timeline-track-VIDEO').getByTestId('timeline-block').first().click();
  const playheadBefore = await page.getByLabel('Seek edited timeline').inputValue();
  await page.getByRole('button', { name: 'Crop', exact: true }).click();

  await expect(page.getByTestId('crop-rectangle')).toBeVisible();
  await expect(previewVideo).toHaveAttribute('data-media-state', 'READY', { timeout: 60_000 });
  await expect(page.getByTestId('crop-grid')).toBeVisible();
  await expect(page.getByTestId('crop-handle-nw')).toBeVisible();
  await expect(page.getByTestId('crop-handle-ne')).toBeVisible();
  await expect(page.getByTestId('crop-handle-sw')).toBeVisible();
  await expect(page.getByTestId('crop-handle-se')).toBeVisible();
  await expect(page.getByLabel('Seek edited timeline')).toBeDisabled();
  expect(await page.getByLabel('Seek edited timeline').inputValue()).toBe(playheadBefore);
  expect(await previewVideo.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);

  const sourceBounds = await page.getByTestId('crop-source-bounds').boundingBox();
  const previewBounds = await page.getByTestId('edit-preview-canvas').boundingBox();
  expect(sourceBounds).not.toBeNull();
  expect(previewBounds).not.toBeNull();
  expect(sourceBounds!.width).toBeCloseTo(previewBounds!.width, 0);
  expect(sourceBounds!.height).toBeCloseTo(previewBounds!.height, 0);
  const sourceAsset = original.assets.find((asset: Json) => asset.id === target.assetId) ??
    original.assets.find((asset: Json) => asset.role === 'SOURCE');
  const sourceRatio = sourceAsset.width / sourceAsset.height;
  for (const [name, ratio] of [['Original', sourceRatio],
    ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9], ['9:16', 9 / 16]] as const) {
    const preset = page.getByRole('group', { name: 'Crop aspect ratio' })
      .getByRole('button', { name, exact: true });
    await preset.click();
    await expect(preset).toHaveAttribute('aria-pressed', 'true');
    const presetBox = await page.getByTestId('crop-rectangle').boundingBox();
    expect(presetBox!.width / presetBox!.height).toBeCloseTo(ratio, 1);
  }

  // Free crop: pull the top-left corner inward, then reposition the crop.
  await page.getByRole('group', { name: 'Crop aspect ratio' })
    .getByRole('button', { name: 'Free / Custom' }).click();
  let handle = await page.getByTestId('crop-handle-nw').boundingBox();
  expect(handle).not.toBeNull();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down(); await page.mouse.move(handle!.x + 55, handle!.y + 38, { steps: 6 }); await page.mouse.up();
  let box = await page.getByTestId('crop-rectangle').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down(); await page.mouse.move(box!.x + box!.width / 2 + 18,
    box!.y + box!.height / 2 + 10, { steps: 5 }); await page.mouse.up();

  // A preset changes the draft only, then corner resizing keeps its pixel ratio.
  await page.getByRole('group', { name: 'Crop aspect ratio' })
    .getByRole('button', { name: '9:16' }).click();
  handle = await page.getByTestId('crop-handle-se').boundingBox();
  expect(handle).not.toBeNull();
  await page.mouse.move(handle!.x + 4, handle!.y + 4); await page.mouse.down();
  await page.mouse.move(handle!.x - 30, handle!.y - 60, { steps: 6 }); await page.mouse.up();
  box = await page.getByTestId('crop-rectangle').boundingBox();
  expect(box!.width / box!.height).toBeCloseTo(9 / 16, 1);

  // Fixed-aspect mode keeps the large frame stable and moves the source below it.
  const frameBeforePan = await page.getByTestId('crop-rectangle').boundingBox();
  const videoBeforePan = await previewVideo.boundingBox();
  await page.mouse.move(frameBeforePan!.x + frameBeforePan!.width / 2,
    frameBeforePan!.y + frameBeforePan!.height / 2);
  await page.mouse.down();
  await page.mouse.move(frameBeforePan!.x + frameBeforePan!.width / 2 + 35,
    frameBeforePan!.y + frameBeforePan!.height / 2, { steps: 5 });
  await page.mouse.up();
  const frameAfterPan = await page.getByTestId('crop-rectangle').boundingBox();
  const videoAfterPan = await previewVideo.boundingBox();
  expect(frameAfterPan).toEqual(frameBeforePan);
  expect(videoAfterPan!.x).not.toBeCloseTo(videoBeforePan!.x, 1);

  const zoom = page.getByLabel('Crop zoom');
  const videoBeforeZoom = await previewVideo.boundingBox();
  await zoom.fill('2');
  const videoAfterZoom = await previewVideo.boundingBox();
  expect(videoAfterZoom!.width).toBeGreaterThan(videoBeforeZoom!.width * 1.1);

  // Pointer work is draft-only: no request/revision per move.
  const beforeApply = await load();
  expect(beforeApply.revision).toBe(original.revision);
  const unrelatedBeforeApply = semanticElements(beforeApply);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect.poll(async () => (await load()).revision).toBe(original.revision + 1);
  await expect(page.getByTestId('edit-preview-canvas')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expect(page.getByTestId('edit-preview-canvas')).toHaveAttribute('data-fit-background', 'BLACK');
  const applied = await load();
  const appliedTarget = videos(applied).find((element: Json) => element.id === target.id);
  const appliedRect = kept(appliedTarget);
  expect(appliedRect.x).toBeGreaterThanOrEqual(0);
  expect(appliedRect.y).toBeGreaterThanOrEqual(0);
  expect(appliedRect.width).toBeGreaterThan(0.05);
  expect(appliedRect.height).toBeGreaterThan(0.05);
  expect(appliedRect.x + appliedRect.width).toBeLessThanOrEqual(1.000001);
  expect(appliedRect.y + appliedRect.height).toBeLessThanOrEqual(1.000001);
  expect(JSON.stringify(videos(applied).slice(1).map((element: Json) => element.properties.crop ?? null)))
    .toBe(JSON.stringify(videos(original).slice(1).map((element: Json) => element.properties.crop ?? null)));
  expect(semanticElements(applied)).toBe(unrelatedBeforeApply);

  await page.getByRole('button', { name: 'Play preview' }).click();
  await expect(page.getByRole('button', { name: 'Pause preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause preview' }).click();
  await page.reload();
  await expect(previewVideo).toHaveAttribute('data-media-state', 'READY', { timeout: 60_000 });
  await expect(page.getByTestId('edit-preview-canvas')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  expect(kept(videos(await load()).find((element: Json) => element.id === target.id))).toEqual(appliedRect);

  await page.getByRole('banner').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => JSON.stringify(videos(await load())
    .find((element: Json) => element.id === target.id).properties.crop ?? null)).toBe(originalCrop);
  await page.getByRole('banner').getByRole('button', { name: 'Redo' }).click();
  await expect.poll(async () => kept(videos(await load())
    .find((element: Json) => element.id === target.id))).toEqual(appliedRect);
  await expect(page.getByTestId('edit-preview-canvas')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  // The black is the canvas behind the video, not an overlay on top of it.
  await expect(previewVideo).toBeVisible();
  await expect(previewVideo).toHaveCSS('opacity', '1');

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Export video' }).click();
  await expect.poll(async () => {
    const exports = await (await request.get(`${API}/edit-mode/projects/${PROJECT_ID}/exports`)).json() as Json[];
    const current = await load();
    return exports.find((item) => item.current && item.sourceRevision === current.revision)
      ?.metadata?.qa?.result ?? null;
  }, { timeout: 12 * 60_000, intervals: [5_000] }).toBe('PASS');

  await page.screenshot({ path: testInfo.outputPath('manual-crop-tool.png'), fullPage: true });
  await expect(page.getByText(/Internal server error/u)).toHaveCount(0);
});
