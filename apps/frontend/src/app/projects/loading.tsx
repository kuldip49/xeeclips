import { AppShell } from '@/components/app-shell';
import { ProjectCardSkeleton } from '@/components/project-card';

export default function Loading() {
  return <AppShell title='Projects'><div className='grid gap-5' aria-busy='true' aria-label='Loading projects'>
    <div className='skeleton h-16 w-48' />
    <div className='grid gap-2.5 md:grid-cols-2'>{[1, 2, 3, 4, 5].map((item) => <ProjectCardSkeleton key={item} />)}</div>
  </div></AppShell>;
}
