'use client';
import { Check } from 'lucide-react';
import type { ReframeStep } from '@/lib/quick-reframe-api';
import { cn } from '@/lib/utils';

const STEPS: Array<{ id: ReframeStep; label: string }> = [
  { id: 'crop', label: 'Crop' }, { id: 'choose', label: 'Choose Style' }, { id: 'edit', label: 'Edit' }, { id: 'export', label: 'Export' }
];

/** 1. Crop → 2. Choose Style → 3. Edit → 4. Export. Earlier and reachable steps are links back. */
export function StepIndicator({ active, reachable, onSelect, className }: {
  active: ReframeStep; reachable: (step: ReframeStep) => boolean; onSelect: (step: ReframeStep) => void; className?: string;
}) {
  const activeIndex = STEPS.findIndex((s) => s.id === active);
  return <nav aria-label='Quick Reframe steps' className={cn('min-w-0', className)}>
    <ol className='flex min-w-0 items-center gap-1 sm:gap-2'>
      {STEPS.map((step, index) => {
        const current = step.id === active; const done = index < activeIndex; const enabled = !current && reachable(step.id);
        return <li key={step.id} className='flex min-w-0 flex-1 items-center gap-1 sm:gap-2'>
          <button type='button' disabled={!enabled} aria-current={current ? 'step' : undefined} onClick={() => onSelect(step.id)}
            className={cn('flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-2 text-left transition-colors sm:px-3',
              current ? 'bg-primary/15 text-foreground' : enabled ? 'text-soft hover:bg-tint' : 'text-faint')}>
            <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold',
              current ? 'bg-primary text-primary-foreground' : done ? 'bg-primary/25 text-primary-soft' : 'bg-tint-strong text-muted-foreground')}>
              {done ? <Check size={14} aria-hidden /> : index + 1}</span>
            <span className={cn('truncate font-display text-xs font-semibold sm:text-sm', !current && 'max-sm:sr-only')}>{step.label}</span>
          </button>
          {index < STEPS.length - 1 && <span aria-hidden className={cn('h-px w-3 shrink-0 sm:w-6', index < activeIndex ? 'bg-primary/60' : 'bg-border')} />}
        </li>;
      })}
    </ol>
  </nav>;
}
