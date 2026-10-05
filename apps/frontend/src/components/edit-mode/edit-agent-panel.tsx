'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Ban, Check, CircleHelp, CornerDownLeft, Crosshair, LoaderCircle,
  ShieldCheck, Sparkles, X } from 'lucide-react';
import { getEditAgent, getEditChatThread, runEditAgent, setEditAgentAutonomy } from '@/lib/edit-mode-api';
import { contextLine } from '@/lib/edit-mode-chat';
import type { AgentAutonomy, AgentLedgerEntry, AgentRun, ChatMessage, EditConstraintInput,
  EditElement, EditTimeRange } from '@/lib/edit-mode-types';

/**
 * The AI editor (Step 7/8): it EDITS this clip through the same validated tools
 * the manual editor uses, then shows a ledger - every clause of the request with
 * what it did, whether the result was verified on the saved project, and
 * anything it held back (destructive work waits for "Yes, do it" unless
 * "Edit automatically" is on). Manual and AI edits land on the SAME project.
 */

const SUGGESTIONS = ['crop the whole video to 9:16', 'make captions white with yellow active words',
  'set music to 15%', 'add subtle zooms', 'make it look more premium'];

const GUARDS: Array<{ type: string; label: string }> = [
  { type: 'PROTECT_CROP', label: "Don't change crop" },
  { type: 'PROTECT_CUTS', label: 'Keep cuts' },
  { type: 'PROTECT_CAPTION_TEXT', label: "Don't touch caption wording" },
  { type: 'PROTECT_COLOR', label: 'Keep colour' },
  { type: 'PROTECT_AUDIO', label: 'Keep audio' }
];

const STATUS: Record<AgentLedgerEntry['status'], { label: string; tone: string }> = {
  DONE: { label: 'Done', tone: 'text-emerald-300' },
  NEEDS_CONFIRMATION: { label: 'Needs your OK', tone: 'text-amber-200' },
  NEEDS_INPUT: { label: 'Question', tone: 'text-sky-200' },
  BLOCKED_BY_CONSTRAINT: { label: 'Blocked by your rule', tone: 'text-slate-300' },
  UNSUPPORTED: { label: 'Not supported', tone: 'text-slate-400' },
  FAILED: { label: 'Failed', tone: 'text-rose-300' },
  SKIPPED: { label: 'Skipped', tone: 'text-slate-400' }
};

export function EditAgentPanel({ projectId, revision, hasSource, disabled, selectedElementId,
  selected, selectedTimeRange, playheadSec, onEdited, onError }: {
  projectId: string;
  revision: number;
  hasSource: boolean;
  disabled: boolean;
  selectedElementId: string | null;
  selected?: EditElement;
  selectedTimeRange: EditTimeRange | null;
  playheadSec: number;
  /** The agent changed the canonical project: the workspace reloads it. */
  onEdited: (run: AgentRun) => void;
  onError: (message: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [autonomy, setAutonomy] = useState<AgentAutonomy>('AI_ASSISTED');
  const [guards, setGuards] = useState<string[]>([]);
  const [aiNote, setAiNote] = useState('');
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([getEditChatThread(projectId).catch(() => null), getEditAgent(projectId).catch(() => null)])
      .then(([thread, state]) => {
        if (!active) return;
        if (thread) setMessages(thread.messages);
        if (state) {
          setAutonomy(state.autonomy);
          setRun(state.runs[0] ?? null);
          setAiNote(state.ai.state === 'AVAILABLE' ? '' : state.ai.message);
        }
      });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages, run]);

  const send = useCallback(async (text?: string) => {
    const message = (text ?? draft).trim();
    if (!message || busy) return;
    setBusy(true);
    if (!text) setDraft('');
    try {
      const constraints: EditConstraintInput[] = guards.map((type) => ({ type }));
      const result = await runEditAgent(projectId, { message, revision, selectedElementId,
        selectedTimeRange, playheadSec, autonomy, constraints });
      setRun(result);
      setAiNote(result.ai.state === 'AVAILABLE' ? '' : result.ai.message);
      const thread = await getEditChatThread(projectId).catch(() => null);
      if (thread) setMessages(thread.messages);
      if (result.revisions.length) onEdited(result);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'The AI editor could not run that');
    } finally { setBusy(false); }
  }, [autonomy, busy, draft, guards, onEdited, onError, playheadSec, projectId, revision,
    selectedElementId, selectedTimeRange]);

  const changeAutonomy = (value: AgentAutonomy) => {
    setAutonomy(value);
    void setEditAgentAutonomy(projectId, value).catch(() => undefined);
  };

  const idle = !busy && !disabled && hasSource;
  const held = run?.ledger.filter((entry) => entry.status === 'NEEDS_CONFIRMATION') ?? [];

  return <section data-testid='agent-panel'
    className='grid content-start gap-3 rounded-2xl border border-white/10 bg-white/5 p-4'>
    <header className='flex items-center gap-2'>
      <Sparkles size={15} className='text-violet-300' />
      <h2 className='text-sm font-bold tracking-tight'>AI Editor</h2>
      <select aria-label='AI autonomy' value={autonomy === 'AI_AUTONOMOUS' ? 'AI_AUTONOMOUS' : 'AI_ASSISTED'}
        onChange={(event) => changeAutonomy(event.target.value as AgentAutonomy)}
        className='ml-auto rounded-md border border-white/10 bg-slate-950/60 px-1.5 py-1 text-[11px] text-slate-200'>
        <option value='AI_ASSISTED'>Ask before major changes</option>
        <option value='AI_AUTONOMOUS'>Edit automatically</option>
      </select>
    </header>

    {aiNote && <p data-testid='agent-ai-note' className='flex items-start gap-1.5 rounded-lg border border-amber-300/20 bg-amber-400/5 px-2 py-1.5 text-[11px] text-amber-100'>
      <AlertTriangle size={12} className='mt-0.5 shrink-0' />{aiNote}</p>}

    <div ref={scroller} className='grid max-h-[360px] content-start gap-2 overflow-y-auto pr-1'>
      {!messages.length && <p className='text-xs leading-relaxed text-slate-400'>
        Tell me what to change in any words - English, Hindi or Hinglish. I edit this clip directly,
        check the result, and ask before removing anything.</p>}
      {messages.slice(-12).map((message) => <p key={message.id} className={message.role === 'USER'
        ? 'ml-6 rounded-xl rounded-br-sm bg-violet-400/15 px-3 py-2 text-xs text-slate-100'
        : 'mr-6 whitespace-pre-line rounded-xl rounded-bl-sm border border-white/10 px-3 py-2 text-[11px] text-slate-300'}>
        {message.text}</p>)}
      {busy && <p className='flex items-center gap-2 text-xs text-slate-400'>
        <LoaderCircle size={12} className='animate-spin' />Editing and checking…</p>}
    </div>

    {run && <Ledger run={run} />}

    {!!held.length && <div className='flex gap-2'>
      <button type='button' disabled={!idle} onClick={() => void send('yes, do it')}
        className='flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-amber-300 px-3 py-1.5 text-xs font-bold text-slate-950 disabled:opacity-40'>
        <Check size={13} />Yes, do it ({held.length})</button>
      <button type='button' disabled={!idle} onClick={() => setRun({ ...run!, ledger: run!.ledger.map((entry) =>
        entry.status === 'NEEDS_CONFIRMATION' ? { ...entry, status: 'SKIPPED', detail: 'Skipped by you.' } : entry) })}
        className='flex items-center justify-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-300 disabled:opacity-40'>
        <X size={13} />Skip</button>
    </div>}

    <div className='flex flex-wrap gap-1.5' role='group' aria-label='Rules for the AI'>
      {GUARDS.map((guard) => { const on = guards.includes(guard.type); return <button key={guard.type}
        type='button' aria-pressed={on}
        onClick={() => setGuards((current) => on ? current.filter((item) => item !== guard.type)
          : [...current, guard.type])}
        className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${on
          ? 'border-emerald-300/40 bg-emerald-400/10 text-emerald-100' : 'border-white/10 text-slate-400'}`}>
        <ShieldCheck size={10} />{guard.label}</button>; })}
    </div>

    <p data-testid='chat-context' className='flex items-start gap-1.5 text-[11px] text-slate-500'>
      <Crosshair size={12} className='mt-0.5 shrink-0 text-slate-600' />
      <span>AI sees: {contextLine({ selected, range: selectedTimeRange, playheadSec })}</span>
    </p>

    {!messages.length && <div className='flex flex-wrap gap-1.5'>
      {SUGGESTIONS.map((suggestion) => <button key={suggestion} type='button' disabled={!idle}
        onClick={() => setDraft(suggestion)}
        className='rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-slate-300 transition hover:border-violet-300/40 hover:text-white disabled:opacity-40'>
        {suggestion}</button>)}
    </div>}

    <div className='grid gap-2'>
      <textarea value={draft} rows={2} disabled={!idle} aria-label='Tell the AI editor what to change'
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
        placeholder={hasSource ? 'e.g. "captions niche rakho, music thoda kam karo"' : 'Attach a source video first'}
        className='w-full resize-none rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600 focus:border-violet-300/40 focus:outline-none disabled:opacity-40' />
      <button type='button' disabled={!idle || !draft.trim()} onClick={() => void send()}
        className='flex items-center justify-center gap-2 rounded-xl bg-violet-400 px-3 py-2 text-xs font-bold text-slate-950 transition disabled:cursor-not-allowed disabled:opacity-40'>
        {busy ? <LoaderCircle size={14} className='animate-spin' /> : <CornerDownLeft size={14} />}
        {busy ? 'Editing…' : 'Edit with AI'}</button>
    </div>
  </section>;
}

/** Every clause, what happened, and whether the saved project proves it. */
function Ledger({ run }: { run: AgentRun }) {
  return <div data-testid='agent-ledger' className='grid gap-1.5 rounded-xl border border-white/10 bg-black/20 p-2.5'>
    <p className='text-[11px] font-semibold text-slate-200'>{run.summary}</p>
    <ol className='grid gap-1'>
      {run.ledger.map((entry) => <li key={entry.index} className='grid gap-0.5 text-[11px]'>
        <span className='flex items-start gap-1.5'>
          {entry.status === 'DONE' ? <Check size={12} className='mt-0.5 shrink-0 text-emerald-300' />
            : entry.status === 'BLOCKED_BY_CONSTRAINT' ? <Ban size={12} className='mt-0.5 shrink-0 text-slate-400' />
              : entry.status === 'NEEDS_INPUT' ? <CircleHelp size={12} className='mt-0.5 shrink-0 text-sky-300' />
                : <AlertTriangle size={12} className='mt-0.5 shrink-0 text-amber-300' />}
          <span className='min-w-0 flex-1 text-slate-200'>{entry.clause}</span>
          <span className={`shrink-0 ${STATUS[entry.status].tone}`}>{STATUS[entry.status].label}
            {entry.status === 'DONE' && entry.verification === 'VERIFIED' ? ' · verified' : ''}
            {entry.verification === 'FAILED' ? ' · not verified' : ''}</span>
        </span>
        {(entry.detail || entry.plannedChanges.length > 0) && <span className='pl-5 text-slate-500'>
          {entry.detail || entry.plannedChanges.slice(0, 3).join('; ')}</span>}
      </li>)}
    </ol>
    {run.review && <details className='text-[11px] text-slate-400'>
      <summary className='cursor-pointer text-slate-300'>Self-review: {run.review.summary}</summary>
      <ul className='mt-1 grid gap-1'>
        {run.review.items.filter((item) => item.severity !== 'LOOKS_GOOD').map((item, index) => <li key={index}>
          <span className='text-slate-200'>{item.title}</span>
          {item.evidence.length > 0 && <span className='block text-slate-500'>Evidence: {item.evidence.join('; ')}</span>}
          {item.suggestion && <span className='block text-slate-500'>Suggestion: {item.suggestion}</span>}
        </li>)}
      </ul>
    </details>}
  </div>;
}
