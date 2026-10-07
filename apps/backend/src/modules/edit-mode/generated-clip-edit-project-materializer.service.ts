import { ConflictException, Injectable, NotFoundException,
  UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { extname, join } from 'path';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import { EditModeService } from './edit-mode.service';
import { adaptAutomaticEditPlan } from './generated-clip-edit-plan-adapter';
import { editProjectRoute } from './generated-clip-edit-link';

const jsonSafe = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, item) =>
  typeof item === 'bigint' ? Number(item) : item)) as T;

const sourceExtension = (mimeType: string, objectKey: string) => {
  const extension = extname(objectKey).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/u.test(extension)) return extension;
  return mimeType === 'video/webm' ? '.webm' : '.mp4';
};

@Injectable()
export class GeneratedClipEditProjectMaterializerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly editMode: EditModeService
  ) {}

  async materialize(generatedClipId: string) {
    const clip = await this.prisma.generatedClip.findUnique({
      where: { id: generatedClipId },
      include: { video: { include: { transcript: { include: {
        segments: { orderBy: { position: 'asc' as const } }
      } } } }, editProject: { select: { id: true } } }
    });
    if (!clip) throw new NotFoundException('Generated clip not found');
    if (clip.editProject) return this.response(clip.id, await this.editMode.get(clip.editProject.id));

    const duration = Number(clip.duration);
    const sizeBytes = Number(clip.sizeBytes);
    if (!clip.mimeType.startsWith('video/') || !Number.isFinite(duration) || duration <= 0 ||
      !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || clip.width <= 0 || clip.height <= 0) {
      throw new UnprocessableEntityException({ code: 'GENERATED_CLIP_NOT_USABLE',
        message: 'Generated clip media metadata is incomplete or unusable' });
    }

    let sourceStat: { size: number };
    try {
      sourceStat = await this.storage.statObject(clip.bucket, clip.objectKey);
    } catch {
      throw new UnprocessableEntityException({ code: 'GENERATED_CLIP_MEDIA_MISSING',
        message: 'Generated clip media is missing from storage' });
    }
    if (!sourceStat.size) {
      throw new UnprocessableEntityException({ code: 'GENERATED_CLIP_MEDIA_MISSING',
        message: 'Generated clip media is empty' });
    }

    const normalOriginalSource = clip.processingType === 'NORMAL_CLIPS';
    const originalDuration = Number(clip.video.duration);
    const projectId = randomUUID();
    const assetId = randomUUID();
    const automatic = clip.processingType === 'EDITED_CLIPS'
      ? adaptAutomaticEditPlan({ editPlan: clip.editPlan, editTelemetry: clip.editTelemetry,
        sourceAssetId: assetId, sourceDuration: originalDuration,
        transcriptSegments: clip.video.transcript?.segments ?? [],
        idFactory: () => randomUUID() })
      : null;
    const reconstructed = automatic?.mode === 'CANONICAL';
    const telemetry = clip.editTelemetry && typeof clip.editTelemetry === 'object' &&
      !Array.isArray(clip.editTelemetry) ? clip.editTelemetry as Record<string, unknown> : {};
    const cachedVisual = telemetry.visualAnalysis;
    const sourceAnalysis = reconstructed && clip.templateId === 'AUTOMATIC_2' &&
      cachedVisual && typeof cachedVisual === 'object' &&
      Array.isArray((cachedVisual as Record<string, unknown>).frames)
      ? jsonSafe(cachedVisual) as Prisma.InputJsonValue : undefined;
    const originalSource = normalOriginalSource || reconstructed;
    if (originalSource && (!clip.video.mimeType.startsWith('video/') ||
      !Number.isFinite(originalDuration) || originalDuration <= 0 ||
      (normalOriginalSource && (clip.startTime < 0 || clip.endTime <= clip.startTime ||
      clip.endTime > originalDuration + 1e-6)))) {
      throw new UnprocessableEntityException({ code: 'ORIGINAL_VIDEO_NOT_USABLE',
        message: 'The original Video metadata cannot satisfy this generated source range' });
    }
    if (originalSource) {
      await this.storage.statObject(clip.video.bucket, clip.video.objectKey).catch(() => {
        throw new UnprocessableEntityException({ code: 'ORIGINAL_VIDEO_MEDIA_MISSING',
          message: 'The original Video media is missing from storage' });
      });
    }

    const elementId = randomUUID();
    const extension = sourceExtension(clip.mimeType, clip.objectKey);
    const editorObjectKey = `edit-mode/${projectId}/${assetId}/source${extension}`;
    const directory = await mkdtemp(join(tmpdir(), 'generated-clip-edit-'));
    const localPath = join(directory, `source${extension}`);
    let copied: { bucket: string; objectKey: string } | null = null;

    try {
      await this.storage.downloadToFile(clip.bucket, clip.objectKey, localPath);
      copied = await this.storage.uploadFile({ filePath: localPath, objectKey: editorObjectKey,
        mimeType: clip.mimeType });

      const origin = jsonSafe({
        schemaVersion: 1, originKind: 'GENERATED_CLIP',
        sourceMode: originalSource ? 'ORIGINAL_VIDEO' : 'FLATTENED_GENERATED_OUTPUT',
        reconstructionMode: reconstructed ? 'CANONICAL' : automatic?.mode === 'FLATTENED_FALLBACK'
          ? 'FLATTENED_FALLBACK' : 'NOT_APPLICABLE',
        reconstructionAdapterVersion: reconstructed ? automatic.report.adapterVersion : null,
        reconstructionReport: reconstructed ? automatic.report : null,
        reconstructionFallback: automatic?.mode === 'FLATTENED_FALLBACK'
          ? { reason: automatic.reason, details: automatic.details } : null,
        originalVideoId: clip.videoId,
        generatedClipId: clip.id, clipCandidateId: clip.candidateId,
        generatedStart: clip.startTime, generatedEnd: clip.endTime,
        currentSourceStart: clip.startTime, currentSourceEnd: clip.endTime,
        // Compatibility aliases retained for already-shipped Step 2 readers.
        fullVideoSourceStart: clip.startTime, fullVideoSourceEnd: clip.endTime,
        generatedDuration: duration, processingType: clip.processingType,
        aspectRatio: clip.aspectRatio, targetPlatform: clip.targetPlatform,
        variantKey: clip.variantKey, editPlan: clip.editPlan,
        editTelemetry: clip.editTelemetry, contentPackaging: clip.contentPackaging
      });
      const supportedAspect = ['SOURCE', '9:16', '16:9', '1:1'].includes(clip.aspectRatio)
        ? clip.aspectRatio : 'SOURCE';
      const baseSettings = {
        selectedPreset: 'SOURCE_MANUAL', aspectRatio: supportedAspect, pacing: 'SOURCE',
        subtitlePolicy: 'OFF', hookPolicy: 'OFF', zoomPolicy: 'OFF', reframePolicy: 'SOURCE',
        musicPolicy: 'KEEP_EXISTING', gradingPolicy: 'NONE', textPolicy: 'OFF',
        overlayPolicy: 'NONE', informationRegionPolicy: 'RESPECT', hookText: null, origin
      };
      const settings = jsonSafe({ ...baseSettings,
        ...(reconstructed ? automatic.settingsPatch : {}), origin }) as Prisma.InputJsonValue;
      const flattenedMetadata = jsonSafe({ hasVideo: true, videoCodec: clip.codec,
        ownership: 'OWNED', sourceMapping: 'FLATTENED_GENERATED_OUTPUT', origin }) as
        Prisma.InputJsonValue;
      const originalMetadata = jsonSafe({ hasVideo: clip.video.hasVideo ?? true,
        hasAudio: clip.video.hasAudio ?? null, videoCodec: clip.video.codec,
        ownership: 'SHARED', sourceMapping: 'ORIGINAL_VIDEO', origin }) as Prisma.InputJsonValue;
      const sourceTranscript = clip.video.transcript ? jsonSafe({
        text: clip.video.transcript.text, language: clip.video.transcript.language,
        segments: clip.video.transcript.segments.map((segment) => ({
          start: segment.start, end: segment.end, text: segment.text,
          words: segment.words, speaker: segment.speaker
        }))
      }) as Prisma.InputJsonValue : undefined;
      const name = `Edit clip ${clip.id.slice(0, 8)}`;
      const afterState = jsonSafe({ id: projectId, name, sourceProjectId: clip.video.projectId,
        generatedClipId: clip.id, originalVideoId: clip.videoId,
        status: 'READY', settings, revision: 1 });

      const sourceAsset = originalSource ? {
        id: assetId, sourceVideoId: clip.videoId, role: 'SOURCE' as const,
        originalName: clip.video.originalName, bucket: clip.video.bucket,
        // objectKey remains an editor-identity key. All storage I/O resolves the
        // shared Video key through storageObjectKey in one policy helper.
        objectKey: `edit-mode/${projectId}/${assetId}/shared${sourceExtension(
          clip.video.mimeType, clip.video.objectKey)}`,
        storageObjectKey: clip.video.objectKey, storageOwnership: 'SHARED' as const,
        mimeType: clip.video.mimeType, sizeBytes: clip.video.sizeBytes,
        duration: originalDuration, width: clip.video.width, height: clip.video.height,
        fps: clip.video.fps, metadata: originalMetadata, transcript: sourceTranscript,
        ...(sourceAnalysis ? { analysis: sourceAnalysis } : {})
      } : {
        id: assetId, sourceVideoId: clip.videoId, role: 'SOURCE' as const,
        originalName: `generated-clip-${clip.id}${extension}`, bucket: copied!.bucket,
        objectKey: copied!.objectKey, storageObjectKey: null, storageOwnership: 'OWNED' as const,
        mimeType: clip.mimeType, sizeBytes: BigInt(sourceStat.size), duration,
        width: clip.width, height: clip.height, metadata: flattenedMetadata
      };
      const assets = originalSource ? [sourceAsset, {
        id: randomUUID(), sourceVideoId: clip.videoId, role: 'REFERENCE' as const,
        originalName: `generated-clip-${clip.id}${extension}`, bucket: copied!.bucket,
        objectKey: copied!.objectKey, storageObjectKey: null, storageOwnership: 'OWNED' as const,
        mimeType: clip.mimeType, sizeBytes: BigInt(sourceStat.size), duration,
        width: clip.width, height: clip.height, metadata: flattenedMetadata
      }] : [sourceAsset];

      // An original-source element's timeline length IS its source interval. The
      // rendered MP4's probed duration differs by encoder frame rounding (e.g.
      // 34.324 vs 34.30), and the validator's 1e-4 tolerance would then refuse
      // every later command on the project.
      const elements = reconstructed ? automatic.elements : [{ id: elementId, assetId,
        type: 'VIDEO' as const, track: 0, position: 0, startTime: 0,
        duration: normalOriginalSource ? clip.endTime - clip.startTime : duration,
        trimStart: normalOriginalSource ? clip.startTime : 0,
        trimEnd: normalOriginalSource ? clip.endTime : duration, properties: {} }];
      const historyElementIds = elements.map((element) => element.id!).filter(Boolean);

      await this.prisma.$transaction(async (tx) => {
        await tx.editProject.create({ data: {
          userId: (await tx.project.findUniqueOrThrow({ where: { id: clip.video.projectId } })).userId,
          id: projectId, name, sourceProjectId: clip.video.projectId, generatedClipId: clip.id,
          originalVideoId: clip.videoId,
          status: 'READY', settings, revision: 1,
          assets: { create: assets },
          elements: { create: elements },
          history: { create: [
            { revision: 0, actor: 'SYSTEM', action: 'PROJECT_CREATED',
              command: { generatedClipId: clip.id }, afterState: { ...afterState, revision: 0 } },
            { revision: 1, actor: 'SYSTEM', action: 'GENERATED_CLIP_MATERIALIZED',
              command: { generatedClipId: clip.id, assetId, elementId: historyElementIds[0],
                elementIds: historyElementIds,
                reconstructionMode: reconstructed ? 'CANONICAL' :
                  automatic?.mode === 'FLATTENED_FALLBACK' ? 'FLATTENED_FALLBACK' :
                    'NOT_APPLICABLE' }, afterState }
          ] }
        } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      return this.response(clip.id, await this.editMode.get(projectId));
    } catch (error) {
      if (copied) await this.storage.removeObject(copied.bucket, copied.objectKey).catch(() => undefined);
      if ((error as { code?: string }).code === 'P2002') {
        const winner = await this.prisma.editProject.findUnique({ where: { generatedClipId: clip.id },
          select: { id: true } });
        if (winner) return this.response(clip.id, await this.editMode.get(winner.id));
      }
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private response(generatedClipId: string, project: { id: string; revision: number;
    generatedClipId?: string | null; assets?: Array<{ role: string }>;
    elements?: Array<{ type: string; assetId?: string | null }> }) {
    const source = project.assets?.find((asset) => asset.role === 'SOURCE');
    const video = project.elements?.find((element) => element.type === 'VIDEO');
    if (!project.id || !Number.isInteger(project.revision) ||
      project.generatedClipId !== generatedClipId || !source || !video?.assetId) {
      throw new ConflictException({ code: 'PARTIAL_GENERATED_CLIP_MATERIALIZATION',
        message: 'The linked EditProject is incomplete' });
    }
    return { editProjectId: project.id, generatedClipId, revision: project.revision,
      editUrl: editProjectRoute(project.id) };
  }
}
