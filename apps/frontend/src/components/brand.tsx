import { Clapperboard } from 'lucide-react';
import { cn } from '@/lib/utils';

/** The XeeClip mark: the same violet→cyan tile everywhere the brand appears. */
export function BrandMark({ className }: { className?: string }) {
  return <span aria-hidden className={cn('grid shrink-0 place-items-center bg-gradient-to-br from-violet-500 to-cyan-400 text-white shadow-lg shadow-violet-500/20', className)}>
    <Clapperboard className='h-[52%] w-[52%]' strokeWidth={2.2} />
  </span>;
}
