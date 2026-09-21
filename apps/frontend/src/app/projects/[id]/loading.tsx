import { AppShell } from '@/components/app-shell';

export default function Loading() { return <AppShell title='Project'><div className='grid gap-6'><div className='skeleton h-10 w-64 max-w-full' /><div className='skeleton h-96' /><div className='skeleton h-64' /></div></AppShell>; }
