'use client';

import { motion } from 'framer-motion';
import { Check, Circle, LoaderCircle, Minus, X } from 'lucide-react';
import { AI_PROCESSING_MODE_LABELS, type Video } from '@/lib/api';
import { cn } from '@/lib/utils';

const stages = [
  { label: 'Uploaded', name: 'UPLOADED' },
  { label: 'Inspect media', name: 'INSPECT_MEDIA' },
  { label: 'Extract audio', name: 'EXTRACT_AUDIO' },
  { label: 'Transcribe to English', name: 'TRANSCRIBE' },
  { label: 'Build chunks', name: 'BUILD_CHUNKS' },
  { label: 'Understand whole video', name: 'WHOLE_VIDEO_UNDERSTANDING' },
  { label: 'Analyze chunks', name: 'ANALYZE_CHUNKS' },
  { label: 'Visual intelligence', name: 'VISUAL_ANALYSIS' },
  { label: 'Multimodal understanding', name: 'MULTIMODAL_UNDERSTANDING' },
  { label: 'Discover candidates', name: 'GENERATE_CLIP_CANDIDATES' },
  { label: 'Fuse evidence', name: 'EVIDENCE_FUSION' },
  { label: 'Understand clips', name: 'CLIP_UNDERSTANDING' },
  { label: 'Generate content', name: 'CONTENT_GENERATION' },
  { label: 'Critic and validation', name: 'CRITIC_VALIDATION' },
  { label: 'Completed', name: 'COMPLETED' }
] as const;

export function ProcessingPipeline({
  video,
  visualAnalysisEnabled
}: {
  video: Video;
  visualAnalysisEnabled: boolean;
}) {
  const job = video.processingJobs?.[0];
  const progress = Math.max(0, Math.min(100, job?.progress ?? 0));
  const failed = video.processingStages?.some((stage) => stage.status === 'FAILED') ??
    job?.status === 'FAILED';
  const completed = video.processingStages?.some((stage) =>
    stage.stage === 'COMPLETED' && stage.status === 'COMPLETED'
  ) ?? job?.status === 'COMPLETED';
  const activeStage = video.processingStages?.find((stage) => stage.status === 'PROCESSING');
  const activeLabel = stages.find((stage) => stage.name === activeStage?.stage)?.label;
  const aiMode = job?.aiMode ?? 'FALLBACK_ONLY';
  const sourceLabel = aiMode === 'ONLINE' ? 'AI provider: OpenAI GPT-5.6 Luna'
    : aiMode === 'OFFLINE' ? 'Processing engine: Qwen3 4B + deterministic analysis'
      : 'Processing engine: Local deterministic pipeline';

  return (
    <div className='grid gap-4 rounded-2xl border border-white/[.08] bg-[#0d111c] p-4 sm:p-5' aria-label='Video processing pipeline'>
      <div className='flex items-center justify-between gap-3 text-sm'>
        <span className='font-medium'>
          {failed ? 'Processing failed' : completed ? 'Processing complete' :
            activeLabel ? `${activeLabel}...` : 'Processing video'}
        </span>
        <span className='text-lg font-bold tabular-nums text-violet-300'>{progress}%</span>
      </div>
      <p className='text-xs text-muted-foreground'>Processing mode: {' '}
        <span className='font-medium text-foreground'>
          {AI_PROCESSING_MODE_LABELS[aiMode]}
        </span>
      </p>
      <p className='text-xs text-muted-foreground'>{sourceLabel}</p>
      <div className='h-2 overflow-hidden rounded-full bg-white/[.08]' role='progressbar' aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
        <motion.div className={cn('h-full rounded-full', failed ? 'bg-destructive' : 'bg-gradient-to-r from-violet-500 to-cyan-400')} initial={{ width: 0 }} animate={{ width: progress + '%' }} transition={{ duration: .6 }} />
      </div>
      <ol className='grid gap-2 sm:grid-cols-2 xl:grid-cols-3'>
        {stages.map((stage) => {
          const record = video.processingStages?.find((item) => item.stage === stage.name);
          const status = record?.status ?? (stage.name === 'UPLOADED' ? 'COMPLETED' : 'PENDING');
          const done = status === 'COMPLETED';
          const active = status === 'PROCESSING';
          const failedStage = status === 'FAILED';
          const skipped = status === 'SKIPPED';
          const Icon = failedStage ? X : skipped ? Minus : done ? Check : active ? LoaderCircle : Circle;
          return (
            <li
              className={cn(
                'flex min-w-0 items-center gap-2 rounded-lg border border-white/[.05] bg-white/[.02] px-3 py-2 text-xs',
                done || active ? 'text-foreground' : 'text-muted-foreground',
                failedStage && 'text-destructive'
              )}
              key={stage.label}
              title={record?.error ?? undefined}
            >
              <Icon className={cn('h-3.5 w-3.5 shrink-0', active && 'animate-spin text-primary', done && 'text-emerald-400')} aria-hidden />
              <span>{stage.label}: {status.toLowerCase()}{active ? ' (' + (record?.progress ?? 0) + '%)' : ''}</span>
            </li>
          );
        })}
      </ol>
      {job?.error ? <details className='text-xs text-red-300'><summary className='cursor-pointer'>Processing failed · Show details</summary><p className='mt-2 break-words'>{job.error}</p></details> : null}
    </div>
  );
}
