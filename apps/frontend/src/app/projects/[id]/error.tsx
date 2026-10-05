'use client';

import Link from 'next/link';

export default function ProjectLoadError({ reset }: { error: Error & { digest?: string };
  reset: () => void }) {
  return <main className='grid min-h-screen place-items-center bg-[#070a12] p-6 text-slate-100'>
    <section role='alert' className='max-w-md rounded-2xl border border-amber-400/20 bg-amber-400/10 p-6 text-center'>
      <h1 className='text-base font-semibold'>Project unavailable</h1>
      <p className='mt-2 text-sm text-amber-100'>Processing server is currently unavailable or the project could not be loaded. Check that the laptop, Docker, and tunnel are running.</p>
      <div className='mt-4 flex justify-center gap-4 text-sm font-semibold'>
        <button type='button' onClick={reset} className='rounded-lg bg-white px-4 py-2 text-black'>Retry</button>
        <Link href='/dashboard' className='rounded-lg border border-white/20 px-4 py-2'>Dashboard</Link>
      </div>
    </section>
  </main>;
}
