'use client';

import Link from 'next/link';
import { CloudOff } from 'lucide-react';

/** Editor-shaped skeleton shown while a project loads. */
export function EditModeLoadingScreen() {
  return <div className='flex h-[100dvh] flex-col bg-background' aria-busy='true' aria-label='Loading editor'>
    <div className='pt-safe border-b border-border bg-surface'><div className='flex h-12 items-center gap-3 px-3'>
      <div className='skeleton h-8 w-8 rounded-full' /><div className='skeleton h-4 w-40' /><div className='skeleton ml-auto h-8 w-20 rounded-xl' /></div></div>
    <div className='flex min-h-0 flex-1 items-center justify-center p-3'>
      <div className='skeleton aspect-[9/16] h-full max-h-[70vh] rounded-xl' /></div>
    <div className='skeleton mx-3 mb-3 h-[28dvh] max-h-[260px] rounded-xl md:h-[38vh] md:max-h-[440px]' />
    <span className='sr-only'>Loading editor…</span>
  </div>;
}

/** A project that could not be loaded (server offline, or no such project). */
export function EditModeLoadError({ onRetry }: { onRetry: () => void }) {
  return <main className='grid min-h-[100dvh] place-items-center bg-background px-4 py-8 text-foreground'>
    <section role='alert' className='w-full max-w-md rounded-[24px] border border-danger/20 bg-danger/[.08] p-6 text-center'>
      <span className='mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-danger/15 text-danger-soft'><CloudOff size={22} aria-hidden /></span>
      <h1 className='mt-4 text-lg font-semibold'>This edit could not be opened</h1>
      <p className='mt-2 text-sm leading-6 text-danger-soft/85'>The processing server may be offline. Try again in a moment.</p>
      <div className='mt-5 grid gap-2 text-sm font-semibold sm:grid-cols-2'>
        <button type='button' onClick={onRetry} className='pressable btn-primary h-12 rounded-xl px-4'>Retry</button>
        <Link href='/history' className='pressable grid h-12 place-items-center rounded-xl border border-border-strong px-4'>History</Link>
      </div>
    </section>
  </main>;
}
