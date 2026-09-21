'use client';

import { useEffect, useRef, useState } from 'react';
import { FileUp, Film, Library } from 'lucide-react';
import { listSourceVideos } from '@/lib/edit-mode-api';
import type { EditAsset, SourceVideoOption } from '@/lib/edit-mode-types';

export function EditAssetPicker({ source, busy, onUpload, onImport }: {
  source?: EditAsset;
  busy: boolean;
  onUpload: (file: File) => Promise<void>;
  onImport: (videoId: string) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [videos, setVideos] = useState<SourceVideoOption[]>([]);
  const [selected, setSelected] = useState('');
  useEffect(() => { void listSourceVideos().then(setVideos).catch(() => setVideos([])); }, []);
  return <section className='rounded-2xl border border-white/10 bg-[#0d111c] p-4'>
    <div className='flex items-center gap-2'><Film size={16} className='text-violet-300' /><h2 className='text-sm font-semibold'>Source media</h2></div>
    {source ? <div className='mt-4 rounded-xl border border-emerald-400/15 bg-emerald-400/5 p-3'>
      <p className='truncate text-sm font-medium'>{source.originalName}</p>
      <p className='mt-1 text-xs text-slate-400'>{source.width ?? '—'}×{source.height ?? '—'} · {(source.duration ?? 0).toFixed(1)}s</p>
      <p className='mt-2 text-[11px] font-medium uppercase tracking-wider text-emerald-300'>EditMode-owned copy</p>
    </div> : <div className='mt-4 grid gap-3'>
      <input ref={input} className='hidden' type='file' accept='video/*' onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) void onUpload(file);
      }} />
      <button disabled={busy} onClick={() => input.current?.click()}
        className='flex items-center justify-center gap-2 rounded-xl bg-violet-500 px-3 py-2.5 text-sm font-semibold disabled:opacity-50'>
        <FileUp size={16} />Upload video
      </button>
      <div className='flex gap-2'>
        <select aria-label='Existing source video' value={selected} onChange={(event) => setSelected(event.target.value)}
          className='min-w-0 flex-1 rounded-xl border border-white/10 bg-[#080b13] px-3 text-xs text-slate-300'>
          <option value=''>Existing source…</option>
          {videos.map((video) => <option key={video.id} value={video.id}>{video.originalName}</option>)}
        </select>
        <button disabled={busy || !selected} onClick={() => void onImport(selected)} aria-label='Attach existing source'
          className='rounded-xl border border-white/10 p-2.5 text-slate-300 disabled:opacity-40'><Library size={16} /></button>
      </div>
      <p className='text-xs leading-5 text-slate-500'>Existing videos are copied into isolated EditMode storage.</p>
    </div>}
  </section>;
}

