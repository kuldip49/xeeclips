'use client';

import { useEffect, useRef } from 'react';
import { cropZoom, normalizedAspect, panSourceUnderFrame, resizeCropRect, setCropZoom,
  type CropAspectPreset, type CropCorner, type CropRect,
  type CropViewportTransform } from '@/lib/edit-mode-crop';

const HANDLES: Array<{ corner: CropCorner; className: string; cursor: string }> = [
  { corner: 'nw', className: '-left-2 -top-2 coarse:-left-3 coarse:-top-3', cursor: 'nwse-resize' },
  { corner: 'ne', className: '-right-2 -top-2 coarse:-right-3 coarse:-top-3', cursor: 'nesw-resize' },
  { corner: 'sw', className: '-bottom-2 -left-2 coarse:-bottom-3 coarse:-left-3', cursor: 'nesw-resize' },
  { corner: 'se', className: '-bottom-2 -right-2 coarse:-bottom-3 coarse:-right-3', cursor: 'nwse-resize' }
];

type Point = { x: number; y: number };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Full-preview interaction layer. The source moves underneath a separate frame.
 *
 * One pointer pans (or resizes from a corner); a second finger turns the gesture into a pinch
 * that drives the same zoom the slider and mouse wheel use, so every input lands on the one
 * crop rectangle and export parity is unchanged.
 */
export function EditCropOverlay({ rect, preset, sourceAspect, transform, onChange }: {
  rect: CropRect;
  preset: CropAspectPreset;
  sourceAspect: number;
  transform: CropViewportTransform;
  onChange: (rect: CropRect) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const latest = useRef({ rect, preset, sourceAspect, onChange });
  latest.current = { rect, preset, sourceAspect, onChange };
  // Every finger on the stage, and the pinch that two of them form.
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{ distance: number; zoom: number; rect: CropRect } | null>(null);
  // A pinch ends the pan it interrupted; the remaining finger must not make the frame jump.
  const pinched = useRef(false);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!pointers.current.has(event.pointerId)) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const current = pinch.current;
      if (!current || pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      const ratio = distance(a, b) / Math.max(1, current.distance);
      const { preset: lock, sourceAspect: aspect, onChange: change } = latest.current;
      change(setCropZoom(current.rect, lock, aspect, current.zoom * ratio));
    };
    const end = (event: PointerEvent) => {
      pointers.current.delete(event.pointerId);
      if (pointers.current.size < 2) pinch.current = null;
      if (pointers.current.size === 0) pinched.current = false;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, []);

  const track = (event: React.PointerEvent) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const { rect: start, preset: lock, sourceAspect: aspect } = latest.current;
      pinch.current = { distance: distance(a, b), zoom: cropZoom(start, lock, aspect), rect: start };
      pinched.current = true;
    }
  };

  const begin = (event: React.PointerEvent, kind: 'pan' | 'resize', corner?: CropCorner) => {
    event.preventDefault(); event.stopPropagation();
    track(event);
    if (!stage.current || pointers.current.size > 1) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const startX = event.clientX; const startY = event.clientY; const initial = rect;
    let frame = 0; let latestPointer: PointerEvent | null = null;
    const draw = () => {
      frame = 0; if (!latestPointer || pinched.current) return;
      const dxPixels = latestPointer.clientX - startX;
      const dyPixels = latestPointer.clientY - startY;
      onChange(kind === 'pan'
        ? panSourceUnderFrame(initial, dxPixels, dyPixels, transform)
        : resizeCropRect(initial, corner ?? 'se',
          dxPixels / Math.max(0.0001, transform.sourceWidth * transform.scale),
          dyPixels / Math.max(0.0001, transform.sourceHeight * transform.scale),
          normalizedAspect(preset, sourceAspect)));
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== event.pointerId) return;
      latestPointer = pointer;
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const up = (pointer: PointerEvent) => {
      if (pointer.pointerId !== event.pointerId) return;
      if (frame) { cancelAnimationFrame(frame); draw(); }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const wheel = (event: React.WheelEvent) => {
    event.preventDefault(); event.stopPropagation();
    const current = cropZoom(rect, preset, sourceAspect);
    onChange(setCropZoom(rect, preset, sourceAspect,
      current * Math.exp(-event.deltaY * 0.0015)));
  };

  return <div ref={stage} data-testid='crop-source-bounds' data-crop-workspace='preview'
    onWheel={wheel} onPointerDown={(event) => { track(event); event.preventDefault(); }}
    className='absolute inset-0 z-30 touch-none overflow-hidden'>
    <div data-testid='crop-rectangle' aria-label='Crop rectangle'
      onPointerDown={(event) => begin(event, 'pan')}
      className='absolute cursor-grab touch-none border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.62)] active:cursor-grabbing'
      style={{ left: transform.frameX, top: transform.frameY,
        width: transform.frameWidth, height: transform.frameHeight }}>
      <div aria-hidden data-testid='crop-grid' className='pointer-events-none absolute inset-0'>
        <div className='absolute inset-y-0 left-1/3 border-l border-white/55' />
        <div className='absolute inset-y-0 left-2/3 border-l border-white/55' />
        <div className='absolute inset-x-0 top-1/3 border-t border-white/55' />
        <div className='absolute inset-x-0 top-2/3 border-t border-white/55' />
      </div>
      {HANDLES.map(({ corner, className, cursor }) => <button key={corner} type='button'
        aria-label={`Resize crop ${corner}`} data-testid={`crop-handle-${corner}`}
        onPointerDown={(event) => begin(event, 'resize', corner)} style={{ cursor }}
        className={`touch-hit absolute h-4 w-4 touch-none rounded-sm border-2 border-black bg-white coarse:h-6 coarse:w-6 coarse:rounded-md ${className}`} />)}
    </div>
  </div>;
}
