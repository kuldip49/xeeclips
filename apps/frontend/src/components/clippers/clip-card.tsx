'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { CheckCircle2, Download, Pencil, Clipboard, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { campaignMedia, campaignRequest, type CampaignClip } from '@/lib/campaign-api';
import { area, field } from './brief-editor';
export function CampaignClipCard({ clip, onChange, onError }: {
    clip: CampaignClip;
    onChange: () => Promise<void>;
    onError: (s: string) => void;
}) {
    const [busy, setBusy] = useState(false), [accept, setAccept] = useState(false), [copied, setCopied] = useState('');
    const run = async (path: string, method = 'POST', body: unknown = {}) => { setBusy(true); onError(''); try {
        await campaignRequest(`/campaign-clips/${clip.id}/${path}`, method, body);
        await onChange();
    }
    catch (e) {
        onError((e as Error).message);
    }
    finally {
        setBusy(false);
    } };
    const copy = async (value: string, label: string) => { try {
        await navigator.clipboard.writeText(value);
        setCopied(label + ' copied');
    }
    catch {
        onError('Copy could not complete. Select and copy the displayed text.');
    } };
    const posted = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const data = new FormData(e.currentTarget); void run('mark-posted', 'POST', Object.fromEntries(data.entries())); };
    const metrics = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const values = Object.fromEntries(new FormData(e.currentTarget).entries()); void run('metrics', 'PATCH', { ...values, ...Object.fromEntries(['views', 'likes', 'comments', 'shares'].map(k => [k, Number(values[k])])) }); };
    const social = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const values = new FormData(e.currentTarget); void run('social', 'PATCH', { caption: values.get('caption'), hashtags: String(values.get('hashtags')).split(/\s+/).filter(Boolean) }); };
    return <article id={'clip-' + clip.id} data-testid='campaign-clip' className='grid min-w-0 content-start gap-4 overflow-hidden rounded-2xl border border-border bg-surface p-4'>
  <div className='flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs'><Link href={`/clippers/campaigns/${clip.campaignId}`} prefetch={false} className='break-all font-semibold text-primary-soft'>{clip.campaignName}</Link><span className='rounded-lg bg-tint px-2 py-1'>{clip.mode === 'XEEPRO' ? 'XeePro' : 'XeeFree'} · {clip.style === 'STYLEZERO' ? 'StyleZero' : clip.style === 'STYLEONE' ? 'StyleOne' : 'StyleTwo'}</span></div>
  {clip.previewUrl ? <video src={campaignMedia(clip.previewUrl)} controls playsInline preload='metadata' className='max-h-80 w-full rounded-xl bg-black' aria-label={'Campaign preview ' + clip.title}/> : <div className='grid h-48 place-content-center rounded-xl bg-background p-4 text-center text-sm text-muted-foreground'>Preparing the canonical video export…</div>}
  {!clip.exportCurrent && clip.previewUrl && <p className='text-xs text-warning-soft'>Previous export shown. Export your latest edits before posting.</p>}
  <h3 className='break-words font-display text-lg font-semibold'>{clip.title}</h3>
  <div className='flex flex-wrap items-center gap-2 text-sm'><ShieldCheck size={16}/><strong>Campaign Match: {clip.compliance.overallScore === null || clip.compliance.overallScore === undefined ? 'Not assessed' : clip.compliance.overallScore + '%'}</strong><span className='rounded-lg bg-tint px-2 py-1 text-xs'>{clip.lifecycleStatus === 'READY' ? 'READY TO POST' : clip.lifecycleStatus === 'POSTED' ? 'POSTED' : 'NEEDS REVIEW'}</span></div>
  <details className='min-w-0 rounded-xl border border-border p-3'><summary className='cursor-pointer text-sm font-semibold'>View Compliance · {clip.complianceStatus}</summary><ul className='mt-3 grid gap-2'>{clip.compliance.checks?.map(c => <li key={c.code} className='grid min-w-0 gap-1 rounded-lg bg-background p-3 text-xs'><strong className={c.status === 'PASS' ? 'text-success' : c.status === 'FAIL' ? 'text-warning-soft' : 'text-soft'}>{c.status} · {c.code.replaceAll('_', ' ')}</strong><span className='break-words text-muted-foreground'>{c.detail}</span></li>)}</ul></details>
  <div className='flex flex-wrap gap-2'>
   {clip.editorUrl && <Button asChild variant='secondary'><Link href={clip.editorUrl} prefetch={false}><Pencil size={15}/>Edit Video</Link></Button>}
   {clip.downloadUrl && <Button asChild variant='secondary'><a href={campaignMedia(clip.downloadUrl)} download><Download size={15}/>Download</a></Button>}
   <Button disabled={busy || !clip.editorUrl} variant='secondary' onClick={() => void run('export')}>Export latest</Button>
   {clip.compliance.checks?.some(c => c.fixable && c.status === 'FAIL') && <Button disabled={busy} variant='secondary' onClick={() => void run('fix')}>Fix Automatically</Button>}
  </div>
  <details className='min-w-0 rounded-xl border border-border p-3' open={clip.lifecycleStatus === 'READY'}><summary className='cursor-pointer text-sm font-semibold'>Social post package</summary><div className='mt-3 grid min-w-0 gap-3 text-sm'><p className='whitespace-pre-wrap break-words'>{clip.socialPackage.caption || 'Review the clip and add a social caption.'}</p><p className='break-words text-primary-soft'>{clip.socialPackage.hashtags.join(' ')}</p>{clip.socialPackage.requiredMentions.length > 0 && <p className='break-words'>{clip.socialPackage.requiredMentions.join(' ')}</p>}{clip.socialPackage.cta && <p className='break-words'>CTA: {clip.socialPackage.cta}</p>}{clip.socialPackage.postingNotes && <p className='whitespace-pre-wrap break-words text-xs text-muted-foreground'>{clip.socialPackage.postingNotes}</p>}
   <div className='flex flex-wrap gap-2'><Button variant='ghost' onClick={() => void copy(clip.socialPackage.caption, 'Caption')}><Clipboard size={14}/>Copy Caption</Button><Button variant='ghost' onClick={() => void copy(clip.socialPackage.hashtags.join(' '), 'Hashtags')}>Copy Hashtags</Button>{clip.socialPackage.cta && <Button variant='ghost' onClick={() => void copy(clip.socialPackage.cta, 'CTA')}>Copy CTA</Button>}</div>{copied && <p role='status' className='text-xs text-success'>{copied}</p>}
   <details><summary className='cursor-pointer text-xs text-muted-foreground'>Edit social copy</summary><form className='mt-3 grid min-w-0 gap-2' onSubmit={social}><label className='grid gap-1 text-xs'>Social caption<textarea name='caption' className={area} defaultValue={clip.socialPackage.caption}/></label><label className='grid gap-1 text-xs'>Hashtags<input name='hashtags' className={field} defaultValue={clip.socialPackage.hashtags.join(' ')}/></label><Button disabled={busy} variant='secondary'>Save social copy</Button></form></details>
  </div></details>
  {clip.lifecycleStatus !== 'POSTED' && <div className='grid gap-2'>{clip.complianceStatus === 'WARN' && <label className='flex min-h-11 items-center gap-2 text-xs'><input type='checkbox' checked={accept} onChange={e => setAccept(e.target.checked)}/>I reviewed and accept the listed warnings.</label>}<Button disabled={busy || !clip.exportCurrent || ['FAIL', 'UNKNOWN'].includes(clip.complianceStatus) || clip.complianceStatus === 'WARN' && !accept} onClick={() => void run('ready', 'POST', { acceptWarnings: accept })}><CheckCircle2 size={16}/>Mark Ready to Post</Button></div>}
  {clip.lifecycleStatus === 'READY' && <details className='rounded-xl border border-border p-3'><summary className='cursor-pointer text-sm font-semibold'>Mark Posted</summary><p className='my-3 text-xs text-muted-foreground'>Record a post you made yourself. XeeClip does not publish to social platforms.</p><form className='grid gap-2' onSubmit={posted}><label className='grid gap-1 text-xs'>Platform<input className={field} name='platform' required maxLength={80} placeholder='TikTok, Instagram Reels…'/></label><label className='grid gap-1 text-xs'>Post URL (optional)<input className={field} name='postUrl' type='url' placeholder='https://…'/></label><label className='grid gap-1 text-xs'>Posted at (optional)<input className={field} type='datetime-local' name='postedAt'/></label><label className='grid gap-1 text-xs'>Notes<textarea className={area} name='notes'/></label><Button disabled={busy}>Confirm manually posted</Button></form></details>}
  {clip.post && <details className='rounded-xl border border-border p-3' open><summary className='cursor-pointer text-sm font-semibold'>Recorded performance · {clip.post.platform}</summary><p className='mt-2 text-xs text-muted-foreground'>Posted {new Date(clip.post.postedAt).toLocaleString()} · manually entered metrics</p>{clip.post.postUrl && <a className='my-2 block break-all text-xs text-primary-soft underline' href={clip.post.postUrl} target='_blank' rel='noreferrer'>Open recorded post</a>}<form key={JSON.stringify(clip.post)} className='mt-3 grid min-w-0 gap-3' onSubmit={metrics}><div className='grid grid-cols-2 gap-2'>{(['views', 'likes', 'comments', 'shares'] as const).map(k => <label key={k} className='grid min-w-0 gap-1 text-xs capitalize'>{k}<input className={field} name={k} type='number' min='0' max='2147483647' required defaultValue={clip.post![k]}/></label>)}</div><div className='grid grid-cols-2 gap-2'><label className='grid min-w-0 gap-1 text-xs'>Recorded earnings<input className={field} name='earnings' type='number' min='0' step='.01' defaultValue={clip.post.earnings}/></label><label className='grid min-w-0 gap-1 text-xs'>Currency<input className={field} name='currency' maxLength={3} pattern='[A-Z]{3}' defaultValue={clip.post.currency}/></label></div><label className='grid gap-1 text-xs'>Performance notes<textarea className={area} name='notes' defaultValue={clip.post.notes}/></label><Button disabled={busy} variant='secondary'>Save metrics</Button></form></details>}
 </article>;
}
