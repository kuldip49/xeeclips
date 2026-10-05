'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { History, Pencil, Plus, Settings } from 'lucide-react';
import { BrandMark } from '@/components/brand';
import { MobileNav } from '@/components/mobile-nav';
import { cn } from '@/lib/utils';

const links = [
  { label: 'Create', href: '/', icon: Plus },
  { label: 'History', href: '/history', icon: History },
  { label: 'Edit', href: '/edit', icon: Pencil },
  { label: 'Settings', href: '/settings', icon: Settings }
];

export function AppShell({ children }: { children: ReactNode; title?: string; backHref?: string;
  backLabel?: string; action?: ReactNode }) {
  const pathname = usePathname();
  return <div className='min-h-screen overflow-x-hidden bg-[#070a12] text-slate-50'>
    <header className='pt-safe sticky top-0 z-30 border-b border-white/[.08] bg-[#0b0f19]/95 backdrop-blur-xl'>
      <div className='mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-5 px-4 sm:px-6 lg:px-8'>
        <Link href='/' aria-label='XeeClip Create' className='flex shrink-0 items-center gap-2.5 text-base font-bold tracking-tight'>
          <BrandMark className='h-9 w-9 rounded-xl' />XeeClip
        </Link>
        <nav aria-label='Main navigation' className='hidden items-center gap-1 md:flex'>
          {links.map(({ label, href, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' || pathname.startsWith('/create') : pathname.startsWith(href);
            return <Link key={href} href={href} aria-current={active ? 'page' : undefined}
              className={cn('inline-flex h-10 items-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors hover:bg-white/[.06] hover:text-white',
                active ? 'bg-violet-500/15 text-violet-200' : 'text-slate-400')}>
              <Icon size={16} aria-hidden />{label}</Link>;
          })}
        </nav>
      </div>
    </header>
    <main className='page-enter pb-mobile-nav mx-auto min-w-0 max-w-[1200px] px-4 pt-7 sm:px-6 md:pt-10 lg:px-8'>{children}</main>
    <MobileNav />
  </div>;
}
