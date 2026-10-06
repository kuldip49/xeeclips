'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { History, Pencil, Plus, Settings } from 'lucide-react';
import { useTypingFlag } from '@/lib/use-typing';
import { cn } from '@/lib/utils';

const tabs = [
  { label: 'Create', href: '/', icon: Plus, match: (path: string) => path === '/' || path.startsWith('/create') },
  { label: 'History', href: '/history', icon: History, match: (path: string) => path.startsWith('/history') },
  { label: 'Edit', href: '/edit', icon: Pencil, match: (path: string) => path === '/edit' || path.startsWith('/edit-mode') },
  { label: 'Settings', href: '/settings', icon: Settings, match: (path: string) => path.startsWith('/settings') }
];

export function MobileNav() {
  const pathname = usePathname();
  const typing = useTypingFlag();
  return <nav aria-label='Mobile navigation' data-testid='mobile-nav' aria-hidden={typing || undefined}
    className={cn('px-safe fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/85 pb-safe backdrop-blur-xl transition-transform md:hidden',
      typing && 'pointer-events-none translate-y-full')}>
    <div className='mx-auto flex h-[var(--bottom-nav-h)] max-w-lg items-stretch gap-2 px-3'>
      {tabs.map(({ label, href, icon: Icon, match }) => {
        const active = match(pathname);
        return <Link key={href} href={href} aria-current={active ? 'page' : undefined}
          className={cn('pressable flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl font-display text-[11px] font-semibold',
            active ? 'text-primary-soft' : 'text-muted-foreground')}>
          <span className={cn('grid h-8 w-12 place-items-center rounded-xl transition-colors', active && 'bg-primary/20 text-primary-soft')}><Icon size={20} aria-hidden /></span>
          {label}
        </Link>;
      })}
    </div>
  </nav>;
}
