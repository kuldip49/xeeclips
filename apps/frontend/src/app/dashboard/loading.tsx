import { AppShell } from '@/components/app-shell';
import { ProjectCardSkeleton } from '@/components/project-card';

export default function Loading() {
  return <AppShell title='Home'><div className='grid gap-6' aria-busy='true' aria-label='Loading workspace'>
    <div className='skeleton h-36 w-full rounded-[24px] md:h-20' />
    <div className='grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4'>{[1, 2, 3, 4].map((item) => <div key={item} className='skeleton h-24 sm:h-32' />)}</div>
    <div className='grid gap-2.5'>{[1, 2, 3].map((item) => <ProjectCardSkeleton key={item} />)}</div>
  </div></AppShell>;
}
