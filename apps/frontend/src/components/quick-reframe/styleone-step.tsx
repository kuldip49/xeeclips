'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Captions, Crop, Download, Loader2, PenLine, SlidersHorizontal, Type, Undo2 } from 'lucide-react';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import { getEditProject, runManualEditCommand, undoEdit } from '@/lib/edit-mode-api';
import type { EditProject } from '@/lib/edit-mode-types';
import { applyQuickStyle, editorUrl, isProcessing, mediaUrl, QUICK_STYLE_LABEL, quickStyleOf, renderReframe, type ReframeSession } from '@/lib/quick-reframe-api';
import { SuggestedHooks, hookElementOf } from './hooks-panel';
import { PostCopyPanel } from './post-copy-panel';

/** The finished StyleOne / StyleTwo video: rendered preview plus the quick changes the brief asks for. */
export function StyleOneStep({ session, onSession, onStep, onError }: {
  session: ReframeSession; onSession: (s: ReframeSession) => void; onStep: (step: 'crop' | 'choose' | 'export') => void; onError: (message: string) => void;
}) {
  const style = quickStyleOf(session) ?? 'STYLEONE';
  const label = QUICK_STYLE_LABEL[style];
  const [project, setProject] = useState<EditProject | null>(null);
  const [sheet, setSheet] = useState<'hook' | 'captions' | null>(null);
  const [busy, setBusy] = useState(false);
  const processing = isProcessing(session);
  const previewCurrent = !!session.previewUrl && session.previewRevision === session.revision;
  const load = useCallback(() => getEditProject(session.editProjectId).then(setProject).catch(() => undefined), [session.editProjectId]);
  useEffect(() => { void load(); }, [load, session.revision]);
  const hook = project ? hookElementOf(project.elements ?? []) ?? (project.elements ?? []).find((e) => e.type === 'TEXT') : undefined;
  const captions = (project?.elements ?? []).filter((e) => e.type === 'SUBTITLE');
  const captionsVisible = captions.some((c) => c.properties.hidden !== true);
  /** One canonical command, then a fresh preview of the same composition. */
  const edit = async (task: (p: EditProject) => Promise<EditProject>) => {
    if (!project) return; setBusy(true);
    try { const next = await task(project); setProject(next);
      onSession(await renderReframe({ ...session, revision: next.revision }, 'preview')); setSheet(null); }
    catch (error) { onError(error instanceof Error ? error.message : 'The change could not be applied.'); }
    finally { setBusy(false); }
  };
  const restyle = async (options: Parameters<typeof applyQuickStyle>[2]) => {
    setBusy(true);
    try { onSession(await applyQuickStyle(session, style, options)); setSheet(null); }
    catch (error) { onError(error instanceof Error ? error.message : `${label} could not be applied.`); }
    finally { setBusy(false); }
  };
  const subtitleState = session.analysis?.subtitleState;
  return <div className='grid min-w-0 gap-6 md:grid-cols-[minmax(0,360px)_minmax(0,1fr)] md:items-start'>
    <div className='mx-auto grid w-full max-w-[360px] gap-2'>
      <div className='relative aspect-[9/16] w-full overflow-hidden rounded-2xl bg-black' data-testid={`${style.toLowerCase()}-preview`}>
        {previewCurrent && !processing ? <video key={session.previewUrl} src={mediaUrl(session.previewUrl)} controls playsInline preload='metadata' className='h-full w-full object-contain' aria-label={`${label} preview`} />
          : <div className='grid h-full place-items-center p-6 text-center text-sm text-muted-foreground'>
            {processing ? <span className='grid justify-items-center gap-3'><Loader2 className='animate-spin text-primary-soft' />{session.message}<progress className='w-40 accent-primary' max={100} value={session.progress} /></span>
              : <span className='grid justify-items-center gap-3'>Your latest changes need a fresh preview.<Button type='button' disabled={busy} onClick={() => void edit(async (p) => p)}>Render preview</Button></span>}
          </div>}
      </div>
      <p className='text-center text-xs text-muted-foreground'>Preview at 540 × 960 · exports at 1080 × 1920 with the same layout</p>
    </div>
    <div className='grid min-w-0 content-start gap-4'>
      <div><p className='eyebrow'>{label}</p><h2 className='mt-1 font-display text-2xl font-bold tracking-tight'>Your styled video</h2>
        <p className='mt-2 text-sm text-muted-foreground'>{style === 'STYLETWO'
          ? <>The full video and original sound, inside StyleTwo&apos;s fixed media window on its white canvas with its condensed headline{captions.length ? ' and red boxed captions' : ''}.</>
          : <>The full video and original sound, inside StyleOne&apos;s fixed media window with its serif hook{captions.length ? ' and active-word captions' : ''}.</>}</p></div>
      {hook && <div className='rounded-xl border border-border bg-surface p-3'><p className='text-[11px] uppercase tracking-wider text-faint'>Hook</p><p className='mt-1 text-sm'>{String(hook.properties.content ?? '')}</p></div>}
      <div className='grid grid-cols-2 gap-2'>
        <Button type='button' variant='secondary' className='h-12' disabled={busy || processing} onClick={() => onStep('crop')}><Crop size={16} />Re-edit Crop</Button>
        <Button type='button' variant='secondary' className='h-12' disabled={busy || processing} onClick={() => setSheet('hook')}><Type size={16} />Change Hook</Button>
        <Button type='button' variant='secondary' className='h-12' disabled={busy || processing} onClick={() => setSheet('captions')}><Captions size={16} />Video Captions</Button>
        <Button type='button' variant='secondary' className='h-12' asChild><Link href={editorUrl(session)}><SlidersHorizontal size={16} />Edit More</Link></Button>
      </div>
      <PostCopyPanel session={session} onSession={onSession} busy={busy} />
      <Button type='button' size='lg' className='h-12' disabled={busy || processing} onClick={() => onStep('export')} data-testid='go-export'><Download size={16} />Export Video</Button>
      <button type='button' disabled={busy || processing} className='inline-flex items-center gap-1.5 justify-self-start text-xs text-muted-foreground hover:text-foreground disabled:opacity-40'
        onClick={() => void (async () => { setBusy(true); try { const undone = await undoEdit(session.editProjectId, session.revision); void undone; onStep('choose'); } catch (error) { onError(error instanceof Error ? error.message : 'Undo failed.'); } finally { setBusy(false); } })()}>
        <Undo2 size={13} />Undo {label}</button>
    </div>

    <BottomSheet open={sheet === 'hook'} onClose={() => setSheet(null)} title='Change hook' size='tall'>
      <SuggestedHooks session={session} onSession={onSession} current={hook ? String(hook.properties.content ?? '') : undefined} busy={busy}
        onApply={(text) => void restyle({ hookText: text, captions: captions.length ? 'KEEP' : 'OFF' })} />
      <p className='mt-3 text-[11px] text-muted-foreground'>{label} re-fits the new hook in its {style === 'STYLETWO' ? 'condensed headline' : 'serif'} typography above the media window. Undo restores the previous one.</p>
    </BottomSheet>
    <BottomSheet open={sheet === 'captions'} onClose={() => setSheet(null)} title='Video Captions'>
      <div className='grid gap-3 text-sm'>
        {captions.length ? <>
          <p>{captions.length} synchronized caption{captions.length > 1 ? 's' : ''} in {label}&apos;s {style === 'STYLETWO' ? 'red boxed' : 'active-word'} style.</p>
          <Button type='button' variant='secondary' disabled={busy} onClick={() => void edit((p) => runManualEditCommand(p.id, p.revision, { action: 'set-captions-visible', visible: !captionsVisible }))}>
            {captionsVisible ? 'Hide captions' : 'Show captions'}</Button>
          <Button type='button' variant='ghost' asChild><Link href={`${editorUrl(session)}`}><PenLine size={15} />Correct wording or timing in the editor</Link></Button>
        </> : subtitleState === 'EXISTING_READABLE' ? <><p>Captions detected.</p><p className='text-xs text-muted-foreground'>Your video already shows readable captions, so {label} keeps them and adds no duplicates.</p></>
          : session.hasTranscript ? <><p>No captions detected. Add captions?</p>
            <Button type='button' disabled={busy} onClick={() => void restyle({ hookText: hook ? String(hook.properties.content ?? '') : '', captions: 'GENERATE' })}>Generate Captions</Button></>
            : <p className='text-muted-foreground'>No speech was found, so captions cannot be generated.</p>}
      </div>
    </BottomSheet>
  </div>;
}
