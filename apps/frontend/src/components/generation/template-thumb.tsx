'use client';

import { useEffect, useRef, type CSSProperties, type MouseEvent } from 'react';
import { Maximize2, X } from 'lucide-react';
import { STYLE_TWO } from '@ai-content-platform/shared/style-two.cjs';
import { cn } from '@/lib/utils';

/**
 * A picture of each look as the finished vertical clip comes out, drawn on the real 1080x1920
 * geometry (StyleOne's media window y 610-1310 and hook box y 470-594, StyleTwo's STYLE_TWO
 * boxes) with the real fonts, so people can compare looks before choosing. Everything scales
 * with the card through container-query units. It depicts generated media, so its colours are the
 * media's own rather than app-chrome tokens. Pure markup: no assets, safe in the static export.
 */
const px = (value: number) => `${(value / 1080) * 100}cqw`; // a 1080-wide design px in card width
const pctY = (value: number) => `${(value / 1920) * 100}%`;
const pctX = (value: number) => `${(value / 1080) * 100}%`;

export const TEMPLATE_CAPTIONS: Record<string, string> = {
  AUTOMATIC_1: 'Captions follow the speaker, with a highlighted key word and gentle zooms.',
  AUTOMATIC_2: 'Black canvas: your video in a centred window, a serif headline above and captions below.',
  AUTOMATIC_3_STYLE_TWO: 'White canvas: a bold headline above your video with red boxed captions.',
  AUTOMATIC_RAW: 'Your selected moment as it is, with no added text or styling.'
};

/** Stand-in footage: a soft scene with a head-and-shoulders silhouette. */
function Footage({ style, className }: { style?: CSSProperties; className?: string }) {
  return <div className={cn('absolute overflow-hidden bg-gradient-to-b from-[#51648a] via-[#6e7ba0] to-[#2c3550]', className)}
    style={style} aria-hidden>
    <span className='absolute left-1/2 top-[24%] h-[28%] w-[30%] -translate-x-1/2 rounded-full bg-[#d6b79f]' />
    <span className='absolute left-1/2 top-[54%] h-[70%] w-[76%] -translate-x-1/2 rounded-t-full bg-[#1f2740]' />
  </div>;
}

const box = (x: number, y: number, width: number, height: number): CSSProperties =>
  ({ left: pctX(x), top: pctY(y), width: pctX(width), height: pctY(height) });

export function TemplateThumb({ look, className }: { look: string; className?: string }) {
  return <div data-template-thumb={look} aria-hidden style={{ containerType: 'inline-size' }}
    className={cn('relative mx-auto aspect-[9/16] w-full max-w-[150px] overflow-hidden rounded-lg border border-border shadow-md', className)}>
    {look === 'AUTOMATIC_1' ? <>
      <Footage className='inset-0 scale-110' />
      {/* The default HOOK text preset: loud opening line on a translucent dark plate (box x .08 y .1 w .84). */}
      <span className='absolute flex items-center justify-center' style={box(0.08 * 1080, 0.1 * 1920, 0.84 * 1080, 0.14 * 1920)}>
        <span className='text-center font-black text-white' style={{ background: 'rgba(0,0,0,.55)', fontSize: px(82), textWrap: 'balance',
          lineHeight: 1.1, padding: `${px(18 * 1.8)} ${px(18 * 1.8)}`, borderRadius: px(14 * 1.8),
          textShadow: `0 ${px(5)} ${px(14)} rgba(0,0,0,.7)` }}>Nobody tells you this</span></span>
      <span className='absolute inset-x-[8%] text-center font-extrabold uppercase leading-[1.1] text-white'
        style={{ top: pctY(1180), fontSize: px(84), textShadow: `0 ${px(5)} ${px(8)} rgba(0,0,0,.85)`, WebkitTextStroke: `${px(3)} #000` , paintOrder: 'stroke fill' }}>
        Buy <span className='text-[#b6e312]'>bonds</span> because they&apos;re nervous</span>
    </> : null}

    {look === 'AUTOMATIC_2' ? <div className='absolute inset-0 bg-black'>
      <span className='absolute flex items-center justify-center text-center text-white' style={{ ...box(27, 470, 1026, 124),
        fontFamily: 'EB Garamond, serif', fontSize: px(26 * 1.8), lineHeight: 1.14 }}>
        <span>It means <span className='text-[#e53935]'>sometimes</span> that&apos;s happening</span></span>
      <Footage style={box(0, 610, 1080, 700)} />
      <span className='absolute inset-x-[8%] text-center font-extrabold uppercase leading-[1.1] text-white'
        style={{ top: pctY(1140), fontSize: px(72), textShadow: `0 ${px(4)} ${px(6)} rgba(0,0,0,.85)` }}>
        Buy <span className='text-[#b6e312]'>bonds</span> now</span>
    </div> : null}

    {look === 'AUTOMATIC_3_STYLE_TWO' ? <div className='absolute inset-0' style={{ background: STYLE_TWO.background }}>
      <span className='absolute flex items-center justify-center text-center text-black'
        style={{ ...box(STYLE_TWO.hook.x, STYLE_TWO.hook.y, STYLE_TWO.hook.width, STYLE_TWO.hook.height),
          fontFamily: '"Roboto Condensed", sans-serif', fontWeight: 700, fontSize: px(STYLE_TWO.hookSize * 1.8),
          lineHeight: STYLE_TWO.hookLineHeight }}>
        Why did the cooling experiment miss its biggest weakness?</span>
      <Footage style={box(STYLE_TWO.media.x, STYLE_TWO.media.y, STYLE_TWO.media.width, STYLE_TWO.media.height)} />
      <span className='absolute flex items-center justify-center'
        style={box(STYLE_TWO.captions.x, STYLE_TWO.captions.y, STYLE_TWO.captions.width, STYLE_TWO.captions.height)}>
        <span className='text-center uppercase text-white' style={{ background: STYLE_TWO.red, fontFamily: 'Anton, sans-serif',
          fontSize: px(STYLE_TWO.captionSize * 1.8), lineHeight: STYLE_TWO.captionLineHeight,
          padding: `${px(STYLE_TWO.paddingY * 1.8)} ${px(STYLE_TWO.paddingX * 1.8)}`, borderRadius: px(STYLE_TWO.radius * 1.8) }}>
          that&apos;s the weakness</span></span>
    </div> : null}

    {look === 'AUTOMATIC_RAW' ? <Footage className='inset-0' /> : null}
  </div>;
}

/**
 * An "Enlarge" control for a card thumbnail: opens the same picture big, with a one-line
 * description of the finished result. It lives inside a radio <label>, so it must not select the card.
 */
export function TemplateThumbEnlarge({ look, title }: { look: string; title: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    return () => { if (node?.open) node.close(); };
  }, []);
  const stop = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); };
  return <>
    <button type='button' aria-label={`Enlarge ${title} example`} data-template-enlarge={look}
      onClick={(event) => { stop(event); dialog.current?.showModal(); }}
      className='absolute right-1.5 top-1.5 z-10 grid h-7 w-7 place-items-center rounded-full bg-black/60 text-white backdrop-blur hover:bg-black/80 focus-visible:ring-2 focus-visible:ring-ring'>
      <Maximize2 size={13} aria-hidden /></button>
    <dialog ref={dialog} onClick={(event) => { stop(event); if (event.target === dialog.current) dialog.current?.close(); }}
      aria-label={`${title} example`}
      className='m-auto max-h-[92svh] w-[min(340px,92vw)] overflow-y-auto rounded-2xl border border-border bg-surface p-4 text-foreground backdrop:bg-black/70'>
      <div className='mb-3 flex items-center justify-between'>
        <span className='font-display text-sm font-semibold'>{title}</span>
        <button type='button' aria-label='Close example' onClick={(event) => { stop(event); dialog.current?.close(); }}
          className='grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-tint-strong'><X size={16} aria-hidden /></button>
      </div>
      <TemplateThumb look={look} className='max-w-[270px]' />
      <p className='mt-3 text-center text-xs leading-5 text-muted-foreground'>{TEMPLATE_CAPTIONS[look] ?? ''} Example frame; your clips use your own video and words.</p>
    </dialog>
  </>;
}
