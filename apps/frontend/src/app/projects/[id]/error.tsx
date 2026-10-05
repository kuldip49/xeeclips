'use client';

import Link from 'next/link';
import { CloudOff } from 'lucide-react';

export default function ProjectLoadError({ reset }: { error: Error & { digest?: string };
  reset: () => void }) {
  return <main className='grid min-h-[100dvh] place-items-center bg-[#070a12] px-4 py-8 text-slate-100'>
    <section role='alert' className='w-full max-w-md rounded-[24px] border border-amber-400/20 bg-amber-400/[.08] p-6 text-center'>
      <span className='mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-amber-400/15 text-amber-300'><CloudOff size={22} aria-hidden /></span>
      <h1 className='mt-4 text-lg font-semibold'>Project unavailable</h1>
      <p className='mt-2 text-sm leading-6 text-amber-100/85'>Processing server is currently offline, or this project could not be loaded. Try again in a moment.</p>
      <div className='mt-5 grid gap-2 text-sm font-semibold sm:grid-cols-2'>
        <button type='button' onClick={reset} className='pressable h-12 rounded-xl bg-white px-4 text-black'>Retry</button>
        <Link href='/dashboard' className='pressable grid h-12 place-items-center rounded-xl border border-white/20 px-4'>Home</Link>
      </div>
    </section>
  </main>;
}
