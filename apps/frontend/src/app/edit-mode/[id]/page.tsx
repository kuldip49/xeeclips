import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { EditModeWorkspace } from '@/components/edit-mode/edit-mode-workspace';
import { getEditHistory, getEditProject } from '@/lib/edit-mode-api';
import styles from './edit-mode.module.css';

export default async function EditModeProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const [project, history] = await Promise.all([getEditProject(id), getEditHistory(id)]);
    return <AppShell title='EditMode'><div className={styles.workspace}><EditModeWorkspace initialProject={project} initialHistory={history} /></div></AppShell>;
  } catch {
    notFound();
  }
}

