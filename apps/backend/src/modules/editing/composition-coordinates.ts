import type { Rect } from './platform-layout';

export function sourceToViewport(source: Rect, sourceCrop: Rect, viewport: Rect): Rect {
  return {
    x: (source.x - sourceCrop.x) / sourceCrop.width * viewport.width,
    y: (source.y - sourceCrop.y) / sourceCrop.height * viewport.height,
    width: source.width / sourceCrop.width * viewport.width,
    height: source.height / sourceCrop.height * viewport.height
  };
}

export function viewportToCanvas(viewportRect: Rect, viewport: Rect): Rect {
  return { ...viewportRect, x: viewport.x + viewportRect.x, y: viewport.y + viewportRect.y };
}

export function sourceToCanvas(source: Rect, sourceCrop: Rect, viewport: Rect): Rect {
  return viewportToCanvas(sourceToViewport(source, sourceCrop, viewport), viewport);
}
