'use client';
import { useRef, useState, type InputHTMLAttributes } from 'react';
import { apiFetch } from '@/lib/api';
import { campaignMedia, campaignRequest, type CampaignAsset } from '@/lib/campaign-api';
import { Button } from '@/components/ui/button';
import { field } from './brief-editor';
const allowed = '.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a,.ogg,.flac,.mp4,.webm,.txt,.pdf,.docx';
export function CampaignAssets({ campaignId, assets, onChange, onError }: {
    campaignId?: string;
    assets: CampaignAsset[];
    onChange: () => Promise<void>;
    onError: (s: string) => void;
}) {
    const [busy, setBusy] = useState(false), [kind, setKind] = useState('REFERENCE'), [progress, setProgress] = useState('');
    const folder = useRef<HTMLInputElement>(null);
    const upload = async (files: FileList | null) => { if (!files || !campaignId)
        return; setBusy(true); onError(''); try {
        if (files.length > 100)
            throw Error('Select at most 100 files per batch.');
        let n = 0;
        for (const file of Array.from(files)) {
            setProgress(`Uploading ${++n} of ${files.length}: ${file.name}`);
            const body = new FormData();
            body.set('file', file);
            body.set('type', kind);
            body.set('relativePath', file.webkitRelativePath || '');
            await apiFetch(`/campaigns/${campaignId}/assets`, { method: 'POST', body });
        }
        await onChange();
    }
    catch (e) {
        onError((e as Error).message);
        await onChange();
    }
    finally {
        setBusy(false);
        setProgress('');
    } };
    const mutate = async (asset: CampaignAsset, method: string, body?: unknown) => { setBusy(true); try {
        await campaignRequest(`/campaigns/${asset.campaignId}/assets/${asset.id}`, method, body);
        await onChange();
    }
    catch (e) {
        onError((e as Error).message);
    }
    finally {
        setBusy(false);
    } };
    return <div className='grid min-w-0 gap-5'>
 {campaignId && <div className='grid gap-3 rounded-2xl border border-dashed border-primary/40 bg-primary/5 p-5'><h3 className='font-display text-lg font-semibold'>Campaign asset library</h3><p className='text-sm text-muted-foreground'>Logos, images, music and references. Uploading a file does not apply it to clips. Required assets need an explicit use and a confirmed brief.</p><label className='grid max-w-sm gap-2 text-sm'>Upload as<select className={field} value={kind} onChange={e => setKind(e.target.value)} disabled={busy}><option value='REFERENCE'>Detect media / reference</option><option value='LOGO'>Logo</option></select></label><label className='grid gap-2 text-sm'>Select campaign files<input type='file' multiple accept={allowed} disabled={busy} onChange={e => { void upload(e.target.files); e.target.value = ''; }} className={field}/></label><input ref={folder} type='file' multiple {...({ webkitdirectory: '', directory: '' } as InputHTMLAttributes<HTMLInputElement>)} onChange={e => { void upload(e.target.files); e.target.value = ''; }} className='hidden'/><Button variant='secondary' className='justify-self-start' disabled={busy} onClick={() => folder.current?.click()}>Upload a folder</Button><p className='text-xs text-muted-foreground'>Images up to 10 MiB; UTF-8 text up to 1 MiB; other media/documents up to 50 MiB each. PDF/DOCX are reference-only. TXT is extracted once. Folder uploads preserve relative names only.</p>{progress && <p role='status' className='break-all text-sm'>{progress}</p>}</div>}
 {!assets.length && <p className='rounded-2xl border border-border p-6 text-sm text-muted-foreground'>Upload campaign logos, music or references.</p>}
 {['LOGO', 'IMAGE', 'MUSIC', 'REFERENCE', 'DOCUMENT'].map(type => {
            const rows = assets.filter(a => a.type === type);
            return rows.length ? <section key={type} className='grid min-w-0 gap-3'><h3 className='font-display text-lg font-semibold'>{({ LOGO: 'Logos', IMAGE: 'Images', MUSIC: 'Music', REFERENCE: 'References', DOCUMENT: 'Documents' } as Record<string, string>)[type]}</h3><div className='grid min-w-0 gap-4 sm:grid-cols-2'>{rows.map(a => <article key={a.id} className='grid min-w-0 gap-3 rounded-2xl border border-border bg-surface p-4'>
 {a.mimeType.startsWith('image/') ? <img src={campaignMedia(a.fileUrl)} alt={a.label || a.fileName} className='h-36 w-full rounded-xl object-contain'/> : a.mimeType.startsWith('audio/') ? <audio controls preload='none' src={campaignMedia(a.fileUrl)} className='w-full min-w-0'/> : a.mimeType.startsWith('video/') ? <video controls playsInline preload='metadata' src={campaignMedia(a.fileUrl)} className='max-h-48 w-full rounded-xl'/> : <a className='text-sm text-primary-soft underline' href={campaignMedia(a.fileUrl)} download>Download reference</a>}
 <p className='break-all text-sm font-semibold'>{a.fileName}</p><p className='break-all text-xs text-muted-foreground'>{a.metadata.relativePath || ''} · {a.metadata.handling === 'REFERENCE_ONLY' ? 'Reference only · paste its rules as text' : a.extractedTextAvailable ? 'Text extracted' : 'Verified media'}</p>
 <label className='grid gap-1 text-sm'>Label<input className={field} defaultValue={a.label} key={a.id + a.label} disabled={busy} onBlur={e => { if (e.target.value !== a.label)
                    void mutate(a, 'PATCH', { label: e.target.value }); }}/></label>
 <label className='grid gap-1 text-sm'>Intended use<select className={field} value={a.intendedUse} disabled={busy} onChange={e => void mutate(a, 'PATCH', { intendedUse: e.target.value })}><option value=''>Choose use</option><option value='REFERENCE'>Reference only</option>{a.type === 'LOGO' && <option value='LOGO_TOP_RIGHT'>Logo top-right</option>}{a.type === 'MUSIC' && <option value='BACKGROUND_MUSIC'>Background music</option>}{a.type === 'IMAGE' && <option value='IMAGE_OVERLAY'>Image overlay</option>}</select></label>
 <label className='flex min-h-11 items-center gap-2 text-sm'><input type='checkbox' checked={a.required} disabled={busy} onChange={e => void mutate(a, 'PATCH', { required: e.target.checked })}/>Required in confirmed rules</label><Button variant='ghost' disabled={busy} onClick={() => { if (window.confirm('Delete this campaign library asset? Existing editor copies are retained.'))
                    void mutate(a, 'DELETE'); }}>Delete asset</Button>
 </article>)}</div></section> : null;
        })}
 </div>;
}
