'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Download, Pencil, Share2, Trash2 } from 'lucide-react';
import { editorUrl, mediaUrl, QUICK_STYLE_LABEL, quickReframeUrl, reframeRequest, type ReframeSession } from '@/lib/quick-reframe-api';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PostCopyButtons } from './post-copy-panel';

const action = 'inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-xs hover:bg-tint';
/** Exported Quick Reframe videos: preview, re-edit in the same state, export again, download, delete. */
export function QuickReframeHistory(){
  const [items,setItems]=useState<ReframeSession[]>([]),[selected,setSelected]=useState<ReframeSession|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const refresh=useCallback(()=>reframeRequest<ReframeSession[]>('/history').then(v=>setItems(Array.isArray(v)?v:[])).catch(()=>setError('Quick Reframe history could not be loaded.')) ,[]);
  useEffect(()=>{void refresh();},[refresh]);
  const remove=async()=>{if(!selected)return;setBusy(true);try{await reframeRequest(`/${selected.id}`,'DELETE');setItems(old=>old.filter(i=>i.id!==selected.id));setSelected(null);}catch{setError('This video could not be deleted. Retry.');}finally{setBusy(false);}};
  return <section className='grid min-w-0 gap-4' aria-label='Quick Reframe history'>
    <h2 className='font-display text-lg font-semibold'>Quick Reframe</h2>
    {error&&<p role='alert' className='text-sm text-warning-soft'>{error} <button className='underline' onClick={()=>void refresh()}>Retry</button></p>}
    {!items.length&&!error&&<p className='text-sm text-muted-foreground'>Your exported Quick Reframe videos will appear here.</p>}
    <div className='grid min-w-0 gap-4 lg:grid-cols-2'>{items.map(s=>{const latest=s.exports[0];const reedit=s.editPath==='MANUAL'&&s.cropConfirmed?editorUrl(s):quickReframeUrl(s.id,s.cropConfirmed&&s.editPath?'edit':undefined);
      return <article key={s.id} className='grid min-w-0 gap-4 overflow-hidden rounded-2xl border border-border bg-surface p-4 sm:grid-cols-[150px_minmax(0,1fr)]' data-testid='quick-reframe-history-item'>
      <video aria-label={`Quick Reframe preview ${s.name}`} playsInline controls preload='none' src={mediaUrl(latest?.url??s.exportUrl)} className='mx-auto max-h-80 w-full rounded-xl bg-black object-contain'/>
      <div className='grid min-w-0 content-start gap-3'>
        <div className='flex flex-wrap gap-1.5 text-[11px] font-semibold'><span className='rounded-md bg-primary/15 px-2 py-0.5 text-primary-soft'>Quick Reframe</span>
          {s.editPath&&<span className='rounded-md bg-tint-strong px-2 py-0.5 text-soft'>{QUICK_STYLE_LABEL[s.editPath]}</span>}
          {latest&&!latest.current&&<span className='rounded-md bg-warning/15 px-2 py-0.5 text-warning-soft'>Edited since export</span>}</div>
        <h3 className='break-all text-sm font-semibold'>{s.name}</h3>
        <p className='text-xs text-muted-foreground'>{s.duration.toFixed(1)}s{latest?.width?` · ${latest.width} × ${latest.height}`:''} · {new Date(latest?.createdAt??s.createdAt).toLocaleString()}</p>
        <div className='flex flex-wrap gap-2'>
          <Link className={action} href={reedit}><Pencil size={14}/>Re-edit</Link>
          <Link className={action} href={quickReframeUrl(s.id,s.cropConfirmed&&s.editPath?'export':undefined)}><Share2 size={14}/>Export</Link>
          {latest&&<a className={action} href={`${mediaUrl(latest.url)}?download=1`} download><Download size={14}/>Download</a>}
          <button className={action} onClick={()=>setSelected(s)}><Trash2 size={14}/>Delete</button>
        </div>
        <PostCopyButtons caption={s.postCopy?.selectedCaption ?? ''} hashtags={s.postCopy?.selectedHashtags ?? []} />
        </div>
    </article>;})}</div>
    <ConfirmDialog open={!!selected} title='Delete this Quick Reframe video?' description='This removes its exports, previews, the cropped copy and the uploaded original. Other videos are kept.' busy={busy} confirmLabel='Delete' busyLabel='Deleting…' onConfirm={()=>void remove()} onCancel={()=>setSelected(null)}/>
  </section>;
}
