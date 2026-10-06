'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { OfflineNotice } from '@/components/offline-notice';
import { UploadVideoForm } from '@/components/upload-video-form';
import { createProject } from '@/lib/api';
import { useBackendStatus } from '@/lib/use-backend-status';

export function CreateClipsFlow() {
  const router = useRouter();
  const { offline, recheck } = useBackendStatus();
  const create = useCallback(async (name: string) => (await createProject({ name })).id, []);
  return <div className='grid grid-cols-[minmax(0,1fr)] gap-5'>
    {offline ? <OfflineNotice onRetry={recheck} detail='Choose your video and settings now; Generate unlocks as soon as it is back.' /> : null}
    <UploadVideoForm createProject={create} showHeading={false} stickyCta offline={offline}
      onStarted={(projectId) => router.push(`/?session=${encodeURIComponent(projectId)}`)} />
  </div>;
}
