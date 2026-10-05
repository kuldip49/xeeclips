'use client';

import { useEffect, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { hookEmphasisRuns, stylePreviewModel, type PreviewText, type ResolvedCreativeStyle,
  type ResolvedVisualLayout } from '@/lib/creative-generation';
import { textStyleCss } from '@/lib/edit-mode-text';

/** Fixed width, so design units (600-wide canvas) scale exactly like the editor. */
const WIDTH = 270;
const HEIGHT = 480;

const CORNERS: Record<string, string> = {
  TOP_RIGHT: 'right-2 top-2', TOP_LEFT: 'left-2 top-2',
  BOTTOM_RIGHT: 'right-2 bottom-2', BOTTOM_LEFT: 'left-2 bottom-2'
};

function PreviewLine({ item, testId }: { item: PreviewText; testId: string }) {
  const css = textStyleCss(item.style as Record<string, unknown>, WIDTH);
  const words = item.text.split(' ');
  return <div data-testid={testId} className='absolute flex justify-center'
    style={{ left: `${item.box.x * 100}%`, top: `${item.box.y * 100}%`,
      width: `${item.box.width * 100}%`, height: `${item.box.height * 100}%`, overflow: 'hidden' }}>
    <span style={{ ...css, display: '-webkit-box', WebkitBoxOrient: 'vertical',
      WebkitLineClamp: item.maxLines, overflow: 'hidden' }}>
      {item.semanticColor?.length
        // Same rule as the backend's semanticHookRuns, so the preview lights the same words.
        ? hookEmphasisRuns(item.text, String(css.color ?? '#FFFFFF'), item.semanticColor)
          .map((run, index) => <span key={index} style={{ color: run.color }}>{run.text}</span>)
        : item.activeWordColor
        ? words.map((word, index) => <span key={index}
          style={index === 1 ? { color: item.activeWordColor! } : undefined}>{word}{index < words.length - 1 ? ' ' : ''}</span>)
        : item.text}
    </span>
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
  const video = useRef<HTMLVideoElement>(null);
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
    ? <div className='grid h-full w-full place-items-center bg-slate-900 text-slate-500'><ImageOff size={22} aria-hidden /></div>
    : <video ref={video} src={sourceUrl} poster={posterUrl} aria-label='Your source video style preview'
      controls playsInline preload='none' onError={() => setFailed(true)}
      onTimeUpdate={(event) => { playback.current = event.currentTarget.currentTime; }}
      className='h-full w-full' style={{ ...model.videoStyle,
        objectFit: model.layout === 'FIT' ? 'contain' : 'cover', objectPosition: model.objectPosition,
        transform: model.zoomScale > 1 ? `scale(${model.zoomScale})` : undefined,
        transition: 'filter 120ms ease, transform 120ms ease' }} />;
  return <figure className='grid justify-items-center gap-2' aria-label='Style preview'>
    <div data-testid='style-preview' data-layout={model.layout} data-loading={loading}
      className='relative overflow-hidden rounded-xl border border-white/10 shadow-lg'
      style={{ width: WIDTH, height: HEIGHT, background: fitBg }}>
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
      {model.hook ? <PreviewLine item={model.hook} testId='style-preview-hook' /> : null}
      {model.captions ? <PreviewLine item={model.captions} testId='style-preview-captions' /> : null}
      {model.supportingText ? <PreviewLine item={model.supportingText} testId='style-preview-supporting' /> : null}
      {model.logoCorner && CORNERS[model.logoCorner]
        ? <span className={`absolute ${CORNERS[model.logoCorner]} rounded bg-white/80 px-1.5 py-0.5 text-[9px] font-bold text-slate-900`}>LOGO</span>
        : null}
      {loading ? <div className='absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-violet-400' /> : null}
    </div>
    <figcaption className='max-w-[270px] text-center text-[11px] leading-4 text-slate-500'>
      Live preview on your uploaded video — timing and tracked crop may adapt per shot.
    </figcaption>
    {model.badges.length ? <div className='flex max-w-[300px] flex-wrap justify-center gap-1'>
      {model.badges.map((badge) => <span key={badge}
        className='rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-slate-400'>{badge}</span>)}
    </div> : null}
  </figure>;
}
