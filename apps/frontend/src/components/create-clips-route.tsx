'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CreateClipsFlow } from '@/components/create-clips-flow';
import { CreationSession } from '@/components/creation-session';
import { getProject, type Project } from '@/lib/api';

/** The Create page body: the one-step form, or a creation session (`?session=<projectId>`). */
export function CreateClipsView({ session, project, unavailable }: {
  session: string | null; project: Project | null; unavailable: boolean;
}) {
  return <div className='mx-auto grid w-full max-w-[920px] min-w-0 grid-cols-[minmax(0,1fr)] gap-6'>
    <header className='flex flex-wrap items-end justify-between gap-3'>
      <div>
        <p className='eyebrow'>XeeClip</p>
        <h1 className='mt-2 text-[30px] font-bold leading-tight tracking-tight sm:text-4xl'>Create clips</h1>
        <p className='mt-2 text-sm leading-6 text-muted-foreground sm:text-base'>Turn a long video into short clips.</p>
      </div>
      {session ? <Link href='/' className='inline-flex h-10 items-center rounded-xl border border-border px-4 text-sm font-medium text-soft hover:bg-tint'>Create another</Link> : null}
    </header>
    {project ? <CreationSession initialProject={project} />
      : unavailable ? <div role='alert' className='rounded-2xl border border-warning/20 bg-warning/10 p-5 text-sm text-warning-soft'>Your clips could not be loaded right now. Refresh when the processing server is available. Your finished clips remain in <Link className='underline' href='/history'>History</Link>.</div>
        : session ? <div role='status' aria-label='Loading your clips' className='grid gap-3'>
          <div className='skeleton h-20 w-full rounded-2xl' /><div className='skeleton h-14 w-full rounded-2xl' />
          <div className='skeleton h-72 w-full rounded-[20px]' /></div>
          : <div className='mx-auto w-full max-w-[720px] rounded-[24px] border border-border bg-surface p-4 sm:p-6'><CreateClipsFlow /></div>}
  </div>;
}

/** Reads `?session=` and loads that project in the browser (the frontend is a static site). */
export function CreateClipsRoute() {
  const session = useSearchParams().get('session');
  const [loaded, setLoaded] = useState<{ id: string; project: Project | null; unavailable: boolean } | null>(null);
  useEffect(() => {
    if (!session) return undefined;
    let active = true;
    getProject(session)
      .then((project) => { if (active) setLoaded({ id: session, project, unavailable: false }); })
      .catch(() => { if (active) setLoaded({ id: session, project: null, unavailable: true }); });
    return () => { active = false; };
  }, [session]);
  const current = session && loaded?.id === session ? loaded : null;
  return <CreateClipsView session={session} project={current?.project ?? null} unavailable={current?.unavailable ?? false} />;
}
