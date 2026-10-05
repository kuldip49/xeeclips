'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { editAssetPlaybackUrl } from '@/lib/edit-mode-api';
import type { TimelineViewport } from '@/lib/edit-mode-viewport';
import {
  onThumbnailsChanged, peekThumbnail, requestThumbnails, thumbnailSlots, type ThumbnailBlock
} from '@/lib/edit-mode-thumbnails';
import {
  loadWaveform, MAX_WAVEFORM_COLUMNS, peakWindow, peekWaveform, type WaveformState
} from '@/lib/edit-mode-waveform';

/**
 * The two media decorations drawn behind timeline blocks: a frame strip on the
 * video track and a waveform on anything with audio.
 *
 * Both are purely visual aids. Neither reads or writes canonical state, neither
 * touches the source media, and both are bounded to the visible range — if
 * either is unavailable the timeline is exactly as usable, just plainer.
 */

/** A frame strip for the video track, laid out over the visible range only. */
export const ThumbnailStrip = memo(function ThumbnailStrip({ blocks, viewport, enabled }: {
  blocks: ThumbnailBlock[]; viewport: TimelineViewport; enabled: boolean;
}) {
  const [, bump] = useState(0);
  const slots = useMemo(() => enabled ? thumbnailSlots(blocks, viewport) : [],
    [blocks, enabled, viewport]);
  useEffect(() => onThumbnailsChanged(() => bump((value) => value + 1)), []);
  useEffect(() => {
    if (!slots.length) return;
    // Deferred off the render that laid the slots out, so opening the editor
    // paints the timeline first and decodes frames afterwards.
    const timer = setTimeout(() => requestThumbnails(slots, editAssetPlaybackUrl), 120);
    return () => clearTimeout(timer);
  }, [slots]);
  if (!slots.length) return null;
  return <div aria-hidden data-testid='timeline-thumbnails' data-slots={slots.length}
    className='pointer-events-none absolute inset-0 overflow-hidden'>
    {slots.map((slot) => {
      const frame = peekThumbnail(slot.key);
      return <div key={`${slot.elementId}:${slot.key}:${Math.round(slot.leftPx)}`}
        className='absolute inset-y-0 bg-slate-800/60 bg-cover bg-center'
        style={{ left: `${slot.leftPx}px`, width: `${slot.widthPx}px`,
          backgroundImage: frame ? `url(${frame})` : undefined }} />;
    })}
  </div>;
});

/**
 * One waveform.
 *
 * Drawn on a canvas rather than as DOM: a waveform is hundreds of columns, and
 * hundreds of <div>s per audio clip is exactly the DOM explosion the timeline
 * was virtualized to avoid. The canvas covers only the part of the block that
 * is on screen, and its width is capped, so its cost does not grow with the
 * project's length or with the zoom.
 */
export const WaveformStrip = memo(function WaveformStrip({ assetId, sizeBytes, block, viewport,
  color, enabled }: {
  assetId: string | null | undefined; sizeBytes?: number | null;
  block: { startTime: number; duration: number; trimStart: number; speed?: number };
  viewport: TimelineViewport; color: string; enabled: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<WaveformState>(() =>
    assetId ? peekWaveform(assetId) : { status: 'IDLE' });

  useEffect(() => {
    if (!enabled || !assetId) return;
    const controller = new AbortController();
    let live = true;
    void loadWaveform(assetId, editAssetPlaybackUrl(assetId),
      { sizeBytes, signal: controller.signal })
      .then((next) => { if (live) setState(next); });
    return () => { live = false; controller.abort(); };
  }, [assetId, enabled, sizeBytes]);

  // The visible slice of this block, clipped to the viewport and capped, so the
  // canvas is never wider than a screenful however far the timeline is zoomed.
  const slice = useMemo(() => {
    const pxPerSecond = viewport.pxPerSecond;
    const blockEnd = block.startTime + block.duration;
    const from = Math.max(block.startTime, viewport.visibleStartSec - viewport.overscanSec);
    const capSec = (MAX_WAVEFORM_COLUMNS * 2) / Math.max(1e-6, pxPerSecond);
    const to = Math.min(blockEnd, viewport.visibleEndSec + viewport.overscanSec, from + capSec);
    if (!(to > from)) return null;
    const speed = Math.max(0.0001, Number(block.speed ?? 1) || 1);
    return {
      leftPx: (from - block.startTime) * pxPerSecond,
      widthPx: Math.max(1, (to - from) * pxPerSecond),
      sourceFromSec: block.trimStart + (from - block.startTime) * speed,
      sourceToSec: block.trimStart + (to - block.startTime) * speed
    };
  }, [block.duration, block.speed, block.startTime, block.trimStart, viewport]);

  useEffect(() => {
    const node = canvas.current;
    if (!node || !slice || state.status !== 'READY') return;
    const ratio = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    const width = Math.max(1, Math.min(MAX_WAVEFORM_COLUMNS * 2, Math.round(slice.widthPx)));
    const height = Math.max(1, node.clientHeight);
    node.width = Math.round(width * ratio);
    node.height = Math.round(height * ratio);
    const context = node.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const columns = peakWindow(state.peaks,
      { fromSec: slice.sourceFromSec, toSec: slice.sourceToSec, columns: width / 2 });
    const step = width / columns.length;
    const middle = height / 2;
    context.fillStyle = color;
    for (let index = 0; index < columns.length; index += 1) {
      const amplitude = Math.max(0.5, columns[index] * (height / 2 - 1));
      context.fillRect(index * step, middle - amplitude, Math.max(1, step - 0.5), amplitude * 2);
    }
  }, [color, slice, state]);

  if (!enabled || !assetId || !slice) return null;
  if (state.status === 'UNAVAILABLE') {
    return <div aria-hidden data-testid='timeline-waveform-unavailable' title={state.reason}
      className='pointer-events-none absolute inset-x-0 bottom-0 top-0 flex items-center'>
      <span className='h-px w-full bg-white/25' /></div>;
  }
  if (state.status !== 'READY') return null;
  return <canvas ref={canvas} aria-hidden data-testid='timeline-waveform'
    className='pointer-events-none absolute inset-y-0 opacity-70'
    style={{ left: `${slice.leftPx}px`, width: `${slice.widthPx}px` }} />;
});
