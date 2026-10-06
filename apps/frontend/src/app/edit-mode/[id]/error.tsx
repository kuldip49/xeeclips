'use client';

import { EditModeLoadError } from '@/components/edit-mode/edit-mode-route-states';

export default function EditModeProjectError({ reset }: { error: Error & { digest?: string };
  reset: () => void }) {
  return <EditModeLoadError onRetry={reset} />;
}
