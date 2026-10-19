'use client';
import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { campaignRequest, type Campaign, type CampaignMode } from '@/lib/campaign-api';
import { CampaignAssets } from './assets';
import { CampaignRules, Mode } from './workspace';
import { area, field } from './brief-editor';
import {useAuth} from '@/components/auth-provider';
const steps = ['Campaign basics', 'Campaign rules', 'Campaign assets', 'Understand campaign', 'Review and confirm'];
export function NewCampaign() {
    const {user}=useAuth();
    const [restored,setRestored]=useState(false),[furthest,setFurthest]=useState(0),[uploading,setUploading]=useState(false);
    const [step, setStep] = useState(0), [campaign, setCampaign] = useState<Campaign | null>(null), [name, setName] = useState(''), [description, setDescription] = useState(''), [platforms, setPlatforms] = useState(''), [deadline, setDeadline] = useState(''), [payout, setPayout] = useState(''), [rules, setRules] = useState(''), [mode, setMode] = useState<CampaignMode>('XEEFREE'), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const refresh = async () => { if (campaign)
        setCampaign(await campaignRequest<Campaign>('/campaigns/' + campaign.id)); };
    const draftKey='xeeclip-campaign-draft:'+user?.id;
    useEffect(()=>{let live=true;(async()=>{try{const raw=sessionStorage.getItem(draftKey);if(!raw)return;const d=JSON.parse(raw);if(typeof d.name!=='string')return;setName(d.name);setDescription(d.description||'');setPlatforms(d.platforms||'');setDeadline(d.deadline||'');setPayout(d.payout||'');setRules(d.rules||'');setMode(d.mode==='XEEPRO'?'XEEPRO':'XEEFREE');if(d.campaignId){const c=await campaignRequest<Campaign>('/campaigns/'+encodeURIComponent(d.campaignId));if(live){setCampaign(c);setStep(Math.min(4,Math.max(0,d.step||0)));setFurthest(Math.min(4,Math.max(0,d.furthest||d.step||0)));}}}catch{if(live)setError('The saved draft could not be reopened. Your pasted rules are still available in this tab.');}finally{if(live)setRestored(true);}})();return()=>{live=false;};},[draftKey]);
    useEffect(()=>{if(!restored)return;try{sessionStorage.setItem(draftKey,JSON.stringify({name,description,platforms,deadline,payout,rules,mode,campaignId:campaign?.id,step,furthest:Math.max(furthest,step)}));}catch{setError('This browser could not save the draft in this tab. Continue to save rules to your campaign.');}setFurthest(old=>Math.max(old,step));},[restored,draftKey,name,description,platforms,deadline,payout,rules,mode,campaign?.id,step,furthest]);
    const saveRules=async()=>{if(!campaign)return;setBusy(true);setError('');try{if(rules!==campaign.brief?.sourceText){await campaignRequest(`/campaigns/${campaign.id}/brief`,'PATCH',{version:campaign.brief!.version,data:campaign.brief!.data,sourceText:rules});await refresh();}setStep(2);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
    const basics = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(''); try {
        const c = await campaignRequest<Campaign>('/campaigns', 'POST', { name, description, platforms: platforms.split(',').map(s => s.trim()).filter(Boolean), deadline: deadline || null, payoutDescription: payout });
        setCampaign(await campaignRequest<Campaign>('/campaigns/' + c.id));
        setStep(1);
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } };
    const understand = async () => { if (!campaign)
        return; setBusy(true); setError(''); try {
        await campaignRequest(`/campaigns/${campaign.id}/understand`, 'POST', { sourceText: rules, version: campaign.brief!.version, mode });
        await refresh();
        setStep(4);
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } };
    if(!restored)return <p role='status'>Opening campaign draft…</p>;
    return <div className='clipper-workspace mx-auto grid max-w-4xl min-w-0 gap-6 pb-10'><header><Link href='/clippers' className='text-sm text-primary-soft'>← Clipper Workspace</Link><p className='eyebrow mt-6'>New Campaign</p><h1 className='mt-2 font-display text-3xl font-bold'>Build your campaign brief.</h1><p className='mt-2 text-sm text-muted-foreground'>Rules and assets guide the clips. You confirm every requirement before generation.</p></header><nav aria-label='Campaign creation steps' className='min-w-0 overflow-x-auto'><ol className='flex w-max min-w-full gap-2'>{steps.map((s, i) => <li key={s}><button type='button' disabled={i > furthest || busy || uploading} onClick={() => setStep(i)} aria-current={step === i ? 'step' : undefined} className={'min-h-11 whitespace-nowrap rounded-xl px-3 text-xs ' + (step === i ? 'bg-primary/20 text-primary-soft' : 'bg-surface text-muted-foreground')}>{i + 1}. {s}</button></li>)}</ol></nav>
  {error && <div className='grid gap-2 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning-soft'><p role='alert'>{error}</p>{error.includes('XeePro is busy') && <Button variant='secondary' className='justify-self-start' onClick={() => { setMode('XEEFREE'); setError(''); }}>Use XeeFree</Button>}</div>}
  {step === 0 && <form onSubmit={basics} className='grid min-w-0 gap-4 rounded-2xl border border-border bg-surface p-5'><h2 className='font-display text-xl font-semibold'>Campaign basics</h2><label className='grid gap-2 text-sm'>Campaign name<input className={field} value={name} maxLength={120} required onChange={e => setName(e.target.value)} disabled={!!campaign}/></label><label className='grid gap-2 text-sm'>Platforms (comma-separated)<input className={field} value={platforms} onChange={e => setPlatforms(e.target.value)} placeholder='TikTok, Instagram Reels' disabled={!!campaign}/></label><div className='grid gap-4 sm:grid-cols-2'><label className='grid gap-2 text-sm'>Deadline (optional)<input className={field} type='date' value={deadline} onChange={e => setDeadline(e.target.value)} disabled={!!campaign}/></label><label className='grid gap-2 text-sm'>Payout / reward description<input className={field} value={payout} maxLength={4000} onChange={e => setPayout(e.target.value)} disabled={!!campaign}/></label></div><label className='grid gap-2 text-sm'>General description<textarea className={area} value={description} maxLength={10000} onChange={e => setDescription(e.target.value)} disabled={!!campaign}/></label>{campaign ? <Button type='button' onClick={() => setStep(1)}>Continue saved campaign</Button> : <Button disabled={busy}>Create draft and continue</Button>}</form>}
  {step === 1 && <section className='grid min-w-0 gap-4 rounded-2xl border border-border bg-surface p-5'><h2 className='font-display text-xl font-semibold'>Paste campaign rules</h2><label className='grid gap-2 text-sm'>Paste the complete campaign description/rules here<textarea className={area + ' min-h-80'} maxLength={50000} value={rules} onChange={e => setRules(e.target.value)} placeholder={'Duration: 25–40 seconds\nRequired topics: business\nForbidden topics: politics\nCaptions: required\nLogo: top-right\nCTA: Learn more'}/></label><p className='text-xs text-muted-foreground'>Paste the entire brief. Unclear or conflicting instructions will be surfaced for review.</p><p role='status' className='text-xs text-muted-foreground'>{rules.length.toLocaleString()} / 50,000 characters · saved in this tab</p><Button disabled={busy} onClick={() => void saveRules()}>{busy?'Saving rules…':'Continue to assets'}</Button></section>}
  {step === 2 && campaign && <><CampaignAssets campaignId={campaign.id} assets={campaign.assets} onChange={refresh} onError={setError} onBusyChange={setUploading}/><Button disabled={uploading} onClick={() => setStep(3)}>Continue to understanding</Button></>}
  {step === 3 && <section className='grid gap-4 rounded-2xl border border-border bg-surface p-5'><h2 className='font-display text-xl font-semibold'>Understand Campaign</h2><p className='text-sm text-muted-foreground'>Structure the pasted rules, supported text files, explicit fields and asset labels. Nothing is confirmed until you review it.</p><Mode value={mode} onChange={setMode} disabled={busy}/><p className='text-xs text-muted-foreground'>XeeFree is fully local. XeePro uses online reasoning with your AI consent and never silently switches to Free.</p><Button disabled={busy} onClick={() => void understand()}>{busy ? 'Understanding campaign…' : 'Understand Campaign'}</Button></section>}
  {step === 4 && campaign && <><CampaignRules campaign={campaign} onChange={refresh} onError={setError}/>{campaign.brief?.confirmedByUser && <Button asChild><a href={'/clippers/campaigns/' + campaign.id} onClick={()=>{try{sessionStorage.removeItem(draftKey);}catch{}}}>Open Campaign</a></Button>}</>}
  {campaign && <p className='text-xs text-muted-foreground'>Draft saved. <a href={'/clippers/campaigns/' + campaign.id} className='text-primary-soft underline'>Continue from the campaign page</a>.</p>}
 </div>;
}
