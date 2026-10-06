'use client';

import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { cn } from '@/lib/utils';

/**
 * A result video that costs nothing until it is near the screen.
 *
 * A list of eight clips used to mount eight <video> elements at once, each fetching metadata
 * ranges on a phone connection. Until the card is within ~one screen of the viewport this
 * renders only the poster (or a placeholder); then the real element mounts with the same src,
 * so playback, seeking and byte-range requests are exactly what they were. A video that
 * scrolls away while playing is paused.
 */
export function LazyVideo({ src, poster, label, vertical, className }: {
  src: string;
  poster?: string;
  label: string;
  vertical: boolean;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) setNear(true);
        else if (!video.current?.paused) video.current?.pause();
      }
    }, { rootMargin: '400px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (autoPlay && near) void video.current?.play().catch(() => undefined);
  }, [autoPlay, near]);

  const shape = vertical ? 'aspect-[9/16] max-h-[72svh] md:max-h-[560px]' : 'aspect-video';
  return <div ref={box} className={cn('relative mx-auto w-full', vertical && 'max-w-[calc(72svh*9/16)] md:max-w-[315px]', className)}>
    {near
      ? <video ref={video} key={src} className={cn('mx-auto block w-full rounded-xl bg-black object-contain', shape)}
        controls playsInline preload={poster ? 'none' : 'metadata'} poster={poster} src={src} aria-label={label} />
      : <button type='button' onClick={() => { setNear(true); setAutoPlay(true); }} aria-label={label}
        className={cn('group relative grid w-full place-items-center overflow-hidden rounded-xl bg-gradient-to-br from-surface to-black', shape)}>
        {poster ? <img src={poster} alt='' loading='lazy' decoding='async' className='absolute inset-0 h-full w-full object-contain' /> : null}
        <span className='relative grid h-14 w-14 place-items-center rounded-full bg-white/90 text-black shadow-xl'><Play size={24} className='ml-1' aria-hidden /></span>
      </button>}
  </div>;
}

/** Near-full-screen player for a 9:16 clip on a phone (a centred dialog on larger screens). */
export function ClipPlayerSheet({ open, onClose, src, poster, title }: {
  open: boolean; onClose: () => void; src: string; poster?: string; title: string;
}) {
  return <BottomSheet open={open} onClose={onClose} title={title} size='full' tone='media'
    desktopWidth='md:max-w-[min(92vw,460px)]' bodyClassName='flex items-center justify-center px-2 pb-[max(.5rem,var(--safe-bottom))] md:px-4'>
    {open ? <video src={src} poster={poster} controls autoPlay playsInline aria-label={title}
      className='block max-h-full w-full rounded-xl bg-black object-contain md:max-h-[78vh]' /> : null}
  </BottomSheet>;
}
