'use client';

import { useEffect, useState } from 'react';
import { BarChart3, Clapperboard, Rows3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WorkspaceAccordion } from '@/components/workspace-accordion';
import {
  getChunkAnalysis, getChunks, getVisualAnalysis,
  type ChunkAnalysis, type TranscriptChunk, type VisualAnalysis, type Video
} from '@/lib/api';

function timestamp(seconds: number) {
  return Math.floor(seconds / 60) + ':' + (seconds % 60).toFixed(1).padStart(4, '0');
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div><dt className='text-muted-foreground'>{label}</dt><dd className='mt-1 font-medium tabular-nums'>{value}</dd></div>;
}

export function ChunksPanel({ video, visualAnalysisEnabled }: { video: Video; visualAnalysisEnabled: boolean }) {
  const [chunks, setChunks] = useState<TranscriptChunk[] | null>(null);
  const [analyses, setAnalyses] = useState<Map<string, ChunkAnalysis>>(new Map());
  const [visualAnalyses, setVisualAnalyses] = useState<Map<string, VisualAnalysis>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const complete = video.hasChunks || video.processingStages?.some((stage) => stage.stage === 'BUILD_CHUNKS' && stage.status === 'COMPLETED');
  const visualStage = video.processingStages?.find((stage) => stage.stage === 'VISUAL_ANALYSIS');
  const analysisStage = video.processingStages?.find((stage) => stage.stage === 'ANALYZE_CHUNKS');
  const visualResults = [...visualAnalyses.values()];
  const visualSummary = visualResults.length ? {
    scenes: visualResults.reduce((total, item) => total + item.sceneChangeCount, 0),
    motion: visualResults.reduce((total, item) => total + item.averageMotion, 0) / visualResults.length,
    faceChunks: visualResults.filter((item) => item.faceCount > 0).length,
    ocrChunks: visualResults.filter((item) => item.ocrText.trim().length > 0).length
  } : null;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (complete) {
      Promise.all([getChunks(video.id), getChunkAnalysis(video.id)]).then(
        ([chunkResult, analysisResult]) => {
          if (!cancelled) { setChunks(chunkResult); setAnalyses(new Map(analysisResult.map((analysis) => [analysis.chunkId, analysis]))); }
        },
        () => { if (!cancelled) setError('Chunk analyses could not be loaded.'); }
      );
      if (visualStage?.status !== 'SKIPPED') {
        getVisualAnalysis(video.id).then(
          (visualResult) => { if (!cancelled) setVisualAnalyses(new Map(visualResult.map((analysis) => [analysis.chunkId, analysis]))); },
          () => { /* Transcript chunks remain available if optional visual data cannot be loaded. */ }
        );
      }
    }
    return () => { cancelled = true; };
  }, [video.id, complete, analysisStage?.status, analysisStage?.progress, visualStage?.status, visualStage?.progress, attempt]);

  const errorView = error && <div role='alert' className='flex flex-wrap items-center gap-2 text-sm text-danger'><span>{error}</span><Button size='sm' variant='outline' onClick={() => setAttempt((value) => value + 1)}>Retry</Button></div>;
  const loadingView = complete && !chunks && !error && <div className='grid gap-2' role='status' aria-label='Loading chunks'><div className='skeleton h-12' /><div className='skeleton h-12' /></div>;

  return <div className='grid gap-2'>
    <WorkspaceAccordion title='Transcript chunks' summary={chunks ? `${chunks.length} chunks` : complete ? 'Loading' : 'Pending'} icon={Rows3}>
      <div className='grid gap-3 text-sm'>
        {!complete && <p className='text-muted-foreground'>Chunks will appear after the build chunks stage completes.</p>}
        {loadingView}{errorView}
        {chunks?.length === 0 && <p className='text-muted-foreground'>No transcript chunks available.</p>}
        {chunks?.map((chunk) => <div key={chunk.id} className='rounded-xl bg-tint-subtle p-3'><p className='mb-2 flex flex-wrap gap-3 text-xs text-muted-foreground'><span>{timestamp(chunk.startTime)}–{timestamp(chunk.endTime)}</span><span>{chunk.duration.toFixed(1)} sec</span><span>{chunk.wordCount} words</span></p><p>{chunk.text}</p></div>)}
      </div>
    </WorkspaceAccordion>

    <WorkspaceAccordion title='Chunk analysis' summary={analyses.size ? `${analyses.size} analyzed` : complete ? 'Pending' : 'Waiting'} icon={BarChart3}>
      <div className='grid gap-3 text-sm'>
        {!complete && <p className='text-muted-foreground'>Analysis will appear after chunks are built.</p>}{loadingView}{errorView}
        {chunks?.map((chunk) => { const analysis = analyses.get(chunk.id); return <div key={chunk.id} className='rounded-xl bg-tint-subtle p-3'><p className='mb-3 text-xs font-semibold text-soft'>{timestamp(chunk.startTime)}–{timestamp(chunk.endTime)}</p>{analysis ? <dl className='grid grid-cols-2 gap-3 text-xs sm:grid-cols-4'><Metric label='Questions' value={analysis.questionCount} /><Metric label='Exclamations' value={analysis.exclamationCount} /><Metric label='Keyword density' value={`${analysis.keywordDensity.toFixed(1)}%`} /><Metric label='Avg sentence' value={`${analysis.averageSentenceLength.toFixed(1)} words`} /><Metric label='Speech rate' value={`${analysis.speechRate.toFixed(1)} wpm`} /><Metric label='Information density' value={`${analysis.informationDensity.toFixed(1)}%`} /><Metric label='Readability' value={`${analysis.readabilityScore.toFixed(1)}/100`} /></dl> : <p className='text-xs text-muted-foreground'>Analysis unavailable.</p>}</div>; })}
      </div>
    </WorkspaceAccordion>

    <WorkspaceAccordion title='Visual analysis' summary={visualResults.length ? `${visualResults.length} chunks` : visualStage?.status?.toLowerCase() || 'Pending'} icon={Clapperboard}>
      <div className='grid gap-3 text-sm'>
        {visualStage?.status === 'SKIPPED' && <p className='text-muted-foreground'>Visual Intelligence skipped.</p>}
        {visualStage?.status === 'FAILED' && <p role='alert' className='text-danger'>Visual Intelligence failed. Transcript and chunk analyses remain available.</p>}
        {!visualResults.length && visualAnalysisEnabled && visualStage?.status !== 'SKIPPED' && <p className='text-muted-foreground'>Visual analysis unavailable.</p>}
        {visualSummary && <div className='rounded-xl border border-border bg-elevated p-4'><h4 className='text-sm font-semibold'>Visual intelligence summary</h4><dl className='mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4'><Metric label='Scene changes' value={visualSummary.scenes} /><Metric label='Average motion' value={`${visualSummary.motion.toFixed(1)}%`} /><Metric label='Face presence' value={`${visualSummary.faceChunks}/${visualResults.length}`} /><Metric label='OCR presence' value={`${visualSummary.ocrChunks}/${visualResults.length}`} /></dl></div>}
        {chunks?.map((chunk) => { const visual = visualAnalyses.get(chunk.id); if (!visual) return null; return <div key={chunk.id} className='rounded-xl bg-tint-subtle p-3'><p className='mb-3 text-xs font-semibold text-soft'>{timestamp(chunk.startTime)}–{timestamp(chunk.endTime)}</p><dl className='grid grid-cols-2 gap-3 text-xs sm:grid-cols-4'><Metric label='Shot boundaries' value={visual.shotBoundaries.length} /><Metric label='Scene changes' value={visual.sceneChangeCount} /><Metric label='Average motion' value={`${visual.averageMotion.toFixed(1)}%`} /><Metric label='Faces' value={visual.faceCount} /><Metric label='Largest face' value={`${visual.largestFaceRatio.toFixed(1)}%`} /><Metric label='Brightness' value={`${visual.brightness.toFixed(1)}%`} /><Metric label='Contrast' value={`${visual.contrast.toFixed(1)}%`} /><Metric label='Colorfulness' value={`${visual.colorfulness.toFixed(1)}%`} /><Metric label='Subtitles' value={visual.subtitleDetected ? 'Detected' : 'Not detected'} /></dl>{visual.shotBoundaries.length > 0 && <p className='mt-3 text-xs text-muted-foreground'>Cuts at {visual.shotBoundaries.map(timestamp).join(', ')}</p>}<p className='mt-2 whitespace-pre-wrap break-words text-xs'><span className='text-muted-foreground'>OCR: </span>{visual.ocrText || 'No text detected'}</p></div>; })}
      </div>
    </WorkspaceAccordion>
  </div>;
}
