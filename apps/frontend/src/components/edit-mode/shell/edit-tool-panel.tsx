'use client';

import { useRef } from 'react';
import { FileAudio, FileImage, Plus, Trash2, X } from 'lucide-react';
import { editTool, type EditToolId } from '@/lib/edit-mode-tools';
import type { CropAspectPreset } from '@/lib/edit-mode-crop';
import type { ManualEditCommand } from '@/lib/edit-mode-api';
import type { EditAsset, EditElement } from '@/lib/edit-mode-types';
import { EditAssetPicker } from '../edit-asset-picker';
import { EditAdjustPanel } from './edit-adjust-panel';
import { EditAudioPanel } from './edit-audio-panel';
import { EditCaptionsPanel } from './edit-captions-panel';
import { EditCropPanel, type CropSession } from './edit-crop-panel';
import { EditFiltersPanel } from './edit-filters-panel';
import { EditTemplatesPanel } from './edit-templates-panel';
import { EditSavedStyles } from './edit-saved-styles';
import { EditTextPanel } from './edit-text-panel';
import type { TemplateApplyResult } from '@/lib/edit-mode-templates';

const ACCEPT = {
  IMAGE: '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp',
  LOGO: '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp',
  AUDIO: '.mp3,.wav,.m4a,.aac,audio/*'
} as const;

type UploadRole = keyof typeof ACCEPT;

/** Upload + library list for one asset role, shared by the Audio and Overlay panels. */
function AssetSection({ role, label, assets, busy, disabled, onUpload, onAdd, onDelete }: {
  role: UploadRole; label: string; assets: EditAsset[]; busy: boolean; disabled: boolean;
  onUpload: (role: UploadRole, file: File) => void;
  onAdd: (asset: EditAsset) => void; onDelete: (asset: EditAsset) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const list = assets.filter((asset) => asset.role === role);
  return <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2'>
    <input ref={input} className='hidden' type='file' accept={ACCEPT[role]}
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) onUpload(role, file);
        event.target.value = '';
      }} />
    <button disabled={busy || disabled} onClick={() => input.current?.click()}
      className='flex items-center justify-center gap-1.5 rounded-lg border border-white/10 py-2 text-[11px] font-medium text-slate-200 hover:bg-white/5 disabled:opacity-30'>
      <Plus size={12} />{label}
    </button>
    {list.map((asset) => <div key={asset.id} className='min-w-0 rounded-lg bg-white/[.035] p-2'>
      <div className='flex items-center gap-2'>
        {role === 'AUDIO' ? <FileAudio size={13} className='shrink-0 text-emerald-300' />
          : <FileImage size={13} className='shrink-0 text-cyan-300' />}
        <span className='min-w-0 flex-1 truncate text-[11px]'>{asset.originalName}</span>
        <button aria-label={`Delete ${asset.originalName}`} disabled={busy}
          onClick={() => onDelete(asset)} className='p-0.5 text-slate-500 hover:text-red-300'>
          <Trash2 size={11} /></button>
      </div>
      <button disabled={busy || disabled} onClick={() => onAdd(asset)}
        className='mt-1.5 w-full rounded-md bg-white/[.06] py-1 text-[10px] font-semibold hover:bg-white/10 disabled:opacity-30'>
        Add to timeline</button>
    </div>)}
  </div>;
}

export type EditToolPanelProps = {
  tool: EditToolId;
  assets: EditAsset[];
  elements: EditElement[];
  busy: boolean;
  hasSource: boolean;
  projectId: string;
  revision: number;
  selectedElementId: string | null;
  playheadSec: number;
  /** False when the source has no cached transcript word timings, in which case
   * the Audio panel says ducking is unavailable rather than offering it. */
  duckingAvailable: boolean;
  copiedAdjustmentsId: string | null;
  onClose: () => void;
  onSelectElement: (id: string) => void;
  /** Every panel edit is one canonical command; no panel keeps its own state. */
  onCommand: (command: ManualEditCommand) => void;
  /** A local, uncommitted element patch: what a slider writes while dragging. */
  onPreviewElement: (element: EditElement) => void;
  cropSession: CropSession | null;
  onCropPreset: (preset: CropAspectPreset) => void;
  onCropZoom: (zoom: number) => void;
  onCropReset: () => void;
  onCropApplyAll: (checked: boolean) => void;
  onCropCancel: () => void;
  onCropDone: () => void;
  onCopyAdjustments: (elementId: string | null) => void;
  onUploadSource: (file: File) => Promise<void>;
  onImportSource: (videoId: string) => Promise<void>;
  onUploadAsset: (role: UploadRole, file: File) => void;
  onAddAsset: (asset: EditAsset) => void;
  onDeleteAsset: (asset: EditAsset) => void;
  /** One applied template is one server revision, accepted exactly like a preset. */
  onTemplateApplied: (result: TemplateApplyResult) => void;
  onError: (message: string) => void;
  /** Phone drawer: the crop controls use their compact dock layout. */
  compact?: boolean;
};

/** The desktop left panel: a titled column beside the rail. */
export function EditToolPanel(props: EditToolPanelProps) {
  const definition = editTool(props.tool);
  return <aside aria-label={`${definition.label} panel`}
    className='flex w-[268px] shrink-0 flex-col border-r border-white/10 bg-[#0b0f1a] max-md:hidden max-lg:absolute max-lg:bottom-0 max-lg:left-[72px] max-lg:top-0 max-lg:z-30'>
    <div className='flex h-10 shrink-0 items-center justify-between border-b border-white/10 px-3'>
      <h2 className='text-xs font-semibold uppercase tracking-wider text-slate-300'>{definition.label}</h2>
      <button onClick={props.onClose} aria-label={`Close ${definition.label} panel`}
        className='rounded p-1 text-slate-500 hover:bg-white/10 hover:text-slate-200'><X size={14} /></button>
    </div>
    <div className='min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-3'>
      <EditToolPanelBody {...props} />
    </div>
  </aside>;
}

/** A tool's controls without any chrome, shared by the desktop panel and the phone drawer. */
export function EditToolPanelBody({ tool, assets, elements, busy, hasSource, selectedElementId,
  playheadSec, duckingAvailable, copiedAdjustmentsId, projectId, revision,
  onSelectElement, onCommand, onPreviewElement, cropSession, onCropPreset,
  onCropZoom, onCropReset, onCropApplyAll, onCropCancel, onCropDone,
  onCopyAdjustments, onUploadSource,
  onImportSource, onUploadAsset, onAddAsset, onDeleteAsset, onTemplateApplied, onError,
  compact = false }: EditToolPanelProps) {
  const source = assets.find((asset) => asset.role === 'SOURCE');
  const selected = elements.find((element) => element.id === selectedElementId);
  return <>
      {tool === 'MEDIA' && <EditAssetPicker assets={assets} busy={busy} onUploadSource={onUploadSource}
        onImport={onImportSource} onUploadAsset={async (role, file) => onUploadAsset(role, file)}
        onAdd={onAddAsset} onDelete={onDeleteAsset} />}

      {tool === 'TEMPLATES' && <EditTemplatesPanel projectId={projectId} revision={revision}
        busy={busy} hasSource={hasSource}
        hasLogo={elements.some((element) => element.type === 'IMAGE' &&
          String(element.properties.role ?? '') === 'LOGO')}
        hasMusic={elements.some((element) => element.type === 'AUDIO')}
        onApplied={onTemplateApplied} onError={onError} />}
      {tool === 'TEMPLATES' && hasSource && <EditSavedStyles projectId={projectId} busy={busy}
        hasCaptions={elements.some((element) => element.type === 'SUBTITLE')} />}

      {tool === 'AUDIO' && <EditAudioPanel assets={assets} elements={elements} busy={busy}
        hasSource={hasSource} selectedElementId={selectedElementId}
        duckingAvailable={duckingAvailable} onCommand={onCommand}
        onPreviewElement={onPreviewElement} onSelectElement={onSelectElement}
        onUpload={(file) => onUploadAsset('AUDIO', file)} onAdd={onAddAsset}
        onDelete={onDeleteAsset} />}

      {tool === 'ADJUST' && <EditAdjustPanel selected={selected} busy={busy}
        onPreview={onPreviewElement} onCommand={onCommand}
        copied={copiedAdjustmentsId} onCopy={onCopyAdjustments} />}

      {tool === 'FILTERS' && <EditFiltersPanel selected={selected} busy={busy}
        onCommand={onCommand} />}

      {tool === 'TEXT' && <EditTextPanel elements={elements} busy={busy} hasSource={hasSource}
        selectedElementId={selectedElementId} onCommand={onCommand}
        onSelectElement={onSelectElement} />}

      {tool === 'CAPTIONS' && <EditCaptionsPanel elements={elements} source={source} busy={busy}
        hasSource={hasSource} selectedElementId={selectedElementId} playheadSec={playheadSec}
        onCommand={onCommand} onSelectElement={onSelectElement} />}

      {tool === 'CROP' && <EditCropPanel session={cropSession} busy={busy} compact={compact}
        onPreset={onCropPreset} onZoom={onCropZoom} onReset={onCropReset} onApplyAll={onCropApplyAll}
        onCancel={onCropCancel} onDone={onCropDone} />}

      {tool === 'OVERLAY' && <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4'>
        <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2'>
          <p className='text-[10px] font-semibold uppercase tracking-wider text-slate-500'>Logo</p>
          <AssetSection role='LOGO' label='Upload logo' assets={assets} busy={busy}
            disabled={!hasSource} onUpload={onUploadAsset} onAdd={onAddAsset} onDelete={onDeleteAsset} />
        </div>
        <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2'>
          <p className='text-[10px] font-semibold uppercase tracking-wider text-slate-500'>Images</p>
          <AssetSection role='IMAGE' label='Upload image' assets={assets} busy={busy}
            disabled={!hasSource} onUpload={onUploadAsset} onAdd={onAddAsset} onDelete={onDeleteAsset} />
        </div>
      </div>}
  </>;
}
