'use client';

import { useState } from 'react';
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
type AiMode = 'CHAT' | 'REVIEW' | 'BRIEF';

/**
 * The contextual half of the editor: what the selected element is, or the AI
 * editor. Only one is mounted at a time so the panel never becomes the stack of
 * unrelated cards the old workspace was.
 */
export function EditRightPanel({ project, source, selected, style, history, busy,
  selectedElementId, selectedTimeRange, playheadSec, exportOpen,
  onPreview, onCommit, onDebounced, onDuplicate, onDelete,
  onPresetApplied, onChatApplied, onAgentEdited, onReviewPreview, onExportStatus, onExportPhase,
  onError, onCloseExport, initialTab = 'INSPECTOR' }: {
  initialTab?: RightTab;
  project: EditProject;
  source?: EditAsset;
  selected?: EditElement;
  style: EditProjectStyle | null;
  history: EditHistory[];
  busy: boolean;
  selectedElementId: string | null;
  selectedTimeRange: EditTimeRange | null;
  playheadSec: number;
  exportOpen: boolean;
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
  onExportStatus: () => void;
  onExportPhase: (phase: string | null) => void;
  onError: (message: string) => void;
  onCloseExport: () => void;
}) {
  const [tab, setTab] = useState<RightTab>(initialTab);
  const [aiMode, setAiMode] = useState<AiMode>('CHAT');
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
      {tab === 'INSPECTOR'
        ? <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3'>
          <EditInspector project={project} source={source} selected={selected}
            playheadSec={playheadSec}
            onPreview={onPreview} onCommit={onCommit} onDebounced={onDebounced}
            onDuplicate={onDuplicate} onDelete={onDelete} />
          <EditHistoryPanel history={history} />
        </div>
        : <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3'>
          <div role='tablist' aria-label='AI mode' className='grid grid-cols-3 gap-1 rounded-lg bg-black/30 p-1'>
            {([['CHAT', 'Chat'], ['REVIEW', 'Review'], ['BRIEF', 'Edit plan']] as const).map(([value, label]) =>
              <button key={value} role='tab' aria-selected={aiMode === value}
                onClick={() => setAiMode(value)} className={`rounded-md py-1.5 text-[10px] font-semibold ${
                  aiMode === value ? 'bg-violet-400/15 text-violet-200' : 'text-slate-500'}`}>{label}</button>)}
          </div>
          {aiMode === 'CHAT' && <EditAgentPanel projectId={project.id} revision={project.revision} hasSource={!!source}
            disabled={busy} selectedElementId={selectedElementId} selected={selected}
            selectedTimeRange={selectedTimeRange} playheadSec={playheadSec}
            onEdited={onAgentEdited} onError={(message) => onError(`AGENT_FAILED: ${message}`)} />}
          {aiMode === 'REVIEW' && <EditReviewPanel projectId={project.id} revision={project.revision}
            disabled={busy} selected={selected} selectedTimeRange={selectedTimeRange}
            playheadSec={playheadSec} onApplied={onChatApplied}
            onPreviewRange={onReviewPreview} onError={(message) => onError(`ANALYSIS_FAILED: ${message}`)} />}
          {aiMode === 'BRIEF' && <EditBriefPanel projectId={project.id} revision={project.revision}
            disabled={busy} selected={selected} selectedTimeRange={selectedTimeRange}
            playheadSec={playheadSec} onProject={onChatApplied}
            onError={(message) => onError(`PREVIEW_LAYOUT_FAILED: ${message}`)} />}
          {aiMode === 'CHAT' && <EditPresetPanel projectId={project.id} revision={project.revision} style={style}
            disabled={busy} hasSource={!!source} onApplied={onPresetApplied}
            onError={(message) => onError(`PREVIEW_LAYOUT_FAILED: ${message}`)} />
          }</div>}
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
