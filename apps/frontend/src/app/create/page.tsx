import { Suspense } from 'react';
import { AppShell } from '@/components/app-shell';
import { CreateClipsRoute, CreateClipsView } from '@/components/create-clips-route';

export const metadata = { title: 'Create clips' };

/** Static: the form is prerendered; `?session=` is read and loaded in the browser. */
export default function CreatePage() {
  return <AppShell>
    <Suspense fallback={<CreateClipsView session={null} project={null} unavailable={false} />}>
      <CreateClipsRoute />
    </Suspense>
  </AppShell>;
}
