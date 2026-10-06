'use client';

import { Plus, Type } from 'lucide-react';
import type { ManualEditCommand } from '@/lib/edit-mode-api';
import type { EditElement } from '@/lib/edit-mode-types';
import { readTextStyle, textStyleCss, TEXT_STYLE_PRESETS,
  type TextStylePresetId } from '@/lib/edit-mode-text';

/**
 * The Text tool panel.
 *
 * Adding text always goes through a built-in style, so the first thing on the
 * canvas is a finished-looking element rather than a default to fight with. The
 * same nine styles restyle the selected element in place, which is why the
 * preset row is shown whether or not something is selected.
 *
 * Everything here emits a canonical command. There is no panel-local text state.
 */
export function EditTextPanel({ elements, busy, hasSource, selectedElementId, onCommand,
  onSelectElement }: {
  elements: EditElement[];
  busy: boolean;
  hasSource: boolean;
  selectedElementId: string | null;
  onCommand: (command: ManualEditCommand) => void;
  onSelectElement: (id: string) => void;
}) {
  const textElements = elements.filter((element) => element.type === 'TEXT')
    .sort((left, right) => left.startTime - right.startTime);
  const selected = textElements.find((element) => element.id === selectedElementId);
  const disabled = busy || !hasSource;

  const applyPreset = (id: TextStylePresetId) => {
    if (selected) onCommand({ action: 'set-text-style-preset', elementId: selected.id,
      textStyleId: id });
    else onCommand({ action: 'add-text', textStyleId: id });
  };

  return <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3'>
    <button disabled={disabled} onClick={() => onCommand({ action: 'add-text' })}
      className='flex items-center justify-center gap-1.5 rounded-lg btn-primary py-2 text-[11px] font-bold text-primary-foreground disabled:opacity-30'>
      <Plus size={12} />Add text</button>

    <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5'>
      <p className='text-[10px] font-semibold uppercase tracking-wider text-faint'>
        {selected ? 'Restyle selected text' : 'Styles'}</p>
      {TEXT_STYLE_PRESETS.map((preset) => {
        const style = readTextStyle(preset.style as Record<string, unknown>);
        // The miniature carries the preset's own plate as well as its type. A
        // style like CTA is dark text on a bright pill: drawn without the pill it
        // reads as an empty row, which is exactly how it looked before this.
        const plate = style.background.enabled && style.background.opacity > 0;
        return <button key={preset.id} disabled={disabled} title={preset.description}
          onClick={() => applyPreset(preset.id)}
          className='flex items-center gap-2 overflow-hidden rounded-lg border border-border bg-tint-subtle px-2.5 py-2 text-left hover:border-primary/40 hover:bg-tint-strong disabled:opacity-30'>
          <span className='min-w-0 flex-1 truncate'
            style={{ fontFamily: textStyleCss(preset.style as Record<string, unknown>, 600).fontFamily,
              fontWeight: style.fontWeight, color: style.color,
              textTransform: style.uppercase ? 'uppercase' : 'none',
              letterSpacing: `${style.letterSpacing / 24}em`,
              fontSize: `${Math.max(11, Math.min(17, style.fontSize / 5))}px`,
              ...(plate
                ? { background: style.background.color,
                  opacity: Math.max(0.65, style.background.opacity),
                  borderRadius: `${Math.min(14, style.background.radius / 3)}px`,
                  padding: '2px 8px' }
                : { textShadow: '0 1px 2px rgba(0,0,0,.9)' }) }}>
            {preset.label}</span>
          <span className='shrink-0 text-[9px] uppercase tracking-wider text-faint'>
            {preset.id === 'BASIC' ? 'default' : ''}</span>
        </button>;
      })}
    </div>

    <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1'>
      <p className='text-[10px] font-semibold uppercase tracking-wider text-faint'>
        On this timeline</p>
      {textElements.length === 0
        ? <p className='text-[11px] leading-4 text-faint'>No text on this timeline yet.</p>
        : textElements.map((element) => <button key={element.id}
          onClick={() => onSelectElement(element.id)}
          className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] transition-colors ${
            element.id === selectedElementId ? 'bg-primary/15 text-foreground'
              : 'text-soft hover:bg-tint'}`}>
          <Type size={12} className='shrink-0 text-faint' />
          <span className='min-w-0 flex-1 truncate'>
            {String(element.properties.content ?? 'Text') || 'Text'}</span>
          <span className='shrink-0 tabular-nums text-faint'>
            {element.startTime.toFixed(1)}s</span>
        </button>)}
    </div>
  </div>;
}
