import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { EditElementType, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { extname, join } from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { PrismaService } from '../database/prisma.service';
import { probeMedia } from '../processing/media-probe';
import { StorageService } from '../storage/storage.service';
import { EditModeAnalysisService } from './edit-mode-analysis.service';
import type { EditElementInput, PreparedEditSource } from './edit-mode.types';
import { editProjectState } from './edit-mode.types';

const MIN_VIDEO_DURATION_SEC = 0.05;
const MANUAL_ACTIONS = new Set(['TRIM_ELEMENT', 'SPLIT_ELEMENT', 'DELETE_ELEMENT', 'MOVE_ELEMENT']);

type TimelineElement = EditElementInput & { id: string };

const timelineElementState = (element: Record<string, unknown>): TimelineElement => ({
  id: String(element.id),
  assetId: typeof element.assetId === 'string' ? element.assetId : null,
  type: element.type as EditElementType,
  track: Number(element.track),
  position: Number(element.position),
  startTime: Number(element.startTime),
  duration: Number(element.duration),
  trimStart: Number(element.trimStart ?? 0),
  trimEnd: element.trimEnd == null ? null : Number(element.trimEnd),
  properties: (element.properties ?? {}) as Prisma.InputJsonValue
});

export const normalizeVideoTrack = <T extends TimelineElement>(elements: T[]): T[] => {
  const videos = elements.filter((element) => element.type === 'VIDEO' && element.track === 0)
    .sort((left, right) => left.position - right.position || left.startTime - right.startTime);
  let startTime = 0;
  const normalized = new Map<string, T>();
  videos.forEach((element, position) => {
    const next = { ...element, position, startTime: Number(startTime.toFixed(6)) } as T;
    normalized.set(element.id, next);
    startTime += element.duration;
  });
  return elements.map((element) => normalized.get(element.id) ?? element)
    .sort((left, right) => left.track - right.track || left.position - right.position);
};

const includeProject = {
  assets: { orderBy: { createdAt: 'asc' as const } },
  elements: { orderBy: [{ track: 'asc' as const }, { position: 'asc' as const }] }
};

const serialize = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, item) =>
  typeof item === 'bigint' ? Number(item) : item)) as T;

const parseRevision = (value: unknown) => {
  const revision = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(revision) || Number(revision) < 0) {
    throw new BadRequestException('revision must be a non-negative integer');
  }
  return Number(revision);
};

@Injectable()
export class EditModeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly analysisService: EditModeAnalysisService
  ) {}

  async create(input: { name?: unknown; sourceProjectId?: unknown; settings?: unknown }) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new BadRequestException('name is required');
    if (name.length > 120) throw new BadRequestException('name must be 120 characters or fewer');
    const sourceProjectId = typeof input.sourceProjectId === 'string' && input.sourceProjectId
      ? input.sourceProjectId : null;
    const settings = input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings)
      ? input.settings as Prisma.InputJsonValue : {};

    const project = await this.prisma.$transaction(async (tx) => {
      const created = await tx.editProject.create({
        data: { name, sourceProjectId, settings }
      });
      await tx.editHistory.create({
        data: {
          editProjectId: created.id,
          revision: 0,
          actor: 'USER',
          action: 'PROJECT_CREATED',
          command: { name, sourceProjectId },
          afterState: editProjectState(created)
        }
      });
      return tx.editProject.findUniqueOrThrow({ where: { id: created.id }, include: includeProject });
    });
    return serialize(project);
  }

  async list() {
    const projects = await this.prisma.editProject.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        assets: { where: { role: 'SOURCE' }, orderBy: { createdAt: 'asc' }, take: 1 },
        _count: { select: { elements: true, history: true } }
      }
    });
    return serialize(projects);
  }

  async get(id: string) {
    const project = await this.prisma.editProject.findUnique({
      where: { id }, include: includeProject
    });
    if (!project) throw new NotFoundException('EditProject not found');
    return serialize(project);
  }

  async update(id: string, input: { revision?: unknown; name?: unknown; settings?: unknown }) {
    const expectedRevision = parseRevision(input.revision);
    return serialize(await this.prisma.$transaction(async (tx) => {
      const current = await tx.editProject.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('EditProject not found');
      if (current.revision !== expectedRevision) throw new ConflictException('EditProject revision is stale');
      const name = input.name === undefined ? current.name
        : typeof input.name === 'string' ? input.name.trim() : '';
      if (!name) throw new BadRequestException('name cannot be empty');
      const settings = input.settings === undefined ? current.settings as Prisma.InputJsonValue
        : input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings)
          ? input.settings as Prisma.InputJsonValue
          : (() => { throw new BadRequestException('settings must be an object'); })();
      const revision = current.revision + 1;
      const updated = await tx.editProject.update({
        where: { id }, data: { name, settings, revision }
      });
      await tx.editHistory.create({
        data: {
          editProjectId: id, revision, actor: 'USER', action: 'PROJECT_UPDATED',
          command: { name: input.name === undefined ? null : name },
          beforeState: editProjectState(current), afterState: editProjectState(updated)
        }
      });
      return tx.editProject.findUniqueOrThrow({ where: { id }, include: includeProject });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async remove(id: string) {
    const project = await this.prisma.editProject.findUnique({
      where: { id }, select: { id: true, assets: { select: { bucket: true, objectKey: true } } }
    });
    if (!project) throw new NotFoundException('EditProject not found');
    await this.prisma.editProject.delete({ where: { id } });
    await Promise.all(project.assets.map((asset) =>
      this.storage.removeObject(asset.bucket, asset.objectKey).catch(() => undefined)));
    return { id, deleted: true };
  }

  async attachUpload(id: string, file: Express.Multer.File, revisionValue: unknown) {
    if (!file.mimetype.startsWith('video/')) throw new BadRequestException('Uploaded file must be a video');
    const revision = parseRevision(revisionValue);
    await this.assertAttachable(id, revision);
    const assetId = randomUUID();
    const suffix = extname(file.originalname).toLowerCase() || '.mp4';
    const objectKey = `edit-mode/${id}/${assetId}/source${suffix}`;
    const stored = await this.storage.uploadVideo({ buffer: file.buffer, objectKey, mimeType: file.mimetype });
    try {
      const stat = await this.storage.statObject(stored.bucket, stored.objectKey);
      const directory = await mkdtemp(join(tmpdir(), 'edit-mode-upload-'));
      const path = join(directory, `source${suffix}`);
      try {
        await writeFile(path, file.buffer);
        const prepared = await this.prepareSource({ id: assetId, originalName: file.originalname,
          mimeType: file.mimetype, bucket: stored.bucket, objectKey: stored.objectKey,
          sizeBytes: BigInt(stat.size), path });
        return await this.persistSource(id, revision, prepared);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    } catch (error) {
      await this.storage.removeObject(stored.bucket, stored.objectKey).catch(() => undefined);
      throw error;
    }
  }

  async attachFromVideo(id: string, sourceVideoIdValue: unknown, revisionValue: unknown) {
    const sourceVideoId = typeof sourceVideoIdValue === 'string' ? sourceVideoIdValue : '';
    if (!sourceVideoId) throw new BadRequestException('sourceVideoId is required');
    const revision = parseRevision(revisionValue);
    await this.assertAttachable(id, revision);
    const video = await this.prisma.video.findUnique({ where: { id: sourceVideoId } });
    if (!video) throw new NotFoundException('Source Video not found');
    const assetId = randomUUID();
    const suffix = extname(video.originalName).toLowerCase() || '.mp4';
    const objectKey = `edit-mode/${id}/${assetId}/source${suffix}`;
    const directory = await mkdtemp(join(tmpdir(), 'edit-mode-copy-'));
    const path = join(directory, `source${suffix}`);
    let stored: { bucket: string; objectKey: string } | null = null;
    try {
      await this.storage.statObject(video.bucket, video.objectKey).catch(() => {
        throw new BadRequestException('Source Video object is missing from storage');
      });
      await this.storage.downloadToFile(video.bucket, video.objectKey, path);
      stored = await this.storage.uploadFile({ filePath: path, objectKey, mimeType: video.mimeType });
      const stat = await this.storage.statObject(stored.bucket, stored.objectKey);
      const prepared = await this.prepareSource({ id: assetId, sourceVideoId,
        originalName: video.originalName, mimeType: video.mimeType, bucket: stored.bucket,
        objectKey: stored.objectKey, sizeBytes: BigInt(stat.size), path });
      return await this.persistSource(id, revision, prepared);
    } catch (error) {
      if (stored) await this.storage.removeObject(stored.bucket, stored.objectKey).catch(() => undefined);
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async prepareSource(input: Omit<PreparedEditSource,
    'duration' | 'width' | 'height' | 'fps' | 'metadata'> & { path: string }): Promise<PreparedEditSource> {
    const media = await probeMedia(input.path);
    if (!media.hasVideo) throw new BadRequestException('Source must contain a video stream');
    if (!media.durationSec || media.durationSec <= 0) throw new BadRequestException('Source duration is unavailable');
    return {
      ...input,
      duration: media.durationSec,
      width: media.width,
      height: media.height,
      fps: media.fps ?? null,
      metadata: {
        hasVideo: media.hasVideo, hasAudio: media.hasAudio, videoCodec: media.videoCodec,
        audioCodec: media.audioCodec, formatName: media.formatName,
        videoStreamIndex: media.videoStreamIndex, audioStreamIndex: media.audioStreamIndex,
        bitrate: media.bitrate == null ? null : Number(media.bitrate)
      }
    };
  }

  private async assertAttachable(id: string, revision: number) {
    const project = await this.prisma.editProject.findUnique({
      where: { id }, include: { assets: { where: { role: 'SOURCE' }, select: { id: true }, take: 1 } }
    });
    if (!project) throw new NotFoundException('EditProject not found');
    if (project.revision !== revision) throw new ConflictException('EditProject revision is stale');
    if (project.assets.length) throw new ConflictException('EditProject already has a source asset');
  }

  private async persistSource(id: string, expectedRevision: number, source: PreparedEditSource) {
    try {
      const project = await this.prisma.$transaction(async (tx) => {
        const current = await tx.editProject.findUnique({
          where: { id }, include: { assets: { where: { role: 'SOURCE' }, select: { id: true }, take: 1 } }
        });
        if (!current) throw new NotFoundException('EditProject not found');
        if (current.revision !== expectedRevision) throw new ConflictException('EditProject revision is stale');
        if (current.assets.length) throw new ConflictException('EditProject already has a source asset');
        const asset = await tx.editAsset.create({ data: {
          id: source.id, editProjectId: id, sourceVideoId: source.sourceVideoId,
          role: 'SOURCE', originalName: source.originalName, bucket: source.bucket,
          objectKey: source.objectKey, mimeType: source.mimeType, sizeBytes: source.sizeBytes,
          duration: source.duration, width: source.width, height: source.height, fps: source.fps,
          metadata: source.metadata
        } });
        await tx.editElement.create({ data: {
          editProjectId: id, assetId: asset.id, type: 'VIDEO', track: 0, position: 0,
          startTime: 0, duration: source.duration, trimStart: 0, trimEnd: source.duration,
          properties: {}
        } });
        const revision = current.revision + 1;
        const updated = await tx.editProject.update({ where: { id }, data: { revision } });
        await tx.editHistory.create({ data: {
          editProjectId: id, revision, actor: 'USER', action: 'SOURCE_ATTACHED',
          command: { assetId: asset.id, sourceVideoId: source.sourceVideoId ?? null },
          beforeState: editProjectState(current),
          afterState: { ...editProjectState(updated), sourceAssetId: asset.id,
            duration: source.duration, objectKey: source.objectKey }
        } });
        return tx.editProject.findUniqueOrThrow({ where: { id }, include: includeProject });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return serialize(project);
    } catch (error) {
      await this.storage.removeObject(source.bucket, source.objectKey).catch(() => undefined);
      throw error;
    }
  }

  async analyze(id: string, revisionValue: unknown) {
    const revision = parseRevision(revisionValue);
    const current = await this.prisma.editProject.findUnique({
      where: { id }, include: { assets: { where: { role: 'SOURCE' }, take: 1 } }
    });
    if (!current) throw new NotFoundException('EditProject not found');
    if (current.revision !== revision) throw new ConflictException('EditProject revision is stale');
    const source = current.assets[0];
    if (!source) throw new BadRequestException('Attach a source before analysis');
    const result = await this.analysisService.analyze(source);
    return serialize(await this.prisma.$transaction(async (tx) => {
      const latest = await tx.editProject.findUnique({ where: { id } });
      if (!latest) throw new NotFoundException('EditProject not found');
      if (latest.revision !== revision) throw new ConflictException('EditProject changed during analysis');
      await tx.editAsset.update({ where: { id: source.id }, data: result });
      const nextRevision = latest.revision + 1;
      const updated = await tx.editProject.update({
        where: { id }, data: { revision: nextRevision, status: 'READY' }
      });
      await tx.editHistory.create({ data: {
        editProjectId: id, revision: nextRevision, actor: 'SYSTEM', action: 'SOURCE_ANALYZED',
        command: { assetId: source.id }, beforeState: editProjectState(latest),
        afterState: { ...editProjectState(updated), sourceAssetId: source.id, analysisComplete: true }
      } });
      return tx.editProject.findUniqueOrThrow({ where: { id }, include: includeProject });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async updateElements(id: string, input: { revision?: unknown; elements?: unknown }) {
    const revision = parseRevision(input.revision);
    if (!Array.isArray(input.elements)) throw new BadRequestException('elements must be an array');
    const elements = input.elements.map((value, position) => this.parseElement(value, position));
    return serialize(await this.prisma.$transaction(async (tx) => {
      const current = await tx.editProject.findUnique({
        where: { id }, include: { elements: true, assets: { select: { id: true } } }
      });
      if (!current) throw new NotFoundException('EditProject not found');
      if (current.revision !== revision) throw new ConflictException('EditProject revision is stale');
      const assetIds = new Set(current.assets.map((asset) => asset.id));
      if (elements.some((element) => element.assetId && !assetIds.has(element.assetId))) {
        throw new BadRequestException('An element references an asset outside this EditProject');
      }
      await tx.editElement.deleteMany({ where: { editProjectId: id } });
      if (elements.length) await tx.editElement.createMany({ data: elements.map((element) => ({
        ...element, id: element.id ?? randomUUID(), editProjectId: id,
        properties: element.properties ?? {}
      })) });
      const nextRevision = current.revision + 1;
      const updated = await tx.editProject.update({ where: { id }, data: { revision: nextRevision } });
      await tx.editHistory.create({ data: {
        editProjectId: id, revision: nextRevision, actor: 'USER', action: 'ELEMENTS_UPDATED',
        command: { elementCount: elements.length },
        beforeState: { ...editProjectState(current), elements: serialize(current.elements) },
        afterState: { ...editProjectState(updated), elements }
      } });
      return tx.editProject.findUniqueOrThrow({ where: { id }, include: includeProject });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async trimElement(id: string, input: { revision?: unknown; elementId?: unknown;
    trimStart?: unknown; trimEnd?: unknown }) {
    const elementId = this.requiredString(input.elementId, 'elementId');
    const trimStart = this.finiteNumber(input.trimStart, 'trimStart');
    const trimEnd = this.finiteNumber(input.trimEnd, 'trimEnd');
    return this.manualMutation(id, input.revision, 'TRIM_ELEMENT',
      { elementId, trimStart, trimEnd }, (elements) => {
        const target = this.videoElement(elements, elementId);
        return elements.map((element) => element.id === target.id
          ? { ...element, trimStart, trimEnd, duration: trimEnd - trimStart }
          : element);
      });
  }

  async splitElement(id: string, input: { revision?: unknown; elementId?: unknown; playheadSec?: unknown }) {
    const elementId = this.requiredString(input.elementId, 'elementId');
    const playheadSec = this.finiteNumber(input.playheadSec, 'playheadSec');
    return this.manualMutation(id, input.revision, 'SPLIT_ELEMENT',
      { elementId, playheadSec }, (elements) => {
        const target = this.videoElement(elements, elementId);
        const offset = playheadSec - target.startTime;
        if (offset < MIN_VIDEO_DURATION_SEC || target.duration - offset < MIN_VIDEO_DURATION_SEC) {
          throw new BadRequestException({ code: 'INVALID_SPLIT',
            message: 'playheadSec must be safely inside the selected VIDEO element' });
        }
        const sourceSplit = target.trimStart! + offset;
        const right: TimelineElement = { ...target, id: randomUUID(), position: target.position + 1,
          trimStart: sourceSplit, trimEnd: target.trimEnd, duration: target.duration - offset };
        return elements.flatMap((element) => element.id === target.id
          ? [{ ...target, trimEnd: sourceSplit, duration: offset }, right]
          : [{ ...element, position: element.type === 'VIDEO' && element.track === 0 &&
              element.position > target.position ? element.position + 1 : element.position }]);
      });
  }

  async deleteElement(id: string, input: { revision?: unknown; elementId?: unknown }) {
    const elementId = this.requiredString(input.elementId, 'elementId');
    return this.manualMutation(id, input.revision, 'DELETE_ELEMENT', { elementId }, (elements) => {
      this.videoElement(elements, elementId);
      return elements.filter((element) => element.id !== elementId);
    });
  }

  async moveElement(id: string, input: { revision?: unknown; elementId?: unknown;
    toPosition?: unknown; track?: unknown }) {
    const elementId = this.requiredString(input.elementId, 'elementId');
    const toPosition = this.integer(input.toPosition, 'toPosition');
    const track = input.track === undefined ? 0 : this.integer(input.track, 'track');
    if (track !== 0) throw new BadRequestException({ code: 'UNSUPPORTED_TRACK',
      message: 'Phase 2 supports moving VIDEO elements only on track 0' });
    return this.manualMutation(id, input.revision, 'MOVE_ELEMENT', { elementId, toPosition, track },
      (elements) => {
        const target = this.videoElement(elements, elementId);
        const videos = elements.filter((element) => element.type === 'VIDEO' && element.track === 0)
          .sort((left, right) => left.position - right.position);
        if (toPosition < 0 || toPosition >= videos.length) throw new BadRequestException({
          code: 'INVALID_POSITION', message: 'toPosition is outside the VIDEO track' });
        const reordered = videos.filter((element) => element.id !== target.id);
        reordered.splice(toPosition, 0, target);
        const positions = new Map(reordered.map((element, position) => [element.id, position]));
        return elements.map((element) => positions.has(element.id)
          ? { ...element, position: positions.get(element.id)! } : element);
      });
  }

  async undo(id: string, revisionValue: unknown) {
    return this.historyMutation(id, revisionValue, 'UNDO');
  }

  async redo(id: string, revisionValue: unknown) {
    return this.historyMutation(id, revisionValue, 'REDO');
  }

  private async manualMutation(id: string, revisionValue: unknown, action: string,
    command: Prisma.InputJsonObject, mutate: (elements: TimelineElement[]) => TimelineElement[]) {
    const expectedRevision = parseRevision(revisionValue);
    return serialize(await this.prisma.$transaction(async (tx) => {
      const current = await tx.editProject.findUnique({ where: { id }, include: { elements: true,
        assets: { select: { id: true, duration: true } } } });
      if (!current) throw new NotFoundException('EditProject not found');
      this.assertRevision(current.revision, expectedRevision);
      const before = current.elements.map((element) => timelineElementState(element as unknown as Record<string, unknown>));
      const after = normalizeVideoTrack(mutate(before.map((element) => ({ ...element }))));
      this.validateTimeline(after, new Map(current.assets.map((asset) => [asset.id, asset.duration])));
      await this.replaceElements(tx, id, after);
      const revision = current.revision + 1;
      const updated = await tx.editProject.update({ where: { id }, data: { revision } });
      await tx.editHistory.create({ data: { editProjectId: id, revision, actor: 'USER', action,
        command, beforeState: { elements: serialize(before) }, afterState: { elements: serialize(after) } } });
      return tx.editProject.findUniqueOrThrow({ where: { id }, include: includeProject });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  private async historyMutation(id: string, revisionValue: unknown, direction: 'UNDO' | 'REDO') {
    const expectedRevision = parseRevision(revisionValue);
    return serialize(await this.prisma.$transaction(async (tx) => {
      const current = await tx.editProject.findUnique({ where: { id }, include: { elements: true } });
      if (!current) throw new NotFoundException('EditProject not found');
      this.assertRevision(current.revision, expectedRevision);
      const history = await tx.editHistory.findMany({ where: { editProjectId: id }, orderBy: { revision: 'asc' } });
      const manual = new Map(history.filter((entry) => MANUAL_ACTIONS.has(entry.action))
        .map((entry) => [entry.id, entry]));
      const active: string[] = [];
      let redo: string[] = [];
      for (const entry of history) {
        if (MANUAL_ACTIONS.has(entry.action)) { active.push(entry.id); redo = []; }
        else if (entry.action === 'UNDO') {
          const target = (entry.command as Record<string, unknown> | null)?.targetHistoryId;
          if (typeof target === 'string') {
            const index = active.lastIndexOf(target);
            if (index >= 0) active.splice(index, 1);
            redo.push(target);
          }
        } else if (entry.action === 'REDO') {
          const target = (entry.command as Record<string, unknown> | null)?.targetHistoryId;
          if (typeof target === 'string') {
            active.push(target);
            const index = redo.lastIndexOf(target);
            if (index >= 0) redo.splice(index, 1);
          }
        }
      }
      const targetId = direction === 'UNDO' ? active.at(-1) : redo.at(-1);
      const target = targetId ? manual.get(targetId) : undefined;
      if (!target) throw new BadRequestException({ code: `NOTHING_TO_${direction}`,
        message: `There is nothing to ${direction.toLowerCase()}` });
      const state = (direction === 'UNDO' ? target.beforeState : target.afterState) as
        { elements?: unknown } | null;
      if (!state || !Array.isArray(state.elements)) throw new BadRequestException({
        code: 'INVALID_HISTORY_STATE', message: 'The history entry cannot be restored' });
      const elements = state.elements.map((element, position) =>
        this.parseElement(element, position) as TimelineElement);
      await this.replaceElements(tx, id, elements);
      const revision = current.revision + 1;
      await tx.editProject.update({ where: { id }, data: { revision } });
      await tx.editHistory.create({ data: { editProjectId: id, revision, actor: 'USER', action: direction,
        command: { targetHistoryId: target.id, targetAction: target.action },
        beforeState: { elements: current.elements.map((element) => timelineElementState(
          element as unknown as Record<string, unknown>)) }, afterState: { elements } } });
      return tx.editProject.findUniqueOrThrow({ where: { id }, include: includeProject });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  private async replaceElements(tx: Prisma.TransactionClient, projectId: string, elements: TimelineElement[]) {
    await tx.editElement.deleteMany({ where: { editProjectId: projectId } });
    if (elements.length) await tx.editElement.createMany({ data: elements.map((element) => ({
      id: element.id, editProjectId: projectId, assetId: element.assetId ?? null, type: element.type,
      track: element.track, position: element.position, startTime: element.startTime,
      duration: element.duration, trimStart: element.trimStart ?? 0, trimEnd: element.trimEnd ?? null,
      properties: element.properties ?? {}
    })) });
  }

  private validateTimeline(elements: TimelineElement[], assetDurations: Map<string, number | null>) {
    for (const element of elements.filter((item) => item.type === 'VIDEO')) {
      if (element.track !== 0) throw new BadRequestException({ code: 'UNSUPPORTED_TRACK',
        message: 'Phase 2 supports VIDEO elements only on track 0' });
      if (!element.assetId || !assetDurations.has(element.assetId)) throw new BadRequestException({
        code: 'INVALID_ASSET', message: 'VIDEO element must reference an EditProject asset' });
      const trimStart = element.trimStart ?? 0;
      const trimEnd = element.trimEnd;
      const sourceDuration = assetDurations.get(element.assetId);
      if (!Number.isFinite(trimStart) || trimStart < 0 || trimEnd == null || !Number.isFinite(trimEnd) ||
        trimEnd - trimStart < MIN_VIDEO_DURATION_SEC || (sourceDuration != null && trimEnd > sourceDuration + 1e-6)) {
        throw new BadRequestException({ code: 'INVALID_TRIM',
          message: 'VIDEO source range is invalid or shorter than the safe minimum' });
      }
      if (Math.abs(element.duration - (trimEnd - trimStart)) > 1e-5) throw new BadRequestException({
        code: 'INVALID_DURATION', message: 'VIDEO duration must match its source trim range' });
    }
  }

  private videoElement(elements: TimelineElement[], id: string) {
    const element = elements.find((item) => item.id === id);
    if (!element) throw new NotFoundException('EditElement not found');
    if (element.type !== 'VIDEO') throw new BadRequestException({ code: 'INVALID_ELEMENT_TYPE',
      message: 'Manual Phase 2 commands require a VIDEO element' });
    return element;
  }

  private requiredString(value: unknown, field: string) {
    if (typeof value !== 'string' || !value) throw new BadRequestException(`${field} is required`);
    return value;
  }

  private finiteNumber(value: unknown, field: string) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new BadRequestException(`${field} must be a finite number`);
    return number;
  }

  private integer(value: unknown, field: string) {
    const number = Number(value);
    if (!Number.isInteger(number)) throw new BadRequestException(`${field} must be an integer`);
    return number;
  }

  private assertRevision(current: number, expected: number) {
    if (current !== expected) throw new ConflictException({ code: 'STALE_REVISION',
      message: 'EditProject revision is stale', currentRevision: current });
  }

  private parseElement(value: unknown, position: number): EditElementInput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException(`elements[${position}] must be an object`);
    }
    const item = value as Record<string, unknown>;
    const type = item.type;
    if (!Object.values(EditElementType).includes(type as EditElementType)) {
      throw new BadRequestException(`elements[${position}].type is invalid`);
    }
    const number = (field: string, fallback?: number) => {
      const candidate = item[field] === undefined ? fallback : Number(item[field]);
      if (candidate === undefined || !Number.isFinite(candidate)) {
        throw new BadRequestException(`elements[${position}].${field} must be a number`);
      }
      return candidate;
    };
    const duration = number('duration');
    if (duration <= 0) throw new BadRequestException(`elements[${position}].duration must be positive`);
    return {
      id: typeof item.id === 'string' ? item.id : undefined,
      assetId: typeof item.assetId === 'string' ? item.assetId : null,
      type: type as EditElementType,
      track: number('track'), position: number('position', position),
      startTime: number('startTime'), duration,
      trimStart: number('trimStart', 0),
      trimEnd: item.trimEnd == null ? null : number('trimEnd'),
      properties: item.properties && typeof item.properties === 'object' && !Array.isArray(item.properties)
        ? item.properties as Prisma.InputJsonValue : {}
    };
  }

  async history(id: string) {
    if (!await this.prisma.editProject.findUnique({ where: { id }, select: { id: true } })) {
      throw new NotFoundException('EditProject not found');
    }
    return this.prisma.editHistory.findMany({ where: { editProjectId: id }, orderBy: { revision: 'desc' } });
  }

  async assetFile(assetId: string, rangeHeader?: string) {
    const asset = await this.prisma.editAsset.findUnique({ where: { id: assetId } });
    if (!asset) throw new NotFoundException('EditAsset not found');
    const size = Number(asset.sizeBytes);
    const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/u);
    if (!match) return { stream: await this.storage.getObject(asset.bucket, asset.objectKey),
      size, start: 0, end: size - 1, partial: false, mimeType: asset.mimeType };
    const requestedStart = match[1] ? Number(match[1]) : 0;
    const requestedEnd = match[2] ? Number(match[2]) : size - 1;
    const start = Math.max(0, Math.min(size - 1, requestedStart));
    const end = Math.max(start, Math.min(size - 1, requestedEnd));
    return { stream: await this.storage.getPartialObject(asset.bucket, asset.objectKey,
      start, end - start + 1), size, start, end, partial: true, mimeType: asset.mimeType };
  }
}
