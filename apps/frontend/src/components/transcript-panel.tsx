'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WorkspaceAccordion } from '@/components/workspace-accordion';
import { getTranscript, type Transcript, type Video } from '@/lib/api';

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return minutes + ':' + remaining.toString().padStart(2, '0');
}

export function TranscriptPanel({ video }: { video: Video }) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isComplete = video.hasTranscript || video.processingStages?.some((stage) =>
    stage.stage === 'TRANSCRIBE' && stage.status === 'COMPLETED'
  );

  const loadTranscript = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try { setTranscript(await getTranscript(video.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Transcript could not be loaded.'); }
    finally { setIsLoading(false); }
  }, [video.id]);

  useEffect(() => {
    if (isComplete && !transcript && !isLoading && !error) void loadTranscript();
  }, [isComplete, transcript, isLoading, error, loadTranscript]);

  const summary = transcript ? `${transcript.segments.length} segments` : isLoading ? 'Loading' : isComplete ? 'Ready' : 'Pending';
  return <WorkspaceAccordion title='Transcript' summary={summary} icon={FileText}>
    <div className='grid gap-3 text-sm'>
      {isLoading && <div className='grid gap-2' aria-label='Loading transcript'><div className='skeleton h-5 w-full' /><div className='skeleton h-5 w-3/4' /></div>}
      {error && <div role='alert' className='flex items-center justify-between gap-3 text-danger'><span>{error}</span><Button size='sm' variant='outline' onClick={() => void loadTranscript()}>Retry</Button></div>}
      {!isComplete && <p className='text-muted-foreground'>Transcript pending.</p>}
      {transcript && <>
        <div className='flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground'><span>{transcript.language ? 'Source language: ' + transcript.language : 'Source language unavailable'}</span><span>{transcript.segments.length} segments</span></div>
        {transcript.segments.map((segment) => <div className='grid grid-cols-[48px_minmax(0,1fr)] gap-3' key={segment.id}><span className='font-mono text-xs text-muted-foreground'>{formatTime(segment.start)}</span><p>{segment.text}</p></div>)}
        {transcript.segments.length === 0 && <p>{transcript.text}</p>}
      </>}
      {isComplete && !isLoading && !error && !transcript && <p className='text-muted-foreground'>No transcript data.</p>}
    </div>
  </WorkspaceAccordion>;
}
