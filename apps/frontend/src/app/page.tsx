import Link from 'next/link';
import { ArrowRight, Captions, Clapperboard, Link2, ScanFace, Scissors, Sparkles, Type, Upload, WandSparkles } from 'lucide-react';
import { BrandMark } from '@/components/brand';
import { Button } from '@/components/ui/button';

const steps = [
  { icon: Link2, title: 'Add a video', body: 'Paste a YouTube link or upload from your phone.' },
  { icon: Sparkles, title: 'AI finds the moments', body: 'Transcript and visual signals pick the strongest parts.' },
  { icon: Scissors, title: 'Post-ready clips', body: 'Vertical clips with hooks, captions and hashtags.' }
];

const templates = [
  { name: 'Automatic 1', tone: 'from-violet-500/20 to-cyan-400/5', icon: Captions,
    points: ['Clean, modern automatic edit', 'Speaker framing and smart zooms', 'Captions with highlighted active words'] },
  { name: 'Automatic 2', tone: 'from-rose-500/15 to-amber-300/5', icon: Type,
    points: ['Editorial black frame, serif hook', 'Key words highlighted in red', 'Bigger speaker, sparse deliberate zooms'] }
];

const features = [
  { icon: Sparkles, title: 'Find the strongest moments', body: 'Upload once, choose how many clips you want, and we find and create the strongest moments.' },
  { icon: ScanFace, title: 'Understand every frame', body: 'Bring transcript and visual signals together to see what makes a moment work.' },
  { icon: Scissors, title: 'Create ready-to-share clips', body: 'Export clips with hooks, captions, hashtags, and a content package built around each moment.' }
];

export default function LandingPage() {
  return <main className='min-h-[100dvh] overflow-x-hidden bg-[#070a12] text-slate-50'>
    <header className='pt-safe mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-4 md:px-8 md:py-6'>
      <Link href='/' className='flex items-center gap-2.5 text-[15px] font-bold'><BrandMark className='h-9 w-9 rounded-xl md:h-10 md:w-10' />XeeClip</Link>
      <Button asChild variant='outline' className='h-11 rounded-full px-4 md:h-9 md:rounded-xl'><Link href='/dashboard'>Open workspace <ArrowRight size={15} /></Link></Button>
    </header>

    <section className='relative mx-auto grid max-w-[1440px] gap-10 px-4 pb-14 pt-8 md:px-8 md:pb-24 md:pt-24 lg:grid-cols-[1.1fr_.9fr] lg:items-center'>
      <div aria-hidden className='pointer-events-none absolute -right-24 top-0 h-72 w-72 rounded-full bg-violet-600/20 blur-[90px] md:-right-48 md:h-96 md:w-96' />
      <div className='relative'>
        <span className='inline-flex items-center gap-2 rounded-full border border-violet-400/20 bg-violet-500/10 px-3 py-1.5 text-xs font-semibold text-violet-200'><WandSparkles size={14} />AI short-form clip maker</span>
        <h1 className='mt-5 max-w-3xl text-[40px] font-bold leading-[1.05] tracking-tight sm:text-5xl md:mt-7 md:text-7xl'>Turn long videos into <span className='bg-gradient-to-r from-violet-400 to-cyan-300 bg-clip-text text-transparent'>short clips with AI.</span></h1>
        <p className='mt-4 max-w-xl text-base leading-7 text-slate-400 md:mt-7 md:leading-8'>Paste a link or upload a video. XeeClip finds the best moments and delivers vertical clips with hooks, captions and hashtags.</p>
        <div className='mt-7 grid gap-3 sm:flex sm:flex-wrap md:mt-9'>
          <Button asChild className='h-14 rounded-2xl px-6 text-base md:h-12 md:rounded-xl md:text-sm'><Link href='/create'><Sparkles size={18} />Create clips</Link></Button>
          <Button asChild className='h-12 rounded-2xl px-6 md:rounded-xl' variant='outline'><Link href='/projects'>View projects</Link></Button>
        </div>
      </div>
      <div className='relative hidden rounded-[28px] border border-white/10 bg-[#0d111c] p-4 shadow-[0_40px_100px_rgba(0,0,0,.4)] lg:block'><div className='flex items-center gap-2 border-b border-white/10 px-2 pb-4'><span className='h-2.5 w-2.5 rounded-full bg-red-400/70' /><span className='h-2.5 w-2.5 rounded-full bg-amber-400/70' /><span className='h-2.5 w-2.5 rounded-full bg-emerald-400/70' /><span className='ml-3 text-xs text-slate-500'>Creative workspace</span></div><div className='grid gap-4 p-2 sm:grid-cols-[.8fr_1.2fr]'><div className='grid gap-4'><div className='rounded-2xl border border-white/10 bg-[#111827] p-5'><p className='text-xs text-slate-400'>Source video</p><div className='mt-4 grid aspect-video place-items-center rounded-xl bg-gradient-to-br from-violet-900/30 to-cyan-900/20'><Clapperboard className='text-violet-300' size={34} /></div><p className='mt-4 text-sm font-semibold'>Your next big idea</p><p className='mt-1 text-xs text-slate-500'>Ready for analysis</p></div></div><div className='grid gap-4'><div className='rounded-2xl border border-violet-400/20 bg-gradient-to-br from-violet-500/15 to-cyan-400/5 p-5'><p className='text-xs font-semibold uppercase tracking-wider text-violet-300'>Your best moments</p><p className='mt-5 text-4xl font-bold'>Discover <span className='text-cyan-300'>more</span></p><p className='mt-2 text-xs leading-5 text-slate-400'>Clips chosen and cut automatically from your video.</p></div><div className='rounded-2xl border border-white/10 bg-[#111827] p-5'><p className='text-sm font-semibold'>A complete content package</p><div className='mt-4 grid gap-2'>{['Hook and synopsis', 'Caption', 'Hashtags'].map((item) => <div key={item} className='rounded-lg bg-white/[.04] px-3 py-2 text-xs text-slate-300'>✦ &nbsp;{item}</div>)}</div></div></div></div></div>
      <ol className='relative grid gap-2.5 lg:hidden' aria-label='How it works'>
        {steps.map(({ icon: Icon, title, body }, index) => <li key={title} className='flex items-center gap-3 rounded-2xl border border-white/[.08] bg-[#0d111c] p-3.5'>
          <span className='grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-violet-500/10 text-violet-300'><Icon size={20} aria-hidden /></span>
          <span className='min-w-0'><span className='block text-sm font-semibold'><span className='text-slate-500'>{index + 1}.</span> {title}</span><span className='block text-xs leading-5 text-slate-400'>{body}</span></span>
        </li>)}
      </ol>
    </section>

    <section className='border-t border-white/[.08]'>
      <div className='mx-auto max-w-[1440px] px-4 py-12 md:px-8 md:py-20'>
        <p className='eyebrow'>Two automatic looks</p>
        <h2 className='mt-3 max-w-xl text-2xl font-bold tracking-tight md:text-3xl'>Pick a template. We do the editing.</h2>
        <div className='mt-6 grid gap-3 md:mt-9 md:grid-cols-2 md:gap-4'>
          {templates.map(({ name, tone, icon: Icon, points }) => <article key={name} className={`rounded-[20px] border border-white/[.08] bg-gradient-to-br ${tone} p-5 md:p-6`}>
            <div className='flex items-center gap-3'><span className='grid h-11 w-11 place-items-center rounded-xl bg-white/[.06] text-white'><Icon size={20} aria-hidden /></span><h3 className='text-lg font-semibold'>{name}</h3></div>
            <ul className='mt-4 grid gap-2 text-sm text-slate-300'>{points.map((point) => <li key={point} className='flex gap-2'><span className='text-violet-300'>✦</span>{point}</li>)}</ul>
          </article>)}
        </div>
      </div>
    </section>

    <section className='border-t border-white/[.08] bg-[#0d111c]'><div className='mx-auto max-w-[1440px] px-4 py-12 md:px-8 md:py-20'><p className='eyebrow'>How it works</p><h2 className='mt-3 max-w-xl text-2xl font-bold tracking-tight md:text-3xl'>Everything you need to go from video to content.</h2><div className='mt-6 grid gap-3 md:mt-9 md:grid-cols-3 md:gap-4'>{features.map(({ icon: Icon, title, body }) => <article key={title} className='rounded-[20px] border border-white/[.08] bg-[#111827] p-5 transition hover:-translate-y-1 hover:border-violet-400/30 md:p-6'><span className='grid h-11 w-11 place-items-center rounded-xl bg-violet-500/10 text-violet-300'><Icon size={20} /></span><h3 className='mt-4 font-semibold md:mt-6'>{title}</h3><p className='mt-2 text-sm leading-6 text-slate-400'>{body}</p></article>)}</div>
      <div className='mt-10 flex flex-col items-center gap-3 text-center'><p className='text-sm text-slate-400'>Ready when you are.</p><Button asChild className='h-14 w-full max-w-sm rounded-2xl text-base md:h-12 md:w-auto md:rounded-xl md:text-sm'><Link href='/create'><Upload size={18} />Create clips</Link></Button></div>
    </div></section>
    <footer className='pb-safe border-t border-white/[.06] px-4 py-6 text-center text-xs text-slate-500'>© XeeClip</footer>
  </main>;
}
