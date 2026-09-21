'use client';

import { useEffect, useState } from 'react';
import { BrainCircuit } from 'lucide-react';
import { WorkspaceAccordion } from '@/components/workspace-accordion';
import {
  getVideoUnderstanding,
  type Video,
  type VideoUnderstanding
} from '@/lib/api';

function timestamp(value: number) {
  const total = Math.max(0, Math.round(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const seconds = total % 60;
  return hours
    ? [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
    : [minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

export function VideoUnderstandingPanel({ video }: { video: Video }) {
  const [understanding, setUnderstanding] = useState<VideoUnderstanding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stage = video.processingStages?.find((item) =>
    item.stage === 'WHOLE_VIDEO_UNDERSTANDING');

  useEffect(() => {
    if (stage?.status !== 'COMPLETED' || understanding) return;
    let cancelled = false;
    getVideoUnderstanding(video.id).then((result) => {
      if (!cancelled) {
        setUnderstanding(result);
        setError(null);
      }
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load summary.');
    });
    return () => { cancelled = true; };
  }, [stage?.status, understanding, video.id]);

  return (
    <WorkspaceAccordion title='Video understanding' summary={understanding ? `${understanding.chapters.length} chapters` : stage?.status?.toLowerCase() || 'Pending'} icon={BrainCircuit}>
      <div className='grid gap-3' aria-label='Whole-video understanding'>
      {stage?.status === 'SKIPPED' ? (
        <p className='text-sm text-muted-foreground'>
          Whole-video analysis is unavailable. Clip discovery continued with transcript heuristics.
        </p>
      ) : null}
      {stage?.status === 'PROCESSING' ? (
        <p className='text-sm text-muted-foreground'>Analyzing the complete video transcript...</p>
      ) : null}
      {stage?.status === 'COMPLETED' && !understanding && !error ? (
        <p className='text-sm text-muted-foreground'>Loading video summary...</p>
      ) : null}
      {error ? <p className='text-sm text-destructive' role='alert'>{error}</p> : null}
      {understanding ? (
        <div className='grid gap-4 text-sm'>
          <div className='rounded-md bg-muted/60 p-3'>
            <p className='font-medium'>{understanding.mainTopic}</p>
            <p className='mt-1'>{understanding.summary}</p>
            <p className='mt-2 text-xs text-muted-foreground'>
              {understanding.contentType} · {understanding.targetAudience} · {understanding.language}
            </p>
            {understanding.topics.length ? (
              <p className='mt-2 text-xs text-muted-foreground'>
                Topics: {understanding.topics.join(', ')}
              </p>
            ) : null}
          </div>
          <div>
            <h4 className='font-medium'>Chapters ({understanding.chapters.length})</h4>
            <ol className='mt-2 grid gap-2'>
              {understanding.chapters.map((chapter) => (
                <li className='rounded-md border p-3' key={chapter.id}>
                  <div className='flex flex-wrap items-baseline justify-between gap-2'>
                    <p className='font-medium'>{chapter.title}</p>
                    <p className='font-mono text-xs text-muted-foreground'>
                      {timestamp(chapter.startTime)}–{timestamp(chapter.endTime)}
                    </p>
                  </div>
                  <p className='mt-1'>{chapter.summary}</p>
                  <p className='mt-2 text-xs text-muted-foreground'>
                    Importance {chapter.importanceScore.toFixed(0)}/100
                    {chapter.topics.length ? ' · ' + chapter.topics.join(', ') : ''}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      ) : null}
      </div>
    </WorkspaceAccordion>
  );
}
