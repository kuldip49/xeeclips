'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, LoaderCircle, Sparkles, Wand2 } from 'lucide-react';
import { applyEditPreset, listEditPresets, previewEditPreset } from '@/lib/edit-mode-api';
import type {
  EditPresetApplyResult, EditPresetId, EditPresetProposal, EditPresetSummary, EditProjectStyle
} from '@/lib/edit-mode-types';

/**
 * Preset controls. No prompt is asked for: choosing a preset and pressing
 * "Preview changes" is the whole interaction. The proposal is shown in plain
 * language - the generated command list is never exposed here.
 */
export function EditPresetPanel({ projectId, revision, style, disabled, hasSource, onApplied,
  onError }: {
  projectId: string;
  revision: number;
  style: EditProjectStyle | null;
  disabled: boolean;
  hasSource: boolean;
  onApplied: (result: EditPresetApplyResult) => void;
  onError: (message: string) => void;
}) {
  const [presets, setPresets] = useState<EditPresetSummary[]>([]);
  const [presetId, setPresetId] = useState<EditPresetId>(style?.selectedPreset ?? 'SOURCE_MANUAL');
  const [proposal, setProposal] = useState<EditPresetProposal | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);

  useEffect(() => {
    listEditPresets().then(setPresets).catch(() => setPresets([]));
  }, []);

  const selected = presets.find((preset) => preset.id === presetId);
  const active = style?.selectedPreset;
  const locked = disabled || !hasSource || !!busy;

  const preview = async () => {
    setBusy('preview');
    try { setProposal(await previewEditPreset(projectId, revision, presetId)); }
    catch (caught) {
      setProposal(null);
      onError(caught instanceof Error ? caught.message : 'Preset preview failed');
    } finally { setBusy(null); }
  };

  const apply = async () => {
    setBusy('apply');
    try {
      onApplied(await applyEditPreset(projectId, revision, presetId));
      setProposal(null);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Preset apply failed');
    } finally { setBusy(null); }
  };

  return <section className='rounded-2xl border border-violet-300/20 bg-[#0d111c] p-4'>
    <div className='flex items-center gap-2'>
      <Wand2 size={16} className='text-violet-300' />
      <h2 className='text-sm font-semibold'>Preset</h2>
      {active && active === presetId && <span className='ml-auto rounded-full bg-violet-400/10 px-2 py-0.5 text-[10px] font-semibold text-violet-200'>Applied</span>}
    </div>

    <label className='mt-3 block text-[10px] text-slate-500'>Preset
      <select value={presetId} disabled={locked}
        onChange={(event) => { setPresetId(event.target.value as EditPresetId); setProposal(null); }}
        className='mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-2 text-xs text-slate-100 disabled:opacity-40'>
        {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.displayName}</option>)}
      </select>
    </label>
    {selected && <p className='mt-2 text-[11px] leading-relaxed text-slate-400'>{selected.description}</p>}
    {!hasSource && <p className='mt-2 text-[11px] text-amber-200'>Attach a source video to use presets.</p>}

    <div className='mt-3 flex gap-2'>
      <button onClick={() => void preview()} disabled={locked}
        className='flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-white/10 px-3 py-2 text-xs font-semibold disabled:opacity-40'>
        {busy === 'preview' ? <LoaderCircle size={13} className='animate-spin' /> : <Sparkles size={13} />}
        Preview changes
      </button>
      <button onClick={() => void apply()} disabled={locked || !proposal}
        className='flex flex-1 items-center justify-center rounded-xl bg-violet-400 px-3 py-2 text-xs font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40'>
        {busy === 'apply' ? <LoaderCircle size={13} className='animate-spin' /> : 'Apply'}
      </button>
    </div>

    {proposal && <div className='mt-4 grid gap-3 rounded-xl border border-white/10 bg-black/30 p-3'>
      <div>
        <p className='text-xs font-semibold text-slate-100'>{proposal.displayName}</p>
        <p className='mt-1 text-[11px] leading-relaxed text-slate-400'>{proposal.summary}</p>
      </div>
      <div>
        <p className='text-[10px] font-semibold uppercase tracking-wider text-slate-500'>Planned changes</p>
        <ul className='mt-1 grid gap-1'>{proposal.plannedChanges.map((change, index) =>
          <li key={index} className='text-[11px] leading-relaxed text-slate-300'>· {change}</li>)}
        </ul>
      </div>
      {proposal.warnings.length > 0 && <div>
        <p className='flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-amber-300'>
          <AlertTriangle size={11} />Notes
        </p>
        <ul className='mt-1 grid gap-1'>{proposal.warnings.map((warning, index) =>
          <li key={index} className='text-[11px] leading-relaxed text-amber-200/80'>· {warning}</li>)}
        </ul>
      </div>}
      <div className='flex gap-2'>
        <button onClick={() => void apply()} disabled={locked}
          className='flex-1 rounded-lg bg-violet-400 px-3 py-1.5 text-[11px] font-bold text-slate-950 disabled:opacity-40'>Apply</button>
        <button onClick={() => setProposal(null)} disabled={!!busy}
          className='flex-1 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] font-semibold disabled:opacity-40'>Cancel</button>
      </div>
    </div>}

    {style && <dl className='mt-4 grid gap-1 border-t border-white/5 pt-3'>
      {([['Aspect', style.aspectRatio], ['Subtitles', style.subtitlePolicy],
        ['Framing', style.reframePolicy], ['Zoom', style.zoomPolicy],
        ['Grading', style.gradingPolicy], ['Music', style.musicPolicy],
        ['Hook', style.hookText ?? style.hookPolicy]] as const).map(([label, value]) =>
        <div key={label} className='flex justify-between gap-3 text-[10px]'>
          <dt className='text-slate-600'>{label}</dt>
          <dd className='truncate text-right text-slate-400'>{String(value)}</dd>
        </div>)}
    </dl>}
  </section>;
}
