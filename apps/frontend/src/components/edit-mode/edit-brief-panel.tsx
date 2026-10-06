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
    {plan && <div className='rounded-xl border border-border bg-tint p-3 text-xs'>
      <p className='font-semibold'>{plan.status === 'COMPLETED' ? 'Plan completed' : 'Plan stopped'}</p>
      {plan.finalReview && <p className='mt-1 text-[11px] text-muted-foreground'>{plan.finalReview.summary}</p>}</div>}
    <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={6}
      placeholder='Make this into a clean professional Reel…'
      className='resize-none rounded-xl border border-border bg-inset p-3 text-xs text-foreground placeholder:text-faint focus:border-primary/40 focus:outline-none' />
    <button disabled={disabled || busy || !draft.trim()} onClick={() => void create()}
      className='flex items-center justify-center gap-2 rounded-lg btn-primary px-3 py-2 text-xs font-bold text-primary-foreground disabled:opacity-40'>
      {busy ? <LoaderCircle size={13} className='animate-spin' /> : <Sparkles size={13} />}Build AI Edit Plan</button>
  </section>;
  const step = plan.steps[plan.currentStepIndex];
  return <section className='grid gap-3' data-testid='edit-brief-plan'>
    <div><p className='text-xs font-bold text-foreground'>AI Edit Plan</p>
      {!!plan.protectedConstraints.length && <p className='mt-1 text-[10px] text-success-soft'>Protected: {plan.protectedConstraints.join(', ')}</p>}</div>
    <ol className='grid gap-1'>{plan.steps.map((item, index) => <li key={item.id}
      className={`flex items-center gap-2 rounded-md px-2 py-1 text-[11px] ${index === plan.currentStepIndex
        ? 'bg-primary/10 text-foreground' : 'text-muted-foreground'}`}>
      {['APPLIED', 'COMPLETED'].includes(item.status) ? <Check size={12} className='text-success' />
        : item.status === 'SKIPPED' ? <SkipForward size={12} /> : <Circle size={10} />}
      <span className='min-w-0 flex-1'>{index + 1}. {item.label}</span>
      {index === plan.currentStepIndex && <span className='text-[9px] uppercase text-primary-soft'>Current</span>}</li>)}</ol>
    {step && <div className='grid gap-2 rounded-xl border border-primary/25 bg-primary/5 p-3'>
      <p className='text-xs font-semibold'>{step.label}</p><p className='text-[11px] text-soft'>{step.interpretedGoal}</p>
      {step.resultSummary && <p className='text-[11px] text-muted-foreground'>{step.resultSummary}</p>}
      {!!step.proposedCommands.length && <ul className='grid gap-0.5 text-[10px] text-muted-foreground'>
        {step.proposedCommands.map((line) => <li key={line}>· {line}</li>)}</ul>}
      {step.warnings.map((line) => <p key={line} className='text-[10px] text-warning-soft'>{line}</p>)}
      <div className='grid grid-cols-2 gap-2'>
        {step.status === 'APPLIED' ? <button disabled={busy} onClick={() => void respond('continue')}
          className='col-span-2 rounded-lg btn-primary py-1.5 text-xs font-bold text-primary-foreground'>Continue</button>
          : <><button disabled={busy || step.status === 'FAILED'} onClick={() => void respond('apply it')}
            className='rounded-lg bg-success py-1.5 text-xs font-bold text-success-foreground disabled:opacity-40'>Apply</button>
          <button disabled={busy} onClick={() => void respond('more subtle')}
            className='rounded-lg border border-border py-1.5 text-xs text-soft'>Change</button></>}
        <button disabled={busy} onClick={() => void respond('skip')}
          className='rounded-lg border border-border py-1.5 text-xs text-soft'>Skip</button>
        <button disabled={busy} onClick={() => void respond('stop')}
          className='flex items-center justify-center gap-1 rounded-lg border border-danger/20 py-1.5 text-xs text-danger-soft'><OctagonX size={11} />Stop</button>
      </div>
      {busy && <p className='flex items-center gap-1 text-[10px] text-muted-foreground'><LoaderCircle size={11} className='animate-spin' />Working…</p>}
    </div>}
  </section>;
}
