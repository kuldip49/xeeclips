'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BarChart3, CirclePlay, FolderKanban, Home, Info, Menu, PenTool, Plus, Scissors, type LucideIcon } from 'lucide-react';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { cn } from '@/lib/utils';
import { useTypingFlag } from '@/lib/use-typing';

type Tab = { label: string; href: string; icon: LucideIcon; match: (path: string) => boolean };

const TABS: Tab[] = [
  { label: 'Home', href: '/dashboard', icon: Home, match: (path) => path === '/dashboard' },
  { label: 'Projects', href: '/projects', icon: FolderKanban, match: (path) => path === '/projects' || path.startsWith('/projects/') },
  { label: 'Edits', href: '/edit-mode', icon: PenTool, match: (path) => path.startsWith('/edit-mode') }
];

const MORE: Array<{ label: string; description: string; href: string; icon: LucideIcon }> = [
  { label: 'Generated clips', description: 'Every clip made from your videos', href: '/dashboard#clips', icon: Scissors },
  { label: 'Processing', description: 'Uploads and analysis in progress', href: '/dashboard#processing', icon: CirclePlay },
  { label: 'Workspace insights', description: 'Totals for projects and videos', href: '/dashboard#analytics', icon: BarChart3 },
  { label: 'About XeeClip', description: 'How Automatic 1 and Automatic 2 work', href: '/', icon: Info }
];

function TabLink({ tab, active }: { tab: Tab; active: boolean }) {
  const Icon = tab.icon;
  return <Link href={tab.href} aria-current={active ? 'page' : undefined}
    className={cn('pressable flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-2xl py-1.5 text-[11px] font-medium',
      active ? 'text-white' : 'text-slate-400')}>
    <span className={cn('grid h-7 w-12 place-items-center rounded-full transition-colors', active && 'bg-violet-500/20 text-violet-200')}>
      <Icon size={20} strokeWidth={active ? 2.4 : 2} aria-hidden /></span>
    <span className='truncate'>{tab.label}</span>
  </Link>;
}

/**
 * Phone/tablet navigation: four destinations and one prominent Create action, fixed to the
 * bottom edge above the home indicator. Hidden from `lg`, where the sidebar takes over.
 */
export function MobileNav() {
  const pathname = usePathname();
  const [more, setMore] = useState(false);
  const typing = useTypingFlag();
  const createActive = pathname === '/create';
  return <>
    <nav aria-label='Primary' data-testid='mobile-nav' aria-hidden={typing || undefined}
      className={cn('px-safe fixed inset-x-0 bottom-0 z-40 border-t border-white/[.08] bg-[#0b0f19]/95 pb-safe backdrop-blur-xl transition-transform duration-200 lg:hidden',
        typing && 'pointer-events-none translate-y-full')}>
      <div className='mx-auto flex h-[var(--bottom-nav-h)] max-w-xl items-stretch gap-1 px-2'>
        <TabLink tab={TABS[0]} active={TABS[0].match(pathname)} />
        <TabLink tab={TABS[1]} active={TABS[1].match(pathname)} />
        <Link href='/create' aria-label='Create clips' aria-current={createActive ? 'page' : undefined}
          className='pressable flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-semibold text-white'>
          <span className={cn('grid h-10 w-14 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-violet-600 shadow-lg shadow-violet-500/30',
            createActive && 'ring-2 ring-violet-300/70')}><Plus size={22} strokeWidth={2.6} aria-hidden /></span>
          <span className='sr-only'>Create clips</span>
        </Link>
        <TabLink tab={TABS[2]} active={TABS[2].match(pathname)} />
        <button type='button' onClick={() => setMore(true)} aria-haspopup='dialog' aria-expanded={more}
          className='pressable flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-2xl py-1.5 text-[11px] font-medium text-slate-400'>
          <span className='grid h-7 w-12 place-items-center rounded-full'><Menu size={20} aria-hidden /></span>
          <span>More</span>
        </button>
      </div>
    </nav>
    <BottomSheet open={more} onClose={() => setMore(false)} title='More'>
      <ul className='grid gap-1'>
        {MORE.map(({ label, description, href, icon: Icon }) => <li key={label}>
          <Link href={href} onClick={() => setMore(false)}
            className='pressable flex min-h-[56px] items-center gap-3 rounded-2xl px-2 py-2 hover:bg-white/[.04]'>
            <span className='grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[.05] text-violet-300'><Icon size={19} aria-hidden /></span>
            <span className='min-w-0'><span className='block text-sm font-semibold'>{label}</span>
              <span className='block truncate text-xs text-slate-400'>{description}</span></span>
          </Link>
        </li>)}
      </ul>
    </BottomSheet>
  </>;
}
