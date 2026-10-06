'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { ClipCreationPanel } from '@/components/clip-creation-panel';
import { UploadVideoForm } from '@/components/upload-video-form';
import { listVideoImports, listVideos, retryVideo, type Project, type VideoImportJob } from '@/lib/api';
import { analysisProgressLabel, importProgressLabel, settingsFromImport } from '@/lib/entry-flow';
import { usePolling } from '@/lib/use-polling';

export function CreationSession({ initialProject }: { initialProject: Project }) {
  const [project, setProject] = useState(initialProject);
  const [imports, setImports] = useState<VideoImportJob[]>([]);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    const [videos, jobs] = await Promise.allSettled([listVideos(initialProject.id), listVideoImports(initialProject.id)]);
    if (videos.status === 'fulfilled') setProject((current) => ({ ...current, videos: videos.value }));
    if (jobs.status === 'fulfilled') setImports(jobs.value);
  }, [initialProject.id]);
  useEffect(() => { void refresh(); }, [refresh]);
  const video = project.videos[0];
  const job = video?.processingJobs?.[0];
  const pendingImport = imports.find((item) => item.status !== 'READY');
  // Once analysis has finished (or failed), the auto-started request has been handed to the
  // clips panel and no import is in flight, nothing here changes any more: stop polling. The
  // panel keeps polling its own results while clips render.
  const settled = !!video && (job?.status === 'COMPLETED' || job?.status === 'FAILED') &&
    !['PENDING', 'STARTING'].includes(job?.autoGenerationStatus ?? '') &&
    imports.every((item) => ['READY', 'IMPORT_FAILED', 'CANCELLED'].includes(item.status));
  usePolling(refresh, 2500, !settled);
  return <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5'>
    {video ? <>
      <div className='rounded-2xl border border-border bg-surface p-4 sm:p-5'>
        <p className='truncate text-sm font-semibold'>{video.originalName}</p>
        <p className='mt-1 text-sm text-muted-foreground'>
          {job?.status === 'COMPLETED' ? 'Your video is ready.' : job?.status === 'FAILED' ? 'Something went wrong.' : analysisProgressLabel(video.processingStages)}
        </p>
        {job?.status !== 'COMPLETED' && job?.status !== 'FAILED' ? <div className='mt-3 h-1.5 overflow-hidden rounded-full bg-tint-strong'><div className='h-full rounded-full bg-brand-progress transition-all' style={{ width: `${Math.max(4, job?.progress ?? 0)}%` }} /></div> : null}
        {job?.status === 'FAILED' && job.retryable !== false ? <button className='mt-3 rounded-xl border border-border px-4 py-2 text-sm font-semibold' disabled={retrying} onClick={() => { setRetrying(true); void retryVideo(video.id).then(refresh).catch(() => setError('Could not try again.')).finally(() => setRetrying(false)); }}>{retrying ? 'Trying again…' : 'Try again'}</button> : null}
      </div>
      {error ? <p role='alert' className='text-sm text-danger-soft'>{error}</p> : null}
      <ClipCreationPanel video={video} />
      <Link href='/history' className='w-fit text-sm font-semibold text-primary-soft hover:text-primary-soft'>View History →</Link>
    </> : pendingImport ? <div className='grid gap-4 rounded-2xl border border-border bg-surface p-5'>
      {pendingImport.status === 'IMPORT_FAILED' || pendingImport.status === 'CANCELLED' ? <>
        <p role='alert' className='text-sm text-warning-soft'>This YouTube video could not be imported. Upload the video file to continue.</p>
        <UploadVideoForm projectId={project.id} initialSource='file' initialSettings={settingsFromImport(pendingImport)} showHeading={false} />
      </> : <p role='status' className='flex items-center gap-3 text-sm text-soft'><Loader2 size={18} className='animate-spin text-secondary' />{importProgressLabel(pendingImport)}</p>}
    </div> : <div role='status' className='flex items-center gap-3 rounded-2xl border border-border bg-surface p-5 text-sm text-soft'><Loader2 size={18} className='animate-spin text-secondary' />Preparing your video…</div>}
  </div>;
}
