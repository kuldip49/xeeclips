'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { isAutomaticLook } from '@/lib/automatic-looks';
import { useRouter } from 'next/navigation';
import { Bot, ChevronDown, Download, Expand, Loader2, Minus, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GenerationSetup, type GenerationChoices } from '@/components/generation/generation-setup';
import { ClipPlayerSheet, LazyVideo } from '@/components/generation/lazy-video';
import { StageSteps, stageFromAnalysisLabel } from '@/components/generation/stage-steps';
import { clipDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  createClips,
  deleteHistoryClip,
  getPublicApiBaseUrl,
  getClipAnalysis,
  getClipResults,
  type ClipAnalysis,
  type ClipCard,
  type ClipResults,
  type Video
} from '@/lib/api';
import {
  canCreateClips,
  clampClipCount,
  requestOutputStyle,
  restoreClipCount,
  restoreLook
} from '@/lib/clip-creation-state';
import {
  generationPayload, getCreativeCatalog, getReference, listSavedStyles, resolveCreative, retryGeneratedClipStyle,
  hookEmphasisRuns, sameGenerationRequest,
  type CreativeCatalog, type CreativeResolution, type SavedStyle
} from '@/lib/creative-generation';
import { materializeGeneratedClipForEditing } from '@/lib/edit-mode-api';
import { analysisProgressLabel, ENTRY_TEMPLATE_LABELS, type EntryTemplate } from '@/lib/entry-flow';

function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return <Button type='button' variant='ghost' size='sm' className='h-9 px-3 text-xs coarse:h-10' disabled={!value}
    onClick={() => void copy()}>{copied ? 'Copied' : label}</Button>;
}

function CardSection({ title, copyValue, children }: {
  title: string; copyValue: string; children: React.ReactNode;
}) {
  return <section className='grid gap-1.5'>
    <div className='flex items-center justify-between gap-2'>
      <h5 className='text-xs font-semibold uppercase tracking-wider text-slate-400'>{title}</h5>
      <CopyButton label='Copy' value={copyValue} />
    </div>
    {children}
  </section>;
}

const STYLE_STATUS: Record<string, string> = {
  STYLING: 'Applying your style…', RENDERING: 'Rendering your styled clip…',
  FAILED: 'Styling failed. This is only the clean base clip.',
  BASE_READY: 'Clean base ready.', STYLE_APPLYING: 'Applying your style…',
  STYLE_READY: 'Style applied. Rendering export…',
  STYLE_FAILED: 'Styling failed. This is only the clean base clip.',
  SKIPPED: 'You edited this clip, so your edits were kept.',
  // Historical clips whose style record predates recorded template identity: the backend has
  // already verified a real styled export exists, so this reads as ready, not failed.
  STYLE_UNKNOWN: 'Checking this clip’s styling…'
};
// A clip's styled export is playable once the backend resolves it to one of these - including
// LEGACY_STYLE_READY, which covers historical clips whose generationStyle record predates
// per-record template identity but whose export was independently verified as genuine.
const STYLE_READY_STATUSES = new Set(['EXPORT_READY', 'READY', 'LEGACY_STYLE_READY']);

/**
 * Step 14: every clip is Preview / Edit / Ask AI / Export. Edit and Ask AI open
 * the SAME canonical project; Export downloads what is previewed, no editor needed.
 */
// Automatic 2 frame on the 1080x1920 canvas, mirroring the backend's
// AUTOMATIC_2_STREET3_LAYOUT (media window y 610-1310, hook box y 470-594) and its hook
// style (EB Garamond, 26 design units on the 600-wide canvas, white with red highlights).
const A2_MEDIA = { top: 610 / 1920, height: 700 / 1920 };
const A2_HOOK = { left: 27 / 1080, top: 470 / 1920, width: 1026 / 1080, height: 124 / 1920 };
const A2_HOOK_TEXT = '#FFFFFF';
const A2_HOOK_HIGHLIGHT = '#E53935';

const A2_STAGE: Record<string, string> = {
  STYLE_APPLYING: 'Applying StyleOne…', STYLING: 'Applying StyleOne…',
  STYLE_READY: 'Rendering the final video…', RENDERING: 'Rendering the final video…'
};

/**
 * Until the finished Automatic 2 export exists, the card shows only its progress in the
 * Automatic 2 frame (the hook in its box, a status where the media will be). Nothing playable
 * stands in for the clip: the card plays the finished video once, as soon as it is ready.
 */
function Automatic2Pending({ clip }: { clip: ClipCard }) {
  const stage = A2_STAGE[clip.style?.status ?? ''] ?? 'Applying StyleOne…';
  return <div data-testid='automatic-2-pending' role='status' aria-label={`Clip ${clip.position}: ${stage}`}
    className='relative mx-auto aspect-[9/16] max-h-[72svh] w-full max-w-[calc(72svh*9/16)] overflow-hidden rounded-xl bg-black md:max-h-[560px] md:max-w-[315px]'
    style={{ containerType: 'inline-size' }}>
    <div className='absolute flex items-center justify-center text-center' style={{
      left: `${A2_HOOK.left * 100}%`, top: `${A2_HOOK.top * 100}%`,
      width: `${A2_HOOK.width * 100}%`, height: `${A2_HOOK.height * 100}%` }}>
      <span style={{ fontFamily: 'EB Garamond, serif', fontSize: `${26 / 6}cqw`, lineHeight: 1.14,
        color: A2_HOOK_TEXT, textWrap: 'balance' } as CSSProperties}>
        {hookEmphasisRuns(clip.hook, A2_HOOK_TEXT, [A2_HOOK_HIGHLIGHT]).map((run, index) =>
          <span key={index} style={{ color: run.color }}>{run.text}</span>)}</span>
    </div>
    <div className='absolute left-0 grid w-full place-items-center bg-white/[.04]'
      style={{ top: `${A2_MEDIA.top * 100}%`, height: `${A2_MEDIA.height * 100}%` }}>
      <span className='flex flex-col items-center gap-2 text-center text-xs text-slate-300'>
        <Loader2 className='animate-spin text-violet-300' size={22} aria-hidden />{stage}
        <span className='text-[11px] text-slate-500'>The finished clip appears here automatically.</span>
      </span>
    </div>
  </div>;
}

function ResultCard({ clip, onRetry }: { clip: ClipCard; onRetry: () => Promise<void> }) {
  const router = useRouter();
  const [opening, setOpening] = useState<'EDIT' | 'AI' | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [retryingStyle, setRetryingStyle] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const styled = STYLE_READY_STATUSES.has(clip.style?.status ?? '') &&
    clip.style?.playbackUrl ? clip.style.playbackUrl : null;
  const requiresCanonicalStyle = clip.templateId === 'AUTOMATIC_2';
  const styleBlocked = requiresCanonicalStyle && !styled;
  const styleFailed = styleBlocked && ['FAILED', 'STYLE_FAILED'].includes(clip.style?.status ?? '');
  const src = `${getPublicApiBaseUrl()}${styled ?? clip.playbackUrl}`;
  // An edited clip ships a designed cover with its headline burned in. Showing
  // it as the poster means the hook is on screen before playback, instead of
  // whatever frame the browser happens to decode first.
  const poster = !styled && clip.posterUrl ? `${getPublicApiBaseUrl()}${clip.posterUrl}` : undefined;
  const vertical = styled ? true : clip.height > clip.width;
  const paragraphs = clip.synopsis.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
  const styleBusy = ['STYLE_APPLYING', 'STYLE_READY', 'STYLING', 'RENDERING'].includes(clip.style?.status ?? '');
  const playable = !styleFailed && !styleBlocked;
  const status = styleFailed ? { label: 'Style failed', tone: 'border-amber-400/30 bg-amber-400/10 text-amber-200' }
    : styleBlocked || styleBusy ? { label: 'Processing', tone: 'border-violet-400/30 bg-violet-500/10 text-violet-200' }
      : { label: 'Ready', tone: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200' };
  async function open(target: 'EDIT' | 'AI') {
    if (!clip.isEditable || opening) return;
    setOpening(target);
    setEditError(null);
    try {
      const editUrl = clip.editUrl ?? (await materializeGeneratedClipForEditing(clip.id)).editUrl;
      router.push(target === 'AI' ? `${editUrl}${editUrl.includes('?') ? '&' : '?'}panel=ai` : editUrl);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : 'Could not open this clip in the editor');
      setOpening(null);
    }
  }
  const action = 'h-11 w-full rounded-xl text-sm md:h-10';
  return <article data-testid='clip-result' className='flex min-w-0 flex-col overflow-hidden rounded-[20px] border border-white/[.08] bg-[#111827]'>
    <div className='bg-[#090c15] p-2'>
      {styleFailed
        ? <div className='mx-auto grid aspect-[9/16] max-h-[72svh] w-full max-w-[calc(72svh*9/16)] place-items-center rounded-xl bg-black px-6 text-center text-sm text-slate-400 md:max-h-[560px] md:max-w-[315px]'>
          StyleOne could not be applied. Try again when the clip is ready.
        </div>
        : styleBlocked ? <Automatic2Pending clip={clip} />
          : <LazyVideo src={src} poster={poster} vertical={vertical} label={`Preview clip ${clip.position}`} />}
    </div>
    <div className='flex flex-1 flex-col gap-4 p-4'>
      <div className='flex min-w-0 items-center gap-2'>
        <p className='text-xs font-semibold uppercase tracking-wider text-slate-400'>Clip {clip.position}</p>
        {clip.durationSec ? <span className='text-xs tabular-nums text-slate-500'>· {clipDuration(clip.durationSec)}</span> : null}
        <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', status.tone)}>{status.label}</span>
        <Button type='button' size='icon' variant='ghost' className='ml-auto h-10 w-10 shrink-0 rounded-xl text-slate-300'
          disabled={!playable} aria-label={`Open clip ${clip.position} full screen`} onClick={() => setPlayerOpen(true)}>
          <Expand size={17} aria-hidden /></Button>
      </div>
      <div className='grid grid-cols-2 gap-2'>
        <Button type='button' variant='outline' className={action} disabled={!clip.isEditable || !!opening}
          onClick={() => void open('EDIT')}>
          {opening === 'EDIT' ? <Loader2 className='animate-spin' size={15} /> : <Pencil size={15} />}
          {opening === 'EDIT' ? 'Opening…' : 'Edit'}
        </Button>
        <Button type='button' variant='outline' className={action} disabled={!clip.isEditable || !!opening}
          onClick={() => void open('AI')}>
          {opening === 'AI' ? <Loader2 className='animate-spin' size={15} /> : <Bot size={15} />}Ask AI
        </Button>
        {styleBlocked ? <Button type='button' className={cn(action, 'col-span-2')} disabled><Download size={15} />Export</Button>
          : <Button asChild className={cn(action, 'col-span-2')} aria-disabled={styleBusy}>
            <a href={`${src}${src.includes('?') ? '&' : '?'}download=1`} download aria-label={`Export clip ${clip.position}`}><Download size={15} />Export</a>
          </Button>}
      </div>
      <Button type='button' variant='ghost' className='h-10 w-fit justify-start px-2 text-red-200 hover:bg-red-400/10'
        disabled={deleting || styleBusy} onClick={() => {
          if (!window.confirm('Delete this clip?\n\nThis removes the clip from your history and cannot be undone.')) return;
          setDeleting(true); setEditError(null);
          void deleteHistoryClip(clip.id).then(onRetry).catch(() => setEditError('This clip could not be deleted. Try again.'))
            .finally(() => setDeleting(false));
        }}><Trash2 size={15} />{deleting ? 'Deleting…' : 'Delete'}</Button>
      {clip.style && !STYLE_READY_STATUSES.has(clip.style.status) ? <div className='flex flex-wrap items-center gap-2'>
        <p role='status' className={`flex items-center gap-2 text-xs ${['FAILED', 'STYLE_FAILED'].includes(clip.style.status) ? 'text-amber-300' : 'text-slate-400'}`}>
          {styleBusy ? <Loader2 className='animate-spin' size={12} /> : null}{STYLE_STATUS[clip.style.status] ?? 'Applying style…'}</p>
        {['FAILED', 'STYLE_FAILED'].includes(clip.style.status) ? <Button type='button' size='sm' variant='outline' className='h-10'
          disabled={retryingStyle} onClick={() => { setRetryingStyle(true); setEditError(null);
            void retryGeneratedClipStyle(clip.id).then(onRetry).catch((error) =>
              setEditError(error instanceof Error ? error.message : 'Could not retry styling'))
              .finally(() => setRetryingStyle(false)); }}>
          {retryingStyle ? <Loader2 className='animate-spin' size={12} /> : null}Retry styling</Button> : null}
      </div> : null}
      {editError ? <p className='break-words text-xs text-red-400 [overflow-wrap:anywhere]' role='alert'>{editError}</p> : null}
      <CardSection title='Hook' copyValue={clip.hook}>
        <p className='text-lg font-semibold leading-snug'>{clip.hook}</p>
      </CardSection>
      {/* Phones: the long copy waits behind one tap; desktop shows it as before. */}
      <button type='button' aria-expanded={detailsOpen} onClick={() => setDetailsOpen((value) => !value)}
        className='flex min-h-[44px] items-center justify-between gap-2 rounded-xl border border-white/[.08] px-3 text-sm font-medium text-slate-300 md:hidden'>
        Synopsis, caption & hashtags<ChevronDown size={16} className={cn('transition-transform', detailsOpen && 'rotate-180')} aria-hidden /></button>
      <div className={cn('grid gap-4', !detailsOpen && 'hidden md:grid')}>
        <CardSection title='Synopsis' copyValue={paragraphs.join('\n\n')}>
          <div className='space-y-2 text-sm leading-relaxed text-slate-300'>
            {paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
          </div>
        </CardSection>
        <CardSection title='Caption' copyValue={clip.caption}>
          <p className='whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-300'>{clip.caption}</p>
        </CardSection>
        <CardSection title='Hashtags' copyValue={clip.hashtags.join(' ')}>
          <p className='break-words text-sm text-violet-300'>{clip.hashtags.join(' ')}</p>
        </CardSection>
      </div>
      <p className='mt-auto border-t border-white/[.06] pt-3 text-xs text-slate-500'>{clip.aiModeUsed === 'Online' ? 'XeePro' : 'XeeFree'}</p>
    </div>
    {playable ? <ClipPlayerSheet open={playerOpen} onClose={() => setPlayerOpen(false)} src={src} poster={poster}
      title={`Clip ${clip.position}`} /> : null}
  </article>;
}

const EMPTY_CHOICES: GenerationChoices = { look: null, components: {}, brief: '', reference: null };

export function ClipCreationPanel({ video }: { video: Video }) {
  const job = video.processingJobs?.[0];
  const analysisDone = job?.status === 'COMPLETED';
  // One-step entry: clips were requested with the upload/import and start by themselves.
  const autoStatus = job?.autoGenerationStatus ?? null;
  const autoRequest = autoStatus ? job?.autoGeneration ?? null : null;
  const autoWaiting = autoStatus === 'PENDING' || autoStatus === 'STARTING';
  const autoSettled = autoStatus === 'STARTED' || autoStatus === 'FAILED';
  const autoTemplate = autoRequest?.generation?.templateId as EntryTemplate | undefined;
  const autoTemplateLabel = autoTemplate ? ENTRY_TEMPLATE_LABELS[autoTemplate] ?? autoTemplate : null;
  const [analysis, setAnalysis] = useState<ClipAnalysis | null>(null);
  const [results, setResults] = useState<ClipResults | null>(null);
  // Single authoritative selection for this panel: the look, components, brief and reference.
  const [choices, setChoices] = useState<GenerationChoices>(EMPTY_CHOICES);
  const [catalog, setCatalog] = useState<CreativeCatalog | null>(null);
  const [savedStyles, setSavedStyles] = useState<SavedStyle[]>([]);
  const [resolution, setResolution] = useState<CreativeResolution | null>(null);
  const [resolving, setResolving] = useState(false);
  const [count, setCount] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Backend request state is authoritative; QUEUED and RENDERING are both in progress.
  const requestStatus = analysis?.clipRequest?.status;
  const rendering = requestStatus === 'QUEUED' || requestStatus === 'RENDERING';
  // Styled clips keep changing after delivery (style -> render), so keep polling.
  const styling = results?.clips.some((clip) => {
    const status = clip.style?.status ?? '';
    if (clip.templateId === 'AUTOMATIC_2') return !(['STYLE_FAILED', 'FAILED'].includes(status) ||
      (STYLE_READY_STATUSES.has(status) && !!clip.style?.playbackUrl));
    return ['BASE_READY', 'STYLE_APPLYING', 'STYLE_READY', 'STYLING', 'RENDERING']
      .includes(status);
  }) ?? false;

  const refresh = useCallback(async () => {
    const [nextAnalysis, nextResults] = await Promise.all([
      getClipAnalysis(video.id), getClipResults(video.id)]);
    setAnalysis(nextAnalysis);
    setResults(nextResults);
    return nextAnalysis;
  }, [video.id]);

  // Initial load once analysis is finished; restores a previous request's choices.
  useEffect(() => {
    if (!analysisDone) return;
    let cancelled = false;
    refresh().then(async (loaded) => {
      if (cancelled) return;
      // Restore a previous request's look, otherwise default so the user is never stuck.
      // Before the auto-started request exists, the choices made at upload/import stand in.
      const pending = !loaded.clipRequest && autoRequest ? autoRequest : null;
      const previous = loaded.clipRequest?.generation ?? pending?.generation ?? undefined;
      const reference = previous?.referenceId ? await getReference(previous.referenceId).catch(() => null) : null;
      if (cancelled) return;
      setChoices({ look: pending?.generation?.look ?? restoreLook(loaded.clipRequest),
        components: previous?.components ?? {}, brief: previous?.brief ?? '', reference });
      setCount(pending ? clampClipCount(Number(pending.requestedClipCount), loaded.maxClipCount)
        : restoreClipCount(loaded));
    }, () => { if (!cancelled) setError('Analysis results could not be loaded.'); });
    return () => { cancelled = true; };
    // autoSettled re-reads once the backend has started (or failed to start) the request;
    // autoRequest is only read for that same transition.
  }, [analysisDone, refresh, autoSettled]);

  // The style library is optional: without it the automatic/clean looks still work.
  useEffect(() => {
    if (!analysisDone) return;
    void getCreativeCatalog().then(setCatalog).catch(() => setCatalog(null));
    void listSavedStyles().then(setSavedStyles).catch(() => setSavedStyles([]));
  }, [analysisDone]);

  const payload = useMemo(() => generationPayload({
    templateId: isAutomaticLook(choices.look) ? choices.look : null,
    components: choices.components, brief: choices.brief, referenceId: choices.reference?.id ?? null,
    look: choices.look
  }), [choices]);
  const payloadKey = JSON.stringify(payload) + (choices.reference?.status ?? '');
  const previousBrief = useRef('');

  // Live preview: the backend resolver, debounced. Deterministic brief reading only.
  useEffect(() => {
    if (!analysisDone || !choices.look) return;
    const controller = new AbortController();
    setResolving(true);
    const brief = payload?.brief ?? '';
    const delay = brief !== previousBrief.current ? 500 : 100;
    previousBrief.current = brief;
    const timer = window.setTimeout(() => {
      resolveCreative({ templateId: payload?.templateId ?? null, components: payload?.components ?? {},
        brief, referenceId: payload?.referenceId ?? null,
        sourceWidth: video.width, sourceHeight: video.height }, controller.signal)
        .then(setResolution)
        .catch((error) => { if (error instanceof DOMException && error.name === 'AbortError') return;
          setResolution(null); })
        .finally(() => { if (!controller.signal.aborted) setResolving(false); });
    }, delay);
    return () => { controller.abort(); window.clearTimeout(timer); };
    // payloadKey captures every input that changes the resolution.
  }, [analysisDone, choices.look, payloadKey]);

  const awaitingAuto = analysisDone && autoWaiting;
  useEffect(() => {
    if (!rendering && !styling && !awaitingAuto) return;
    const interval = window.setInterval(() => { void refresh().catch(() => undefined); },
      awaitingAuto ? 2000 : 4000);
    return () => window.clearInterval(interval);
  }, [rendering, styling, awaitingAuto, refresh]);

  const explicitStyle = !!payload && (!!payload.templateId || !!payload.referenceId ||
    Object.keys(payload.components).length > 0);
  const outputStyle = requestOutputStyle(choices.look, resolution ? resolution.resolved.styled || explicitStyle : explicitStyle);

  async function submit() {
    if (!analysis || !outputStyle) return;
    if (!canCreateClips({ analysisReady: analysis.analysisStatus === 'READY', outputStyle,
      requestedClipCount: count, maxClipCount: analysis.maxClipCount, submitting, rendering })) return;
    setSubmitting(true);
    setError(null);
    try {
      // Pressing the button is always an explicit request: when the settings match what is
      // already served, ask the backend to generate again rather than return the old result.
      await createClips(video.id, { requestedClipCount: count, outputStyle, generation: payload,
        regenerate: analysis.clipRequest?.status === 'COMPLETED' });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Clips could not be created.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!job || job.status === 'FAILED') return null;
  if (!analysisDone && autoRequest) {
    const requested = Number(autoRequest.requestedClipCount);
    const label = analysisProgressLabel(video.processingStages);
    return <div className='grid gap-3 rounded-2xl border border-violet-400/15 bg-[#0b0f1a] p-4 sm:p-5' data-testid='entry-progress'>
      <p role='status' className='flex items-center gap-2 text-sm font-semibold'>
        <Loader2 className='animate-spin text-violet-300' size={16} aria-hidden />{label}</p>
      <StageSteps stage={stageFromAnalysisLabel(label)} styleName={autoTemplate === 'AUTOMATIC_2' ? 'StyleOne' : null} />
      <div className='h-1.5 w-full overflow-hidden rounded-full bg-white/[.08]'><div className='h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-all duration-500'
        style={{ width: `${Math.max(3, Math.min(100, job.progress ?? 0))}%` }} /></div>
      <p className='text-xs leading-5 text-slate-400'>Then {requested} clip{requested === 1 ? '' : 's'}{autoTemplateLabel ? ` with ${autoTemplateLabel}` : ''} will be created automatically. You can leave this page — progress is saved.</p>
    </div>;
  }
  if (!analysisDone) {
    return <div className='empty-state'><Loader2 className='animate-spin text-violet-300' size={25} />
      <h3 className='mt-3 font-semibold'>Analyzing your video</h3>
      <p className='mt-1 text-sm text-slate-400'>We are reviewing the entire video. You can choose your clips as soon as this finishes.</p>
    </div>;
  }
  if (!analysis) {
    return error ? <p role='alert' className='rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200'>{error}</p>
      : <div className='grid gap-3'><div className='skeleton h-8 w-48' /><div className='skeleton h-24 w-full' /></div>;
  }
  if (analysis.analysisStatus === 'REJECTED') {
    return <p role='alert' className='rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200'>{analysis.rejectionMessage}</p>;
  }

  const max = analysis.maxClipCount;
  const request = analysis.clipRequest;
  // Cards only for the request the backend is currently serving.
  const clips = results?.outputStyle === request?.outputStyle ? results?.clips ?? [] : [];
  const busy = submitting || rendering;
  const canCreate = canCreateClips({ analysisReady: analysis.analysisStatus === 'READY',
    outputStyle, requestedClipCount: count, maxClipCount: max, submitting, rendering });
  // Same look/brief/count as the clips already shown: the button re-generates them.
  const regenerating = request?.status === 'COMPLETED' && clips.length > 0 &&
    request.requestedClipCount === count && request.outputStyle === outputStyle &&
    sameGenerationRequest(request.generation, payload);
  // Auto-started videos show one continuous flow; the setup stays available, folded away.
  const autoFlow = !!autoRequest && autoStatus !== 'FAILED';
  const requestedTotal = request?.requestedClipCount ?? Number(autoRequest?.requestedClipCount ?? count);
  const styleName = request?.generation?.templateId === 'AUTOMATIC_2' ? 'StyleOne'
    : request?.generation?.templateId === 'AUTOMATIC_RAW' ? 'No Edit'
    : autoTemplateLabel ?? 'the template';
  const flowLabel = !autoFlow ? null
    : autoWaiting || (autoStatus === 'STARTED' && !request) ? 'Finding clips...'
      : rendering ? `Rendering ${Math.min(clips.length + 1, requestedTotal)} / ${requestedTotal}...`
        : styling ? `Applying ${styleName}... ${results?.deliveredClipCount ?? 0} / ${requestedTotal} ready`
          : request?.status === 'COMPLETED' ? 'Ready' : null;
  const setup = <div className='grid min-w-0 gap-6 rounded-2xl border border-violet-400/15 bg-[#0b0f1a] p-4 sm:p-5'>
      <div className='flex items-start gap-3'>
        <Sparkles className='mt-0.5 shrink-0 text-violet-300' size={20} aria-hidden />
        <div><h3 className='text-lg font-semibold'>Create clips</h3>
          <p className='text-sm text-slate-400'>Everything below is optional — pick a count and go, or shape the look and tell us what to find.</p></div>
      </div>
      <GenerationSetup videoId={video.id} catalog={catalog} savedStyles={savedStyles} choices={choices}
        onChange={setChoices} resolution={resolution} resolving={resolving} disabled={submitting} />
      <div className='grid gap-3 border-t border-white/[.06] pt-5'>
        <p className='text-sm text-slate-300'>Maximum clips for this video: <span className='font-semibold text-white'>{max}</span></p>
        <div className='flex items-center justify-between gap-4 sm:justify-start'>
          <span className='text-sm font-medium'>Number of clips</span>
          <div className='flex items-center gap-1.5 rounded-2xl border border-white/10 bg-[#111827] p-1'>
            <Button type='button' size='icon' variant='ghost' className='h-11 w-11 rounded-xl sm:h-9 sm:w-9' aria-label='Fewer clips'
              disabled={busy || count <= 1} onClick={() => setCount((value) => clampClipCount(value - 1, max))}><Minus size={17} /></Button>
            <span className='w-9 text-center text-lg font-semibold tabular-nums' aria-live='polite'>{count}</span>
            <Button type='button' size='icon' variant='ghost' className='h-11 w-11 rounded-xl sm:h-9 sm:w-9' aria-label='More clips'
              disabled={busy || count >= max} onClick={() => setCount((value) => clampClipCount(value + 1, max))}><Plus size={17} /></Button>
          </div>
        </div>
        <Button className='h-12 w-full rounded-2xl text-base sm:h-11 sm:w-auto sm:justify-self-start sm:rounded-xl sm:text-sm' disabled={!canCreate}
          onClick={() => void submit()}>
          {busy ? <><Loader2 className='animate-spin' size={16} />Creating clips...</>
            : `${regenerating ? 'Regenerate' : 'Create'} ${count} Clip${count === 1 ? '' : 's'}`}
        </Button>
        {!outputStyle ? <p className='text-xs text-slate-500'>Choose a look to continue.</p> : null}
        {outputStyle && max < 1 ? <p className='text-xs text-slate-500'>No clips can be created from this video.</p> : null}
      </div>
    </div>;
  return <section className='grid min-w-0 gap-5' aria-label='Create clips'>
    {flowLabel ? <div className='grid gap-2.5 rounded-xl border border-violet-400/15 bg-[#0b0f1a] px-4 py-3'>
      <p role='status' data-testid='entry-flow-status' className='flex items-center gap-2 text-sm font-semibold'>
        {flowLabel === 'Ready' ? <Sparkles className='text-violet-300' size={16} aria-hidden />
          : <Loader2 className='animate-spin text-violet-300' size={16} aria-hidden />}{flowLabel}</p>
      {flowLabel !== 'Ready' ? <StageSteps styleName={request?.generation?.templateId === 'AUTOMATIC_2' || autoTemplate === 'AUTOMATIC_2' ? 'StyleOne' : null}
        stage={flowLabel.startsWith('Finding') ? 'FINDING' : flowLabel.startsWith('Applying') ? 'STYLING' : 'CREATING'} /> : null}
    </div> : null}
    {autoRequest?.adjustedFrom ? <p role='status' className='rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100'>
      You asked for {autoRequest.adjustedFrom} clips. This video allows up to {String(autoRequest.requestedClipCount)}, so {String(autoRequest.requestedClipCount)} are being made.</p> : null}
    {autoStatus === 'FAILED' && job?.autoGenerationError ? <p role='alert' className='rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100'>
      Clips could not start automatically. Your choices are kept below so you can try again.</p> : null}
    {autoFlow ? <details className='group rounded-2xl border border-white/[.08] bg-[#0b0f1a]'>
      <summary className='flex min-h-[48px] cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-slate-300 sm:px-5 [&::-webkit-details-marker]:hidden'>Change template or regenerate
        <ChevronDown size={16} className='shrink-0 transition-transform group-open:rotate-180' aria-hidden /></summary>
      <div className='p-1'>{setup}</div>
    </details> : setup}

    {error ? <p role='alert' className='rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200'>{error}</p> : null}
    {request?.status === 'FAILED' && request.error ? <p role='alert' className='rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200'>{request.error}</p> : null}
    {request?.status === 'COMPLETED' && request.error ? <p role='status' className='rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100'>{request.error}</p> : null}
    {rendering && !autoFlow ? <p className='text-sm text-slate-400' role='status'>
      {results?.deliveredClipCount ?? 0} / {request?.requestedClipCount ?? count} clips ready</p> : null}
    {request?.status === 'COMPLETED' && !submitting ? <p className='text-sm text-slate-300' role='status'>
      {results?.deliveredClipCount ?? clips.length} of {request.requestedClipCount ?? clips.length} clip{request.requestedClipCount === 1 ? '' : 's'} generated
      {results?.deliveryStatus === 'PARTIAL' ? ' (partial delivery).' : results?.deliveryStatus === 'FAILED' ? ' (failed).' : '.'}</p> : null}

    {clips.length ? <div className='grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3'>
      {clips.map((clip) => <ResultCard clip={clip} key={clip.id}
        onRetry={async () => { await refresh(); }} />)}
    </div> : null}
  </section>;
}
