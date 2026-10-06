'use client';

import { useMemo, useState } from 'react';
import { Captions, Eye, EyeOff, Search, Sparkles, Trash2, Wand2 } from 'lucide-react';
import type { ManualEditCommand } from '@/lib/edit-mode-api';
import type { EditAsset, EditElement } from '@/lib/edit-mode-types';
import { CAPTION_STYLE_PRESETS, readTextStyle, textStyleCss,
  type CaptionStylePresetId } from '@/lib/edit-mode-text';
import { captionRows } from '@/lib/edit-mode-caption-list';

export function EditCaptionsPanel({ elements, source, busy, hasSource, selectedElementId,
  playheadSec, onCommand, onSelectElement }: {
  elements: EditElement[];
  source?: EditAsset;
  busy: boolean;
  hasSource: boolean;
  selectedElementId: string | null;
  playheadSec: number;
  onCommand: (command: ManualEditCommand) => void;
  onSelectElement: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [styleId, setStyleId] = useState<CaptionStylePresetId>('CLEAN');
  const captions = useMemo(() => elements.filter((element) => element.type === 'SUBTITLE'),
    [elements]);
  const { rows, total, mode } = useMemo(() => captionRows(captions, playheadSec, query),
    [captions, playheadSec, query]);
  const hidden = captions.length > 0 && captions.every((element) =>
    element.properties.hidden === true);
  const selected = captions.find((element) => element.id === selectedElementId);
  // Captions come from the transcript cached by "Analyze source"; without it
  // there is nothing to generate FROM, and saying so beats a failed request.
  const hasTranscript = !!source?.transcript;
  const disabled = busy || !hasSource;

  return <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3'>
    <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5'>
      <label className='text-[10px] font-semibold uppercase tracking-wider text-faint'>
        Caption style
        <select value={styleId} onChange={(event) =>
          setStyleId(event.target.value as CaptionStylePresetId)}
          className='mt-1 w-full rounded-lg border border-border bg-inset px-2 py-1.5 text-xs font-normal normal-case tracking-normal text-soft'>
          {CAPTION_STYLE_PRESETS.map((preset) =>
            <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        </select>
      </label>
      <p className='text-[10px] leading-4 text-faint'>
        {CAPTION_STYLE_PRESETS.find((preset) => preset.id === styleId)?.description}</p>
      <button disabled={disabled || !hasTranscript}
        onClick={() => onCommand({ action: 'generate-captions', captionStyleId: styleId })}
        className='flex items-center justify-center gap-1.5 rounded-lg bg-secondary py-2 text-[11px] font-bold text-secondary-foreground hover:bg-secondary disabled:opacity-30'>
        <Wand2 size={12} />{captions.length ? 'Regenerate captions' : 'Generate captions'}</button>
      {!hasTranscript && <p className='text-[10px] leading-4 text-warning-soft/70'>
        Run &ldquo;Analyze source&rdquo; first — captions are built from the cached transcript and
        nothing is re-transcribed.</p>}
      {captions.length > 0 && <p className='text-[10px] leading-4 text-faint'>
        Regenerating replaces the caption track, including manual corrections.</p>}
    </div>

    {captions.length > 0 && <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5'>
      <div className='grid grid-cols-2 gap-1.5'>
        <button disabled={busy}
          onClick={() => onCommand({ action: 'set-captions-visible', visible: hidden })}
          className='flex items-center justify-center gap-1.5 rounded-lg border border-border py-1.5 text-[11px] text-soft hover:bg-tint disabled:opacity-30'>
          {hidden ? <Eye size={12} /> : <EyeOff size={12} />}{hidden ? 'Show' : 'Hide'}</button>
        <button disabled={busy} onClick={() => onCommand({ action: 'remove-captions' })}
          className='flex items-center justify-center gap-1.5 rounded-lg border border-danger/20 py-1.5 text-[11px] text-danger hover:bg-danger/10 disabled:opacity-30'>
          <Trash2 size={12} />Remove all</button>
      </div>
      <button disabled={busy || !selected}
        title={selected ? undefined : 'Select a caption first'}
        onClick={() => selected && onCommand({ action: 'apply-caption-style-to-all',
          elementId: selected.id })}
        className='flex items-center justify-center gap-1.5 rounded-lg border border-secondary/25 py-1.5 text-[11px] font-semibold text-secondary-soft hover:bg-secondary/10 disabled:opacity-30'>
        <Sparkles size={12} />Apply selected style to all</button>
    </div>}

    {captions.length > 0 && <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1'>
      <label className='relative block'>
        <Search size={12} aria-hidden
          className='pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint' />
        <input value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder='Search captions' aria-label='Search captions'
          className='w-full rounded-lg border border-border bg-inset py-1.5 pl-7 pr-2 text-xs text-soft placeholder:text-faint' />
      </label>
      <p className='text-[10px] text-faint'>
        {mode === 'ALL' ? `${total} caption${total === 1 ? '' : 's'}`
          : `Showing ${rows.length} of ${total}${mode === 'WINDOW' ? ' around the playhead' : ' matches'}`}
      </p>
      <div data-testid='caption-rows' data-mounted={rows.length} data-total={total}
        className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-0.5'>
        {rows.map((element) => {
          const style = readTextStyle(element.properties);
          return <button key={element.id} onClick={() => onSelectElement(element.id)}
            className={`flex items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] transition-colors ${
              element.id === selectedElementId ? 'bg-secondary/15 text-secondary-soft'
                : 'text-soft hover:bg-tint'}`}>
            <Captions size={11} className='shrink-0 text-faint' />
            <span className='min-w-0 flex-1 truncate'
              style={{ textTransform: style.uppercase ? 'uppercase' : 'none',
                fontFamily: textStyleCss(element.properties, 600).fontFamily }}>
              {String(element.properties.content ?? '')}</span>
            {element.properties.manualEdited === true &&
              <span title='Edited by hand' aria-label='Edited by hand'
                className='shrink-0 rounded bg-warning/15 px-1 text-[9px] font-semibold text-warning-soft'>
                edited</span>}
            <span className='shrink-0 tabular-nums text-faint'>
              {element.startTime.toFixed(1)}s</span>
          </button>;
        })}
      </div>
    </div>}
  </div>;
}
