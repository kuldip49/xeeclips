'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Captions, Crop, Image as ImageIcon, LayoutTemplate, Music, MousePointerClick, Palette,
  SlidersHorizontal, Sparkles, Type, Video, X, type LucideIcon } from 'lucide-react';
import type { EditToolId } from '@/lib/edit-mode-tools';
import { cn } from '@/lib/utils';

/** What a phone drawer can show: the AI editor, the inspector, export, or one tool. */
export type MobilePanelId = 'AI' | 'INSPECTOR' | 'EXPORT' | Exclude<EditToolId, 'EFFECTS'>;

const ITEMS: Array<{ id: MobilePanelId; label: string; icon: LucideIcon }> = [
  { id: 'AI', label: 'Ask AI', icon: Sparkles },
  { id: 'INSPECTOR', label: 'Inspect', icon: MousePointerClick },
  { id: 'CAPTIONS', label: 'Captions', icon: Captions },
  { id: 'TEXT', label: 'Text', icon: Type },
  { id: 'CROP', label: 'Crop', icon: Crop },
  { id: 'AUDIO', label: 'Audio', icon: Music },
  { id: 'TEMPLATES', label: 'Style', icon: LayoutTemplate },
  { id: 'ADJUST', label: 'Adjust', icon: SlidersHorizontal },
  { id: 'FILTERS', label: 'Filters', icon: Palette },
  { id: 'OVERLAY', label: 'Overlay', icon: ImageIcon },
  { id: 'MEDIA', label: 'Media', icon: Video }
];

export const MOBILE_PANEL_TITLES: Record<MobilePanelId, string> = {
  AI: 'AI editor', INSPECTOR: 'Inspector', EXPORT: 'Export', CAPTIONS: 'Captions', TEXT: 'Text',
  CROP: 'Crop', AUDIO: 'Audio', TEMPLATES: 'Style', ADJUST: 'Adjust', FILTERS: 'Filters',
  OVERLAY: 'Overlay', MEDIA: 'Media'
};

/**
 * The phone editor's tool bar: one horizontally scrolling row of large icon+label targets,
 * pinned above the home indicator. Tapping a tool opens its drawer; tapping it again closes it.
 */
export function EditMobileToolbar({ active, onSelect }: {
  active: MobilePanelId | null;
  onSelect: (id: MobilePanelId) => void;
}) {
  return <nav aria-label='Editing tools' data-testid='mobile-editor-toolbar'
    className='shrink-0 border-t border-white/10 bg-[#0b0f19] pb-safe md:hidden'>
    <div className='scrollbar-none flex h-16 items-stretch gap-0.5 overflow-x-auto px-1.5'>
      {ITEMS.map(({ id, label, icon: Icon }) => {
        const selected = active === id;
        return <button key={id} type='button' aria-pressed={selected} onClick={() => onSelect(id)}
          className={cn('pressable flex min-w-[64px] shrink-0 flex-col items-center justify-center gap-1 rounded-xl px-1.5 text-[11px] font-medium',
            selected ? 'text-violet-100' : 'text-slate-400', id === 'AI' && !selected && 'text-violet-300')}>
          <span className={cn('grid h-8 w-11 place-items-center rounded-full transition-colors', selected && 'bg-violet-500/25')}>
            <Icon size={20} aria-hidden /></span>
          {label}
        </button>;
      })}
    </div>
  </nav>;
}

/**
 * A drawer docked under the preview (not floating over it), so the video stays visible and
 * live while a tool is used - the preview simply gets shorter. Swipe the handle down or press
 * the close button to dismiss it.
 */
export function EditMobileDrawer({ title, size = 'medium', expanded = false, scroll = true, onClose, children, action }: {
  title: string;
  /** `tall` for the AI chat, `auto` for compact docks such as crop. */
  size?: 'auto' | 'medium' | 'tall';
  /** The keyboard is up: give the drawer nearly all the height. */
  expanded?: boolean;
  /** False when the content manages its own scrolling (the chat thread). */
  scroll?: boolean;
  onClose: () => void;
  children: ReactNode;
  action?: ReactNode;
}) {
  const [drag, setDrag] = useState(0);
  const start = useRef<{ y: number; id: number } | null>(null);
  const basis = expanded ? 'basis-[calc(100%-84px)]'
    : size === 'tall' ? 'basis-[62%]' : size === 'medium' ? 'basis-[50%]' : 'max-h-[62%]';
  const release = () => {
    if (!start.current) return;
    start.current = null;
    if (drag > 70) onClose();
    setDrag(0);
  };
  return <section role='region' aria-label={title} data-testid='mobile-editor-drawer'
    className={cn('relative z-20 flex min-h-0 shrink-0 grow-0 flex-col rounded-t-[20px] border-t border-white/10 bg-[#0f1422] shadow-[0_-12px_32px_rgba(0,0,0,.45)] md:hidden', basis)}
    style={drag ? { transform: `translateY(${drag}px)`, transition: 'none' } : { transition: 'transform .18s ease' }}>
    <div className='shrink-0 touch-none select-none'
      onPointerDown={(event) => { start.current = { y: event.clientY, id: event.pointerId }; event.currentTarget.setPointerCapture?.(event.pointerId); }}
      onPointerMove={(event) => { if (start.current?.id === event.pointerId) setDrag(Math.max(0, event.clientY - start.current.y)); }}
      onPointerUp={release} onPointerCancel={release}>
      <div aria-hidden className='mx-auto mt-2 h-1.5 w-10 rounded-full bg-white/20' />
      <div className='flex h-12 items-center gap-2 pl-4 pr-1.5'>
        <h2 className='min-w-0 flex-1 truncate text-[15px] font-semibold'>{title}</h2>
        {action}
        <button type='button' onClick={onClose} aria-label={`Close ${title}`} onPointerDown={(event) => event.stopPropagation()}
          className='grid h-11 w-11 shrink-0 place-items-center rounded-full text-slate-300 hover:bg-white/10'><X size={20} aria-hidden /></button>
      </div>
    </div>
    <div className={cn('min-h-0 min-w-0 flex-1 px-4', scroll ? 'overflow-y-auto overscroll-contain pb-4' : 'flex flex-col overflow-hidden')}>
      {children}
    </div>
  </section>;
}

