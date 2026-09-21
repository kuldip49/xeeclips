import type { EditElementType, Prisma } from '@prisma/client';

export type EditElementInput = {
  id?: string;
  assetId?: string | null;
  type: EditElementType;
  track: number;
  position: number;
  startTime: number;
  duration: number;
  trimStart?: number;
  trimEnd?: number | null;
  properties?: Prisma.InputJsonValue;
};

export type PreparedEditSource = {
  id: string;
  sourceVideoId?: string;
  originalName: string;
  bucket: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: bigint;
  duration: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  metadata: Prisma.InputJsonValue;
};

export const editProjectState = (project: {
  id: string;
  name: string;
  status: string;
  revision: number;
  settings?: unknown;
}) => ({
  id: project.id,
  name: project.name,
  status: project.status,
  revision: project.revision,
  settings: project.settings ?? {}
});

