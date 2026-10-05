'use client';

import { Clipboard, Copy, RotateCcw } from 'lucide-react';
import type { ManualEditCommand } from '@/lib/edit-mode-api';
import { COLOR_BOUNDS, COLOR_CONTROLS, NEUTRAL_COLOR, PREVIEW_PARITY, matchesFilter,
  readColorAdjustments, readColorFilterId, readColorFilterStrength, COLOR_FILTERS,
  type ColorKey } from '@/lib/edit-mode-color';
import type { EditElement } from '@/lib/edit-mode-types';

/** The typed command each control commits. Kept as one table so a control and
 * its command cannot drift apart. */
const COLOR_ACTIONS: Record<ColorKey, ManualEditCommand['action']> = {
  exposure: 'set-video-exposure', brightness: 'set-video-brightness',
  contrast: 'set-video-contrast', highlights: 'set-video-highlights',
  shadows: 'set-video-shadows', saturation: 'set-video-saturation',
  temperature: 'set-video-temperature', tint: 'set-video-tint',
  sharpness: 'set-video-sharpness', fade: 'set-video-fade', vignette: 'set-video-vignette'
};

const colorCommand = (elementId: string, key: ColorKey, value: number): ManualEditCommand =>
  ({ action: COLOR_ACTIONS[key], elementId, [key]: value } as ManualEditCommand);

const PARITY_NOTE: Record<string, string> = {
  APPROXIMATE: 'Preview is close; the export is exact.',
  EXPORT_ONLY: 'Applied on export only - the preview cannot show it.'
};

/**
 * Manual colour for the selected video segment.
 *
 * Every slider is LOCAL while the pointer is down - it patches the in-memory
 * element and the preview redraws immediately - and commits exactly one typed
 * command on release. That is what makes dragging Contrast feel instant while
 * costing one undoable revision rather than one per pointer move, and it is why
 * no FFmpeg render is ever triggered by a drag.
 */
export function EditAdjustPanel({ selected, busy, onPreview, onCommand, copied, onCopy }: {
  selected?: EditElement;
  busy: boolean;
  onPreview: (element: EditElement) => void;
  onCommand: (command: ManualEditCommand) => void;
  /** The element whose adjustments are on the local clipboard, if any. */
  copied: string | null;
  onCopy: (elementId: string | null) => void;
}) {
  if (!selected || selected.type !== 'VIDEO') {
    return <p className='text-[11px] leading-4 text-slate-500'>
      Select a video segment on the timeline to colour it.</p>;
  }
  const properties = selected.properties;
  const color = readColorAdjustments(properties);
  const filterId = readColorFilterId(properties);
  const strength = readColorFilterStrength(properties);
  const filter = COLOR_FILTERS.find((item) => item.id === filterId);
  const edited = filterId != null && !matchesFilter(color, filterId, strength);

  // A drag writes straight to the in-memory element. `colorAdjustments` is the
  // canonical shape, so the preview reads the same field the renderer will.
  const patch = (key: ColorKey, value: number) => onPreview({ ...selected,
    properties: { ...properties, colorAdjustments: { ...color, [key]: value } } });

  return <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3'>
    <div className='flex items-center justify-between gap-2'>
      <p className='min-w-0 truncate text-[11px] text-slate-400'>
        {filter && filter.id !== 'ORIGINAL'
          ? <>Based on <span className='text-slate-200'>{filter.label}</span>{edited && ' (edited)'}</>
          : 'Manual grade'}
      </p>
      <button type='button' disabled={busy}
        onClick={() => onCommand({ action: 'reset-video-adjustments', elementId: selected.id })}
        className='flex shrink-0 items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[10px] text-slate-300 hover:bg-white/10 disabled:opacity-30'>
        <RotateCcw size={10} />Reset all</button>
    </div>

    {COLOR_CONTROLS.map(({ key, label, hint }) => {
      const { min, max } = COLOR_BOUNDS[key];
      const value = color[key];
      const parity = PREVIEW_PARITY[key];
      return <div key={key} className='grid min-w-0 gap-1'>
        <div className='flex items-baseline justify-between gap-2'>
          <label htmlFor={`adjust-${key}`} className='text-[11px] text-slate-300'>{label}</label>
          <div className='flex items-center gap-1'>
            <span className='text-[10px] tabular-nums text-slate-500'>
              {Math.round(value * 100)}</span>
            {value !== NEUTRAL_COLOR[key] && <button type='button' disabled={busy}
              aria-label={`Reset ${label}`}
              onClick={() => onCommand(colorCommand(selected.id, key, NEUTRAL_COLOR[key]))}
              className='text-[10px] text-slate-600 hover:text-slate-300'>&#8635;</button>}
          </div>
        </div>
        <input id={`adjust-${key}`} type='range' min={min} max={max} step={0.01} value={value}
          disabled={busy} className='w-full accent-violet-400'
          onChange={(event) => patch(key, Number(event.target.value))}
          onPointerUp={() => onCommand(colorCommand(selected.id, key,
            Number(readColorAdjustments(selected.properties)[key])))}
          onKeyUp={() => onCommand(colorCommand(selected.id, key,
            Number(readColorAdjustments(selected.properties)[key])))} />
        <p className='text-[9px] leading-3 text-slate-600'>
          {hint}{parity === 'EXACT' ? '' : ` · ${PARITY_NOTE[parity]}`}</p>
      </div>;
    })}

    {/* Copy/paste between segments. The clipboard is view state: pasting is a
        normal typed command that reads the source segment on the server, so a
        stale clipboard cannot write a value that no longer exists. */}
    <div className='grid grid-cols-2 gap-2 border-t border-white/[.06] pt-3'>
      <button type='button' disabled={busy} onClick={() => onCopy(selected.id)}
        className='flex items-center justify-center gap-1 rounded-lg border border-white/10 py-1.5 text-[10px] text-slate-300 hover:bg-white/10 disabled:opacity-30'>
        <Copy size={11} />Copy</button>
      <button type='button' disabled={busy || !copied || copied === selected.id}
        onClick={() => copied && onCommand({ action: 'paste-video-adjustments',
          elementId: selected.id, fromElementId: copied })}
        className='flex items-center justify-center gap-1 rounded-lg border border-white/10 py-1.5 text-[10px] text-slate-300 hover:bg-white/10 disabled:opacity-30'>
        <Clipboard size={11} />Paste</button>
    </div>
  </div>;
}
