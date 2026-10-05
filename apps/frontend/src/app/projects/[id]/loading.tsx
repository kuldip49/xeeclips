import { AppShell } from '@/components/app-shell';

export default function Loading() {
  return <AppShell title='Project' backHref='/projects'><div className='grid gap-5' aria-busy='true' aria-label='Loading project'>
    <div className='grid gap-2'><div className='skeleton h-4 w-32' /><div className='skeleton h-8 w-64 max-w-full' /></div>
    <div className='skeleton h-14 w-full rounded-2xl' />
    <div className='skeleton aspect-video w-full rounded-2xl' />
    <div className='skeleton h-40 w-full rounded-2xl' />
  </div></AppShell>;
}
