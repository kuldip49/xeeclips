'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Circle, Download, Loader2, Minus, Plus, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  createClips,
  getApiBaseUrl,
  getClipAnalysis,
  getClipResults,
  type ClipAnalysis,
  type ClipCard,
  type ClipResults,
  type OutputStyle,
  type Video
} from '@/lib/api';
import {
  canCreateClips,
  clampClipCount,
  restoreClipCount,
  restoreOutputStyle
} from '@/lib/clip-creation-state';
import { cn } from '@/lib/utils';

const outputStyles: Array<{ value: OutputStyle; title: string; description: string }> = [
  { value: 'NORMAL', title: 'Normal Clips', description: 'The best moments, cut cleanly at natural start and end points. No added effects.' },
  { value: 'AI_EDITED', title: 'AI Edited Clips', description: 'Fully edited: hook, subtitles, reframing, zoom, background, color, music and pacing.' }
];

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
  return <Button type='button' variant='ghost' size='sm' className='h-7 px-2 text-xs' disabled={!value}
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

function ResultCard({ clip }: { clip: ClipCard }) {
  const src = `${getApiBaseUrl()}${clip.playbackUrl}`;
  // An edited clip ships a designed cover with its headline burned in. Showing
  // it as the poster means the hook is on screen before playback, instead of
  // whatever frame the browser happens to decode first.
  const poster = clip.posterUrl ? `${getApiBaseUrl()}${clip.posterUrl}` : undefined;
  const vertical = clip.height > clip.width;
  const paragraphs = clip.synopsis.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
  return <article className='flex min-w-0 flex-col overflow-hidden rounded-2xl border border-white/[.08] bg-[#111827]'>
    <div className='bg-[#090c15] p-2'>
      <video className={cn('mx-auto w-full rounded-xl bg-black object-contain', vertical ? 'aspect-[9/16] max-h-[560px]' : 'aspect-video')}
        controls preload={poster ? 'none' : 'metadata'} poster={poster} src={src} />
    </div>
    <div className='flex flex-1 flex-col gap-4 p-4'>
      <div className='flex items-center justify-between gap-2'>
        <p className='text-xs font-semibold uppercase tracking-wider text-slate-500'>Clip {clip.position}</p>
        <Button asChild size='sm' variant='outline'><a href={src} download><Download size={14} />Download</a></Button>
      </div>
      <CardSection title='Hook' copyValue={clip.hook}>
        <p className='text-lg font-semibold leading-snug'>{clip.hook}</p>
      </CardSection>
      <CardSection title='Synopsis' copyValue={paragraphs.join('\n\n')}>
        <div className='space-y-2 text-sm leading-relaxed text-slate-300'>
          {paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
        </div>
      </CardSection>
      <CardSection title='Caption' copyValue={clip.caption}>
        <p className='whitespace-pre-wrap text-sm leading-relaxed text-slate-300'>{clip.caption}</p>
      </CardSection>
      <CardSection title='Hashtags' copyValue={clip.hashtags.join(' ')}>
        <p className='break-words text-sm text-violet-300'>{clip.hashtags.join(' ')}</p>
      </CardSection>
      <p className='mt-auto border-t border-white/[.06] pt-3 text-xs text-slate-500'>AI mode used: {clip.aiModeUsed}</p>
    </div>
  </article>;
}

export function ClipCreationPanel({ video }: { video: Video }) {
  const job = video.processingJobs?.[0];
  const analysisDone = job?.status === 'COMPLETED';
  const [analysis, setAnalysis] = useState<ClipAnalysis | null>(null);
  const [results, setResults] = useState<ClipResults | null>(null);
  // Single authoritative selection for this panel; nothing else stores an output style.
  const [outputStyle, setOutputStyle] = useState<OutputStyle | null>(null);
  const [count, setCount] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Backend request state is authoritative; QUEUED and RENDERING are both in progress.
  const requestStatus = analysis?.clipRequest?.status;
  const rendering = requestStatus === 'QUEUED' || requestStatus === 'RENDERING';

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
    refresh().then((loaded) => {
      if (cancelled) return;
      // Restore a previous request's style, otherwise default so the user is never stuck.
      setOutputStyle(restoreOutputStyle(loaded.clipRequest));
      setCount(restoreClipCount(loaded));
    }, () => { if (!cancelled) setError('Analysis results could not be loaded.'); });
    return () => { cancelled = true; };
  }, [analysisDone, refresh]);

  useEffect(() => {
    if (!rendering) return;
    const interval = window.setInterval(() => { void refresh().catch(() => undefined); }, 4000);
    return () => window.clearInterval(interval);
  }, [rendering, refresh]);

  async function submit() {
    if (!analysis || !outputStyle) return;
    if (!canCreateClips({ analysisReady: analysis.analysisStatus === 'READY', outputStyle,
      requestedClipCount: count, maxClipCount: analysis.maxClipCount, submitting, rendering })) return;
    setSubmitting(true);
    setError(null);
    try {
      await createClips(video.id, { requestedClipCount: count, outputStyle });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Clips could not be created.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!job || job.status === 'FAILED') return null;
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
  // Cards only for the style the backend is currently serving.
  const clips = results?.outputStyle === request?.outputStyle ? results?.clips ?? [] : [];
  const busy = submitting || rendering;
  const canCreate = canCreateClips({ analysisReady: analysis.analysisStatus === 'READY',
    outputStyle, requestedClipCount: count, maxClipCount: max, submitting, rendering });
  return <section className='grid min-w-0 gap-5' aria-label='Create clips'>
    <div className='grid gap-5 rounded-2xl border border-violet-400/15 bg-[#0d111c] p-5'>
      <div className='flex items-start gap-3'>
        <Sparkles className='mt-0.5 shrink-0 text-violet-300' size={20} aria-hidden />
        <div><h3 className='text-lg font-semibold'>Analysis complete</h3>
          <p className='text-sm text-slate-400'>Your video is ready.</p></div>
      </div>
      {/* Native radios: the whole card is the label, so clicks, Enter/Space and arrow keys all work.
          Only a live submit freezes the choice — a queued render must never trap the user here. */}
      <fieldset className='grid gap-3' disabled={submitting}>
        <legend className='mb-2 text-sm font-medium'>Output style</legend>
        <div className='grid gap-3 sm:grid-cols-2'>
          {outputStyles.map((option) => {
            const selected = outputStyle === option.value;
            const Indicator = selected ? CheckCircle2 : Circle;
            return <label key={option.value} data-output-style={option.value} data-selected={selected}
              className={cn('block cursor-pointer rounded-2xl border p-4 text-left transition-colors focus-within:ring-2 focus-within:ring-violet-400',
                selected ? 'border-violet-400 bg-violet-500/10' : 'border-white/10 bg-[#111827] hover:border-white/25')}>
              <input type='radio' className='sr-only' name={`output-style-${video.id}`}
                value={option.value} checked={selected}
                onChange={() => setOutputStyle(option.value)} />
              <span className='flex items-center justify-between text-sm font-semibold'>{option.title}<Indicator size={18} className={selected ? 'text-violet-300' : 'text-slate-600'} aria-hidden /></span>
              <span className='mt-1.5 block text-xs leading-5 text-slate-400'>{option.description}</span>
            </label>;
          })}
        </div>
      </fieldset>
      <div className='grid gap-3'>
        <p className='text-sm text-slate-300'>Maximum clips for this video: <span className='font-semibold text-white'>{max}</span></p>
        <div className='flex flex-wrap items-center gap-4'>
          <span className='text-sm font-medium'>Number of clips</span>
          <div className='flex items-center gap-2'>
            <Button type='button' size='sm' variant='outline' aria-label='Fewer clips'
              disabled={busy || count <= 1} onClick={() => setCount((value) => clampClipCount(value - 1, max))}><Minus size={15} /></Button>
            <span className='w-10 text-center text-lg font-semibold tabular-nums' aria-live='polite'>{count}</span>
            <Button type='button' size='sm' variant='outline' aria-label='More clips'
              disabled={busy || count >= max} onClick={() => setCount((value) => clampClipCount(value + 1, max))}><Plus size={15} /></Button>
          </div>
        </div>
        <Button className='h-11 w-full sm:w-auto sm:justify-self-start' disabled={!canCreate}
          onClick={() => void submit()}>
          {busy ? <><Loader2 className='animate-spin' size={16} />Creating clips...</>
            : `Create ${count} Clip${count === 1 ? '' : 's'}`}
        </Button>
        {!outputStyle ? <p className='text-xs text-slate-500'>Choose an output style to continue.</p> : null}
        {outputStyle && max < 1 ? <p className='text-xs text-slate-500'>No clips can be created from this video.</p> : null}
      </div>
    </div>

    {error ? <p role='alert' className='rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200'>{error}</p> : null}
    {request?.status === 'FAILED' && request.error ? <p role='alert' className='rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200'>{request.error}</p> : null}
    {request?.status === 'COMPLETED' && request.error ? <p role='status' className='rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100'>{request.error}</p> : null}
    {rendering ? <p className='text-sm text-slate-400' role='status'>
      Creating your clips — {request?.returnedClipCount ?? 0} of {request?.requestedClipCount ?? 0} ready.</p> : null}
    {request?.status === 'COMPLETED' && !submitting ? <p className='text-sm text-slate-300' role='status'>
      {clips.length} clip{clips.length === 1 ? ' was' : 's were'} created from this video.</p> : null}

    {clips.length ? <div className='grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3'>
      {clips.map((clip) => <ResultCard clip={clip} key={clip.id} />)}
    </div> : null}
  </section>;
}
