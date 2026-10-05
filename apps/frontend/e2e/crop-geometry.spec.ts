import { expect, test } from '@playwright/test';
import { fitCropToAspect, panSourceUnderFrame, setCropZoom, sourceCropToViewport,
  viewportTransformToSourceCrop, type CropAspectPreset,
  type CropRect } from '../src/lib/edit-mode-crop';

const closeRect = (actual: CropRect, expected: CropRect) => {
  expect(actual.x).toBeCloseTo(expected.x, 5);
  expect(actual.y).toBeCloseTo(expected.y, 5);
  expect(actual.width).toBeCloseTo(expected.width, 5);
  expect(actual.height).toBeCloseTo(expected.height, 5);
};

const roundTrip = (sourceWidth: number, sourceHeight: number,
  preset: CropAspectPreset, rect: CropRect) => {
  const transform = sourceCropToViewport(rect, sourceWidth, sourceHeight,
    1000, 600, preset);
  closeRect(viewportTransformToSourceCrop(transform), rect);
  return transform;
};

test('1920x1080 to 9:16 uses a large workspace frame and round-trips', () => {
  const rect = fitCropToAspect({ x: 0, y: 0, width: 1, height: 1 }, '9:16', 16 / 9);
  closeRect(rect, { x: 0.341797, y: 0, width: 0.316406, height: 1 });
  const transform = roundTrip(1920, 1080, '9:16', rect);
  expect(transform.workspaceWidth).toBe(1000);
  expect(transform.frameHeight).toBeCloseTo(552, 5);
  expect(transform.frameWidth / transform.frameHeight).toBeCloseTo(9 / 16, 5);
  expect(transform.scale).toBeGreaterThanOrEqual(
    transform.frameHeight / transform.sourceHeight);
});

test('portrait and landscape square crops round-trip', () => {
  const portrait = fitCropToAspect({ x: 0, y: 0, width: 1, height: 1 }, '1:1', 9 / 16);
  closeRect(portrait, { x: 0, y: 0.21875, width: 1, height: 0.5625 });
  roundTrip(1080, 1920, '1:1', portrait);

  const landscape = fitCropToAspect({ x: 0, y: 0, width: 1, height: 1 }, '1:1', 16 / 9);
  closeRect(landscape, { x: 0.21875, y: 0, width: 0.5625, height: 1 });
  roundTrip(1920, 1080, '1:1', landscape);
});

test('landscape 4:3 and free crops round-trip', () => {
  const fourThree = fitCropToAspect({ x: 0, y: 0, width: 1, height: 1 }, '4:3', 16 / 9);
  closeRect(fourThree, { x: 0.125, y: 0, width: 0.75, height: 1 });
  roundTrip(1920, 1080, '4:3', fourThree);

  roundTrip(1920, 1080, 'FREE', { x: 0.17, y: 0.11, width: 0.61, height: 0.72 });
});

test('pan and crop zoom remain source-normalized and clamped', () => {
  const initial = fitCropToAspect({ x: 0, y: 0, width: 1, height: 1 }, '9:16', 16 / 9);
  const zoomed = setCropZoom(initial, '9:16', 16 / 9, 2);
  expect(zoomed.width).toBeCloseTo(initial.width / 2, 5);
  expect(zoomed.height).toBeCloseTo(initial.height / 2, 5);
  const transform = sourceCropToViewport(zoomed, 1920, 1080, 1000, 600, '9:16');
  const panned = panSourceUnderFrame(zoomed, 100, 0, transform);
  expect(panned.x).toBeLessThan(zoomed.x);
  expect(panned.x).toBeGreaterThanOrEqual(0);
  expect(panned.x + panned.width).toBeLessThanOrEqual(1);
});
