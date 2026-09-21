'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { BarChart3, Bell, Clapperboard, FolderKanban, LayoutDashboard, Menu, PenTool, Scissors, Settings, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';

const navigation = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Projects', href: '/dashboard#projects', icon: FolderKanban },
  { label: 'EditMode', href: '/edit-mode', icon: PenTool },
  { label: 'Generated Clips', href: '/dashboard#clips', icon: Scissors },
  { label: 'Analytics', href: '/dashboard#analytics', icon: BarChart3 },
  { label: 'Settings', href: '/dashboard#settings', icon: Settings }
];

function Sidebar({ close }: { close?: () => void }) {
  const pathname = usePathname();
  return <div className='flex h-full flex-col bg-[#0d111c] px-4 py-6'>
    <Link href='/dashboard' onClick={close} className='flex items-center gap-3 px-3'>
      <span className='grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-cyan-400 text-white shadow-lg shadow-violet-500/20'><Clapperboard size={21} aria-hidden /></span>
      <span className='min-w-0'><span className='block truncate text-sm font-bold tracking-tight'>AI Content</span><span className='block text-xs text-slate-400'>Creative workspace</span></span>
    </Link>
    <p className='mt-12 px-3 text-[11px] font-semibold uppercase tracking-[.18em] text-slate-500'>Workspace</p>
    <nav className='mt-4 grid gap-1' aria-label='Main navigation'>
      {navigation.map(({ label, href, icon: Icon }, index) => {
        const active = index === 0 ? pathname === '/dashboard' :
          href === '/edit-mode' ? pathname.startsWith('/edit-mode') : pathname === href;
        return <Link key={label} href={href} onClick={close} className={cn('flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition-colors hover:bg-[#151d2e] hover:text-white', active ? 'bg-violet-500/10 text-violet-300' : 'text-slate-400')}><Icon size={18} aria-hidden />{label}</Link>;
      })}
    </nav>
    <div className='mt-auto rounded-2xl border border-violet-400/10 bg-gradient-to-br from-violet-500/10 to-cyan-400/5 p-4'>
      <Sparkles className='text-violet-400' size={20} aria-hidden />
      <p className='mt-3 text-sm font-semibold'>Make every moment count</p>
      <p className='mt-1 text-xs leading-5 text-slate-400'>Turn long videos into ready-to-share clips.</p>
    </div>
  </div>;
}

export function AppShell({ children, title = 'Dashboard' }: { children: React.ReactNode; title?: string }) {
  const [open, setOpen] = useState(false);
  return <div className='min-h-screen bg-[#070a12] text-[#f8fafc]'>
    <aside className='fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-white/[.08] lg:block'><Sidebar /></aside>
    <AnimatePresence>{open && <><motion.button aria-label='Close navigation' className='fixed inset-0 z-40 bg-black/70 lg:hidden' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(false)} /><motion.aside className='fixed inset-y-0 left-0 z-50 w-72 border-r border-white/10 lg:hidden' initial={{ x: -288 }} animate={{ x: 0 }} exit={{ x: -288 }} transition={{ duration: .22 }}><Sidebar close={() => setOpen(false)} /><button className='absolute right-3 top-5 rounded-lg p-2 text-slate-400' aria-label='Close menu' onClick={() => setOpen(false)}><X size={20} /></button></motion.aside></>}</AnimatePresence>
    <div className='min-w-0 lg:pl-64'>
      <header className='sticky top-0 z-30 flex h-[72px] items-center justify-between border-b border-white/[.08] bg-[#0d111c]/95 px-4 backdrop-blur-xl md:px-6 lg:px-8'>
        <div className='flex min-w-0 items-center gap-3'><button aria-label='Open navigation' className='rounded-xl p-2 text-slate-300 hover:bg-white/5 lg:hidden' onClick={() => setOpen(true)}><Menu size={21} /></button><div><p className='text-xs text-slate-500'>Workspace / Overview</p><p className='truncate text-sm font-semibold'>{title}</p></div></div>
        <div className='flex items-center gap-3'><span className='hidden text-xs text-slate-400 sm:block'>Your creative dashboard</span><span className='rounded-xl border border-white/[.08] p-2 text-slate-400' aria-label='Notifications'><Bell size={17} aria-hidden /></span><span className='grid h-9 w-9 place-items-center rounded-full bg-violet-500/20 text-xs font-bold text-violet-200' aria-label='Profile'>AC</span></div>
      </header>
      <motion.main initial={false} className='page-enter mx-auto min-w-0 max-w-[1440px] px-4 py-6 md:px-6 md:py-8 lg:px-8'>{children}</motion.main>
    </div>
  </div>;
}
