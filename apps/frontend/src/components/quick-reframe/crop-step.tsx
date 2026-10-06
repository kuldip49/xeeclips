'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Eye, EyeOff, Pause, Play, RotateCcw, ScanText, Sparkles, Wand2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { mediaUrl, suggestCrop, type ReframePlan, type ReframeSession, type ReframeBox, type ReframeAspect } from '@/lib/quick-reframe-api';
import { boxOf, CROP_SHAPES, cropProblems, dragCrop, fitRatio, FULL, insetsOf, isFull, shapeRatio, zoomCrop, type Handle, type Insets } from '@/lib/quick-reframe-crop';
import { cn } from '@/lib/utils';

const HANDLES: Array<{ id: Handle; style: React.CSSProperties; cursor: string }> = [
  { id: 'nw', style: { left: 0, top: 0 }, cursor: 'nwse-resize' }, { id: 'ne', style: { left: '100%', top: 0 }, cursor: 'nesw-resize' },
  { id: 'sw', style: { left: 0, top: '100%' }, cursor: 'nesw-resize' }, { id: 'se', style: { left: '100%', top: '100%' }, cursor: 'nwse-resize' },
  { id: 'n', style: { left: '50%', top: 0 }, cursor: 'ns-resize' }, { id: 's', style: { left: '50%', top: '100%' }, cursor: 'ns-resize' },
  { id: 'w', style: { left: 0, top: '50%' }, cursor: 'ew-resize' }, { id: 'e', style: { left: '100%', top: '50%' }, cursor: 'ew-resize' }
];
const pct = (v: number) => `${v * 100}%`;
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const chip = (active: boolean) => cn('min-h-10 rounded-xl border px-3 text-xs font-semibold transition-colors',
  active ? 'border-primary/60 bg-primary/15 text-foreground' : 'border-border bg-surface text-muted-foreground hover:bg-tint hover:text-foreground');

function Slider({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (v: number) => void }) {
  return <label className='grid gap-1.5 text-xs'>
    <span className='flex justify-between text-muted-foreground'><span>{label}</span><span className='tabular-nums text-soft'>{Math.round(value * 100)}%</span></span>
    <input aria-label={label} type='range' min={0} max={max} step={0.005} value={value} onChange={(e) => onChange(Number(e.target.value))} className='min-h-8 w-full accent-primary' />
  </label>;
}

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
  const [showText, setShowText] = useState(false);
  const [cleanOpen, setCleanOpen] = useState(plan.cleanup.length > 0);
  const [suggesting, setSuggesting] = useState<ReframeAspect | null>(null);
  const [note, setNote] = useState('');
  const W = session.width || 16, H = session.height || 9;
  const ratio = shapeRatio(plan.aspect);
  const problems = useMemo(() => cropProblems(plan, session.analysis), [plan, session.analysis]);
  const src = mediaUrl(session.originalUrl);
  const setCrop = useCallback((crop: ReframeBox, aspect: ReframeAspect = plan.aspect) =>
    onChange({ ...plan, crop, aspect, framing: 'CROP', tracking: undefined }), [onChange, plan]);

  // --- Gestures: one pointer drags a handle or moves the box; two pointers pinch-zoom. -------------
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ box: ReframeBox; x: number; y: number; handle: Handle; distance?: number } | null>(null);
  const down = (event: React.PointerEvent<HTMLDivElement>) => {
    if (view !== 'before') return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()];
    const handle = ((event.target as HTMLElement).closest('[data-handle]') as HTMLElement | null)?.dataset.handle as Handle | undefined;
    gesture.current = { box: { ...plan.crop }, x: event.clientX, y: event.clientY, handle: handle ?? 'move',
      distance: points.length === 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : undefined };
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current; if (!g || !pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const rect = event.currentTarget.getBoundingClientRect(); const points = [...pointers.current.values()];
    if (points.length === 2 && g.distance) {
      const now = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      setCrop(zoomCrop(g.box, g.distance / Math.max(1, now), ratio, W, H), plan.aspect === 'SOURCE' ? 'CUSTOM' : plan.aspect);
      return;
    }
    const next = dragCrop(g.box, g.handle, (event.clientX - g.x) / rect.width, (event.clientY - g.y) / rect.height, ratio, W, H);
    setCrop(next, plan.aspect === 'SOURCE' && g.handle !== 'move' ? 'CUSTOM' : plan.aspect);
  };
  const up = (event: React.PointerEvent<HTMLDivElement>) => { pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) gesture.current = null;
    else { const [rest] = [...pointers.current.values()]; gesture.current = { box: { ...plan.crop }, x: rest.x, y: rest.y, handle: 'move' }; } };
  // Wheel zoom on desktop; passive listeners cannot preventDefault, so it is attached manually.
  useEffect(() => {
    const element = stage.current; if (!element) return;
    // Ctrl + wheel (and trackpad pinch, which browsers report as Ctrl + wheel); plain scrolling still scrolls the page.
    const wheel = (event: WheelEvent) => { if (view !== 'before' || !event.ctrlKey) return; event.preventDefault();
      setCrop(zoomCrop(plan.crop, event.deltaY > 0 ? 1.04 : 0.96, ratio, W, H), plan.aspect === 'SOURCE' ? 'CUSTOM' : plan.aspect); };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [plan.crop, plan.aspect, ratio, W, H, view, setCrop]);

  const insets = insetsOf(plan.crop);
  const setInset = (edge: keyof Insets, value: number) => {
    const next = { ...insets, [edge]: value };
    if (next.left + next.right > 0.7 || next.top + next.bottom > 0.7) return;
    setCrop(boxOf(next), 'CUSTOM');
  };
  const chooseShape = async (aspect: ReframeAspect) => {
    setNote('');
    if (aspect === 'CUSTOM') { onChange({ ...plan, aspect, tracking: undefined, framing: 'CROP' }); return; }
    setSuggesting(aspect);
    try {
      const suggestion = await suggestCrop(session.id, aspect);
      const target = shapeRatio(aspect);
      // When a safe crop of that exact shape does not exist, the closest safe shape is used and explained.
      const crop = target && suggestion.framing === 'FIT' ? fitRatio(suggestion.crop, target, W, H) : suggestion.crop;
      onChange({ ...plan, aspect, crop, framing: 'CROP', tracking: suggestion.framing === 'CROP' ? suggestion.tracking ?? undefined : undefined });
      setNote(suggestion.framing === 'FIT' ? 'XeeClip could not find a crop of this shape that keeps every face and important detail. Check the highlighted problems or choose another shape.' :
        suggestion.tracking?.length ? 'Smart crop follows the main subject smoothly through the video.' : 'Smart crop keeps faces, captions and attribution inside the frame.');
    } catch (error) { setNote(error instanceof Error ? error.message : 'Crop suggestions are unavailable.'); }
    finally { setSuggesting(null); }
  };
  const smart = async () => chooseShape('SOURCE');
  const reset = () => { setNote(''); setCrop(FULL, 'SOURCE'); };

  // --- Playback shared by the before/after views. ---------------------------------------------------
  const toggle = () => { const v = video.current; if (!v) return; if (v.paused) void v.play().catch(() => undefined); else v.pause(); };
  useEffect(() => { const a = afterVideo.current, v = video.current; if (!a || !v) return;
    if (Math.abs(a.currentTime - time) > 0.2) a.currentTime = time;
    if (playing && a.paused) void a.play().catch(() => undefined); if (!playing && !a.paused) a.pause(); }, [time, playing, view]);
  const seek = (t: number) => { if (video.current) video.current.currentTime = t; setTime(t); };
  const live = session.analysis?.regions.filter((r) => r.start <= time && r.end > time) ?? [];
  const masks = plan.cleanup.filter((r) => r.start <= time && r.end > time);
  const croppedAspect = (plan.crop.w * W) / (plan.crop.h * H);

  return <div className='grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]'>
    <div className='grid min-w-0 content-start gap-3'>
      <div className='flex flex-wrap items-center gap-2' role='group' aria-label='Preview mode'>
        <button type='button' className={chip(view === 'before')} aria-pressed={view === 'before'} onClick={() => setView('before')}>Adjust crop</button>
        <button type='button' className={chip(view === 'after')} aria-pressed={view === 'after'} onClick={() => setView('after')}>Preview result</button>
        <button type='button' className={cn(chip(showText), 'ml-auto inline-flex items-center gap-1.5')} aria-pressed={showText}
          onClick={() => setShowText((v) => !v)}>{showText ? <EyeOff size={14} /> : <Eye size={14} />}Show detected text</button>
      </div>
      <div className='relative mx-auto grid w-full place-items-center overflow-hidden rounded-2xl bg-black' style={{ height: 'min(62vh, 640px)' }}>
        <div ref={stage} data-testid='crop-stage' className={cn('relative max-h-full max-w-full touch-none select-none', view === 'after' && 'hidden')}
          style={{ aspectRatio: `${W} / ${H}`, height: W / H < 1.2 ? '100%' : undefined, width: W / H >= 1.2 ? '100%' : undefined }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <video ref={video} src={src} playsInline preload='metadata' className='pointer-events-none h-full w-full object-contain'
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
          {masks.map((m, i) => <div key={i} aria-hidden className='pointer-events-none absolute' style={{ left: pct(m.x), top: pct(m.y), width: pct(m.w), height: pct(m.h),
            ...(m.method === 'COVER' ? { background: '#000' } : { backdropFilter: `blur(${Math.max(2, m.intensity)}px)`, WebkitBackdropFilter: `blur(${Math.max(2, m.intensity)}px)` }) }} />)}
          {showText && live.map((r) => <div key={r.id} aria-hidden className={cn('pointer-events-none absolute border', r.kind === 'ATTRIBUTION' ? 'border-warning' : 'border-secondary')}
            style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) }}>
            <span className='absolute left-0 top-0 max-w-full truncate bg-black/80 px-1 text-[10px] text-white'>{r.kind === 'ATTRIBUTION' ? 'attribution · kept' : r.kind.toLowerCase()} {Math.round(r.confidence * 100)}%</span></div>)}
          <div className='absolute cursor-move border-2 border-primary shadow-[0_0_0_9999px_rgba(0,0,0,.55)]' data-testid='crop-box'
            style={{ left: pct(plan.crop.x), top: pct(plan.crop.y), width: pct(plan.crop.w), height: pct(plan.crop.h) }}>
            <div aria-hidden className='pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3'>
              {Array.from({ length: 9 }).map((_, i) => <span key={i} className='border border-white/15' />)}</div>
            {HANDLES.map((h) => <span key={h.id} data-handle={h.id} aria-label={`Crop handle ${h.id}`} className='absolute grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 place-items-center'
              style={{ ...h.style, cursor: h.cursor }}>
              <span data-handle={h.id} className={cn('rounded-full border-2 border-white bg-primary shadow', h.id.length === 2 ? 'h-4 w-4' : 'h-3 w-6', (h.id === 'w' || h.id === 'e') && 'h-6 w-3')} /></span>)}
          </div>
        </div>
        {view === 'after' && <div className='relative max-h-full max-w-full overflow-hidden' data-testid='crop-result'
          style={{ aspectRatio: String(croppedAspect), height: croppedAspect < 1.2 ? '100%' : undefined, width: croppedAspect >= 1.2 ? '100%' : undefined }}>
          <video ref={afterVideo} src={src} muted playsInline preload='metadata' className='absolute max-w-none'
            style={{ width: pct(1 / plan.crop.w), height: pct(1 / plan.crop.h), left: pct(-plan.crop.x / plan.crop.w), top: pct(-plan.crop.y / plan.crop.h) }} />
          {masks.map((m, i) => <div key={i} aria-hidden className='pointer-events-none absolute' style={{ left: pct((m.x - plan.crop.x) / plan.crop.w), top: pct((m.y - plan.crop.y) / plan.crop.h), width: pct(m.w / plan.crop.w), height: pct(m.h / plan.crop.h),
            ...(m.method === 'COVER' ? { background: '#000' } : { backdropFilter: `blur(${Math.max(2, m.intensity)}px)`, WebkitBackdropFilter: `blur(${Math.max(2, m.intensity)}px)` }) }} />)}
        </div>}
      </div>
      <div className='flex min-w-0 items-center gap-3'>
        <button type='button' aria-label={playing ? 'Pause' : 'Play'} onClick={toggle} className='grid h-11 w-11 shrink-0 place-items-center rounded-full bg-tint-strong text-foreground'>
          {playing ? <Pause size={18} /> : <Play size={18} />}</button>
        <input aria-label='Seek' type='range' min={0} max={session.duration || 0} step={0.05} value={time} onChange={(e) => seek(Number(e.target.value))} className='min-h-8 min-w-0 flex-1 accent-primary' />
        <span className='shrink-0 text-xs tabular-nums text-muted-foreground'>{clock(time)} / {clock(session.duration)}</span>
      </div>
      <p className='text-xs text-muted-foreground'>The crop applies to the whole {session.duration.toFixed(1)}-second video. Nothing is trimmed, and the original sound is kept.
        {' '}Drag the box or its handles{' '}<span className='hidden md:inline'>(Ctrl + scroll to zoom)</span><span className='md:hidden'>or pinch to zoom</span>.</p>
    </div>

    <aside className='grid min-w-0 content-start gap-5 rounded-2xl border border-border bg-surface p-4 sm:p-5'>
      <div className='grid gap-2'>
        <h2 className='font-display text-sm font-semibold'>Shape</h2>
        <div className='flex flex-wrap gap-2'>{CROP_SHAPES.map((shape) => <button key={shape.id} type='button' className={chip(plan.aspect === shape.id)} aria-pressed={plan.aspect === shape.id}
          disabled={busy || !!suggesting} onClick={() => void chooseShape(shape.id)}>{suggesting === shape.id ? 'Finding…' : shape.label}</button>)}</div>
        <Button type='button' variant='secondary' className='justify-start' disabled={busy || !!suggesting} onClick={() => void smart()}><Sparkles size={15} />Smart crop suggestion</Button>
        {note && <p className='text-xs text-muted-foreground'>{note}</p>}
      </div>
      <div className='grid gap-3'>
        <h2 className='font-display text-sm font-semibold'>Crop edges</h2>
        <Slider label='From top' value={insets.top} max={0.45} onChange={(v) => setInset('top', v)} />
        <Slider label='From bottom' value={insets.bottom} max={0.45} onChange={(v) => setInset('bottom', v)} />
        <Slider label='From left' value={insets.left} max={0.45} onChange={(v) => setInset('left', v)} />
        <Slider label='From right' value={insets.right} max={0.45} onChange={(v) => setInset('right', v)} />
        <Button type='button' variant='ghost' className='justify-start' disabled={busy || isFull(plan.crop)} onClick={reset}><RotateCcw size={15} />Reset crop</Button>
      </div>
      <CleanOverlays session={session} plan={plan} open={cleanOpen} onToggle={() => setCleanOpen((v) => !v)} time={time} busy={busy} onChange={onChange} />
      {problems.length > 0 && <div role='alert' className='grid gap-1 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-warning-soft'>{problems.map((p) => <p key={p}>{p}</p>)}</div>}
      {plan.tracking?.length ? <p className='text-xs text-muted-foreground'>Subject tracking is on. The result preview shows the starting position; the confirmed video follows the subject.</p> : null}
    </aside>

    <div className='sticky bottom-[calc(var(--bottom-nav-h,0px)+env(safe-area-inset-bottom)+8px)] z-20 flex gap-2 rounded-2xl border border-border bg-background/95 p-3 backdrop-blur-xl md:bottom-4 lg:col-span-2'>
      <Button type='button' variant='secondary' className='h-12 flex-1 md:flex-none' disabled={busy} onClick={onCancel}><X size={16} />{confirmed ? 'Cancel' : 'Reset'}</Button>
      <span className='hidden flex-1 items-center text-xs text-muted-foreground md:flex'>{plan.crop.w < 0.999 || plan.crop.h < 0.999 ? `Keeps ${Math.round(plan.crop.w * plan.crop.h * 100)}% of the frame` : 'Full frame'}{plan.cleanup.length ? ` · ${plan.cleanup.length} overlay cleanup${plan.cleanup.length > 1 ? 's' : ''}` : ''}</span>
      <Button type='button' className='h-12 flex-1 md:flex-none md:px-8' disabled={busy || problems.length > 0} onClick={onDone} data-testid='crop-done'><Check size={16} />Done</Button>
    </div>
  </div>;
}

function CleanOverlays({ session, plan, open, onToggle, time, busy, onChange }: {
  session: ReframeSession; plan: ReframePlan; open: boolean; onToggle: () => void; time: number; busy: boolean; onChange: (plan: ReframePlan) => void;
}) {
  const [rights, setRights] = useState(plan.cleanup.length > 0);
  const [selected, setSelected] = useState('');
  const [owned, setOwned] = useState(false);
  const [manual, setManual] = useState<ReframeBox>({ x: 0.1, y: 0.05, w: 0.3, h: 0.1 });
  const [detecting, setDetecting] = useState(false);
  const regions = session.analysis?.regions.filter((r) => r.kind !== 'CAPTION' && r.kind !== 'INFORMATION') ?? [];
  const region = regions.find((r) => r.id === selected);
  const add = () => {
    const box = region ?? manual;
    onChange({ ...plan, cleanup: [...plan.cleanup, { x: box.x, y: box.y, w: box.w, h: box.h, regionId: region?.id ?? 'manual',
      start: region ? region.start : Math.max(0, time - 0.01), end: region ? region.end : session.duration, method: 'BLUR', intensity: 10, authorized: true,
      ownedBranding: region?.kind === 'ATTRIBUTION' && owned }] });
  };
  const auto = async () => {
    setDetecting(true);
    try { const suggestion = await suggestCrop(session.id, plan.aspect === 'CUSTOM' ? 'SOURCE' : plan.aspect, true);
      const fresh = suggestion.cleanup.filter((c) => !plan.cleanup.some((d) => d.regionId === c.regionId));
      onChange({ ...plan, cleanup: [...plan.cleanup, ...fresh].slice(0, 24) }); }
    finally { setDetecting(false); }
  };
  const update = (index: number, patch: Partial<ReframePlan['cleanup'][number]>) => onChange({ ...plan, cleanup: plan.cleanup.map((c, i) => i === index ? { ...c, ...patch } : c) });
  return <div className='grid gap-3 border-t border-border pt-4'>
    <button type='button' onClick={onToggle} aria-expanded={open} className='flex min-h-10 items-center justify-between text-left font-display text-sm font-semibold'>
      <span className='flex items-center gap-2'><ScanText size={16} className='text-primary-soft' />Clean overlays</span><ChevronDown size={16} className={cn('transition-transform', open && 'rotate-180')} /></button>
    {open && <div className='grid gap-3'>
      <p className='text-xs text-muted-foreground'>Blur or cover removable text and logos on videos you own or have permission to edit. Creator attribution is protected and stays visible.</p>
      <label className='flex items-start gap-2 text-xs'><input type='checkbox' className='mt-0.5' checked={rights} onChange={(e) => setRights(e.target.checked)} />I own this video or have permission to remove these overlays.</label>
      <Button type='button' variant='secondary' className='justify-start' disabled={!rights || busy || detecting} onClick={() => void auto()}><Wand2 size={15} />{detecting ? 'Detecting…' : 'Auto-detect removable overlays'}</Button>
      <select aria-label='Overlay to clean' className='min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm' value={selected} onChange={(e) => { setSelected(e.target.value); setOwned(false); }}>
        <option value=''>Draw a custom region</option>
        {regions.map((r) => <option key={r.id} value={r.id}>{(r.text || r.kind.toLowerCase()).slice(0, 40)} · {r.start.toFixed(1)}–{r.end.toFixed(1)}s{r.kind === 'ATTRIBUTION' ? ' · attribution' : ''}</option>)}
      </select>
      {!region && <div className='grid grid-cols-2 gap-2'>{(['x', 'y', 'w', 'h'] as const).map((k) => <label key={k} className='grid gap-1 text-[11px] text-muted-foreground'>
        {{ x: 'Left', y: 'Top', w: 'Width', h: 'Height' }[k]}
        <input aria-label={`Region ${k}`} type='range' className='accent-primary' min={k === 'w' || k === 'h' ? 0.02 : 0} step={0.005}
          max={k === 'w' ? 1 - manual.x : k === 'h' ? 1 - manual.y : k === 'x' ? 1 - manual.w : 1 - manual.h} value={manual[k]} onChange={(e) => setManual({ ...manual, [k]: Number(e.target.value) })} /></label>)}</div>}
      {region?.kind === 'ATTRIBUTION' && <label className='flex items-start gap-2 text-xs'><input type='checkbox' className='mt-0.5' checked={owned} onChange={(e) => setOwned(e.target.checked)} />This branding is my own. Removing it keeps any required attribution.</label>}
      <Button type='button' variant='secondary' disabled={!rights || busy || plan.cleanup.length >= 24 || (region?.kind === 'ATTRIBUTION' && !owned)} onClick={add}>Add cleanup region</Button>
      {plan.cleanup.map((c, i) => <div key={`${c.regionId}-${i}`} className='grid gap-2 rounded-xl border border-border p-3'>
        <div className='flex items-center gap-2'>
          <select aria-label={`Cleanup ${i + 1} method`} className='min-h-10 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-xs' value={c.method} onChange={(e) => update(i, { method: e.target.value as 'BLUR' | 'COVER' })}>
            <option value='BLUR'>Localized blur</option><option value='COVER'>Mask (cover)</option></select>
          <button type='button' aria-label='Remove cleanup region' className='grid h-10 w-10 place-items-center rounded-lg border border-border' onClick={() => onChange({ ...plan, cleanup: plan.cleanup.filter((_, j) => j !== i) })}><X size={14} /></button>
        </div>
        {c.method === 'BLUR' && <label className='grid gap-1 text-[11px] text-muted-foreground'>Blur strength<input type='range' className='accent-primary' min={1} max={30} step={1} value={c.intensity} onChange={(e) => update(i, { intensity: Number(e.target.value) })} /></label>}
        <p className='text-[11px] text-muted-foreground'>{c.start.toFixed(1)}s – {c.end.toFixed(1)}s</p>
      </div>)}
      {session.analysis && session.analysis.subtitleState !== 'MISSING' && <label className='flex items-start gap-2 text-xs'>
        <input type='checkbox' className='mt-0.5' checked={plan.captions.replaceExisting} onChange={(e) => onChange({ ...plan, captions: { ...plan.captions, replaceExisting: e.target.checked } })} />
        I will replace the video's own captions (allows cropping them out).</label>}
    </div>}
  </div>;
}
