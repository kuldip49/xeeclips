'use client';

import Link from 'next/link';
import { CloudOff } from 'lucide-react';

export default function EditModeProjectError({ reset }: { error: Error & { digest?: string };
  reset: () => void }) {
  return <main className='grid min-h-[100dvh] place-items-center bg-[#070a12] px-4 py-8 text-slate-100'>
    <section role='alert' className='w-full max-w-md rounded-[24px] border border-red-400/20 bg-red-400/[.08] p-6 text-center'>
      <span className='mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-red-400/15 text-red-200'><CloudOff size={22} aria-hidden /></span>
      <h1 className='mt-4 text-lg font-semibold'>This edit could not be opened</h1>
      <p className='mt-2 text-sm leading-6 text-red-100/85'>The processing server may be offline. Try again in a moment.</p>
      <p className='mt-1 text-[11px] uppercase tracking-wider text-red-200/50'>PROJECT_LOAD_FAILED</p>
      <div className='mt-5 grid gap-2 text-sm font-semibold sm:grid-cols-2'>
        <button type='button' onClick={reset} className='pressable h-12 rounded-xl bg-white px-4 text-black'>Retry</button>
        <Link href='/edit-mode' className='pressable grid h-12 place-items-center rounded-xl border border-white/20 px-4'>Your edits</Link>
      </div>
    </section>
  </main>;
}
