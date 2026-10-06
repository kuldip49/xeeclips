'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, CornerDownLeft, Crosshair, LoaderCircle, Pencil, RefreshCw,
  Sparkles, TriangleAlert, X } from 'lucide-react';
import {
  applyEditChat, cancelEditChat, EditModeApiError, getEditChatThread, planEditChat
} from '@/lib/edit-mode-api';
import { changeAction, changeRows, CHAT_SUGGESTIONS, contextLine } from '@/lib/edit-mode-chat';
import type { ChatApplyResult, ChatMessage, ChatProposal, EditElement,
  EditTimeRange } from '@/lib/edit-mode-types';

/**
 * The AI editor panel.
 *
 * Every turn is proposal-first: the assistant shows exactly what it would
 * change - "Music 20% -> 14%", the current hook beside the proposed one - and
 * waits. Nothing is applied until Apply is pressed, and the raw commands are
 * never shown or sent from here: the browser only ever holds a proposal id.
 */
export function EditChatPanel({ projectId, revision, hasSource, disabled, selectedElementId,
  selected, selectedTimeRange, playheadSec, onApplied, onError }: {
  projectId: string;
  revision: number;
  hasSource: boolean;
  disabled: boolean;
  selectedElementId: string | null;
  selected?: EditElement;
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
  const composer = useRef<HTMLTextAreaElement>(null);

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

  const cancel = useCallback(async (quiet = false) => {
    if (!proposal) return;
    const pending = proposal;
    setProposal(null);
    try {
      const result = await cancelEditChat(projectId, pending.proposalId);
      if (!quiet) setMessages(result.messages);
    } catch { /* cancelling is local-safe: nothing was applied either way */ }
  }, [projectId, proposal]);

  /** "Change": another version of written wording, or hand the request back. */
  const change = useCallback(async () => {
    if (!proposal || busy) return;
    const next = changeAction(proposal);
    await cancel(true);
    if (next.kind === 'ANOTHER') { void send(next.message); return; }
    setDraft(next.draft);
    composer.current?.focus();
  }, [busy, cancel, proposal, send]);

  const idle = !busy && !disabled && hasSource;

  return <section className='grid content-start gap-3 rounded-2xl border border-border bg-tint p-4'>
    <header className='flex items-center gap-2'>
      <Sparkles size={15} className='text-primary-soft' />
      <h2 className='text-sm font-bold tracking-tight'>AI Editor</h2>
      <span className='ml-auto text-[11px] text-faint'>Proposes, never auto-applies</span>
    </header>

    <div ref={scroller} className='grid max-h-[320px] content-start gap-2 overflow-y-auto pr-1'>
      {!loaded && <p className='text-xs text-faint'>Loading conversation…</p>}
      {loaded && !messages.length && <p className='text-xs leading-relaxed text-muted-foreground'>
        Tell me what to change in your own words - &ldquo;the music is too loud&rdquo;, &ldquo;move
        my logo down&rdquo; - and I&apos;ll show you the edit before anything happens.
      </p>}
      {messages.map((message) => <ChatBubble key={message.id} message={message} />)}
      {busy === 'planning' && <p className='flex items-center gap-2 text-xs text-muted-foreground'>
        <LoaderCircle size={12} className='animate-spin' />Planning…</p>}
    </div>

    {proposal && <ProposalCard proposal={proposal} busy={busy === 'applying'}
      onApply={() => void apply()} onCancel={() => void cancel()} onChange={() => void change()}
      onRegenerate={lastInstruction ? () => void send(lastInstruction) : undefined} />}

    {/* What "this", "it" and "here" will mean for the next message. */}
    <p data-testid='chat-context' className='flex items-start gap-1.5 text-[11px] text-faint'>
      <Crosshair size={12} className='mt-0.5 shrink-0 text-faint' />
      <span>AI sees: {contextLine({ selected, range: selectedTimeRange, playheadSec })}</span>
    </p>

    {loaded && !messages.length && <div className='flex flex-wrap gap-1.5'>
      {CHAT_SUGGESTIONS.map((suggestion) => <button key={suggestion} type='button' disabled={!idle}
        onClick={() => setDraft(suggestion)}
        className='rounded-full border border-border px-2.5 py-1 text-[11px] text-soft transition hover:border-primary/40 hover:text-foreground disabled:opacity-40'>
        {suggestion}</button>)}
    </div>}

    <div className='grid gap-2'>
      <textarea ref={composer} value={draft} rows={2} disabled={!idle}
        aria-label='Tell the AI editor what to change'
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
        }}
        placeholder={hasSource ? 'e.g. "make the hook shorter and lower the music"'
          : 'Attach a source video first'}
        className='w-full resize-none rounded-xl border border-border bg-background/60 px-3 py-2 text-xs text-foreground placeholder:text-faint focus:border-primary/40 focus:outline-none disabled:opacity-40' />
      <button type='button' disabled={!idle || !draft.trim()} onClick={() => void send()}
        className='flex items-center justify-center gap-2 rounded-xl btn-primary px-3 py-2 text-xs font-bold text-primary-foreground transition disabled:cursor-not-allowed disabled:opacity-40'>
        {busy === 'planning' ? <LoaderCircle size={14} className='animate-spin' />
          : <CornerDownLeft size={14} />}
        {busy === 'planning' ? 'Planning…' : 'Plan the edit'}</button>
    </div>
  </section>;
}

function ChatBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'USER') {
    return <p className='ml-6 rounded-xl rounded-br-sm bg-primary/15 px-3 py-2 text-xs text-foreground'>
      {message.text}</p>;
  }
  if (message.role === 'SYSTEM_STATUS') {
    const failed = message.state === 'FAILED' || message.state === 'STALE';
    return <p className={`flex items-start gap-1.5 text-[11px] ${
      failed ? 'text-warning-soft' : 'text-faint'}`}>
      {failed ? <TriangleAlert size={12} className='mt-0.5 shrink-0' />
        : <Check size={12} className='mt-0.5 shrink-0 text-success' />}
      {message.text}</p>;
  }
  return <div className='mr-6 grid gap-1 rounded-xl rounded-bl-sm border border-border px-3 py-2'>
    <p className='text-xs text-soft'>{message.text}</p>
    {!!message.plannedChanges?.length && <ul className='grid gap-0.5 text-[11px] text-muted-foreground'>
      {message.plannedChanges.slice(0, 6).map((line, index) => <li key={index}>· {line}</li>)}
    </ul>}
  </div>;
}

/**
 * The decision point: what is there now, what it would become. Plain values
 * only - no command JSON, no handles, no ids.
 */
export function ProposalCard({ proposal, busy, onApply, onCancel, onChange, onRegenerate }: {
  proposal: ChatProposal; busy: boolean; onApply: () => void; onCancel: () => void;
  onChange: () => void; onRegenerate?: () => void;
}) {
  const stale = proposal.state === 'STALE' || proposal.state === 'FAILED';
  const rows = changeRows(proposal);
  const creative = proposal.route === 'CREATIVE_LLM' || proposal.route === 'CREATIVE_DETERMINISTIC';
  return <div data-testid='chat-proposal'
    className='grid gap-2 rounded-xl border border-primary/25 bg-primary/5 p-3'>
    <p className='text-xs font-semibold text-foreground'>{proposal.summary}</p>
    {rows.length ? <dl className='grid gap-2'>
      {rows.map((row, index) => row.wording
        ? <div key={index} className='grid gap-1 text-[11px]'>
          <dt className='font-semibold uppercase tracking-[.12em] text-primary-soft'>{row.label}</dt>
          <dd className='grid gap-1'>
            <span className='rounded-md bg-inset px-2 py-1 text-muted-foreground'>
              <span className='mr-1 text-[10px] uppercase tracking-wider text-faint'>Current</span>
              {row.before}</span>
            <span className='rounded-md bg-primary/10 px-2 py-1 text-foreground'>
              <span className='mr-1 text-[10px] uppercase tracking-wider text-primary-soft'>Proposed</span>
              {row.after}</span>
          </dd>
        </div>
        : <div key={index} className='flex items-center gap-2 text-xs'>
          <dt className='min-w-0 flex-1 truncate text-soft'>{row.label}</dt>
          <dd className='flex shrink-0 items-center gap-1.5 tabular-nums'>
            <span className='text-faint'>{row.before}</span>
            <ArrowRight size={11} className='text-primary-soft' />
            <span className='font-semibold text-foreground'>{row.after}</span>
          </dd>
        </div>)}
    </dl>
      : <ul className='grid gap-1 text-xs text-soft'>
        {proposal.plannedChanges.map((line, index) => <li key={index} className='flex gap-1.5'>
          <span className='text-primary-soft'>·</span>{line}</li>)}
      </ul>}
    {!!proposal.warnings.length && <ul className='grid gap-1'>
      {proposal.warnings.map((warning, index) => <li key={index}
        className='flex items-start gap-1.5 text-[11px] text-warning-soft'>
        <TriangleAlert size={12} className='mt-0.5 shrink-0' />{warning}</li>)}
    </ul>}
    {stale && <p className='text-[11px] text-warning-soft'>
      {proposal.state === 'STALE'
        ? 'The timeline changed after this was planned, so it is no longer safe to apply.'
        : 'That could not be applied against the timeline as it stands now.'}
      {onRegenerate ? ' Regenerate it to re-plan the same request.' : ' Ask again to re-plan it.'}</p>}
    <div className='flex gap-2'>
      <button type='button' disabled={busy || stale} onClick={onApply}
        className='flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-success px-3 py-1.5 text-xs font-bold text-success-foreground disabled:opacity-40'>
        {busy ? <LoaderCircle size={13} className='animate-spin' /> : <Check size={13} />}
        {busy ? 'Applying…' : 'Apply'}</button>
      {stale && onRegenerate
        ? <button type='button' disabled={busy} onClick={onRegenerate}
          className='flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-warning/30 px-3 py-1.5 text-xs font-semibold text-warning-soft disabled:opacity-40'>
          <RefreshCw size={13} />Regenerate</button>
        : <button type='button' disabled={busy} onClick={onChange}
          title={creative ? 'Suggest a different version' : 'Edit the request'}
          className='flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-soft disabled:opacity-40'>
          {creative ? <RefreshCw size={13} /> : <Pencil size={13} />}Change</button>}
      <button type='button' disabled={busy} onClick={onCancel}
        className='flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-soft disabled:opacity-40'>
        <X size={13} />Cancel</button>
    </div>
  </div>;
}
