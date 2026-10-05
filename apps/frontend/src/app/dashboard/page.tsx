import Link from 'next/link';
import { ArrowRight, BarChart3, CirclePlay, Clapperboard, FolderKanban, Plus, Scissors, Sparkles } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { CreateProjectForm } from '@/components/create-project-form';
import { OfflineNotice } from '@/components/offline-notice';
import { ProjectCard } from '@/components/project-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getGeneratedClips, listProjects, listVideos } from '@/lib/api';
import { formatBytes } from '@/lib/format';

const RECENT_PROJECTS = 6;
/** Phones show the first few rows of each long list; desktop shows them all. */
const MOBILE_LIST_LIMIT = 5;

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
  return <AppShell title='Home'>
    <div className='grid gap-6 md:gap-8'>
      {serverUnavailable ? <OfflineNotice />
        : loadFailed ? <div role='alert' className='flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-400/20 bg-amber-400/10 p-4 text-sm text-amber-100'><span>Some workspace data could not be loaded. Please try again.</span><Link href='/dashboard' className='font-semibold underline underline-offset-4'>Retry</Link></div> : null}

      <header className='relative overflow-hidden rounded-[24px] border border-violet-400/15 bg-gradient-to-br from-[#191a35] via-[#121628] to-[#0d111c] p-5 sm:p-6 md:rounded-none md:border-0 md:bg-none md:p-0'>
        <div aria-hidden className='pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-violet-600/25 blur-[70px] md:hidden' />
        <div className='relative flex flex-col justify-between gap-5 sm:flex-row sm:items-end'>
          <div><p className='eyebrow'>Overview</p><h1 className='mt-2 text-[26px] font-bold leading-tight tracking-tight md:text-4xl'>Welcome to your workspace</h1><p className='mt-2 max-w-2xl text-sm leading-6 text-slate-400 md:mt-3'>Turn long videos into short clips. Paste a YouTube link or upload a video and pick how many clips you want.</p></div>
          <div className='flex flex-col gap-2 sm:flex-row'>
            <Link href='/create' className='pressable inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-violet-500 px-5 text-[15px] font-semibold shadow-lg shadow-violet-500/25 transition hover:bg-violet-400 md:h-11 md:rounded-xl md:text-sm'><Sparkles size={17} aria-hidden />Create clips</Link>
            <a href='#new-project' className='hidden h-11 items-center justify-center gap-2 rounded-xl border border-white/10 px-4 text-sm font-semibold transition hover:bg-white/5 md:inline-flex'><Plus size={16} />New project</a>
          </div>
        </div>
      </header>

      <section id='analytics' className='grid scroll-mt-24 grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4' aria-label='Workspace metrics'>
        {[
          { label: 'Projects', value: projects.length, icon: FolderKanban, color: 'text-violet-400' },
          { label: 'Source videos', value: videos.length, icon: CirclePlay, color: 'text-cyan-400' },
          { label: 'Processing now', value: active.length, icon: Sparkles, color: 'text-amber-400' },
          { label: 'Ready for clips', value: completed.length, icon: Scissors, color: 'text-emerald-400' }
        ].map(({ label, value, icon: Icon, color }) => <Card key={label} className='p-4 sm:p-5'><div className='flex items-center justify-between gap-2'><span className='truncate text-xs text-slate-400 sm:text-sm'>{label}</span><span className='shrink-0 rounded-xl bg-white/[.04] p-1.5 sm:p-2'><Icon className={color} size={17} aria-hidden /></span></div><p className='mt-3 text-2xl font-bold tabular-nums sm:mt-5 sm:text-3xl'>{value}</p></Card>)}
      </section>

      <div className='grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,.9fr)]'>
        <section id='projects' className='min-w-0 scroll-mt-24' aria-labelledby='recent-projects'>
          <Card className='h-full border-0 bg-transparent shadow-none sm:border sm:bg-[#111827] sm:shadow-[0_16px_40px_rgba(0,0,0,.14)]'>
            <CardHeader className='flex-row items-end justify-between gap-3 space-y-0 p-0 pb-3 sm:p-6 sm:pb-4'>
              <div className='min-w-0'><CardTitle id='recent-projects'>Recent projects</CardTitle><CardDescription className='mt-1.5 hidden sm:block'>Your video workspaces, ready to pick up where you left off.</CardDescription></div>
              {projects.length ? <Link href='/projects' className='inline-flex h-10 shrink-0 items-center gap-1 rounded-xl px-2 text-sm font-semibold text-violet-300 hover:bg-white/5'>View all<ArrowRight size={15} aria-hidden /></Link> : null}
            </CardHeader>
            <CardContent className='grid gap-2.5 p-0 sm:p-6 sm:pt-0'>{projects.length ? projects.slice(0, RECENT_PROJECTS).map((project) => <ProjectCard key={project.id} project={project} />)
              : <div className='empty-state'><FolderKanban className='text-violet-400' size={26} /><h3 className='mt-4 font-semibold'>No projects yet</h3><p className='mt-1 max-w-xs text-sm text-slate-400'>Turn your first long video into short clips in a couple of taps.</p><Link href='/create' className='pressable mt-5 inline-flex h-12 items-center gap-2 rounded-2xl bg-violet-500 px-5 text-sm font-semibold'><Sparkles size={16} aria-hidden />Create your first clips</Link></div>}</CardContent>
          </Card>
        </section>
        <section id='new-project' className='hidden scroll-mt-24 md:block'><Card className='h-full border-violet-400/20 bg-gradient-to-br from-[#15162a] to-[#111827]'><CardHeader><div className='mb-3 grid h-11 w-11 place-items-center rounded-xl bg-violet-500/15 text-violet-300'><Sparkles size={20} /></div><CardTitle>Start something new</CardTitle><CardDescription>Give your next source video a home.</CardDescription></CardHeader><CardContent><CreateProjectForm /></CardContent></Card></section>
      </div>

      <section id='processing' className='scroll-mt-24'><Card><CardHeader className='p-4 sm:p-6'><div className='flex items-center justify-between gap-3'><div><CardTitle>Processing jobs & videos</CardTitle><CardDescription className='mt-1'>Open a project to track progress and create clips.</CardDescription></div><Clapperboard className='hidden shrink-0 text-slate-500 sm:block' size={20} /></div></CardHeader><CardContent className='grid gap-2.5 p-4 pt-0 sm:p-6 sm:pt-0'>{videos.length ? videos.map((video, index) => <Link href={`/projects/${video.projectId}`} key={video.id} className={`${index >= MOBILE_LIST_LIMIT ? 'max-md:hidden ' : ''}pressable flex min-w-0 items-center justify-between gap-3 rounded-2xl border border-white/[.08] bg-white/[.02] p-3 transition hover:border-violet-400/30 hover:bg-[#151d2e] sm:p-4`}><span className='flex min-w-0 items-center gap-3'><span className='grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-cyan-400/10 text-cyan-300'><CirclePlay size={19} /></span><span className='min-w-0'><span className='block truncate text-sm font-semibold'>{video.originalName}</span><span className='block truncate text-xs text-slate-400'>{video.project?.name || 'Project'} · {formatBytes(video.sizeBytes)}</span></span></span><span className='flex shrink-0 items-center gap-2'><span className='rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-slate-300'>{video.processingJobs?.[0]?.status?.toLowerCase() || 'uploaded'}</span><ArrowRight size={16} className='hidden text-slate-500 sm:block' /></span></Link>).concat(videos.length > MOBILE_LIST_LIMIT ? [<Link key='more' href='/projects' className='flex h-11 items-center justify-center rounded-xl border border-white/[.08] text-sm font-semibold text-violet-300 md:hidden'>+{videos.length - MOBILE_LIST_LIMIT} more · View projects</Link>] : []) : <div className='empty-state'><CirclePlay className='text-cyan-400' size={26} /><h3 className='mt-4 font-semibold'>No videos in progress</h3><p className='mt-1 max-w-sm text-sm text-slate-400'>Your uploads and processing jobs will appear here after you add a video.</p><Link href='/create' className='mt-4 text-sm font-semibold text-violet-300'>Create clips →</Link></div>}</CardContent></Card></section>
      <section id='clips' className='scroll-mt-24'><Card><CardHeader className='p-4 sm:p-6'><CardTitle>Generated clips</CardTitle><CardDescription>Exported moments from your processed videos.</CardDescription></CardHeader><CardContent className='grid gap-2.5 p-4 pt-0 sm:grid-cols-2 sm:p-6 sm:pt-0'>{generatedClips.length ? generatedClips.map(({ clip, video }, index) => <Link key={clip.id} href={`/projects/${video.projectId}`} className={`${index >= MOBILE_LIST_LIMIT ? 'max-md:hidden ' : ''}pressable flex min-w-0 items-center gap-3 rounded-2xl border border-white/[.08] bg-white/[.02] p-3 transition hover:border-violet-400/30 hover:bg-[#151d2e] sm:p-4`}><span className='grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-violet-500/10 text-violet-300'><Scissors size={19} /></span><span className='min-w-0'><span className='block truncate text-sm font-semibold'>{clip.candidate?.title || `Clip from ${video.originalName}`}</span><span className='mt-1 block truncate text-xs text-slate-400'>{video.originalName} · {clip.duration.toFixed(1)} sec</span></span><ArrowRight className='ml-auto shrink-0 text-slate-500' size={16} /></Link>).concat(generatedClips.length > MOBILE_LIST_LIMIT ? [<p key='more' className='text-center text-xs text-slate-500 md:hidden'>Showing {MOBILE_LIST_LIMIT} of {generatedClips.length} clips. Open a project to see all of its clips.</p>] : []) : <div className='empty-state sm:col-span-2'><Scissors className='text-violet-300' size={26} /><h3 className='mt-4 font-semibold'>No clips yet</h3><p className='mt-1 max-w-xs text-sm text-slate-400'>Generated clips will appear here after you create them in a project.</p><Link href='/create' className='mt-4 text-sm font-semibold text-violet-300'>Create clips →</Link></div>}</CardContent></Card></section>
      <section id='settings' className='scroll-mt-24 rounded-2xl border border-white/[.08] bg-[#0d111c] p-4 sm:p-5'><div className='flex items-start gap-3'><BarChart3 className='mt-0.5 shrink-0 text-slate-400' size={18} /><div><h2 className='text-sm font-semibold'>Workspace insights</h2><p className='mt-1 text-sm text-slate-400'>Open a processed project to choose an output style and create clips. The target platform is chosen with each upload.</p></div></div></section>
    </div>
  </AppShell>;
}
