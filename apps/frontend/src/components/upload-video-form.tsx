'use client';

import { ChangeEvent, DragEvent, FormEvent, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Circle, Cloud, Cpu, FolderOpen, ShieldCheck, Upload, X } from 'lucide-react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { TARGET_PLATFORM_LABELS, uploadVideo, type AiProcessingMode,
  type TargetPlatform } from '@/lib/api';
import { cn } from '@/lib/utils';

const modes: Array<{ value: AiProcessingMode; title: string; description: string; icon: typeof Cpu }> = [
  { value: 'FALLBACK_ONLY', title: 'Fallback', description: 'Transcript, visual and audio analysis only. No AI model is used.', icon: ShieldCheck },
  { value: 'OFFLINE', title: 'Local AI', description: 'Runs on a local AI model. Nothing is sent to the cloud.', icon: Cpu },
  { value: 'ONLINE', title: 'Online AI', description: 'Uses cloud AI for the strongest understanding and editing.', icon: Cloud }
];

const platforms: Array<{ value: TargetPlatform; description: string }> = [
  { value: 'INSTAGRAM_REELS', description: 'Vertical 9:16' },
  { value: 'YOUTUBE_SHORTS', description: 'Vertical 9:16' },
  { value: 'TIKTOK', description: 'Vertical 9:16' }
];

const MAX_VIDEO_SECONDS = 7200;

function readDuration(file: File) {
  return new Promise<number | null>((resolve) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    const done = (value: number | null) => { URL.revokeObjectURL(url); resolve(value); };
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => done(Number.isFinite(probe.duration) ? probe.duration : null);
    probe.onerror = () => done(null);
    probe.src = url;
  });
}

export function UploadVideoForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiMode, setAiMode] = useState<AiProcessingMode>('FALLBACK_ONLY');
  // The platform deliberately persists across uploads in this session; everything else resets.
  const [platform, setPlatform] = useState<TargetPlatform | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);

  function clearFile() {
    setFile(null);
    if (inputRef.current) inputRef.current.value = '';
  }
  function handleFile(event: ChangeEvent<HTMLInputElement>) { setFile(event.target.files?.[0] ?? null); setError(null); }
  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); setDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped?.type.startsWith('video/')) { setFile(dropped); setError(null); }
    else setError('Choose a supported video file.');
  }
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!platform) { setError('Choose a target platform first.'); return; }
    if (!file) { setError('Select a video to upload.'); return; }
    setError(null); setIsUploading(true);
    try {
      const duration = await readDuration(file);
      if (duration != null && duration > MAX_VIDEO_SECONDS) {
        setError('This video is longer than the 2-hour limit. Please upload a video shorter than 2 hours.');
        return;
      }
      const formData = new FormData();
      formData.set('file', file);
      formData.set('aiMode', aiMode);
      formData.set('targetPlatform', platform);
      await uploadVideo(projectId, formData);
      clearFile(); router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Video could not be uploaded.');
    } finally { setIsUploading(false); }
  }

  return <form className='grid gap-7' onSubmit={onSubmit}>
    <div><p className='eyebrow'>Create short clips</p><h2 className='mt-2 text-2xl font-bold tracking-tight'>Create Short Clips</h2><p className='mt-2 text-sm leading-6 text-slate-400'>Pick where the clips will be posted, then upload your video. We analyze the whole video before you decide how many clips to create.</p></div>
    <fieldset className='grid gap-3'><legend className='text-sm font-medium'>Target platform</legend>
      <div className='grid gap-3 sm:grid-cols-3' role='radiogroup' aria-label='Target platform'>
        {platforms.map((option) => {
          const selected = platform === option.value;
          const Indicator = selected ? CheckCircle2 : Circle;
          return <button key={option.value} type='button' role='radio' aria-checked={selected}
            onClick={() => { setPlatform(option.value); setError(null); }}
            className={cn('rounded-2xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400',
              selected ? 'border-violet-400 bg-violet-500/10' : 'border-white/10 bg-[#0d111c] hover:border-white/25')}>
            <span className='flex items-center justify-between text-sm font-semibold'>{TARGET_PLATFORM_LABELS[option.value]}<Indicator size={18} className={selected ? 'text-violet-300' : 'text-slate-600'} aria-hidden /></span>
            <span className='mt-1 block text-xs text-slate-400'>{option.description}</span>
          </button>;
        })}
      </div>
    </fieldset>
    <fieldset className='grid gap-3'><legend className='text-sm font-medium'>AI mode</legend>
      <div className='grid gap-3 sm:grid-cols-3' role='radiogroup' aria-label='AI mode'>
        {modes.map((mode) => { const selected = aiMode === mode.value; const Indicator = selected ? CheckCircle2 : Circle; const Icon = mode.icon;
          return <motion.button key={mode.value} type='button' role='radio' aria-checked={selected} onClick={() => setAiMode(mode.value)} whileHover={{ y: -2 }} className={cn('relative rounded-2xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400', selected ? 'border-violet-400/70 bg-violet-500/10' : 'border-white/[.08] bg-[#0d111c] hover:border-white/20 hover:bg-[#151d2e]')}>
            <span className='flex items-start justify-between'><span className={cn('grid h-9 w-9 place-items-center rounded-xl', selected ? 'bg-violet-500/20 text-violet-300' : 'bg-white/5 text-slate-400')}><Icon size={17} aria-hidden /></span><Indicator className={cn('h-4 w-4', selected ? 'text-violet-300' : 'text-slate-600')} aria-hidden /></span>
            <span className='mt-3 block text-sm font-semibold'>{mode.title}</span><span className='mt-1 block text-xs leading-5 text-slate-400'>{mode.description}</span>
          </motion.button>;
        })}
      </div>
    </fieldset>
    <div className='grid gap-3'><Label htmlFor='file'>Video</Label>
      <div onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { event.preventDefault(); setDragging(false); }} onDrop={handleDrop} className={cn('rounded-2xl border border-dashed p-7 text-center transition-colors sm:p-10', dragging ? 'border-violet-400 bg-violet-500/10' : 'border-white/15 bg-[#0d111c] hover:border-violet-400/50')}>
        <span className='mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-violet-500/10 text-violet-300'><Upload size={25} aria-hidden /></span><p className='mt-4 text-sm font-semibold'>Drag and drop your video here</p><p className='mt-1 text-xs text-slate-400'>Maximum video length: 2 hours</p>
        <input ref={inputRef} id='file' name='file' type='file' accept='video/*' className='sr-only' onChange={handleFile} />
        <Button type='button' variant='outline' className='mt-5' onClick={() => inputRef.current?.click()}><FolderOpen size={16} />Browse files</Button>
      </div>
      {file && <div className='flex min-w-0 items-center justify-between gap-3 rounded-xl border border-violet-400/20 bg-violet-500/5 px-4 py-3'><span className='min-w-0 truncate text-sm'>{file.name} <span className='text-slate-400'>· {(file.size / 1024 / 1024).toFixed(1)} MB</span></span><button type='button' aria-label='Remove selected file' onClick={clearFile} className='shrink-0 text-slate-400 hover:text-white'><X size={17} /></button></div>}
    </div>
    {error && <div role='alert' className='rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200'>{error}</div>}
    <Button disabled={isUploading || !file || !platform} type='submit' className='h-12 w-full text-sm'><Upload size={17} aria-hidden />{isUploading ? 'Uploading video...' : 'Upload Video'}</Button>
  </form>;
}
