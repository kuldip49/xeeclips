'use client';

import type { ManualEditCommand } from '@/lib/edit-mode-api';
import { COLOR_FILTERS, colorFilterCss, matchesFilter, readColorAdjustments,
  readColorFilterId, readColorFilterStrength, resolveColorFilter } from '@/lib/edit-mode-color';
import type { EditElement } from '@/lib/edit-mode-types';

/**
 * Built-in filters for the selected video segment.
 *
 * A filter is not a hidden effect layered over the sliders: applying one
 * RESOLVES to concrete adjustment values and stores them, so the Adjust panel
 * immediately shows what the filter actually did and every slider remains free
 * to move afterwards. The filter's name is kept alongside, as a label for the
 * UI and for a future template - never as a second source of truth for what is
 * rendered.
 *
 * Strength interpolates between neutral and the filter's target, and it is
 * resolved at APPLY time for the same reason: what is stored is what renders.
 * Re-applying at a different strength re-resolves from the filter definition,
 * so it replaces a previous application rather than compounding with it.
 */
export function EditFiltersPanel({ selected, busy, onCommand }: {
  selected?: EditElement;
  busy: boolean;
  onCommand: (command: ManualEditCommand) => void;
}) {
  if (!selected || selected.type !== 'VIDEO') {
    return <p className='text-[11px] leading-4 text-slate-500'>
      Select a video segment on the timeline to apply a filter.</p>;
  }
  const properties = selected.properties;
  const color = readColorAdjustments(properties);
  const activeId = readColorFilterId(properties);
  const strength = readColorFilterStrength(properties);
  const edited = activeId != null && !matchesFilter(color, activeId, strength);

  return <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3'>
    <div className='grid grid-cols-2 gap-2'>
      {COLOR_FILTERS.map((filter) => {
        const active = filter.id === 'ORIGINAL' ? activeId === null : filter.id === activeId;
        // The swatch is the filter's own preview: a gradient graded with the
        // same CSS approximation the canvas uses, so the tile and the picture
        // agree about what the filter does.
        const preview = colorFilterCss(resolveColorFilter(filter.id, 1));
        return <button key={filter.id} type='button' disabled={busy}
          aria-pressed={active} title={filter.description}
          onClick={() => onCommand({ action: 'apply-color-filter', elementId: selected.id,
            filterId: filter.id, strength })}
          className={`grid gap-1 rounded-lg border p-1.5 text-left disabled:opacity-30 ${
            active ? 'border-violet-300/60 bg-violet-400/10' : 'border-white/10 hover:bg-white/5'}`}>
          <span aria-hidden className='h-9 w-full rounded'
            style={{ filter: preview || undefined,
              background: 'linear-gradient(135deg,#1f2937 0%,#8b5cf6 40%,#f59e0b 75%,#fef3c7 100%)' }} />
          <span className='truncate text-[10px] font-medium text-slate-200'>{filter.label}</span>
        </button>;
      })}
    </div>

    <div className='grid gap-1 border-t border-white/[.06] pt-3'>
      <div className='flex items-baseline justify-between'>
        <label htmlFor='filter-strength' className='text-[11px] text-slate-300'>Strength</label>
        <span className='text-[10px] tabular-nums text-slate-500'>
          {Math.round(strength * 100)}%</span>
      </div>
      <input id='filter-strength' type='range' min={0} max={1} step={0.05} value={strength}
        disabled={busy || !activeId} className='w-full accent-violet-400'
        onChange={(event) => activeId && onCommand({ action: 'apply-color-filter',
          elementId: selected.id, filterId: activeId, strength: Number(event.target.value) })} />
      <p className='text-[9px] leading-3 text-slate-600'>
        {activeId
          ? 'Re-applies the filter at this strength. Anything you changed by hand afterwards is replaced.'
          : 'Pick a filter first.'}</p>
    </div>

    {edited && <p className='text-[10px] leading-4 text-amber-200/70'>
      You have adjusted this grade by hand, so it no longer matches {
        COLOR_FILTERS.find((filter) => filter.id === activeId)?.label} exactly. Your values are
      what renders.</p>}
  </div>;
}
