'use client';
import { useRef, useState, type InputHTMLAttributes } from 'react';
import { apiFetch } from '@/lib/api';
import { campaignError, campaignMedia, campaignRequest, type CampaignAsset } from '@/lib/campaign-api';
import { Button } from '@/components/ui/button';
import { field } from './brief-editor';
const allowed = '.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a,.ogg,.flac,.mp4,.webm,.txt,.pdf,.docx';
export function CampaignAssets({ campaignId, assets, onChange, onError, onBusyChange }: {
    campaignId?: string;
    assets: CampaignAsset[];
    onChange: () => Promise<void>;
    onError: (s: string) => void;
    onBusyChange?: (busy:boolean)=>void;
}) {
    const [busy, setBusy] = useState(false), [kind, setKind] = useState('REFERENCE'), [progress, setProgress] = useState('');
    const [result,setResult]=useState(''),[failures,setFailures]=useState<Array<{name:string;reason:string}>>([]);
    const folder = useRef<HTMLInputElement>(null);
    const upload = async (selection: FileList | null) => {
        if (!selection || !campaignId || busy) return;
        const files=Array.from(selection);if(!files.length)return;
        if(files.length>100){onError('Select at most 100 files per batch.');return;}
        setBusy(true);onBusyChange?.(true);onError('');setFailures([]);setResult('');
        const failed:Array<{name:string;reason:string}>=[];let succeeded=0;
        try {
            for(let i=0;i<files.length;i++){
                const file=files[i];setProgress(`Uploading ${i+1} of ${files.length}: ${file.name}`);
                try{
                    const ext='.'+file.name.split('.').at(-1)?.toLowerCase();
                    if(!allowed.split(',').includes(ext))throw Error('Unsupported file. Choose a supported image, audio, video, TXT, PDF or DOCX file.');
                    const max=['.png','.jpg','.jpeg','.webp'].includes(ext)?10:ext==='.txt'?1:50;
                    if(!file.size||file.size>max*1024**2)throw Error(`File must be non-empty and no larger than ${max} MiB.`);
                    const body=new FormData();body.set('file',file);body.set('type',kind);body.set('relativePath',file.webkitRelativePath||'');
                    await apiFetch(`/campaigns/${campaignId}/assets`,{method:'POST',body,signal:AbortSignal.timeout(90000)});succeeded++;
                }catch(error){failed.push({name:file.webkitRelativePath||file.name,reason:campaignError(error)});setFailures([...failed]);}
            }
            setResult(`${succeeded} files uploaded. ${failed.length?`${failed.length} could not upload. Successful files are saved; retry only the failed files.`:'All files saved.'}`);
            await onChange();
        }catch(error){onError(campaignError(error));}
        finally{setBusy(false);onBusyChange?.(false);setProgress('');}
    };
    const mutate = async (asset: CampaignAsset, method: string, body?: unknown) => { setBusy(true); try {
        await campaignRequest(`/campaigns/${asset.campaignId}/assets/${asset.id}`, method, body);
        await onChange();
    }
    catch (e) {
        onError(campaignError(e));
    }
    finally {
        setBusy(false);
    } };
    return <div className='grid min-w-0 gap-5'>
 {campaignId && <div className='grid gap-3 rounded-2xl border border-dashed border-primary/40 bg-primary/5 p-5'><h3 className='font-display text-lg font-semibold'>Campaign asset library</h3><p className='text-sm text-muted-foreground'>Logos, images, music and references. Uploading a file does not apply it to clips. Required assets need an explicit use and a confirmed brief.</p><label className='grid max-w-sm gap-2 text-sm'>Upload as<select className={field} value={kind} onChange={e => setKind(e.target.value)} disabled={busy}><option value='REFERENCE'>Detect media / reference</option><option value='LOGO'>Logo</option></select></label><label className='grid gap-2 text-sm'>Select campaign files<input type='file' multiple accept={allowed} disabled={busy} onChange={e => { const input=e.currentTarget;void upload(input.files).finally(()=>{input.value='';}); }} className={field}/></label><input ref={folder} type='file' multiple aria-label='Select campaign folder' disabled={busy} {...({ webkitdirectory: '', directory: '' } as InputHTMLAttributes<HTMLInputElement>)} onChange={e => { const input=e.currentTarget;void upload(input.files).finally(()=>{input.value='';}); }} className='hidden'/><Button variant='secondary' className='justify-self-start' disabled={busy} onClick={() => folder.current?.click()}>Upload a folder</Button><p className='text-xs text-muted-foreground'>Images up to 10 MiB; UTF-8 text up to 1 MiB; other media/documents up to 50 MiB each. PDF/DOCX are reference-only. TXT is extracted once. Folder uploads preserve relative names only.</p>{progress && <p role='status' className='break-all text-sm'>{progress}</p>}</div>}
 {result&&<p role='status' className='break-words rounded-xl bg-primary/10 p-3 text-sm text-primary-soft'>{result}</p>}
 {!!failures.length&&<div role='alert' className='grid min-w-0 gap-2 rounded-xl border border-warning/40 p-4 text-sm'><h3 className='font-semibold'>Files that need attention</h3><ul className='grid gap-2'>{failures.map((f,i)=><li key={i} className='break-all'><strong>{f.name}</strong><span className='block text-muted-foreground'>{f.reason}</span></li>)}</ul></div>}
 {!assets.length && <p className='rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground'>{campaignId?'Add campaign logos, music or reference files when needed.':'No assets yet. Open a campaign to upload your first files.'}</p>}
 {['LOGO', 'IMAGE', 'MUSIC', 'REFERENCE', 'DOCUMENT'].map(type => {
            const rows = assets.filter(a => a.type === type);
            return rows.length ? <section key={type} className='grid min-w-0 gap-3'><h3 className='font-display text-lg font-semibold'>{({ LOGO: 'Logos', IMAGE: 'Images', MUSIC: 'Music', REFERENCE: 'References', DOCUMENT: 'Documents' } as Record<string, string>)[type]}</h3><div className='grid min-w-0 gap-4 sm:grid-cols-2'>{rows.map(a => <article key={a.id} className='grid min-w-0 gap-3 rounded-2xl border border-border bg-surface p-4'>
 {a.mimeType.startsWith('image/') ? <img src={campaignMedia(a.fileUrl)} alt={a.label || a.fileName} className='h-36 w-full rounded-xl object-contain'/> : a.mimeType.startsWith('audio/') ? <audio controls preload='none' src={campaignMedia(a.fileUrl)} className='w-full min-w-0'/> : a.mimeType.startsWith('video/') ? <video controls playsInline preload='metadata' src={campaignMedia(a.fileUrl)} className='max-h-48 w-full rounded-xl'/> : <a className='text-sm text-primary-soft underline' href={campaignMedia(a.fileUrl)} download>Download reference</a>}
 <p className='break-all text-sm font-semibold'>{a.fileName}</p><p className='break-all text-xs text-muted-foreground'>{a.metadata.relativePath || ''} · {a.metadata.handling === 'REFERENCE_ONLY' ? 'Reference only · paste its rules as text' : a.extractedTextAvailable ? 'Text extracted' : 'Verified media'}</p>
 <label className='grid gap-1 text-sm'>Label<input className={field} maxLength={200} defaultValue={a.label} key={a.id + a.label} disabled={busy} onBlur={e => { if (e.target.value !== a.label)
                    void mutate(a, 'PATCH', { label: e.target.value }); }}/></label>
 <label className='grid gap-1 text-sm'>Intended use<select className={field} value={a.intendedUse} disabled={busy} onChange={e => void mutate(a, 'PATCH', { intendedUse: e.target.value })}><option value=''>Choose use</option><option value='REFERENCE'>Reference only</option>{a.type === 'LOGO' && <option value='LOGO_TOP_RIGHT'>Logo top-right</option>}{a.type === 'MUSIC' && <option value='BACKGROUND_MUSIC'>Background music</option>}{a.type === 'IMAGE' && <option value='IMAGE_OVERLAY'>Image overlay</option>}</select></label>
 <label className='flex min-h-11 items-center gap-2 text-sm'><input type='checkbox' checked={a.required} disabled={busy||!a.required&&(!a.intendedUse||a.intendedUse==='REFERENCE')} onChange={e => void mutate(a, 'PATCH', { required: e.target.checked })}/>Required in confirmed rules</label><Button variant='ghost' disabled={busy} onClick={() => { if (window.confirm('Delete this campaign library asset? Existing editor copies are retained.'))
                    void mutate(a, 'DELETE'); }}>Delete asset</Button>
 </article>)}</div></section> : null;
        })}
 </div>;
}
