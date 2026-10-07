'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { History, ScanLine, Plus, Settings } from 'lucide-react';
import { BrandMark } from '@/components/brand';
import { MobileNav } from '@/components/mobile-nav';
import { cn } from '@/lib/utils';
import { useAuth } from './auth-provider';

const links = [
  { label: 'Create', href: '/', icon: Plus },
  { label: 'Quick Reframe', href: '/quick-reframe', icon: ScanLine },
  { label: 'History', href: '/history', icon: History },
  { label: 'Settings', href: '/settings', icon: Settings }
];

export function AppShell({ children }: { children: ReactNode; title?: string; backHref?: string;
  backLabel?: string; action?: ReactNode }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const navigation = user?.role === 'ADMIN' ? [...links.slice(0, 3), { label: 'Admin', href: '/admin', icon: Settings }, links[3]] : links;
  return <div className='min-h-screen overflow-x-clip bg-background text-foreground'>
    <header className='pt-safe sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-xl'>
      <div className='mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-2 px-4 sm:px-6 lg:gap-5 lg:px-8'>
        <Link href='/' aria-label='XeeClip Create' className='flex shrink-0 items-center gap-2.5 rounded-xl font-display text-base font-extrabold tracking-tight'>
          <BrandMark className='h-9 w-9 rounded-xl' />XeeClip
        </Link>
        <Link href='/quick-reframe' aria-current={pathname.startsWith('/quick-reframe')?'page':undefined}
          aria-label='Quick Reframe' className={cn('inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs font-semibold md:hidden',pathname.startsWith('/quick-reframe')?'bg-primary/15 text-primary-soft':'bg-tint text-soft')}><ScanLine size={16}/><span className='hidden sm:inline'>Quick Reframe</span></Link>
        <nav aria-label='Main navigation' className='hidden items-center gap-1 md:flex'>
          {navigation.map(({ label, href, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' || pathname.startsWith('/create') : pathname.startsWith(href);
            return <Link key={href} href={href} aria-current={active ? 'page' : undefined}
              className={cn('inline-flex h-10 items-center gap-1 rounded-xl px-2 font-display text-xs font-semibold transition-colors hover:bg-tint hover:text-foreground lg:gap-2 lg:px-4 lg:text-sm',
                active ? 'bg-primary/15 text-primary-soft' : 'text-muted-foreground')}>
              <Icon size={16} aria-hidden />{label}</Link>;
          })}
        </nav>
        <div className='flex shrink-0 items-center gap-2 text-xs'><Link href='/settings' className='text-secondary-soft'>{user?.role === 'ADMIN' ? 'Owner' : `${user?.creditBalance ?? 0} credits`}</Link><button onClick={() => void logout()} className='min-h-11 text-soft'>Logout</button></div>
      </div>
    </header>
    <main className='page-enter pb-mobile-nav mx-auto min-w-0 max-w-[1200px] px-4 pt-7 sm:px-6 md:pt-10 lg:px-8'>{children}</main>
    <MobileNav />
  </div>;
}
