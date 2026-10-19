'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { CheckCircle2, Download, Pencil, Clipboard, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { campaignError, campaignMedia, campaignRequest, type CampaignClip } from '@/lib/campaign-api';
import { area, field } from './brief-editor';
import {ComplianceStatus,checkLabel} from './status';
export function CampaignClipCard({ clip, onChange, onError }: {
    clip: CampaignClip;
    onChange: () => Promise<void>;
    onError: (s: string) => void;
}) {
    const [busy, setBusy] = useState(false), [acceptedVersion, setAcceptedVersion] = useState(''), [copied, setCopied] = useState('');
    const reviewVersion=JSON.stringify([clip.checkedRevision,clip.checkedBriefVersion,clip.compliance,clip.socialPackage]);
    const accept=acceptedVersion===reviewVersion,setAccept=(value:boolean)=>setAcceptedVersion(value?reviewVersion:'');
    const [notice,setNotice]=useState('');const lock=useRef(false),live=useRef(true),video=useRef<HTMLVideoElement>(null);
    useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
    const run = async (path: string, method = 'POST', body: unknown = {}) => { if(lock.current)return;lock.current=true;setBusy(true);setNotice(path==='fix'?'Applying campaign fixes…':path==='export'?'Preparing the latest export…':'Saving…');onError(''); try {
        const result=await campaignRequest<{export?:{phase:string};project?:{id:string}}>(`/campaign-clips/${clip.id}/${path}`, method, body);
        if(path==='export'&&result.export&&result.project){const end=Date.now()+15*60000;let progress=result.export;while(live.current&&!['COMPLETED','FAILED'].includes(progress.phase)){if(Date.now()>end)throw Error('The export is taking longer than expected. Refresh to check its progress.');setNotice('Exporting the latest edit…');await new Promise(r=>setTimeout(r,1500));if(!live.current)return;progress=await campaignRequest(`/edit-mode/projects/${result.project.id}/export/progress`);}if(progress.phase==='FAILED')throw Error('Export could not finish. Open the editor to review the video, then retry.');}
        if(!live.current)return;
        await onChange();
        setNotice(path==='fix'?'Requirements updated. Export the latest edit and review compliance.':path==='export'?'Latest export is ready.':path==='social'?'Social copy saved. Review compliance again before marking Ready.':path==='ready'?'Ready to post.':path==='mark-posted'?'Your manually published post was recorded.':'Metrics saved.');
    }
    catch (e) {
        if(live.current){setNotice('');setAccept(false);onError(campaignError(e));}
    }
    finally {
        lock.current=false;if(live.current)setBusy(false);
    } };
    const copy = async (value: string, label: string) => { try {
        await navigator.clipboard.writeText(value);
        setCopied(label + ' copied');
    }
    catch {
        onError('Copy could not complete. Select and copy the displayed text.');
    } };
    const posted = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const values=Object.fromEntries(new FormData(e.currentTarget).entries());const {postedAt,...rest}=values;void run('mark-posted','POST',{...rest,...(postedAt?{postedAt:new Date(String(postedAt)).toISOString()}:{})}); };
    const metrics = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const values = Object.fromEntries(new FormData(e.currentTarget).entries()); void run('metrics', 'PATCH', { ...values, ...Object.fromEntries(['views', 'likes', 'comments', 'shares'].map(k => [k, Number(values[k])])) }); };
    const social = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const values = new FormData(e.currentTarget); void run('social', 'PATCH', { caption: values.get('caption'), hashtags: String(values.get('hashtags')).split(/\s+/).filter(Boolean) }); };
    return <article id={'clip-' + clip.id} data-testid='campaign-clip' className='grid min-w-0 content-start gap-4 overflow-hidden rounded-2xl border border-border bg-surface p-4'>
  <div className='flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs'><a href={`/clippers/campaigns/${clip.campaignId}?tab=Generated%20Clips`} className='break-all font-semibold text-primary-soft'>{clip.campaignName}</a><span className='rounded-lg bg-tint px-2 py-1'>{clip.mode === 'XEEPRO' ? 'XeePro' : 'XeeFree'} · {clip.style === 'STYLEZERO' ? 'StyleZero' : clip.style === 'STYLEONE' ? 'StyleOne' : 'StyleTwo'}</span></div>
  {clip.previewUrl ? <video ref={video} src={campaignMedia(clip.previewUrl)} controls playsInline preload='metadata' className='max-h-80 w-full rounded-xl bg-black' aria-label={'Campaign preview ' + clip.title}/> : <div className='grid h-48 place-content-center rounded-xl bg-background p-4 text-center text-sm text-muted-foreground'>Video preview is not ready. Export the latest edit to prepare it.</div>}
  {!clip.exportCurrent && clip.previewUrl && <p className='text-xs text-warning-soft'>Previous export shown. Export your latest edits before posting.</p>}
  <h3 className='break-words font-display text-lg font-semibold'>{clip.title}</h3>
  <div className='flex flex-wrap items-center gap-2 text-sm'><ShieldCheck size={16}/><strong>Campaign Match: {clip.compliance.overallScore === null || clip.compliance.overallScore === undefined ? 'Not assessed' : clip.compliance.overallScore + '%'}</strong><span className='rounded-lg bg-tint px-2 py-1 text-xs'>{clip.lifecycleStatus === 'READY' ? 'Ready to Post' : clip.lifecycleStatus === 'POSTED' ? 'Posted' : 'Needs Review'}</span></div>
  <details className='min-w-0 rounded-xl border border-border p-3'><summary className='cursor-pointer text-sm font-semibold'>View Compliance · <ComplianceStatus status={clip.complianceStatus}/></summary><ul className='mt-3 grid gap-2'>{clip.compliance.checks?.map(c => <li key={c.code} className='grid min-w-0 gap-1 rounded-lg bg-background p-3 text-xs'><strong className={c.status === 'PASS' ? 'text-success' : c.status === 'FAIL' ? 'text-warning-soft' : 'text-soft'}><ComplianceStatus status={c.status}/> · {checkLabel(c.code)}</strong><span className='break-words text-muted-foreground'>{c.detail}</span></li>)}</ul></details>
  <div className='flex flex-wrap gap-2'>
   {clip.previewUrl&&<Button variant='secondary' onClick={()=>{video.current?.focus();void video.current?.play().catch(()=>onError('Use the video controls to start playback.'));}}>Preview</Button>}
   {clip.editorUrl && <Button asChild variant='secondary'><Link href={clip.editorUrl} prefetch={false} onClick={()=>sessionStorage.setItem('xeeclip-campaign-return',JSON.stringify({project:clip.editProjectId||clip.editorUrl?.split('/').at(-1),campaign:clip.campaignId}))}><Pencil size={15}/>Edit Video</Link></Button>}
   {clip.downloadUrl && <Button asChild variant='secondary'><a href={campaignMedia(clip.downloadUrl)} download><Download size={15}/>Download</a></Button>}
   <Button disabled={busy || !clip.editorUrl} variant='secondary' onClick={() => void run('export')}>Export latest</Button>
   {clip.compliance.checks?.some(c => c.fixable && ['FAIL','WARN'].includes(c.status)) && <Button disabled={busy} variant='secondary' onClick={() => void run('fix')}>Fix Automatically</Button>}
  </div>
  {notice&&<p role='status' className='break-words text-xs text-primary-soft'>{notice}</p>}
  <details className='min-w-0 rounded-xl border border-border p-3' open={clip.lifecycleStatus === 'READY'}><summary className='cursor-pointer text-sm font-semibold'>Social post package</summary><div className='mt-3 grid min-w-0 gap-3 text-sm'><p className='whitespace-pre-wrap break-words'>{clip.socialPackage.caption || 'Review the clip and add a social caption.'}</p><p className='break-words text-primary-soft'>{clip.socialPackage.hashtags.join(' ')}</p>{clip.socialPackage.requiredMentions.length > 0 && <p className='break-words'>{clip.socialPackage.requiredMentions.join(' ')}</p>}{clip.socialPackage.cta && <p className='break-words'>CTA: {clip.socialPackage.cta}</p>}{clip.socialPackage.postingNotes && <p className='whitespace-pre-wrap break-words text-xs text-muted-foreground'>{clip.socialPackage.postingNotes}</p>}
   <div className='flex flex-wrap gap-2'><Button variant='ghost' onClick={() => void copy(clip.socialPackage.caption, 'Caption')}><Clipboard size={14}/>Copy Caption</Button><Button variant='ghost' onClick={() => void copy(clip.socialPackage.hashtags.join(' '), 'Hashtags')}>Copy Hashtags</Button>{clip.socialPackage.cta && <Button variant='ghost' onClick={() => void copy(clip.socialPackage.cta, 'CTA')}>Copy CTA</Button>}</div>{copied && <p role='status' className='text-xs text-success'>{copied}</p>}
   <details><summary className='cursor-pointer text-xs text-muted-foreground'>Edit social copy</summary><form className='mt-3 grid min-w-0 gap-2' onSubmit={social}><label className='grid gap-1 text-xs'>Social caption<textarea name='caption' maxLength={4000} className={area} defaultValue={clip.socialPackage.caption}/></label><label className='grid gap-1 text-xs'>Hashtags<input name='hashtags' className={field} defaultValue={clip.socialPackage.hashtags.join(' ')}/></label><Button disabled={busy} variant='secondary'>Save social copy</Button></form></details>
  </div></details>
  {clip.lifecycleStatus !== 'POSTED' && <div className='grid gap-2'>{clip.complianceStatus === 'WARN' && <label className='flex min-h-11 items-center gap-2 text-xs'><input type='checkbox' disabled={busy} checked={accept} onChange={e => setAccept(e.target.checked)}/>I reviewed and accept the listed warnings.</label>}<Button disabled={busy || !clip.exportCurrent || ['FAIL', 'UNKNOWN'].includes(clip.complianceStatus) || clip.complianceStatus === 'WARN' && !accept} onClick={() => void run('ready', 'POST', { acceptWarnings: accept })}><CheckCircle2 size={16}/>Mark Ready to Post</Button></div>}
  {clip.lifecycleStatus === 'READY' && <details className='rounded-xl border border-border p-3'><summary className='cursor-pointer text-sm font-semibold'>Mark Posted</summary><p className='my-3 text-xs text-muted-foreground'>Record a post you made yourself. XeeClip does not publish to social platforms.</p><form className='grid gap-2' onSubmit={posted}><label className='grid gap-1 text-xs'>Platform<input className={field} name='platform' required maxLength={80} placeholder='TikTok, Instagram Reels…'/></label><label className='grid gap-1 text-xs'>Post URL (optional)<input className={field} name='postUrl' type='url' pattern='https://.*' maxLength={2000} placeholder='https://…'/></label><label className='grid gap-1 text-xs'>Posted at (optional)<input className={field} type='datetime-local' name='postedAt'/></label><label className='grid gap-1 text-xs'>Notes<textarea className={area} maxLength={4000} name='notes'/></label><Button disabled={busy}>Confirm manually posted</Button></form></details>}
  {clip.post && <details className='rounded-xl border border-border p-3' open><summary className='cursor-pointer text-sm font-semibold'>Recorded performance · {clip.post.platform}</summary><p className='mt-2 text-xs text-muted-foreground'>Posted {new Date(clip.post.postedAt).toLocaleString()} · manually entered metrics</p>{clip.post.postUrl && <a className='my-2 block break-all text-xs text-primary-soft underline' href={clip.post.postUrl} target='_blank' rel='noreferrer'>Open recorded post</a>}<form key={JSON.stringify(clip.post)} className='mt-3 grid min-w-0 gap-3' onSubmit={metrics}><div className='grid grid-cols-2 gap-2'>{(['views', 'likes', 'comments', 'shares'] as const).map(k => <label key={k} className='grid min-w-0 gap-1 text-xs capitalize'>{k}<input className={field} name={k} type='number' min='0' step='1' max='2147483647' required defaultValue={clip.post![k]}/></label>)}</div><div className='grid grid-cols-2 gap-2'><label className='grid min-w-0 gap-1 text-xs'>Recorded earnings<input className={field} name='earnings' type='number' min='0' step='.01' defaultValue={clip.post.earnings}/></label><label className='grid min-w-0 gap-1 text-xs'>Currency<input className={field} name='currency' maxLength={3} pattern='[A-Z]{3}' defaultValue={clip.post.currency}/></label></div><label className='grid gap-1 text-xs'>Performance notes<textarea className={area} name='notes' defaultValue={clip.post.notes}/></label><Button disabled={busy} variant='secondary'>Save metrics</Button></form></details>}
 </article>;
}
