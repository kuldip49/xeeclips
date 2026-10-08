export type PixelBox = { x: number; y: number; width: number; height: number };
export type StyleTwoCropTransform = {
  source: { width: number; height: number }; rect: PixelBox; fitted: PixelBox; scaled: PixelBox;
  rotation: number; flipH: boolean; flipV: boolean; target: PixelBox;
  sourceScale: { x: number; y: number };
};
export function styleTwoCropTransform(width: number, height: number,
  properties: Record<string, unknown>): StyleTwoCropTransform | null;
export function styleTwoCropFilter(transform: StyleTwoCropTransform): string;
export function styleTwoCropCamera<T extends { x: number; y: number; w: number; h: number }>(
  camera: T, transform: StyleTwoCropTransform): T;
export function styleTwoCropCameraFilter(filter: string): string;
