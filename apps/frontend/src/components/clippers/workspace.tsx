'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Clapperboard, Plus, ArrowRight, FolderOpen, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { apiFetch, uploadVideo, type VideoImportJob } from '@/lib/api';
import { campaignRequest, type Campaign, type CampaignAsset, type CampaignBrief, type CampaignClip, type CampaignMode, type CampaignStyle, type CampaignOverview } from '@/lib/campaign-api';
import { CampaignAssets } from './assets';
import { CampaignClipCard } from './clip-card';
import { BriefEditor, area, field } from './brief-editor';
const nav = [['Overview', '/clippers'], ['Campaigns', '/clippers/campaigns'], ['Assets', '/clippers/assets'], ['Campaign Clips', '/clippers/clips'], ['Ready to Post', '/clippers/ready'], ['Posted', '/clippers/posted'], ['Performance', '/clippers/performance']];
const panel = 'grid min-w-0 gap-4 rounded-2xl border border-border bg-surface p-5';
const format = (v: number | null | undefined) => v == null ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(v);
function Summary({ data }: {
    data: CampaignOverview;
}) { return <div className='grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-3'>{[['Active Campaigns', data.activeCampaigns], ['Clips Generated', data.clipsGenerated], ['Ready to Post', data.ready], ['Posted', data.posted], ['Total Views', data.totalViews], ['Total Engagement', data.totalEngagement], ['Average Views', data.averageViews], ['Average Campaign Match', data.averageCampaignMatch]].map(([k, v]) => <div key={String(k)} className='min-w-0 rounded-2xl border border-border bg-surface p-4'><p className='text-xs text-muted-foreground'>{k}</p><p className='mt-2 break-all font-display text-2xl font-semibold'>{format(v as number | null)}</p></div>)}<div className='min-w-0 rounded-2xl border border-border bg-surface p-4'><p className='text-xs text-muted-foreground'>Recorded Earnings</p>{Object.entries(data.earningsByCurrency).length ? Object.entries(data.earningsByCurrency).map(([currency, value]) => <p key={currency} className='mt-2 break-all font-display text-xl'>{currency} {value}</p>) : <p className='mt-2 text-sm text-muted-foreground'>No earnings recorded</p>}</div>{data.bestClipId && <Link href={'/clippers/performance#clip-' + data.bestClipId} className='min-w-0 rounded-2xl border border-border bg-surface p-4 text-sm text-primary-soft'>View best performing clip</Link>}{data.bestCampaign && <div className='rounded-2xl border border-border bg-surface p-4'><p className='text-xs text-muted-foreground'>Best Campaign by Views</p><p className='mt-2 break-words font-semibold'>{data.bestCampaign.name}</p><p className='text-sm'>{format(data.bestCampaign.views)} recorded views</p></div>}</div>; }
export function ClippersWorkspace({ section = 'overview', campaignRoute = false }: {
    section?: string;
    campaignRoute?: boolean;
}) {
    const [campaigns, setCampaigns] = useState<Campaign[]>([]), [campaign, setCampaign] = useState<Campaign | null>(null), [clips, setClips] = useState<CampaignClip[]>([]), [assets, setAssets] = useState<CampaignAsset[]>([]), [summary, setSummary] = useState<CampaignOverview | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [tab, setTab] = useState('Overview');
    const id = useRef('');
    const refresh = useCallback(async () => { if (campaignRoute) {
        if (!id.current)
            id.current = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).at(-1)!);
        const [c, s] = await Promise.all([campaignRequest<Campaign>('/campaigns/' + id.current), campaignRequest<CampaignOverview>(`/campaigns/${id.current}/performance`)]);
        setCampaign(c);
        setSummary(s);
    }
    else {
        const [c, s] = await Promise.all([campaignRequest<Campaign[]>('/campaigns'), campaignRequest<CampaignOverview>('/campaigns/overview')]);
        setCampaigns(c);
        setSummary(s);
        if (['clips', 'ready', 'posted', 'performance'].includes(section))
            setClips(await campaignRequest<CampaignClip[]>('/campaign-clips'));
        if (section === 'assets')
            setAssets(await campaignRequest<CampaignAsset[]>('/campaign-assets'));
    } }, [campaignRoute, section]);
    useEffect(() => { void refresh().catch(e => setError(e.message)).finally(() => setLoading(false)); }, [refresh]);
    const active = campaign?.runs.some(r => ['QUEUED', 'STARTING', 'GENERATING', 'PREPARING'].includes(r.status)) || campaign?.sources.some(s => s.video.processingJobs.some(j => ['PENDING', 'PROCESSING'].includes(j.status)));
    useEffect(() => { if (!active)
        return; const timer = setInterval(() => void refresh().catch(e => setError(e.message)), 3000); return () => clearInterval(timer); }, [active, refresh]);
    const visibleClips = campaign ? campaign.clips : clips;
    const showClips = (rows: CampaignClip[], empty: string) => <>{!rows.length && <p className={panel + ' text-sm text-muted-foreground'}>{empty}</p>}<div className='grid min-w-0 gap-5 lg:grid-cols-2'>{rows.map(c => <CampaignClipCard key={c.id} clip={c} onChange={refresh} onError={setError}/>)}</div></>;
    return <div className='grid min-w-0 gap-7 pb-8'><header className='flex min-w-0 flex-wrap items-start justify-between gap-4'><div><p className='eyebrow flex items-center gap-2'><Clapperboard size={15}/>Clipper Workspace</p><h1 className='mt-2 font-display text-3xl font-bold tracking-tight'>{campaign?.name ?? (section === 'overview' ? 'Campaigns that turn clips into results.' : nav.find(n => n[1].endsWith('/' + section))?.[0] ?? 'Clippers')}</h1><p className='mt-2 text-sm text-muted-foreground'>{campaign ? [campaign.status, campaign.platforms.join(', '), campaign.deadline ? 'Due ' + new Date(campaign.deadline).toLocaleDateString() : ''].filter(Boolean).join(' · ') : 'Plan the campaign. Review the clips. Track what you post.'}</p></div><Button asChild><Link href='/clippers/campaigns/new'><Plus size={16}/>New Campaign</Link></Button></header>
  <nav aria-label='Clipper workspace navigation' className='min-w-0 overflow-x-auto rounded-xl border border-border bg-surface p-1'><div className='flex w-max min-w-full gap-1'>{nav.map(([name, href]) => <Link key={href} href={href} className={cn('inline-flex min-h-11 items-center whitespace-nowrap rounded-lg px-3 text-xs font-semibold', !campaignRoute && (href === '/clippers' ? section === 'overview' : href.endsWith('/' + section)) ? 'bg-primary/20 text-primary-soft' : 'text-muted-foreground hover:bg-tint')}>{name}</Link>)}</div></nav>
  {error && <p role='alert' className='rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning-soft'>{error}<button className='ml-3 underline' onClick={() => void refresh().then(() => setError('')).catch(e => setError(e.message))}>Refresh</button></p>}
  {loading && <p role='status' className='flex items-center gap-2 text-sm'><Loader2 size={16} className='animate-spin'/>Loading workspace…</p>}
  {!loading && campaign && <><div className='flex min-w-0 flex-wrap gap-2'><Button onClick={() => setTab('Sources')}>Create Campaign Clips<ArrowRight size={16}/></Button>{['Overview', 'Rules', 'Sources', 'Assets', 'Generated Clips', 'Ready to Post', 'Posted', 'Performance'].map(name => <Button key={name} variant={tab === name ? 'secondary' : 'ghost'} onClick={() => setTab(name)}>{name}</Button>)}</div>
   {tab === 'Overview' && <>{summary && <Summary data={summary}/>}<div className={panel}><h2 className='font-display text-xl font-semibold'>Campaign overview</h2><p className='whitespace-pre-wrap break-words text-sm'>{campaign.description || 'Add campaign rules and confirm the brief to get started.'}</p>{campaign.payoutDescription && <p className='whitespace-pre-wrap break-words text-sm text-soft'>Reward description: {campaign.payoutDescription}</p>}<p className='text-sm'>{campaign.brief?.confirmedByUser ? 'Campaign brief confirmed' : 'Campaign brief needs confirmation'}</p><div className='flex flex-wrap gap-2'><Button variant='secondary' onClick={() => setTab('Rules')}>Review Rules</Button><select className={field + ' max-w-xs'} aria-label='Campaign status' value={campaign.status} onChange={e => void campaignRequest('/campaigns/' + campaign.id, 'PATCH', { status: e.target.value }).then(refresh).catch(e => setError(e.message))}>{['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'].map(v => <option key={v}>{v}</option>)}</select></div></div></>}
   {tab === 'Rules' && <CampaignRules campaign={campaign} onChange={refresh} onError={setError}/>}
   {tab === 'Assets' && <CampaignAssets campaignId={campaign.id} assets={campaign.assets} onChange={refresh} onError={setError}/>}
   {tab === 'Sources' && <CampaignSources campaign={campaign} onChange={refresh} onError={setError} onRules={() => setTab('Rules')}/>}
   {tab === 'Generated Clips' && showClips(visibleClips, 'Generate campaign-matched clips.')}
   {tab === 'Ready to Post' && showClips(visibleClips.filter(c => c.lifecycleStatus === 'READY' && !['FAIL', 'UNKNOWN'].includes(c.complianceStatus) && c.exportCurrent), 'Clips that pass campaign checks will appear here.')}
   {tab === 'Posted' && showClips(visibleClips.filter(c => c.lifecycleStatus === 'POSTED'), 'Mark exported clips as posted to track results.')}
   {tab === 'Performance' && <>{summary && <Summary data={summary}/>}<p className='text-sm text-muted-foreground'>Performance and earnings are manually recorded. Currencies are kept separate.</p>{showClips(visibleClips.filter(c => c.post), 'No posted clips have recorded performance yet.')}</>}
  </>}
  {!loading && !campaignRoute && <>
   {section === 'overview' && <>{summary && <Summary data={summary}/>}<div className={panel}><h2 className='font-display text-xl font-semibold'>{campaigns.length ? 'Your campaigns' : 'Create your first clipping campaign.'}</h2><p className='text-sm text-muted-foreground'>Keep rules, brand assets, source videos and posting progress together.</p><Button asChild variant='secondary' className='justify-self-start'><Link href='/clippers/campaigns'>View Campaigns<ArrowRight size={15}/></Link></Button></div></>}
   {['overview', 'campaigns'].includes(section) && <div className='grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3'>{campaigns.map(c => <Link key={c.id} href={'/clippers/campaigns/' + c.id} prefetch={false} className={panel + ' transition-colors hover:border-primary/50'}><FolderOpen size={22} className='text-primary-soft'/><span className='break-words font-display text-xl font-semibold'>{c.name}</span><span className='text-xs text-soft'>{c.status} · {c.platforms.join(', ') || 'Platforms not set'}</span><span className='text-xs text-muted-foreground'>{c._count?.clips ?? 0} clips · {c._count?.assets ?? 0} assets · {c.brief?.confirmedByUser ? 'Brief confirmed' : 'Review brief'}</span></Link>)}{section === 'campaigns' && !campaigns.length && <p className={panel}>Create your first clipping campaign.</p>}</div>}
   {section === 'assets' && <CampaignAssets assets={assets} onChange={refresh} onError={setError}/>}
   {section === 'clips' && showClips(clips, 'Generate campaign-matched clips.')}
   {section === 'ready' && showClips(clips.filter(c => c.lifecycleStatus === 'READY' && !['FAIL', 'UNKNOWN'].includes(c.complianceStatus) && c.exportCurrent), 'Clips that pass campaign checks will appear here.')}
   {section === 'posted' && showClips(clips.filter(c => c.lifecycleStatus === 'POSTED'), 'Mark exported clips as posted to track results.')}
   {section === 'performance' && <>{summary && <Summary data={summary}/>}<p className='text-sm text-muted-foreground'>Only manually recorded metrics are counted. Earnings are grouped by currency.</p>{showClips(clips.filter(c => c.post), 'No performance recorded. Mark an exported clip as posted to begin.')}</>}
  </>}
 </div>;
}
export function CampaignRules({ campaign, onChange, onError }: {
    campaign: Campaign;
    onChange: () => Promise<void>;
    onError: (s: string) => void;
}) {
    const saved = campaign.brief!;
    const [draft, setDraft] = useState(saved.data), [sourceText, setSourceText] = useState(saved.sourceText), [mode, setMode] = useState<CampaignMode>(saved.mode), [busy, setBusy] = useState(false), [proBusy, setProBusy] = useState(false), [dirty, setDirty] = useState(false), [ack, setAck] = useState(false), [confirm, setConfirm] = useState(false);
    useEffect(() => { setDraft(saved.data); setSourceText(saved.sourceText); setDirty(false); setAck(false); setConfirm(false); }, [saved.version]);
    const run = async (path: string, body: unknown, method = 'POST') => { setBusy(true); setProBusy(false); onError(''); try {
        await campaignRequest('/campaigns/' + campaign.id + '/' + path, method, body);
        await onChange();
    }
    catch (e) {
        const message = (e as Error).message;
        onError(message);
        setProBusy(message.includes('XeePro is busy'));
    }
    finally {
        setBusy(false);
    } };
    return <section className={panel}><h2 className='font-display text-xl font-semibold'>Campaign rules and confirmation</h2><label className='grid gap-2 text-sm'>Paste the complete campaign description/rules here<textarea className={area + ' min-h-48'} value={sourceText} onChange={e => { setSourceText(e.target.value); setDirty(true); }} maxLength={50000}/></label><div className='flex flex-wrap items-center gap-2'><Mode value={mode} onChange={setMode} disabled={busy}/><Button disabled={busy} onClick={() => void run('understand', { sourceText, version: saved.version, mode })}>{busy ? <Loader2 size={15} className='animate-spin'/> : null}Understand Campaign</Button></div><p className='text-xs text-muted-foreground'>XeeFree uses local rules only. XeePro interprets the supplied rules online with your AI consent. Documents marked reference-only are not parsed.</p>
  {!!draft.unresolvedRules.length && <div className='rounded-xl border border-warning/40 bg-warning/5 p-4 text-sm text-warning-soft'><strong>NEEDS CONFIRMATION</strong><ul className='mt-2 grid gap-1'>{draft.unresolvedRules.map((w, i) => <li key={i} className='break-words'>{w}</li>)}</ul></div>}
  {proBusy && <Button variant='secondary' className='justify-self-start' onClick={() => { setMode('XEEFREE'); setProBusy(false); onError(''); }}>Use XeeFree</Button>}
  <BriefEditor value={draft} disabled={busy} onChange={v => { setDraft(v); setDirty(true); setConfirm(false); }}/>
  <Button disabled={busy || !dirty} variant='secondary' className='justify-self-start' onClick={() => void run('brief', { version: saved.version, data: draft, sourceText }, 'PATCH')}>Save corrected brief</Button>
  <label className='flex min-h-11 items-center gap-2 text-sm'><input type='checkbox' checked={confirm} onChange={e => setConfirm(e.target.checked)}/>I reviewed and confirm these campaign rules.</label>
  {!!draft.warnings.length && <label className='flex min-h-11 items-center gap-2 text-sm'><input type='checkbox' checked={ack} onChange={e => setAck(e.target.checked)}/>I acknowledge that unresolved rules keep clips in Needs Review.</label>}
  <Button disabled={busy || dirty || !confirm || !!draft.warnings.length && !ack} onClick={() => void run('confirm', { version: saved.version, confirmedByUser: true, warningsAcknowledged: ack })}>Confirm Campaign</Button><p className='text-xs text-muted-foreground'>{dirty ? 'Save corrections before confirming.' : saved.confirmedByUser ? 'The current brief is confirmed.' : 'Generation stays locked until this version is confirmed.'}</p>
 </section>;
}
export function Mode({ value, onChange, disabled = false }: {
    value: CampaignMode;
    onChange: (v: CampaignMode) => void;
    disabled?: boolean;
}) { return <div role='group' aria-label='Campaign mode' className='flex gap-2'>{(['XEEFREE', 'XEEPRO'] as const).map(v => <Button key={v} type='button' variant={value === v ? 'secondary' : 'ghost'} aria-pressed={value === v} disabled={disabled} onClick={() => onChange(v)}>{v === 'XEEFREE' ? 'XeeFree' : 'XeePro'}</Button>)}</div>; }
function CampaignSources({ campaign, onChange, onError, onRules }: {
    campaign: Campaign;
    onChange: () => Promise<void>;
    onError: (s: string) => void;
    onRules: () => void;
}) {
    const [videos, setVideos] = useState<Array<{
        id: string;
        originalName: string;
    }>>([]), [existing, setExisting] = useState(''), [url, setUrl] = useState(''), [imports, setImports] = useState<{
        id: string;
        status: string;
        videoId?: string | null;
    } | null>(null), [authorized, setAuthorized] = useState(false), [busy, setBusy] = useState(false), [selected, setSelected] = useState<string[]>([]), [mode, setMode] = useState<CampaignMode>('XEEFREE'), [style, setStyle] = useState<CampaignStyle>('STYLEZERO'), [count, setCount] = useState(campaign.defaultClipCount), [notes, setNotes] = useState(''), [status, setStatus] = useState('');
    const requestKey = useRef(crypto.randomUUID());
    const attach = useCallback(async (videoId: string) => { await campaignRequest(`/campaigns/${campaign.id}/sources`, 'POST', { videoId, authorized: true, ownershipNote: 'User confirmed source authorization.' }); await onChange(); }, [campaign.id, onChange]);
    useEffect(() => { void apiFetch<Array<{
        id: string;
        originalName: string;
    }>>('/videos').then(setVideos).catch(e => onError(e.message)); }, []);
    useEffect(() => { if (!imports || ['READY', 'FAILED', 'IMPORT_FAILED'].includes(imports.status))
        return; const timer = setInterval(() => void campaignRequest<VideoImportJob>('/videos/import-jobs/' + imports.id).then(async (j) => { setImports(j); if (j.status === 'READY' && j.videoId) {
        await attach(j.videoId);
        setStatus('Imported source added.');
    }
    else if (j.status === 'IMPORT_FAILED')
        onError(j.error || 'Import failed.'); }).catch(e => onError(e.message)), 3000); return () => clearInterval(timer); }, [imports?.id, imports?.status, attach, onError]);
    const task = async (fn: () => Promise<void>) => { setBusy(true); onError(''); try {
        if (!authorized)
            throw Error('Confirm your source permissions first.');
        await fn();
    }
    catch (e) {
        onError((e as Error).message);
    }
    finally {
        setBusy(false);
    } };
    const upload = async (file: File | undefined) => { if (!file)
        return; await task(async () => { setStatus('Uploading source…'); const form = new FormData(); form.set('file', file); form.set('aiMode', 'FALLBACK_ONLY'); form.set('processingType', 'EDITED_CLIPS'); form.set('aspectRatio', campaign.brief?.data.aspectRatio || '9:16'); const v = await uploadVideo(campaign.projectId, form); await attach(v.id); setStatus('Source uploaded. Existing local analysis is running.'); }); };
    const generate = async () => { setBusy(true); onError(''); try {
        if (!selected.length)
            throw Error('Choose at least one source.');
        await campaignRequest(`/campaigns/${campaign.id}/generate`, 'POST', { sourceIds: selected, mode, style, count, notes, requestKey: requestKey.current });
        requestKey.current = crypto.randomUUID();
        setStatus('Campaign generation queued.');
        await onChange();
    }
    catch (e) {
        onError((e as Error).message);
    }
    finally {
        setBusy(false);
    } };
    return <div className='grid min-w-0 gap-5'><section className={panel}><h2 className='font-display text-xl font-semibold'>Source videos</h2><p className='text-sm text-muted-foreground'>Sources are separate from logos, music and references. Uploads reuse the existing local analysis pipeline; generation uses your selected mode.</p><label className='flex min-h-11 items-center gap-2 text-sm'><input type='checkbox' checked={authorized} onChange={e => setAuthorized(e.target.checked)}/>I own these videos or have permission to use them.</label><label className='grid gap-2 text-sm'>Upload campaign source<input type='file' accept='video/mp4,video/webm,video/quicktime' className={field} disabled={busy || !authorized} onChange={e => void upload(e.target.files?.[0])}/></label><div className='grid gap-2 sm:grid-cols-[1fr_auto]'><select className={field} aria-label='Existing authorized source' value={existing} onChange={e => setExisting(e.target.value)}><option value=''>Choose an existing authorized XeeClip source</option>{videos.map(v => <option key={v.id} value={v.id}>{v.originalName}</option>)}</select><Button disabled={busy || !existing || !authorized} variant='secondary' onClick={() => void task(() => attach(existing))}>Add existing source</Button></div><details className='rounded-xl border border-border p-3'><summary className='cursor-pointer text-sm'>Import an authorized public YouTube video</summary><p className='my-2 text-xs text-muted-foreground'>Uses the existing import service when enabled. Private/login/DRM restrictions are retained.</p><div className='flex min-w-0 flex-wrap gap-2'><input className={field + ' flex-1'} type='url' aria-label='Public source URL' value={url} onChange={e => setUrl(e.target.value)} placeholder='https://www.youtube.com/watch?v=…'/><Button disabled={busy || !authorized || !url} variant='secondary' onClick={() => void task(async () => { const j = await campaignRequest<VideoImportJob>('/videos/import-url', 'POST', { projectId: campaign.projectId, url, aiMode: 'FALLBACK_ONLY', processingType: 'EDITED_CLIPS', aspectRatio: '9:16', rightsConfirmed: true }); setImports(j); setStatus('Import submitted through the existing source service.'); if (j.status === 'READY' && j.videoId)
        await attach(j.videoId); })}>Import source</Button></div></details>{status && <p role='status' className='text-sm text-primary-soft'>{status}</p>}
  {!campaign.sources.length && <p className='text-sm text-muted-foreground'>Add a source video to generate campaign-matched clips.</p>}{campaign.sources.map(s => <label key={s.id} className='flex min-h-12 min-w-0 items-center gap-3 rounded-xl border border-border p-3 text-sm'><input type='checkbox' checked={selected.includes(s.id)} onChange={e => setSelected(old => e.target.checked ? [...old, s.id] : old.filter(id => id !== s.id))}/><span className='min-w-0 break-all'>{s.video.originalName}<span className='mt-1 block text-xs text-muted-foreground'>{s.video.processingJobs[0]?.status || 'Waiting'}{s.video.processingJobs[0]?.error ? ' · ' + s.video.processingJobs[0].error : ''}</span></span></label>)}</section>
  <section className={panel}><h2 className='font-display text-xl font-semibold'>Create Campaign Clips</h2>{!campaign.brief?.confirmedByUser && <div className='grid gap-2 rounded-xl bg-warning/10 p-4 text-sm text-warning-soft'><p>Confirm the current campaign brief before generation.</p><Button variant='secondary' className='justify-self-start' onClick={onRules}>Review Rules</Button></div>}<Mode value={mode} onChange={setMode} disabled={busy}/><div className='grid gap-3 sm:grid-cols-2'><label className='grid gap-2 text-sm'>Style<select className={field} value={style} onChange={e => setStyle(e.target.value as CampaignStyle)}>{(['STYLEZERO', 'STYLEONE', 'STYLETWO'] as const).map((v, i) => <option key={v} value={v}>{['StyleZero', 'StyleOne', 'StyleTwo'][i]}</option>)}</select></label><label className='grid gap-2 text-sm'>Clips per selected source<input className={field} type='number' min='1' max='20' value={count} onChange={e => setCount(Number(e.target.value))}/></label></div><label className='grid gap-2 text-sm'>Campaign-specific notes<textarea className={area} value={notes} maxLength={1500} onChange={e => setNotes(e.target.value)}/></label><p className='text-xs text-muted-foreground'>Generation reuses the existing engine and credit policy. It may deliver fewer complete moments when campaign rules cannot be met.</p><Button disabled={busy || !campaign.brief?.confirmedByUser || !selected.length} onClick={() => void generate()}>Generate Campaign Clips</Button>
   {campaign.runs.map(r => <div key={r.id} className='grid gap-2 rounded-xl border border-border p-3 text-sm'><p>{r.mode === 'XEEPRO' ? 'XeePro' : 'XeeFree'} · {r.style.replace('STYLE', 'Style')} · {r.status}</p>{r.error && <p role='alert' className='text-warning-soft'>{r.error}</p>}{r.errorCode === 'XEEPRO_BUSY' && <Button className='justify-self-start' variant='secondary' onClick={() => { setMode('XEEFREE'); setStatus('XeeFree selected. Click Generate Campaign Clips when ready.'); }}>Use XeeFree</Button>}</div>)}
  </section></div>;
}
