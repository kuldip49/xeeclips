'use client';

import { Activity, SlidersHorizontal } from 'lucide-react';
import { ChunksPanel } from '@/components/chunks-panel';
import { ProcessingPipeline } from '@/components/processing-pipeline';
import { TranscriptPanel } from '@/components/transcript-panel';
import { VideoUnderstandingPanel } from '@/components/video-understanding-panel';
import { WorkspaceAccordion } from '@/components/workspace-accordion';
import type { Video } from '@/lib/api';

/**
 * Pipeline internals for developers only. Rendered when the server sets
 * SHOW_DEVELOPER_DIAGNOSTICS=true; never part of the normal product workspace.
 */
export function DeveloperDiagnostics({ video, visualAnalysisEnabled }: {
  video: Video;
  visualAnalysisEnabled: boolean;
}) {
  return (
    <div className='grid gap-2 border-t border-white/[.07] pt-4'>
      <p className='mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500'>Developer diagnostics</p>
      <WorkspaceAccordion title='Processing details' summary={`${video.processingStages?.filter((stage) => stage.status === 'COMPLETED').length ?? 0} stages complete`} icon={Activity}>
        <ProcessingPipeline video={video} visualAnalysisEnabled={visualAnalysisEnabled} />
      </WorkspaceAccordion>
      <WorkspaceAccordion title='Media details' summary={video.duration != null ? `${video.duration.toFixed(1)} sec` : 'Pending'} icon={SlidersHorizontal}>
        <div className='grid grid-cols-2 gap-3 text-xs text-slate-400 sm:grid-cols-4'>
          <span>{video.duration != null ? video.duration.toFixed(1) + ' sec' : 'Duration pending'}</span>
          <span>{video.width && video.height ? video.width + 'x' + video.height : 'Resolution pending'}</span>
          <span>{video.fps != null ? video.fps.toFixed(2) + ' fps' : 'FPS pending'}</span>
          <span>{video.codec?.toUpperCase() || 'Codec pending'}</span>
        </div>
      </WorkspaceAccordion>
      <TranscriptPanel video={video} />
      <VideoUnderstandingPanel video={video} />
      <ChunksPanel video={video} visualAnalysisEnabled={visualAnalysisEnabled} />
    </div>
  );
}
