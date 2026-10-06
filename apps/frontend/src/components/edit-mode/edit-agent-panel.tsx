'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowUp, Ban, Check, CircleHelp, CornerDownLeft, Crosshair, LoaderCircle,
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
  DONE: { label: 'Done', tone: 'text-success' },
  NEEDS_CONFIRMATION: { label: 'Needs your OK', tone: 'text-warning-soft' },
  NEEDS_INPUT: { label: 'Question', tone: 'text-secondary-soft' },
  BLOCKED_BY_CONSTRAINT: { label: 'Blocked by your rule', tone: 'text-soft' },
  UNSUPPORTED: { label: 'Not supported', tone: 'text-muted-foreground' },
  FAILED: { label: 'Failed', tone: 'text-danger' },
  SKIPPED: { label: 'Skipped', tone: 'text-muted-foreground' }
};

export function EditAgentPanel({ projectId, revision, hasSource, disabled, selectedElementId,
  selected, selectedTimeRange, playheadSec, onEdited, onError, layout = 'panel' }: {
  /** `sheet`: the phone drawer - a scrolling thread with the composer pinned at the bottom. */
  layout?: 'panel' | 'sheet';
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
  const composer = useRef<HTMLTextAreaElement>(null);

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
      const result = await runEditAgent(projectId, { message, revision, aiConsent: true, selectedElementId,
        selectedTimeRange, playheadSec, autonomy, constraints });
      setRun(result);
      setAiNote(result.ai.state === 'AVAILABLE' ? '' : result.ai.message);
      const thread = await getEditChatThread(projectId).catch(() => null);
      if (thread) setMessages(thread.messages);
      if (result.revisions.length) onEdited(result);
    } catch {
      onError('Ask AI is temporarily unavailable.');
    } finally { setBusy(false); }
  }, [autonomy, busy, draft, guards, onEdited, onError, playheadSec, projectId, revision,
    selectedElementId, selectedTimeRange]);

  const changeAutonomy = (value: AgentAutonomy) => {
    setAutonomy(value);
    void setEditAgentAutonomy(projectId, value).catch(() => undefined);
  };

  const idle = !busy && !disabled && hasSource;
  const held = run?.ledger.filter((entry) => entry.status === 'NEEDS_CONFIRMATION') ?? [];

  if (layout === 'sheet') {
    // The keyboard opening shrinks the drawer; keep the newest message in view above the input.
    const revealLatest = () => window.setTimeout(() =>
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight }), 280);
    const grow = (node: HTMLTextAreaElement) => {
      node.style.height = 'auto';
      node.style.height = `${Math.min(128, node.scrollHeight)}px`;
    };
    return <section data-testid='agent-panel' className='flex h-full min-h-0 min-w-0 flex-col'>
      <div ref={scroller} className='min-h-0 flex-1 overflow-y-auto overscroll-contain'>
        <div className='grid content-start gap-3 pb-3'>
          <div className='flex items-center gap-2'>
            <Sparkles size={16} className='shrink-0 text-primary-soft' />
            <select aria-label='AI autonomy' value={autonomy === 'AI_AUTONOMOUS' ? 'AI_AUTONOMOUS' : 'AI_ASSISTED'}
              onChange={(event) => changeAutonomy(event.target.value as AgentAutonomy)}
              className='h-10 min-w-0 flex-1 rounded-xl border border-border bg-background/60 px-3 text-sm text-soft'>
              <option value='AI_ASSISTED'>Ask before major changes</option>
              <option value='AI_AUTONOMOUS'>Edit automatically</option>
            </select>
          </div>
          {aiNote && <p data-testid='agent-ai-note' className='flex items-start gap-2 rounded-xl border border-warning/20 bg-warning/5 px-3 py-2 text-xs leading-5 text-warning-soft'>
            <AlertTriangle size={14} className='mt-0.5 shrink-0' />{aiNote}</p>}
          {!messages.length && <p className='text-sm leading-6 text-muted-foreground'>
            Tell me what to change in any words - English, Hindi or Hinglish. I edit this clip directly,
            check the result, and ask before removing anything.</p>}
          {messages.slice(-30).map((message) => <p key={message.id} className={message.role === 'USER'
            ? 'ml-8 break-words rounded-2xl rounded-br-md bg-primary/20 px-3.5 py-2.5 text-sm leading-6 text-foreground'
            : 'mr-6 whitespace-pre-line break-words rounded-2xl rounded-bl-md border border-border bg-tint-subtle px-3.5 py-2.5 text-sm leading-6 text-soft'}>
            {message.text}</p>)}
          {busy && <p className='flex items-center gap-2 text-sm text-muted-foreground'>
            <LoaderCircle size={15} className='animate-spin' />Editing and checking…</p>}
          {run && <Ledger run={run} />}
          {!!held.length && <div className='grid grid-cols-[1fr_auto] gap-2'>
            <button type='button' disabled={!idle} onClick={() => void send('yes, do it')}
              className='flex h-11 items-center justify-center gap-1.5 rounded-xl bg-warning px-3 text-sm font-bold text-warning-foreground disabled:opacity-40'>
              <Check size={15} />Yes, do it ({held.length})</button>
            <button type='button' disabled={!idle} onClick={() => setRun({ ...run!, ledger: run!.ledger.map((entry) =>
              entry.status === 'NEEDS_CONFIRMATION' ? { ...entry, status: 'SKIPPED', detail: 'Skipped by you.' } : entry) })}
              className='flex h-11 items-center justify-center gap-1.5 rounded-xl border border-border px-4 text-sm font-semibold text-soft disabled:opacity-40'>
              <X size={15} />Skip</button>
          </div>}
          {!messages.length && <div className='flex flex-wrap gap-2'>
            {SUGGESTIONS.map((suggestion) => <button key={suggestion} type='button' disabled={!idle}
              onClick={() => { setDraft(suggestion); composer.current?.focus(); }}
              className='min-h-[40px] rounded-full border border-border px-3.5 text-sm text-soft disabled:opacity-40'>
              {suggestion}</button>)}
          </div>}
          <details className='group rounded-xl border border-border text-sm'>
            <summary className='flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-3 text-soft [&::-webkit-details-marker]:hidden'>
              <ShieldCheck size={15} className='shrink-0 text-success/80' />Editing preferences
              {guards.length ? <span className='rounded-full bg-success/15 px-2 text-xs text-success-soft'>{guards.length}</span> : null}</summary>
            <div className='flex flex-wrap gap-2 px-3 pb-3' role='group' aria-label='Editing preferences'>
              {GUARDS.map((guard) => { const on = guards.includes(guard.type); return <button key={guard.type}
                type='button' aria-pressed={on}
                onClick={() => setGuards((current) => on ? current.filter((item) => item !== guard.type)
                  : [...current, guard.type])}
                className={`flex min-h-[38px] items-center gap-1.5 rounded-full border px-3 text-xs ${on
                  ? 'border-success/40 bg-success/10 text-success-soft' : 'border-border text-muted-foreground'}`}>
                <ShieldCheck size={12} />{guard.label}</button>; })}
            </div>
          </details>
          <p data-testid='chat-context' className='flex items-start gap-1.5 text-xs text-faint'>
            <Crosshair size={13} className='mt-0.5 shrink-0 text-faint' />
            <span className='min-w-0 break-words'>AI sees: {contextLine({ selected, range: selectedTimeRange, playheadSec })}</span>
          </p>
        </div>
      </div>
      <div className='shrink-0 border-t border-border pt-3 pb-[max(.5rem,var(--safe-bottom))]'>
        <div className='flex items-end gap-2'>
          <textarea ref={composer} value={draft} rows={1} disabled={!idle} aria-label='Tell the AI editor what to change'
            enterKeyHint='send'
            onChange={(event) => { setDraft(event.target.value); grow(event.currentTarget); }}
            onFocus={revealLatest}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
            placeholder={hasSource ? 'Tell the AI what to change…' : 'Attach a source video first'}
            className='max-h-32 min-h-[48px] min-w-0 flex-1 resize-none rounded-2xl border border-border bg-background/70 px-4 py-3 text-base leading-6 text-foreground placeholder:text-faint focus:border-primary/50 focus:outline-none disabled:opacity-40' />
          <button type='button' disabled={!idle || !draft.trim()} onClick={() => { void send(); if (composer.current) composer.current.style.height = 'auto'; }}
            aria-label='Edit with AI'
            className='grid h-12 w-12 shrink-0 place-items-center rounded-2xl btn-primary text-primary-foreground transition disabled:cursor-not-allowed disabled:opacity-40'>
            {busy ? <LoaderCircle size={18} className='animate-spin' /> : <ArrowUp size={20} />}</button>
        </div>
      </div>
    </section>;
  }

  return <section data-testid='agent-panel'
    className='grid content-start gap-3 rounded-2xl border border-border bg-tint p-4'>
    <header className='flex items-center gap-2'>
      <Sparkles size={15} className='text-primary-soft' />
      <h2 className='text-sm font-bold tracking-tight'>AI Editor</h2>
      <select aria-label='AI autonomy' value={autonomy === 'AI_AUTONOMOUS' ? 'AI_AUTONOMOUS' : 'AI_ASSISTED'}
        onChange={(event) => changeAutonomy(event.target.value as AgentAutonomy)}
        className='ml-auto rounded-md border border-border bg-background/60 px-1.5 py-1 text-[11px] text-soft'>
        <option value='AI_ASSISTED'>Ask before major changes</option>
        <option value='AI_AUTONOMOUS'>Edit automatically</option>
      </select>
    </header>

    {aiNote && <p data-testid='agent-ai-note' className='flex items-start gap-1.5 rounded-lg border border-warning/20 bg-warning/5 px-2 py-1.5 text-[11px] text-warning-soft'>
      <AlertTriangle size={12} className='mt-0.5 shrink-0' />{aiNote}</p>}

    <div ref={scroller} className='grid max-h-[360px] content-start gap-2 overflow-y-auto pr-1'>
      {!messages.length && <p className='text-xs leading-relaxed text-muted-foreground'>
        Tell me what to change in any words - English, Hindi or Hinglish. I edit this clip directly,
        check the result, and ask before removing anything.</p>}
      {messages.slice(-12).map((message) => <p key={message.id} className={message.role === 'USER'
        ? 'ml-6 rounded-xl rounded-br-sm bg-primary/15 px-3 py-2 text-xs text-foreground'
        : 'mr-6 whitespace-pre-line rounded-xl rounded-bl-sm border border-border px-3 py-2 text-[11px] text-soft'}>
        {message.text}</p>)}
      {busy && <p className='flex items-center gap-2 text-xs text-muted-foreground'>
        <LoaderCircle size={12} className='animate-spin' />Editing and checking…</p>}
    </div>

    {run && <Ledger run={run} />}

    {!!held.length && <div className='flex gap-2'>
      <button type='button' disabled={!idle} onClick={() => void send('yes, do it')}
        className='flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-warning px-3 py-1.5 text-xs font-bold text-warning-foreground disabled:opacity-40'>
        <Check size={13} />Yes, do it ({held.length})</button>
      <button type='button' disabled={!idle} onClick={() => setRun({ ...run!, ledger: run!.ledger.map((entry) =>
        entry.status === 'NEEDS_CONFIRMATION' ? { ...entry, status: 'SKIPPED', detail: 'Skipped by you.' } : entry) })}
        className='flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-soft disabled:opacity-40'>
        <X size={13} />Skip</button>
    </div>}

    <div className='flex flex-wrap gap-1.5' role='group' aria-label='Editing preferences'>
      {GUARDS.map((guard) => { const on = guards.includes(guard.type); return <button key={guard.type}
        type='button' aria-pressed={on}
        onClick={() => setGuards((current) => on ? current.filter((item) => item !== guard.type)
          : [...current, guard.type])}
        className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${on
          ? 'border-success/40 bg-success/10 text-success-soft' : 'border-border text-muted-foreground'}`}>
        <ShieldCheck size={10} />{guard.label}</button>; })}
    </div>

    <p data-testid='chat-context' className='flex items-start gap-1.5 text-[11px] text-faint'>
      <Crosshair size={12} className='mt-0.5 shrink-0 text-faint' />
      <span>AI sees: {contextLine({ selected, range: selectedTimeRange, playheadSec })}</span>
    </p>

    {!messages.length && <div className='flex flex-wrap gap-1.5'>
      {SUGGESTIONS.map((suggestion) => <button key={suggestion} type='button' disabled={!idle}
        onClick={() => setDraft(suggestion)}
        className='rounded-full border border-border px-2.5 py-1 text-[11px] text-soft transition hover:border-primary/40 hover:text-foreground disabled:opacity-40'>
        {suggestion}</button>)}
    </div>}

    <div className='grid gap-2'>
      <textarea value={draft} rows={2} disabled={!idle} aria-label='Tell the AI editor what to change'
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
        placeholder={hasSource ? 'e.g. "captions niche rakho, music thoda kam karo"' : 'Attach a source video first'}
        className='w-full resize-none rounded-xl border border-border bg-background/60 px-3 py-2 text-xs text-foreground placeholder:text-faint focus:border-primary/40 focus:outline-none disabled:opacity-40' />
      <button type='button' disabled={!idle || !draft.trim()} onClick={() => void send()}
        className='flex items-center justify-center gap-2 rounded-xl btn-primary px-3 py-2 text-xs font-bold text-primary-foreground transition disabled:cursor-not-allowed disabled:opacity-40'>
        {busy ? <LoaderCircle size={14} className='animate-spin' /> : <CornerDownLeft size={14} />}
        {busy ? 'Editing…' : 'Edit with AI'}</button>
    </div>
  </section>;
}

/** Every clause, what happened, and whether the saved project proves it. */
function Ledger({ run }: { run: AgentRun }) {
  return <div data-testid='agent-ledger' className='grid gap-1.5 rounded-xl border border-border bg-inset p-2.5'>
    <p className='text-[11px] font-semibold text-soft'>{run.summary}</p>
    <ol className='grid gap-1'>
      {run.ledger.map((entry) => <li key={entry.index} className='grid gap-0.5 text-[11px]'>
        <span className='flex items-start gap-1.5'>
          {entry.status === 'DONE' ? <Check size={12} className='mt-0.5 shrink-0 text-success' />
            : entry.status === 'BLOCKED_BY_CONSTRAINT' ? <Ban size={12} className='mt-0.5 shrink-0 text-muted-foreground' />
              : entry.status === 'NEEDS_INPUT' ? <CircleHelp size={12} className='mt-0.5 shrink-0 text-secondary' />
                : <AlertTriangle size={12} className='mt-0.5 shrink-0 text-warning' />}
          <span className='min-w-0 flex-1 text-soft'>{entry.clause}</span>
          <span className={`shrink-0 ${STATUS[entry.status].tone}`}>{STATUS[entry.status].label}
            {entry.status === 'DONE' && entry.verification === 'VERIFIED' ? ' · verified' : ''}
            {entry.verification === 'FAILED' ? ' · not verified' : ''}</span>
        </span>
        {(entry.detail || entry.plannedChanges.length > 0) && <span className='pl-5 text-faint'>
          {entry.detail || entry.plannedChanges.slice(0, 3).join('; ')}</span>}
      </li>)}
    </ol>
    {run.review && <details className='text-[11px] text-muted-foreground'>
      <summary className='cursor-pointer text-soft'>Self-review: {run.review.summary}</summary>
      <ul className='mt-1 grid gap-1'>
        {run.review.items.filter((item) => item.severity !== 'LOOKS_GOOD').map((item, index) => <li key={index}>
          <span className='text-soft'>{item.title}</span>
          {item.evidence.length > 0 && <span className='block text-faint'>Evidence: {item.evidence.join('; ')}</span>}
          {item.suggestion && <span className='block text-faint'>Suggestion: {item.suggestion}</span>}
        </li>)}
      </ul>
    </details>}
  </div>;
}
