'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CloudOff, Loader2, RotateCw } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The one way the app says the processing server (the laptop API) is not reachable. Short on
 * purpose: no stack traces or status codes, and a Retry that re-checks rather than reloads blindly.
 */
export function OfflineNotice({ onRetry, className, detail }: {
  /** Re-check the server; defaults to refreshing the server-rendered page. */
  onRetry?: () => Promise<unknown> | unknown;
  className?: string;
  detail?: string;
}) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  async function retry() {
    setRetrying(true);
    try { if (onRetry) await onRetry(); else router.refresh(); }
    finally { window.setTimeout(() => setRetrying(false), 600); }
  }
  return <div role='alert' data-testid='offline-notice'
    className={cn('flex items-start gap-3 rounded-2xl border border-amber-400/20 bg-amber-400/[.08] p-3.5 text-sm text-amber-50 sm:items-center sm:p-4', className)}>
    <span className='grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-400/15 text-amber-300'><CloudOff size={18} aria-hidden /></span>
    <div className='min-w-0 flex-1'>
      <p className='font-semibold'>Processing server is currently offline.</p>
      <p className='mt-0.5 text-xs leading-5 text-amber-100/75'>{detail ?? 'You can keep browsing. Uploads and clip generation resume when it is back.'}</p>
    </div>
    <button type='button' onClick={() => void retry()} disabled={retrying}
      className='pressable inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-amber-300/30 px-3 text-xs font-semibold text-amber-50 hover:bg-amber-300/10 disabled:opacity-60'>
      {retrying ? <Loader2 size={14} className='animate-spin' aria-hidden /> : <RotateCw size={14} aria-hidden />}Retry</button>
  </div>;
}
