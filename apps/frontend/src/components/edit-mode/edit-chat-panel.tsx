'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CornerDownLeft, LoaderCircle, RefreshCw, Sparkles, TriangleAlert,
  X } from 'lucide-react';
import {
  applyEditChat, cancelEditChat, EditModeApiError, getEditChatThread, planEditChat
} from '@/lib/edit-mode-api';
import type { ChatApplyResult, ChatMessage, ChatProposal, EditTimeRange } from '@/lib/edit-mode-types';

/** Concrete openers, so the panel teaches its own vocabulary. */
const SUGGESTIONS = [
  'Remove the first 3 seconds',
  'Make the logo smaller',
  'Mute the music',
  'Make it 9:16'
];

/**
 * The AI editor panel.
 *
 * Every turn is proposal-first: the assistant explains what it would change in
 * plain sentences and waits. Nothing is applied until Apply is pressed, and the
 * raw commands are never shown or sent from here - the browser only ever holds
 * a proposal id.
 */
export function EditChatPanel({ projectId, revision, hasSource, disabled, selectedElementId,
  selectedTimeRange, playheadSec, onApplied, onError }: {
  projectId: string;
  revision: number;
  hasSource: boolean;
  disabled: boolean;
  selectedElementId: string | null;
  selectedTimeRange: EditTimeRange | null;
  playheadSec: number;
  onApplied: (result: ChatApplyResult) => void;
  onError: (message: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [proposal, setProposal] = useState<ChatProposal | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'planning' | 'applying' | null>(null);
  // The wording behind the current proposal, so "Regenerate" can re-plan the
  // same request against the timeline as it stands now.
  const [lastInstruction, setLastInstruction] = useState('');
  const [loaded, setLoaded] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void getEditChatThread(projectId)
      .then((thread) => { if (active) setMessages(thread.messages); })
      .catch(() => undefined)
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages, proposal]);

  const send = useCallback(async (override?: string) => {
    const message = (override ?? draft).trim();
    if (!message || busy) return;
    setBusy('planning'); setLastInstruction(message);
    if (!override) setDraft('');
    try {
      const result = await planEditChat(projectId, { message, revision, selectedElementId,
        selectedTimeRange, playheadSec });
      setMessages(result.messages);
      setProposal(result.proposal.needsClarification ? null : result.proposal);
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : 'The AI editor could not plan that';
      setMessages((current) => [...current,
        { id: `local-${Date.now()}`, role: 'USER', text: message, createdAt: new Date().toISOString() },
        { id: `local-${Date.now()}-e`, role: 'SYSTEM_STATUS', text, state: 'FAILED',
          createdAt: new Date().toISOString() }]);
      setProposal(null);
    } finally { setBusy(null); }
  }, [busy, draft, playheadSec, projectId, revision, selectedElementId, selectedTimeRange]);

  const apply = useCallback(async () => {
    if (!proposal || busy) return;
    setBusy('applying');
    try {
      const result = await applyEditChat(projectId, proposal.proposalId, revision);
      setMessages(result.messages);
      setProposal(null);
      onApplied(result);
    } catch (caught) {
      const stale = caught instanceof EditModeApiError &&
        (caught.code === 'STALE_PROPOSAL' || caught.code === 'PROPOSAL_NOT_FOUND');
      setProposal((current) => current ? { ...current, state: stale ? 'STALE' : 'FAILED' } : null);
      onError(caught instanceof Error ? caught.message : 'That edit could not be applied');
    } finally { setBusy(null); }
  }, [busy, onApplied, onError, projectId, proposal, revision]);

  const cancel = useCallback(async () => {
    if (!proposal) return;
    const pending = proposal;
    setProposal(null);
    try { setMessages((await cancelEditChat(projectId, pending.proposalId)).messages); }
    catch { /* cancelling is local-safe: nothing was applied either way */ }
  }, [projectId, proposal]);

  const idle = !busy && !disabled && hasSource;

  return <section className='grid content-start gap-3 rounded-2xl border border-white/10 bg-white/5 p-4'>
    <header className='flex items-center gap-2'>
      <Sparkles size={15} className='text-violet-300' />
      <h2 className='text-sm font-bold tracking-tight'>AI Editor</h2>
      <span className='ml-auto text-[11px] text-slate-500'>Proposes, never auto-applies</span>
    </header>

    <div ref={scroller} className='grid max-h-[320px] content-start gap-2 overflow-y-auto pr-1'>
      {!loaded && <p className='text-xs text-slate-500'>Loading conversation…</p>}
      {loaded && !messages.length && <p className='text-xs leading-relaxed text-slate-400'>
        Tell me what to change and I&apos;ll show you the edit before anything happens.
      </p>}
      {messages.map((message) => <ChatBubble key={message.id} message={message} />)}
      {busy === 'planning' && <p className='flex items-center gap-2 text-xs text-slate-400'>
        <LoaderCircle size={12} className='animate-spin' />Planning…</p>}
    </div>

    {proposal && <ProposalCard proposal={proposal} busy={busy === 'applying'}
      onApply={() => void apply()} onCancel={() => void cancel()}
      onRegenerate={lastInstruction ? () => void send(lastInstruction) : undefined} />}

    {selectedTimeRange && <p className='rounded-lg border border-amber-300/20 bg-amber-300/5 px-2.5 py-1.5 text-[11px] text-amber-200'>
      Acting on the selected {selectedTimeRange.startSec.toFixed(1)}s–
      {selectedTimeRange.endSec.toFixed(1)}s. Try &ldquo;delete this section&rdquo;.</p>}

    {loaded && !messages.length && <div className='flex flex-wrap gap-1.5'>
      {SUGGESTIONS.map((suggestion) => <button key={suggestion} type='button' disabled={!idle}
        onClick={() => setDraft(suggestion)}
        className='rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-slate-300 transition hover:border-violet-300/40 hover:text-white disabled:opacity-40'>
        {suggestion}</button>)}
    </div>}

    <div className='grid gap-2'>
      <textarea value={draft} rows={2} disabled={!idle}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
        }}
        placeholder={hasSource ? 'e.g. "remove the first 3 seconds and make the logo smaller"'
          : 'Attach a source video first'}
        className='w-full resize-none rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600 focus:border-violet-300/40 focus:outline-none disabled:opacity-40' />
      <button type='button' disabled={!idle || !draft.trim()} onClick={() => void send()}
        className='flex items-center justify-center gap-2 rounded-xl bg-violet-400 px-3 py-2 text-xs font-bold text-slate-950 transition disabled:cursor-not-allowed disabled:opacity-40'>
        {busy === 'planning' ? <LoaderCircle size={14} className='animate-spin' />
          : <CornerDownLeft size={14} />}
        {busy === 'planning' ? 'Planning…' : 'Plan the edit'}</button>
    </div>
  </section>;
}

function ChatBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'USER') {
    return <p className='ml-6 rounded-xl rounded-br-sm bg-violet-400/15 px-3 py-2 text-xs text-slate-100'>
      {message.text}</p>;
  }
  if (message.role === 'SYSTEM_STATUS') {
    const failed = message.state === 'FAILED' || message.state === 'STALE';
    return <p className={`flex items-start gap-1.5 text-[11px] ${
      failed ? 'text-amber-200' : 'text-slate-500'}`}>
      {failed ? <TriangleAlert size={12} className='mt-0.5 shrink-0' />
        : <Check size={12} className='mt-0.5 shrink-0 text-emerald-300' />}
      {message.text}</p>;
  }
  return <div className='mr-6 grid gap-1 rounded-xl rounded-bl-sm border border-white/10 px-3 py-2'>
    <p className='text-xs text-slate-200'>{message.text}</p>
    {!!message.plannedChanges?.length && <ul className='grid gap-0.5 text-[11px] text-slate-400'>
      {message.plannedChanges.map((line, index) => <li key={index}>· {line}</li>)}
    </ul>}
  </div>;
}

/** The decision point. Plain sentences only - no command JSON. */
function ProposalCard({ proposal, busy, onApply, onCancel, onRegenerate }: {
  proposal: ChatProposal; busy: boolean; onApply: () => void; onCancel: () => void;
  onRegenerate?: () => void;
}) {
  const stale = proposal.state === 'STALE' || proposal.state === 'FAILED';
  return <div className='grid gap-2 rounded-xl border border-violet-300/25 bg-violet-400/5 p-3'>
    <p className='text-[11px] font-semibold uppercase tracking-[.14em] text-violet-300'>
      Planned changes</p>
    <ul className='grid gap-1 text-xs text-slate-200'>
      {proposal.plannedChanges.map((line, index) => <li key={index} className='flex gap-1.5'>
        <span className='text-violet-300'>·</span>{line}</li>)}
    </ul>
    {!!proposal.warnings.length && <ul className='grid gap-1'>
      {proposal.warnings.map((warning, index) => <li key={index}
        className='flex items-start gap-1.5 text-[11px] text-amber-200'>
        <TriangleAlert size={12} className='mt-0.5 shrink-0' />{warning}</li>)}
    </ul>}
    {stale && <p className='text-[11px] text-amber-200'>
      {proposal.state === 'STALE'
        ? 'The timeline changed after this was planned, so it is no longer safe to apply.'
        : 'That could not be applied against the timeline as it stands now.'}
      {onRegenerate ? ' Regenerate it to re-plan the same request.' : ' Ask again to re-plan it.'}</p>}
    <div className='flex gap-2'>
      <button type='button' disabled={busy || stale} onClick={onApply}
        className='flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-400 px-3 py-1.5 text-xs font-bold text-slate-950 disabled:opacity-40'>
        {busy ? <LoaderCircle size={13} className='animate-spin' /> : <Check size={13} />}
        {busy ? 'Applying…' : 'Apply'}</button>
      {stale && onRegenerate && <button type='button' disabled={busy} onClick={onRegenerate}
        className='flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-amber-300/30 px-3 py-1.5 text-xs font-semibold text-amber-100 disabled:opacity-40'>
        <RefreshCw size={13} />Regenerate proposal</button>}
      <button type='button' disabled={busy} onClick={onCancel}
        className='flex items-center justify-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-300 disabled:opacity-40'>
        <X size={13} />Cancel</button>
    </div>
  </div>;
}
