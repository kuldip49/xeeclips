'use client';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Grid3x3, Maximize2, Minimize2, Pause, Play, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { mediaUrl, type ReframeAspect, type ReframeBox, type ReframeCropGrid, type ReframePlan, type ReframeSession } from '@/lib/quick-reframe-api';
import { CROP_GRIDS, CROP_SHAPES, cropWarnings, dragCrop, edgesOf, FULL, isFull, isPreset, maxZoomOf, panTo, parseRatio, ratioOf, setEdge, setSize,
  setZoom, withRatio, zoomCrop, zoomOf, type Edge, type Handle } from '@/lib/quick-reframe-crop';
import { cn } from '@/lib/utils';

const HANDLES: Array<{ id: Handle; style: React.CSSProperties; cursor: string; label: string }> = [
  { id: 'nw', style: { left: 0, top: 0 }, cursor: 'nwse-resize', label: 'top-left corner' }, { id: 'ne', style: { left: '100%', top: 0 }, cursor: 'nesw-resize', label: 'top-right corner' },
  { id: 'sw', style: { left: 0, top: '100%' }, cursor: 'nesw-resize', label: 'bottom-left corner' }, { id: 'se', style: { left: '100%', top: '100%' }, cursor: 'nwse-resize', label: 'bottom-right corner' },
  { id: 'n', style: { left: '50%', top: 0 }, cursor: 'ns-resize', label: 'top edge' }, { id: 's', style: { left: '50%', top: '100%' }, cursor: 'ns-resize', label: 'bottom edge' },
  { id: 'w', style: { left: 0, top: '50%' }, cursor: 'ew-resize', label: 'left edge' }, { id: 'e', style: { left: '100%', top: '50%' }, cursor: 'ew-resize', label: 'right edge' }
];
const EDGES: Array<{ id: Edge; label: string }> = [{ id: 'top', label: 'Crop top' }, { id: 'bottom', label: 'Crop bottom' }, { id: 'left', label: 'Crop left' }, { id: 'right', label: 'Crop right' }];
const pct = (v: number) => `${v * 100}%`;
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const chip = (active: boolean) => cn('min-h-10 rounded-xl border px-3 text-xs font-semibold transition-colors disabled:opacity-40',
  active ? 'border-primary/60 bg-primary/15 text-foreground' : 'border-border bg-surface text-muted-foreground hover:bg-tint hover:text-foreground');
const field = 'min-h-10 w-full min-w-0 rounded-lg border border-border bg-background px-2 text-sm tabular-nums';
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** A pixel field that commits on Enter/blur, so typing is never fought by the live crop. */
function PixelField({ label, value, min, max, disabled, hideLabel, onCommit }: { label: string; value: number; min: number; max: number; disabled?: boolean; hideLabel?: boolean; onCommit: (px: number) => void }) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setText(String(value)); }, [value, editing]);
  const commit = () => { setEditing(false); const n = Number(text); if (Number.isFinite(n)) onCommit(Math.max(min, Math.min(max, Math.round(n)))); else setText(String(value)); };
  return <label className='grid gap-1 text-[11px] text-muted-foreground'><span className={hideLabel ? 'sr-only' : undefined}>{label}</span>
    <input aria-label={label} inputMode='numeric' className={field} value={text} disabled={disabled} onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value.replace(/[^\d]/gu, ''))} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></label>;
}

/** Lines drawn over the crop area only. Changing the grid never changes the crop. */
function GridLines({ grid }: { grid: ReframeCropGrid }) {
  const lines = grid === 'THIRDS' || grid === 'GRID3' ? [1 / 3, 2 / 3] : grid === 'GRID4' ? [0.25, 0.5, 0.75] : grid === 'GOLDEN' ? [0.382, 0.618] : grid === 'CROSSHAIR' ? [0.5] : [];
  const line = grid === 'THIRDS' || grid === 'GOLDEN' ? 'bg-white/55' : 'bg-white/35';
  return <div aria-hidden data-testid='crop-grid' data-grid={grid} className='pointer-events-none absolute inset-0'>
    {lines.map((p) => <Fragment key={p}><span className={cn('absolute inset-y-0 w-px', line)} style={{ left: pct(p) }} /><span className={cn('absolute inset-x-0 h-px', line)} style={{ top: pct(p) }} /></Fragment>)}
    {grid === 'THIRDS' && [1 / 3, 2 / 3].flatMap((x) => [1 / 3, 2 / 3].map((y) => <span key={`${x}-${y}`} className='absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/80' style={{ left: pct(x), top: pct(y) }} />))}
    {grid === 'CROSSHAIR' && <span className='absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/80' />}
  </div>;
}

/** The cropped picture, drawn live from the playing video. Display only. */
function LivePreview({ video, crop, aspect }: { video: React.RefObject<HTMLVideoElement | null>; crop: ReframeBox; aspect: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const width = aspect >= 1 ? 240 : Math.max(24, Math.round(240 * aspect)), height = aspect >= 1 ? Math.max(24, Math.round(240 / aspect)) : 240;
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const v = video.current, c = canvas.current, context = c?.getContext('2d');
      if (v && c && context && v.readyState >= 2 && v.videoWidth) context.drawImage(v, crop.x * v.videoWidth, crop.y * v.videoHeight, crop.w * v.videoWidth, crop.h * v.videoHeight, 0, 0, c.width, c.height);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [video, crop]);
  return <canvas ref={canvas} width={width} height={height} data-testid='crop-live-preview' aria-label='Live crop preview' className='mx-auto max-h-60 max-w-full rounded-lg bg-black' style={{ aspectRatio: `${width} / ${height}` }} />;
}

/**
 * Quick Reframe step 1: a fully manual crop. Nothing is detected, suggested or corrected here; the crop
 * is exactly what the user drags, pinches or types, fixed for the whole video.
 */
export function CropStep({ session, plan, busy, onChange, onDone, onCancel, confirmed }: {
  session: ReframeSession; plan: ReframePlan; busy: boolean; confirmed: boolean;
  onChange: (plan: ReframePlan) => void; onDone: () => void; onCancel: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const afterVideo = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [view, setView] = useState<'before' | 'after'>('before');
  const [expanded, setExpanded] = useState(false);
  const [ratioText, setRatioText] = useState(isPreset(plan.aspect) || plan.aspect === 'STYLEONE' ? '' : plan.aspect);
  const [ratioError, setRatioError] = useState('');
  const lastGrid = useRef<ReframeCropGrid>(plan.grid && plan.grid !== 'NONE' ? plan.grid : 'THIRDS');
  const W = session.width || 16, H = session.height || 9;
  const grid = plan.grid ?? 'THIRDS';
  const ratio = ratioOf(plan.aspect, W, H);
  // The whole frame must always be visible: size the picture in pixels from the measured stage.
  const frame = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  const scrolled = useRef(false);
  /** Full screen remounts the workspace in a portal; playback resumes where it was. */
  const resumeAt = useRef(0);
  useEffect(() => {
    const element = frame.current; if (!element) return;
    const measure = () => { const style = getComputedStyle(element);
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight), padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      setRoom({ width: Math.max(0, element.clientWidth - padX), height: Math.max(0, element.clientHeight - padY) }); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    // Phones/tablets: bring the whole picture above the docked Cancel/Done bar instead of under it.
    if (!scrolled.current && window.innerWidth < 1024) element.scrollIntoView({ block: 'start' });
    scrolled.current = true;
    return () => observer.disconnect();
  }, [expanded]);
  // Full-screen workspace: lock page scroll; Escape leaves it.
  useEffect(() => {
    if (!expanded) return;
    const previous = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', key);
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', key); };
  }, [expanded]);
  const fit = (aspect: number) => { if (!room.width || !room.height) return { width: 0, height: 0 };
    const scale = Math.min(room.width / aspect, room.height); return { width: Math.floor(scale * aspect), height: Math.floor(scale) }; };
  const src = mediaUrl(session.originalUrl);
  const setCrop = useCallback((crop: ReframeBox, aspect: ReframeAspect = plan.aspect) =>
    onChange({ ...plan, crop, aspect, framing: 'CROP', tracking: undefined }), [onChange, plan]);

  // --- Gestures: one pointer drags a handle or moves the box; two pointers pinch-zoom and pan together. ---
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ box: ReframeBox; x: number; y: number; handle: Handle | 'pinch'; distance?: number } | null>(null);
  const centroid = () => { const p = [...pointers.current.values()]; return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2, d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) }; };
  const down = (event: React.PointerEvent<HTMLDivElement>) => {
    if (view !== 'before' || busy) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) { const c = centroid(); gesture.current = { box: { ...plan.crop }, x: c.x, y: c.y, handle: 'pinch', distance: c.d }; return; }
    if (pointers.current.size > 2) return;
    const handle = ((event.target as HTMLElement).closest('[data-handle]') as HTMLElement | null)?.dataset.handle as Handle | undefined;
    gesture.current = { box: { ...plan.crop }, x: event.clientX, y: event.clientY, handle: handle ?? 'move' };
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current; if (!g || !pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const rect = event.currentTarget.getBoundingClientRect();
    if (g.handle === 'pinch') {
      if (pointers.current.size !== 2 || !g.distance) return;
      const c = centroid();
      const zoomed = zoomCrop(g.box, g.distance / Math.max(1, c.d), W, H);
      setCrop(panTo(zoomed, zoomed.x + zoomed.w / 2 + (c.x - g.x) / rect.width, zoomed.y + zoomed.h / 2 + (c.y - g.y) / rect.height));
      return;
    }
    setCrop(dragCrop(g.box, g.handle, (event.clientX - g.x) / rect.width, (event.clientY - g.y) / rect.height, ratio, W, H));
  };
  const up = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) { gesture.current = null; return; }
    // Lifting one finger of a pinch continues as a move from where the crop is now.
    const [rest] = [...pointers.current.values()]; gesture.current = { box: { ...plan.crop }, x: rest.x, y: rest.y, handle: 'move' };
  };
  // Desktop: Ctrl + wheel (and trackpad pinch, reported as Ctrl + wheel) zooms; plain scrolling still scrolls the page.
  useEffect(() => {
    const element = stage.current; if (!element) return;
    const wheel = (event: WheelEvent) => { if (view !== 'before' || !event.ctrlKey) return; event.preventDefault();
      setCrop(zoomCrop(plan.crop, event.deltaY > 0 ? 1.04 : 0.96, W, H)); };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [plan.crop, W, H, view, setCrop]);
  /** Arrow keys move the focused crop by one source pixel (Shift: ten). */
  const nudge = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 1;
    const delta = { ArrowLeft: [-step / W, 0], ArrowRight: [step / W, 0], ArrowUp: [0, -step / H], ArrowDown: [0, step / H] }[event.key];
    if (!delta) return; event.preventDefault(); setCrop(dragCrop(plan.crop, 'move', delta[0], delta[1], ratio, W, H));
  };

  const chooseShape = (aspect: ReframeAspect) => { setRatioError(''); setCrop(withRatio(plan.crop, ratioOf(aspect, W, H), W, H), aspect); };
  const applyCustomRatio = () => { const aspect = parseRatio(ratioText); if (!aspect) { setRatioError('Enter a ratio such as 7:5 or 2.35:1.'); return; } setRatioText(aspect); chooseShape(aspect); };
  const reset = () => { setRatioError(''); setRatioText(''); setCrop(FULL, 'SOURCE'); };
  const setGrid = (next: ReframeCropGrid) => { if (next !== 'NONE') lastGrid.current = next; onChange({ ...plan, grid: next }); };

  // --- Playback shared by the adjust/result views. ----------------------------------------------------
  const toggle = () => { const v = video.current; if (!v) return; if (v.paused) void v.play().catch(() => undefined); else v.pause(); };
  useEffect(() => { const a = afterVideo.current, v = video.current; if (!a || !v) return;
    if (Math.abs(a.currentTime - time) > 0.2) a.currentTime = time;
    if (playing && a.paused) void a.play().catch(() => undefined); if (!playing && !a.paused) a.pause(); }, [time, playing, view]);
  const seek = (t: number) => { if (video.current) video.current.currentTime = t; setTime(t); resumeAt.current = t; };
  const crop = plan.crop;
  const cw = Math.round(crop.w * W), ch = Math.round(crop.h * H);
  const croppedAspect = (crop.w * W) / (crop.h * H);
  const divisor = gcd(cw, ch) || 1;
  const shapeLabel = plan.aspect === 'CUSTOM' ? `Free · ${cw / divisor <= 50 ? `${cw / divisor}:${ch / divisor}` : `${croppedAspect.toFixed(2)}:1`}`
    : plan.aspect === 'SOURCE' ? 'Original ratio' : plan.aspect === 'STYLEONE' ? '54:35' : plan.aspect;
  const warnings = cropWarnings(crop, W, H);
  const edges = edgesOf(crop);
  const zoom = zoomOf(crop), maxZoom = Math.min(20, maxZoomOf(crop, W, H));
  const done = (testId: string) => <Button type='button' size='lg' className='h-12 min-w-0 flex-1 px-3 md:flex-none md:px-8' disabled={busy} onClick={onDone} data-testid={testId}><Check size={16} />Done Cropping</Button>;
  const cancel = <Button type='button' variant='secondary' className='h-12 px-3 sm:px-4' disabled={busy} onClick={onCancel}><X size={16} />Cancel</Button>;
  const resetButton = <Button type='button' variant='ghost' className='h-12 px-3 sm:px-4' aria-label='Reset' disabled={busy || (isFull(crop) && plan.aspect === 'SOURCE')} onClick={reset}><RotateCcw size={16} /><span className='hidden min-[400px]:inline lg:inline'>Reset</span></Button>;

  const workspace = <div data-testid='crop-workspace' data-expanded={expanded || undefined} className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 [overflow-anchor:none] lg:grid-cols-[minmax(0,1fr)_340px]',
    expanded && 'fixed inset-0 z-[100] content-start overflow-y-auto overscroll-contain bg-background px-3 pb-[calc(env(safe-area-inset-bottom)+96px)] pt-[max(12px,env(safe-area-inset-top))] lg:px-6 lg:pb-6')}>
    <div className='grid min-w-0 content-start gap-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='flex gap-2' role='group' aria-label='Preview mode'>
          <button type='button' className={chip(view === 'before')} aria-pressed={view === 'before'} onClick={() => setView('before')}>Adjust crop</button>
          <button type='button' className={chip(view === 'after')} aria-pressed={view === 'after'} onClick={() => setView('after')}>Preview result</button>
        </div>
        <div className='ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2'>
          <button type='button' className={cn(chip(grid !== 'NONE'), 'inline-flex items-center gap-1.5')} aria-pressed={grid !== 'NONE'} onClick={() => setGrid(grid === 'NONE' ? lastGrid.current : 'NONE')}
            aria-label={grid === 'NONE' ? 'Show grid' : 'Hide grid'}><Grid3x3 size={14} /><span className='hidden sm:inline'>{grid === 'NONE' ? 'Show grid' : 'Hide grid'}</span></button>
          <select aria-label='Grid style' className='min-h-10 min-w-0 max-w-[9.5rem] rounded-xl border border-border bg-surface px-2 text-xs' value={grid} onChange={(e) => setGrid(e.target.value as ReframeCropGrid)}>
            {CROP_GRIDS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}</select>
          <button type='button' className={cn(chip(expanded), 'inline-flex items-center gap-1.5')} aria-pressed={expanded} onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? 'Exit full screen' : 'Full screen'}>{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}<span className='hidden sm:inline'>{expanded ? 'Exit full screen' : 'Full screen'}</span></button>
        </div>
      </div>
      <div ref={frame} className={cn('relative mx-auto grid w-full scroll-mt-20 place-items-center overflow-hidden rounded-2xl bg-black p-4',
        expanded ? 'h-[calc(100dvh-260px)] min-h-[240px] lg:h-[calc(100dvh-180px)]' : 'h-[min(52vh,520px)] lg:h-[clamp(320px,calc(100dvh-330px),680px)]')}>
        <div ref={stage} data-testid='crop-stage' className={cn('relative touch-none select-none', view === 'after' && 'hidden')}
          style={fit(W / H)} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <video ref={video} src={src} playsInline preload='auto' className='pointer-events-none h-full w-full object-contain'
            onLoadedMetadata={(e) => { if (resumeAt.current) e.currentTarget.currentTime = resumeAt.current; }}
            onTimeUpdate={(e) => { setTime(e.currentTarget.currentTime); resumeAt.current = e.currentTarget.currentTime; }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
          <div className='absolute cursor-move border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,.6)] outline-none focus-visible:border-primary' data-testid='crop-box'
            tabIndex={0} role='group' aria-label={`Crop area ${cw} by ${ch} pixels. Arrow keys move it.`} onKeyDown={nudge}
            style={{ left: pct(crop.x), top: pct(crop.y), width: pct(crop.w), height: pct(crop.h) }}>
            {grid !== 'NONE' && <GridLines grid={grid} />}
            {HANDLES.map((h) => <span key={h.id} data-handle={h.id} aria-label={`Crop handle: ${h.label}`} className='absolute z-10 grid h-12 w-12 -translate-x-1/2 -translate-y-1/2 place-items-center'
              style={{ ...h.style, cursor: h.cursor }}>
              <span data-handle={h.id} className={cn('rounded-full border-2 border-white bg-primary shadow', h.id.length === 2 ? 'h-5 w-5' : 'h-3 w-7', (h.id === 'w' || h.id === 'e') && 'h-7 w-3')} /></span>)}
          </div>
        </div>
        {view === 'after' && <div className='relative overflow-hidden' data-testid='crop-result' style={fit(croppedAspect)}>
          <video ref={afterVideo} src={src} muted playsInline preload='auto' className='absolute max-w-none'
            style={{ width: pct(1 / crop.w), height: pct(1 / crop.h), left: pct(-crop.x / crop.w), top: pct(-crop.y / crop.h) }} />
        </div>}
      </div>
      <div className='flex min-w-0 items-center gap-3'>
        <button type='button' aria-label={playing ? 'Pause' : 'Play'} onClick={toggle} className='grid h-11 w-11 shrink-0 place-items-center rounded-full bg-tint-strong text-foreground'>
          {playing ? <Pause size={18} /> : <Play size={18} />}</button>
        <input aria-label='Seek' type='range' min={0} max={session.duration || 0} step={0.05} value={time} onChange={(e) => seek(Number(e.target.value))} className='min-h-8 min-w-0 flex-1 accent-primary' />
        <span className='shrink-0 text-xs tabular-nums text-muted-foreground'>{clock(time)} / {clock(session.duration)}</span>
      </div>
      <div className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
        <span>Check:</span>
        {[['Start', 0], ['Middle', session.duration / 2], ['End', Math.max(0, session.duration - 0.1)]].map(([label, t]) =>
          <button key={label as string} type='button' className={chip(false)} onClick={() => seek(t as number)}>{label}</button>)}
        <span className='basis-full sm:basis-auto'>The crop stays fixed for the whole {session.duration.toFixed(1)}-second video. Nothing is trimmed and the original sound is kept.</span>
      </div>
    </div>

    {/* Not a scroll anchor: text reflowing here while dragging must never shift the picture under the finger. */}
    <aside className='grid min-w-0 content-start gap-5 rounded-2xl border border-border bg-surface p-4 [overflow-anchor:none] sm:p-5'>
      <div className='hidden gap-2 lg:grid'>
        {done('crop-done-desktop')}
        <div className='grid grid-cols-2 gap-2'>{cancel}{resetButton}</div>
      </div>
      <div className='grid gap-1' data-testid='crop-summary'>
        <p className='font-display text-lg font-semibold tabular-nums'>{cw} × {ch} px</p>
        <p className='text-xs text-muted-foreground'>{shapeLabel} · {isFull(crop) ? 'full frame' : `keeps ${Math.round(crop.w * crop.h * 100)}% of the frame`}{confirmed ? '' : ' · not confirmed yet'}</p>
        {warnings.map((w) => <p key={w} role='status' className='rounded-lg border border-warning/30 bg-warning/10 p-2 text-[11px] text-warning-soft'>{w}</p>)}
      </div>
      <div className='grid gap-2'>
        <h2 className='font-display text-sm font-semibold'>Aspect ratio</h2>
        <div className='flex flex-wrap gap-2' role='group' aria-label='Aspect ratio'>{CROP_SHAPES.map((shape) => <button key={shape.id} type='button' className={chip(plan.aspect === shape.id)} aria-pressed={plan.aspect === shape.id}
          disabled={busy} onClick={() => chooseShape(shape.id)}>{shape.label}</button>)}</div>
        <div className='flex gap-2'>
          <input aria-label='Custom aspect ratio' placeholder='Custom, e.g. 7:5' className={field} value={ratioText} onChange={(e) => { setRatioText(e.target.value); setRatioError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') applyCustomRatio(); }} />
          <Button type='button' variant='secondary' className='shrink-0' disabled={busy || !ratioText.trim()} onClick={applyCustomRatio}>Apply</Button>
        </div>
        {ratioError && <p className='text-[11px] text-warning-soft'>{ratioError}</p>}
        <p className='text-[11px] text-muted-foreground'>{ratio ? 'The shape stays locked while you resize.' : 'Free Crop: width and height change independently.'}</p>
      </div>
      <div className='grid gap-3'>
        <h2 className='font-display text-sm font-semibold'>Size</h2>
        <div className='grid grid-cols-2 gap-2'>
          <PixelField label='Width (px)' value={cw} min={16} max={W} disabled={busy} onCommit={(px) => setCrop(setSize(crop, { w: px / W }, ratio, W, H))} />
          <PixelField label='Height (px)' value={ch} min={16} max={H} disabled={busy} onCommit={(px) => setCrop(setSize(crop, { h: px / H }, ratio, W, H))} />
        </div>
      </div>
      <div className='grid gap-3'>
        <h2 className='font-display text-sm font-semibold'>Edges</h2>
        {EDGES.map(({ id, label }) => { const size = id === 'top' || id === 'bottom' ? H : W;
          return <div key={id} className='grid grid-cols-[minmax(0,1fr)_72px] items-end gap-2'>
            <label className='grid gap-1.5 text-xs'><span className='text-muted-foreground'>{label}</span>
              <input aria-label={label} type='range' min={0} max={0.95} step={1 / size} value={edges[id]} disabled={busy}
                onChange={(e) => setCrop(setEdge(crop, id, Number(e.target.value), ratio, W, H))} className='min-h-8 w-full accent-primary' /></label>
            <PixelField hideLabel label={`${label} (px)`} value={Math.round(edges[id] * size)} min={0} max={size - 16} disabled={busy} onCommit={(px) => setCrop(setEdge(crop, id, px / size, ratio, W, H))} />
          </div>; })}
      </div>
      <div className='grid gap-3'>
        <h2 className='font-display text-sm font-semibold'>Zoom &amp; position</h2>
        <label className='grid gap-1.5 text-xs'><span className='flex justify-between text-muted-foreground'><span>Zoom</span><span className='tabular-nums'>{zoom.toFixed(2)}×</span></span>
          <input aria-label='Zoom' type='range' min={1} max={Math.max(1.01, maxZoom)} step={0.01} value={Math.min(zoom, maxZoom)} disabled={busy}
            onChange={(e) => setCrop(setZoom(crop, Number(e.target.value), W, H))} className='min-h-8 w-full accent-primary' /></label>
        <label className='grid gap-1.5 text-xs'><span className='text-muted-foreground'>Pan left / right</span>
          <input aria-label='Pan horizontally' type='range' min={crop.w / 2} max={1 - crop.w / 2} step={1 / W} value={crop.x + crop.w / 2} disabled={busy || crop.w > 0.9999}
            onChange={(e) => setCrop(panTo(crop, Number(e.target.value), crop.y + crop.h / 2))} className='min-h-8 w-full accent-primary' /></label>
        <label className='grid gap-1.5 text-xs'><span className='text-muted-foreground'>Pan up / down</span>
          <input aria-label='Pan vertically' type='range' min={crop.h / 2} max={1 - crop.h / 2} step={1 / H} value={crop.y + crop.h / 2} disabled={busy || crop.h > 0.9999}
            onChange={(e) => setCrop(panTo(crop, crop.x + crop.w / 2, Number(e.target.value)))} className='min-h-8 w-full accent-primary' /></label>
        <div className='grid grid-cols-2 gap-2'>
          <PixelField label='Position X (px)' value={Math.round(crop.x * W)} min={0} max={W - cw} disabled={busy} onCommit={(px) => setCrop(dragCrop(crop, 'move', px / W - crop.x, 0, ratio, W, H))} />
          <PixelField label='Position Y (px)' value={Math.round(crop.y * H)} min={0} max={H - ch} disabled={busy} onCommit={(px) => setCrop(dragCrop(crop, 'move', 0, px / H - crop.y, ratio, W, H))} />
        </div>
        <p className='text-[11px] text-muted-foreground'><span className='hidden md:inline'>Drag the box or its handles. Ctrl + scroll zooms. Arrow keys nudge the focused box.</span>
          <span className='md:hidden'>Drag the box or its handles. Pinch with two fingers to zoom and move.</span></p>
      </div>
      <div className='grid gap-2'>
        <h2 className='font-display text-sm font-semibold'>Live preview</h2>
        <LivePreview video={video} crop={crop} aspect={croppedAspect} />
      </div>
      {plan.cleanup.length > 0 && <div className='grid gap-2 rounded-xl border border-border p-3 text-xs text-muted-foreground'>
        <p>This video has {plan.cleanup.length} overlay cleanup region{plan.cleanup.length > 1 ? 's' : ''} from an earlier version of Quick Reframe. They are kept unless you remove them.</p>
        <Button type='button' size='sm' variant='secondary' disabled={busy} onClick={() => onChange({ ...plan, cleanup: [] })}>Remove overlay cleanup</Button></div>}
      <p className='text-[11px] text-muted-foreground'>You decide the crop; XeeClip does not detect or move anything here. If the video is someone else&apos;s, keep the credit they require.</p>
    </aside>

    <div className={cn('sticky z-20 flex gap-2 rounded-2xl border border-border bg-background/95 p-3 backdrop-blur-xl lg:hidden',
      expanded ? 'fixed inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))]' : 'bottom-[calc(var(--bottom-nav-h,0px)+env(safe-area-inset-bottom)+8px)] md:bottom-4')}>
      {resetButton}{cancel}
      <span className='hidden flex-1 items-center text-xs tabular-nums text-muted-foreground md:flex'>{cw} × {ch} px · {shapeLabel}</span>
      {done('crop-done')}
    </div>
  </div>;
  // Rendered on <body> so no transformed ancestor can turn `fixed` into page-relative positioning.
  return expanded ? createPortal(workspace, document.body) : workspace;
}
