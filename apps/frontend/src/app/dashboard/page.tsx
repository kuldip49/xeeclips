import Link from 'next/link';
import { ArrowRight, BarChart3, CirclePlay, Clapperboard, FolderKanban, Plus, Scissors, Sparkles } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { CreateProjectForm } from '@/components/create-project-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getGeneratedClips, listProjects, listVideos } from '@/lib/api';

function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export default async function DashboardPage() {
  const auth: RequestInit = {};
  const [projectResult, videoResult] = await Promise.allSettled([listProjects(auth), listVideos(undefined, auth)]);
  const projects = projectResult.status === 'fulfilled' ? projectResult.value : [];
  const videos = videoResult.status === 'fulfilled' ? videoResult.value : [];
  const loadFailed = projectResult.status === 'rejected' || videoResult.status === 'rejected';
  const serverUnavailable = [projectResult, videoResult].some((result) =>
    result.status === 'rejected' && result.reason instanceof Error &&
    result.reason.message === 'Processing server is currently unavailable.');
  const active = videos.filter((video) => video.processingJobs?.[0]?.status === 'PROCESSING' || video.processingJobs?.[0]?.status === 'PENDING');
  const completed = videos.filter((video) => video.processingJobs?.[0]?.status === 'COMPLETED');
  const clipResults = await Promise.allSettled(completed.map(async (video) => ({ video, clips: await getGeneratedClips(video.id, auth) })));
  const generatedClips = clipResults.flatMap((result) => result.status === 'fulfilled' ? result.value.clips.map((clip) => ({ clip, video: result.value.video })) : []);
  return <AppShell title='Dashboard'>
    <div className='grid gap-8'>
      {loadFailed && <div role='alert' className='flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-400/20 bg-amber-400/10 p-4 text-sm text-amber-100'><span>{serverUnavailable ? 'Processing server is currently unavailable. Check that the laptop, Docker, and tunnel are running.' : 'Some workspace data could not be loaded. Please try again.'}</span><Link href='/dashboard' className='font-semibold underline underline-offset-4'>Retry</Link></div>}
      <header className='flex flex-col justify-between gap-5 sm:flex-row sm:items-end'>
        <div><p className='eyebrow'>Overview</p><h1 className='mt-2 text-3xl font-bold tracking-tight md:text-4xl'>Welcome to your workspace</h1><p className='mt-3 max-w-2xl text-sm leading-6 text-slate-400'>Create a project, upload a source video, and turn its strongest moments into clips.</p></div>
        <a href='#new-project' className='inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-violet-500 px-4 text-sm font-semibold shadow-lg shadow-violet-500/20 transition hover:-translate-y-0.5 hover:bg-violet-400'><Plus size={16} />New project</a>
      </header>

      <section id='analytics' className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4' aria-label='Workspace metrics'>
        {[
          { label: 'Total projects', value: projects.length, icon: FolderKanban, color: 'text-violet-400' },
          { label: 'Source videos', value: videos.length, icon: CirclePlay, color: 'text-cyan-400' },
          { label: 'Processing now', value: active.length, icon: Sparkles, color: 'text-amber-400' },
          { label: 'Ready for clips', value: completed.length, icon: Scissors, color: 'text-emerald-400' }
        ].map(({ label, value, icon: Icon, color }) => <Card key={label} className='p-5'><div className='flex items-center justify-between'><span className='text-sm text-slate-400'>{label}</span><span className='rounded-xl bg-white/[.04] p-2'><Icon className={color} size={18} aria-hidden /></span></div><p className='mt-5 text-3xl font-bold tabular-nums'>{value}</p></Card>)}
      </section>

      <div className='grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,.9fr)]'>
        <section id='projects' className='min-w-0 scroll-mt-24'><Card className='h-full'><CardHeader><CardTitle>Recent projects</CardTitle><CardDescription>Your video workspaces, ready to pick up where you left off.</CardDescription></CardHeader><CardContent className='grid gap-3'>{projects.length ? projects.map((project) => <Link href={`/projects/${project.id}`} key={project.id} className='group flex min-w-0 items-center justify-between gap-4 rounded-2xl border border-white/[.08] bg-white/[.02] p-4 transition hover:-translate-y-0.5 hover:border-violet-400/30 hover:bg-[#151d2e]'><span className='flex min-w-0 items-center gap-3'><span className='grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-violet-500/10 text-violet-300'><FolderKanban size={19} /></span><span className='min-w-0'><span className='block truncate text-sm font-semibold'>{project.name}</span><span className='mt-1 block truncate text-xs text-slate-400'>{project.description || 'Video workspace'} · {project.videos.length} videos</span></span></span><ArrowRight className='shrink-0 text-slate-500 transition group-hover:translate-x-1 group-hover:text-violet-300' size={16} /></Link>) : <div className='empty-state'><FolderKanban className='text-violet-400' size={26} /><h3 className='mt-4 font-semibold'>No projects yet</h3><p className='mt-1 max-w-xs text-sm text-slate-400'>Create your first workspace to start turning video into content.</p><a href='#new-project' className='mt-4 text-sm font-semibold text-violet-300'>Create a project →</a></div>}</CardContent></Card></section>
        <section id='new-project' className='scroll-mt-24'><Card className='h-full border-violet-400/20 bg-gradient-to-br from-[#15162a] to-[#111827]'><CardHeader><div className='mb-3 grid h-11 w-11 place-items-center rounded-xl bg-violet-500/15 text-violet-300'><Sparkles size={20} /></div><CardTitle>Start something new</CardTitle><CardDescription>Give your next source video a home.</CardDescription></CardHeader><CardContent><CreateProjectForm /></CardContent></Card></section>
      </div>

      <section id='processing' className='scroll-mt-24'><Card><CardHeader><div className='flex items-center justify-between gap-3'><div><CardTitle>Processing jobs & videos</CardTitle><CardDescription className='mt-1'>Open a project to track progress and create clips.</CardDescription></div><Clapperboard className='text-slate-500' size={20} /></div></CardHeader><CardContent className='grid gap-3'>{videos.length ? videos.map((video) => <Link href={`/projects/${video.projectId}`} key={video.id} className='flex min-w-0 flex-col gap-3 rounded-2xl border border-white/[.08] bg-white/[.02] p-4 transition hover:border-violet-400/30 hover:bg-[#151d2e] sm:flex-row sm:items-center sm:justify-between'><span className='flex min-w-0 items-center gap-3'><span className='grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-cyan-400/10 text-cyan-300'><CirclePlay size={19} /></span><span className='min-w-0'><span className='block truncate text-sm font-semibold'>{video.originalName}</span><span className='block truncate text-xs text-slate-400'>{video.project?.name || 'Project'} · {formatBytes(video.sizeBytes)}</span></span></span><span className='flex items-center gap-3 sm:shrink-0'><span className='rounded-full border border-white/10 px-3 py-1 text-xs text-slate-300'>{video.processingJobs?.[0]?.status?.toLowerCase() || 'uploaded'}</span><ArrowRight size={16} className='text-slate-500' /></span></Link>) : <div className='empty-state'><CirclePlay className='text-cyan-400' size={26} /><h3 className='mt-4 font-semibold'>No videos in progress</h3><p className='mt-1 max-w-sm text-sm text-slate-400'>Your uploads and processing jobs will appear here after you add a video to a project.</p><a href='#projects' className='mt-4 text-sm font-semibold text-violet-300'>Browse projects →</a></div>}</CardContent></Card></section>
      <section id='clips' className='scroll-mt-24'><Card><CardHeader><CardTitle>Generated clips</CardTitle><CardDescription>Exported moments from your processed videos.</CardDescription></CardHeader><CardContent className='grid gap-3 sm:grid-cols-2'>{generatedClips.length ? generatedClips.map(({ clip, video }) => <Link key={clip.id} href={`/projects/${video.projectId}`} className='flex min-w-0 items-center gap-3 rounded-2xl border border-white/[.08] bg-white/[.02] p-4 transition hover:border-violet-400/30 hover:bg-[#151d2e]'><span className='grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-violet-500/10 text-violet-300'><Scissors size={19} /></span><span className='min-w-0'><span className='block truncate text-sm font-semibold'>{clip.candidate?.title || `Clip from ${video.originalName}`}</span><span className='mt-1 block truncate text-xs text-slate-400'>{video.originalName} · {clip.duration.toFixed(1)} sec</span></span><ArrowRight className='ml-auto shrink-0 text-slate-500' size={16} /></Link>) : <div className='empty-state sm:col-span-2'><Scissors className='text-violet-300' size={26} /><h3 className='mt-4 font-semibold'>No clips yet</h3><p className='mt-1 max-w-xs text-sm text-slate-400'>Generated clips will appear here after you create them in a project.</p><a href='#projects' className='mt-4 text-sm font-semibold text-violet-300'>Browse projects →</a></div>}</CardContent></Card></section>
      <section id='settings' className='scroll-mt-24 rounded-2xl border border-white/[.08] bg-[#0d111c] p-5'><div className='flex items-start gap-3'><BarChart3 className='mt-0.5 text-slate-400' size={18} /><div><h2 className='text-sm font-semibold'>Workspace insights</h2><p className='mt-1 text-sm text-slate-400'>Open a processed project to choose an output style and create clips. The target platform is chosen with each upload.</p></div></div></section>
    </div>
  </AppShell>;
}
