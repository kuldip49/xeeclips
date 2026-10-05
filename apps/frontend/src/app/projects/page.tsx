import Link from 'next/link';
import { FolderKanban, Sparkles } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { OfflineNotice } from '@/components/offline-notice';
import { ProjectCard } from '@/components/project-card';
import { listProjects, type Project } from '@/lib/api';

export const metadata = { title: 'Projects' };

export default async function ProjectsPage() {
  let projects: Project[] = [];
  let failure: 'offline' | 'error' | null = null;
  try {
    projects = await listProjects({});
  } catch (error) {
    failure = error instanceof Error && error.message === 'Processing server is currently unavailable.' ? 'offline' : 'error';
  }
  return <AppShell title='Projects'>
    <div className='grid gap-5'>
      <header className='flex items-end justify-between gap-3'>
        <div><p className='eyebrow'>Library</p><h1 className='mt-2 text-[26px] font-bold tracking-tight md:text-3xl'>Projects</h1>
          <p className='mt-1 text-sm text-slate-400'>{failure ? 'Your projects appear here.' : `${projects.length} project${projects.length === 1 ? '' : 's'}`}</p></div>
        <Link href='/create' className='pressable hidden h-11 items-center gap-2 rounded-xl bg-violet-500 px-4 text-sm font-semibold lg:inline-flex'><Sparkles size={16} aria-hidden />Create clips</Link>
      </header>
      {failure === 'offline' ? <OfflineNotice /> : failure ? <div role='alert' className='rounded-2xl border border-amber-400/20 bg-amber-400/10 p-4 text-sm text-amber-100'>Projects could not be loaded. Please try again.</div> : null}
      {projects.length ? <div className='grid gap-2.5 md:grid-cols-2 2xl:grid-cols-3'>{projects.map((project) => <ProjectCard key={project.id} project={project} />)}</div>
        : !failure ? <div className='empty-state'><FolderKanban className='text-violet-400' size={26} /><h2 className='mt-4 font-semibold'>No projects yet</h2><p className='mt-1 max-w-xs text-sm text-slate-400'>Paste a YouTube link or upload a video to make your first clips.</p><Link href='/create' className='pressable mt-5 inline-flex h-12 items-center gap-2 rounded-2xl bg-violet-500 px-5 text-sm font-semibold'><Sparkles size={16} aria-hidden />Create your first clips</Link></div> : null}
    </div>
  </AppShell>;
}
