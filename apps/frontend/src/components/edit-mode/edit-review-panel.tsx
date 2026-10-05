'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Eye, LoaderCircle, Sparkles, TriangleAlert } from 'lucide-react';
import { applyEditChat, getLatestEditReview, proposeReviewSuggestion, reviewEdit } from '@/lib/edit-mode-api';
import type { ChatApplyResult, ChatProposal, EditElement, EditReview,
  EditTimeRange, ReviewSeverity } from '@/lib/edit-mode-types';
import { ProposalCard } from './edit-chat-panel';

const labels: Record<ReviewSeverity, string> = { NEEDS_ATTENTION: 'Needs attention',
  COULD_IMPROVE: 'Could improve', LOOKS_GOOD: 'Looks good' };
const colors: Record<ReviewSeverity, string> = { NEEDS_ATTENTION: 'text-amber-200',
  COULD_IMPROVE: 'text-sky-200', LOOKS_GOOD: 'text-emerald-200' };

export function EditReviewPanel({ projectId, revision, disabled, selected, selectedTimeRange,
  playheadSec, onApplied, onPreviewRange, onError }: { projectId: string; revision: number;
  disabled: boolean; selected?: EditElement; selectedTimeRange: EditTimeRange | null;
  playheadSec: number; onApplied: (result: ChatApplyResult) => void;
  onPreviewRange: (range: EditTimeRange) => void; onError: (message: string) => void }) {
  const [review, setReview] = useState<EditReview | null>(null);
  const [proposal, setProposal] = useState<ChatProposal | null>(null);
  const [busy, setBusy] = useState<'review' | 'propose' | 'apply' | null>(null);
  useEffect(() => { let live = true; void getLatestEditReview(projectId).then((value) => {
    if (live && value?.revision === revision) setReview(value);
  }).catch(() => undefined); return () => { live = false; }; }, [projectId, revision]);
  const context = { revision, selectedElementId: selected?.id ?? null, selectedTimeRange, playheadSec };
  const run = async (scope: 'FULL' | 'SELECTION') => { setBusy('review'); setProposal(null); try {
    setReview(await reviewEdit(projectId, scope === 'FULL'
      ? { revision, selectedElementId: null, selectedTimeRange: null, playheadSec,
        message: 'review my edit' }
      : { ...context, message: 'review this' }));
  } catch (caught) { onError(caught instanceof Error ? caught.message : 'Review failed'); }
  finally { setBusy(null); } };
  const suggest = async (findingId: string) => { setBusy('propose'); try {
    const result = await proposeReviewSuggestion(projectId, { ...context, findingId });
    setProposal(result.proposal);
  } catch (caught) { onError(caught instanceof Error ? caught.message : 'Could not prepare suggestion'); }
  finally { setBusy(null); } };
  const apply = async () => { if (!proposal) return; setBusy('apply'); try {
    const result = await applyEditChat(projectId, proposal.proposalId, revision);
    setProposal(null); setReview(null); onApplied(result);
  } catch (caught) { onError(caught instanceof Error ? caught.message : 'Could not apply suggestion'); }
  finally { setBusy(null); } };
  return <section className='grid gap-3'>
    <div className='rounded-xl border border-white/10 bg-white/5 p-3'>
      <div className='flex items-center gap-2'><Eye size={14} className='text-sky-300' />
        <p className='text-xs font-semibold'>Review the current edit</p></div>
      <p className='mt-1 text-[11px] leading-relaxed text-slate-400'>Evidence is kept separate from
        editorial suggestions. A review never changes the project.</p>
      <button disabled={disabled || !!busy} onClick={() => void run('FULL')}
        className='mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-sky-300 px-3 py-2 text-xs font-bold text-slate-950 disabled:opacity-40'>
        {busy === 'review' ? <LoaderCircle size={13} className='animate-spin' /> : <Sparkles size={13} />}
        Review my edit</button>
      {(selected || selectedTimeRange) && <button disabled={disabled || !!busy}
        onClick={() => void run('SELECTION')}
        className='mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-sky-300/25 px-3 py-1.5 text-[11px] font-semibold text-sky-200 disabled:opacity-40'>
        Review this selection</button>}
    </div>
    {review && <div className='grid gap-2' data-testid='edit-review'>
      <p className='text-xs font-semibold text-slate-100'>{review.summary}</p>
      {review.findings.map((finding) => <article key={finding.id}
        className='grid gap-2 rounded-xl border border-white/10 bg-black/20 p-3'>
        <div className='flex items-start gap-2'><div className='min-w-0 flex-1'>
          <p className='text-[10px] font-bold uppercase tracking-[.12em] text-slate-500'>{finding.dimension}</p>
          <p className={`text-[11px] font-semibold ${colors[finding.severity]}`}>{labels[finding.severity]}</p>
        </div>{finding.severity === 'LOOKS_GOOD' ? <CheckCircle2 size={14} className='text-emerald-300' />
          : <TriangleAlert size={14} className='text-amber-300' />}</div>
        <p className='text-xs text-slate-100'>{finding.title}</p>
        <div><p className='text-[10px] font-semibold uppercase tracking-wider text-slate-500'>Evidence</p>
          {finding.evidence.map((line) => <p key={line} className='text-[11px] text-slate-300'>{line}</p>)}</div>
        {finding.suggestion && <div><p className='text-[10px] font-semibold uppercase tracking-wider text-violet-300'>Suggestion</p>
          <p className='text-[11px] text-slate-300'>{finding.suggestion}</p></div>}
        {finding.evidenceLimit && <p className='text-[10px] leading-relaxed text-slate-500'>{finding.evidenceLimit}</p>}
        <div className='flex gap-2'>{finding.previewRange && <button onClick={() => onPreviewRange(finding.previewRange!)}
          className='rounded-md border border-white/10 px-2 py-1 text-[10px] text-slate-300'>Preview</button>}
        {finding.applyInstruction && <button disabled={!!busy} onClick={() => void suggest(finding.id)}
          className='rounded-md bg-violet-400/15 px-2 py-1 text-[10px] font-semibold text-violet-200 disabled:opacity-40'>Apply suggestion</button>}</div>
      </article>)}
    </div>}
    {proposal && <ProposalCard proposal={proposal} busy={busy === 'apply'} onApply={() => void apply()}
      onCancel={() => setProposal(null)} onChange={() => setProposal(null)} />}
  </section>;
}
