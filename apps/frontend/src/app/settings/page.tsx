import Link from 'next/link';
import { AppShell } from '@/components/app-shell';

export const metadata = { title: 'Settings' };

export default function SettingsPage() {
  return <AppShell><div className='mx-auto max-w-2xl'>
    <p className='eyebrow'>XeeClip</p><h1 className='mt-2 text-3xl font-bold tracking-tight'>Settings</h1>
    <div className='mt-6 rounded-2xl border border-border bg-surface p-5'>
      <h2 className='font-semibold'>Your workspace</h2>
      <p className='mt-2 text-sm leading-6 text-muted-foreground'>Choose your mode and style each time you create clips. Your finished clips are saved in History.</p>
      <Link href='/history' className='mt-4 inline-block text-sm font-semibold text-primary-soft'>View History →</Link>
    </div>
  </div></AppShell>;
}
