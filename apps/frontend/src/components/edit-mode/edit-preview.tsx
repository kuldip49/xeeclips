'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import type { EditAsset, EditElement, VisualElementProperties } from '@/lib/edit-mode-types';
import { editAssetPlaybackUrl } from '@/lib/edit-mode-api';
import { elementsAtTime, resolvePreviewPosition, timelineDuration, videoTrack } from '@/lib/edit-mode-timeline';

const clock = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${Math.floor(Math.max(0, seconds) % 60).toString().padStart(2, '0')}`;
export type EditPreviewHandle = { toggle: () => void };

function AudioLayer({ element, playing, timelineTime }: { element: EditElement; playing: boolean; timelineTime: number }) {
  const ref = useRef<HTMLAudioElement>(null);
  const properties = element.properties;
  const offset = Math.max(0, timelineTime - element.startTime);
  const fadeIn = Number(properties.fadeInSec ?? 0); const fadeOut = Number(properties.fadeOutSec ?? 0);
  let gain = Number(properties.volume ?? 0.25);
  if (fadeIn > 0) gain *= Math.min(1, offset / fadeIn);
  if (fadeOut > 0) gain *= Math.min(1, (element.duration - offset) / fadeOut);
  useEffect(() => {
    const audio = ref.current; if (!audio) return;
    const sourceTime = element.trimStart + offset;
    if (Math.abs(audio.currentTime - sourceTime) > 0.2) audio.currentTime = sourceTime;
    audio.volume = Math.max(0, Math.min(1, gain)); audio.muted = Boolean(properties.muted);
    if (playing) void audio.play().catch(() => undefined); else audio.pause();
  }, [element.trimStart, gain, offset, playing, properties.muted]);
  return <audio ref={ref} src={element.assetId ? editAssetPlaybackUrl(element.assetId) : undefined} preload='metadata' />;
}

export const EditPreview = forwardRef<EditPreviewHandle, { source?: EditAsset; assets: EditAsset[];
  elements: EditElement[]; selectedElementId: string | null; currentPlayheadSec: number;
  onPlayheadChange: (seconds: number) => void; onSelect: (id: string) => void;
  onPreviewElements: (elements: EditElement[]) => void;
  onCommitTransform: (kind: 'move' | 'resize', element: EditElement, before: EditElement[]) => void;
}>(({ source, assets, elements, selectedElementId, currentPlayheadSec, onPlayheadChange, onSelect,
  onPreviewElements, onCommitTransform }, forwardedRef) => {
  const video = useRef<HTMLVideoElement>(null); const canvas = useRef<HTMLDivElement>(null);
  const activeId = useRef<string | null>(null); const syncing = useRef(false);
  const [playing, setPlaying] = useState(false); const duration = timelineDuration(elements);
  const mapping = resolvePreviewPosition(elements, currentPlayheadSec);
  const active = elementsAtTime(elements, currentPlayheadSec);
  const toggle = async () => { if (!video.current || !mapping) return; if (video.current.paused) await video.current.play(); else video.current.pause(); };
  useImperativeHandle(forwardedRef, () => ({ toggle }));
  useEffect(() => { if (!video.current || !mapping) return; if (activeId.current !== mapping.element.id || (!playing && Math.abs(video.current.currentTime - mapping.sourceTime) > 0.04)) { syncing.current = true; video.current.currentTime = mapping.sourceTime; activeId.current = mapping.element.id; } }, [mapping?.element.id, mapping?.sourceTime, playing]);
  if (!source) return <section className='grid min-h-[360px] place-items-center rounded-2xl border border-dashed border-white/10 bg-black/20 text-center'><div><p className='text-sm font-semibold text-slate-300'>No source attached</p><p className='mt-2 text-xs text-slate-500'>Choose one exact video from the media panel.</p></div></section>;
  const timeUpdate = (media: HTMLVideoElement) => {
    if (syncing.current) { syncing.current = false; return; }
    const item = videoTrack(elements).find((element) => element.id === activeId.current) ?? mapping?.element; if (!item) return;
    const trimEnd = item.trimEnd ?? item.trimStart + item.duration;
    if (media.currentTime >= trimEnd - 0.025) { const next = videoTrack(elements).find((element) => element.position === item.position + 1); if (!next) { media.pause(); onPlayheadChange(duration); return; } activeId.current = next.id; syncing.current = true; media.currentTime = next.trimStart; onPlayheadChange(next.startTime); return; }
    onPlayheadChange(Math.min(duration, item.startTime + Math.max(0, media.currentTime - item.trimStart)));
  };
  const interaction = (event: React.PointerEvent, element: EditElement, kind: 'move' | 'resize') => {
    event.preventDefault(); event.stopPropagation(); onSelect(element.id);
    const bounds = canvas.current?.getBoundingClientRect(); if (!bounds || element.properties.locked) return;
    const before = elements.map((item) => ({ ...item, properties: { ...item.properties } }));
    const origin = element.properties as unknown as VisualElementProperties;
    const startX = event.clientX; const startY = event.clientY; let latest = element;
    const move = (pointer: PointerEvent) => {
      const dx = (pointer.clientX - startX) / bounds.width; const dy = (pointer.clientY - startY) / bounds.height;
      let next: Record<string, unknown>;
      if (kind === 'move') next = { x: Math.max(0, Math.min(1 - origin.width, origin.x + dx)), y: Math.max(0, Math.min(1 - origin.height, origin.y + dy)) };
      else { let width = Math.max(0.02, Math.min(1 - origin.x, origin.width + dx)); let height = Math.max(0.02, Math.min(1 - origin.y, origin.height + dy)); if (element.type === 'IMAGE') { const ratio = origin.height / origin.width; height = Math.min(1 - origin.y, width * ratio); width = height / ratio; } next = { width, height }; }
      latest = { ...element, properties: { ...element.properties, ...next } };
      onPreviewElements(elements.map((item) => item.id === element.id ? latest : item));
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); onCommitTransform(kind, latest, before); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true });
  };
  return <section className='overflow-hidden rounded-2xl border border-white/10 bg-black/40'>
    <div ref={canvas} className='relative mx-auto aspect-video w-full overflow-hidden bg-black'>
      <video ref={video} src={editAssetPlaybackUrl(source.id)} className='absolute inset-0 h-full w-full object-contain' preload='metadata' onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={(event) => timeUpdate(event.currentTarget)} />
      {active.filter((item) => item.type === 'IMAGE' || item.type === 'TEXT' || item.type === 'SUBTITLE').map((element) => {
        const p = element.properties as unknown as VisualElementProperties; const selected = element.id === selectedElementId;
        const asset = element.assetId ? assets.find((item) => item.id === element.assetId) : undefined;
        return <div key={element.id} role='button' tabIndex={0} onPointerDown={(event) => interaction(event, element, 'move')}
          className={`absolute cursor-move select-none ${selected ? 'ring-2 ring-cyan-300 ring-offset-1 ring-offset-transparent' : ''}`}
          style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: `${p.width * 100}%`, height: `${p.height * 100}%`, opacity: p.opacity, transform: `rotate(${p.rotation ?? 0}deg)`, zIndex: p.zIndex }}>
          {element.type === 'IMAGE' ? <img src={asset ? editAssetPlaybackUrl(asset.id) : ''} alt={asset?.originalName ?? 'Overlay'} draggable={false} className='pointer-events-none h-full w-full object-contain' /> : <div className='flex h-full w-full items-center' style={{ color: p.color, background: p.backgroundColor, fontFamily: p.fontFamily, fontSize: `${Math.max(10, (p.fontSize ?? 48) / 6)}cqw`, fontWeight: p.fontWeight, textAlign: p.textAlign }}><span className='w-full whitespace-pre-wrap break-words'>{p.content}</span></div>}
          {selected && <span aria-label='Resize overlay' onPointerDown={(event) => interaction(event, element, 'resize')} className='absolute -bottom-1.5 -right-1.5 h-4 w-4 cursor-nwse-resize rounded-sm border border-black bg-cyan-300' />}
        </div>;
      })}
      {active.filter((item) => item.type === 'AUDIO').map((element) => <AudioLayer key={element.id} element={element} playing={playing} timelineTime={currentPlayheadSec} />)}
    </div>
    <div className='flex items-center gap-3 border-t border-white/10 px-4 py-3'><button onClick={() => void toggle()} aria-label={playing ? 'Pause preview' : 'Play preview'} className='grid h-9 w-9 place-items-center rounded-full bg-white text-black disabled:opacity-40' disabled={!mapping}>{playing ? <Pause size={16} /> : <Play size={16} className='ml-0.5' />}</button><input aria-label='Seek edited timeline' type='range' min={0} max={duration || 0} step={0.01} value={Math.min(currentPlayheadSec, duration)} onChange={(event) => onPlayheadChange(Number(event.target.value))} className='h-1 flex-1 accent-violet-400' /><span className='text-xs tabular-nums text-slate-400'>{clock(currentPlayheadSec)} / {clock(duration)}</span></div>
  </section>;
});
EditPreview.displayName = 'EditPreview';
