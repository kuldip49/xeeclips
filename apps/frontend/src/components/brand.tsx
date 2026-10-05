import { cn } from '@/lib/utils';

/** The XeeClip mark used across the landing page and workspace. */
export function BrandMark({ className }: { className?: string }) {
  return <span aria-hidden className={cn('grid shrink-0 place-items-center overflow-hidden', className)}>
    <img src='/xeeclip-logo.png' alt='' className='h-full w-full object-contain' />
  </span>;
}
