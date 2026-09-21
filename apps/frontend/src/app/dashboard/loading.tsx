import { AppShell } from '@/components/app-shell';

export default function Loading() { return <AppShell title='Dashboard'><div className='grid gap-6'><div className='skeleton h-10 w-72 max-w-full' /><div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>{[1, 2, 3, 4].map((item) => <div key={item} className='skeleton h-32' />)}</div><div className='grid gap-4 xl:grid-cols-2'><div className='skeleton h-64' /><div className='skeleton h-64' /></div></div></AppShell>; }
