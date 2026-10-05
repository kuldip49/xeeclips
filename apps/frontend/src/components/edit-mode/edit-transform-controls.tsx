'use client';

import { useState } from 'react';
import { FlipHorizontal, FlipVertical, RotateCcw, RotateCw } from 'lucide-react';
import type { ManualEditCommand } from '@/lib/edit-mode-api';
import { NEUTRAL_CROP, SPEED_PRESETS, TRANSFORM_BOUNDS, type CropInsets,
  type EditElement } from '@/lib/edit-mode-types';

const num = (value: unknown, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

export const readCrop = (properties: Record<string, unknown>): CropInsets => {
  const crop = properties.crop;
  if (!crop || typeof crop !== 'object') return { ...NEUTRAL_CROP };
  const value = crop as Record<string, unknown>;
  return { left: num(value.left), right: num(value.right),
    top: num(value.top), bottom: num(value.bottom) };
};

const field = 'w-full rounded-lg border border-white/10 bg-black/20 px-2 py-1 text-xs text-slate-200';
const chip = 'rounded-md border border-white/10 py-1 text-[10px] text-slate-300 hover:bg-white/10';
const label = 'text-[10px] text-slate-500';

const CROP_EDGES = [['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom']] as const;

/** Aspect crop presets, expressed as the ratio the kept region should have. */
const CROP_PRESETS: Array<{ id: string; ratio: number | null }> = [
  { id: 'Original', ratio: null },
  { id: '9:16', ratio: 9 / 16 },
  { id: '1:1', ratio: 1 },
  { id: '4:5', ratio: 4 / 5 },
  { id: '16:9', ratio: 16 / 9 }
];

/** Canonical framing choices (SET_VIDEO_FRAMING). */
const FRAMING_CHOICES: Array<{ label: string;
  command: { mode: 'FIT' | 'FILL' | 'ASPECT'; aspectRatio?: '9:16' | '16:9' | '1:1' } }> = [
  { label: 'Fit', command: { mode: 'FIT' } },
  { label: 'Fill', command: { mode: 'FILL' } },
  { label: '9:16', command: { mode: 'ASPECT', aspectRatio: '9:16' } },
  { label: '16:9', command: { mode: 'ASPECT', aspectRatio: '16:9' } },
  { label: '1:1', command: { mode: 'ASPECT', aspectRatio: '1:1' } }
];

/**
 * Crop, rotation, flip, scale, position and speed for the selected element.
 *
 * Every control previews locally on change and commits one typed command on
 * release or blur, so dragging a slider is realtime and produces exactly one
 * undoable revision rather than one per pointer move.
 */
export function EditTransformControls({ selected, sourceAspect, onPreview, onCommit }: {
  selected: EditElement;
  /** Source width/height, used to solve an aspect crop preset. */
  sourceAspect: number | null;
  onPreview: (element: EditElement) => void;
  onCommit: (command: ManualEditCommand) => void;
}) {
  const p = selected.properties;
  const isVideo = selected.type === 'VIDEO';
  const [cropScope, setCropScope] = useState<'CURRENT_VIDEO_SEGMENT' | 'ALL_VIDEO_SEGMENTS'>(
    'CURRENT_VIDEO_SEGMENT');
  const crop = readCrop(p);
  const rotation = num(p.rotation, 0);
  const speed = num(p.speed, 1);
  const scale = num(p.scale, 1);
  const offsetX = num(p.offsetX, 0);
  const offsetY = num(p.offsetY, 0);

  const patch = (next: Record<string, unknown>) =>
    onPreview({ ...selected, properties: { ...p, ...next } });
  const commitCrop = (next: CropInsets) => onCommit({ action: 'set-video-crop',
    elementId: selected.id, cropLeft: next.left, cropRight: next.right,
    cropTop: next.top, cropBottom: next.bottom,
    scope: isVideo ? cropScope : 'SELECTED_ELEMENT' });
  const commitRotation = (value: number) =>
    onCommit({ action: 'set-video-rotation', elementId: selected.id, rotation: value });

  /** Solves the symmetric inset that gives the kept region the wanted ratio. */
  const applyCropPreset = (ratio: number | null) => {
    if (ratio == null || !sourceAspect) { patch({ crop: { ...NEUTRAL_CROP } }); commitCrop(NEUTRAL_CROP); return; }
    const next = ratio > sourceAspect
      // Wanted region is wider than the source: take height off.
      ? { left: 0, right: 0,
        top: (1 - sourceAspect / ratio) / 2, bottom: (1 - sourceAspect / ratio) / 2 }
      : { left: (1 - ratio / sourceAspect) / 2, right: (1 - ratio / sourceAspect) / 2,
        top: 0, bottom: 0 };
    const rounded: CropInsets = { left: Number(next.left.toFixed(4)),
      right: Number(next.right.toFixed(4)), top: Number(next.top.toFixed(4)),
      bottom: Number(next.bottom.toFixed(4)) };
    patch({ crop: rounded });
    commitCrop(rounded);
  };

  return <div className='grid gap-3 border-t border-white/[.06] pt-3'>
    <p className='text-[10px] font-semibold uppercase tracking-wider text-slate-500'>Transform</p>

    {/* --- Crop --- */}
    <div className='grid gap-1.5'>
      <div className='flex items-center justify-between gap-2'>
        <span className={label}>Crop / reframe</span>
        {isVideo && <select className={`${field} max-w-32`} aria-label='Crop scope'
          value={cropScope} onChange={(event) => setCropScope(event.target.value as typeof cropScope)}>
          <option value='CURRENT_VIDEO_SEGMENT'>Current segment</option>
          <option value='ALL_VIDEO_SEGMENTS'>Entire clip</option>
        </select>}
      </div>
      {/* Step 5 canonical framing. With "Entire clip" an aspect also changes the
          output canvas; with "Current segment" it crops that segment only. Cuts,
          captions, text, audio and zoom are never touched by framing. */}
      {isVideo && <div className='grid grid-cols-5 gap-1' role='group' aria-label='Frame'>
        {FRAMING_CHOICES.map((choice) => <button key={choice.label} type='button' className={chip}
          title={cropScope === 'ALL_VIDEO_SEGMENTS' ? `${choice.label} - entire clip`
            : `${choice.label} - current segment`}
          onClick={() => onCommit({ action: 'set-video-framing', elementId: selected.id,
            scope: cropScope, ...choice.command })}>{choice.label}</button>)}
      </div>}
      <div className='grid grid-cols-5 gap-1'>
        {CROP_PRESETS.map((preset) => <button key={preset.id} type='button' className={chip}
          onClick={() => applyCropPreset(preset.ratio)}>{preset.id}</button>)}
      </div>
      <div className='grid grid-cols-4 gap-1'>
        {CROP_EDGES.map(([edge, title]) => <label key={edge} className={label}>{title}
          <input className={field} type='number' min={0} max={0.95} step='.01'
            value={crop[edge]}
            onChange={(event) => patch({ crop: { ...crop, [edge]: num(event.target.value) } })}
            onBlur={() => commitCrop(readCrop(selected.properties))} />
        </label>)}
      </div>
    </div>

    {/* --- Rotation --- */}
    <div className='grid gap-1.5'>
      <div className='flex items-baseline justify-between'>
        <span className={label}>Angle</span>
        <span className='text-[10px] tabular-nums text-slate-400'>{rotation.toFixed(0)}°</span>
      </div>
      <input className='w-full accent-cyan-300' type='range'
        min={TRANSFORM_BOUNDS.minRotation} max={TRANSFORM_BOUNDS.maxRotation} step={1}
        value={rotation} aria-label='Rotation angle'
        onChange={(event) => patch({ rotation: num(event.target.value) })}
        onPointerUp={() => commitRotation(num(selected.properties.rotation, 0))} />
      <div className='grid grid-cols-5 gap-1'>
        <input className={field} type='number' aria-label='Rotation degrees'
          min={TRANSFORM_BOUNDS.minRotation} max={TRANSFORM_BOUNDS.maxRotation}
          value={rotation}
          onChange={(event) => patch({ rotation: num(event.target.value) })}
          onBlur={() => commitRotation(num(selected.properties.rotation, 0))} />
        {[-90, 0, 90, 180].map((angle) => <button key={angle} type='button' className={chip}
          aria-label={angle === 0 ? 'Straighten to 0 degrees' : `Rotate to ${angle} degrees`}
          onClick={() => { patch({ rotation: angle }); commitRotation(angle); }}>
          {angle === 0 ? <RotateCcw size={11} className='mx-auto' aria-hidden /> : `${angle}°`}</button>)}
      </div>
    </div>

    {/* --- Flip --- */}
    <div className='grid gap-1.5'>
      <span className={label}>Flip</span>
      <div className='grid grid-cols-2 gap-1'>
        {([['flipH', 'Horizontal', FlipHorizontal], ['flipV', 'Vertical', FlipVertical]] as const)
          .map(([key, title, Icon]) => {
            const active = p[key] === true;
            return <button key={key} type='button' aria-pressed={active}
              onClick={() => {
                const next = { flipH: p.flipH === true, flipV: p.flipV === true, [key]: !active };
                patch(next);
                onCommit({ action: 'set-video-flip', elementId: selected.id,
                  flipH: next.flipH as boolean, flipV: next.flipV as boolean });
              }}
              className={`flex items-center justify-center gap-1 rounded-md border py-1.5 text-[10px] ${
                active ? 'border-cyan-300/40 bg-cyan-400/10 text-cyan-200'
                  : 'border-white/10 text-slate-300 hover:bg-white/10'}`}>
              <Icon size={12} />{title}</button>;
          })}
      </div>
    </div>

    {isVideo && <>
      {/* --- Scale and position (VIDEO uses its own transform; an overlay uses
             its box, so these are deliberately not shown for one.) --- */}
      <div className='grid gap-1.5'>
        <div className='flex items-baseline justify-between'>
          <span className={label}>Scale</span>
          <span className='text-[10px] tabular-nums text-slate-400'>{scale.toFixed(2)}×</span>
        </div>
        <input className='w-full accent-cyan-300' type='range' aria-label='Scale'
          min={TRANSFORM_BOUNDS.minScale} max={TRANSFORM_BOUNDS.maxScale} step='.01' value={scale}
          onChange={(event) => patch({ scale: num(event.target.value, 1) })}
          onPointerUp={() => onCommit({ action: 'set-video-scale', elementId: selected.id,
            scale: num(selected.properties.scale, 1) })} />
      </div>
      <div className='grid gap-1.5'>
        <span className={label}>Position</span>
        <div className='grid grid-cols-2 gap-1'>
          {(['offsetX', 'offsetY'] as const).map((key) => <label key={key} className={label}>
            {key === 'offsetX' ? 'X' : 'Y'}
            <input className={field} type='number' min={-1} max={1} step='.01'
              value={key === 'offsetX' ? offsetX : offsetY}
              onChange={(event) => patch({ [key]: num(event.target.value) })}
              onBlur={() => onCommit({ action: 'set-video-position', elementId: selected.id,
                x: num(selected.properties.offsetX, 0), y: num(selected.properties.offsetY, 0) })} />
          </label>)}
        </div>
      </div>

      {/* --- Speed --- */}
      <div className='grid gap-1.5'>
        <div className='flex items-baseline justify-between'>
          <span className={label}>Speed</span>
          <span className='text-[10px] tabular-nums text-slate-400'>{speed.toFixed(2)}×</span>
        </div>
        <div className='grid grid-cols-7 gap-1'>
          {SPEED_PRESETS.map((preset) => <button key={preset} type='button'
            aria-pressed={Math.abs(preset - speed) < 1e-6}
            onClick={() => onCommit({ action: 'set-speed', elementId: selected.id, speed: preset })}
            className={`rounded-md border py-1 text-[9px] ${
              Math.abs(preset - speed) < 1e-6 ? 'border-cyan-300/40 bg-cyan-400/10 text-cyan-200'
                : 'border-white/10 text-slate-300 hover:bg-white/10'}`}>{preset}×</button>)}
        </div>
        <p className='text-[10px] leading-4 text-slate-500'>
          Changing speed moves every later clip, and the overlays placed on them, to match.</p>
      </div>
    </>}

    <button type='button' onClick={() => {
      patch({ crop: { ...NEUTRAL_CROP }, rotation: 0, flipH: false, flipV: false,
        scale: 1, offsetX: 0, offsetY: 0 });
      commitCrop(NEUTRAL_CROP);
      commitRotation(0);
      onCommit({ action: 'set-video-flip', elementId: selected.id, flipH: false, flipV: false });
      if (isVideo) {
        onCommit({ action: 'set-video-scale', elementId: selected.id, scale: 1 });
        onCommit({ action: 'set-video-position', elementId: selected.id, x: 0, y: 0 });
      }
    }} className='flex items-center justify-center gap-1 rounded-lg border border-white/10 py-1.5 text-[10px] text-slate-300 hover:bg-white/5'>
      <RotateCw size={11} />Reset transform</button>
  </div>;
}
