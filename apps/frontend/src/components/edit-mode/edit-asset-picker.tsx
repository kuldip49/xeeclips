'use client';

import { useEffect, useRef, useState } from 'react';
import { FileAudio, FileImage, FileUp, Library, Plus, Trash2 } from 'lucide-react';
import { listSourceVideos } from '@/lib/edit-mode-api';
import type { EditAsset, SourceVideoOption } from '@/lib/edit-mode-types';

export function EditAssetPicker({ assets, busy, onUploadSource, onImport, onUploadAsset,
  onAdd, onDelete }: {
  assets: EditAsset[]; busy: boolean; onUploadSource: (file: File) => Promise<void>;
  onImport: (videoId: string) => Promise<void>;
  onUploadAsset: (role: 'IMAGE' | 'LOGO' | 'AUDIO', file: File) => Promise<void>;
  onAdd: (asset: EditAsset) => void; onDelete: (asset: EditAsset) => void;
}) {
  const sourceInput = useRef<HTMLInputElement>(null);
  const assetInput = useRef<HTMLInputElement>(null);
  const pendingRole = useRef<'IMAGE' | 'LOGO' | 'AUDIO'>('IMAGE');
  const [videos, setVideos] = useState<SourceVideoOption[]>([]);
  const [selected, setSelected] = useState('');
  const source = assets.find((asset) => asset.role === 'SOURCE');
  const library = assets.filter((asset) => ['IMAGE', 'LOGO', 'AUDIO'].includes(asset.role));
  useEffect(() => { void listSourceVideos().then(setVideos).catch(() => setVideos([])); }, []);
  const choose = (role: 'IMAGE' | 'LOGO' | 'AUDIO') => {
    pendingRole.current = role;
    if (assetInput.current) assetInput.current.accept = role === 'AUDIO'
      ? '.mp3,.wav,.m4a,.aac,audio/*' : '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp';
    assetInput.current?.click();
  };
  return <section className='grid min-w-0 gap-3'>
    {source ? <div className='min-w-0 rounded-xl border border-success/15 bg-success/5 p-3'>
      <p className='truncate text-sm font-medium'>{source.originalName}</p><p className='mt-1 text-xs text-muted-foreground'>{source.width ?? '—'}×{source.height ?? '—'} · {(source.duration ?? 0).toFixed(1)}s</p><p className='mt-2 text-[11px] font-medium uppercase tracking-wider text-success'>Source video</p>
    </div> : <div className='grid gap-3'>
      <input ref={sourceInput} className='hidden' type='file' accept='video/*' onChange={(event) => { const file = event.target.files?.[0]; if (file) void onUploadSource(file); event.target.value = ''; }} />
      <button disabled={busy} onClick={() => sourceInput.current?.click()} className='flex items-center justify-center gap-2 rounded-xl btn-primary px-3 py-2.5 text-sm font-semibold disabled:opacity-50'><FileUp size={16} />Upload video</button>
      <div className='flex gap-2'><select aria-label='Existing source video' value={selected} onChange={(event) => setSelected(event.target.value)} className='min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-xs text-soft'><option value=''>Existing source…</option>{videos.map((video) => <option key={video.id} value={video.id}>{video.originalName}</option>)}</select><button disabled={busy || !selected} onClick={() => void onImport(selected)} aria-label='Attach existing source' className='rounded-xl border border-border p-2.5 text-soft disabled:opacity-40'><Library size={16} /></button></div>
    </div>}
    <div className='h-px bg-tint-strong' />
    <input ref={assetInput} className='hidden' type='file' onChange={(event) => { const file = event.target.files?.[0]; if (file) void onUploadAsset(pendingRole.current, file); event.target.value = ''; }} />
    <div className='grid grid-cols-3 gap-1.5'><button disabled={busy || !source} onClick={() => choose('IMAGE')} className='rounded-lg border border-border px-2 py-2 text-[11px] disabled:opacity-30'>+ Image</button><button disabled={busy || !source} onClick={() => choose('LOGO')} className='rounded-lg border border-border px-2 py-2 text-[11px] disabled:opacity-30'>+ Logo</button><button disabled={busy || !source} onClick={() => choose('AUDIO')} className='rounded-lg border border-border px-2 py-2 text-[11px] disabled:opacity-30'>+ Music</button></div>
    <p className='mt-2 text-[10px] leading-4 text-warning-soft/70'>Only upload audio you own or are licensed to use.</p>
    <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2'>{library.map((asset) => <div key={asset.id} className='min-w-0 rounded-lg bg-tint-subtle p-2'><div className='flex items-center gap-2'>{asset.role === 'AUDIO' ? <FileAudio size={14} /> : <FileImage size={14} />}<span className='min-w-0 flex-1 truncate text-[11px]'>{asset.originalName}</span><button aria-label={`Delete ${asset.originalName}`} disabled={busy} onClick={() => onDelete(asset)} className='p-1 text-faint hover:text-danger'><Trash2 size={12} /></button></div><button disabled={busy} onClick={() => onAdd(asset)} className='mt-2 flex w-full items-center justify-center gap-1 rounded-md bg-tint py-1.5 text-[10px] font-semibold hover:bg-tint-strong'><Plus size={11} />Add to timeline</button></div>)}</div>
  </section>;
}
