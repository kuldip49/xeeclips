'use client';

import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Secondary controls folded behind one row on phones, always shown from `md` up.
 *
 * Desktop layouts keep every control visible exactly as before; a phone sees the essentials
 * first and opens the rest with one large tap target.
 */
export function MobileDisclosure({ title, summary, children, defaultOpen = false, className }: {
  title: string;
  summary?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  return <div className={cn('grid min-w-0 gap-6', className)}>
    <button type='button' aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}
      className='flex min-h-[48px] w-full min-w-0 items-center gap-2 rounded-2xl border border-white/10 bg-[#111827] px-4 py-3 text-left text-sm font-medium md:hidden'>
      <SlidersHorizontal size={16} className='shrink-0 text-violet-300' aria-hidden />
      <span className='shrink-0'>{title}</span>
      {summary ? <span className='min-w-0 flex-1 truncate font-normal text-slate-500'>· {summary}</span> : <span className='flex-1' />}
      <ChevronDown size={16} className={cn('shrink-0 text-slate-400 transition-transform', open && 'rotate-180')} aria-hidden />
    </button>
    <div id={panelId} className={cn('grid min-w-0 content-start gap-6', !open && 'hidden md:grid')}>{children}</div>
  </div>;
}
