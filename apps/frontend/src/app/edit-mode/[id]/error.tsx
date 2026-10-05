'use client';

export default function EditModeProjectError({ reset }: { error: Error & { digest?: string };
  reset: () => void }) {
  return <main className='grid min-h-screen place-items-center bg-[#070a12] p-6 text-slate-100'>
    <section role='alert' className='max-w-md rounded-2xl border border-red-400/20 bg-red-400/10 p-6 text-center'>
      <h1 className='text-base font-semibold'>PROJECT_LOAD_FAILED</h1>
      <p className='mt-2 text-sm text-red-100'>The edit project could not be loaded. The processing server may be unavailable; check the laptop, Docker, and tunnel.</p>
      <button type='button' onClick={reset}
        className='mt-4 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black'>Retry</button>
    </section>
  </main>;
}
