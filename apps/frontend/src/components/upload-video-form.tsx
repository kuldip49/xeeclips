'use client';
import { useAuth } from '@/components/auth-provider';

import { ChangeEvent, DragEvent, FormEvent, useEffect, useRef, useState } from 'react';
import { RAW_LOOK } from '@/lib/automatic-looks';
import { useRouter } from 'next/navigation';
import { CheckCircle2, ChevronDown, Circle, ClipboardPaste, FileVideo, FolderOpen, Link2, Loader2, Minus, Plus,
  SlidersHorizontal, Sparkles, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TARGET_PLATFORM_LABELS, uploadVideo, importYouTubeVideo, getVideoImportCapabilities,
  type OutputAspectRatio, type TargetPlatform } from '@/lib/api';
import { CLIP_LIMIT_HINT, DEFAULT_ENTRY_SETTINGS, ENTRY_MAX_CLIPS, entryGenerationRequest, maxClipsForDuration,
  type EntrySettings, type EntrySource, type EntryTemplate } from '@/lib/entry-flow';
import { clipDuration, formatBytes } from '@/lib/format';
import { isServerUnavailable } from '@/lib/use-backend-status';
import { cn } from '@/lib/utils';

const MAX_VIDEO_SECONDS = 7200;
const YOUTUBE_LINK = /^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?|shorts\/)|youtu\.be\/)/i;
const YOUTUBE_ID = /(?:[?&]v=|youtu\.be\/|shorts\/)([\w-]{6,})/i;
const FALLBACK_HINT = 'You can upload the video file instead.';
const OFFLINE_MESSAGE = 'Processing server is currently offline. Try again when it is back.';

/** Best-effort early length check; the backend enforces the limit, so a browser that never
 * loads the metadata (background tabs can stall it) must not block the upload. */
function readDuration(file: File) {
  return new Promise<number | null>((resolve) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    let settled = false;
    const done = (value: number | null) => {
      if (settled) return;
      settled = true; window.clearTimeout(timer); URL.revokeObjectURL(url); resolve(value);
    };
    const timer = window.setTimeout(() => done(null), 4000);
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => done(Number.isFinite(probe.duration) ? probe.duration : null);
    probe.onerror = () => done(null);
    probe.src = url;
  });
}

/** A readable project name for the one-step Create page, where no project exists yet. */
function projectNameFor(source: EntrySource, file: File | null, url: string) {
  if (source === 'file' && file) return file.name.replace(/\.[^.]+$/u, '').trim().slice(0, 100) || 'New clips';
  const id = YOUTUBE_ID.exec(url)?.[1];
  return id ? `YouTube · ${id}` : 'YouTube clips';
}

/**
 * One-step entry: a file or a YouTube link, a template and a clip count, then one Generate.
 * The choices travel with the upload/import and the backend starts clip creation as soon as
 * analysis completes - there is no second button. Whether a link can be imported stays a
 * server decision; a refusal keeps every choice and offers the file upload instead.
 *
 * On a project page it uploads into that project. On the Create page (no `projectId`) the
 * project is created on submit and `onStarted` takes the user to it.
 */
export function UploadVideoForm({ projectId, createProject, onStarted, initialSettings, initialSource,
  initialNotice, onSettingsChange, showHeading = true, stickyCta = false, offline = false }: {
  projectId?: string;
  /** Creates the project for the Create page; called once, reused if a retry is needed. */
  createProject?: (name: string) => Promise<string>;
  /** The upload/import has started for this project. */
  onStarted?: (projectId: string) => void;
  initialSettings?: EntrySettings;
  /** Lets the workspace keep the last choices when this form remounts. */
  onSettingsChange?: (settings: EntrySettings) => void;
  initialSource?: EntrySource;
  /** Shown above the form, e.g. why a YouTube import fell back to a file upload. */
  initialNotice?: string | null;
  showHeading?: boolean;
  /** Keep Generate pinned above the mobile tab bar (Create page). */
  stickyCta?: boolean;
  /** The processing server is unreachable: everything stays editable but Generate is paused. */
  offline?: boolean;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const noCredits = user?.role !== 'ADMIN' && (user?.creditBalance ?? 0) <= 0;
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const createdProject = useRef<string | null>(projectId ?? null);
  const formKey = projectId ?? 'new';
  const [settings, setSettings] = useState<EntrySettings>(initialSettings ?? DEFAULT_ENTRY_SETTINGS);
  const [source, setSource] = useState<EntrySource>(initialSource ?? 'youtube');
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [youtubeEnabled, setYoutubeEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [error, setError] = useState<{ message: string; fallback: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice ?? null);
  const [dragging, setDragging] = useState(false);
  const [canPaste, setCanPaste] = useState(false);
  // A chosen file's length decides how many clips it allows; a YouTube link is checked later.
  const [fileDuration, setFileDuration] = useState<number | null>(null);
  const maxClips = source === 'file' && fileDuration ? maxClipsForDuration(fileDuration) : ENTRY_MAX_CLIPS;

  useEffect(() => {
    let active = true;
    void getVideoImportCapabilities().then((result) => {
      if (active) { setYoutubeEnabled(result.youtubeEnabled); if (!result.youtubeEnabled) setSource('file'); }
    }).catch(() => undefined);
    setCanPaste(typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function');
    return () => { active = false; abortRef.current?.abort(); };
  }, []);

  useEffect(() => { onSettingsChange?.(settings); }, [settings, onSettingsChange]);
  const update = (patch: Partial<EntrySettings>) => setSettings((current) => ({ ...current, ...patch }));
  useEffect(() => {
    setSettings((current) => current.count > maxClips ? { ...current, count: maxClips } : current);
  }, [maxClips]);
  const templates: Array<{ value: EntryTemplate; title: string; description: string }> = [
    { value: 'AUTOMATIC_1', title: 'StyleZero', description: 'Clean framing, captions and subtle zooms.' },
    { value: 'AUTOMATIC_2', title: 'StyleOne',
      description: 'Editorial black canvas, serif headline and red highlights.' },
    RAW_LOOK
  ];

  function clearFile() {
    setFile(null);
    setFileDuration(null);
    if (inputRef.current) inputRef.current.value = '';
  }
  function chooseFile(next: File | null) {
    setFile(next); setError(null); setNotice(null); setFileDuration(null);
    if (next) void readDuration(next).then((seconds) => setFileDuration(seconds));
  }
  function handleFile(event: ChangeEvent<HTMLInputElement>) { chooseFile(event.target.files?.[0] ?? null); }
  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); setDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped?.type.startsWith('video/')) chooseFile(dropped);
    else setError({ message: 'Choose a supported video file.', fallback: false });
  }
  function switchToUpload() { setSource('file'); setError(null); }
  async function pasteLink() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) { setSourceUrl(text); setError(null); setNotice(null); }
    } catch { /* clipboard permission refused: typing/pasting by hand still works */ }
  }

  async function targetProject() {
    if (createdProject.current) return createdProject.current;
    if (!createProject) throw new Error('No project to add this video to.');
    createdProject.current = await createProject(projectNameFor(source, file, sourceUrl.trim()));
    return createdProject.current;
  }

  async function submitFile() {
    if (!file) { setError({ message: 'Select a video to upload.', fallback: false }); return false; }
    const duration = await readDuration(file);
    if (duration != null && duration > MAX_VIDEO_SECONDS) {
      setError({ message: 'This video is longer than the 2-hour limit. Please upload a video shorter than 2 hours.',
        fallback: false });
      return false;
    }
    const target = await targetProject();
    const formData = new FormData();
    formData.set('file', file);
    formData.set('aiMode', settings.aiMode);
    formData.set('processingType', 'EDITED_CLIPS');
    formData.set('aspectRatio', settings.aspectRatio);
    formData.set('targetPlatform', settings.platform);
    formData.set('generationRequest', JSON.stringify(entryGenerationRequest(settings)));
    abortRef.current = new AbortController();
    await uploadVideo(target, formData, (completed, total) => {
      setUploadProgress(Math.round(completed * 100 / total));
    }, abortRef.current.signal);
    clearFile();
    return true;
  }

  async function submitLink() {
    if (!YOUTUBE_LINK.test(sourceUrl.trim())) {
      setError({ message: 'Enter a YouTube video link.', fallback: false });
      return false;
    }
    if (!rightsConfirmed) {
      setError({ message: 'Confirm you have the right to process this video.', fallback: false });
      return false;
    }
    const target = await targetProject();
    await importYouTubeVideo({ projectId: target, url: sourceUrl.trim(), aiMode: settings.aiMode,
      processingType: 'EDITED_CLIPS', aspectRatio: settings.aspectRatio, targetPlatform: settings.platform,
      rightsConfirmed: true, generationRequest: entryGenerationRequest(settings) });
    setSourceUrl('');
    setRightsConfirmed(false);
    return true;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (offline) return;
    setError(null); setNotice(null); setUploadProgress(null); setBusy(true);
    try {
      const started = source === 'youtube' ? await submitLink() : await submitFile();
      if (!started) return;
      if (onStarted && createdProject.current) onStarted(createdProject.current);
      // Settings stay as chosen; the new source and its progress appear below.
      else router.refresh();
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        setNotice('Upload cancelled. Your file and choices are kept — tap Generate to try again.');
        return;
      }
      const message = isServerUnavailable(cause) ? OFFLINE_MESSAGE
        : cause instanceof Error ? cause.message : 'Clips could not be started.';
      setError({ message, fallback: source === 'youtube' && !isServerUnavailable(cause) });
    } finally { setBusy(false); abortRef.current = null; }
  }

  const ready = source === 'youtube' ? !!sourceUrl.trim() && rightsConfirmed : !!file;
  const linkDetected = YOUTUBE_LINK.test(sourceUrl.trim());
  const uploading = busy && source === 'file';
  const busyLabel = source === 'youtube' ? 'Starting import...' : uploadProgress === 100 ? 'Finishing upload...'
    : uploadProgress == null ? 'Uploading video...' : `Uploading video... ${uploadProgress}%`;
  const advancedSummary = `${TARGET_PLATFORM_LABELS[settings.platform]}, ${settings.aspectRatio}${settings.brief.trim() ? ', with a description' : ''}`;

  return <form className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6' onSubmit={onSubmit} aria-label='Generate clips'>
    {showHeading ? <div><p className='eyebrow'>Create short clips</p><h2 className='mt-2 text-xl font-bold tracking-tight sm:text-2xl'>Generate clips</h2>
      <p className='mt-1.5 text-sm leading-6 text-muted-foreground'>Add a video, pick a template and how many clips you want. We handle the rest and show each clip as it is ready.</p></div> : null}

    {notice ? <p role='status' className='rounded-xl border border-warning/20 bg-warning/5 p-3 text-sm text-warning-soft'>{notice}</p> : null}

    <section className='grid gap-3' aria-label='Video source'>
      <p className='eyebrow'>Source</p>
      <div className='grid w-full grid-cols-2 rounded-2xl border border-border bg-sunken p-1 sm:inline-grid sm:w-fit' role='tablist' aria-label='Video source'>
        {([['file', 'Upload file', Upload], ['youtube', 'YouTube link', Link2]] as const).map(([value, label, Icon]) =>
          <button key={value} type='button' role='tab' aria-selected={source === value} disabled={busy || (value === 'youtube' && youtubeEnabled === false)}
            onClick={() => { setSource(value); setError(null); }}
            className={cn('flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:px-4',
              source === value ? 'bg-primary/20 text-foreground ring-1 ring-inset ring-primary/40' : 'text-muted-foreground hover:bg-tint hover:text-foreground')}>
            <Icon size={16} className='shrink-0' aria-hidden />{label}</button>)}
      </div>

      {source === 'youtube' && youtubeEnabled !== false ? <div className='grid gap-3'>
        <label htmlFor={`youtube-url-${formKey}`} className='text-sm font-medium'>Paste a public YouTube link</label>
        <div className='relative'>
          <Link2 size={18} aria-hidden className='pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint' />
          <input id={`youtube-url-${formKey}`} type='url' inputMode='url' autoComplete='off' autoCapitalize='off'
            autoCorrect='off' spellCheck={false} enterKeyHint='go' value={sourceUrl} disabled={busy}
            onChange={(event) => { setSourceUrl(event.target.value); setError(null); setNotice(null); }}
            placeholder='https://www.youtube.com/watch?v=...'
            className='field h-12 w-full min-w-0 pl-11 pr-24 text-sm md:h-11' />
          <div className='absolute inset-y-0 right-1 flex items-center'>
            {sourceUrl ? <button type='button' aria-label='Clear link' disabled={busy}
              onClick={() => { setSourceUrl(''); setError(null); }}
              className='grid h-10 w-10 place-items-center rounded-lg text-muted-foreground hover:bg-tint-strong hover:text-foreground'><X size={18} aria-hidden /></button>
              : canPaste ? <button type='button' onClick={() => void pasteLink()} disabled={busy}
                className='flex h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-primary-soft hover:bg-primary/10'><ClipboardPaste size={15} aria-hidden />Paste</button> : null}
          </div>
        </div>
        {linkDetected ? <p className='flex items-center gap-1.5 text-xs text-primary-soft'><CheckCircle2 size={14} aria-hidden />YouTube video detected.</p>
          : <p className='text-xs leading-5 text-faint'>Private, members-only, age-restricted and live videos can't be imported.</p>}
        <label className='flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl border border-border bg-tint-subtle px-3 py-2 text-sm text-soft'>
          <input type='checkbox' className='h-5 w-5 shrink-0 accent-primary'
            checked={rightsConfirmed} disabled={busy} onChange={(event) => setRightsConfirmed(event.target.checked)} />
          I have the right to process this video.</label>
      </div> : <div className='grid gap-3'>
        <div onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { event.preventDefault(); setDragging(false); }} onDrop={handleDrop}
          className={cn('rounded-2xl border border-dashed p-5 text-center transition-colors sm:p-7', dragging ? 'border-primary bg-primary/10' : 'border-border-strong bg-sunken hover:border-primary/50', file && 'hidden sm:block')}>
          <span className='mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary-soft'><Upload size={22} aria-hidden /></span>
          <p className='mt-3 text-sm font-semibold'><span className='fine:hidden'>Choose a video from your phone</span><span className='hidden fine:inline'>Drag and drop your video here</span></p>
          <p className='mt-1 text-xs text-muted-foreground'>Gallery or Files · Maximum video length: 2 hours</p>
          <input ref={inputRef} id='file' name='file' type='file' accept='video/*' className='sr-only' aria-label='Video file' onChange={handleFile} />
          <Button type='button' variant='outline' className='mt-4 h-12 w-full sm:h-10 sm:w-auto' disabled={busy} onClick={() => inputRef.current?.click()}><FolderOpen size={17} aria-hidden /><span className='sm:hidden'>Choose video</span><span className='hidden sm:inline'>Browse files</span></Button>
        </div>
        {file && <div className='flex min-w-0 items-center gap-3 rounded-2xl border border-primary/25 bg-primary/[.07] p-3'>
          <span className='grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary-soft'><FileVideo size={20} aria-hidden /></span>
          <span className='min-w-0 flex-1'><span className='block truncate text-sm font-medium'>{file.name}</span>
            <span className='block text-xs text-muted-foreground'>{formatBytes(file.size)}{fileDuration ? ` · ${clipDuration(fileDuration)}` : ''}</span></span>
          <button type='button' aria-label='Remove selected file' onClick={clearFile} disabled={busy}
            className='grid h-11 w-11 shrink-0 place-items-center rounded-xl text-muted-foreground hover:bg-tint-strong hover:text-foreground disabled:opacity-40'><X size={18} aria-hidden /></button>
        </div>}
      </div>}
    </section>

    <fieldset className='grid gap-2.5' disabled={busy}>
      <legend className='mb-2 text-sm font-medium'>Style</legend>
      <div className='grid gap-2 sm:grid-cols-3 sm:gap-3'>
        {templates.map((option) => {
          const selected = settings.template === option.value;
          const Indicator = selected ? CheckCircle2 : Circle;
          return <label key={option.value} data-entry-template={option.value}
            className={cn('pressable flex min-h-[56px] cursor-pointer items-start gap-3 rounded-2xl border p-3 text-left transition-colors focus-within:ring-2 focus-within:ring-ring sm:block sm:rounded-xl',
              selected ? 'border-primary bg-primary/10' : 'border-border bg-sunken hover:border-border-strong')}>
            <input type='radio' className='sr-only' name={`entry-template-${formKey}`} value={option.value}
              checked={selected} onChange={() => update({ template: option.value })} />
            <Indicator size={20} className={cn('mt-0.5 shrink-0 sm:hidden', selected ? 'text-primary-soft' : 'text-faint')} aria-hidden />
            <span className='min-w-0 flex-1'>
              <span className='flex items-center justify-between gap-2 font-display text-sm font-semibold'>{option.title}
                <Indicator size={16} className={cn('hidden sm:block', selected ? 'text-primary-soft' : 'text-faint')} aria-hidden /></span>
              <span className='mt-0.5 block text-xs leading-5 text-muted-foreground sm:mt-1'>{option.description}</span>
            </span>
          </label>;
        })}
      </div>
    </fieldset>

    <fieldset className='grid gap-2.5' disabled={busy}>
      <legend className='mb-2 text-sm font-medium'>Mode</legend>
      <div className='grid gap-2 sm:grid-cols-2'>
        {([{ value: 'FALLBACK_ONLY', title: 'XeeFree', description: "Fast clip creation using XeeClip's built-in editing intelligence." },
          { value: 'ONLINE', title: 'XeePro', description: 'Advanced AI understanding for stronger moment selection and creative decisions.' }] as const).map((option) =>
          { const selected = settings.aiMode === option.value;
          const Indicator = selected ? CheckCircle2 : Circle;
          return <label key={option.value} data-entry-mode={option.value}
            className={cn('pressable flex min-h-[56px] cursor-pointer items-start gap-3 rounded-2xl border p-3 text-sm transition-colors focus-within:ring-2 focus-within:ring-ring',
              selected ? 'border-primary bg-primary/10' : 'border-border bg-sunken hover:border-border-strong')}>
            <input type='radio' className='sr-only' name={`entry-mode-${formKey}`} checked={selected}
              onChange={() => update({ aiMode: option.value })} />
            <Indicator size={20} className={cn('mt-0.5 shrink-0', selected ? 'text-primary-soft' : 'text-faint')} aria-hidden />
            <span className='min-w-0 flex-1'>
              <span className='flex items-center gap-1.5 font-display font-semibold'>{option.title}
                {option.value === 'ONLINE' ? <Sparkles size={14} className='text-accent' aria-hidden /> : null}</span>
              <span className='mt-1 block text-xs leading-5 text-muted-foreground'>{option.description}</span>
            </span>
          </label>; })}
      </div>
    </fieldset>

    <div className='grid gap-2'>
      <div className='flex items-center justify-between gap-4'>
        <span className='text-sm font-medium' id={`entry-count-${formKey}`}>Number of clips</span>
        <div className='flex items-center gap-1.5 rounded-2xl border border-border bg-sunken p-1' role='group' aria-labelledby={`entry-count-${formKey}`}>
          <Button type='button' size='icon' variant='ghost' className='h-11 w-11 rounded-xl sm:h-9 sm:w-9' aria-label='Fewer clips' disabled={busy || settings.count <= 1}
            onClick={() => update({ count: Math.max(1, settings.count - 1) })}><Minus size={17} /></Button>
          <span className='w-9 text-center text-lg font-semibold tabular-nums' aria-live='polite' data-testid='entry-clip-count'>{settings.count}</span>
          <Button type='button' size='icon' variant='ghost' className='h-11 w-11 rounded-xl sm:h-9 sm:w-9' aria-label='More clips' disabled={busy || settings.count >= maxClips}
            onClick={() => update({ count: Math.min(maxClips, settings.count + 1) })}><Plus size={17} /></Button>
        </div>
      </div>
      <p className='text-xs leading-5 text-faint'><span className='font-medium text-muted-foreground'>1–{maxClips}{source === 'file' && fileDuration ? ' for this video' : ''}.</span> {CLIP_LIMIT_HINT} You get exactly the number you choose.</p>
    </div>

    <details className='group rounded-2xl border border-border bg-sunken'>
      <summary className='flex min-h-[48px] cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden'>
        <SlidersHorizontal size={16} className='shrink-0 text-primary-soft' aria-hidden />
        <span className='shrink-0'>More options</span>
        <span className='min-w-0 flex-1 truncate font-normal text-faint'>· {advancedSummary}</span>
        <ChevronDown size={16} className='shrink-0 text-muted-foreground transition-transform group-open:rotate-180' aria-hidden /></summary>
      <div className='grid gap-4 border-t border-border p-4 sm:grid-cols-3'>
        <label className='grid gap-1.5 text-sm font-medium'>Platform
          <select value={settings.platform} disabled={busy} onChange={(event) => update({ platform: event.target.value as TargetPlatform })}
            className='field h-11 bg-surface px-3 text-sm font-normal md:h-10'>
            {(Object.keys(TARGET_PLATFORM_LABELS) as TargetPlatform[]).map((value) =>
              <option key={value} value={value}>{TARGET_PLATFORM_LABELS[value]}</option>)}
          </select>
        </label>
        <label className='grid gap-1.5 text-sm font-medium'>Clip shape
          <select value={settings.aspectRatio} disabled={busy} onChange={(event) => update({ aspectRatio: event.target.value as OutputAspectRatio })}
            className='field h-11 bg-surface px-3 text-sm font-normal md:h-10'>
            {(['9:16', '16:9', '4:5', '1:1'] as const).map((value) => <option key={value}>{value}</option>)}
          </select>
        </label>
        <label className='grid gap-1.5 text-sm font-medium sm:col-span-3'>Describe what you want <span className='-mt-1 font-normal text-faint'>Optional</span>
          <textarea data-testid='entry-brief' value={settings.brief} disabled={busy} maxLength={1500} rows={2}
            onChange={(event) => update({ brief: event.target.value })}
            placeholder='e.g. "find the funny moments"'
            className='field bg-surface p-3 text-sm font-normal' />
        </label>
      </div>
    </details>

    {error ? <div role='alert' className='grid gap-2 rounded-xl border border-danger/20 bg-danger/10 p-3 text-sm text-danger-soft'>
      <p className='break-words [overflow-wrap:anywhere]'>{error.message}{error.fallback && !error.message.includes(FALLBACK_HINT) ? ` ${FALLBACK_HINT}` : ''}</p>
      {error.fallback ? <Button type='button' size='sm' variant='outline' className='h-10 w-fit' onClick={switchToUpload}>
        <Upload size={14} aria-hidden />Upload file instead</Button> : null}
    </div> : null}

    <div className={cn('grid gap-2', stickyCta && 'sticky bottom-[calc(var(--nav-offset,0px)+12px)] z-20 -mx-4 bg-gradient-to-t from-surface via-surface/95 to-transparent px-4 pb-1 pt-6 sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:bg-none lg:p-0')}>
      {uploading ? <div className='grid gap-1.5' role='status' aria-live='polite'>
        <div className='h-2 w-full overflow-hidden rounded-full bg-tint-strong'>
          <div className={cn('h-full rounded-full bg-brand-progress transition-all duration-300', uploadProgress == null && 'w-1/3 animate-pulse')}
            style={uploadProgress == null ? undefined : { width: `${Math.max(4, uploadProgress)}%` }} /></div>
        <div className='flex items-center justify-between gap-2 text-xs text-muted-foreground'>
          <span className='min-w-0 truncate'>{busyLabel}</span>
          <button type='button' onClick={() => abortRef.current?.abort()} className='h-9 shrink-0 rounded-lg px-3 font-semibold text-soft hover:bg-tint-strong'>Cancel</button>
        </div>
      </div> : null}
      {noCredits && <p role='status' className='text-sm text-soft'>You've used your available generations.</p>}
      <Button disabled={busy || !ready || offline || noCredits} type='submit' className='h-14 w-full rounded-2xl text-base sm:h-12 sm:rounded-xl sm:text-sm'>
        {busy ? <><Loader2 className='animate-spin' size={18} aria-hidden />{busyLabel}</>
          : <><Sparkles size={18} aria-hidden />Generate {settings.count} Clip{settings.count === 1 ? '' : 's'}</>}
      </Button>
      {offline ? <p className='text-center text-xs text-warning-soft/80'>Generation is paused while the processing server is offline.</p>
        : !ready && !busy ? <p className='text-center text-xs text-faint'>{source === 'youtube' ? 'Paste a link and confirm your rights to continue.' : 'Choose a video to continue.'}</p> : null}
    </div>
  </form>;
}
