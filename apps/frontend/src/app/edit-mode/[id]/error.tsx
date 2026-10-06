'use client';

import Link from 'next/link';
import { CloudOff } from 'lucide-react';

export default function EditModeProjectError({ reset }: { error: Error & { digest?: string };
  reset: () => void }) {
  return <main className='grid min-h-[100dvh] place-items-center bg-background px-4 py-8 text-foreground'>
    <section role='alert' className='w-full max-w-md rounded-[24px] border border-danger/20 bg-danger/[.08] p-6 text-center'>
      <span className='mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-danger/15 text-danger-soft'><CloudOff size={22} aria-hidden /></span>
      <h1 className='mt-4 text-lg font-semibold'>This edit could not be opened</h1>
      <p className='mt-2 text-sm leading-6 text-danger-soft/85'>The processing server may be offline. Try again in a moment.</p>
      <div className='mt-5 grid gap-2 text-sm font-semibold sm:grid-cols-2'>
        <button type='button' onClick={reset} className='pressable btn-primary h-12 rounded-xl px-4'>Retry</button>
        <Link href='/history' className='pressable grid h-12 place-items-center rounded-xl border border-border-strong px-4'>History</Link>
      </div>
    </section>
  </main>;
}
