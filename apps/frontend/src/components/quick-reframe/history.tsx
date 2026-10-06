'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Download, Pencil, Trash2 } from 'lucide-react';
import { reframeRequest, mediaUrl, type ReframeSession } from '@/lib/quick-reframe-api';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
export function QuickReframeHistory(){
  const [items,setItems]=useState<ReframeSession[]>([]),[selected,setSelected]=useState<ReframeSession|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const refresh=useCallback(()=>reframeRequest<ReframeSession[]>('/history').then(setItems).catch(()=>setError('Quick Reframe history could not be loaded.')) ,[]);
  useEffect(()=>{void refresh();},[refresh]);
  const remove=async()=>{if(!selected)return;setBusy(true);try{await reframeRequest(`/${selected.id}`,'DELETE');setItems(old=>old.filter(i=>i.id!==selected.id));setSelected(null);}catch{setError('This video could not be deleted. Retry.');}finally{setBusy(false);}};
  return <section className='grid min-w-0 gap-4' aria-label='Quick Reframe history'>
    <h2 className='font-display text-lg font-semibold'>Quick Reframe</h2>
    {error&&<p role='alert' className='text-sm text-warning-soft'>{error} <button className='underline' onClick={()=>void refresh()}>Retry</button></p>}
    {!items.length&&!error&&<p className='text-sm text-muted-foreground'>Your exported Quick Reframe videos will appear here.</p>}
    <div className='grid min-w-0 gap-4 lg:grid-cols-2'>{items.map(s=><article key={s.id} className='grid min-w-0 gap-4 overflow-hidden rounded-2xl border border-border bg-surface p-4 sm:grid-cols-[150px_minmax(0,1fr)]'>
      <video aria-label={`Quick Reframe preview ${s.name}`} playsInline controls preload='none' src={mediaUrl(s.exportUrl)} className='mx-auto max-h-80 w-full rounded-xl bg-black object-contain'/>
      <div className='grid min-w-0 content-start gap-3'><span className='text-xs text-primary-soft'>Quick Reframe</span><h3 className='break-all text-sm font-semibold'>{s.name}</h3><p className='text-xs text-muted-foreground'>{s.duration.toFixed(1)}s · {new Date(s.createdAt).toLocaleString()}</p><div className='flex flex-wrap gap-2'>
        <Link className='inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-xs' href={`/quick-reframe?video=${s.id}`}><Pencil size={14}/>Re-edit</Link>
        <a className='inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-xs' href={`${mediaUrl(s.exportUrl)}?download=1`}><Download size={14}/>Export</a>
        <button className='inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-xs' onClick={()=>setSelected(s)}><Trash2 size={14}/>Delete</button>
      </div></div>
    </article>)}</div>
    <ConfirmDialog open={!!selected} title='Delete this Quick Reframe video?' description='This removes its exports, previews, and owned source. Other videos are kept.' busy={busy} confirmLabel='Delete' busyLabel='Deleting…' onConfirm={()=>void remove()} onCancel={()=>setSelected(null)}/>
  </section>;
}
