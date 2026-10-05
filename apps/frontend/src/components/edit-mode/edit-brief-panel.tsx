'use client';

import { useEffect, useState } from 'react';
import { Check, Circle, LoaderCircle, OctagonX, SkipForward, Sparkles } from 'lucide-react';
import { createEditBriefPlan, getEditBriefPlan, respondEditBriefPlan } from '@/lib/edit-mode-api';
import type { BriefPlan, ChatApplyResult, EditElement, EditTimeRange } from '@/lib/edit-mode-types';

export function EditBriefPanel({ projectId, revision, disabled, selected, selectedTimeRange,
  playheadSec, onProject, onError }: { projectId: string; revision: number; disabled: boolean;
  selected?: EditElement; selectedTimeRange: EditTimeRange | null; playheadSec: number;
  onProject: (result: ChatApplyResult) => void; onError: (message: string) => void }) {
  const [plan, setPlan] = useState<BriefPlan | null>(null); const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false); const context = { revision,
    selectedElementId: selected?.id ?? null, selectedTimeRange, playheadSec };
  useEffect(() => { let live = true; void getEditBriefPlan(projectId).then((value) => {
    if (live) setPlan(value);
  }).catch(() => undefined); return () => { live = false; }; }, [projectId]);
  const create = async () => { if (!draft.trim()) return; setBusy(true); try {
    setPlan(await createEditBriefPlan(projectId, { ...context, brief: draft })); setDraft('');
  } catch (caught) { onError(caught instanceof Error ? caught.message : 'Could not build the edit plan'); }
  finally { setBusy(false); } };
  const respond = async (message: string) => { setBusy(true); try {
    const result = await respondEditBriefPlan(projectId, { ...context, message }); setPlan(result.plan);
    if (result.project) onProject({ project: result.project, proposal: result.plan.activeProposal!,
      affectedElementIds: [], messages: [] });
  } catch (caught) { onError(caught instanceof Error ? caught.message : 'Could not continue the plan'); }
  finally { setBusy(false); } };
  if (!plan || plan.status === 'COMPLETED' || plan.status === 'STOPPED') return <section className='grid gap-3'>
    {plan && <div className='rounded-xl border border-white/10 bg-white/5 p-3 text-xs'>
      <p className='font-semibold'>{plan.status === 'COMPLETED' ? 'Plan completed' : 'Plan stopped'}</p>
      {plan.finalReview && <p className='mt-1 text-[11px] text-slate-400'>{plan.finalReview.summary}</p>}</div>}
    <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={6}
      placeholder='Make this into a clean professional Reel…'
      className='resize-none rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-slate-100 placeholder:text-slate-600 focus:border-violet-300/40 focus:outline-none' />
    <button disabled={disabled || busy || !draft.trim()} onClick={() => void create()}
      className='flex items-center justify-center gap-2 rounded-lg bg-violet-400 px-3 py-2 text-xs font-bold text-slate-950 disabled:opacity-40'>
      {busy ? <LoaderCircle size={13} className='animate-spin' /> : <Sparkles size={13} />}Build AI Edit Plan</button>
  </section>;
  const step = plan.steps[plan.currentStepIndex];
  return <section className='grid gap-3' data-testid='edit-brief-plan'>
    <div><p className='text-xs font-bold text-slate-100'>AI Edit Plan</p>
      {!!plan.protectedConstraints.length && <p className='mt-1 text-[10px] text-emerald-200'>Protected: {plan.protectedConstraints.join(', ')}</p>}</div>
    <ol className='grid gap-1'>{plan.steps.map((item, index) => <li key={item.id}
      className={`flex items-center gap-2 rounded-md px-2 py-1 text-[11px] ${index === plan.currentStepIndex
        ? 'bg-violet-400/10 text-white' : 'text-slate-400'}`}>
      {['APPLIED', 'COMPLETED'].includes(item.status) ? <Check size={12} className='text-emerald-300' />
        : item.status === 'SKIPPED' ? <SkipForward size={12} /> : <Circle size={10} />}
      <span className='min-w-0 flex-1'>{index + 1}. {item.label}</span>
      {index === plan.currentStepIndex && <span className='text-[9px] uppercase text-violet-300'>Current</span>}</li>)}</ol>
    {step && <div className='grid gap-2 rounded-xl border border-violet-300/25 bg-violet-400/5 p-3'>
      <p className='text-xs font-semibold'>{step.label}</p><p className='text-[11px] text-slate-300'>{step.interpretedGoal}</p>
      {step.resultSummary && <p className='text-[11px] text-slate-400'>{step.resultSummary}</p>}
      {!!step.proposedCommands.length && <ul className='grid gap-0.5 text-[10px] text-slate-400'>
        {step.proposedCommands.map((line) => <li key={line}>· {line}</li>)}</ul>}
      {step.warnings.map((line) => <p key={line} className='text-[10px] text-amber-200'>{line}</p>)}
      <div className='grid grid-cols-2 gap-2'>
        {step.status === 'APPLIED' ? <button disabled={busy} onClick={() => void respond('continue')}
          className='col-span-2 rounded-lg bg-violet-400 py-1.5 text-xs font-bold text-slate-950'>Continue</button>
          : <><button disabled={busy || step.status === 'FAILED'} onClick={() => void respond('apply it')}
            className='rounded-lg bg-emerald-400 py-1.5 text-xs font-bold text-slate-950 disabled:opacity-40'>Apply</button>
          <button disabled={busy} onClick={() => void respond('more subtle')}
            className='rounded-lg border border-white/10 py-1.5 text-xs text-slate-200'>Change</button></>}
        <button disabled={busy} onClick={() => void respond('skip')}
          className='rounded-lg border border-white/10 py-1.5 text-xs text-slate-300'>Skip</button>
        <button disabled={busy} onClick={() => void respond('stop')}
          className='flex items-center justify-center gap-1 rounded-lg border border-red-300/20 py-1.5 text-xs text-red-200'><OctagonX size={11} />Stop</button>
      </div>
      {busy && <p className='flex items-center gap-1 text-[10px] text-slate-400'><LoaderCircle size={11} className='animate-spin' />Working…</p>}
    </div>}
  </section>;
}
