import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { ProjectWorkspace } from '@/components/project-workspace';
import { Button } from '@/components/ui/button';
import { ApiError, getProject } from '@/lib/api';

type ProjectDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProjectDetailPage({ params }: ProjectDetailPageProps) {
  const { id } = await params;
  const project = await getProject(id).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });

  if (!project) notFound();

  return (
    <AppShell title={project.name} backHref='/projects' backLabel='Back to projects'>
      <div className='grid min-w-0 gap-5 md:gap-8'>
        <div className='min-w-0'>
          <Button asChild size='sm' variant='ghost' className='hidden lg:inline-flex'>
            <Link href='/dashboard'>
              <ArrowLeft size={16} aria-hidden />
              Dashboard
            </Link>
          </Button>
          <p className='eyebrow lg:mt-5'>Project workspace</p>
          <h1 className='mt-1.5 break-words text-2xl font-bold tracking-tight md:mt-2 md:text-4xl'>{project.name}</h1>
          <p className='mt-1.5 text-sm text-muted-foreground md:mt-2 md:text-base'>
            {project.description || 'Upload and manage source videos for this project.'}
          </p>
        </div>
        <ProjectWorkspace
          initialProject={project}
          visualAnalysisEnabled={process.env.ENABLE_VISUAL_ANALYSIS?.toLowerCase() === 'true'}
          developerDiagnostics={process.env.SHOW_DEVELOPER_DIAGNOSTICS?.toLowerCase() === 'true'}
        />
      </div>
    </AppShell>
  );
}
