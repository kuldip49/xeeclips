'use client';

import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { EditModeWorkspace } from '@/components/edit-mode/edit-mode-workspace';
import { EditModeLoadError, EditModeLoadingScreen } from '@/components/edit-mode/edit-mode-route-states';
import { getEditHistory, getEditProject } from '@/lib/edit-mode-api';
import type { EditHistory, EditProject } from '@/lib/edit-mode-types';
import { reframeForProject, type ReframeSession } from '@/lib/quick-reframe-api';

/** `/edit-mode/<id>` -> `<id>`. Read from the URL, not route params: in the static build every id
 * is served the same prebuilt shell, whose params are a placeholder. */
export const editProjectIdFromPath = (pathname: string | null) => {
  const segment = pathname?.split('/').filter(Boolean)[1] ?? '';
  try { return decodeURIComponent(segment); } catch { return segment; }
};

type Loaded = { id: string; project: EditProject; history: EditHistory[]; reframe?: ReframeSession };

/**
 * Loads the editor in the browser. The frontend is a static site (no per-request server), so the
 * project is fetched here rather than server-rendered; the editor skeleton covers the wait.
 * "Ask AI" opens the same project with `?panel=ai`.
 */
export function EditModeProjectRoute() {
  const id = editProjectIdFromPath(usePathname());
  const params = useSearchParams();
  const panel = params.get('panel');
  const tool = params.get('tool');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setFailed(false);
    Promise.all([getEditProject(id), getEditHistory(id)])
      .then(async ([project, history]) => {
        // A Quick Reframe video edits in this same editor, with its step bar and Hooks tool.
        const feature = (project.settings as Record<string, unknown> | undefined)?.feature;
        const reframe = feature === 'QUICK_REFRAME' ? await reframeForProject(id).catch(() => undefined) : undefined;
        if (active) setLoaded({ id, project, history, reframe });
      })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [id, attempt]);

  if (failed) return <EditModeLoadError onRetry={() => setAttempt((value) => value + 1)} />;
  if (!loaded || loaded.id !== id) return <EditModeLoadingScreen />;
  return <EditModeWorkspace key={id} initialProject={loaded.project} initialHistory={loaded.history}
    initialRightTab={panel === 'ai' ? 'AI' : 'INSPECTOR'} quickReframe={loaded.reframe}
    initialTool={loaded.reframe && tool === 'hooks' ? 'HOOKS' : undefined} />;
}
