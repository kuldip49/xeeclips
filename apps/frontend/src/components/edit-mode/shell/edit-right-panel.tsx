'use client';

import { useEffect, useState } from 'react';
import type { ManualEditCommand } from '@/lib/edit-mode-api';
import type { AgentRun, ChatApplyResult, EditAsset, EditElement, EditHistory, EditPresetApplyResult,
  EditProject, EditProjectStyle, EditTimeRange } from '@/lib/edit-mode-types';
import { EditAgentPanel } from '../edit-agent-panel';
import { EditReviewPanel } from '../edit-review-panel';
import { EditBriefPanel } from '../edit-brief-panel';
import { EditExportPanel } from '../edit-export-panel';
import { EditHistoryPanel } from '../edit-history-panel';
import { EditInspector } from '../edit-inspector';
import { EditPresetPanel } from '../edit-preset-panel';

export type RightTab = 'INSPECTOR' | 'AI';
export type AiMode = 'CHAT' | 'REVIEW' | 'BRIEF';
const ASK_AI_CONSENT_KEY = 'xeeclip-ask-ai-consent-v1';
const ASK_AI_DISCLOSURE = 'Ask AI uses an AI service to understand your request and relevant clip content.';

export type EditPanelContentProps = {
  project: EditProject;
  source?: EditAsset;
  selected?: EditElement;
  style: EditProjectStyle | null;
  history: EditHistory[];
  busy: boolean;
  selectedElementId: string | null;
  selectedTimeRange: EditTimeRange | null;
  playheadSec: number;
  onPreview: (element: EditElement) => void;
  onCommit: (command: ManualEditCommand) => void;
  onDebounced: (command: ManualEditCommand) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onPresetApplied: (result: EditPresetApplyResult) => void;
  onChatApplied: (result: ChatApplyResult) => void;
  /** The AI editor agent changed the canonical project. */
  onAgentEdited: (run: AgentRun) => void;
  onReviewPreview: (range: EditTimeRange) => void;
  onError: (message: string) => void;
};

/** What the selected element is, plus the project's history. */
export function EditInspectorContent({ project, source, selected, history, playheadSec,
  onPreview, onCommit, onDebounced, onDuplicate, onDelete }: EditPanelContentProps) {
  return <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3'>
    <EditInspector project={project} source={source} selected={selected}
      playheadSec={playheadSec}
      onPreview={onPreview} onCommit={onCommit} onDebounced={onDebounced}
      onDuplicate={onDuplicate} onDelete={onDelete} />
    <EditHistoryPanel history={history} />
  </div>;
}

/**
 * The AI editor: Chat, Review and Edit plan. `layout='sheet'` is the phone drawer: the chat
 * fills the drawer with its input pinned at the bottom, and looks move to the Style tool.
 */
export function EditAiContent({ project, source, selected, style, busy, selectedElementId,
  selectedTimeRange, playheadSec, onPresetApplied, onChatApplied, onAgentEdited, onReviewPreview,
  onError, layout = 'panel', mode, onModeChange }: EditPanelContentProps & { layout?: 'panel' | 'sheet';
  /** Optional controlled mode, so a parent can keep it across tab switches. */
  mode?: AiMode; onModeChange?: (mode: AiMode) => void }) {
  const [ownMode, setOwnMode] = useState<AiMode>('CHAT');
  const [consent, setConsent] = useState<'loading' | 'needed' | 'declined' | 'granted'>('loading');
  useEffect(() => {
    try { setConsent(localStorage.getItem(ASK_AI_CONSENT_KEY) === 'allowed' ? 'granted' : 'needed'); }
    catch { setConsent('needed'); }
  }, []);
  const aiMode = mode ?? ownMode;
  const setAiMode = (next: AiMode) => { setOwnMode(next); onModeChange?.(next); };
  const sheet = layout === 'sheet';
  if (consent !== 'granted') return <section className='grid content-start gap-4 rounded-2xl border border-white/10 bg-[#111827] p-4 sm:p-5'>
    <h2 className='text-lg font-semibold'>Ask AI</h2>
    <p className='text-sm leading-6 text-slate-300'>{ASK_AI_DISCLOSURE}</p>
    {consent === 'declined' ? <p className='text-sm text-slate-400'>Ask AI is off. You can keep editing manually.</p>
      : <p className='text-sm text-slate-300'>Allow Ask AI to process your prompt and relevant clip content?</p>}
    <div className='flex flex-wrap gap-2'>
      {consent === 'declined' ? <button type='button' onClick={() => setConsent('needed')}
        className='h-10 rounded-xl bg-violet-500 px-4 text-sm font-semibold'>Enable Ask AI</button> : <>
        <button type='button' onClick={() => setConsent('declined')}
          className='h-10 rounded-xl border border-white/10 px-4 text-sm'>Cancel</button>
        <button type='button' onClick={() => { try { localStorage.setItem(ASK_AI_CONSENT_KEY, 'allowed'); }
          catch { /* Keep consent for this open editor only when storage is unavailable. */ }
          setConsent('granted'); }} className='h-10 rounded-xl bg-violet-500 px-4 text-sm font-semibold'>Allow Ask AI</button>
      </>}
    </div>
  </section>;
  const tabs = <div role='tablist' aria-label='AI mode' className={`grid shrink-0 grid-cols-3 gap-1 rounded-lg bg-black/30 p-1 ${sheet ? 'rounded-xl' : ''}`}>
    {([['CHAT', 'Chat'], ['REVIEW', 'Review'], ['BRIEF', 'Edit plan']] as const).map(([value, label]) =>
      <button key={value} role='tab' aria-selected={aiMode === value}
        onClick={() => setAiMode(value)} className={`rounded-md font-semibold ${sheet ? 'h-10 rounded-lg text-xs' : 'py-1.5 text-[10px]'} ${
          aiMode === value ? 'bg-violet-400/15 text-violet-200' : 'text-slate-500'}`}>{label}</button>)}
  </div>;
  const chat = <EditAgentPanel projectId={project.id} revision={project.revision} hasSource={!!source}
    disabled={busy} selectedElementId={selectedElementId} selected={selected}
    selectedTimeRange={selectedTimeRange} playheadSec={playheadSec} layout={layout}
    onEdited={onAgentEdited} onError={(message) => onError(`AGENT_FAILED: ${message}`)} />;
  const review = <EditReviewPanel projectId={project.id} revision={project.revision}
    disabled={busy} selected={selected} selectedTimeRange={selectedTimeRange}
    playheadSec={playheadSec} onApplied={onChatApplied}
    onPreviewRange={onReviewPreview} onError={(message) => onError(`ANALYSIS_FAILED: ${message}`)} />;
  const brief = <EditBriefPanel projectId={project.id} revision={project.revision}
    disabled={busy} selected={selected} selectedTimeRange={selectedTimeRange}
    playheadSec={playheadSec} onProject={onChatApplied}
    onError={(message) => onError(`PREVIEW_LAYOUT_FAILED: ${message}`)} />;
  if (sheet) return <div className='flex h-full min-h-0 min-w-0 flex-col gap-3'>
    <p className='text-xs leading-5 text-slate-400'>{ASK_AI_DISCLOSURE}</p>
    {tabs}
    {aiMode === 'CHAT' ? <div className='flex min-h-0 flex-1 flex-col'>{chat}</div>
      : <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(.75rem,var(--safe-bottom))]'>{aiMode === 'REVIEW' ? review : brief}</div>}
  </div>;
  return <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3'>
    <p className='text-xs leading-5 text-slate-400'>{ASK_AI_DISCLOSURE}</p>
    {tabs}
    {aiMode === 'CHAT' && chat}
    {aiMode === 'REVIEW' && review}
    {aiMode === 'BRIEF' && brief}
    {aiMode === 'CHAT' && <EditPresetPanel projectId={project.id} revision={project.revision} style={style}
      disabled={busy} hasSource={!!source} onApplied={onPresetApplied}
      onError={(message) => onError(`PREVIEW_LAYOUT_FAILED: ${message}`)} />}
  </div>;
}

/**
 * The contextual half of the editor: what the selected element is, or the AI
 * editor. Only one is mounted at a time so the panel never becomes the stack of
 * unrelated cards the old workspace was.
 */
export function EditRightPanel({ exportOpen, onExportStatus, onExportPhase, onCloseExport,
  initialTab = 'INSPECTOR', ...content }: EditPanelContentProps & {
  initialTab?: RightTab;
  exportOpen: boolean;
  onExportStatus: () => void;
  onExportPhase: (phase: string | null) => void;
  onCloseExport: () => void;
}) {
  const [tab, setTab] = useState<RightTab>(initialTab);
  const [aiMode, setAiMode] = useState<AiMode>('CHAT');
  const { project, source, busy } = content;
  const tabClass = (value: RightTab) =>
    `flex-1 rounded-md py-1.5 text-[11px] font-semibold transition-colors ${
      tab === value ? 'bg-white/15 text-white' : 'text-slate-400 hover:text-slate-200'}`;
  return <aside aria-label='Inspector and AI editor'
    className='hidden w-[320px] shrink-0 flex-col border-l border-white/10 bg-[#0b0f1a] md:flex'>
    <div className='shrink-0 border-b border-white/10 p-2'>
      <div role='tablist' aria-label='Right panel' className='flex gap-1 rounded-lg bg-black/30 p-0.5'>
        <button role='tab' aria-selected={tab === 'INSPECTOR'} className={tabClass('INSPECTOR')}
          onClick={() => setTab('INSPECTOR')}>Inspector</button>
        <button role='tab' aria-selected={tab === 'AI'} className={tabClass('AI')}
          onClick={() => setTab('AI')}>AI Editor</button>
      </div>
    </div>
    <div className='min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-3'>
      {tab === 'INSPECTOR' ? <EditInspectorContent {...content} /> : <EditAiContent {...content} mode={aiMode} onModeChange={setAiMode} />}
      {exportOpen && <div className='mt-3'>
        <EditExportPanel projectId={project.id} revision={project.revision} hasSource={!!source}
          disabled={busy} onStatusChange={onExportStatus} onPhaseChange={onExportPhase} />
        <button onClick={onCloseExport}
          className='mt-2 w-full rounded-lg border border-white/10 py-1.5 text-[11px] text-slate-400 hover:bg-white/5'>
          Hide export</button>
      </div>}
    </div>
  </aside>;
}
