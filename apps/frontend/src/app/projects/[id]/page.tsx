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
    <AppShell title={project.name}>
      <div className='grid min-w-0 gap-8'>
        <div>
          <Button asChild size='sm' variant='ghost'>
            <Link href='/dashboard'>
              <ArrowLeft size={16} aria-hidden />
              Dashboard
            </Link>
          </Button>
          <p className='eyebrow mt-5'>Project workspace</p>
          <h1 className='mt-2 text-3xl font-bold tracking-tight md:text-4xl'>{project.name}</h1>
          <p className='mt-2 text-muted-foreground'>
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
