'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { applyQuickStyle, chooseManual, confirmCrop, defaultStep, editorUrl, isProcessing, mediaUrl, preparePlayback, quickReframeUrl, quickStyleOf, reframeRequest, revertCrop, savePlan,
  uploadReframe, type ReframePlan, type ReframeSession, type ReframeStep } from '@/lib/quick-reframe-api';
import { cropIssue } from '@/lib/quick-reframe-crop';
import { StepIndicator } from './step-indicator';
import { CropStep } from './crop-step';
import { ChooseStep, type ChooseAction } from './choose-step';
import { StyleOneStep } from './styleone-step';
import { ExportStep } from './export-step';

const field = 'min-h-11 w-full min-w-0 rounded-xl border border-border bg-background px-3 text-sm';
const STORAGE_KEY = 'quick-reframe-session';
const readStorage = () => { try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; } };
const writeStorage = (value: string | null) => { try { if (value) window.localStorage.setItem(STORAGE_KEY, value); else window.localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ } };

/**
 * Quick Reframe V3: Import → 1. Crop (fully manual) → 2. Choose Style → 3. Edit → 4. Export.
 * No AI runs before Done Cropping and a chosen editing mode; Manual editing opens the real XeeClip editor.
 */
export function QuickReframeWorkspace() {
  const router = useRouter();
  const [session, setSession] = useState<ReframeSession | null>(null);
  const [plan, setPlan] = useState<ReframePlan | null>(null);
  const [step, setStepState] = useState<ReframeStep>('crop');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const afterJob = useRef<ReframeStep | null>(null);
  const loaded = useRef(false);
  /** The crop as it was when the crop step opened: Cancel returns to it when nothing was confirmed yet. */
  const cropBaseline = useRef<ReframePlan | null>(null);

  const setStep = useCallback((next: ReframeStep, id?: string) => {
    setStepState(next);
    if (id) window.history.replaceState(null, '', quickReframeUrl(id, next));
  }, []);
  /** Server state wins, except a crop draft the user is still changing. */
  const accept = useCallback((next: ReframeSession) => {
    setSession(next);
    if (!dirty.current) setPlan(next.plan);
  }, []);

  useEffect(() => {
    if (loaded.current) return; loaded.current = true;
    const params = new URLSearchParams(window.location.search);
    const id = params.get('video') || readStorage();
    if (!id) { setLoading(false); return; }
    reframeRequest(`/${encodeURIComponent(id)}`).then((s) => {
      accept(s);
      const requested = params.get('step') as ReframeStep | null;
      const fallback = defaultStep(s);
      const allowed = requested && (requested === 'crop' || (requested === 'choose' && s.cropConfirmed) || ((requested === 'edit' || requested === 'export') && s.cropConfirmed && !!s.editPath));
      const target = allowed ? requested! : fallback;
      if (target === 'edit' && s.editPath === 'MANUAL' && !requested) { setStep('choose', s.id); return; }
      setStep(target, s.id);
    }).catch(() => writeStorage(null)).finally(() => setLoading(false));
  }, [accept, setStep]);
  useEffect(() => { if (session?.id) writeStorage(session.id); }, [session?.id]);

  // Poll while the server works; then move on to the step the finished job unlocks.
  const processing = isProcessing(session);
  useEffect(() => {
    if (!processing || !session) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      reframeRequest(`/${session.id}`).then((s) => {
        if (stopped) return;
        accept(s);
        if (!isProcessing(s)) {
          if (s.status === 'FAILED') { setError(s.error || 'Processing failed. Please retry.'); afterJob.current = null; return; }
          if (afterJob.current === 'edit' && s.editPath === 'MANUAL') { afterJob.current = null; router.push(editorUrl(s)); return; }
          if (afterJob.current) { setStep(afterJob.current, s.id); afterJob.current = null; }
        }
      }).catch(() => { if (!stopped) setError('Connection interrupted. Your progress is saved.'); });
    }, 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, [processing, session?.id, accept, setStep, router]); // eslint-disable-line react-hooks/exhaustive-deps

  const action = async (task: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await task(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Please retry.'); }
    finally { setBusy(false); }
  };
  const ensure = async () => session ?? await reframeRequest<ReframeSession>('', 'POST');
  const playback = async (s: ReframeSession) => accept(await preparePlayback(s.id));
  const upload = () => action(async () => {
    if (!file) return;
    const s = await ensure(); accept(s); setUploading(true); setUploadPercent(0); abort.current = new AbortController();
    try { const uploaded = await uploadReframe(s.id, file, setUploadPercent, abort.current.signal); accept(uploaded); setStep('crop', uploaded.id); await playback(uploaded); }
    finally { setUploading(false); }
  });
  const importLink = () => action(async () => {
    const s = await ensure(); accept(s); afterJob.current = 'crop';
    accept(await reframeRequest(`/${s.id}/import`, 'POST', { url, authorized }));
  });
  // A finished import still needs browser playback and its whole-frame draft before cropping.
  useEffect(() => {
    if (session && session.sourceUrl && !session.plan && session.status === 'INPUT' && !busy && !uploading) void action(() => playback(session));
  }, [session?.status, session?.sourceUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (step === 'crop' && plan && !cropBaseline.current) cropBaseline.current = plan; if (step !== 'crop') cropBaseline.current = null; }, [step, plan]);

  // --- Crop draft: saved quietly (debounced) so a refresh keeps it; Done bakes it into the source. ---
  const flush = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (!session || !plan || !dirty.current) return session;
    const saved = await savePlan(session, plan); dirty.current = false; setSession(saved); return saved;
  }, [session, plan]);
  const changePlan = (next: ReframePlan) => {
    setPlan(next); dirty.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (!session || cropIssue(next.crop, session.width || 16, session.height || 9)) return;
    saveTimer.current = setTimeout(() => { void savePlan(session, next).then((saved) => { dirty.current = false; setSession(saved); })
      .catch((caught) => setError(caught instanceof Error ? caught.message : 'The crop could not be saved.')); }, 700);
  };
  const done = () => action(async () => {
    const saved = await flush(); if (!saved) return;
    afterJob.current = saved.editPath ? 'edit' : 'choose';
    accept(await confirmCrop(saved));
  });
  const cancelCrop = () => action(async () => {
    if (!session) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    dirty.current = false;
    if (session.confirmed) { const reverted = await revertCrop(session); accept(reverted); setPlan(reverted.plan); setStep(reverted.editPath ? 'edit' : 'choose', reverted.id); }
    else if (cropBaseline.current) changePlan(cropBaseline.current);
  });
  const choose = (choice: ChooseAction) => action(async () => {
    if (!session) return;
    if (choice.kind === 'STYLEONE' || choice.kind === 'STYLETWO') { const next = await applyQuickStyle(session, choice.kind); accept(next);
      // The first style checks speech and captions first; the step opens when that job hands over.
      if (next.status === 'ANALYZE') afterJob.current = 'edit'; else setStep('edit', next.id); return; }
    const next = await chooseManual(session, choice.removeStyleOne); accept(next); router.push(editorUrl(next, 'hooks'));
  });
  const goTo = (next: ReframeStep) => {
    if (!session) return;
    if (next === 'edit' && session.editPath === 'MANUAL') { router.push(editorUrl(session)); return; }
    void reframeRequest(`/${session.id}`).then(accept).catch(() => undefined);
    setStep(next, session.id);
  };
  const reachable = (target: ReframeStep) => !!session?.plan && !processing && (target === 'crop' || (target === 'choose' && session.cropConfirmed) ||
    ((target === 'edit' || target === 'export') && session.cropConfirmed && !!session.editPath));
  const reset = () => { abort.current?.abort(); setSession(null); setPlan(null); setFile(null); setError(''); dirty.current = false; writeStorage(null); window.history.replaceState(null, '', '/quick-reframe'); setStep('crop'); };

  const hasSource = !!session?.sourceUrl;
  return <div className='grid min-w-0 gap-6 pb-8'>
    <header className='flex flex-wrap items-start justify-between gap-4'>
      <div><p className='eyebrow'>Crop first. Then style.</p>
        <h1 className='mt-2 font-display text-3xl font-bold tracking-tight sm:text-4xl'>Quick Reframe AI</h1>
        {!hasSource && <p className='mt-3 max-w-xl text-sm text-muted-foreground'>Crop your video, then let StyleOne or StyleTwo finish it, or edit it yourself. One video, full length, original sound. Up to 3 minutes.</p>}</div>
      {session && <Button type='button' variant='secondary' disabled={busy || processing} onClick={reset}>New video</Button>}
    </header>
    {hasSource && <StepIndicator active={step} reachable={reachable} onSelect={goTo} />}
    {(error || (session?.status === 'FAILED' && session.error)) && <p role='alert' className='rounded-xl border border-warning/30 bg-warning/10 p-3 text-sm text-warning-soft'>{error || session?.error}</p>}
    {loading && <p role='status' className='flex items-center gap-2 text-sm text-muted-foreground'><Loader2 size={16} className='animate-spin' />Loading your video…</p>}

    {!loading && !hasSource && !processing && !uploading && <section className='grid min-w-0 gap-5 rounded-2xl border border-border bg-surface p-4 sm:p-6 md:grid-cols-2'>
      <div className='grid gap-3'><h2 className='font-display font-semibold'>Upload your video</h2>
        <label className='flex min-h-32 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border-strong p-4 text-center'>
          <Upload className='text-primary-soft' size={24} /><span className='break-all text-sm'>{file?.name || 'Choose MP4, MOV, M4V, or WebM'}</span>
          <span className='text-xs text-muted-foreground'>Up to 180 seconds · 1 GiB</span>
          <input aria-label='Upload video' className='sr-only' type='file' accept='video/mp4,video/quicktime,video/webm,video/x-m4v,.mp4,.mov,.m4v,.webm' onChange={(e) => { setFile(e.target.files?.[0] || null); setError(''); }} /></label>
        <Button type='button' disabled={!file || busy} onClick={() => void upload()}><Upload size={16} />Upload video</Button></div>
      <div className='grid content-start gap-3'><h2 className='font-display font-semibold'>Paste a video link</h2>
        <input aria-label='Instagram or X video link' className={field} placeholder='Instagram Reel or X video link' type='url' value={url} onChange={(e) => setUrl(e.target.value)} />
        <label className='flex items-start gap-3 text-xs text-muted-foreground'><input type='checkbox' className='mt-1' checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} />I own this video or have permission to process it.</label>
        <Button type='button' variant='secondary' disabled={!url || !authorized || busy} onClick={() => void importLink()}>Import video</Button>
        <p className='text-xs text-muted-foreground'>Public eligible videos only. If import is unavailable, upload your authorized source file.</p></div>
    </section>}
    {uploading && <div role='status' className='grid gap-3 rounded-xl border border-border p-4'><span className='text-sm'>Uploading video · {uploadPercent}%</span>
      <progress className='w-full accent-primary' max={100} value={uploadPercent} /><Button type='button' variant='secondary' className='justify-self-start' onClick={() => abort.current?.abort()}>Cancel upload</Button></div>}
    {processing && session && !(step === 'edit' && !!quickStyleOf(session)) && !(step === 'export' && ['PREVIEW', 'EXPORT'].includes(session.status)) &&
      <div role='status' aria-live='polite' className='grid gap-3 rounded-xl border border-border bg-surface p-4'>
        <p className='flex items-center gap-2 text-sm'><Loader2 size={18} className='animate-spin text-primary-soft' />{session.message}</p>
        <progress className='w-full accent-primary' value={session.progress || 0} max={100} />
        <Button type='button' variant='secondary' className='justify-self-start' onClick={() => void action(async () => accept(await reframeRequest(`/${session.id}/cancel`, 'POST')))}>Cancel</Button></div>}

    {session && hasSource && step === 'crop' && (plan
      ? <CropStep session={session} plan={plan} busy={busy || processing} confirmed={!!session.confirmed} onChange={changePlan} onDone={() => void done()} onCancel={() => void cancelCrop()} />
      : processing ? session.originalUrl && <div className='mx-auto w-full max-w-3xl overflow-hidden rounded-2xl bg-black'>
          <video src={mediaUrl(session.originalUrl)} controls playsInline preload='metadata' aria-label='Your video' className='max-h-[56vh] w-full object-contain' /></div>
      : <div className='grid gap-3 rounded-xl border border-border bg-surface p-4'><p className='text-sm text-muted-foreground'>Your video needs to be prepared for cropping.</p>
        <Button type='button' className='justify-self-start' disabled={busy} onClick={() => void action(() => playback(session))}>Prepare video</Button></div>)}
    {session && step === 'choose' && session.cropConfirmed && !processing && <ChooseStep session={session} busy={busy} onChoose={(c) => void choose(c)} onBack={() => goTo('crop')} />}
    {session && step === 'edit' && !!quickStyleOf(session) && <StyleOneStep session={session} onSession={accept} onError={setError} onStep={(s) => goTo(s)} />}
    {session && step === 'export' && session.editPath && <ExportStep session={session} onSession={accept} onError={setError}
      onBack={() => session.editPath === 'MANUAL' ? router.push(editorUrl(session)) : goTo('edit')} />}
  </div>;
}
