'use client';

import { useRef } from 'react';
import { cropZoom, normalizedAspect, panSourceUnderFrame, resizeCropRect, setCropZoom,
  type CropAspectPreset, type CropCorner, type CropRect,
  type CropViewportTransform } from '@/lib/edit-mode-crop';

const HANDLES: Array<{ corner: CropCorner; className: string; cursor: string }> = [
  { corner: 'nw', className: '-left-2 -top-2', cursor: 'nwse-resize' },
  { corner: 'ne', className: '-right-2 -top-2', cursor: 'nesw-resize' },
  { corner: 'sw', className: '-bottom-2 -left-2', cursor: 'nesw-resize' },
  { corner: 'se', className: '-bottom-2 -right-2', cursor: 'nwse-resize' }
];

/** Full-preview interaction layer. The source moves underneath a separate frame. */
export function EditCropOverlay({ rect, preset, sourceAspect, transform, onChange }: {
  rect: CropRect;
  preset: CropAspectPreset;
  sourceAspect: number;
  transform: CropViewportTransform;
  onChange: (rect: CropRect) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const begin = (event: React.PointerEvent, kind: 'pan' | 'resize', corner?: CropCorner) => {
    event.preventDefault(); event.stopPropagation();
    if (!stage.current) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const startX = event.clientX; const startY = event.clientY; const initial = rect;
    let frame = 0; let latest: PointerEvent | null = null;
    const draw = () => {
      frame = 0; if (!latest) return;
      const dxPixels = latest.clientX - startX;
      const dyPixels = latest.clientY - startY;
      onChange(kind === 'pan'
        ? panSourceUnderFrame(initial, dxPixels, dyPixels, transform)
        : resizeCropRect(initial, corner ?? 'se',
          dxPixels / Math.max(0.0001, transform.sourceWidth * transform.scale),
          dyPixels / Math.max(0.0001, transform.sourceHeight * transform.scale),
          normalizedAspect(preset, sourceAspect)));
    };
    const move = (pointer: PointerEvent) => {
      latest = pointer;
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const up = () => {
      if (frame) { cancelAnimationFrame(frame); draw(); }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
  };

  const wheel = (event: React.WheelEvent) => {
    event.preventDefault(); event.stopPropagation();
    const current = cropZoom(rect, preset, sourceAspect);
    onChange(setCropZoom(rect, preset, sourceAspect,
      current * Math.exp(-event.deltaY * 0.0015)));
  };

  return <div ref={stage} data-testid='crop-source-bounds' data-crop-workspace='preview'
    onWheel={wheel} className='absolute inset-0 z-30 touch-none overflow-hidden'>
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
        className={`absolute h-4 w-4 touch-none rounded-sm border-2 border-black bg-white ${className}`} />)}
    </div>
  </div>;
}
