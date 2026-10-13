import type { PrismaService } from '../database/prisma.service';
import { normalizeAiProcessingMode, type AiProcessingMode } from './ai-processing-mode';

type ProjectTierRecord = { settings: unknown; generatedClipId?: string | null; userId?: string | null };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const recordedMode = (value: unknown): AiProcessingMode | null => {
  const telemetry = record(value);
  const mode = telemetry.effectiveAiMode ?? telemetry.requestedAiMode;
  return typeof mode === 'string' && mode.trim() ? normalizeAiProcessingMode(mode) : null;
};

/** Read-only compatibility for editor projects created before tier provenance was stored.
 * Only a server-owned clip reference and matching owner can supply the missing tier.
 * Never use a newer video analysis to upgrade an older Free clip. Unresolved lineage
 * remains unchanged, so the existing provider policy still fails closed.
 */
export async function withTrustedProjectTier<T extends ProjectTierRecord>(
  prisma: Pick<PrismaService, 'generatedClip' | 'processingJob'>, project: T): Promise<T> {
  const settings = record(project.settings), origin = record(settings.origin);
  if ((typeof origin.aiMode === 'string' && origin.aiMode.trim()) || recordedMode(origin.editTelemetry)) return project;
  if (!project.generatedClipId || !project.userId) return project;
  const clip = await prisma.generatedClip.findFirst({
    where: { id: project.generatedClipId, video: { project: { userId: project.userId } } },
    select: { videoId: true, generationJobId: true, createdAt: true, editTelemetry: true }
  });
  if (!clip) return project;
  let mode = recordedMode(clip.editTelemetry);
  if (!mode) {
    const select = { videoId: true, aiMode: true, telemetry: true, startedAt: true, status: true } as const;
    const job = clip.generationJobId
      ? await prisma.processingJob.findUnique({ where: { id: clip.generationJobId }, select })
      : await prisma.processingJob.findFirst({ where: { videoId: clip.videoId,
        createdAt: { lte: clip.createdAt }, status: 'COMPLETED',
        OR: [{ startedAt: null }, { startedAt: { lte: clip.createdAt } }] },
        orderBy: { createdAt: 'desc' }, select });
    // A job rerun after this clip was created no longer proves its original tier.
    if (job?.videoId === clip.videoId && job.status === 'COMPLETED' &&
      (!job.startedAt || job.startedAt.getTime() <= clip.createdAt.getTime())) {
      mode = recordedMode(job.telemetry) ?? normalizeAiProcessingMode(job.aiMode);
    }
  }
  return mode ? { ...project, settings: { ...settings, origin: { ...origin, aiMode: mode } } } : project;
}
