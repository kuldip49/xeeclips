import { Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type GenerationStage = 'ANALYZING' | 'FINDING' | 'CREATING' | 'STYLING' | 'READY';

const ORDER: GenerationStage[] = ['ANALYZING', 'FINDING', 'CREATING', 'STYLING', 'READY'];

/** Map the plain-language analysis label onto the coarse stage it belongs to. */
export function stageFromAnalysisLabel(label: string): GenerationStage {
  return /finding/i.test(label) ? 'FINDING' : 'ANALYZING';
}

/**
 * Where a generation is, at a glance: Analyzing → Finding moments → Creating clips → (style) →
 * Ready. Compact enough for a phone; the detailed label stays in the status line above it.
 */
export function StageSteps({ stage, styleName, className }: {
  stage: GenerationStage;
  /** e.g. "Automatic 2"; omits the styling step when the clips have no style pass. */
  styleName?: string | null;
  className?: string;
}) {
  const steps = ORDER.filter((step) => step !== 'STYLING' || styleName);
  const current = steps.indexOf(stage === 'STYLING' && !styleName ? 'CREATING' : stage);
  const labels: Record<GenerationStage, string> = {
    ANALYZING: 'Analyzing', FINDING: 'Finding moments', CREATING: 'Creating clips',
    STYLING: `Applying ${styleName ?? 'style'}`, READY: 'Ready'
  };
  return <ol aria-label='Generation progress' data-testid='stage-steps'
    className={cn('flex min-w-0 items-center gap-1 overflow-hidden text-[11px]', className)}>
    {steps.map((step, index) => {
      const done = index < current || (step === 'READY' && current === index);
      const active = index === current && step !== 'READY';
      return <li key={step} aria-current={active ? 'step' : undefined}
        className={cn('flex min-w-0 items-center gap-1', index > 0 && 'before:h-px before:w-2 before:shrink-0 before:bg-white/15 sm:before:w-4',
          active ? 'shrink-0 text-violet-100' : 'text-slate-500', done && 'text-emerald-300/90')}>
        <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full border',
          active ? 'border-violet-400/60 bg-violet-500/20' : done ? 'border-emerald-400/40 bg-emerald-400/10' : 'border-white/10')}>
          {active ? <Loader2 size={11} className='animate-spin' aria-hidden /> : done ? <Check size={11} aria-hidden /> : <span className='h-1 w-1 rounded-full bg-current' />}
        </span>
        <span className={cn('truncate', !active && 'hidden sm:inline')}>{labels[step]}</span>
      </li>;
    })}
  </ol>;
}
