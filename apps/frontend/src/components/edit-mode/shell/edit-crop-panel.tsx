'use client';

import { Check, Crop, Minus, Plus, RotateCcw, X } from 'lucide-react';
import { cropZoom, CROP_ASPECT_PRESETS, type CropAspectPreset,
  type CropRect } from '@/lib/edit-mode-crop';

export type CropSession = {
  elementId: string;
  sourceAssetId?: string;
  rect: CropRect;
  preset: CropAspectPreset;
  sourceAspect: number;
  sourceWidth: number;
  sourceHeight: number;
  applyAll: boolean;
  applyAllCompatible: boolean;
};

const label = (preset: CropAspectPreset) => preset === 'FREE' ? 'Free / Custom'
  : preset === 'ORIGINAL' ? 'Original' : preset;
const choice = (active: boolean) => `rounded-lg border px-2 py-2 text-[11px] font-semibold transition-colors ${
  active ? 'border-violet-300/60 bg-violet-400/20 text-violet-50'
    : 'border-white/10 bg-white/[.025] text-slate-400 hover:bg-white/[.06] hover:text-slate-200'}`;

export function EditCropPanel({ session, busy, onPreset, onZoom, onReset, onApplyAll, onCancel, onDone }: {
  session: CropSession | null;
  busy: boolean;
  onPreset: (preset: CropAspectPreset) => void;
  onZoom: (zoom: number) => void;
  onReset: () => void;
  onApplyAll: (checked: boolean) => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  if (!session) return <div role='status' className='rounded-xl border border-amber-300/20 bg-amber-300/5 p-3 text-xs text-amber-200'>
    Select a video segment to open the crop editor.
  </div>;
  const { rect } = session;
  const zoom = cropZoom(rect, session.preset, session.sourceAspect);
  return <div className='grid gap-5'>
    <div className='rounded-xl border border-violet-300/20 bg-violet-400/[.05] p-3'>
      <div className='flex items-center gap-2 text-violet-100'><Crop size={15} />
        <p className='text-xs font-semibold'>Manual crop</p></div>
      <p className='mt-1.5 text-[10px] leading-relaxed text-slate-400'>Drag the video under the frame to reposition it. Use Zoom or the mouse wheel for precise framing. Drag a corner to resize the source crop.</p>
    </div>

    <fieldset disabled={busy} className='grid gap-2 disabled:opacity-40'>
      <legend className='mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500'>Aspect lock</legend>
      <div className='grid grid-cols-2 gap-2' role='group' aria-label='Crop aspect ratio'>
        {CROP_ASPECT_PRESETS.map((preset) => <button key={preset} type='button'
          aria-pressed={session.preset === preset} className={choice(session.preset === preset)}
          onClick={() => onPreset(preset)}>{label(preset)}</button>)}
      </div>
    </fieldset>

    <div className='grid gap-2 rounded-lg border border-white/10 bg-black/20 p-3'>
      <div className='flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-slate-400'>
        <span>Zoom</span><span className='tabular-nums text-violet-200'>{zoom.toFixed(2)}×</span>
      </div>
      <div className='flex items-center gap-2'>
        <Minus size={13} className='text-slate-500' />
        <input aria-label='Crop zoom' type='range' min={1} max={4} step={0.01}
          value={zoom} disabled={busy} onChange={(event) => onZoom(Number(event.target.value))}
          className='h-1 flex-1 accent-violet-400 disabled:opacity-40' />
        <Plus size={13} className='text-slate-500' />
      </div>
    </div>

    <div className='grid grid-cols-2 gap-2 rounded-lg border border-white/10 bg-black/20 p-2 text-[10px] tabular-nums text-slate-400'>
      <span>X {(rect.x * 100).toFixed(1)}%</span><span>Y {(rect.y * 100).toFixed(1)}%</span>
      <span>W {(rect.width * 100).toFixed(1)}%</span><span>H {(rect.height * 100).toFixed(1)}%</span>
    </div>

    <label className={`flex items-start gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs ${
      session.applyAllCompatible ? 'text-slate-300' : 'text-slate-600'}`}>
      <input type='checkbox' className='mt-0.5' checked={session.applyAll}
        disabled={busy || !session.applyAllCompatible}
        onChange={(event) => onApplyAll(event.target.checked)} />
      <span>Apply this crop to all video segments
        {!session.applyAllCompatible && <small className='mt-1 block text-[9px] text-amber-300/75'>Unavailable because segment source dimensions differ.</small>}
      </span>
    </label>

    <div className='grid grid-cols-3 gap-2'>
      <button type='button' disabled={busy} onClick={onCancel}
        className='flex items-center justify-center gap-1 rounded-lg border border-white/10 px-2 py-2 text-[11px] font-semibold text-slate-300 hover:bg-white/5 disabled:opacity-40'>
        <X size={12} />Cancel</button>
      <button type='button' disabled={busy} onClick={onReset}
        className='flex items-center justify-center gap-1 rounded-lg border border-white/10 px-2 py-2 text-[11px] font-semibold text-slate-300 hover:bg-white/5 disabled:opacity-40'>
        <RotateCcw size={12} />Reset</button>
      <button type='button' disabled={busy} onClick={onDone}
        className='flex items-center justify-center gap-1 rounded-lg bg-violet-500 px-2 py-2 text-[11px] font-bold text-white hover:bg-violet-400 disabled:opacity-40'>
        <Check size={12} />{busy ? 'Saving…' : 'Done'}</button>
    </div>
  </div>;
}
