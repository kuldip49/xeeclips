'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bot, Download, Loader2, Pencil, Trash2 } from 'lucide-react';
import { deleteHistoryClip, getPublicApiBaseUrl, listHistory, type HistoryClip } from '@/lib/api';
import { materializeGeneratedClipForEditing } from '@/lib/edit-mode-api';
import { OfflineNotice } from '@/components/offline-notice';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { clipDuration } from '@/lib/format';
import { isServerUnavailable } from '@/lib/use-backend-status';

let cachedHistory: HistoryClip[] | null = null;

function groupFor(date: string) {
  const created = new Date(date);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const yesterday = new Date(start.getTime() - 86_400_000);
  return created >= start ? 'Today' : created >= yesterday ? 'Yesterday' : 'Earlier';
}

function HistoryCard({ clip, onDelete }: { clip: HistoryClip; onDelete?: (clip: HistoryClip) => void }) {
  const router = useRouter();
  const [opening, setOpening] = useState<'edit' | 'ai' | null>(null);
  const [error, setError] = useState('');
  const playback = clip.playbackUrl ? `${getPublicApiBaseUrl()}${clip.playbackUrl}` : null;
  const poster = clip.thumbnailUrl ? `${getPublicApiBaseUrl()}${clip.thumbnailUrl}` : undefined;
  const open = async (panel: 'edit' | 'ai') => {
    setOpening(panel); setError('');
    try {
      const url = clip.editUrl ?? (await materializeGeneratedClipForEditing(clip.id)).editUrl;
      router.push(panel === 'ai' ? `${url}${url.includes('?') ? '&' : '?'}panel=ai` : url);
    } catch { setError('This clip could not be opened. Try again.'); setOpening(null); }
  };
  return <article className='grid min-w-0 gap-4 overflow-hidden rounded-[20px] border border-border bg-surface p-3 shadow-card transition-colors hover:border-border-strong sm:grid-cols-[180px_minmax(0,1fr)] sm:p-4'>
    {playback ? <video controls playsInline preload='none' poster={poster} src={playback} aria-label={`Preview ${clip.title}`}
      className='mx-auto aspect-[9/16] max-h-[360px] w-full max-w-[202px] rounded-xl bg-black object-contain sm:max-h-[320px]' />
      : <div role='status' className='mx-auto grid aspect-[9/16] max-h-[360px] w-full max-w-[202px] place-items-center rounded-xl bg-black p-4 text-center text-sm text-muted-foreground'>{clip.status}</div>}
    <div className='flex min-w-0 flex-col gap-3'>
      <div>
        <h3 className='line-clamp-2 text-base font-semibold leading-snug'>{clip.title}</h3>
        <p className='mt-1 truncate text-xs text-muted-foreground'>{clip.sourceLabel}</p>
        <p className='mt-2 text-xs text-muted-foreground'>{new Date(clip.createdAt).toLocaleString()} · {clipDuration(clip.duration)}</p>
      </div>
      <div className='flex flex-wrap gap-1.5 text-xs'>
        {[clip.style, clip.mode, clip.status].map((item) => <span key={item} className='rounded-full border border-border bg-tint px-2.5 py-1 text-soft'>{item}</span>)}
      </div>
      <div className='mt-auto grid grid-cols-2 gap-2 sm:flex sm:flex-wrap'>
        <button type='button' onClick={() => void open('edit')} disabled={!clip.editable || !!opening}
          className='inline-flex h-11 items-center justify-center gap-1.5 rounded-xl sm:h-10 border border-border px-3 text-sm font-medium text-soft transition-colors hover:border-border-strong hover:bg-tint hover:text-foreground disabled:opacity-50'>
          {opening === 'edit' ? <Loader2 size={15} className='animate-spin' /> : <Pencil size={15} />}Edit</button>
        <button type='button' onClick={() => void open('ai')} disabled={!clip.editable || !!opening}
          className='inline-flex h-11 items-center justify-center gap-1.5 rounded-xl sm:h-10 border border-border px-3 text-sm font-medium text-soft transition-colors hover:border-border-strong hover:bg-tint hover:text-foreground disabled:opacity-50'>
          {opening === 'ai' ? <Loader2 size={15} className='animate-spin' /> : <Bot size={15} />}Ask AI</button>
        {onDelete ? <>
          <a href={playback ? `${playback}${playback.includes('?') ? '&' : '?'}download=1` : '#'} download aria-disabled={!clip.exportable} className={`btn-primary inline-flex h-11 items-center justify-center gap-1.5 rounded-xl sm:h-10 px-3 text-sm ${!clip.exportable ? 'pointer-events-none opacity-50' : ''}`}><Download size={15} />Export</a>
          <button type='button' onClick={() => onDelete(clip)} className='inline-flex h-11 items-center justify-center gap-1.5 rounded-xl sm:h-10 border border-danger/25 px-3 text-sm font-medium text-danger transition-colors hover:bg-danger/10'><Trash2 size={15} />Delete</button>
        </> : null}
      </div>
      {error ? <p role='alert' className='text-xs text-danger-soft'>{error}</p> : null}
    </div>
  </article>;
}

export function HistoryView({ mode = 'history' }: { mode?: 'history' | 'edit' }) {
  const [clips, setClips] = useState<HistoryClip[]>(cachedHistory ?? []);
  const [loading, setLoading] = useState(!cachedHistory);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const [selected, setSelected] = useState<HistoryClip | null>(null);
  const [deleting, setDeleting] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const items = await listHistory();
      cachedHistory = items;
      setClips(items);
      setError('');
      setOffline(false);
    } catch (caught) {
      const unavailable = isServerUnavailable(caught);
      setOffline(unavailable);
      setError(unavailable ? '' : 'History could not be loaded. Try again.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const remove = async () => {
    if (!selected) return;
    setDeleting(true); setError('');
    try {
      await deleteHistoryClip(selected.id);
      setClips((current) => { const next = current.filter((item) => item.id !== selected.id); cachedHistory = next; return next; });
      setSelected(null);
    } catch { setError('This clip could not be deleted. Try again.'); }
    finally { setDeleting(false); }
  };
  const groups = ['Today', 'Yesterday', 'Earlier'] as const;
  const visibleClips = mode === 'edit' ? clips.filter((clip) => clip.editable) : clips;
  return <div className='grid gap-7'>
    <header><p className='eyebrow'>Your clips</p><h1 className='mt-2 text-3xl font-bold tracking-tight sm:text-4xl'>{mode === 'edit' ? 'Edit clips' : 'History'}</h1>
      <p className='mt-2 text-sm text-muted-foreground'>{mode === 'edit' ? 'Choose a clip to edit or open it in Ask AI.' : 'Every clip you create, newest first.'}</p></header>
    {offline ? <OfflineNotice onRetry={refresh} detail='Your clips are safe. They appear here again when it is back.' /> : null}
    {error ? <p role='alert' className='rounded-xl border border-warning/20 bg-warning/10 p-3 text-sm text-warning-soft'>{error} <button className='ml-2 underline' onClick={() => void refresh()}>Retry</button></p> : null}
    {loading ? <p role='status' className='flex items-center gap-2 text-sm text-muted-foreground'><Loader2 size={17} className='animate-spin text-secondary' />Loading clips…</p>
      : visibleClips.length ? groups.map((group) => {
        const items = visibleClips.filter((clip) => groupFor(clip.createdAt) === group);
        return items.length ? <section key={group} className='grid gap-3'><h2 className='text-sm font-semibold text-soft'>{group}</h2>
          <div className='grid gap-4 lg:grid-cols-2'>{items.map((clip) => <HistoryCard key={clip.id} clip={clip} onDelete={mode === 'history' ? setSelected : undefined} />)}</div></section> : null;
      }) : !error && !offline ? <div className='empty-state'><h2 className='text-lg font-semibold'>{mode === 'edit' ? 'No clips to edit yet.' : 'No clips yet.'}</h2>
        <p className='mt-2 text-sm text-muted-foreground'>{mode === 'edit' ? 'Create clips first, then return here to edit them.' : 'Create your first clips and they\'ll appear here.'}</p>
        <Link href='/' className='btn-primary mt-5 inline-flex min-h-[44px] items-center rounded-xl px-5 text-sm'>Create clips</Link></div> : null}
    <ConfirmDialog open={!!selected} title='Delete this clip?' busy={deleting}
      description='This removes the clip from your history and cannot be undone.'
      confirmLabel='Delete' busyLabel='Deleting…' onConfirm={() => void remove()} onCancel={() => setSelected(null)} />
  </div>;
}
