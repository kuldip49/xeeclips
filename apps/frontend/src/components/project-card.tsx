import Link from 'next/link';
import { ChevronRight, FolderKanban } from 'lucide-react';
import type { Project } from '@/lib/api';
import { sourcePosterUrl } from '@/lib/creative-generation';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

function projectStatus(project: Project) {
  const job = project.videos[0]?.processingJobs?.[0];
  if (!project.videos.length) return { label: 'No video yet', tone: 'border-white/10 text-slate-400' };
  if (job?.status === 'FAILED') return { label: 'Failed', tone: 'border-red-400/25 bg-red-400/10 text-red-200' };
  if (job?.status === 'COMPLETED') return { label: 'Ready', tone: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200' };
  return { label: job ? `Processing ${Math.max(0, Math.min(100, job.progress ?? 0))}%` : 'Uploaded',
    tone: 'border-amber-400/25 bg-amber-400/10 text-amber-100' };
}

/**
 * A project as a tappable card: poster of its latest source, name, status and when it last
 * changed. The whole card is one link (one large target) - there are no nested buttons.
 */
export function ProjectCard({ project }: { project: Project }) {
  const latest = project.videos[0];
  const status = projectStatus(project);
  const updated = latest?.updatedAt ?? project.updatedAt;
  return <Link href={`/projects/${project.id}`} data-testid='project-card'
    className='pressable group flex min-w-0 items-center gap-3 rounded-2xl border border-white/[.08] bg-white/[.02] p-2.5 pr-3 transition hover:border-violet-400/30 hover:bg-[#151d2e] sm:p-3'>
    <span className='relative grid h-16 w-24 shrink-0 place-items-center overflow-hidden rounded-xl bg-gradient-to-br from-violet-900/40 to-cyan-900/20 text-violet-300 sm:h-[72px] sm:w-[112px]'>
      <FolderKanban size={20} aria-hidden />
      {latest ? <img src={sourcePosterUrl(latest.id)} alt='' loading='lazy' decoding='async'
        className='absolute inset-0 h-full w-full object-cover' /> : null}
    </span>
    <span className='min-w-0 flex-1'>
      <span className='block truncate text-[15px] font-semibold sm:text-sm'>{project.name}</span>
      <span className='mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400'>
        <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', status.tone)}>{status.label}</span>
        <span className='truncate'>{project.videos.length} video{project.videos.length === 1 ? '' : 's'} · {timeAgo(updated)}</span>
      </span>
    </span>
    <ChevronRight className='shrink-0 text-slate-500 transition group-hover:translate-x-0.5 group-hover:text-violet-300' size={18} aria-hidden />
  </Link>;
}

export function ProjectCardSkeleton() {
  return <div className='flex items-center gap-3 rounded-2xl border border-white/[.06] p-2.5'>
    <div className='skeleton h-16 w-24 shrink-0 rounded-xl' />
    <div className='grid flex-1 gap-2'><div className='skeleton h-4 w-3/4' /><div className='skeleton h-3 w-1/2' /></div>
  </div>;
}
