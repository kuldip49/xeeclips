'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bot, Download, Loader2, Pencil, Trash2 } from 'lucide-react';
import { deleteHistoryClip, getPublicApiBaseUrl, listHistory, type HistoryClip } from '@/lib/api';
import { materializeGeneratedClipForEditing } from '@/lib/edit-mode-api';
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
  return <article className='grid min-w-0 gap-4 overflow-hidden rounded-[20px] border border-white/[.08] bg-[#111827] p-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:p-4'>
    {playback ? <video controls playsInline preload='none' poster={poster} src={playback} aria-label={`Preview ${clip.title}`}
      className='mx-auto aspect-[9/16] max-h-[360px] w-full max-w-[202px] rounded-xl bg-black object-contain sm:max-h-[320px]' />
      : <div role='status' className='mx-auto grid aspect-[9/16] max-h-[360px] w-full max-w-[202px] place-items-center rounded-xl bg-black p-4 text-center text-sm text-slate-400'>{clip.status}</div>}
    <div className='flex min-w-0 flex-col gap-3'>
      <div>
        <h3 className='line-clamp-2 text-base font-semibold leading-snug'>{clip.title}</h3>
        <p className='mt-1 truncate text-xs text-slate-400'>{clip.sourceLabel}</p>
        <p className='mt-2 text-xs text-slate-400'>{new Date(clip.createdAt).toLocaleString()} · {clipDuration(clip.duration)}</p>
      </div>
      <div className='flex flex-wrap gap-1.5 text-xs'>
        {[clip.style, clip.mode, clip.status].map((item) => <span key={item} className='rounded-full border border-white/10 bg-white/[.04] px-2.5 py-1 text-slate-300'>{item}</span>)}
      </div>
      <div className='mt-auto grid grid-cols-2 gap-2 sm:flex sm:flex-wrap'>
        <button type='button' onClick={() => void open('edit')} disabled={!clip.editable || !!opening}
          className='inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-white/10 px-3 text-sm font-medium hover:bg-white/[.05] disabled:opacity-50'>
          {opening === 'edit' ? <Loader2 size={15} className='animate-spin' /> : <Pencil size={15} />}Edit</button>
        <button type='button' onClick={() => void open('ai')} disabled={!clip.editable || !!opening}
          className='inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-white/10 px-3 text-sm font-medium hover:bg-white/[.05] disabled:opacity-50'>
          {opening === 'ai' ? <Loader2 size={15} className='animate-spin' /> : <Bot size={15} />}Ask AI</button>
        {onDelete ? <>
          <a href={playback ? `${playback}${playback.includes('?') ? '&' : '?'}download=1` : '#'} download aria-disabled={!clip.exportable} className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-xl bg-violet-500 px-3 text-sm font-semibold ${!clip.exportable ? 'pointer-events-none opacity-50' : 'hover:bg-violet-400'}`}><Download size={15} />Export</a>
          <button type='button' onClick={() => onDelete(clip)} className='inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-red-400/20 px-3 text-sm font-medium text-red-200 hover:bg-red-400/10'><Trash2 size={15} />Delete</button>
        </> : null}
      </div>
      {error ? <p role='alert' className='text-xs text-red-200'>{error}</p> : null}
    </div>
  </article>;
}

export function HistoryView({ mode = 'history' }: { mode?: 'history' | 'edit' }) {
  const [clips, setClips] = useState<HistoryClip[]>(cachedHistory ?? []);
  const [loading, setLoading] = useState(!cachedHistory);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<HistoryClip | null>(null);
  const [deleting, setDeleting] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const items = await listHistory();
      cachedHistory = items;
      setClips(items);
      setError('');
    } catch (caught) {
      setError(isServerUnavailable(caught) ? 'Processing server is currently offline.' : 'History could not be loaded. Try again.');
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
      <p className='mt-2 text-sm text-slate-400'>{mode === 'edit' ? 'Choose a clip to edit or open it in Ask AI.' : 'Every clip you create, newest first.'}</p></header>
    {error ? <p role='alert' className='rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100'>{error} <button className='ml-2 underline' onClick={() => void refresh()}>Retry</button></p> : null}
    {loading ? <p role='status' className='flex items-center gap-2 text-sm text-slate-400'><Loader2 size={17} className='animate-spin' />Loading clips…</p>
      : visibleClips.length ? groups.map((group) => {
        const items = visibleClips.filter((clip) => groupFor(clip.createdAt) === group);
        return items.length ? <section key={group} className='grid gap-3'><h2 className='text-sm font-semibold text-slate-300'>{group}</h2>
          <div className='grid gap-4 lg:grid-cols-2'>{items.map((clip) => <HistoryCard key={clip.id} clip={clip} onDelete={mode === 'history' ? setSelected : undefined} />)}</div></section> : null;
      }) : !error ? <div className='empty-state'><h2 className='text-lg font-semibold'>{mode === 'edit' ? 'No clips to edit yet.' : 'No clips yet.'}</h2>
        <p className='mt-2 text-sm text-slate-400'>{mode === 'edit' ? 'Create clips first, then return here to edit them.' : 'Create your first clips and they\'ll appear here.'}</p>
        <Link href='/' className='mt-5 rounded-xl bg-violet-500 px-5 py-3 text-sm font-semibold'>Create clips</Link></div> : null}
    {selected ? <div className='fixed inset-0 z-50 grid place-items-center bg-black/75 p-4' role='presentation'>
      <div role='alertdialog' aria-modal='true' aria-labelledby='delete-clip-title' aria-describedby='delete-clip-description' className='w-full max-w-sm rounded-2xl border border-white/10 bg-[#111827] p-5 shadow-2xl'>
        <h2 id='delete-clip-title' className='text-lg font-semibold'>Delete this clip?</h2>
        <p id='delete-clip-description' className='mt-2 text-sm leading-6 text-slate-400'>This removes the clip from your history and cannot be undone.</p>
        <div className='mt-5 flex justify-end gap-2'>
          <button type='button' disabled={deleting} onClick={() => setSelected(null)} className='h-10 rounded-xl border border-white/10 px-4 text-sm'>Cancel</button>
          <button type='button' disabled={deleting} onClick={() => void remove()} className='inline-flex h-10 items-center gap-2 rounded-xl bg-red-600 px-4 text-sm font-semibold disabled:opacity-60'>{deleting ? <Loader2 size={15} className='animate-spin' /> : null}{deleting ? 'Deleting…' : 'Delete'}</button>
        </div>
      </div>
    </div> : null}
  </div>;
}
