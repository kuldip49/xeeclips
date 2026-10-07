'use client';
import { useEffect, useState } from 'react';
import { Captions, Check, Loader2, Pencil, RefreshCw, Sparkles, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { analyzeReframe, HOOK_CATEGORY_LABEL, isProcessing, reframeRequest, requestHooks, type ReframeHook, type ReframeSession } from '@/lib/quick-reframe-api';
import { intoCrop } from '@/lib/quick-reframe-crop';
import type { ManualEditCommand } from '@/lib/edit-mode-api';
import type { EditElement, EditProject } from '@/lib/edit-mode-types';
import { cn } from '@/lib/utils';

/**
 * "Suggested Hooks": shared categories ranked by relevance, accuracy, clarity and engagement, with the
 * strongest marked Recommended. Transcript text reaches OpenAI only when the user ticks the consent box
 * for that request; otherwise suggestions are written locally from the transcript.
 */
export function SuggestedHooks({ session, onSession, onApply, current, busy, compact = false }: {
  session: ReframeSession; onSession: (session: ReframeSession) => void; onApply: (text: string) => void;
  current?: string; busy: boolean; compact?: boolean;
}) {
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [own, setOwn] = useState('');
  const [direction, setDirection] = useState('Rewrite');
  const [category, setCategory] = useState('');
  const generate = async (regenerate = false) => {
    setLoading(true); setWarnings([]);
    try { const result = await requestHooks(session.id, consent, regenerate ? session.hooks.map((hook) => hook.text) : [], {direction,category:category ? category as ReframeHook['category'] : undefined});
      onSession(result.session); setWarnings(result.warnings); }
    catch (error) { setWarnings([error instanceof Error ? error.message : 'Hook suggestions are unavailable.']); }
    finally { setLoading(false); }
  };
  const hooks = session.hooks;
  // The speech/caption check starts only after an editing mode is chosen; follow it until it finishes.
  const checking = !session.analysis;
  const running = isProcessing(session);
  useEffect(() => {
    if (!checking || !running) return;
    const timer = window.setInterval(() => { reframeRequest(`/${session.id}`).then(onSession).catch(() => undefined); }, 2000);
    return () => clearInterval(timer);
  }, [checking, running, session.id, onSession]);
  const check = async () => {
    setLoading(true); setWarnings([]);
    try { onSession(await analyzeReframe(session.id)); }
    catch (error) { setWarnings([error instanceof Error ? error.message : 'The video could not be checked.']); }
    finally { setLoading(false); }
  };
  return <section aria-label='Suggested Hooks' className='grid min-w-0 gap-3'>
    <div className='flex items-center justify-between gap-2'>
      <h3 className={cn('font-display font-semibold', compact ? 'text-xs uppercase tracking-wider text-soft' : 'text-sm')}>Suggested Hooks</h3>
      {hooks.length > 0 && <button type='button' disabled={loading || busy} onClick={() => void generate(true)} data-testid='regenerate-hooks' className='inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs text-primary-soft hover:bg-tint disabled:opacity-40'>
        <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />Regenerate</button>}
    </div>
    {checking && (running
      ? <p role='status' className='flex items-center gap-2 text-xs text-muted-foreground' data-testid='hooks-checking'><Loader2 size={14} className='animate-spin text-primary-soft' />Checking your video&apos;s speech and captions…</p>
      : <div className='grid gap-2'><p className='text-xs text-muted-foreground'>{session.error || 'Your video has not been checked for speech and captions yet.'}</p>
        <Button type='button' size='sm' variant='secondary' disabled={loading || busy} onClick={() => void check()}>Check video</Button></div>)}
    {!checking && !session.hasTranscript && <p className='text-xs text-muted-foreground'>No speech was found in this video, so hooks cannot be suggested. Write your own below.</p>}
    {!checking && session.hasTranscript && <label className='flex items-start gap-2 text-[11px] leading-5 text-muted-foreground'>
      <input type='checkbox' className='mt-1' checked={consent} onChange={(e) => setConsent(e.target.checked)} />
      Use OpenAI for stronger suggestions (sends a compact package of retained speech, visible text and source context; video stays on XeeClip). Unticked, suggestions are written locally.</label>}
    {!checking && session.hasTranscript && !hooks.length && <Button type='button' disabled={loading || busy} onClick={() => void generate()} data-testid='generate-hooks'>
      {loading ? <Loader2 size={15} className='animate-spin' /> : <Sparkles size={15} />}{loading ? 'Analyzing your video…' : 'Suggest hooks'}</Button>}
    {!checking && session.hasTranscript && <div className='grid grid-cols-2 gap-2'>
      <label className='grid gap-1 text-xs'>Category<select aria-label='Hook category' value={category} onChange={e => setCategory(e.target.value)} className='min-h-10 rounded-lg border border-border bg-background px-2'>
        <option value=''>All suitable tones</option>{Object.entries(HOOK_CATEGORY_LABEL).map(([value,label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label className='grid gap-1 text-xs'>Rewrite<select aria-label='Hook rewrite direction' value={direction} onChange={e => setDirection(e.target.value)} className='min-h-10 rounded-lg border border-border bg-background px-2'>
        {['Rewrite','Stronger / bolder','Funnier','More sarcastic','More professional','Shorter'].map(value => <option key={value}>{value}</option>)}
      </select></label>
    </div>}
    {warnings.map((w) => <p key={w} className='text-[11px] text-warning-soft'>{w}</p>)}
    <ul className='grid gap-2'>{hooks.map((hook: ReframeHook) => {
      const applied = current?.trim() === hook.text;
      return <li key={hook.text} className={cn('grid gap-2 rounded-xl border p-3', hook.recommended ? 'border-primary/50 bg-primary/10' : 'border-border bg-tint-subtle')} data-testid='hook-card'>
        <div className='flex flex-wrap items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider'>
          <span className='rounded-md bg-tint-strong px-1.5 py-0.5 text-soft'>{HOOK_CATEGORY_LABEL[hook.category]}</span>
          {hook.recommended && <span className='inline-flex items-center gap-1 rounded-md bg-primary/20 px-1.5 py-0.5 text-primary-soft'><Star size={10} aria-hidden />Recommended</span>}
        </div>
        {editing === hook.text ? <textarea aria-label='Edit hook text' maxLength={160} rows={2} value={draft} onChange={(e) => setDraft(e.target.value)}
          className='min-h-11 w-full rounded-lg border border-border bg-background p-2 text-sm' />
          : <p className='text-sm leading-snug'>{hook.text}</p>}
        <div className='flex gap-2'>
          {editing === hook.text ? <><Button type='button' size='sm' className='flex-1' disabled={busy || !draft.trim()} onClick={() => { onApply(draft.trim()); setEditing(null); }}><Check size={14} />Apply</Button>
            <Button type='button' size='sm' variant='ghost' onClick={() => setEditing(null)}>Cancel</Button></>
            : <><Button type='button' size='sm' className='flex-1' variant={applied ? 'secondary' : 'default'} disabled={busy || applied} onClick={() => onApply(hook.text)}>{applied ? <><Check size={14} />Applied</> : 'Apply'}</Button>
              <Button type='button' size='sm' variant='ghost' aria-label={`Edit "${hook.text}"`} onClick={() => { setEditing(hook.text); setDraft(hook.text); }}><Pencil size={14} />Edit</Button></>}
        </div>
      </li>;
    })}</ul>
    {hooks.length > 0 && <p className='text-[11px] text-muted-foreground'>Ranked by relevance to your video, accuracy, clarity and engagement. A ranking is a quality judgement, not a promise of views.</p>}
    <div className='grid gap-2 border-t border-border pt-3'>
      <label htmlFor='own-hook' className='text-xs font-semibold'>Write your own hook</label>
      <textarea id='own-hook' maxLength={160} rows={2} value={own} onChange={(e) => setOwn(e.target.value)} placeholder='What should viewers know in the first second?'
        className='min-h-11 w-full rounded-lg border border-border bg-background p-2 text-sm' />
      <Button type='button' variant='secondary' size='sm' disabled={busy || !own.trim()} onClick={() => { onApply(own.trim()); setOwn(''); }}>Use my hook</Button>
    </div>
  </section>;
}

export const hookElementOf = (elements: EditElement[]) => elements.find((e) => e.type === 'TEXT' &&
  ['HOOK'].includes(String(e.properties.presetRole ?? e.properties.templateRole ?? e.properties.role ?? '').toUpperCase()));

const CANVAS_ASPECT: Record<string, number> = { '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 };
/** Where the video sits on the canvas (normalized), matching the renderer's FIT/FILL rules. */
function videoRect(project: EditProject, source: { width: number; height: number }) {
  const settings = (project.settings ?? {}) as Record<string, unknown>;
  const layout = settings.resolvedVisualLayout as { videoFrame?: { x: number; y: number; width: number; height: number } } | null | undefined;
  if (layout?.videoFrame) return { x: layout.videoFrame.x, y: layout.videoFrame.y, w: layout.videoFrame.width, h: layout.videoFrame.height };
  const videoAspect = source.width / Math.max(1, source.height);
  const canvasAspect = CANVAS_ASPECT[String(settings.aspectRatio)] ?? videoAspect;
  const segment = (project.elements ?? []).find((e) => e.type === 'VIDEO');
  const fit = segment?.properties.frameLayout === 'FIT' || settings.reframePolicy === 'SOURCE' || !CANVAS_ASPECT[String(settings.aspectRatio)];
  if (!fit || Math.abs(videoAspect - canvasAspect) < 0.01) return { x: 0, y: 0, w: 1, h: 1 };
  return videoAspect > canvasAspect ? { x: 0, y: (1 - canvasAspect / videoAspect) / 2, w: 1, h: canvasAspect / videoAspect }
    : { x: (1 - videoAspect / canvasAspect) / 2, y: 0, w: videoAspect / canvasAspect, h: 1 };
}
/** Size a hook to at most three lines of the HOOK style (uppercase Inter ExtraBold, 600-unit design width). */
export function fitHook(text: string, canvasAspect: number, boxWidth = 0.84) {
  const em = 0.62, line = boxWidth * 600, length = Math.max(1, text.length);
  const fontSize = Math.max(28, Math.min(82, Math.floor(line * 3 / (length * em))));
  const lines = Math.max(1, Math.ceil(length * em * fontSize / line));
  const height = Math.min(0.6, Math.max(0.04, (lines * fontSize * 1.08 + 36) / (600 / canvasAspect)));
  return { fontSize, height: Number(height.toFixed(4)) };
}
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** The Manual editor's Hooks tool: suggestions, position presets, display time and the caption decision. */
export function QuickReframeHooksTool({ session, project, busy, onSession, onCommand, onCommands, onSelectElement, onOpenTool }: {
  session: ReframeSession; project: EditProject; busy: boolean; onSession: (s: ReframeSession) => void;
  onCommand: (command: ManualEditCommand) => void; onCommands: (commands: ManualEditCommand[]) => void;
  onSelectElement: (id: string) => void; onOpenTool: (tool: 'TEXT' | 'CAPTIONS') => void;
}) {
  const elements = project.elements ?? [];
  const hook = hookElementOf(elements);
  const source = { width: session.sourceWidth || 16, height: session.sourceHeight || 9 };
  const video = videoRect(project, source);
  const hookHeight = Number(hook?.properties.height ?? 0.12);
  const totalDuration = Math.max(0, ...elements.filter((e) => e.type === 'VIDEO').map((e) => e.startTime + e.duration));
  const settings = (project.settings ?? {}) as Record<string, unknown>;
  const canvasAspect = CANVAS_ASPECT[String(settings.aspectRatio)] ?? source.width / Math.max(1, source.height);
  const apply = (text: string) => {
    const fit = fitHook(text, canvasAspect, Number(hook?.properties.width ?? 0.84));
    if (hook) onCommands([{ action: 'set-text-content', elementId: hook.id, content: text },
      { action: 'set-text-size', elementId: hook.id, fontSize: fit.fontSize },
      { action: 'resize-element', elementId: hook.id, width: Number(hook.properties.width ?? 0.84), height: fit.height }]);
    else onCommand({ action: 'add-text', textStyleId: 'HOOK', content: text, origin: 'ASSISTANT', presetRole: 'HOOK',
      fontSize: fit.fontSize, height: fit.height });
  };
  const band = video.y;
  const positions = [
    { id: 'ABOVE', label: 'Above video', y: band >= hookHeight + 0.02 ? Math.max(0.01, (band - hookHeight) / 2) : null },
    { id: 'TOP', label: 'Top inside video', y: video.y + video.h * 0.04 },
    { id: 'CENTER', label: 'Center', y: video.y + video.h / 2 - hookHeight / 2 }
  ];
  const place = (y: number) => { if (hook) onCommand({ action: 'move-element', elementId: hook.id, x: Number(hook.properties.x ?? 0.05), y: Math.max(0, Math.min(1 - hookHeight, y)) }); };
  // Faces are measured on the original upload; map them through the confirmed crop onto the canvas.
  const warning = (() => {
    if (!hook || !session.analysis || !session.confirmed) return '';
    const box = { x: Number(hook.properties.x ?? 0), y: Number(hook.properties.y ?? 0), w: Number(hook.properties.width ?? 0.9), h: hookHeight };
    const visible = (t: number) => t >= hook.startTime && t < hook.startTime + hook.duration;
    for (const frame of session.analysis.frames) {
      if (!visible(frame.t)) continue;
      for (const face of frame.faces) {
        const inside = intoCrop(face, session.confirmed.crop); if (!inside) continue;
        const onCanvas = { x: video.x + inside.x * video.w, y: video.y + inside.y * video.h, w: inside.w * video.w, h: inside.h * video.h };
        const overlap = Math.max(0, Math.min(box.x + box.w, onCanvas.x + onCanvas.w) - Math.max(box.x, onCanvas.x)) * Math.max(0, Math.min(box.y + box.h, onCanvas.y + onCanvas.h) - Math.max(box.y, onCanvas.y));
        if (overlap > onCanvas.w * onCanvas.h * 0.15) return `The hook covers a face around ${clock(frame.t)}. Try another position.`;
      }
    }
    const captions = elements.filter((e) => e.type === 'SUBTITLE');
    if (captions.some((c) => { const y = Number(c.properties.y ?? 0.8), h = Number(c.properties.height ?? 0.1); return y < box.y + box.h && box.y < y + h; }))
      return 'The hook overlaps your captions. Choose another position.';
    return '';
  })();
  const subtitleState = session.analysis?.subtitleState;
  const hasCaptions = elements.some((e) => e.type === 'SUBTITLE');
  return <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5'>
    <SuggestedHooks session={session} onSession={onSession} onApply={apply} current={hook ? String(hook.properties.content ?? '') : undefined} busy={busy} compact />
    {hook && <section aria-label='Hook position' className='grid gap-2'>
      <h3 className='text-xs font-semibold uppercase tracking-wider text-soft'>Position</h3>
      <div className='grid grid-cols-2 gap-2'>
        {positions.map((p) => <button key={p.id} type='button' disabled={busy || p.y === null} title={p.y === null ? 'Your video fills the frame. Make room above it first.' : undefined}
          onClick={() => p.y !== null && place(p.y)} className='min-h-10 rounded-lg border border-border px-2 text-xs font-medium hover:bg-tint disabled:opacity-40'>{p.label}</button>)}
        <button type='button' disabled={busy} onClick={() => onSelectElement(hook.id)} className='min-h-10 rounded-lg border border-border px-2 text-xs font-medium hover:bg-tint'>Custom (drag)</button>
      </div>
      {positions[0].y === null && <button type='button' disabled={busy} className='text-left text-[11px] text-primary-soft underline-offset-2 hover:underline'
        onClick={() => onCommand({ action: 'set-video-framing', mode: 'ASPECT', aspectRatio: '9:16', fitMode: 'FIT', scope: 'ALL_VIDEO_SEGMENTS' })}>Make room above the video (9:16 frame)</button>}
      {warning && <p role='alert' className='text-[11px] text-warning-soft'>{warning}</p>}
      <h3 className='mt-2 text-xs font-semibold uppercase tracking-wider text-soft'>Show hook for</h3>
      <div className='grid grid-cols-3 gap-2'>{[3, 5, 0].map((seconds) => {
        const duration = seconds ? Math.min(seconds, totalDuration) : totalDuration;
        return <button key={seconds} type='button' disabled={busy || !totalDuration} aria-pressed={Math.abs(hook.duration - duration) < 0.05}
          onClick={() => onCommand({ action: 'set-element-timing', elementId: hook.id, startTime: 0, duration })}
          className={cn('min-h-10 rounded-lg border px-2 text-xs font-medium', Math.abs(hook.duration - duration) < 0.05 ? 'border-primary/60 bg-primary/15' : 'border-border hover:bg-tint')}>{seconds ? `First ${seconds}s` : 'Whole video'}</button>;
      })}</div>
      <Button type='button' size='sm' variant='secondary' disabled={busy} onClick={() => { onSelectElement(hook.id); onOpenTool('TEXT'); }}>Font, color & background</Button>
    </section>}
    <section aria-label='Captions decision' className='grid gap-2 border-t border-border pt-4'>
      <h3 className='flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-soft'><Captions size={13} />Captions</h3>
      {!session.analysis && !hasCaptions ? <p className='text-xs text-muted-foreground'>Available once XeeClip has checked the speech and on-screen captions.</p>
        : hasCaptions ? <><p className='text-xs text-muted-foreground'>Captions added to your video.</p>
        <Button type='button' size='sm' variant='secondary' onClick={() => onOpenTool('CAPTIONS')}>Customize captions</Button></>
        : subtitleState === 'EXISTING_READABLE' ? <><p className='text-xs'>Captions detected.</p><p className='text-[11px] text-muted-foreground'>Your video already shows readable captions, so XeeClip keeps them and adds no duplicates.</p>
          <details className='text-[11px] text-muted-foreground'><summary className='cursor-pointer'>Add new captions anyway</summary>
            <p className='mt-1'>Only do this if you cropped or covered the original captions, or they will appear twice.</p>
            <Button type='button' size='sm' variant='ghost' className='mt-1' disabled={busy || !session.hasTranscript} onClick={() => onCommand({ action: 'generate-captions' })}>Generate captions</Button></details></>
          : session.hasTranscript ? <><p className='text-xs'>{subtitleState === 'MISSING' ? 'No captions detected. Add captions?' : 'Some on-screen text may be captions. Add captions?'}</p>
            <Button type='button' size='sm' disabled={busy} onClick={() => onCommand({ action: 'generate-captions' })} data-testid='generate-captions'>Generate Captions</Button></>
            : <p className='text-xs text-muted-foreground'>No speech was found, so captions cannot be generated.</p>}
    </section>
  </div>;
}
