'use client';

import { useEffect, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { hookEmphasisRuns, stylePreviewModel, type PreviewText, type ResolvedCreativeStyle,
  type ResolvedVisualLayout } from '@/lib/creative-generation';
import { textStyleCss } from '@/lib/edit-mode-text';
import { StyleTwoPreviewText } from '@/components/edit-mode/style-two-preview-text';
import { STYLE_TWO_ID } from '@ai-content-platform/shared/style-two.cjs';

/** Largest preview width; design units (600-wide canvas) scale from the width actually drawn. */
const MAX_WIDTH = 270;
const ASPECT = 16 / 9;

const CORNERS: Record<string, string> = {
  TOP_RIGHT: 'right-2 top-2', TOP_LEFT: 'left-2 top-2',
  BOTTOM_RIGHT: 'right-2 bottom-2', BOTTOM_LEFT: 'left-2 bottom-2'
};

function PreviewLine({ item, testId, width, styleTwo }: { item: PreviewText; testId: string; width: number; styleTwo?: boolean }) {
  const css = textStyleCss(item.style as Record<string, unknown>, width);
  const words = item.text.split(' ');
  return <div data-testid={testId} className='absolute flex justify-center'
    style={{ left: `${item.box.x * 100}%`, top: `${item.box.y * 100}%`,
      width: `${item.box.width * 100}%`, height: `${item.box.height * 100}%`, overflow: 'hidden' }}>
    {styleTwo ? <StyleTwoPreviewText element={{ properties: { ...item.box, ...item.style, content: item.text } }} /> : <span style={{ ...css, display: '-webkit-box', WebkitBoxOrient: 'vertical',
      WebkitLineClamp: item.maxLines, overflow: 'hidden' }}>
      {item.semanticColor?.length
        // Same rule as the backend's semanticHookRuns, so the preview lights the same words.
        ? hookEmphasisRuns(item.text, String(css.color ?? '#FFFFFF'), item.semanticColor)
          .map((run, index) => <span key={index} style={{ color: run.color }}>{run.text}</span>)
        : item.activeWordColor
        ? words.map((word, index) => <span key={index}
          style={index === 1 ? { color: item.activeWordColor! } : undefined}>{word}{index < words.length - 1 ? ' ' : ''}</span>)
        : item.text}
    </span>}
  </div>;
}

/**
 * Step 9.3: an approximate look at the chosen style on the source's own frame.
 * No render per click - the hook wording, timing and per-shot framing are
 * decided for each clip, which the caption under the frame says plainly.
 */
export function StylePreview({ posterUrl, sourceUrl, resolved, layout, loading }: {
  posterUrl: string; sourceUrl: string; resolved: ResolvedCreativeStyle | null;
  layout: ResolvedVisualLayout | null; loading: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(MAX_WIDTH);
  const figure = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  // Phones get a narrower frame (never wider than its column); text keeps the same proportions.
  useEffect(() => {
    const node = figure.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const available = node.clientWidth;
      if (available > 0) setWidth(Math.min(MAX_WIDTH, Math.floor(available), window.innerWidth < 640 ? 230 : MAX_WIDTH));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);
  const playback = useRef(0);
  const model = stylePreviewModel(resolved, layout);
  const fitBg = model.fitBackground === 'WHITE' ? '#ffffff' : '#000000';
  useEffect(() => {
    const node = video.current;
    if (node && Math.abs(node.currentTime - playback.current) > 0.15 && node.readyState >= 1) {
      node.currentTime = Math.min(playback.current, node.duration || playback.current);
    }
  }, [resolved, layout]);
  const frame = failed
    ? <div className='grid h-full w-full place-items-center bg-surface text-faint'><ImageOff size={22} aria-hidden /></div>
    : <video ref={video} src={sourceUrl} poster={posterUrl} aria-label='Your source video style preview'
      controls playsInline preload='none' onError={() => setFailed(true)}
      onTimeUpdate={(event) => { playback.current = event.currentTarget.currentTime; }}
      className='h-full w-full' style={{ ...model.videoStyle,
        objectFit: model.layout === 'FIT' ? 'contain' : 'cover', objectPosition: model.objectPosition,
        transform: model.zoomScale > 1 ? `scale(${model.zoomScale})` : undefined,
        transition: 'filter 120ms ease, transform 120ms ease' }} />;
  return <figure ref={figure} className='grid min-w-0 justify-items-center gap-2' aria-label='Style preview'>
    <div data-testid='style-preview' data-layout={model.layout} data-loading={loading}
      className='relative overflow-hidden rounded-xl border border-border shadow-lg'
      style={{ width, height: Math.round(width * ASPECT), background: fitBg }}>
      {model.layout === 'FIT' && model.fitBackground === 'BLUR' && !failed
        ? <img src={posterUrl} alt='' aria-hidden className='absolute inset-0 h-full w-full scale-110 object-cover blur-xl brightness-75' />
        : null}
      <div className='absolute inset-0 overflow-hidden'>
        <div className='absolute overflow-hidden' style={layout ? {
          left: `${layout.videoFrame.x * 100}%`, top: `${layout.videoFrame.y * 100}%`,
          width: `${layout.videoFrame.width * 100}%`, height: `${layout.videoFrame.height * 100}%`,
          transition: 'all 120ms ease' } : { left: `${(1 - model.videoScale) * 50}%`,
          top: `${(1 - model.videoScale) * 50}%`, width: `${model.videoScale * 100}%`,
          height: `${model.videoScale * 100}%` }}>
          {frame}
          {model.overlayLayers.map((layer) => <div key={layer.key} className='pointer-events-none absolute inset-0' style={layer.style} />)}
        </div>
      </div>
      {model.hook ? <PreviewLine item={model.hook} testId='style-preview-hook' width={width} styleTwo={resolved?.templateId === STYLE_TWO_ID} /> : null}
      {model.captions ? <PreviewLine item={model.captions} testId='style-preview-captions' width={width} styleTwo={resolved?.templateId === STYLE_TWO_ID} /> : null}
      {model.supportingText ? <PreviewLine item={model.supportingText} testId='style-preview-supporting' width={width} /> : null}
      {model.logoCorner && CORNERS[model.logoCorner]
        ? <span className={`absolute ${CORNERS[model.logoCorner]} rounded bg-white/80 px-1.5 py-0.5 text-[9px] font-bold text-slate-900`}>LOGO</span>
        : null}
      {loading ? <div className='absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-secondary' /> : null}
    </div>
    <figcaption className='max-w-[270px] text-center text-[11px] leading-4 text-faint'>
      Live preview on your uploaded video — timing and tracked crop may adapt per shot.
    </figcaption>
    {model.badges.length ? <div className='flex max-w-[300px] flex-wrap justify-center gap-1'>
      {model.badges.map((badge) => <span key={badge}
        className='rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground'>{badge}</span>)}
    </div> : null}
  </figure>;
}
