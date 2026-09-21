import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { EditAssetRole, EditElementType, Prisma } from '@prisma/client';
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
import type { PresetCommand } from './presets/edit-preset-commands';
import { EDIT_PRESET_IDS, readEditProjectStyle,
  type EditPresetRun } from './presets/edit-preset-policy';

const MIN_VIDEO_DURATION_SEC = 0.05;
const PHASE3_ACTIONS = [
  'ADD_IMAGE', 'ADD_LOGO', 'ADD_TEXT', 'ADD_AUDIO', 'MOVE_ELEMENT', 'RESIZE_ELEMENT',
  'SET_ELEMENT_TIMING', 'SET_ELEMENT_OPACITY', 'SET_ELEMENT_Z_INDEX', 'UPDATE_TEXT',
  'SET_AUDIO_VOLUME', 'SET_AUDIO_MUTED', 'SET_AUDIO_FADE', 'DUPLICATE_ELEMENT', 'REMOVE_ELEMENT'
] as const;
// Phase 4 adds one element action, reachable only through a validated preset
// plan: a transcript-exact caption line. There is no manual subtitle editor.
const PRESET_ONLY_ACTIONS = ['ADD_SUBTITLE'] as const;
// Actions that produce an undoable user-level revision. A whole preset
// application is one entry here, so it undoes and redoes as a single step.
const MANUAL_ACTIONS = new Set(['TRIM_ELEMENT', 'SPLIT_ELEMENT', 'DELETE_ELEMENT',
  'MOVE_ELEMENT', 'APPLY_PRESET', ...PHASE3_ACTIONS]);
const ELEMENT_ORIGINS = new Set(['USER', 'PRESET', 'ASSISTANT']);
const PRESET_ROLES = new Set(['HOOK', 'SUBTITLE', 'KEY_POINT', 'CTA', 'PRODUCT', 'LOGO', 'MUSIC']);
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const AUDIO_MIMES = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav',
  'audio/mp4', 'audio/x-m4a', 'audio/aac']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 200 * 1024 * 1024;

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

  async uploadAsset(id: string, file: Express.Multer.File, roleValue: unknown, revisionValue: unknown) {
    const expectedRevision = parseRevision(revisionValue);
    const role = typeof roleValue === 'string' ? roleValue.toUpperCase() : '';
    if (!['IMAGE', 'LOGO', 'AUDIO'].includes(role)) {
      throw new BadRequestException('role must be IMAGE, LOGO, or AUDIO');
    }
    const extension = extname(file.originalname).toLowerCase();
    const image = role === 'IMAGE' || role === 'LOGO';
    const allowedMime = image ? IMAGE_MIMES : AUDIO_MIMES;
    const allowedExtension = image ? IMAGE_EXTENSIONS : AUDIO_EXTENSIONS;
    const maxBytes = image ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
    if (!allowedMime.has(file.mimetype.toLowerCase()) || !allowedExtension.has(extension)) {
      throw new BadRequestException(`Unsupported ${image ? 'image' : 'audio'} MIME type or extension`);
    }
    if (!file.size || file.size > maxBytes) {
      throw new BadRequestException(`${image ? 'Image' : 'Audio'} file exceeds the size limit`);
    }
    const current = await this.prisma.editProject.findUnique({ where: { id }, select: { id: true, revision: true } });
    if (!current) throw new NotFoundException('EditProject not found');
    this.assertRevision(current.revision, expectedRevision);
    const assetId = randomUUID();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(-120) || `asset${extension}`;
    const objectKey = `edit-mode/${id}/assets/${assetId}/${safeName}`;
    const directory = await mkdtemp(join(tmpdir(), 'edit-mode-asset-'));
    const path = join(directory, `asset${extension}`);
    let stored: { bucket: string; objectKey: string } | null = null;
    try {
      await writeFile(path, file.buffer);
      const media = await this.probeAssetMedia(path);
      const imageFormat = media.formatName && /(?:image2|png_pipe|jpeg_pipe|webp_pipe)/iu.test(media.formatName);
      if (image && (!media.hasVideo || media.width == null || media.height == null || !imageFormat)) {
        throw new BadRequestException('Image file is not readable');
      }
      if (!image && (!media.hasAudio || !media.durationSec || media.durationSec <= 0)) {
        throw new BadRequestException('Audio file is not readable or has no audio stream');
      }
      stored = await this.storage.uploadBuffer({ buffer: file.buffer, objectKey, mimeType: file.mimetype });
      const result = await this.prisma.$transaction(async (tx) => {
        const latest = await tx.editProject.findUnique({ where: { id } });
        if (!latest) throw new NotFoundException('EditProject not found');
        this.assertRevision(latest.revision, expectedRevision);
        const asset = await tx.editAsset.create({ data: {
          id: assetId, editProjectId: id, role: role as EditAssetRole,
          originalName: file.originalname, bucket: stored!.bucket, objectKey: stored!.objectKey,
          mimeType: file.mimetype, sizeBytes: BigInt(file.size), duration: media.durationSec,
          width: media.width, height: media.height, fps: media.fps ?? null,
          metadata: { hasVideo: media.hasVideo, hasAudio: media.hasAudio,
            videoCodec: media.videoCodec, audioCodec: media.audioCodec, formatName: media.formatName }
        } });
        const revision = latest.revision + 1;
        await tx.editProject.update({ where: { id }, data: { revision } });
        await tx.editHistory.create({ data: { editProjectId: id, revision, actor: 'USER',
          action: 'ASSET_UPLOADED', command: { assetId, role },
          beforeState: editProjectState(latest), afterState: { ...editProjectState(latest), revision, assetId } } });
        return { asset: serialize(asset), revision };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return result;
    } catch (error) {
      if (stored) await this.storage.removeObject(stored.bucket, stored.objectKey).catch(() => undefined);
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async deleteAsset(id: string, assetId: string, revisionValue: unknown) {
    const expectedRevision = parseRevision(revisionValue);
    const result = await this.prisma.$transaction(async (tx) => {
      const project = await tx.editProject.findUnique({ where: { id } });
      if (!project) throw new NotFoundException('EditProject not found');
      this.assertRevision(project.revision, expectedRevision);
      const asset = await tx.editAsset.findUnique({ where: { id: assetId },
        include: { _count: { select: { elements: true } } } });
      if (!asset || asset.editProjectId !== id) throw new NotFoundException('EditAsset not found');
      if (asset.role === 'SOURCE') throw new BadRequestException('The source asset cannot be deleted here');
      if (asset._count.elements > 0) throw new ConflictException({ code: 'ASSET_IN_USE',
        message: 'Remove timeline elements that reference this asset before deleting it' });
      await tx.editAsset.delete({ where: { id: assetId } });
      const revision = project.revision + 1;
      await tx.editProject.update({ where: { id }, data: { revision } });
      await tx.editHistory.create({ data: { editProjectId: id, revision, actor: 'USER',
        action: 'ASSET_DELETED', command: { assetId }, beforeState: editProjectState(project),
        afterState: { ...editProjectState(project), revision, deletedAssetId: assetId } } });
      return { asset, revision };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await this.storage.removeObject(result.asset.bucket, result.asset.objectKey).catch(() => undefined);
    return { id: assetId, deleted: true, revision: result.revision };
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

  private probeAssetMedia(path: string) {
    return probeMedia(path);
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
      { elementId, trimStart, trimEnd }, (elements, assets) =>
        this.applyElementCommand('TRIM_ELEMENT', { elementId, trimStart, trimEnd },
          elements, assets));
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

  async phase3Command(id: string, actionValue: string, input: Record<string, unknown>) {
    const action = actionValue.replace(/-/gu, '_').toUpperCase();
    if (PRESET_ONLY_ACTIONS.includes(action as typeof PRESET_ONLY_ACTIONS[number])) {
      throw new BadRequestException({ code: 'PRESET_ONLY_COMMAND',
        message: `${action} is produced by a preset plan and is not a manual command` });
    }
    if (!PHASE3_ACTIONS.includes(action as typeof PHASE3_ACTIONS[number])) {
      throw new BadRequestException({ code: 'UNSUPPORTED_COMMAND', message: 'Unsupported EditMode command' });
    }
    const { revision: _revision, ...commandValue } = input;
    const command = commandValue as Prisma.InputJsonObject;
    return this.manualMutation(id, input.revision, action, command,
      (elements, assets) => this.applyElementCommand(action, input, elements, assets));
  }

  /**
   * The single element mutation path.
   *
   * Manual Phase 3 commands and preset-generated commands both run through
   * here, so a preset can never reach the timeline by a route that skips the
   * validation the manual editor is held to.
   */
  private applyElementCommand(action: string, input: Record<string, unknown>,
    elements: TimelineElement[], assets: Map<string, {
      id: string; role: EditAssetRole; duration: number | null;
      width: number | null; height: number | null;
    }>): TimelineElement[] {
    {
      const projectDuration = elements.filter((item) => item.type === 'VIDEO' && item.track === 0)
        .reduce((total, item) => total + item.duration, 0);
      const assetId = typeof input.assetId === 'string' ? input.assetId : '';
      const elementId = typeof input.elementId === 'string' ? input.elementId : '';
      const asset = assetId ? assets.get(assetId) : undefined;
      const target = elementId ? elements.find((item) => item.id === elementId) : undefined;
      const nextPosition = (track: number) => elements.filter((item) => item.track === track).length;
      const add = (element: TimelineElement) => [...elements, element];
      const normalizedDuration = (value: number) => Math.max(MIN_VIDEO_DURATION_SEC,
        Math.min(value, projectDuration || value));
      const requireTarget = () => {
        if (!target) throw new NotFoundException('EditElement not found');
        return target;
      };
      const requireVisual = () => {
        const item = requireTarget();
        // Preset-authored caption lines are repositionable by hand, but their
        // wording stays transcript-exact: UPDATE_TEXT remains TEXT-only.
        if (item.type !== 'IMAGE' && item.type !== 'TEXT' && item.type !== 'SUBTITLE') {
          throw new BadRequestException({ code: 'INVALID_ELEMENT_TYPE',
            message: 'Command requires an IMAGE, LOGO, TEXT, or SUBTITLE element' });
        }
        return item;
      };
      const withProperties = (item: TimelineElement, properties: Record<string, unknown>) =>
        elements.map((candidate) => candidate.id === item.id ? { ...candidate,
          properties: { ...(item.properties as Record<string, unknown>), ...properties } as Prisma.InputJsonValue }
          : candidate);

      if (action === 'TRIM_ELEMENT') {
        const trimStart = this.finiteNumber(input.trimStart, 'trimStart');
        const trimEnd = this.finiteNumber(input.trimEnd, 'trimEnd');
        const item = this.videoElement(elements, this.requiredString(input.elementId, 'elementId'));
        return elements.map((candidate) => candidate.id === item.id
          ? { ...candidate, trimStart, trimEnd, duration: trimEnd - trimStart } : candidate);
      }
      if (action === 'ADD_IMAGE' || action === 'ADD_LOGO') {
        const expectedRole = action === 'ADD_LOGO' ? 'LOGO' : 'IMAGE';
        if (!asset || asset.role !== expectedRole) throw new BadRequestException({ code: 'INVALID_ASSET',
          message: `${expectedRole} asset must belong to this EditProject` });
        const width = expectedRole === 'LOGO' ? 0.2 : 0.5;
        const ratio = asset.width && asset.height ? asset.height / asset.width : 1;
        const height = Math.min(0.8, width * ratio * 16 / 9);
        const x = expectedRole === 'LOGO' ? 0.76 : (1 - width) / 2;
        const y = expectedRole === 'LOGO' ? 0.04 : (1 - height) / 2;
        return add({ id: randomUUID(), assetId, type: 'IMAGE', track: 2,
          position: nextPosition(2), startTime: 0, duration: normalizedDuration(projectDuration),
          trimStart: 0, trimEnd: null, properties: { x, y, width, height, scale: 1, rotation: 0,
            opacity: 1, zIndex: expectedRole === 'LOGO' ? 20 : 10, anchor: 'top-left',
            locked: false, role: expectedRole, preserveAspectRatio: true,
            ...this.originProperties(input) } });
      }
      if (action === 'ADD_TEXT') {
        return add({ id: randomUUID(), assetId: null, type: 'TEXT', track: 1,
          position: nextPosition(1), startTime: 0, duration: normalizedDuration(projectDuration),
          trimStart: 0, trimEnd: null, properties: { content: 'Text', x: 0.2, y: 0.42,
            width: 0.6, height: 0.16, scale: 1, fontSize: 48, fontWeight: 700,
            fontFamily: 'Arial, sans-serif', textAlign: 'center', color: '#ffffff',
            backgroundColor: 'transparent', rotation: 0, opacity: 1, zIndex: 30,
            anchor: 'top-left', locked: false, ...this.originProperties(input) } });
      }
      if (action === 'ADD_AUDIO') {
        if (!asset || asset.role !== 'AUDIO' || !asset.duration) throw new BadRequestException({
          code: 'INVALID_ASSET', message: 'A readable AUDIO asset must belong to this EditProject' });
        const duration = normalizedDuration(Math.min(asset.duration, projectDuration));
        return add({ id: randomUUID(), assetId, type: 'AUDIO', track: 3,
          position: nextPosition(3), startTime: 0, duration, trimStart: 0, trimEnd: duration,
          properties: { volume: 0.25, muted: false, fadeInSec: 0, fadeOutSec: 0,
            duckUnderSpeech: false, duckLevel: 0.25, attackMs: 150, releaseMs: 350,
            ...this.originProperties(input) } });
      }
      if (action === 'MOVE_ELEMENT') {
        const item = requireVisual();
        const properties = item.properties as Record<string, unknown>;
        const width = Number(properties.width ?? 0.2); const height = Number(properties.height ?? 0.2);
        const x = this.unitNumber(input.x, 'x'); const y = this.unitNumber(input.y, 'y');
        return withProperties(item, { x: Math.min(x, 1 - width), y: Math.min(y, 1 - height) });
      }
      if (action === 'RESIZE_ELEMENT') {
        const item = requireVisual();
        const width = this.unitNumber(input.width, 'width');
        const height = this.unitNumber(input.height, 'height');
        if (width < 0.02 || height < 0.02) throw new BadRequestException('width and height must be at least 0.02');
        const properties = item.properties as Record<string, unknown>;
        const x = Number(properties.x ?? 0); const y = Number(properties.y ?? 0);
        return withProperties(item, { width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) });
      }
      if (action === 'SET_ELEMENT_TIMING') {
        const item = requireTarget();
        if (item.type === 'VIDEO') throw new BadRequestException('Use trim/split commands for VIDEO timing');
        const startTime = this.nonNegativeNumber(input.startTime, 'startTime');
        const duration = this.positiveNumber(input.duration, 'duration');
        if (startTime + duration > projectDuration + 1e-6) throw new BadRequestException({
          code: 'TIMING_OUT_OF_RANGE', message: 'Element timing must stay within the video timeline' });
        const trimStart = input.trimStart === undefined ? item.trimStart ?? 0
          : this.nonNegativeNumber(input.trimStart, 'trimStart');
        const trimEnd = input.trimEnd === undefined ? (item.type === 'AUDIO' ? trimStart + duration : null)
          : this.positiveNumber(input.trimEnd, 'trimEnd');
        return elements.map((candidate) => candidate.id === item.id
          ? { ...candidate, startTime, duration, trimStart, trimEnd } : candidate);
      }
      if (action === 'SET_ELEMENT_OPACITY') return withProperties(requireVisual(),
        { opacity: this.unitNumber(input.opacity, 'opacity') });
      if (action === 'SET_ELEMENT_Z_INDEX') return withProperties(requireVisual(),
        { zIndex: this.integer(input.zIndex, 'zIndex') });
      if (action === 'UPDATE_TEXT') {
        const item = requireTarget();
        if (item.type !== 'TEXT') throw new BadRequestException('UPDATE_TEXT requires a TEXT element');
        if (typeof input.content !== 'string') throw new BadRequestException('content must be a string');
        const content = input.content.slice(0, 2000);
        const patch: Record<string, unknown> = { content };
        if (input.fontSize !== undefined) patch.fontSize = Math.min(300, Math.max(8,
          this.positiveNumber(input.fontSize, 'fontSize')));
        if (input.fontWeight !== undefined) patch.fontWeight = Math.min(900, Math.max(100,
          this.integer(input.fontWeight, 'fontWeight')));
        if (input.fontFamily !== undefined) {
          const family = String(input.fontFamily);
          if (!['Arial, sans-serif', 'Georgia, serif', 'monospace'].includes(family)) {
            throw new BadRequestException('fontFamily is invalid');
          }
          patch.fontFamily = family;
        }
        if (input.color !== undefined) patch.color = this.cssColor(input.color, 'color');
        if (input.backgroundColor !== undefined) patch.backgroundColor =
          input.backgroundColor === 'transparent' ? 'transparent' : this.cssColor(input.backgroundColor, 'backgroundColor');
        if (input.textAlign !== undefined) {
          if (!['left', 'center', 'right'].includes(String(input.textAlign))) throw new BadRequestException('textAlign is invalid');
          patch.textAlign = input.textAlign;
        }
        return withProperties(item, patch);
      }
      if (action === 'SET_AUDIO_VOLUME' || action === 'SET_AUDIO_MUTED' || action === 'SET_AUDIO_FADE') {
        const item = requireTarget();
        if (item.type !== 'AUDIO') throw new BadRequestException('Audio command requires an AUDIO element');
        if (action === 'SET_AUDIO_VOLUME') return withProperties(item,
          { volume: this.unitNumber(input.volume, 'volume') });
        if (action === 'SET_AUDIO_MUTED') {
          if (typeof input.muted !== 'boolean') throw new BadRequestException('muted must be boolean');
          return withProperties(item, { muted: input.muted });
        }
        const fadeInSec = this.nonNegativeNumber(input.fadeInSec, 'fadeInSec');
        const fadeOutSec = this.nonNegativeNumber(input.fadeOutSec, 'fadeOutSec');
        if (fadeInSec + fadeOutSec > item.duration) throw new BadRequestException('Audio fades exceed element duration');
        return withProperties(item, { fadeInSec, fadeOutSec });
      }
      if (action === 'DUPLICATE_ELEMENT') {
        const item = requireTarget();
        if (item.type === 'VIDEO') throw new BadRequestException('VIDEO elements cannot be duplicated');
        return add({ ...item, id: randomUUID(), position: nextPosition(item.track),
          properties: { ...(item.properties as Record<string, unknown>) } as Prisma.InputJsonValue });
      }
      if (action === 'REMOVE_ELEMENT') {
        const item = requireTarget();
        if (item.type === 'VIDEO') throw new BadRequestException('Use VIDEO delete for ripple deletion');
        return elements.filter((candidate) => candidate.id !== item.id);
      }
      if (action === 'ADD_SUBTITLE') {
        // Caption text and timing come straight from the cached transcript, so
        // they are accepted verbatim and only bounds-checked here.
        if (typeof input.content !== 'string' || !input.content.trim()) {
          throw new BadRequestException('content is required for ADD_SUBTITLE');
        }
        const startTime = this.nonNegativeNumber(input.startTime, 'startTime');
        const duration = this.positiveNumber(input.duration, 'duration');
        if (startTime + duration > projectDuration + 1e-6) throw new BadRequestException({
          code: 'TIMING_OUT_OF_RANGE', message: 'Subtitle timing must stay within the video timeline' });
        return add({ id: randomUUID(), assetId: null, type: 'SUBTITLE', track: 1,
          position: nextPosition(1), startTime, duration, trimStart: 0, trimEnd: null,
          properties: { content: input.content.slice(0, 500),
            x: this.unitNumber(input.x ?? 0.1, 'x'), y: this.unitNumber(input.y ?? 0.73, 'y'),
            width: this.unitNumber(input.width ?? 0.8, 'width'),
            height: this.unitNumber(input.height ?? 0.13, 'height'),
            scale: 1, fontSize: 40, fontWeight: 700, fontFamily: 'Arial, sans-serif',
            textAlign: 'center', color: '#ffffff', backgroundColor: '#00000099', rotation: 0,
            opacity: 1, zIndex: this.integer(input.zIndex ?? 35, 'zIndex'), anchor: 'top-left',
            locked: false, ...this.originProperties(input) } });
      }
      throw new BadRequestException({ code: 'UNSUPPORTED_COMMAND',
        message: 'Unsupported EditMode command' });
    }
  }

  /**
   * Typed provenance for a newly created element.
   *
   * Every add stamps an origin, so a preset reapply can tell the elements it
   * owns from the ones the user made by hand. Manual adds default to USER.
   */
  private originProperties(input: Record<string, unknown>): Record<string, unknown> {
    const origin = input.origin === undefined ? 'USER' : String(input.origin);
    if (!ELEMENT_ORIGINS.has(origin)) throw new BadRequestException('origin is invalid');
    const properties: Record<string, unknown> = { origin };
    if (origin === 'USER') return properties;
    if (input.presetId !== undefined) {
      if (!(EDIT_PRESET_IDS as readonly string[]).includes(String(input.presetId))) {
        throw new BadRequestException('presetId is invalid');
      }
      properties.presetId = String(input.presetId);
    }
    if (input.presetRole !== undefined) {
      if (!PRESET_ROLES.has(String(input.presetRole))) {
        throw new BadRequestException('presetRole is invalid');
      }
      properties.presetRole = String(input.presetRole);
    }
    if (input.presetRunId !== undefined) {
      if (typeof input.presetRunId !== 'string' || !/^[a-z0-9-]{1,64}$/iu.test(input.presetRunId)) {
        throw new BadRequestException('presetRunId is invalid');
      }
      properties.presetRunId = input.presetRunId;
    }
    if (input.createdAtRevision !== undefined) {
      properties.createdAtRevision = this.integer(input.createdAtRevision, 'createdAtRevision');
    }
    return properties;
  }

  /**
   * Applies a validated preset plan as ONE user-level action.
   *
   * Every element command is folded through `applyElementCommand` and the
   * timeline is normalised and validated after each step, exactly as a manual
   * command would be. Settings commands fold into the project style block. The
   * whole bundle commits in one transaction and writes exactly one EditHistory
   * row, actor PRESET, whose before/after state carries both the elements and
   * the settings - so a single undo restores the complete pre-preset project.
   */
  async applyPresetBundle(id: string, revisionValue: unknown, bundle: {
    presetId: string; presetRunId: string; summary: string;
    commands: PresetCommand[]; plannedZoomMoments: EditPresetRun['plannedZoomMoments'];
  }) {
    const expectedRevision = parseRevision(revisionValue);
    if (!(EDIT_PRESET_IDS as readonly string[]).includes(bundle.presetId)) {
      throw new BadRequestException({ code: 'UNKNOWN_PRESET', message: 'Unknown preset' });
    }
    return serialize(await this.prisma.$transaction(async (tx) => {
      const current = await tx.editProject.findUnique({ where: { id }, include: { elements: true,
        assets: { select: { id: true, role: true, duration: true, width: true, height: true } } } });
      if (!current) throw new NotFoundException('EditProject not found');
      this.assertRevision(current.revision, expectedRevision);
      const before = current.elements.map((element) =>
        timelineElementState(element as unknown as Record<string, unknown>));
      const assetMap = new Map(current.assets.map((asset) => [asset.id, asset]));
      const revision = current.revision + 1;
      const settingsBefore = current.settings && typeof current.settings === 'object' &&
        !Array.isArray(current.settings) ? current.settings as Record<string, unknown> : {};

      let elements = before.map((element) => ({ ...element }));
      let style = readEditProjectStyle(settingsBefore);
      const refs = new Map<string, string>();
      const trims: EditPresetRun['trims'] = [];

      for (const command of bundle.commands) {
        if (command.kind === 'SETTINGS') { style = { ...style, ...command.payload }; continue; }
        const payload: Record<string, unknown> = { ...command.payload };
        if (typeof payload.ref === 'string') {
          const resolved = refs.get(payload.ref);
          if (!resolved) throw new BadRequestException({ code: 'INVALID_PRESET_COMMAND',
            message: `Preset plan references an element it never created ("${payload.ref}")` });
          payload.elementId = resolved;
          delete payload.ref;
        }
        const creates = command.action.startsWith('ADD_');
        if (creates) {
          payload.origin = payload.origin ?? 'PRESET';
          payload.presetRunId = bundle.presetRunId;
          payload.createdAtRevision = revision;
        }
        const priorIds = new Set(elements.map((element) => element.id));
        const next = normalizeVideoTrack(
          this.applyElementCommand(command.action, payload, elements, assetMap));
        this.validateTimeline(next, assetMap);
        elements = next;
        if (creates && command.ref) {
          const created = elements.find((element) => !priorIds.has(element.id));
          if (created) refs.set(command.ref, created.id);
        }
        if (command.action === 'TRIM_ELEMENT') {
          trims.push({ elementId: String(payload.elementId),
            trimStart: Number(payload.trimStart), trimEnd: Number(payload.trimEnd) });
        }
      }

      await this.replaceElements(tx, id, elements);
      const presetRun: EditPresetRun = { presetId: bundle.presetId as EditPresetRun['presetId'],
        presetRunId: bundle.presetRunId, appliedAtRevision: revision, summary: bundle.summary,
        plannedZoomMoments: bundle.plannedZoomMoments, trims };
      const settingsAfter = { ...settingsBefore, ...style, presetRun } as Prisma.InputJsonValue;
      await tx.editProject.update({ where: { id }, data: { revision, settings: settingsAfter } });
      await tx.editHistory.create({ data: { editProjectId: id, revision, actor: 'PRESET',
        action: 'APPLY_PRESET',
        command: { presetId: bundle.presetId, presetRunId: bundle.presetRunId,
          commandCount: bundle.commands.length, summary: bundle.summary },
        beforeState: { elements: serialize(before), settings: settingsBefore as Prisma.InputJsonValue },
        afterState: { elements: serialize(elements), settings: settingsAfter } } });
      return tx.editProject.findUniqueOrThrow({ where: { id }, include: includeProject });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async undo(id: string, revisionValue: unknown) {
    return this.historyMutation(id, revisionValue, 'UNDO');
  }

  async redo(id: string, revisionValue: unknown) {
    return this.historyMutation(id, revisionValue, 'REDO');
  }

  private async manualMutation(id: string, revisionValue: unknown, action: string,
    command: Prisma.InputJsonObject, mutate: (elements: TimelineElement[], assets: Map<string, {
      id: string; role: EditAssetRole; duration: number | null; width: number | null; height: number | null;
    }>) => TimelineElement[]) {
    const expectedRevision = parseRevision(revisionValue);
    return serialize(await this.prisma.$transaction(async (tx) => {
      const current = await tx.editProject.findUnique({ where: { id }, include: { elements: true,
        assets: { select: { id: true, role: true, duration: true, width: true, height: true } } } });
      if (!current) throw new NotFoundException('EditProject not found');
      this.assertRevision(current.revision, expectedRevision);
      const before = current.elements.map((element) => timelineElementState(element as unknown as Record<string, unknown>));
      const assetMap = new Map(current.assets.map((asset) => [asset.id, asset]));
      const after = normalizeVideoTrack(mutate(before.map((element) => ({ ...element })), assetMap));
      this.validateTimeline(after, assetMap);
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
        { elements?: unknown; settings?: unknown } | null;
      if (!state || !Array.isArray(state.elements)) throw new BadRequestException({
        code: 'INVALID_HISTORY_STATE', message: 'The history entry cannot be restored' });
      const elements = state.elements.map((element, position) =>
        this.parseElement(element, position) as TimelineElement);
      await this.replaceElements(tx, id, elements);
      const revision = current.revision + 1;
      // A preset application changes settings as well as elements, so its
      // history entries carry both and both are restored together. Entries
      // written before Phase 4 carry no settings and leave them alone.
      const restoresSettings = state.settings && typeof state.settings === 'object' &&
        !Array.isArray(state.settings);
      await tx.editProject.update({ where: { id }, data: { revision,
        ...(restoresSettings ? { settings: state.settings as Prisma.InputJsonValue } : {}) } });
      await tx.editHistory.create({ data: { editProjectId: id, revision, actor: 'USER', action: direction,
        command: { targetHistoryId: target.id, targetAction: target.action },
        beforeState: { elements: current.elements.map((element) => timelineElementState(
          element as unknown as Record<string, unknown>)),
        ...(restoresSettings ? { settings: current.settings } : {}) },
        afterState: serialize({ elements,
          ...(restoresSettings ? { settings: state.settings } : {}) }) as Prisma.InputJsonValue } });
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

  private validateTimeline(elements: TimelineElement[], assets: Map<string, {
    id: string; role: EditAssetRole; duration: number | null; width: number | null; height: number | null;
  }>) {
    const projectDuration = elements.filter((item) => item.type === 'VIDEO' && item.track === 0)
      .reduce((total, item) => total + item.duration, 0);
    for (const element of elements.filter((item) => item.type === 'VIDEO')) {
      if (element.track !== 0) throw new BadRequestException({ code: 'UNSUPPORTED_TRACK',
        message: 'Phase 2 supports VIDEO elements only on track 0' });
      if (!element.assetId || !assets.has(element.assetId)) throw new BadRequestException({
        code: 'INVALID_ASSET', message: 'VIDEO element must reference an EditProject asset' });
      const trimStart = element.trimStart ?? 0;
      const trimEnd = element.trimEnd;
      const sourceDuration = assets.get(element.assetId)?.duration;
      if (!Number.isFinite(trimStart) || trimStart < 0 || trimEnd == null || !Number.isFinite(trimEnd) ||
        trimEnd - trimStart < MIN_VIDEO_DURATION_SEC || (sourceDuration != null && trimEnd > sourceDuration + 1e-6)) {
        throw new BadRequestException({ code: 'INVALID_TRIM',
          message: 'VIDEO source range is invalid or shorter than the safe minimum' });
      }
      if (Math.abs(element.duration - (trimEnd - trimStart)) > 1e-5) throw new BadRequestException({
        code: 'INVALID_DURATION', message: 'VIDEO duration must match its source trim range' });
    }
    for (const element of elements.filter((item) => item.type !== 'VIDEO')) {
      if (!Number.isFinite(element.startTime) || element.startTime < 0 ||
        !Number.isFinite(element.duration) || element.duration <= 0 ||
        element.startTime + element.duration > projectDuration + 1e-6) {
        throw new BadRequestException({ code: 'TIMING_OUT_OF_RANGE',
          message: 'Overlay and audio timing must stay within the video timeline' });
      }
      if ((element.type === 'IMAGE' || element.type === 'AUDIO') &&
        (!element.assetId || !assets.has(element.assetId))) throw new BadRequestException({
        code: 'INVALID_ASSET', message: `${element.type} element must reference an EditProject asset` });
      if (element.type === 'AUDIO') {
        const sourceDuration = element.assetId ? assets.get(element.assetId)?.duration : null;
        const trimStart = element.trimStart ?? 0;
        const trimEnd = element.trimEnd ?? trimStart + element.duration;
        if (trimStart < 0 || trimEnd <= trimStart || Math.abs(trimEnd - trimStart - element.duration) > 1e-5 ||
          (sourceDuration != null && trimEnd > sourceDuration + 1e-6)) throw new BadRequestException({
          code: 'INVALID_TRIM', message: 'AUDIO source range is invalid' });
      }
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

  private positiveNumber(value: unknown, field: string) {
    const number = this.finiteNumber(value, field);
    if (number <= 0) throw new BadRequestException(`${field} must be positive`);
    return number;
  }

  private nonNegativeNumber(value: unknown, field: string) {
    const number = this.finiteNumber(value, field);
    if (number < 0) throw new BadRequestException(`${field} must be non-negative`);
    return number;
  }

  private unitNumber(value: unknown, field: string) {
    const number = this.finiteNumber(value, field);
    if (number < 0 || number > 1) throw new BadRequestException(`${field} must be between 0 and 1`);
    return number;
  }

  private cssColor(value: unknown, field: string) {
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/iu.test(value)) {
      throw new BadRequestException(`${field} must be a hex color`);
    }
    return value;
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
