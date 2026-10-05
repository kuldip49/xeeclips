'use client';

import { useEffect, useState } from 'react';
import { FileVideo, Film, Trash2, Upload } from 'lucide-react';
import { UploadVideoForm } from '@/components/upload-video-form';
import { ClipCreationPanel } from '@/components/clip-creation-panel';
import { DeveloperDiagnostics } from '@/components/developer-diagnostics';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cancelVideoImport, deleteVideo, listVideoImports, listVideos, retryVideo,
  retryVideoImport, MEDIA_ERROR_UI_MESSAGES, TARGET_PLATFORM_LABELS, type MediaErrorCode,
  type Project, type VideoImportJob } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { WorkspaceAccordion } from '@/components/workspace-accordion';
import { sourceFileUrl, sourcePosterUrl } from '@/lib/creative-generation';
import { analysisProgressLabel, importProgressLabel, settingsFromImport,
  type EntrySettings } from '@/lib/entry-flow';

const IMPORT_FALLBACK = "Automatic import isn't available for this video. You can upload the video file instead.";
// Failures that can succeed on a later attempt: offer "Try again" first.
const TEMPORARY_IMPORT_FAILURES = new Set(['NETWORK_TIMEOUT', 'RATE_LIMITED', 'BOT_CHALLENGE',
  'DOWNLOAD_FAILED', 'STORAGE_FAILED', 'IMPORT_UNAVAILABLE']);

function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1) + ' ' + units[index];
}

export function ProjectWorkspace({
  initialProject,
  visualAnalysisEnabled,
  developerDiagnostics = false
}: {
  initialProject: Project;
  visualAnalysisEnabled: boolean;
  /** Pipeline internals (stages, chunks, understanding) are for developers, never the normal UI. */
  developerDiagnostics?: boolean;
}) {
  const [project, setProject] = useState(initialProject);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [imports, setImports] = useState<VideoImportJob[]>([]);
  const [importAction, setImportAction] = useState<string | null>(null);
  // A failed import reopens the form as a file upload with the import's own choices.
  const [fallback, setFallback] = useState<{ key: number; settings: EntrySettings; notice: string } | null>(null);
  const [dismissedImports, setDismissedImports] = useState<string[]>([]);
  // The last choices survive the form remounting (e.g. when the first source appears).
  const [entrySettings, setEntrySettings] = useState<EntrySettings | undefined>(undefined);

  function uploadInstead(job: VideoImportJob) {
    setFallback((current) => ({ key: (current?.key ?? 0) + 1, settings: settingsFromImport(job),
      notice: `${job.title ? `“${job.title}” couldn't be imported.` : "That YouTube video couldn't be imported."} Your template, clip count and options are kept — choose the video file to continue.` }));
    setDismissedImports((current) => [...current, job.id]);
  }

  async function updateImport(id: string, action: 'retry' | 'cancel') {
    setImportAction(id); setRetryError(null);
    try {
      if (action === 'retry') await retryVideoImport(id); else await cancelVideoImport(id);
      setImports(await listVideoImports(project.id));
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : 'Could not update import.');
    } finally { setImportAction(null); }
  }

  async function retry(id: string) {
    setRetrying(id);
    setRetryError(null);
    try {
      await retryVideo(id);
      const videos = await listVideos(project.id);
      setProject((current) => ({ ...current, videos }));
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : 'Could not retry video.');
    } finally {
      setRetrying(null);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this video and all of its transcript and analysis data?')) return;
    setDeleting(id);
    setRetryError(null);
    try {
      await deleteVideo(id);
      setProject((current) => ({
        ...current,
        videos: current.videos.filter((video) => video.id !== id)
      }));
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : 'Could not delete video.');
    } finally {
      setDeleting(null);
    }
  }

  useEffect(() => setProject(initialProject), [initialProject]);

  useEffect(() => {
    let cancelled = false;
    const refreshVideos = async () => {
      try {
        const [videos, jobs] = await Promise.allSettled([
          listVideos(project.id), listVideoImports(project.id)
        ]);
        if (!cancelled) {
          if (videos.status === 'fulfilled') setProject((current) => ({ ...current,
            videos: videos.value }));
          if (jobs.status === 'fulfilled') setImports(jobs.value);
        }
      } catch {
        // Keep the latest durable state and retry on the next interval.
      }
    };
    void refreshVideos();
    const interval = window.setInterval(refreshVideos, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [project.id]);

  return (
    <div className='grid min-w-0 gap-5'>
      <WorkspaceAccordion key={`${project.videos.length === 0 ? 'empty' : 'populated'}-${fallback?.key ?? 0}`} title='Generate clips' summary='Upload a file or paste a YouTube link' icon={Upload} defaultOpen={project.videos.length === 0 || !!fallback} className='border-violet-400/15'>
        <UploadVideoForm key={fallback?.key ?? 0} projectId={project.id}
          initialSettings={fallback?.settings ?? entrySettings} onSettingsChange={setEntrySettings}
          initialSource={fallback ? 'file' : undefined} initialNotice={fallback?.notice} />
      </WorkspaceAccordion>

      {imports.filter((job) => job.status !== 'READY' && !dismissedImports.includes(job.id)).map((job) => (
        <div key={job.id} className='grid gap-2 rounded-2xl border border-white/10 bg-[#0d111c] p-4'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <p className='min-w-0 truncate text-sm font-medium'>{job.title || job.sourceUrl}</p>
            <div className='flex gap-2'>
              {job.status === 'IMPORT_FAILED' || job.status === 'CANCELLED' ? (() => {
                const temporary = job.status === 'CANCELLED' || TEMPORARY_IMPORT_FAILURES.has(job.errorCode ?? '');
                return <>
                  <Button type='button' size='sm' variant={temporary ? 'outline' : 'default'} onClick={() => uploadInstead(job)}>
                    <Upload size={14} aria-hidden />Upload file instead</Button>
                  <Button type='button' size='sm' variant={temporary ? 'default' : 'outline'} disabled={importAction === job.id}
                    onClick={() => void updateImport(job.id, 'retry')}>Try again</Button></>;
              })() : null}
              {job.status === 'PENDING' || job.status === 'IMPORTING' ?
                <Button type='button' size='sm' variant='outline' disabled={importAction === job.id}
                  onClick={() => void updateImport(job.id, 'cancel')}>Cancel</Button> : null}
            </div>
          </div>
          <p role={job.status === 'IMPORT_FAILED' ? 'alert' : 'status'} className={job.status === 'IMPORT_FAILED' ? 'text-sm text-red-200' : 'text-xs text-slate-400'}>
            {job.status === 'IMPORT_FAILED' ? (job.error || IMPORT_FALLBACK) :
              job.status === 'CANCELLED' ? 'Import cancelled.' : importProgressLabel(job)}</p>
          {job.status === 'PENDING' || job.status === 'IMPORTING' ? <div className='h-1.5 w-full overflow-hidden rounded-full bg-white/10'><div
            className='h-full bg-violet-400 transition-all duration-500' style={{ width: `${Math.max(3, job.progress)}%` }} /></div> : null}
        </div>
      ))}

      <Card>
        <CardHeader className='pb-4'>
          <CardTitle>Source videos</CardTitle>
          <CardDescription>{project.videos.length} source files · live analysis status and created clips.</CardDescription>
        </CardHeader>
        <CardContent className='grid gap-4'>
          {retryError ? <p role='alert' className='rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200'>{retryError}</p> : null}
          {project.videos.length === 0 ? (
            <div className='empty-state'><Film className='text-violet-300' size={28} /><h3 className='mt-4 font-semibold'>No videos yet</h3><p className='mt-1 text-sm text-slate-400'>Add your first source video above to begin processing.</p></div>
          ) : project.videos.map((video) => {
            return (
              <article className='grid min-w-0 gap-4 rounded-2xl border border-white/[.08] bg-[#0d111c] p-4 sm:p-5' key={video.id}>
                <div className='flex min-w-0 flex-wrap items-center gap-3'>
                  <span className='grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-cyan-400/10 text-cyan-300'><FileVideo className='h-5 w-5' aria-hidden /></span>
                  <div className='min-w-0 flex-1'>
                    <h2 className='truncate font-medium'>{video.originalName}</h2>
                    <p className='truncate text-sm text-muted-foreground'>
                      {video.mimeType} · {formatBytes(video.sizeBytes)}
                    </p>
                  </div>
                  <div className='flex flex-wrap gap-2'>
                  {video.processingJobs?.[0]?.status === 'FAILED' &&
                    video.processingJobs[0].retryable !== false ? (
                    <Button size='sm' disabled={retrying !== null || deleting !== null}
                      onClick={() => void retry(video.id)}>
                      {retrying === video.id ? 'Requeuing...' : 'Retry'}
                    </Button>
                  ) : null}
                  <Button size='sm' variant='outline'
                    disabled={deleting !== null || retrying !== null ||
                      video.processingJobs?.[0]?.status === 'PROCESSING'}
                    onClick={() => void remove(video.id)}>
                    <Trash2 size={15} aria-hidden />
                    {deleting === video.id ? 'Deleting...' : 'Delete'}
                  </Button>
                  </div>
                </div>
                <div className='flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/[.06] bg-white/[.02] px-4 py-3 text-xs text-slate-400'>
                  <span className='font-semibold text-slate-200'>{video.processingJobs?.[0]?.status === 'COMPLETED' ? 'Analyzed'
                    : video.processingJobs?.[0]?.status === 'FAILED' ? 'Failed'
                      : analysisProgressLabel(video.processingStages)}</span>
                  {video.targetPlatform ? <span>{TARGET_PLATFORM_LABELS[video.targetPlatform]}</span> : null}
                  <span>{video.processingJobs?.[0]?.progress ?? 0}% complete</span>
                  <div className='h-1.5 w-full overflow-hidden rounded-full bg-white/[.08]'><div className='h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-all duration-500' style={{ width: `${Math.max(0, Math.min(100, video.processingJobs?.[0]?.progress ?? 0))}%` }} /></div>
                </div>
                {video.processingJobs?.[0]?.status === 'FAILED' && video.processingJobs[0].errorCode &&
                  MEDIA_ERROR_UI_MESSAGES[video.processingJobs[0].errorCode as MediaErrorCode] ? (
                  <div role='alert' className='rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200'>
                    <p className='font-semibold'>
                      {MEDIA_ERROR_UI_MESSAGES[video.processingJobs[0].errorCode as MediaErrorCode].title}
                    </p>
                    <p className='mt-1 text-red-200/80'>
                      {MEDIA_ERROR_UI_MESSAGES[video.processingJobs[0].errorCode as MediaErrorCode].description}
                    </p>
                  </div>
                ) : null}
                {/* Step 9.1: the source is visible immediately, before any configuration. */}
                <video data-testid='source-preview' controls preload='none' className='max-h-[360px] w-full rounded-xl bg-black object-contain'
                  poster={sourcePosterUrl(video.id)} src={sourceFileUrl(video.id)} aria-label={`Source: ${video.originalName}`} />
                <ClipCreationPanel video={video} />
                {developerDiagnostics ? (
                  <DeveloperDiagnostics video={video} visualAnalysisEnabled={visualAnalysisEnabled} />
                ) : null}
              </article>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
