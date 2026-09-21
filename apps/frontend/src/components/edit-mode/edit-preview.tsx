'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import type { EditAsset, EditElement } from '@/lib/edit-mode-types';
import { editAssetPlaybackUrl } from '@/lib/edit-mode-api';
import { resolvePreviewPosition, timelineDuration, videoTrack } from '@/lib/edit-mode-timeline';

const clock = (seconds: number) => {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return `${Math.floor(safe / 60)}:${Math.floor(safe % 60).toString().padStart(2, '0')}`;
};

export type EditPreviewHandle = { toggle: () => void };

export const EditPreview = forwardRef<EditPreviewHandle, { source?: EditAsset; elements: EditElement[];
  currentPlayheadSec: number; onPlayheadChange: (seconds: number) => void; onSelect: (id: string) => void;
}>(({ source, elements, currentPlayheadSec, onPlayheadChange, onSelect }, forwardedRef) => {
  const video = useRef<HTMLVideoElement>(null);
  const activeId = useRef<string | null>(null);
  const syncing = useRef(false);
  const [playing, setPlaying] = useState(false);
  const duration = timelineDuration(elements);
  const mapping = resolvePreviewPosition(elements, currentPlayheadSec);

  const toggle = async () => {
    if (!video.current || !mapping) return;
    if (video.current.paused) await video.current.play();
    else video.current.pause();
  };
  useImperativeHandle(forwardedRef, () => ({ toggle }));

  useEffect(() => {
    if (!video.current || !mapping) return;
    if (activeId.current !== mapping.element.id ||
      (!playing && Math.abs(video.current.currentTime - mapping.sourceTime) > 0.04)) {
      syncing.current = true;
      video.current.currentTime = mapping.sourceTime;
      activeId.current = mapping.element.id;
    }
  }, [mapping?.element.id, mapping?.sourceTime, playing]);

  if (!source) return <section className='grid min-h-[360px] place-items-center rounded-2xl border border-dashed border-white/10 bg-black/20 text-center'>
    <div><p className='text-sm font-semibold text-slate-300'>No source attached</p><p className='mt-2 text-xs text-slate-500'>Choose one exact video from the media panel.</p></div>
  </section>;

  const timeUpdate = (media: HTMLVideoElement) => {
    if (syncing.current) { syncing.current = false; return; }
    const active = videoTrack(elements).find((element) => element.id === activeId.current) ?? mapping?.element;
    if (!active) return;
    const trimEnd = active.trimEnd ?? active.trimStart + active.duration;
    if (media.currentTime >= trimEnd - 0.025) {
      const next = videoTrack(elements).find((element) => element.position === active.position + 1);
      if (!next) { media.pause(); onPlayheadChange(duration); return; }
      activeId.current = next.id;
      syncing.current = true;
      media.currentTime = next.trimStart;
      onSelect(next.id);
      onPlayheadChange(next.startTime);
      return;
    }
    onPlayheadChange(Math.min(duration, active.startTime + Math.max(0, media.currentTime - active.trimStart)));
  };

  return <section className='overflow-hidden rounded-2xl border border-white/10 bg-black/40'>
    <div className='grid min-h-[360px] place-items-center bg-black'>
      <video ref={video} src={editAssetPlaybackUrl(source.id)} className='max-h-[62vh] w-full object-contain'
        preload='metadata' onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => timeUpdate(event.currentTarget)} />
    </div>
    <div className='flex items-center gap-3 border-t border-white/10 px-4 py-3'>
      <button onClick={() => void toggle()} aria-label={playing ? 'Pause preview' : 'Play preview'}
        className='grid h-9 w-9 place-items-center rounded-full bg-white text-black disabled:opacity-40' disabled={!mapping}>
        {playing ? <Pause size={16} /> : <Play size={16} className='ml-0.5' />}
      </button>
      <input aria-label='Seek edited timeline' type='range' min={0} max={duration || 0} step={0.01}
        value={Math.min(currentPlayheadSec, duration)} onChange={(event) => onPlayheadChange(Number(event.target.value))}
        className='h-1 flex-1 accent-violet-400' />
      <span className='text-xs tabular-nums text-slate-400'>{clock(currentPlayheadSec)} / {clock(duration)}</span>
    </div>
  </section>;
});

EditPreview.displayName = 'EditPreview';
