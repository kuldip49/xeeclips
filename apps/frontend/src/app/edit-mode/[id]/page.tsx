import { EditModeWorkspace } from '@/components/edit-mode/edit-mode-workspace';
import { getEditHistory, getEditProject } from '@/lib/edit-mode-api';

/**
 * The editor deliberately does not use AppShell.
 *
 * A professional editing layout needs the whole viewport: AppShell's 64px nav,
 * 72px header and max-w-[1440px] padded main would cost roughly a third of the
 * height at 1366x768, which is exactly the height the preview and timeline
 * need. The top bar carries its own "Projects" link back into the app.
 */
export default async function EditModeProjectPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ panel?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const auth: RequestInit = {};
  const [project, history] = await Promise.all([getEditProject(id, auth), getEditHistory(id, auth)]);
  // "Ask AI" on a generated clip opens the same project with the AI editor showing.
  return <EditModeWorkspace initialProject={project} initialHistory={history}
    initialRightTab={query.panel === 'ai' ? 'AI' : 'INSPECTOR'} />;
}
