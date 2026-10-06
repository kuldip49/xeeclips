'use client';

import { Captions, Crop, Image as ImageIcon, LayoutTemplate, Music, Palette, SlidersHorizontal,
  Sparkles, Type, Video } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { EDIT_TOOLS, type EditToolId } from '@/lib/edit-mode-tools';

const ICONS: Record<EditToolId, LucideIcon> = {
  MEDIA: Video, TEMPLATES: LayoutTemplate, AUDIO: Music, TEXT: Type, CAPTIONS: Captions,
  CROP: Crop, OVERLAY: ImageIcon, EFFECTS: Sparkles, FILTERS: Palette, ADJUST: SlidersHorizontal
};

/**
 * Compact icon + label navigation. Exactly one category is open at a time, and
 * clicking the open one closes it, giving the preview the full width back.
 */
export function EditToolRail({ active, cropDisabled = false, onSelect }: {
  active: EditToolId | null;
  cropDisabled?: boolean;
  onSelect: (id: EditToolId | null) => void;
}) {
  return <nav aria-label='Editing tools'
    className='hidden w-[72px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-surface py-2 md:flex'>
    {EDIT_TOOLS.map((tool) => {
      const Icon = ICONS[tool.id];
      const selected = active === tool.id;
      const disabled = !!tool.pending || (tool.id === 'CROP' && cropDisabled);
      return <button key={tool.id} disabled={disabled}
        aria-pressed={selected} title={tool.pending ?? (tool.id === 'CROP' && cropDisabled
          ? 'Select a video segment to use manual crop.' : undefined)}
        onClick={() => onSelect(selected ? null : tool.id)}
        className={`mx-1.5 grid place-items-center gap-1 rounded-xl px-1 py-2.5 transition-colors ${
          disabled ? 'cursor-not-allowed text-faint opacity-50'
            : selected ? 'bg-primary/15 text-primary-soft'
              : 'text-muted-foreground hover:bg-tint hover:text-soft'}`}>
        <Icon size={19} aria-hidden />
        <span className='text-[10px] font-medium leading-none'>{tool.label}</span>
      </button>;
    })}
  </nav>;
}
