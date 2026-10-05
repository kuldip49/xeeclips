'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeft, BarChart3, Bell, FolderKanban, LayoutDashboard, PenTool, Plus, Scissors, Settings, Sparkles } from 'lucide-react';
import { BrandMark } from '@/components/brand';
import { MobileNav } from '@/components/mobile-nav';
import { cn } from '@/lib/utils';

const navigation = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Projects', href: '/projects', icon: FolderKanban },
  { label: 'Create clips', href: '/create', icon: Plus },
  { label: 'Editor', href: '/edit-mode', icon: PenTool },
  { label: 'Generated Clips', href: '/dashboard#clips', icon: Scissors },
  { label: 'Analytics', href: '/dashboard#analytics', icon: BarChart3 },
  { label: 'Settings', href: '/dashboard#settings', icon: Settings }
];

function isActive(pathname: string, href: string) {
  if (href.includes('#')) return false;
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Sidebar() {
  const pathname = usePathname();
  return <div className='flex h-full flex-col bg-[#0d111c] px-4 py-6'>
    <Link href='/dashboard' className='flex items-center gap-3 px-3'>
      <BrandMark className='h-11 w-11 rounded-2xl' />
      <span className='min-w-0'><span className='block truncate text-sm font-bold tracking-tight'>XeeClip</span><span className='block text-xs text-slate-400'>Creative workspace</span></span>
    </Link>
    <p className='mt-12 px-3 text-[11px] font-semibold uppercase tracking-[.18em] text-slate-500'>Workspace</p>
    <nav className='mt-4 grid gap-1' aria-label='Main navigation'>
      {navigation.map(({ label, href, icon: Icon }) => {
        const active = isActive(pathname, href);
        return <Link key={label} href={href} aria-current={active ? 'page' : undefined} className={cn('flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition-colors hover:bg-[#151d2e] hover:text-white', active ? 'bg-violet-500/10 text-violet-300' : 'text-slate-400')}><Icon size={18} aria-hidden />{label}</Link>;
      })}
    </nav>
    <div className='mt-auto rounded-2xl border border-violet-400/10 bg-gradient-to-br from-violet-500/10 to-cyan-400/5 p-4'>
      <Sparkles className='text-violet-400' size={20} aria-hidden />
      <p className='mt-3 text-sm font-semibold'>Make every moment count</p>
      <p className='mt-1 text-xs leading-5 text-slate-400'>Turn long videos into ready-to-share clips.</p>
    </div>
  </div>;
}

/**
 * The app frame for every page except the editor.
 *
 * Desktop keeps the sidebar. Below `lg` the sidebar is not squeezed in: a compact sticky header
 * (logo or Back, the page title, one contextual action) sits on top and a bottom tab bar carries
 * navigation, with the page content padded clear of it and of the home indicator.
 */
export function AppShell({ children, title = 'Dashboard', backHref, backLabel = 'Back', action }: {
  children: ReactNode;
  title?: string;
  /** Sub-pages show Back instead of the logo in the mobile header. */
  backHref?: string;
  backLabel?: string;
  /** One contextual action for the mobile header (defaults to Create). */
  action?: ReactNode;
}) {
  const pathname = usePathname();
  return <div className='min-h-screen bg-[#070a12] text-[#f8fafc]'>
    <aside className='fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-white/[.08] lg:block'><Sidebar /></aside>
    <div className='min-w-0 lg:pl-64'>
      <header className='pt-safe sticky top-0 z-30 border-b border-white/[.08] bg-[#0b0f19]/90 backdrop-blur-xl'>
        <div className='flex h-[var(--mobile-header-h)] items-center gap-2 px-2 sm:px-4 lg:h-[72px] lg:px-8'>
          {backHref
            ? <Link href={backHref} aria-label={backLabel} className='grid h-11 w-11 shrink-0 place-items-center rounded-full text-slate-200 hover:bg-white/10 lg:hidden'><ArrowLeft size={20} aria-hidden /></Link>
            : <Link href='/dashboard' aria-label='XeeClip home' className='grid h-11 w-11 shrink-0 place-items-center lg:hidden'><BrandMark className='h-8 w-8 rounded-[10px]' /></Link>}
          <div className='min-w-0 flex-1 lg:pl-0'>
            <p className='hidden text-xs text-slate-500 lg:block'>Workspace / Overview</p>
            <p className='truncate text-[15px] font-semibold lg:text-sm'>{title}</p>
          </div>
          <div className='flex shrink-0 items-center gap-1 lg:hidden'>
            {action ?? (pathname === '/create' ? null : <Link href='/create' className='pressable inline-flex h-10 items-center gap-1.5 rounded-full bg-violet-500 pl-3 pr-4 text-sm font-semibold text-white shadow-lg shadow-violet-500/25'><Plus size={17} aria-hidden />Create</Link>)}
          </div>
          <div className='hidden items-center gap-3 lg:flex'><span className='text-xs text-slate-400'>Your creative dashboard</span><span className='rounded-xl border border-white/[.08] p-2 text-slate-400' aria-label='Notifications'><Bell size={17} aria-hidden /></span><span className='grid h-9 w-9 place-items-center rounded-full bg-violet-500/20 text-xs font-bold text-violet-200' aria-label='Profile'>XC</span></div>
        </div>
      </header>
      <main className='page-enter pb-mobile-nav mx-auto min-w-0 max-w-[1440px] px-4 pt-5 md:px-6 md:pt-8 lg:px-8'>{children}</main>
    </div>
    <MobileNav />
  </div>;
}
