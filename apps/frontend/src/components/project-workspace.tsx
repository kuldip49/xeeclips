'use client';

import { useEffect, useState } from 'react';
import { FileVideo, Film, Trash2, Upload } from 'lucide-react';
import { UploadVideoForm } from '@/components/upload-video-form';
import { ClipCreationPanel } from '@/components/clip-creation-panel';
import { DeveloperDiagnostics } from '@/components/developer-diagnostics';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { deleteVideo, listVideos, retryVideo, MEDIA_ERROR_UI_MESSAGES, TARGET_PLATFORM_LABELS, type MediaErrorCode,
  type Project } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { WorkspaceAccordion } from '@/components/workspace-accordion';

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
        const videos = await listVideos(project.id);
        if (!cancelled) setProject((current) => ({ ...current, videos }));
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
      <WorkspaceAccordion key={project.videos.length === 0 ? 'empty' : 'populated'} title='Add a source video' summary='Choose a platform and upload' icon={Upload} defaultOpen={project.videos.length === 0} className='border-violet-400/15'>
        <UploadVideoForm projectId={project.id} />
      </WorkspaceAccordion>

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
                  <span className='font-semibold text-slate-200'>{video.processingJobs?.[0]?.status?.toLowerCase() || 'uploaded'}</span>
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
