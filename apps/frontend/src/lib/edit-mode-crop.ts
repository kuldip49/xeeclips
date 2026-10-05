import type { CropInsets } from './edit-mode-types';

export type CropRect = { x: number; y: number; width: number; height: number };
export type PixelRect = { x: number; y: number; width: number; height: number };
export type CropAspectPreset = 'FREE' | 'ORIGINAL' | '9:16' | '16:9' | '1:1' | '4:3' | '3:4';
export type CropCorner = 'nw' | 'ne' | 'sw' | 'se';
export type CropViewportTransform = {
  sourceWidth: number;
  sourceHeight: number;
  workspaceWidth: number;
  workspaceHeight: number;
  frameX: number;
  frameY: number;
  frameWidth: number;
  frameHeight: number;
  scale: number;
  translateX: number;
  translateY: number;
};

export const CROP_ASPECT_PRESETS: CropAspectPreset[] =
  ['FREE', 'ORIGINAL', '9:16', '16:9', '1:1', '4:3', '3:4'];
export const MIN_CROP_SIZE = 0.05;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number) => Number(value.toFixed(6));

export function presetPixelAspect(preset: CropAspectPreset, sourceAspect: number,
  rect?: CropRect): number {
  if (preset === 'ORIGINAL') return Math.max(0.0001, sourceAspect);
  if (preset !== 'FREE') {
    const [width, height] = preset.split(':').map(Number);
    return width / height;
  }
  return rect ? Math.max(0.0001, rect.width / rect.height * sourceAspect)
    : Math.max(0.0001, sourceAspect);
}

/** Largest centred frame of `aspect` inside the physical crop workspace. */
export function fitAspectInsideRect(workspaceWidth: number, workspaceHeight: number,
  aspect: number, margin = 24): PixelRect {
  const availableWidth = Math.max(1, workspaceWidth - Math.min(margin * 2, workspaceWidth * 0.12));
  const availableHeight = Math.max(1, workspaceHeight - Math.min(margin * 2, workspaceHeight * 0.12));
  const width = Math.min(availableWidth, availableHeight * aspect);
  const height = width / aspect;
  return { x: (workspaceWidth - width) / 2, y: (workspaceHeight - height) / 2,
    width, height };
}

export function calculateMinimumCoverScale(sourceWidth: number, sourceHeight: number,
  frameWidth: number, frameHeight: number): number {
  return Math.max(frameWidth / Math.max(1, sourceWidth),
    frameHeight / Math.max(1, sourceHeight));
}

/**
 * Maps one canonical source-normalized crop to the dedicated crop workspace.
 * The frame is workspace geometry; the source is independently scaled and
 * translated underneath it. No object-fit/content rectangle participates.
 */
export function sourceCropToViewport(rect: CropRect, sourceWidth: number, sourceHeight: number,
  workspaceWidth: number, workspaceHeight: number, preset: CropAspectPreset,
  margin = 24): CropViewportTransform {
  const safe = clampCropRect(rect);
  const frame = fitAspectInsideRect(workspaceWidth, workspaceHeight,
    presetPixelAspect(preset, sourceWidth / Math.max(1, sourceHeight), safe), margin);
  const scale = Math.max(frame.width / Math.max(1, safe.width * sourceWidth),
    frame.height / Math.max(1, safe.height * sourceHeight));
  return { sourceWidth, sourceHeight, workspaceWidth, workspaceHeight,
    frameX: frame.x, frameY: frame.y, frameWidth: frame.width, frameHeight: frame.height,
    scale, translateX: frame.x - safe.x * sourceWidth * scale,
    translateY: frame.y - safe.y * sourceHeight * scale };
}

/** Converts physical workspace state back to the only persisted representation. */
export function viewportTransformToSourceCrop(transform: CropViewportTransform): CropRect {
  const { sourceWidth, sourceHeight, frameX, frameY, frameWidth, frameHeight,
    scale, translateX, translateY } = transform;
  return clampCropRect({
    x: (frameX - translateX) / Math.max(0.0001, sourceWidth * scale),
    y: (frameY - translateY) / Math.max(0.0001, sourceHeight * scale),
    width: frameWidth / Math.max(0.0001, sourceWidth * scale),
    height: frameHeight / Math.max(0.0001, sourceHeight * scale)
  });
}

/** Ensures the source continues to cover every edge of the stable crop frame. */
export function clampCropTransform(transform: CropViewportTransform): CropViewportTransform {
  const minimum = calculateMinimumCoverScale(transform.sourceWidth, transform.sourceHeight,
    transform.frameWidth, transform.frameHeight);
  const scale = Math.max(minimum, transform.scale);
  const minX = transform.frameX + transform.frameWidth - transform.sourceWidth * scale;
  const minY = transform.frameY + transform.frameHeight - transform.sourceHeight * scale;
  return { ...transform, scale,
    translateX: clamp(transform.translateX, minX, transform.frameX),
    translateY: clamp(transform.translateY, minY, transform.frameY) };
}

export function panSourceUnderFrame(rect: CropRect, dxPixels: number, dyPixels: number,
  transform: CropViewportTransform): CropRect {
  return moveCropRect(rect,
    -dxPixels / Math.max(0.0001, transform.sourceWidth * transform.scale),
    -dyPixels / Math.max(0.0001, transform.sourceHeight * transform.scale));
}

function maximumCropAtCurrentAspect(rect: CropRect, preset: CropAspectPreset,
  sourceAspect: number): CropRect {
  if (preset !== 'FREE') {
    return fitCropToAspect({ x: 0, y: 0, width: 1, height: 1 }, preset, sourceAspect);
  }
  const ratio = Math.max(0.0001, rect.width / rect.height);
  const width = ratio >= 1 ? 1 : ratio;
  const height = ratio >= 1 ? 1 / ratio : 1;
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

export function cropZoom(rect: CropRect, preset: CropAspectPreset, sourceAspect: number): number {
  const base = maximumCropAtCurrentAspect(rect, preset, sourceAspect);
  return Math.max(1, Math.min(4, Math.min(base.width / rect.width, base.height / rect.height)));
}

/** Zoom is crop-editor scale, not the timeline/cinematic zoom effect. */
export function setCropZoom(rect: CropRect, preset: CropAspectPreset, sourceAspect: number,
  zoom: number): CropRect {
  const base = maximumCropAtCurrentAspect(rect, preset, sourceAspect);
  const safeZoom = clamp(zoom, 1, 4);
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const width = base.width / safeZoom;
  const height = base.height / safeZoom;
  return clampCropRect({ x: centerX - width / 2, y: centerY - height / 2, width, height });
}

export function cropRectFromInsets(crop: CropInsets): CropRect {
  const x = clamp(Number(crop.left) || 0, 0, 1 - MIN_CROP_SIZE);
  const y = clamp(Number(crop.top) || 0, 0, 1 - MIN_CROP_SIZE);
  return {
    x: round(x), y: round(y),
    width: round(clamp(1 - x - (Number(crop.right) || 0), MIN_CROP_SIZE, 1 - x)),
    height: round(clamp(1 - y - (Number(crop.bottom) || 0), MIN_CROP_SIZE, 1 - y))
  };
}

export function cropInsetsFromRect(rect: CropRect): CropInsets {
  const safe = clampCropRect(rect);
  return { left: round(safe.x), top: round(safe.y),
    right: round(1 - safe.x - safe.width), bottom: round(1 - safe.y - safe.height) };
}

export function clampCropRect(rect: CropRect): CropRect {
  const width = clamp(Number(rect.width) || MIN_CROP_SIZE, MIN_CROP_SIZE, 1);
  const height = clamp(Number(rect.height) || MIN_CROP_SIZE, MIN_CROP_SIZE, 1);
  return { x: round(clamp(Number(rect.x) || 0, 0, 1 - width)),
    y: round(clamp(Number(rect.y) || 0, 0, 1 - height)), width: round(width), height: round(height) };
}

/** Pixel aspect becomes a normalized width/height ratio inside the source box. */
export function normalizedAspect(preset: CropAspectPreset, sourceAspect: number): number | null {
  if (preset === 'FREE') return null;
  if (preset === 'ORIGINAL') return 1;
  const [width, height] = preset.split(':').map(Number);
  return (width / height) / Math.max(0.0001, sourceAspect);
}

export function fitCropToAspect(rect: CropRect, preset: CropAspectPreset,
  sourceAspect: number): CropRect {
  const ratio = normalizedAspect(preset, sourceAspect);
  if (!ratio) return clampCropRect(rect);
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const width = ratio >= 1 ? 1 : ratio;
  const height = ratio >= 1 ? 1 / ratio : 1;
  return clampCropRect({ x: clamp(centerX - width / 2, 0, 1 - width),
    y: clamp(centerY - height / 2, 0, 1 - height), width, height });
}

export function moveCropRect(rect: CropRect, dx: number, dy: number): CropRect {
  return { ...rect, x: round(clamp(rect.x + dx, 0, 1 - rect.width)),
    y: round(clamp(rect.y + dy, 0, 1 - rect.height)) };
}

export function resizeCropRect(rect: CropRect, corner: CropCorner, dx: number, dy: number,
  aspect: number | null): CropRect {
  const east = corner.endsWith('e');
  const south = corner.startsWith('s');
  const anchorX = east ? rect.x : rect.x + rect.width;
  const anchorY = south ? rect.y : rect.y + rect.height;
  const pointerX = (east ? rect.x + rect.width : rect.x) + dx;
  const pointerY = (south ? rect.y + rect.height : rect.y) + dy;
  let width = Math.max(MIN_CROP_SIZE, Math.abs(pointerX - anchorX));
  let height = Math.max(MIN_CROP_SIZE, Math.abs(pointerY - anchorY));

  const maxWidth = east ? 1 - anchorX : anchorX;
  const maxHeight = south ? 1 - anchorY : anchorY;
  if (aspect) {
    const fromWidth = { width, height: width / aspect };
    const fromHeight = { width: height * aspect, height };
    const horizontalMotion = Math.abs(dx) / Math.max(rect.width, MIN_CROP_SIZE);
    const verticalMotion = Math.abs(dy) / Math.max(rect.height, MIN_CROP_SIZE);
    ({ width, height } = horizontalMotion >= verticalMotion ? fromWidth : fromHeight);
    if (width > maxWidth) { width = maxWidth; height = width / aspect; }
    if (height > maxHeight) { height = maxHeight; width = height * aspect; }
    if (width < MIN_CROP_SIZE || height < MIN_CROP_SIZE) {
      height = Math.max(MIN_CROP_SIZE, MIN_CROP_SIZE / aspect);
      width = height * aspect;
    }
  } else {
    width = Math.min(width, maxWidth);
    height = Math.min(height, maxHeight);
  }
  return clampCropRect({ x: east ? anchorX : anchorX - width,
    y: south ? anchorY : anchorY - height, width, height });
}

export function inferCropPreset(rect: CropRect, sourceAspect: number): CropAspectPreset {
  const pixelRatio = rect.width / rect.height * sourceAspect;
  const candidates: Array<[CropAspectPreset, number]> = [
    ['ORIGINAL', sourceAspect], ['9:16', 9 / 16], ['16:9', 16 / 9], ['1:1', 1],
    ['4:3', 4 / 3], ['3:4', 3 / 4]
  ];
  return candidates.find(([, ratio]) => Math.abs(pixelRatio - ratio) / ratio < 0.005)?.[0] ?? 'FREE';
}
