import Link from 'next/link';
import { AppShell } from '@/components/app-shell';
import { CreateClipsFlow } from '@/components/create-clips-flow';
import { CreationSession } from '@/components/creation-session';
import { getProject, type Project } from '@/lib/api';

export const metadata = { title: 'Create clips' };

export default async function CreatePage({ searchParams }: {
  searchParams?: Promise<{ session?: string }>;
}) {
  const session = (await searchParams)?.session;
  let project: Project | null = null;
  let unavailable = false;
  if (session) {
    try { project = await getProject(session, { cache: 'no-store' }); }
    catch { unavailable = true; }
  }
  return <AppShell>
    <div className='mx-auto grid w-full max-w-[920px] min-w-0 gap-6'>
      <header className='flex flex-wrap items-end justify-between gap-3'>
        <div>
          <p className='eyebrow'>XeeClip</p>
          <h1 className='mt-2 text-[30px] font-bold leading-tight tracking-tight sm:text-4xl'>Create clips</h1>
          <p className='mt-2 text-sm leading-6 text-slate-400 sm:text-base'>Turn a long video into short clips.</p>
        </div>
        {session ? <Link href='/' className='inline-flex h-10 items-center rounded-xl border border-white/10 px-4 text-sm font-medium text-slate-200 hover:bg-white/[.05]'>Create another</Link> : null}
      </header>
      {project ? <CreationSession initialProject={project} />
        : unavailable ? <div role='alert' className='rounded-2xl border border-amber-400/20 bg-amber-400/10 p-5 text-sm text-amber-100'>Your clips could not be loaded right now. Refresh when the processing server is available. Your finished clips remain in <Link className='underline' href='/history'>History</Link>.</div>
          : <div className='mx-auto w-full max-w-[720px] rounded-[24px] border border-white/[.08] bg-[#0d111c] p-4 sm:p-6'><CreateClipsFlow /></div>}
    </div>
  </AppShell>;
}
