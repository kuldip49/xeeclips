'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { ClipCreationPanel } from '@/components/clip-creation-panel';
import { UploadVideoForm } from '@/components/upload-video-form';
import { listVideoImports, listVideos, retryVideo, type Project, type VideoImportJob } from '@/lib/api';
import { analysisProgressLabel, importProgressLabel, settingsFromImport } from '@/lib/entry-flow';

export function CreationSession({ initialProject }: { initialProject: Project }) {
  const [project, setProject] = useState(initialProject);
  const [imports, setImports] = useState<VideoImportJob[]>([]);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const [videos, jobs] = await Promise.allSettled([listVideos(initialProject.id), listVideoImports(initialProject.id)]);
      if (!active) return;
      if (videos.status === 'fulfilled') setProject((current) => ({ ...current, videos: videos.value }));
      if (jobs.status === 'fulfilled') setImports(jobs.value);
    };
    void refresh();
    const interval = window.setInterval(refresh, 2500);
    return () => { active = false; window.clearInterval(interval); };
  }, [initialProject.id]);
  const video = project.videos[0];
  const job = video?.processingJobs?.[0];
  const pendingImport = imports.find((item) => item.status !== 'READY');
  return <div className='grid min-w-0 gap-5'>
    {video ? <>
      <div className='rounded-2xl border border-white/[.08] bg-[#0d111c] p-4 sm:p-5'>
        <p className='truncate text-sm font-semibold'>{video.originalName}</p>
        <p className='mt-1 text-sm text-slate-400'>
          {job?.status === 'COMPLETED' ? 'Your video is ready.' : job?.status === 'FAILED' ? 'Something went wrong.' : analysisProgressLabel(video.processingStages)}
        </p>
        {job?.status !== 'COMPLETED' && job?.status !== 'FAILED' ? <div className='mt-3 h-1.5 overflow-hidden rounded-full bg-white/10'><div className='h-full rounded-full bg-violet-400 transition-all' style={{ width: `${Math.max(4, job?.progress ?? 0)}%` }} /></div> : null}
        {job?.status === 'FAILED' && job.retryable !== false ? <button className='mt-3 rounded-xl border border-white/10 px-4 py-2 text-sm font-semibold' disabled={retrying} onClick={() => { setRetrying(true); void retryVideo(video.id).catch(() => setError('Could not try again.')).finally(() => setRetrying(false)); }}>{retrying ? 'Trying again…' : 'Try again'}</button> : null}
      </div>
      {error ? <p role='alert' className='text-sm text-red-200'>{error}</p> : null}
      <ClipCreationPanel video={video} />
      <Link href='/history' className='w-fit text-sm font-semibold text-violet-300 hover:text-violet-200'>View History →</Link>
    </> : pendingImport ? <div className='grid gap-4 rounded-2xl border border-white/[.08] bg-[#0d111c] p-5'>
      {pendingImport.status === 'IMPORT_FAILED' || pendingImport.status === 'CANCELLED' ? <>
        <p role='alert' className='text-sm text-amber-200'>This YouTube video could not be imported. Upload the video file to continue.</p>
        <UploadVideoForm projectId={project.id} initialSource='file' initialSettings={settingsFromImport(pendingImport)} showHeading={false} />
      </> : <p role='status' className='flex items-center gap-3 text-sm text-slate-300'><Loader2 size={18} className='animate-spin text-violet-300' />{importProgressLabel(pendingImport)}</p>}
    </div> : <div role='status' className='flex items-center gap-3 rounded-2xl border border-white/[.08] bg-[#0d111c] p-5 text-sm text-slate-300'><Loader2 size={18} className='animate-spin text-violet-300' />Preparing your video…</div>}
  </div>;
}
