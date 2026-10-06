'use client';

import { useId, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function WorkspaceAccordion({ title, summary, icon: Icon, children, defaultOpen = false, className }: {
  title: string;
  summary?: string;
  icon: LucideIcon;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return <section className={cn('min-w-0 overflow-hidden rounded-2xl border border-border bg-surface', className)}>
    <h3>
      <button type='button' aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)} className='flex w-full min-w-0 items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-tint-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'>
        <Icon className='h-4 w-4 shrink-0 text-primary-soft' aria-hidden />
        <span className='min-w-0 flex-1 truncate text-sm font-semibold'>{title}</span>
        {summary && <span className='hidden max-w-[40%] truncate text-right text-xs text-muted-foreground sm:block'>{summary}</span>}
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-180')} aria-hidden />
      </button>
    </h3>
    <AnimatePresence initial={false}>
      {open && <motion.div id={panelId} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: .22, ease: 'easeInOut' }} className='overflow-hidden'>
        <div className='border-t border-border px-4 py-4'>{children}</div>
      </motion.div>}
    </AnimatePresence>
  </section>;
}
