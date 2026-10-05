import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
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
import type { TemplateCommand, TemplateImprint } from './templates/edit-template-plan';
import { EDIT_PRESET_IDS, readEditProjectStyle,
  type EditPresetRun } from './presets/edit-preset-policy';
import { retimeOverlays, timelineDurationFor, TransformRangeError, validateCrop,
  validateOffset, validateRotation, validateScale, validateSpeed, videoLayout,
  readSpeed, readCrop, NEUTRAL_CROP, MIN_CROP_REMAINDER } from './edit-mode-transform';
import { AudioRangeError, DEFAULT_ATTACK_MS, DEFAULT_DUCK_STRENGTH, DEFAULT_MUSIC_VOLUME,
  DEFAULT_RELEASE_MS, DUCK_STRENGTHS, readAudioState, validateAudioTrim, validateBoolean,
  validateDuckStrength, validateDuckTiming, validateFades,
  validateVolume } from './edit-mode-audio';
import { ColorRangeError, NEUTRAL_COLOR, colorProperties, readColor,
  readColorFilterId, readColorFilterStrength, resolveColorFilter, validateColorFilterId,
  validateColorFilterStrength, validateColorValue, type ColorKey } from './edit-mode-color';
import { adjacentCaption, CaptionGenerationError, generateCaptions, mergeCaptions,
  splitCaption, MIN_CAPTION_SEC } from './edit-mode-captions';
import { buildTimelineMap } from './render/edit-mode-timeline-map';
import { wordsFromCache } from './presets/edit-preset-evidence';
import { captionStylePreset, DEFAULT_CAPTION_BOX, effectiveBackgroundColor,
  extractStyleProperties, readCaptionWords, readTextStyle, styleProperties, textStylePreset,
  TextRangeError, validateActiveWord, validateAlignment, validateBackground, validateColor,
  validateFontFamily, validateFontSize, validateFontWeight, validateShadow, validateSpacing,
  validateStroke, MAX_CAPTION_LENGTH, MAX_TEXT_LENGTH,
  type CaptionWord } from './edit-mode-text';
import { assertStoredZoom, readZoomEffect, validateZoomScale, zoomProperties, ZoomRangeError,
  MAX_ZOOM_SCALE, MIN_ZOOM_SCALE, ZOOM_SCALE_STEP,
  MIN_ZOOM_DURATION_SEC } from './edit-mode-zoom-events';
import { editAssetOwnsStorage, editAssetStorageLocation } from './edit-asset-storage';
import { readGeneratedClipLineage } from './generated-clip-lineage';
import { assertEditScope, blockingEditConstraint, describeChanges, rangeViolation,
  readEditCommandActor, readEditCommandScope, readEditConstraints, readProjectConstraints,
  semanticRole, type EditCommandActor, type EditCommandResult, type EditCommandResultStatus,
  type EditCommandScope, type EditConstraint } from './edit-command-scope';
import { aspectCropInsets, FramingError, resolveReframePolicy, validateFramingAspect,
  validateFramingMode } from './edit-mode-framing';
import { ZOOM_POLICIES, type ZoomPolicy } from './presets/edit-preset-policy';

const MIN_VIDEO_DURATION_SEC = 0.05;

export class MediaRangeNotSatisfiableError extends Error {
  constructor(readonly size: number) {
    super('The requested media range is not satisfiable');
    this.name = 'MediaRangeNotSatisfiableError';
  }
}

export const resolveMediaByteRange = (header: string | undefined, size: number) => {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/u);
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(size) || size <= 0) {
    throw new MediaRangeNotSatisfiableError(size);
  }
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new MediaRangeNotSatisfiableError(size);
    }
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) ||
    start < 0 || start >= size || requestedEnd < start) {
    throw new MediaRangeNotSatisfiableError(size);
  }
  return { start, end: Math.min(size - 1, requestedEnd) };
};
const PHASE3_ACTIONS = [
  'ADD_IMAGE', 'ADD_LOGO', 'ADD_TEXT', 'ADD_AUDIO', 'MOVE_ELEMENT', 'RESIZE_ELEMENT',
  'SET_ELEMENT_TIMING', 'SET_ELEMENT_OPACITY', 'SET_ELEMENT_Z_INDEX', 'UPDATE_TEXT',
  'SET_AUDIO_VOLUME', 'SET_AUDIO_MUTED', 'SET_AUDIO_FADE', 'DUPLICATE_ELEMENT', 'REMOVE_ELEMENT',
  // Manual transform. Crop, rotation and flip apply to the VIDEO track and to
  // IMAGE/LOGO overlays; scale, position and speed are VIDEO-only. They are
  // ordinary typed commands, so they inherit validation, history and undo, and
  // an assistant bundle reaches them by exactly the same path the editor does.
  'SET_VIDEO_CROP', 'SET_VIDEO_ROTATION', 'SET_VIDEO_FLIP', 'SET_VIDEO_SCALE',
  'SET_VIDEO_POSITION', 'SET_SPEED',
  // Workstream C: professional text. Each property is its own typed, validated,
  // undoable command rather than one JSON patch, so an assistant turn and the
  // inspector reach exactly the same code with exactly the same bounds.
  'SET_TEXT_CONTENT', 'SET_TEXT_FONT', 'SET_TEXT_SIZE', 'SET_TEXT_WEIGHT', 'SET_TEXT_COLOR',
  'SET_TEXT_ALIGNMENT', 'SET_TEXT_STROKE', 'SET_TEXT_SHADOW', 'SET_TEXT_BACKGROUND',
  'SET_TEXT_SPACING', 'SET_TEXT_STYLE_PRESET', 'SET_TEXT_CASE', 'SET_TEXT_RUNS',
  // Workstream C: captions. Generation, wording, split, merge and style are all
  // canonical element mutations on the same SUBTITLE elements the renderer reads.
  'GENERATE_CAPTIONS', 'REMOVE_CAPTIONS', 'SET_CAPTIONS_VISIBLE', 'SET_CAPTION_TEXT',
  'SPLIT_CAPTION', 'MERGE_CAPTION', 'SET_CAPTION_STYLE', 'SET_CAPTION_ACTIVE_WORD',
  'APPLY_CAPTION_STYLE_TO_ALL',
  // Workstream D: professional colour. One typed command per control rather
  // than a generic SET_VIDEO_COLOR_PROPERTIES patch, so every change is
  // independently validated, independently undoable, and reachable by name from
  // a later assistant turn ("make it warmer") without a JSON schema in between.
  'SET_VIDEO_EXPOSURE', 'SET_VIDEO_BRIGHTNESS', 'SET_VIDEO_CONTRAST', 'SET_VIDEO_HIGHLIGHTS',
  'SET_VIDEO_SHADOWS', 'SET_VIDEO_SATURATION', 'SET_VIDEO_TEMPERATURE', 'SET_VIDEO_TINT',
  'SET_VIDEO_SHARPNESS', 'SET_VIDEO_FADE', 'SET_VIDEO_VIGNETTE',
  'RESET_VIDEO_ADJUSTMENTS', 'APPLY_COLOR_FILTER', 'PASTE_VIDEO_ADJUSTMENTS',
  // Workstream D: audio. The source video's own level, a music clip's source
  // trim, and speech ducking.
  'SET_SOURCE_AUDIO_VOLUME', 'SET_SOURCE_AUDIO_MUTED', 'SET_AUDIO_TRIM', 'SET_AUDIO_DUCKING',
  // Workstream E: the two pieces of timeline track state that have to survive a
  // reload and reach the renderer. Both already existed as stored properties
  // (`hidden` was honoured by the render plan, `locked` by the preview) with no
  // command able to set them; these close that gap rather than inventing state.
  'SET_ELEMENT_VISIBLE', 'SET_ELEMENT_LOCKED',
  // Workstream G: a zoom is an editable EFFECT element, so "make this zoom
  // deeper" changes that one event rather than re-planning every zoom.
  'ADD_ZOOM', 'SET_ZOOM_SCALE', 'REMOVE_ZOOM',
  // Step 5: canonical scope primitives. Whole-project framing and reframe
  // policy, relative zoom strength, and explicit caption regeneration (the only
  // command besides SET_CAPTION_TEXT allowed to rewrite caption wording).
  'SET_VIDEO_FRAMING', 'SET_REFRAME_POLICY', 'ADJUST_ZOOM_STRENGTH', 'REGENERATE_CAPTIONS',
  // Step 10: what shows behind a fitted (letterboxed) frame.
  'SET_FIT_BACKGROUND'
] as const;

/** Caption wording provenance. Legacy captions read from `manualEdited`. */
export const CAPTION_TEXT_SOURCES = ['TRANSCRIPT_GENERATED', 'MANUAL_EDITED', 'AI_REWRITTEN'] as const;
export type CaptionTextSource = typeof CAPTION_TEXT_SOURCES[number];
export const readCaptionTextSource = (properties: unknown): CaptionTextSource => {
  const p = properties && typeof properties === 'object' ? properties as Record<string, unknown> : {};
  if ((CAPTION_TEXT_SOURCES as readonly string[]).includes(String(p.textSource))) {
    return p.textSource as CaptionTextSource;
  }
  return p.manualEdited === true ? 'MANUAL_EDITED' : 'TRANSCRIPT_GENERATED';
};

/**
 * Per-command execution context. `actor` decides which constraints bind and
 * how provenance is stamped; `settingsPatch` is how an element command that
 * also changes project-level canonical state (canvas, reframe policy, zoom or
 * subtitle policy) reports it, so every caller commits it in the SAME revision.
 */
type CommandContext = {
  actor: EditCommandActor;
  settings: Record<string, unknown>;
  settingsPatch: Record<string, unknown>;
};
const manualContext = (settings: Record<string, unknown> = {}): CommandContext =>
  ({ actor: 'MANUAL_USER_ACTION', settings, settingsPatch: {} });
const settingsRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const statusForError = (caught: unknown): EditCommandResultStatus => {
  const response = caught instanceof BadRequestException || caught instanceof NotFoundException
    ? caught.getResponse() : null;
  const code = response && typeof response === 'object'
    ? String((response as Record<string, unknown>).code ?? '') : '';
  return /UNSUPPORTED/u.test(code) ? 'UNSUPPORTED'
    : caught instanceof BadRequestException || caught instanceof NotFoundException ? 'INVALID'
      : 'FAILED';
};
const errorCode = (caught: unknown) => {
  const response = caught instanceof BadRequestException || caught instanceof NotFoundException ||
    caught instanceof ConflictException ? caught.getResponse() : null;
  return response && typeof response === 'object'
    ? String((response as Record<string, unknown>).code ?? '') || undefined : undefined;
};
const errorMessage = (caught: unknown) => {
  const response = caught instanceof BadRequestException || caught instanceof NotFoundException
    ? caught.getResponse() : null;
  const message = response && typeof response === 'object'
    ? (response as Record<string, unknown>).message : undefined;
  return typeof message === 'string' ? message
    : caught instanceof Error ? caught.message : 'Command failed';
};

/** Hiding is for the layers drawn OVER the footage. A VIDEO segment is not
 *  hideable - the track is sequential, so "hidden" would silently change every
 *  later start time - and audio is silenced with mute, which is a real gain. */
const VISIBILITY_TYPES = new Set(['TEXT', 'SUBTITLE', 'IMAGE']);
/** Anything on the timeline can be locked, including footage. */
const LOCK_TYPES = new Set(['VIDEO', 'AUDIO', 'TEXT', 'SUBTITLE', 'IMAGE']);

/** The colour control each typed command sets. The command name and the stored
 * key are kept in one table so a new control cannot be half-added. */
const COLOR_COMMANDS: Record<string, ColorKey> = {
  SET_VIDEO_EXPOSURE: 'exposure', SET_VIDEO_BRIGHTNESS: 'brightness',
  SET_VIDEO_CONTRAST: 'contrast', SET_VIDEO_HIGHLIGHTS: 'highlights',
  SET_VIDEO_SHADOWS: 'shadows', SET_VIDEO_SATURATION: 'saturation',
  SET_VIDEO_TEMPERATURE: 'temperature', SET_VIDEO_TINT: 'tint',
  SET_VIDEO_SHARPNESS: 'sharpness', SET_VIDEO_FADE: 'fade', SET_VIDEO_VIGNETTE: 'vignette'
};
// Phase 4 adds one element action, reachable only through a validated preset
// plan: a transcript-exact caption line. There is no manual subtitle editor.
const PRESET_ONLY_ACTIONS = ['ADD_SUBTITLE'] as const;
// Actions that produce an undoable user-level revision. A whole preset
// application is one entry here, so it undoes and redoes as a single step.
const MANUAL_ACTIONS = new Set(['TRIM_ELEMENT', 'SPLIT_ELEMENT', 'DELETE_ELEMENT',
  'MOVE_ELEMENT', 'ADJUST_SOURCE_RANGE', 'APPLY_PRESET', 'APPLY_ASSISTANT_EDIT',
  'APPLY_TEMPLATE', ...PHASE3_ACTIONS]);
const ELEMENT_ORIGINS = new Set(['USER', 'PRESET', 'ASSISTANT']);
const PRESET_ROLES = new Set(['HOOK', 'SUBTITLE', 'KEY_POINT', 'CTA', 'PRODUCT', 'LOGO', 'MUSIC']);
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const AUDIO_MIMES = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav',
  'audio/mp4', 'audio/x-m4a', 'audio/aac']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 200 * 1024 * 1024;

// --- Phase 7 capacity limits -------------------------------------------------
//
// EditMode is a direct short-form editor, not a long-form NLE, and every one of
// these bounds exists because the thing behind it is genuinely not free: a very
// long source makes each export a multi-hour encode, and every overlay and
// caption line is another layer in a single FFmpeg filter graph and another ASS
// event libass composites on every frame.
//
// They are deliberately generous relative to real short-form use and they fail
// with a clear, specific message rather than with a timeout, an OOM or an
// FFmpeg error the user cannot act on.
const boundedEnv = (name: string, fallback: number, minimum: number, maximum: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
};
/** Longest source EditMode will accept. Default 30 minutes. */
export const maxSourceDurationSec = () =>
  boundedEnv('EDIT_MODE_MAX_SOURCE_DURATION_SEC', 30 * 60, 10, 4 * 60 * 60);
/** Non-caption overlays (TEXT, IMAGE, AUDIO, EFFECT) on one timeline. */
export const maxOverlayElements = () =>
  boundedEnv('EDIT_MODE_MAX_OVERLAY_ELEMENTS', 60, 5, 500);
/** Caption lines on one timeline. Presets generate these, so the cap is higher. */
export const maxSubtitleElements = () =>
  boundedEnv('EDIT_MODE_MAX_SUBTITLE_ELEMENTS', 400, 10, 5000);

type TimelineElement = EditElementInput & { id: string };

/** The asset fields every command path needs. `transcript` is here because
 * caption generation reads the transcript already cached on the source and must
 * never re-transcribe. */
export type CommandAsset = {
  id: string; role: EditAssetRole; duration: number | null;
  width: number | null; height: number | null; transcript?: unknown;
};

/** One entry of a validated AI chat bundle. Element payloads are already
 * resolved to real ids (or to a plan-local ref / timeline second). */
export type AssistantBundleCommand =
  | { kind: 'ELEMENT'; action: string; ref?: string; payload: Record<string, unknown> }
  | { kind: 'SETTINGS'; action: string; payload: Record<string, unknown> };

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
  private readonly logger = new Logger(EditModeService.name);

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
      where: { id }, select: { id: true, assets: { select: { bucket: true, objectKey: true,
        storageObjectKey: true, storageOwnership: true } } }
    });
    if (!project) throw new NotFoundException('EditProject not found');
    await this.prisma.editProject.delete({ where: { id } });
    await Promise.all(project.assets.filter(editAssetOwnsStorage).map((asset) => {
      const location = editAssetStorageLocation(asset);
      return this.storage.removeObject(location.bucket, location.objectKey).catch(() => undefined);
    }));
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
    if (editAssetOwnsStorage(result.asset)) {
      const location = editAssetStorageLocation(result.asset);
      await this.storage.removeObject(location.bucket, location.objectKey).catch(() => undefined);
    }
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
    const limit = maxSourceDurationSec();
    if (media.durationSec > limit + 1e-6) {
      throw new BadRequestException({ code: 'SOURCE_TOO_LONG',
        message: `EditMode edits clips up to ${Math.round(limit / 60)} minutes. This source is ` +
          `${Math.round(media.durationSec / 60)} minutes long - trim it first, or use the ` +
          'automatic clip pipeline to find short sections in it.' });
    }
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

  /** Changes the outer original-video range for a generated NORMAL clip.
   * It is intentionally separate from generic segment trim: it owns ripple
   * retiming, lineage updates, validation and one atomic history revision. */
  async adjustSourceRange(id: string, input: { revision?: unknown; start?: unknown;
    end?: unknown; startDelta?: unknown; endDelta?: unknown }) {
    const expectedRevision = parseRevision(input.revision);
    const optionalNumber = (value: unknown, field: string) => value === undefined
      ? undefined : this.finiteNumber(value, field);
    const requestedStart = optionalNumber(input.start, 'start');
    const requestedEnd = optionalNumber(input.end, 'end');
    const startDelta = optionalNumber(input.startDelta, 'startDelta');
    const endDelta = optionalNumber(input.endDelta, 'endDelta');
    if (requestedStart !== undefined && startDelta !== undefined) {
      throw new BadRequestException('Use either start or startDelta, not both');
    }
    if (requestedEnd !== undefined && endDelta !== undefined) {
      throw new BadRequestException('Use either end or endDelta, not both');
    }
    if ([requestedStart, requestedEnd, startDelta, endDelta].every((value) => value === undefined)) {
      throw new BadRequestException('Provide a source boundary or delta');
    }
    return serialize(await this.prisma.$transaction(async (tx) => {
      const current = await tx.editProject.findUnique({ where: { id }, include: { elements: true,
        assets: { select: { id: true, role: true, duration: true, width: true, height: true,
          transcript: true, sourceVideoId: true, storageOwnership: true } } } });
      if (!current) throw new NotFoundException('EditProject not found');
      this.assertRevision(current.revision, expectedRevision);
      {
        const locked = blockingEditConstraint('ADJUST_SOURCE_RANGE', 'MANUAL_USER_ACTION',
          readProjectConstraints(current.settings), current.elements.filter((element) =>
            element.type === 'VIDEO').map((element) => timelineElementState(
            element as unknown as Record<string, unknown>)));
        if (locked) throw this.blockedError(locked, 'ADJUST_SOURCE_RANGE');
      }
      const lineage = readGeneratedClipLineage(current.settings);
      if (!lineage || lineage.sourceMode !== 'ORIGINAL_VIDEO' ||
        !current.originalVideoId || current.originalVideoId !== lineage.originalVideoId) {
        throw new BadRequestException({ code: 'ORIGINAL_SOURCE_UNAVAILABLE',
          message: 'Source boundaries are available only for original-source generated clips' });
      }
      const source = current.assets.find((asset) => asset.role === 'SOURCE' &&
        asset.sourceVideoId === current.originalVideoId && asset.storageOwnership === 'SHARED');
      const sourceDuration = Number(source?.duration);
      if (!source || !Number.isFinite(sourceDuration) || sourceDuration <= 0) {
        throw new BadRequestException({ code: 'ORIGINAL_SOURCE_UNAVAILABLE',
          message: 'The original source duration is unavailable' });
      }
      const before = current.elements.map((element) => timelineElementState(
        element as unknown as Record<string, unknown>));
      const videos = before.filter((element) => element.type === 'VIDEO' && element.track === 0)
        .sort((left, right) => left.position - right.position);
      if (!videos.length || videos.some((element) => element.assetId !== source.id)) {
        throw new BadRequestException({ code: 'ORIGINAL_SOURCE_UNAVAILABLE',
          message: 'The canonical video track is not backed solely by the original Video' });
      }
      // A reconstructed automatic edit can contain deliberate internal source
      // gaps. The Step 3 outer-boundary algorithm was designed for one
      // contiguous generated clip; extending a multi-segment track through a
      // gap could silently restore footage the automatic editor removed.
      if (lineage.reconstructionMode === 'CANONICAL' && videos.length > 1) {
        throw new BadRequestException({ code: 'COMPLEX_SOURCE_RANGE_UNSUPPORTED',
          message: 'Adjust individual reconstructed video segments; the outer source-range ' +
            'command cannot safely rewrite a multi-cut automatic edit.' });
      }
      const oldStart = videos[0].trimStart ?? 0;
      const oldEnd = videos.at(-1)!.trimEnd ?? oldStart;
      const nextStart = requestedStart ?? oldStart + (startDelta ?? 0);
      const nextEnd = requestedEnd ?? oldEnd + (endDelta ?? 0);
      if (nextStart < 0) throw new BadRequestException({ code: 'SOURCE_RANGE_OUT_OF_BOUNDS',
        message: 'Source start must be zero or more' });
      if (nextEnd > sourceDuration + 1e-6) throw new BadRequestException({
        code: 'SOURCE_RANGE_OUT_OF_BOUNDS',
        message: `Source end exceeds the original Video duration (${sourceDuration.toFixed(2)}s)` });
      if (nextEnd - nextStart < MIN_VIDEO_DURATION_SEC) throw new BadRequestException({
        code: 'INVALID_SOURCE_RANGE', message: 'Source end must be after source start' });
      const afterVideos = this.reboundOriginalVideoTrack(videos, nextStart, nextEnd);
      const beforeDuration = buildTimelineMap(videos).durationSec;
      const afterDuration = buildTimelineMap(afterVideos).durationSec;
      const startShift = nextStart > oldStart
        ? beforeDuration - buildTimelineMap(this.reboundOriginalVideoTrack(videos, nextStart, oldEnd)).durationSec
        : nextStart < oldStart
          ? buildTimelineMap(this.reboundOriginalVideoTrack(videos, nextStart, oldEnd)).durationSec - beforeDuration
          : 0;
      const videoIds = new Set(videos.map((element) => element.id));
      const nonVideos = this.retimeForOuterBoundary(before.filter((element) =>
        !videoIds.has(element.id)), oldStart, nextStart, startShift, afterDuration);
      const after = normalizeVideoTrack([...afterVideos, ...nonVideos]);
      const assetMap = new Map(current.assets.map((asset) => [asset.id, asset]));
      this.validateTimeline(after, assetMap);
      await this.replaceElements(tx, id, after);
      const settingsRecord = current.settings && typeof current.settings === 'object' &&
        !Array.isArray(current.settings) ? current.settings as Record<string, unknown> : {};
      const settings = { ...settingsRecord, origin: { ...lineage,
        currentSourceStart: Number(nextStart.toFixed(6)),
        currentSourceEnd: Number(nextEnd.toFixed(6)) } } as Prisma.InputJsonValue;
      const revision = current.revision + 1;
      await tx.editProject.update({ where: { id }, data: { revision, settings } });
      await tx.editHistory.create({ data: { editProjectId: id, revision, actor: 'USER',
        action: 'ADJUST_SOURCE_RANGE', command: { start: nextStart, end: nextEnd,
          startDelta: startDelta ?? null, endDelta: endDelta ?? null },
        beforeState: { elements: serialize(before), settings: current.settings },
        afterState: { elements: serialize(after), settings } } });
      return tx.editProject.findUniqueOrThrow({ where: { id }, include: includeProject });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  private reboundOriginalVideoTrack(videos: TimelineElement[], start: number, end: number) {
    const ordered = videos.map((element) => ({ ...element }));
    const kept = ordered.filter((element) => (element.trimEnd ?? 0) > start + 1e-6 &&
      (element.trimStart ?? 0) < end - 1e-6);
    if (!kept.length) {
      const template = ordered[0];
      return [{ ...template, trimStart: start, trimEnd: end,
        duration: timelineDurationFor(start, end, readSpeed(template.properties)) }];
    }
    kept[0] = { ...kept[0], trimStart: start,
      duration: timelineDurationFor(start, kept[0].trimEnd!, readSpeed(kept[0].properties)) };
    const last = kept.length - 1;
    kept[last] = { ...kept[last], trimEnd: end,
      duration: timelineDurationFor(kept[last].trimStart!, end, readSpeed(kept[last].properties)) };
    return kept;
  }

  /** Boundary ripple policy for every dependent timeline layer:
   * - move start later: discard fully cut items, trim crossing items, shift survivors left;
   * - extend start earlier: shift every existing item right, leaving the new lead-in empty;
   * - move end earlier: discard/trim at the new project end;
   * - extend end later: preserve existing timing, leaving the new tail empty.
   * AUDIO advances its own trim when its beginning is cut. No text/caption/effect
   * is fabricated, and unrelated manual work stays attached to the same content. */
  private retimeForOuterBoundary(elements: TimelineElement[], oldStart: number, nextStart: number,
    startShift: number, duration: number) {
    const extendingStart = nextStart < oldStart;
    const cuttingStart = nextStart > oldStart;
    return elements.flatMap((element) => {
      let start = element.startTime;
      let elementDuration = element.duration;
      let trimStart = element.trimStart ?? 0;
      if (extendingStart) start += startShift;
      if (cuttingStart) {
        const end = start + elementDuration;
        if (end <= startShift + 1e-6) return [];
        if (start < startShift) {
          const removed = startShift - start;
          start = 0; elementDuration -= removed;
          if (element.type === 'AUDIO') trimStart += removed;
        } else start -= startShift;
      }
      if (start >= duration - 1e-6) return [];
      elementDuration = Math.min(elementDuration, duration - start);
      if (elementDuration < MIN_VIDEO_DURATION_SEC) return [];
      return [{ ...element, startTime: Number(start.toFixed(6)),
        duration: Number(elementDuration.toFixed(6)), trimStart: Number(trimStart.toFixed(6)),
        ...(element.type === 'AUDIO'
          ? { trimEnd: Number((trimStart + elementDuration).toFixed(6)) } : {}) }];
    });
  }

  async splitElement(id: string, input: { revision?: unknown; elementId?: unknown; playheadSec?: unknown }) {
    const elementId = this.requiredString(input.elementId, 'elementId');
    const playheadSec = this.finiteNumber(input.playheadSec, 'playheadSec');
    return this.manualMutation(id, input.revision, 'SPLIT_ELEMENT',
      { elementId, playheadSec },
      (elements) => this.splitVideoTimeline(elements, elementId, playheadSec));
  }

  async deleteElement(id: string, input: { revision?: unknown; elementId?: unknown }) {
    const elementId = this.requiredString(input.elementId, 'elementId');
    return this.manualMutation(id, input.revision, 'DELETE_ELEMENT', { elementId },
      (elements) => this.deleteVideoTimeline(elements, elementId));
  }

  async moveElement(id: string, input: { revision?: unknown; elementId?: unknown;
    toPosition?: unknown; track?: unknown }) {
    const elementId = this.requiredString(input.elementId, 'elementId');
    const toPosition = this.integer(input.toPosition, 'toPosition');
    const track = input.track === undefined ? 0 : this.integer(input.track, 'track');
    if (track !== 0) throw new BadRequestException({ code: 'UNSUPPORTED_TRACK',
      message: 'Phase 2 supports moving VIDEO elements only on track 0' });
    return this.manualMutation(id, input.revision, 'MOVE_ELEMENT', { elementId, toPosition, track },
      (elements) => this.reorderVideoTimeline(elements, elementId, toPosition));
  }

  // The three VIDEO-track mutators live here rather than inside their command
  // methods so that the manual editor and an assistant command bundle share one
  // implementation. A chat-driven ripple delete is therefore the same code path,
  // with the same guards, as pressing Delete on the timeline.

  private splitVideoTimeline(elements: TimelineElement[], elementId: string,
    playheadSec: number): TimelineElement[] {
    const target = this.videoElement(elements, elementId);
    const offset = playheadSec - target.startTime;
    if (offset < MIN_VIDEO_DURATION_SEC || target.duration - offset < MIN_VIDEO_DURATION_SEC) {
      throw new BadRequestException({ code: 'INVALID_SPLIT',
        message: 'playheadSec must be safely inside the selected VIDEO element' });
    }
    // `offset` is measured on the edited timeline. At non-1x playback the
    // corresponding source span is larger (or smaller) by the playback rate.
    // Keeping the old 1:1 conversion made each half fail the canonical
    // duration/trim invariant as soon as a user split a sped-up clip.
    const sourceSplit = target.trimStart! + offset * readSpeed(target.properties);
    const right: TimelineElement = { ...target, id: randomUUID(), position: target.position + 1,
      trimStart: sourceSplit, trimEnd: target.trimEnd, duration: target.duration - offset };
    return elements.flatMap((element) => element.id === target.id
      ? [{ ...target, trimEnd: sourceSplit, duration: offset }, right]
      : [{ ...element, position: element.type === 'VIDEO' && element.track === 0 &&
          element.position > target.position ? element.position + 1 : element.position }]);
  }

  private deleteVideoTimeline(elements: TimelineElement[], elementId: string): TimelineElement[] {
    this.videoElement(elements, elementId);
    return elements.filter((element) => element.id !== elementId);
  }

  private reorderVideoTimeline(elements: TimelineElement[], elementId: string,
    toPosition: number): TimelineElement[] {
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
      (elements, assets, ctx) => this.applyElementCommand(action, input, elements, assets, ctx));
  }

  /** Reads the persistent project locks. */
  async getConstraints(id: string) {
    const current = await this.prisma.editProject.findUnique({ where: { id },
      select: { settings: true, revision: true } });
    if (!current) throw new NotFoundException('EditProject not found');
    return { revision: current.revision,
      projectConstraints: readProjectConstraints(current.settings) };
  }

  /**
   * Replaces the persistent PROJECT locks. These bind every actor, manual
   * included, until removed - unlike AI task constraints, which only bind the
   * automated task they were given to. Not an undoable timeline edit.
   */
  async setConstraints(id: string, input: { revision?: unknown; constraints?: unknown }) {
    const expectedRevision = parseRevision(input.revision);
    const constraints = readEditConstraints(input.constraints, 'PROJECT')
      .map((constraint) => ({ ...constraint, lifetime: 'PROJECT' as const }));
    return serialize(await this.prisma.$transaction(async (tx) => {
      const current = await tx.editProject.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('EditProject not found');
      this.assertRevision(current.revision, expectedRevision);
      const settings = { ...settingsRecord(current.settings),
        projectConstraints: constraints } as Prisma.InputJsonValue;
      await tx.editProject.update({ where: { id }, data: { settings } });
      return { revision: current.revision, projectConstraints: constraints };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  /** The canonical elements a command would touch, for constraint checks. */
  private constraintTargets(action: string, payload: Record<string, unknown>,
    elements: TimelineElement[]): TimelineElement[] {
    const elementId = typeof payload.elementId === 'string' ? payload.elementId : '';
    if (elementId) {
      const hit = elements.find((item) => item.id === elementId);
      return hit ? [hit] : [];
    }
    if (action.startsWith('ADD_')) {
      // A new element is checked for real after it exists (rangeViolation);
      // here it only needs a stand-in carrying the timing it asked for.
      const startTime = Number(payload.startTime ?? 0);
      const duration = Number(payload.duration ?? 0.001);
      return [{ id: '__new__', assetId: null, type: (action === 'ADD_AUDIO' ? 'AUDIO'
        : action === 'ADD_ZOOM' ? 'EFFECT' : action === 'ADD_TEXT' ? 'TEXT'
          : 'IMAGE') as EditElementType,
      track: 0, position: 0, startTime: Number.isFinite(startTime) ? startTime : 0,
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0.001,
      trimStart: 0, trimEnd: null, properties: {} }];
    }
    const role = String(payload.semanticRole ?? '').toUpperCase();
    if (role === 'HOOK' || role === 'LOGO') {
      return elements.filter((item) => semanticRole(item) === role);
    }
    if (action.includes('ZOOM')) return elements.filter((item) => item.type === 'EFFECT');
    if (action.startsWith('SET_AUDIO_')) return elements.filter((item) => item.type === 'AUDIO');
    if (typeof payload.elementType === 'string') {
      return elements.filter((item) => item.type === payload.elementType);
    }
    if (action.includes('CAPTION')) return elements.filter((item) => item.type === 'SUBTITLE');
    if (action.startsWith('SET_VIDEO_') || action.startsWith('SET_SOURCE_AUDIO_') ||
      action === 'RESET_VIDEO_ADJUSTMENTS' || action === 'APPLY_COLOR_FILTER' ||
      action === 'PASTE_VIDEO_ADJUSTMENTS' || action === 'SET_REFRAME_POLICY' ||
      action === 'ADJUST_SOURCE_RANGE') {
      return elements.filter((item) => item.type === 'VIDEO' && item.track === 0);
    }
    return [];
  }

  private resultScope(action: string, payload: Record<string, unknown>): EditCommandScope {
    const video = action.startsWith('SET_VIDEO_') || action.startsWith('SET_SOURCE_AUDIO_') ||
      action === 'APPLY_COLOR_FILTER' || action === 'RESET_VIDEO_ADJUSTMENTS';
    try {
      return readEditCommandScope(payload.scope, payload.elementId
        ? (video ? 'CURRENT_VIDEO_SEGMENT' : 'SELECTED_ELEMENT')
        : payload.elementType || payload.semanticRole ? 'TRACK'
          : video ? 'ALL_VIDEO_SEGMENTS' : 'PROJECT');
    } catch {
      return 'PROJECT';
    }
  }

  private blockedError(constraint: EditConstraint, action: string) {
    this.logger.log(JSON.stringify({ event: 'edit_constraint_blocked', action,
      constraint: constraint.type, lifetime: constraint.lifetime ?? null }));
    return new BadRequestException({ code: 'BLOCKED_BY_CONSTRAINT', constraint: constraint.type,
      message: `${action} is blocked by the ${constraint.type} ` +
        `${constraint.lifetime === 'PROJECT' ? 'project lock' : 'task constraint'}` });
  }

  /**
   * The single element mutation path.
   *
   * Manual Phase 3 commands and preset-generated commands both run through
   * here, so a preset can never reach the timeline by a route that skips the
   * validation the manual editor is held to.
   */
  private applyElementCommand(action: string, rawInput: Record<string, unknown>,
    elements: TimelineElement[], assets: Map<string, CommandAsset>,
    ctx: CommandContext = manualContext()): TimelineElement[] {
    // Step 5: a semantic object ("the hook") is resolved to its ONE canonical
    // element here, so "make the hook smaller" can never land on another TEXT.
    // Asset ids are never invented: an absent hook is an honest NOT_FOUND.
    let input = rawInput;
    if (!input.elementId && String(input.semanticRole ?? '').toUpperCase() === 'HOOK') {
      const hooks = elements.filter((item) => item.type === 'TEXT' && semanticRole(item) === 'HOOK');
      if (!hooks.length) throw new NotFoundException({ code: 'NO_HOOK',
        message: 'This project has no hook text' });
      input = { ...input, elementId: hooks[0].id };
    }
    {
      const projectDuration = elements.filter((item) => item.type === 'VIDEO' && item.track === 0)
        .reduce((total, item) => total + item.duration, 0);
      const assetId = typeof input.assetId === 'string' ? input.assetId : '';
      const elementId = typeof input.elementId === 'string' ? input.elementId : '';
      const asset = assetId ? assets.get(assetId) : undefined;
      const target = elementId ? elements.find((item) => item.id === elementId) : undefined;
      const scope = (fallback: EditCommandScope = 'SELECTED_ELEMENT') =>
        readEditCommandScope(input.scope, fallback);
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
      const withPropertiesFor = (items: TimelineElement[], properties: Record<string, unknown>) => {
        const ids = new Set(items.map((item) => item.id));
        return elements.map((candidate) => ids.has(candidate.id) ? { ...candidate,
          properties: { ...(candidate.properties as Record<string, unknown>), ...properties } as
            Prisma.InputJsonValue } : candidate);
      };
      const videoTargets = (actionName: string) => {
        const requested = scope(elementId ? 'CURRENT_VIDEO_SEGMENT' : 'ALL_VIDEO_SEGMENTS');
        assertEditScope(actionName, requested,
          ['SELECTED_ELEMENT', 'CURRENT_VIDEO_SEGMENT', 'ALL_VIDEO_SEGMENTS', 'PROJECT']);
        if (requested === 'ALL_VIDEO_SEGMENTS' || requested === 'PROJECT') {
          const all = elements.filter((item) => item.type === 'VIDEO' && item.track === 0);
          if (!all.length) throw new BadRequestException({ code: 'INVALID_TIMELINE',
            message: 'This timeline has no video segments' });
          return all;
        }
        return [this.videoElement(elements, this.requiredString(input.elementId, 'elementId'))];
      };

      if (action === 'TRIM_ELEMENT') {
        const trimStart = this.finiteNumber(input.trimStart, 'trimStart');
        const trimEnd = this.finiteNumber(input.trimEnd, 'trimEnd');
        const item = this.videoElement(elements, this.requiredString(input.elementId, 'elementId'));
        const duration = timelineDurationFor(trimStart, trimEnd, readSpeed(item.properties));
        const before = videoLayout(elements);
        const trimmed = elements.map((candidate) => candidate.id === item.id
          ? { ...candidate, trimStart, trimEnd, duration } : candidate);
        return retimeOverlays(trimmed, before, videoLayout(trimmed), MIN_VIDEO_DURATION_SEC);
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
            flipH: false, flipV: false, crop: { ...NEUTRAL_CROP },
            opacity: 1, zIndex: expectedRole === 'LOGO' ? 20 : 10, anchor: 'top-left',
            locked: false, role: expectedRole, preserveAspectRatio: true,
            ...this.originProperties(input) } });
      }
      if (action === 'ADD_TEXT') {
        // New text is born in a built-in style, geometry and all, so the first
        // thing the user sees is a finished-looking element rather than a
        // default they have to style from nothing.
        let preset;
        try { preset = textStylePreset(String(input.textStyleId ?? 'BASIC')); }
        catch (caught) { throw this.textError(caught); }
        const content = typeof input.content === 'string' && input.content.trim()
          ? input.content.slice(0, MAX_TEXT_LENGTH) : 'Text';
        const textRuns = this.validTextRuns(input.textRuns, content);
        return add({ id: randomUUID(), assetId: null, type: 'TEXT', track: 1,
          position: nextPosition(1), startTime: 0, duration: normalizedDuration(projectDuration),
          trimStart: 0, trimEnd: null, properties: { content, ...(textRuns.length ? { textRuns } : {}),
            ...preset.box, scale: 1,
            rotation: 0, opacity: 1, zIndex: 30, anchor: 'top-left', locked: false,
            hidden: false, textStyleId: preset.id, ...styleProperties(preset.style),
            ...this.originProperties(input) } });
      }
      if (action === 'ADD_AUDIO') {
        if (!asset || asset.role !== 'AUDIO' || !asset.duration) throw new BadRequestException({
          code: 'INVALID_ASSET', message: 'A readable AUDIO asset must belong to this EditProject' });
        const duration = normalizedDuration(Math.min(asset.duration, projectDuration));
        return add({ id: randomUUID(), assetId, type: 'AUDIO', track: 3,
          position: nextPosition(3), startTime: 0, duration, trimStart: 0, trimEnd: duration,
          properties: { volume: DEFAULT_MUSIC_VOLUME, muted: false, fadeInSec: 0, fadeOutSec: 0,
            duckUnderSpeech: false, duckLevel: DUCK_STRENGTHS[DEFAULT_DUCK_STRENGTH],
            duckStrength: DEFAULT_DUCK_STRENGTH, attackMs: DEFAULT_ATTACK_MS,
            releaseMs: DEFAULT_RELEASE_MS, ...this.originProperties(input) } });
      }
      // Step 5: every logo as one target ("move all logos top right"). Only
      // IMAGE overlays whose role is LOGO move; other images stay put.
      if (action === 'MOVE_ELEMENT' && !elementId &&
        String(input.semanticRole ?? '').toUpperCase() === 'LOGO') {
        assertEditScope(action, scope('TRACK'), ['TRACK']);
        const logos = elements.filter((item) => item.type === 'IMAGE' && semanticRole(item) === 'LOGO');
        if (!logos.length) throw new BadRequestException({ code: 'NO_LOGO',
          message: 'This project has no logo overlay' });
        const x = input.x === undefined ? null : this.unitNumber(input.x, 'x');
        const y = input.y === undefined ? null : this.unitNumber(input.y, 'y');
        if (x === null && y === null) throw new BadRequestException('x or y is required');
        const ids = new Set(logos.map((item) => item.id));
        return elements.map((item) => {
          if (!ids.has(item.id)) return item;
          const properties = item.properties as Record<string, unknown>;
          const width = Number(properties.width ?? 0.2);
          const height = Number(properties.height ?? 0.2);
          return { ...item, properties: { ...properties,
            ...(x === null ? {} : { x: Math.min(x, 1 - width) }),
            ...(y === null ? {} : { y: Math.min(y, 1 - height) }) } as Prisma.InputJsonValue };
        });
      }
      if (action === 'MOVE_ELEMENT' && ((!elementId && input.elementType === 'SUBTITLE') ||
        scope() === 'TRACK')) {
        assertEditScope(action, scope(!elementId ? 'TRACK' : 'SELECTED_ELEMENT'), ['TRACK']);
        if (input.elementType !== undefined && input.elementType !== 'SUBTITLE') {
          throw new BadRequestException({ code: 'UNSUPPORTED_EDIT_SCOPE',
            message: 'Track-wide MOVE_ELEMENT is supported only for captions' });
        }
        // The caption band as one target ("move the captions lower"). Each
        // caption keeps its own size; only its position is written.
        const x = input.x === undefined ? null : this.unitNumber(input.x, 'x');
        const y = input.y === undefined ? null : this.unitNumber(input.y, 'y');
        if (x === null && y === null) throw new BadRequestException('x or y is required');
        if (!elements.some((item) => item.type === 'SUBTITLE')) {
          throw new BadRequestException({ code: 'NO_CAPTIONS',
            message: 'This timeline has no captions yet' });
        }
        return elements.map((item) => {
          if (item.type !== 'SUBTITLE') return item;
          const properties = item.properties as Record<string, unknown>;
          const width = Number(properties.width ?? DEFAULT_CAPTION_BOX.width);
          const height = Number(properties.height ?? DEFAULT_CAPTION_BOX.height);
          return { ...item, properties: { ...properties,
            ...(x === null ? {} : { x: Math.min(x, 1 - width) }),
            ...(y === null ? {} : { y: Math.min(y, 1 - height) }) } as Prisma.InputJsonValue };
        });
      }
      if (action === 'MOVE_ELEMENT') {
        const item = requireVisual();
        const properties = item.properties as Record<string, unknown>;
        const width = Number(properties.width ?? 0.2); const height = Number(properties.height ?? 0.2);
        const x = this.unitNumber(input.x, 'x'); const y = this.unitNumber(input.y, 'y');
        return withProperties(item, { x: Math.min(x, 1 - width), y: Math.min(y, 1 - height) });
      }
      if (action === 'RESIZE_ELEMENT' && ((!elementId && input.elementType === 'SUBTITLE') ||
        scope() === 'TRACK')) {
        assertEditScope(action, scope(!elementId ? 'TRACK' : 'SELECTED_ELEMENT'), ['TRACK']);
        if (input.elementType !== undefined && input.elementType !== 'SUBTITLE') {
          throw new BadRequestException({ code: 'UNSUPPORTED_EDIT_SCOPE',
            message: 'Track-wide RESIZE_ELEMENT is supported only for captions' });
        }
        const width = this.unitNumber(input.width, 'width');
        const height = this.unitNumber(input.height, 'height');
        if (width < 0.02 || height < 0.02) throw new BadRequestException('width and height must be at least 0.02');
        if (!elements.some((item) => item.type === 'SUBTITLE')) throw new BadRequestException({
          code: 'NO_CAPTIONS', message: 'This timeline has no captions yet' });
        return elements.map((item) => {
          if (item.type !== 'SUBTITLE') return item;
          const properties = item.properties as Record<string, unknown>;
          const x = Number(properties.x ?? DEFAULT_CAPTION_BOX.x);
          const y = Number(properties.y ?? DEFAULT_CAPTION_BOX.y);
          return { ...item, properties: { ...properties, width: Math.min(width, 1 - x),
            height: Math.min(height, 1 - y) } as Prisma.InputJsonValue };
        });
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
      if (action === 'SET_ELEMENT_OPACITY') {
        const opacity = this.unitNumber(input.opacity, 'opacity');
        if (scope() === 'TRACK') {
          if (input.elementType !== 'SUBTITLE' && target?.type !== 'SUBTITLE') throw new BadRequestException({
            code: 'UNSUPPORTED_EDIT_SCOPE', message: 'Track opacity is supported only for captions' });
          return withPropertiesFor(elements.filter((item) => item.type === 'SUBTITLE'), { opacity });
        }
        assertEditScope(action, scope(), ['SELECTED_ELEMENT']);
        return withProperties(requireVisual(), { opacity });
      }
      if (action === 'SET_ELEMENT_Z_INDEX') return withProperties(requireVisual(),
        { zIndex: this.integer(input.zIndex, 'zIndex') });
      // --- Workstream E: visibility and lock --------------------------------
      //
      // Both accept EITHER one elementId or an elementType. A timeline track
      // header hides or locks a whole track, and a track can be four hundred
      // captions, so the bulk form keeps that one command, one revision and one
      // undo step instead of four hundred of each.
      //
      // Lock is deliberately NOT enforced here: it guards the timeline's
      // gestures (drag, trim, delete, split, duplicate) in the editor, while
      // the inspector, a preset and an assistant turn still reach a locked
      // element - otherwise applying a style to a locked caption would fail for
      // a reason the user never asked for, and unlocking could deadlock itself.
      if (action === 'SET_ELEMENT_VISIBLE' || action === 'SET_ELEMENT_LOCKED') {
        const visibility = action === 'SET_ELEMENT_VISIBLE';
        const raw = visibility ? input.visible : input.locked;
        if (typeof raw !== 'boolean') {
          throw new BadRequestException(`${visibility ? 'visible' : 'locked'} must be a boolean`);
        }
        const allowed = visibility ? VISIBILITY_TYPES : LOCK_TYPES;
        let targets: TimelineElement[];
        const requested = scope(elementId ? 'SELECTED_ELEMENT' : 'TRACK');
        assertEditScope(action, requested, ['SELECTED_ELEMENT', 'TRACK']);
        if (requested === 'SELECTED_ELEMENT') targets = [requireTarget()];
        else {
          const elementType = String(input.elementType ?? '');
          if (!allowed.has(elementType)) throw new BadRequestException({
            code: 'INVALID_ELEMENT_TYPE',
            message: `elementId, or elementType of ${[...allowed].join('/')}, is required` });
          targets = elements.filter((item) => item.type === elementType);
        }
        for (const item of targets) {
          if (allowed.has(item.type)) continue;
          throw new BadRequestException({ code: 'INVALID_ELEMENT_TYPE', message: visibility
            ? 'Only TEXT, SUBTITLE and IMAGE elements can be hidden; mute audio instead'
            : 'Command requires a timeline element' });
        }
        const patch = visibility ? { hidden: !raw } : { locked: raw };
        const targetIds = new Set(targets.map((item) => item.id));
        return elements.map((candidate) => targetIds.has(candidate.id)
          ? { ...candidate, properties: { ...(candidate.properties as Record<string, unknown>),
            ...patch } as Prisma.InputJsonValue }
          : candidate);
      }
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
      // --- Workstream D: music and sound ------------------------------------
      //
      // Volume is a GAIN over 0..2 rather than a 0..1 fraction, so "make the
      // music slightly louder" is possible on a quiet upload. The bounds, the
      // fade rules and the trim rules all live in edit-mode-audio.ts, so the
      // editor, an assistant bundle and a raw request reach the same answer.
      const requireAudio = () => {
        const item = requireTarget();
        if (item.type !== 'AUDIO') {
          throw new BadRequestException({ code: 'INVALID_ELEMENT_TYPE',
            message: 'Audio command requires an AUDIO element' });
        }
        return item;
      };
      // Muting the music track is one user action, so like SET_SOURCE_AUDIO_MUTED
      // it accepts an omitted elementId and covers every AUDIO element in one
      // revision rather than one revision per clip.
      if (action === 'SET_AUDIO_MUTED' && (!elementId || scope() === 'TRACK')) {
        assertEditScope(action, scope(!elementId ? 'TRACK' : 'SELECTED_ELEMENT'), ['TRACK']);
        const muted = validateBoolean(input.muted, 'muted');
        return elements.map((item) => item.type === 'AUDIO'
          ? { ...item, properties: { ...(item.properties as Record<string, unknown>),
            muted } as Prisma.InputJsonValue }
          : item);
      }
      // Step 5: "lower the music" is the MUSIC track (every AUDIO element), never
      // the source video's own audio (SET_SOURCE_AUDIO_VOLUME) - and "lower this
      // audio clip" stays SELECTED_ELEMENT below.
      if (action === 'SET_AUDIO_VOLUME' && !elementId && scope('TRACK') === 'TRACK') {
        const music = elements.filter((item) => item.type === 'AUDIO');
        if (!music.length) throw new BadRequestException({ code: 'NO_MUSIC',
          message: 'This timeline has no music or audio clip' });
        try { return withPropertiesFor(music, { volume: validateVolume(input.volume) }); }
        catch (caught) { throw this.audioError(caught); }
      }
      if (action === 'SET_AUDIO_VOLUME' || action === 'SET_AUDIO_MUTED' ||
        action === 'SET_AUDIO_FADE' || action === 'SET_AUDIO_TRIM' ||
        action === 'SET_AUDIO_DUCKING') {
        const item = requireAudio();
        try {
          if (action === 'SET_AUDIO_VOLUME') {
            return withProperties(item, { volume: validateVolume(input.volume) });
          }
          if (action === 'SET_AUDIO_MUTED') {
            return withProperties(item, { muted: validateBoolean(input.muted, 'muted') });
          }
          if (action === 'SET_AUDIO_FADE') {
            return withProperties(item,
              validateFades(input.fadeInSec, input.fadeOutSec, item.duration));
          }
          if (action === 'SET_AUDIO_TRIM') {
            // The uploaded file is never touched: a trim is a read window over
            // it, exactly as a VIDEO element's trim is a window over the source
            // video. The clip's timeline length follows the window, and fades
            // are held inside the new length rather than refusing a legal trim
            // because of a fade the user is not currently editing.
            const asset = item.assetId ? assets.get(item.assetId) : undefined;
            const { trimStart, trimEnd } = validateAudioTrim(input.trimStart, input.trimEnd,
              asset?.duration ?? null);
            const duration = Number((trimEnd - trimStart).toFixed(6));
            const state = readAudioState(item.properties);
            const fadeInSec = Math.min(state.fadeInSec, duration);
            const fadeOutSec = Math.min(state.fadeOutSec, Math.max(0, duration - fadeInSec));
            return elements.map((candidate) => candidate.id === item.id
              ? { ...candidate, trimStart, trimEnd, duration,
                properties: { ...(item.properties as Record<string, unknown>),
                  fadeInSec, fadeOutSec } as Prisma.InputJsonValue }
              : candidate);
          }
          // Ducking. Real or refused: it is built from the transcript already
          // cached on this exact source, and when that transcript has no word
          // timings there is nothing honest to build, so the command says so
          // rather than storing a flag the export would silently ignore.
          const duckEnabled = validateBoolean(input.duckEnabled, 'duckEnabled');
          if (duckEnabled && !this.hasSpeechTiming(assets)) {
            throw new BadRequestException({ code: 'DUCKING_UNAVAILABLE',
              message: 'This source has no transcript word timings, so the music cannot be ' +
                'lowered under speech. Analyze the source first.' });
          }
          const strength = input.duckStrength === undefined
            ? DEFAULT_DUCK_STRENGTH : validateDuckStrength(input.duckStrength);
          const { attackMs, releaseMs } = validateDuckTiming(input.attackMs, input.releaseMs);
          return withProperties(item, { duckUnderSpeech: duckEnabled,
            duckLevel: DUCK_STRENGTHS[strength], duckStrength: strength, attackMs, releaseMs });
        } catch (caught) {
          throw this.audioError(caught);
        }
      }
      // The source video's own audio. `elementId` is OPTIONAL: without one the
      // command covers every segment on the VIDEO track, because "mute the
      // original video" is one user action and should cost one revision even on
      // a timeline that has been split into eight clips.
      if (action === 'SET_SOURCE_AUDIO_VOLUME' || action === 'SET_SOURCE_AUDIO_MUTED') {
        const targets = videoTargets(action);
        if (!targets.length) {
          throw new BadRequestException({ code: 'INVALID_TIMELINE',
            message: 'This timeline has no video segment to set the source audio on' });
        }
        let patch: Record<string, unknown>;
        try {
          patch = action === 'SET_SOURCE_AUDIO_VOLUME'
            ? { sourceVolume: validateVolume(input.volume) }
            : { sourceMuted: validateBoolean(input.muted, 'muted') };
        } catch (caught) {
          throw this.audioError(caught);
        }
        const ids = new Set(targets.map((item) => item.id));
        return elements.map((candidate) => {
          if (!ids.has(candidate.id)) return candidate;
          const properties = { ...(candidate.properties as Record<string, unknown>), ...patch };
          return { ...candidate, properties: properties as Prisma.InputJsonValue };
        });
      }
      // --- Workstream D: colour ---------------------------------------------
      //
      // Colour is VIDEO-only. An overlay image is already reframed by its own
      // transform controls, and grading one independently of the footage under
      // it is a compositing feature, not a colour one.
      const requireVideoElement = () => {
        const item = requireTarget();
        if (item.type !== 'VIDEO') {
          throw new BadRequestException({ code: 'INVALID_ELEMENT_TYPE',
            message: 'Colour adjustments apply to a video segment' });
        }
        return item;
      };
      if (COLOR_COMMANDS[action]) {
        const key = COLOR_COMMANDS[action];
        try {
          // The stored state is always the RESOLVED settings. A filter is a
          // named starting point, so editing one control after applying a
          // filter keeps the rest of that filter and changes only this value -
          // there is no hidden filter effect left fighting the slider.
          const targets = videoTargets(action);
          const value = validateColorValue(key, input[key]);
          const ids = new Set(targets.map((item) => item.id));
          return elements.map((candidate) => ids.has(candidate.id) ? { ...candidate,
            properties: { ...(candidate.properties as Record<string, unknown>),
              ...colorProperties({ ...readColor(candidate.properties), [key]: value },
                readColorFilterId(candidate.properties),
                readColorFilterStrength(candidate.properties)) } as Prisma.InputJsonValue }
            : candidate);
        } catch (caught) {
          throw this.colorError(caught);
        }
      }
      if (action === 'RESET_VIDEO_ADJUSTMENTS') {
        return withPropertiesFor(videoTargets(action), colorProperties({ ...NEUTRAL_COLOR }, null, 1));
      }
      if (action === 'APPLY_COLOR_FILTER') {
        try {
          const filterId = validateColorFilterId(input.filterId);
          const strength = validateColorFilterStrength(input.strength);
          // Original is the reset, so it clears the label as well as the values.
          return withPropertiesFor(videoTargets(action), colorProperties(resolveColorFilter(filterId, strength),
            filterId === 'ORIGINAL' ? null : filterId, strength));
        } catch (caught) {
          throw this.colorError(caught);
        }
      }
      if (action === 'PASTE_VIDEO_ADJUSTMENTS') {
        const from = elements.find((candidate) =>
          candidate.id === this.requiredString(input.fromElementId, 'fromElementId'));
        if (!from || from.type !== 'VIDEO') {
          throw new BadRequestException({ code: 'INVALID_ELEMENT_TYPE',
            message: 'Copy adjustments from a video segment on this timeline' });
        }
        return withPropertiesFor(videoTargets(action), colorProperties(readColor(from.properties),
          readColorFilterId(from.properties), readColorFilterStrength(from.properties)));
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
        if (item.type === 'EFFECT' && readZoomEffect(item.properties)?.claimsMoment) {
          throw new BadRequestException({ code: 'USE_REMOVE_ZOOM',
            message: 'This zoom replaces a planned zoom; remove it with REMOVE_ZOOM' });
        }
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
      if (action === 'SET_VIDEO_CROP' || action === 'SET_VIDEO_ROTATION' ||
        action === 'SET_VIDEO_FLIP') {
        // Reframing an overlay image and reframing the footage are the same
        // gesture, so one command serves both rather than duplicating bounds.
        const requested = scope(elementId ? 'SELECTED_ELEMENT' : 'ALL_VIDEO_SEGMENTS');
        assertEditScope(action, requested,
          ['SELECTED_ELEMENT', 'CURRENT_VIDEO_SEGMENT', 'ALL_VIDEO_SEGMENTS', 'PROJECT']);
        const targets = requested === 'ALL_VIDEO_SEGMENTS' || requested === 'PROJECT'
          ? videoTargets(action) : [requireTarget()];
        // Rotation also applies to TEXT and captions - the preview draws it and
        // the ASS builder emits it - while crop and flip stay pixel-source only.
        const invalid = targets.find((item) => {
          const rotatable = action === 'SET_VIDEO_ROTATION' &&
            (item.type === 'TEXT' || item.type === 'SUBTITLE');
          return item.type !== 'VIDEO' && item.type !== 'IMAGE' && !rotatable;
        });
        if (invalid) {
          throw new BadRequestException({ code: 'INVALID_ELEMENT_TYPE',
            message: 'Crop and flip require a VIDEO or IMAGE element' });
        }
        try {
          if (action === 'SET_VIDEO_CROP') {
            return withPropertiesFor(targets, { crop: validateCrop({ left: input.cropLeft,
              right: input.cropRight, top: input.cropTop, bottom: input.cropBottom }) });
          }
          if (action === 'SET_VIDEO_ROTATION') {
            return withPropertiesFor(targets, { rotation: validateRotation(input.rotation) });
          }
          if (typeof input.flipH !== 'boolean' || typeof input.flipV !== 'boolean') {
            throw new BadRequestException('flipH and flipV must be boolean');
          }
          return withPropertiesFor(targets, { flipH: input.flipH, flipV: input.flipV });
        } catch (caught) {
          throw this.transformError(caught);
        }
      }
      if (action === 'SET_VIDEO_SCALE' || action === 'SET_VIDEO_POSITION') {
        const targets = videoTargets(action);
        try {
          return action === 'SET_VIDEO_SCALE'
            ? withPropertiesFor(targets, { scale: validateScale(input.scale) })
            : withPropertiesFor(targets, { offsetX: validateOffset(input.x, 'x'),
              offsetY: validateOffset(input.y, 'y') });
        } catch (caught) {
          throw this.transformError(caught);
        }
      }
      if (action === 'SET_SPEED') {
        const item = this.videoElement(elements, this.requiredString(input.elementId, 'elementId'));
        let speed: number;
        try { speed = validateSpeed(input.speed); }
        catch (caught) { throw this.transformError(caught); }
        const trimStart = item.trimStart ?? 0;
        const trimEnd = item.trimEnd ?? trimStart + item.duration;
        const duration = timelineDurationFor(trimStart, trimEnd, speed);
        if (duration < MIN_VIDEO_DURATION_SEC) {
          throw new BadRequestException({ code: 'INVALID_SPEED',
            message: 'That speed would make this segment shorter than the safe minimum' });
        }
        // Changing one segment's length moves every later segment, and every
        // overlay, caption and music clip placed against them. Both happen here,
        // inside the one mutation, so the timeline is never briefly invalid and
        // one undo puts all of it back.
        const before = videoLayout(elements);
        const sped = elements.map((candidate) => candidate.id === item.id
          ? { ...candidate, duration,
            properties: { ...(item.properties as Record<string, unknown>), speed } as
              Prisma.InputJsonValue }
          : candidate);
        return retimeOverlays(sped, before, videoLayout(sped), MIN_VIDEO_DURATION_SEC);
      }
      // --- Workstream C: text and caption commands --------------------------
      //
      // Every command below is typed, bounds-checked in edit-mode-text.ts /
      // edit-mode-captions.ts, folded through this one mutation path, and
      // therefore history-backed and undoable as a single step. There is no
      // generic "set these text properties" JSON patch: the editor, an
      // assistant bundle and a raw request all reach the same validators.
      const requireText = (kinds: Array<'TEXT' | 'SUBTITLE'> = ['TEXT', 'SUBTITLE']) => {
        const item = requireTarget();
        if (item.type !== 'TEXT' && item.type !== 'SUBTITLE') {
          throw new BadRequestException({ code: 'INVALID_ELEMENT_TYPE',
            message: 'Command requires a TEXT or SUBTITLE element' });
        }
        if (!kinds.includes(item.type)) {
          throw new BadRequestException({ code: 'INVALID_ELEMENT_TYPE',
            message: `Command requires a ${kinds.join(' or ')} element` });
        }
        return item;
      };
      const captionSpec = (item: TimelineElement) => {
        const properties = item.properties as Record<string, unknown>;
        return { content: String(properties.content ?? ''), startTime: item.startTime,
          duration: item.duration, words: readCaptionWords(properties) };
      };
      // Workstream G: the caption TRACK as one target. With no elementId and
      // elementType SUBTITLE, a style command writes its one property onto every
      // caption - the same bulk form SET_ELEMENT_VISIBLE and SET_AUDIO_MUTED
      // already have. "Make the captions bigger" is then one revision that
      // changes font size and nothing else, instead of 400 revisions, or an
      // APPLY_CAPTION_STYLE_TO_ALL that would also overwrite every caption's box.
      const requestedTextScope = scope(!elementId && input.elementType === 'SUBTITLE'
        ? 'TRACK' : 'SELECTED_ELEMENT');
      const captionTrack = requestedTextScope === 'TRACK' &&
        (input.elementType === undefined || input.elementType === 'SUBTITLE' || target?.type === 'SUBTITLE');
      const patchCaptions = (patch: Record<string, unknown>) => {
        if (!elements.some((item) => item.type === 'SUBTITLE')) {
          throw new BadRequestException({ code: 'NO_CAPTIONS',
            message: 'This timeline has no captions yet' });
        }
        return elements.map((item) => item.type === 'SUBTITLE'
          ? { ...item, properties: { ...(item.properties as Record<string, unknown>),
            ...patch } as Prisma.InputJsonValue }
          : item);
      };
      // Step 5 style resolution for captions, deterministic and per property:
      //   * a TRACK write sets that property on every caption and clears it
      //     from each caption's `styleOverrides` (the user asked for all);
      //   * a SELECTED write sets it on one caption and records the key in
      //     that caption's `styleOverrides`;
      //   * a later TRACK write of a DIFFERENT property never touches an
      //     override, so "all captions yellow" keeps a selected size of 52.
      // Wording, timing, words and provenance are never in a style patch.
      const overrideKeys = (patch: Record<string, unknown>) => Object.keys(patch)
        .filter((key) => key !== 'captionStyleId');
      const withOverrides = (properties: Record<string, unknown>, keys: string[], add: boolean) => {
        const current = Array.isArray(properties.styleOverrides)
          ? (properties.styleOverrides as unknown[]).map(String) : [];
        const next = add ? [...new Set([...current, ...keys])]
          : current.filter((key) => !keys.includes(key));
        return next.length ? { styleOverrides: next.sort() }
          : current.length ? { styleOverrides: [] } : {};
      };
      const patchCaptionTrack = (patch: Record<string, unknown>) => {
        if (!elements.some((item) => item.type === 'SUBTITLE')) {
          throw new BadRequestException({ code: 'NO_CAPTIONS',
            message: 'This timeline has no captions yet' });
        }
        const keys = overrideKeys(patch);
        return elements.map((item) => {
          if (item.type !== 'SUBTITLE') return item;
          const properties = item.properties as Record<string, unknown>;
          return { ...item, properties: { ...properties, ...patch,
            ...withOverrides(properties, keys, false) } as Prisma.InputJsonValue };
        });
      };
      const patchSelectedCaption = (item: TimelineElement, patch: Record<string, unknown>) => {
        const properties = item.properties as Record<string, unknown>;
        return withProperties(item, { ...patch,
          ...withOverrides(properties, overrideKeys(patch), true) });
      };
      const textStyleCommand = (patch: Record<string, unknown>) => {
        assertEditScope(action, requestedTextScope, ['SELECTED_ELEMENT', 'TRACK']);
        if (requestedTextScope === 'TRACK' && !captionTrack) {
          if (input.elementType !== 'TEXT') throw new BadRequestException({
            code: 'UNSUPPORTED_EDIT_SCOPE', message: 'TRACK text styling requires TEXT or SUBTITLE' });
          return withPropertiesFor(elements.filter((item) => item.type === 'TEXT'), patch);
        }
        if (captionTrack) return patchCaptionTrack(patch);
        const item = requireText();
        return item.type === 'SUBTITLE' ? patchSelectedCaption(item, patch)
          : withProperties(item, patch);
      };

      if (action === 'SET_TEXT_CONTENT') {
        assertEditScope(action, requestedTextScope, ['SELECTED_ELEMENT']);
        const item = requireText(['TEXT']);
        if (typeof input.content !== 'string') {
          throw new BadRequestException('content must be a string');
        }
        return withProperties(item, { content: input.content.slice(0, MAX_TEXT_LENGTH), textRuns: [] });
      }
      if (action === 'SET_TEXT_RUNS') {
        assertEditScope(action, requestedTextScope, ['SELECTED_ELEMENT']);
        const item = requireText(['TEXT']);
        const content = String((item.properties as Record<string, unknown>).content ?? '');
        return withProperties(item, { textRuns: this.validTextRuns(input.textRuns, content) });
      }
      if (action === 'SET_TEXT_FONT' || action === 'SET_TEXT_SIZE' ||
        action === 'SET_TEXT_WEIGHT' || action === 'SET_TEXT_COLOR' ||
        action === 'SET_TEXT_ALIGNMENT' || action === 'SET_TEXT_STROKE' ||
        action === 'SET_TEXT_SHADOW' || action === 'SET_TEXT_BACKGROUND' ||
        action === 'SET_TEXT_SPACING' || action === 'SET_CAPTION_ACTIVE_WORD' ||
        action === 'SET_TEXT_CASE') {
        try {
          if (action === 'SET_TEXT_FONT') {
            return textStyleCommand({ fontFamily: validateFontFamily(input.fontFamily) });
          }
          if (action === 'SET_TEXT_SIZE') {
            return textStyleCommand({ fontSize: validateFontSize(input.fontSize) });
          }
          if (action === 'SET_TEXT_WEIGHT') {
            return textStyleCommand({ fontWeight: validateFontWeight(input.fontWeight) });
          }
          if (action === 'SET_TEXT_COLOR') {
            return textStyleCommand({ color: validateColor(input.color, 'color') });
          }
          if (action === 'SET_TEXT_ALIGNMENT') {
            return textStyleCommand({ textAlign: validateAlignment(input.textAlign) });
          }
          if (action === 'SET_TEXT_STROKE') {
            return textStyleCommand({ stroke: validateStroke(input) });
          }
          if (action === 'SET_TEXT_SHADOW') {
            return textStyleCommand({ shadow: validateShadow(input) });
          }
          if (action === 'SET_TEXT_BACKGROUND') {
            const background = validateBackground(input);
            // `backgroundColor` is the Phase 3 property and is kept in step, so
            // anything still reading it sees the same plate this draws.
            return textStyleCommand({ background,
              backgroundColor: effectiveBackgroundColor(background) });
          }
          if (action === 'SET_TEXT_SPACING') {
            return textStyleCommand(validateSpacing(input));
          }
          // Letter case is a STYLE property, not a rewrite: the stored wording
          // is untouched and the renderer upper-cases at draw time, so turning
          // it off restores the original casing exactly. This is what lets a
          // template state an uppercase preference without editing anyone's text.
          if (action === 'SET_TEXT_CASE') {
            return textStyleCommand({
              uppercase: validateBoolean(input.uppercase, 'uppercase') });
          }
          // SET_CAPTION_ACTIVE_WORD: word-level emphasis, captions only.
          const activeWord = validateActiveWord(input);
          return captionTrack ? patchCaptionTrack({ activeWord })
            : patchSelectedCaption(requireText(['SUBTITLE']), { activeWord });
        } catch (caught) {
          throw this.textError(caught);
        }
      }
      if (action === 'SET_TEXT_STYLE_PRESET') {
        const item = requireText(['TEXT']);
        let preset;
        try { preset = textStylePreset(String(input.textStyleId)); }
        catch (caught) { throw this.textError(caught); }
        // A preset restyles in place. Its box is applied only when the caller
        // asks for it, so a preset never teleports text the user has placed.
        const box = input.applyBox === true ? preset.box : {};
        return withProperties(item, { ...styleProperties(preset.style), ...box,
          textStyleId: preset.id });
      }

      if (action === 'GENERATE_CAPTIONS' || action === 'REGENERATE_CAPTIONS') {
        const source = [...assets.values()].find((candidate) => candidate.role === 'SOURCE');
        if (!source) throw new BadRequestException({ code: 'SOURCE_MISSING',
          message: 'Attach a source video before generating captions.' });
        const existing = elements.filter((item) => item.type === 'SUBTITLE');
        // Step 5: wording a person (or an explicit AI rewrite) produced is only
        // ever replaced by an EXPLICIT regeneration. Plain generation over an
        // edited track is refused rather than silently reverting "OpenAI".
        const edited = existing.filter((item) =>
          readCaptionTextSource(item.properties) !== 'TRANSCRIPT_GENERATED');
        if (action === 'GENERATE_CAPTIONS' && edited.length) {
          throw new BadRequestException({ code: 'CAPTIONS_HAVE_EDITS',
            message: `${edited.length} caption${edited.length === 1 ? ' has' : 's have'} edited ` +
              'wording. Use REGENERATE_CAPTIONS to replace it with the transcript.' });
        }
        let preset;
        try { preset = captionStylePreset(String(input.captionStyleId ??
          (action === 'REGENERATE_CAPTIONS' && existing.length
            ? (existing[0].properties as Record<string, unknown>).captionStyleId ?? 'CLEAN'
            : 'CLEAN'))); }
        catch (caught) { throw this.textError(caught); }
        // Regeneration rewrites WORDING only: the current track style and box
        // are carried over unless a style was explicitly asked for.
        const keepStyle = action === 'REGENERATE_CAPTIONS' && existing.length &&
          input.captionStyleId === undefined
          ? (() => {
            // The TRACK style is read from a caption with no selected-caption
            // overrides, so one caption's local tweak is not spread to all.
            const base = existing.find((item) => {
              const overrides = (item.properties as Record<string, unknown>).styleOverrides;
              return !Array.isArray(overrides) || !overrides.length;
            }) ?? existing[0];
            const properties = base.properties as Record<string, unknown>;
            return { ...extractStyleProperties(properties),
              x: Number(properties.x ?? DEFAULT_CAPTION_BOX.x),
              y: Number(properties.y ?? DEFAULT_CAPTION_BOX.y),
              width: Number(properties.width ?? DEFAULT_CAPTION_BOX.width),
              height: Number(properties.height ?? DEFAULT_CAPTION_BOX.height),
              hidden: properties.hidden === true };
          })() : {};
        const transcript = wordsFromCache(source.transcript);
        const map = buildTimelineMap(elements.map((item) => ({ id: item.id, type: item.type,
          track: item.track, position: item.position, startTime: item.startTime,
          duration: item.duration, trimStart: item.trimStart ?? 0,
          trimEnd: item.trimEnd ?? null, properties: item.properties })));
        let generated;
        try {
          generated = generateCaptions({ words: transcript.words,
            wordTimings: transcript.wordTimings, map, limit: maxSubtitleElements() });
        } catch (caught) { throw this.captionError(caught); }
        // Regeneration REPLACES the caption track rather than appending to it,
        // the same idempotency rule the rest of the pipeline follows.
        const kept = elements.filter((item) => item.type !== 'SUBTITLE');
        let captionPosition = kept.filter((item) => item.track === 1).length;
        const captions: TimelineElement[] = generated.captions.map((spec) => ({
          id: randomUUID(), assetId: null, type: 'SUBTITLE' as EditElementType, track: 1,
          position: captionPosition++, startTime: spec.startTime, duration: spec.duration,
          trimStart: 0, trimEnd: null,
          properties: { ...preset.box, content: spec.content, words: spec.words,
            scale: 1, rotation: 0, opacity: 1, zIndex: 35, anchor: 'top-left', locked: false,
            hidden: false, manualEdited: false, textSource: 'TRANSCRIPT_GENERATED',
            captionStyleId: preset.id, ...styleProperties(preset.style), ...keepStyle,
            origin: ctx.actor === 'AI_ACTION' ? 'ASSISTANT' : 'USER' } as Prisma.InputJsonValue
        }));
        return [...kept, ...captions];
      }
      if (action === 'REMOVE_CAPTIONS') {
        // Removing the track also turns the subtitle POLICY off; otherwise the
        // renderer would build a render-only caption track from the transcript
        // and the captions the user just removed would come back in the export.
        ctx.settingsPatch.subtitlePolicy = 'OFF';
        return elements.filter((item) => item.type !== 'SUBTITLE');
      }
      if (action === 'SET_CAPTIONS_VISIBLE') {
        if (typeof input.visible !== 'boolean') {
          throw new BadRequestException('visible must be a boolean');
        }
        const hidden = !input.visible;
        return elements.map((item) => item.type === 'SUBTITLE'
          ? { ...item, properties: { ...(item.properties as Record<string, unknown>),
            hidden } as Prisma.InputJsonValue }
          : item);
      }
      if (action === 'SET_CAPTION_TEXT') {
        assertEditScope(action, scope(), ['SELECTED_ELEMENT']);
        const item = requireText(['SUBTITLE']);
        if (typeof input.content !== 'string' || !input.content.trim()) {
          throw new BadRequestException('content is required');
        }
        // Manual caption editing INTENTIONALLY allows wording that differs from
        // the transcript. The flag is what stops a later regeneration or an
        // assistant turn from silently reverting a correction the user made.
        // Step 5 provenance: a direct edit is MANUAL_EDITED; an automated
        // rewrite is AI_REWRITTEN. Both survive every later style command and
        // plain generation; only REGENERATE_CAPTIONS replaces them.
        const automated = ctx.actor === 'AI_ACTION' || ctx.actor === 'TEMPLATE_ACTION';
        return withProperties(item, { content: input.content.slice(0, MAX_CAPTION_LENGTH),
          manualEdited: true, textSource: automated ? 'AI_REWRITTEN' : 'MANUAL_EDITED' });
      }
      if (action === 'SPLIT_CAPTION') {
        assertEditScope(action, scope(), ['SELECTED_ELEMENT']);
        const item = requireText(['SUBTITLE']);
        const atSec = this.finiteNumber(input.atSec, 'atSec');
        let parts;
        try { parts = splitCaption({ ...captionSpec(item), atSec }); }
        catch (caught) { throw this.captionError(caught); }
        const properties = item.properties as Record<string, unknown>;
        const half = (part: { content: string; startTime: number; duration: number;
          words: CaptionWord[] }, id: string, slot: number): TimelineElement => ({
          ...item, id, position: slot, startTime: part.startTime, duration: part.duration,
          properties: { ...properties, content: part.content,
            words: part.words } as Prisma.InputJsonValue });
        return [
          ...elements.filter((candidate) => candidate.id !== item.id),
          half(parts.left, item.id, item.position),
          half(parts.right, randomUUID(), nextPosition(1))
        ];
      }
      if (action === 'MERGE_CAPTION') {
        assertEditScope(action, scope(), ['SELECTED_ELEMENT']);
        const item = requireText(['SUBTITLE']);
        const direction = String(input.direction ?? 'PREVIOUS').toUpperCase();
        if (direction !== 'PREVIOUS' && direction !== 'NEXT') {
          throw new BadRequestException('direction must be PREVIOUS or NEXT');
        }
        const neighbour = adjacentCaption(elements.map((candidate) => ({ ...candidate,
          type: String(candidate.type) })), { ...item, type: String(item.type) }, direction);
        if (!neighbour) throw new BadRequestException({ code: 'NO_ADJACENT_CAPTION',
          message: `There is no caption ${direction === 'PREVIOUS' ? 'before' : 'after'} this one.` });
        const other = elements.find((candidate) => candidate.id === neighbour.id)!;
        let merged;
        try { merged = mergeCaptions(captionSpec(item), captionSpec(other)); }
        catch (caught) { throw this.captionError(caught); }
        // The SELECTED caption's style wins, and the merged line keeps its id -
        // so the element you were editing is the element you are still editing.
        return elements.filter((candidate) => candidate.id !== other.id)
          .map((candidate) => candidate.id === item.id
            ? { ...candidate, startTime: merged.startTime, duration: merged.duration,
              properties: { ...(item.properties as Record<string, unknown>),
                content: merged.content, words: merged.words } as Prisma.InputJsonValue }
            : candidate);
      }
      if (action === 'SET_CAPTION_STYLE') {
        let preset;
        try { preset = captionStylePreset(String(input.captionStyleId)); }
        catch (caught) { throw this.textError(caught); }
        const patch = { ...styleProperties(preset.style), ...preset.box, captionStyleId: preset.id };
        const requested = scope(!elementId ? 'TRACK' : 'SELECTED_ELEMENT');
        assertEditScope(action, requested, ['SELECTED_ELEMENT', 'TRACK']);
        return requested === 'TRACK' ? patchCaptionTrack(patch)
          : patchSelectedCaption(requireText(['SUBTITLE']), patch);
      }
      if (action === 'APPLY_CAPTION_STYLE_TO_ALL') {
        const item = requireText(['SUBTITLE']);
        const properties = item.properties as Record<string, unknown>;
        // STYLE and PLACEMENT only. Text, timing and the manualEdited flag are
        // deliberately absent from this patch, so one undo restores every
        // caption's previous look without touching a single correction.
        const patch = { ...extractStyleProperties(properties),
          x: Number(properties.x ?? DEFAULT_CAPTION_BOX.x),
          y: Number(properties.y ?? DEFAULT_CAPTION_BOX.y),
          width: Number(properties.width ?? DEFAULT_CAPTION_BOX.width),
          height: Number(properties.height ?? DEFAULT_CAPTION_BOX.height),
          rotation: Number(properties.rotation ?? 0),
          zIndex: Number(properties.zIndex ?? 35),
          captionStyleId: properties.captionStyleId ?? null };
        return elements.map((candidate) => candidate.type === 'SUBTITLE'
          ? { ...candidate, properties: { ...(candidate.properties as Record<string, unknown>),
            ...patch } as Prisma.InputJsonValue }
          : candidate);
      }

      // --- Workstream G: zoom events -----------------------------------------
      //
      // A zoom is an EFFECT element on its own track. Its timing is edited with
      // the ordinary SET_ELEMENT_TIMING, and it is retimed with everything else
      // when a segment's speed changes. The renderer re-checks every stored zoom
      // against subject and information safety, so a stored scale is a request.
      const requireZoom = () => {
        const item = requireTarget();
        if (item.type !== 'EFFECT' || !readZoomEffect(item.properties)) {
          throw new BadRequestException({ code: 'INVALID_ELEMENT_TYPE',
            message: 'Zoom command requires a zoom element' });
        }
        return item;
      };
      if (action === 'ADD_ZOOM') {
        const startTime = this.nonNegativeNumber(input.startTime, 'startTime');
        const duration = this.positiveNumber(input.duration, 'duration');
        if (input.enabled !== false && duration < MIN_ZOOM_DURATION_SEC - 1e-6) {
          throw new BadRequestException({ code: 'ZOOM_TOO_SHORT',
            message: `A zoom needs at least ${MIN_ZOOM_DURATION_SEC}s to ease in, hold and ease out` });
        }
        if (startTime + duration > projectDuration + 1e-6) throw new BadRequestException({
          code: 'TIMING_OUT_OF_RANGE', message: 'A zoom must stay within the video timeline' });
        let properties: Record<string, unknown>;
        try { properties = zoomProperties(input); }
        catch (caught) { throw this.zoomError(caught); }
        if (properties.claimsMoment && elements.some((item) => item.type === 'EFFECT' &&
          readZoomEffect(item.properties)?.claimsMoment === properties.claimsMoment)) {
          throw new BadRequestException({ code: 'ZOOM_ALREADY_EDITED',
            message: 'That planned zoom already has an edited version; change that one instead' });
        }
        return add({ id: randomUUID(), assetId: null, type: 'EFFECT', track: 4,
          position: nextPosition(4), startTime, duration, trimStart: 0, trimEnd: null,
          properties: { ...properties, locked: false, ...this.originProperties(input) } });
      }
      if (action === 'SET_ZOOM_SCALE') {
        const requested = scope();
        assertEditScope(action, requested, ['SELECTED_ELEMENT', 'TRACK', 'PROJECT']);
        const targets = requested === 'TRACK' || requested === 'PROJECT'
          ? elements.filter((item) => item.type === 'EFFECT' && !!readZoomEffect(item.properties))
          : [requireZoom()];
        if (!targets.length) throw new BadRequestException({ code: 'NO_ZOOMS',
          message: 'This timeline has no canonical zoom events' });
        try { return withPropertiesFor(targets,
          { scale: validateZoomScale(input.scale), enabled: true }); }
        catch (caught) { throw this.zoomError(caught); }
      }
      // Step 5: relative strength. SELECTED changes one zoom; TRACK changes every
      // canonical zoom event AND steps the zoom POLICY that drives planned
      // (preset) zooms, so "make zooms weaker" also weakens the ones the
      // renderer derives rather than leaving them at full strength.
      if (action === 'ADJUST_ZOOM_STRENGTH') {
        const direction = String(input.direction ?? '').toUpperCase();
        if (direction !== 'WEAKER' && direction !== 'STRONGER') {
          throw new BadRequestException({ code: 'INVALID_DIRECTION',
            message: 'direction must be WEAKER or STRONGER' });
        }
        const step = input.step === undefined ? ZOOM_SCALE_STEP
          : this.positiveNumber(input.step, 'step');
        const sign = direction === 'WEAKER' ? -1 : 1;
        const requested = scope(elementId ? 'SELECTED_ELEMENT' : 'TRACK');
        assertEditScope(action, requested, ['SELECTED_ELEMENT', 'TRACK', 'PROJECT']);
        const all = requested !== 'SELECTED_ELEMENT';
        const targets = all ? elements.filter((item) => item.type === 'EFFECT' &&
          readZoomEffect(item.properties)?.enabled) : [requireZoom()];
        const policy = String(ctx.settings.zoomPolicy ?? 'OFF') as ZoomPolicy;
        const levels = ZOOM_POLICIES.filter((level) => level !== 'OFF');
        const policyIndex = levels.indexOf(policy as typeof levels[number]);
        if (all && policyIndex >= 0) {
          ctx.settingsPatch.zoomPolicy = levels[Math.max(0,
            Math.min(levels.length - 1, policyIndex + sign))];
        }
        if (!targets.length && !(all && policyIndex >= 0)) {
          throw new BadRequestException({ code: 'NO_ZOOMS',
            message: 'This timeline has no zooms to adjust' });
        }
        const ids = new Set(targets.map((item) => item.id));
        return elements.map((item) => {
          if (!ids.has(item.id)) return item;
          const current = readZoomEffect(item.properties)!.scale;
          const scale = Number(Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE,
            current + sign * step)).toFixed(4));
          return { ...item, properties: { ...(item.properties as Record<string, unknown>),
            scale } as Prisma.InputJsonValue };
        });
      }
      if (action === 'REMOVE_ZOOM') {
        const requested = scope(elementId ? 'SELECTED_ELEMENT' : 'TRACK');
        assertEditScope(action, requested, ['SELECTED_ELEMENT', 'TRACK', 'PROJECT']);
        if (requested === 'TRACK' || requested === 'PROJECT') {
          const zooms = elements.filter((item) => item.type === 'EFFECT' &&
            !!readZoomEffect(item.properties));
          const policyZooms = String(ctx.settings.zoomPolicy ?? 'OFF') !== 'OFF';
          if (!zooms.length && !policyZooms) throw new BadRequestException({ code: 'NO_ZOOMS',
            message: 'This timeline has no canonical zoom events' });
          // "Remove all zooms" also switches the zoom policy off, so planned
          // (render-derived) zooms stop too - no shadow zoom survives it.
          if (policyZooms) ctx.settingsPatch.zoomPolicy = 'OFF';
          const disabledClaims = new Set(zooms.filter((item) =>
            readZoomEffect(item.properties)?.claimsMoment).map((item) => item.id));
          const ids = new Set(zooms.map((item) => item.id));
          return elements.filter((item) => !ids.has(item.id) || disabledClaims.has(item.id))
            .map((item) => disabledClaims.has(item.id) ? { ...item,
              properties: { ...(item.properties as Record<string, unknown>), enabled: false } as
                Prisma.InputJsonValue } : item);
        }
        const item = requireZoom();
        // A zoom that replaced a preset moment is disabled rather than deleted:
        // deleting it would let the moment it replaced quietly render again.
        return readZoomEffect(item.properties)?.claimsMoment
          ? withProperties(item, { enabled: false })
          : elements.filter((candidate) => candidate.id !== item.id);
      }

      // --- Step 5: canonical framing ------------------------------------------
      //
      // FIT / FILL / ASPECT / FREE over CURRENT_VIDEO_SEGMENT or
      // ALL_VIDEO_SEGMENTS. Only framing properties are written (crop insets,
      // frameLayout) plus, for a whole-project aspect, the output canvas - so
      // trims, order, speed, captions, hook, overlays, audio and zoom events
      // are untouched, and a multi-cut reconstructed edit keeps every cut.
      if (action === 'SET_VIDEO_FRAMING') {
        let mode;
        try { mode = validateFramingMode(input.mode); }
        catch (caught) { throw this.framingError(caught); }
        const requested = scope(elementId ? 'CURRENT_VIDEO_SEGMENT' : 'ALL_VIDEO_SEGMENTS');
        assertEditScope(action, requested, ['CURRENT_VIDEO_SEGMENT', 'ALL_VIDEO_SEGMENTS',
          'SELECTED_ELEMENT', 'PROJECT']);
        const whole = requested === 'ALL_VIDEO_SEGMENTS' || requested === 'PROJECT';
        const videoElements = elements.filter((item) => item.type === 'VIDEO' && item.track === 0);
        if (!videoElements.length) throw new BadRequestException({ code: 'NO_VIDEO_ELEMENTS',
          message: 'This project has no video elements to crop' });
        if (!whole && (typeof input.elementId !== 'string' || !input.elementId)) {
          throw new BadRequestException({ code: 'NO_VIDEO_SELECTED',
            message: 'Select a video segment first' });
        }
        const targets = whole
          ? videoElements
          : [this.videoElement(elements, this.requiredString(input.elementId, 'elementId'))];
        const ids = new Set(targets.map((item) => item.id));
        const write = (patchFor: (item: TimelineElement) => Record<string, unknown>) =>
          elements.map((item) => ids.has(item.id) ? { ...item, properties: {
            ...(item.properties as Record<string, unknown>), ...patchFor(item) } as
            Prisma.InputJsonValue } : item);
        try {
          if (mode === 'FIT' || mode === 'FILL') {
            // Show the whole frame / cover the canvas. A prior crop is part of
            // the framing being replaced, so it resets to neutral.
            return write(() => ({ frameLayout: mode, crop: { ...NEUTRAL_CROP } }));
          }
          if (mode === 'FREE') {
            return write(() => ({ frameLayout: null, crop: validateCrop({ left: input.cropLeft,
              right: input.cropRight, top: input.cropTop, bottom: input.cropBottom }) }));
          }
          const aspect = validateFramingAspect(input.aspectRatio);
          const fitMode = input.fitMode === undefined ? 'FILL'
            : String(input.fitMode).trim().toUpperCase();
          if (fitMode !== 'FIT' && fitMode !== 'FILL') {
            throw new FramingError('INVALID_FIT_MODE', 'fitMode must be FIT or FILL');
          }
          const canvas = String(ctx.settings.aspectRatio ?? 'SOURCE');
          if (whole) {
            // The whole clip becomes this shape: the canvas changes and every
            // segment receives the same explicit framing rule. FIT keeps every
            // source pixel visible; FILL covers the canvas without distortion.
            ctx.settingsPatch.aspectRatio = aspect;
            return write(() => ({ frameLayout: fitMode, crop: { ...NEUTRAL_CROP } }));
          }
          if (canvas === aspect) {
            return write(() => ({ frameLayout: fitMode, crop: { ...NEUTRAL_CROP } }));
          }
          // One segment cannot have its own canvas, so it gets a centred source
          // crop of that shape, then uses the requested fit/fill rule in the
          // existing project canvas.
          return write((item) => {
            const asset = item.assetId ? assets.get(item.assetId) : undefined;
            return { frameLayout: fitMode, crop: aspectCropInsets(Number(asset?.width),
              Number(asset?.height), aspect) };
          });
        } catch (caught) {
          throw caught instanceof FramingError ? this.framingError(caught)
            : this.transformError(caught);
        }
      }
      if (action === 'SET_FIT_BACKGROUND') {
        const background = String(input.background ?? '').toUpperCase();
        if (!['BLUR', 'BLACK', 'WHITE'].includes(background)) throw new BadRequestException({
          code: 'INVALID_BACKGROUND', message: 'background must be BLUR, BLACK or WHITE' });
        assertEditScope(action, scope('PROJECT'), ['PROJECT', 'ALL_VIDEO_SEGMENTS']);
        ctx.settingsPatch.fitBackground = background;
        return elements;
      }
      if (action === 'SET_REFRAME_POLICY') {
        const requested = scope('PROJECT');
        // The camera is solved once over the whole exported timeline, so a
        // policy cannot differ per segment; per-segment framing uses
        // SET_VIDEO_FRAMING instead.
        assertEditScope(action, requested, ['PROJECT', 'ALL_VIDEO_SEGMENTS']);
        try { ctx.settingsPatch.reframePolicy = resolveReframePolicy(input.policy); }
        catch (caught) { throw this.framingError(caught); }
        // Segment FIT/FILL overrides would otherwise keep beating the new policy.
        if (input.clearSegmentOverrides === true) {
          return elements.map((item) => item.type === 'VIDEO' ? { ...item, properties: {
            ...(item.properties as Record<string, unknown>), frameLayout: null } as
            Prisma.InputJsonValue } : item);
        }
        return elements;
      }

      throw new BadRequestException({ code: 'UNSUPPORTED_COMMAND',
        message: 'Unsupported EditMode command' });
    }
  }

  /** Framing failures carry their own code; UNSUPPORTED_* stays UNSUPPORTED. */
  private framingError(caught: unknown) {
    if (caught instanceof FramingError) {
      return new BadRequestException({ code: caught.code, message: caught.message });
    }
    return caught instanceof Error ? caught : new BadRequestException('Invalid framing');
  }

  /**
   * The stored transform invariants for one VIDEO element.
   *
   * A VIDEO element occupies its source range divided by its playback rate, so
   * at the default 1x this is the original "duration matches the trim range"
   * rule. Crop is validated on the way in too, but a timeline can also arrive
   * from a history restore or an assistant bundle, so it is re-checked here.
   */
  private assertVideoTransform(element: TimelineElement, trimStart: number, trimEnd: number) {
    const expected = timelineDurationFor(trimStart, trimEnd, readSpeed(element.properties));
    if (Math.abs(element.duration - expected) > 1e-4) {
      throw new BadRequestException({ code: 'INVALID_DURATION',
        message: 'VIDEO duration must match its source trim range at its playback speed' });
    }
    const crop = readCrop(element.properties);
    if (crop.left + crop.right > 1 - MIN_CROP_REMAINDER + 1e-6 ||
      crop.top + crop.bottom > 1 - MIN_CROP_REMAINDER + 1e-6) {
      throw new BadRequestException({ code: 'INVALID_CROP',
        message: 'A stored crop leaves too little of the frame' });
    }
  }

  /** Text style bounds failures carry their own code, so the inspector can point
   * at the control that was out of range. */
  private textError(caught: unknown) {
    if (caught instanceof TextRangeError) {
      return new BadRequestException({ code: caught.code, message: caught.message });
    }
    return caught instanceof Error ? caught : new BadRequestException('Invalid text style');
  }

  /** Caption generation, split and merge failures, likewise. */
  private captionError(caught: unknown) {
    if (caught instanceof CaptionGenerationError) {
      return new BadRequestException({ code: caught.code, message: caught.message });
    }
    return caught instanceof Error ? caught : new BadRequestException('Caption command failed');
  }

  /** Colour bounds failures carry their own code, so the Adjust panel can point
   * at the control that was out of range. */
  private colorError(caught: unknown) {
    if (caught instanceof ColorRangeError) {
      return new BadRequestException({ code: caught.code, message: caught.message });
    }
    return caught instanceof Error ? caught : new BadRequestException('Invalid colour adjustment');
  }

  /** Zoom bounds failures, likewise. */
  private zoomError(caught: unknown) {
    if (caught instanceof ZoomRangeError) {
      return new BadRequestException({ code: caught.code, message: caught.message });
    }
    return caught instanceof Error ? caught : new BadRequestException('Invalid zoom');
  }

  /** Audio bounds failures, likewise. A typed BadRequestException raised inside
   * the same block (DUCKING_UNAVAILABLE) passes straight through. */
  private audioError(caught: unknown) {
    if (caught instanceof AudioRangeError) {
      return new BadRequestException({ code: caught.code, message: caught.message });
    }
    return caught instanceof Error ? caught : new BadRequestException('Invalid audio setting');
  }

  /**
   * Whether this project's source carries transcript word timings.
   *
   * This is the ONLY thing ducking is allowed to be built from: the transcript
   * already cached on the exact source by "Analyze source". Nothing here
   * re-transcribes, calls the AI service or infers speech from levels.
   */
  private hasSpeechTiming(assets: Map<string, CommandAsset>) {
    for (const asset of assets.values()) {
      if (asset.role !== 'SOURCE') continue;
      const transcript = wordsFromCache(asset.transcript);
      if (transcript.wordTimings && transcript.words.length > 0) return true;
    }
    return false;
  }

  /** Transform bounds failures carry their own code, so the editor can say which
   * control was out of range rather than showing a generic rejection. */
  private transformError(caught: unknown) {
    if (caught instanceof TransformRangeError) {
      return new BadRequestException({ code: caught.code, message: caught.message });
    }
    return caught instanceof Error ? caught : new BadRequestException('Invalid transform');
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

  private validTextRuns(value: unknown, content: string) {
    if (value === undefined) return [] as Array<{ text: string; color: string }>;
    if (!Array.isArray(value) || value.length > 24) {
      throw new BadRequestException('textRuns must be an array of at most 24 runs');
    }
    const runs = value.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new BadRequestException('Each text run must contain text and color');
      }
      const run = item as Record<string, unknown>;
      if (typeof run.text !== 'string' || !run.text) {
        throw new BadRequestException('Each text run requires non-empty text');
      }
      return { text: run.text, color: validateColor(run.color, 'text run color') };
    });
    if (runs.map((run) => run.text).join('') !== content) {
      throw new BadRequestException('textRuns must reproduce the element content exactly');
    }
    return runs;
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
        assets: { select: { id: true, role: true, duration: true, width: true, height: true,
          transcript: true } } } });
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
        // Step 5: a preset plan is interdependent (refs), so a project lock that
        // blocks any of it aborts the whole preset rather than half-applying it.
        const locked = blockingEditConstraint(command.action, 'TEMPLATE_ACTION',
          readProjectConstraints(settingsBefore), this.constraintTargets(command.action, payload,
            elements));
        if (locked) throw this.blockedError(locked, `Preset ${bundle.presetId} (${command.action})`);
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

  /**
   * Applies a TEMPLATE as one user-level action.
   *
   * Deliberately the same shape as `applyPresetBundle`: every element command is
   * folded through `applyElementCommand`, the timeline is normalised and
   * validated after each one, and the whole thing commits in one transaction as
   * exactly one EditHistory row - actor TEMPLATE, action APPLY_TEMPLATE. So one
   * template application is one undo, and one redo puts the whole resulting
   * state back.
   *
   * There is no second mutation path here. A template cannot write an element
   * property that a manual command would refuse, cannot create or delete an
   * element, and cannot reach caption wording, caption timing or any text
   * content - because no command in its plan does those things.
   *
   * The ownership stamp (templateId / templateRunId / templateRole) is written
   * as a fixed three-field record onto the elements the template actually
   * touched. It is not arbitrary JSON passthrough: the values come from the
   * validated template and the run, never from the caller's payload.
   */
  async applyTemplateBundle(id: string, revisionValue: unknown, bundle: {
    templateId: string; templateName: string; templateRunId: string;
    source: 'BUILTIN' | 'USER'; summary: string;
    commands: TemplateCommand[];
    imprints: TemplateImprint[];
    defaults: Record<string, unknown>;
    /** Optional task constraints from the caller (e.g. an AI task applying a template). */
    constraints?: EditConstraint[];
  }) {
    const expectedRevision = parseRevision(revisionValue);
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(bundle.templateId)) {
      throw new BadRequestException({ code: 'INVALID_TEMPLATE', message: 'Unknown template' });
    }
    return serialize(await this.prisma.$transaction(async (tx) => {
      const current = await tx.editProject.findUnique({ where: { id }, include: { elements: true,
        assets: { select: { id: true, role: true, duration: true, width: true, height: true,
          transcript: true } } } });
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
      // Which element each facet touched, so ownership can be stamped once at
      // the end rather than re-written by every command in the facet.
      const touched = new Map<string, string>();
      // Step 5.17: a template is automation. Project locks (and any task
      // constraints) bind it at the command layer; a blocked command is skipped
      // and REPORTED, never silently dropped and never half-applied.
      const constraints = [...readProjectConstraints(settingsBefore),
        ...readEditConstraints(bundle.constraints ?? [], 'TASK')];
      const commandResults: EditCommandResult[] = [];

      for (const [index, command] of bundle.commands.entries()) {
        if (command.kind === 'SETTINGS') {
          // Settings are checked per key: a crop lock strips the canvas/reframe
          // keys and keeps the rest of the template's project style.
          const videos = elements.filter((item) => item.type === 'VIDEO');
          const guarded: Record<string, string> = { aspectRatio: 'SET_ASPECT_RATIO',
            reframePolicy: 'SET_AUTO_REFRAME', subtitlePolicy: 'SET_SUBTITLE_POLICY',
            gradingPolicy: 'SET_COLOR_GRADE' };
          const payload = { ...command.payload };
          for (const [key, action] of Object.entries(guarded)) {
            if (!(key in payload)) continue;
            const blocked = blockingEditConstraint(action, 'TEMPLATE_ACTION', constraints, videos);
            if (!blocked) continue;
            delete payload[key];
            commandResults.push({ index, action, status: 'BLOCKED_BY_CONSTRAINT', scope: 'PROJECT',
              affectedElementIds: [], affectedCount: 0, constraint: blocked.type });
          }
          style = { ...style, ...payload } as typeof style;
          commandResults.push({ index, action: 'SET_PROJECT_STYLE', status: 'DONE', scope: 'PROJECT',
            affectedElementIds: [], affectedCount: 0, settingsChanged: Object.keys(payload) });
          continue;
        }
        const blocked = blockingEditConstraint(command.action, 'TEMPLATE_ACTION', constraints,
          this.constraintTargets(command.action, command.payload, elements));
        if (blocked) {
          commandResults.push({ index, action: command.action, status: 'BLOCKED_BY_CONSTRAINT',
            scope: this.resultScope(command.action, command.payload), affectedElementIds: [],
            affectedCount: 0, constraint: blocked.type });
          continue;
        }
        const ctx: CommandContext = { actor: 'TEMPLATE_ACTION',
          settings: { ...settingsBefore, ...style }, settingsPatch: {} };
        const next = normalizeVideoTrack(
          this.applyElementCommand(command.action, command.payload, elements, assetMap, ctx));
        this.validateTimeline(next, assetMap);
        const described = describeChanges(elements, next);
        elements = next;
        style = { ...style, ...ctx.settingsPatch } as typeof style;
        commandResults.push({ index, action: command.action, status: 'DONE',
          scope: this.resultScope(command.action, command.payload),
          affectedElementIds: described.affectedElementIds,
          affectedCount: described.affectedElementIds.length });
        if (command.facet !== 'PROJECT') touched.set(command.elementId, command.facet);
      }

      // APPLY_CAPTION_STYLE_TO_ALL restyles the whole track from one reference
      // caption, so every caption is marked owned, not just that reference.
      const captionsTouched = [...touched.values()].includes('CAPTIONS');
      elements = elements.map((element) => {
        const facet = touched.get(element.id) ??
          (captionsTouched && element.type === 'SUBTITLE' ? 'CAPTIONS' : undefined);
        if (!facet) return element;
        const properties = element.properties as Record<string, unknown>;
        // A TEXT element keeps its ROLE (HOOK / CTA) as its templateRole. Stamping
        // the facet name 'TEXT' erased what the element is: the next template's
        // templateTextRole() read 'TEXT', stopped treating the hook as a hook and
        // silently skipped restyling it (found by Workstream G - the AI chat also
        // lost "the hook" after any template apply).
        const textRole = [properties.templateRole, properties.presetRole]
          .find((role) => role === 'HOOK' || role === 'CTA');
        return { ...element, properties: {
          ...properties,
          templateId: bundle.templateId,
          templateRunId: bundle.templateRunId,
          templateRole: facet === 'TEXT' && textRole ? textRole : facet
        } as Prisma.InputJsonValue };
      });

      await this.replaceElements(tx, id, elements);
      const templateRun = {
        templateId: bundle.templateId, templateName: bundle.templateName,
        templateRunId: bundle.templateRunId, source: bundle.source,
        appliedAtRevision: revision, imprints: bundle.imprints
      };
      const settingsAfter = { ...settingsBefore, ...style, templateRun,
        templateDefaults: bundle.defaults } as Prisma.InputJsonValue;
      await tx.editProject.update({ where: { id }, data: { revision, settings: settingsAfter } });
      await tx.editHistory.create({ data: { editProjectId: id, revision, actor: 'TEMPLATE',
        action: 'APPLY_TEMPLATE',
        command: { templateId: bundle.templateId, templateName: bundle.templateName,
          templateRunId: bundle.templateRunId, source: bundle.source,
          commandCount: bundle.commands.length, summary: bundle.summary,
          blocked: commandResults.filter((result) => result.status !== 'DONE')
            .map((result) => ({ action: result.action, constraint: result.constraint ?? null })) },
        beforeState: { elements: serialize(before),
          settings: settingsBefore as Prisma.InputJsonValue },
        afterState: { elements: serialize(elements), settings: settingsAfter } } });
      const project = await tx.editProject.findUniqueOrThrow({ where: { id }, include: includeProject });
      return { ...project, commandResults };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  /**
   * Applies an AI chat proposal (or an agent tool batch) as ONE user-level action.
   *
   * This is deliberately the same shape as `applyPresetBundle`: every element
   * command is folded through `applyElementCommand` (or, for the three VIDEO
   * track operations, the same private mutators the manual editor uses), the
   * timeline is normalised and validated after every single step, and the whole
   * bundle commits in one transaction as exactly one EditHistory row - actor
   * ASSISTANT, action APPLY_ASSISTANT_EDIT. So one chat request is one undo.
   *
   * There is no second mutation path here: nothing in the chat layer can write
   * an EditElement, and a command the manual editor would reject is rejected
   * here too.
   *
   * Step 5 bundle semantics (deterministic, never silent):
   *   * every command gets exactly one result, in order: DONE,
   *     BLOCKED_BY_CONSTRAINT, UNSUPPORTED, INVALID, FAILED or SKIPPED;
   *   * a blocked command never runs; its later siblings still do;
   *   * `onInvalid: 'ABORT'` (default, the historic behaviour) aborts the whole
   *     transaction on the first INVALID/UNSUPPORTED command; `'CONTINUE'`
   *     records it and keeps going, and a later command that references a ref
   *     created by a failed/blocked command is SKIPPED;
   *   * everything that ran commits as ONE revision / ONE undo step; when
   *     nothing ran, no revision is consumed.
   */
  async applyAssistantBundle(id: string, revisionValue: unknown, bundle: {
    proposalId: string;
    summary: string;
    userMessage: string;
    commands: AssistantBundleCommand[];
    /** Ephemeral guardrails for this automated task; they are not persisted. */
    constraints?: EditConstraint[];
    /** Who is executing. Defaults to AI_ACTION. */
    actor?: EditCommandActor;
    onInvalid?: 'ABORT' | 'CONTINUE';
    /** Persisted alongside the edit so the thread and the timeline stay in step. */
    chat?: Prisma.InputJsonValue;
  }) {
    const expectedRevision = parseRevision(revisionValue);
    if (!bundle.commands.length) {
      throw new BadRequestException({ code: 'EMPTY_PLAN', message: 'There is nothing to apply' });
    }
    const actor = readEditCommandActor(bundle.actor, 'AI_ACTION');
    const taskConstraints = readEditConstraints(bundle.constraints ?? [], 'TASK');
    const continueOnInvalid = bundle.onInvalid === 'CONTINUE';
    // Command expansion, validation, normalization, diffing and history JSON
    // construction are deliberately OUTSIDE Prisma's interactive transaction.
    // Caption-heavy generation bundles used to repeat whole-timeline work here
    // while holding the transaction open, regularly consuming Prisma's 5s
    // budget before editHistory.create could run.
    const planningStarted = performance.now();
    const current = await this.prisma.editProject.findUnique({ where: { id }, include: { elements: true,
      assets: { select: { id: true, role: true, duration: true, width: true, height: true,
        transcript: true } } } });
    if (!current) throw new NotFoundException('EditProject not found');
    this.assertRevision(current.revision, expectedRevision);
    const before = current.elements.map((element) =>
      timelineElementState(element as unknown as Record<string, unknown>));
    const assetMap = new Map(current.assets.map((asset) => [asset.id, asset]));
    const revision = current.revision + 1;
    const settingsBefore = settingsRecord(current.settings);
    const constraints = [...readProjectConstraints(settingsBefore), ...taskConstraints];

    let elements = before.map((element) => ({ ...element }));
    let style = readEditProjectStyle(settingsBefore) as Record<string, unknown>;
    let settingsPatch: Record<string, unknown> = {};
    const refs = new Map<string, string>();
    const deadRefs = new Set<string>();
    const affected = new Set<string>();
    const commandResults: EditCommandResult[] = [];
    let executedCount = 0;

    for (const [index, command] of bundle.commands.entries()) {
        const commandRef = command.kind === 'ELEMENT' ? command.ref : undefined;
        const record = (result: Omit<EditCommandResult, 'index' | 'action'>) => {
          commandResults.push({ index, action: command.action, ...result });
          if (result.status === 'BLOCKED_BY_CONSTRAINT') {
            this.logger.log(JSON.stringify({ event: 'edit_constraint_blocked', editProjectId: id,
              action: command.action, actor: bundle.actor ?? 'AI_ACTION' }));
          }
          if (result.status !== 'DONE' && commandRef) deadRefs.add(commandRef);
        };
        if (command.kind === 'SETTINGS') {
          const targets = elements.filter((item) => item.type === 'VIDEO');
          const blocked = blockingEditConstraint(command.action, actor, constraints, targets);
          if (blocked) {
            record({ status: 'BLOCKED_BY_CONSTRAINT', scope: 'PROJECT', affectedElementIds: [],
              affectedCount: 0, constraint: blocked.type,
              message: `${command.action} is protected for this task` });
            continue;
          }
          const changed = Object.keys(command.payload).filter((key) =>
            JSON.stringify(style[key]) !== JSON.stringify(command.payload[key]));
          style = { ...style, ...command.payload };
          executedCount += 1;
          record({ status: 'DONE', scope: 'PROJECT', affectedElementIds: [], affectedCount: 0,
            settingsChanged: changed, changes: changed.map((key) => ({ field: `settings.${key}`,
              before: settingsBefore[key], after: command.payload[key] })) });
          continue;
        }
        const payload: Record<string, unknown> = { ...command.payload };

        // A plan-local ref points at something an earlier command in this same
        // bundle created; it only has a real id once that command has run.
        if (typeof payload.ref === 'string') {
          const resolved = refs.get(payload.ref);
          if (!resolved) {
            if (continueOnInvalid && deadRefs.has(payload.ref)) {
              record({ status: 'SKIPPED', scope: 'SELECTED_ELEMENT', affectedElementIds: [],
                affectedCount: 0, code: 'DEPENDENCY_NOT_DONE',
                message: `Skipped: it depends on "${payload.ref}", which did not run` });
              continue;
            }
            throw new BadRequestException({ code: 'UNKNOWN_REF',
              message: `The plan references an element it never created ("${payload.ref}")` });
          }
          payload.elementId = resolved;
          delete payload.ref;
        }
        // A time-addressed target binds against the timeline as it stands at
        // this step, because an earlier split in the same bundle changes which
        // segment covers a given second. Its own key, `targetAtSec`: `atSec` is
        // a real SPLIT_CAPTION parameter and must reach the command untouched
        // (Workstream G found chat caption splits losing their split point).
        if (payload.targetAtSec !== undefined && !payload.elementId) {
          const atSec = Number(payload.targetAtSec);
          const hit = elements.filter((element) => element.type === 'VIDEO' && element.track === 0)
            .find((element) => atSec >= element.startTime - 1e-6 &&
              atSec < element.startTime + element.duration - 1e-6);
          if (!hit) {
            const error = new BadRequestException({ code: 'NO_ELEMENT_AT_TIME',
              message: `There is no video segment at ${atSec.toFixed(2)}s` });
            if (!continueOnInvalid) throw error;
            record({ status: 'INVALID', scope: 'CURRENT_VIDEO_SEGMENT', affectedElementIds: [],
              affectedCount: 0, code: 'NO_ELEMENT_AT_TIME', message: errorMessage(error) });
            continue;
          }
          payload.elementId = hit.id;
        }
        delete payload.targetAtSec;

        const commandScope = this.resultScope(command.action, payload);
        const blocked = blockingEditConstraint(command.action, actor, constraints,
          this.constraintTargets(command.action, payload, elements));
        if (blocked) {
          record({ status: 'BLOCKED_BY_CONSTRAINT', scope: commandScope, affectedElementIds: [],
            affectedCount: 0, constraint: blocked.type,
            message: `${command.action} is protected for this task` });
          continue;
        }

        const creates = command.action.startsWith('ADD_');
        if (creates) {
          payload.origin = 'ASSISTANT';
          payload.createdAtRevision = revision;
        }
        const priorIds = new Set(elements.map((element) => element.id));
        const elementId = String(payload.elementId ?? '');
        const ctx: CommandContext = { actor, settings: { ...settingsBefore, ...style },
          settingsPatch: {} };
        let next: TimelineElement[];
        try {
          next = normalizeVideoTrack(
            command.action === 'SPLIT_ELEMENT'
              ? this.splitVideoTimeline(elements, elementId,
                this.finiteNumber(payload.playheadSec, 'playheadSec'))
              : command.action === 'DELETE_ELEMENT'
                ? this.deleteVideoTimeline(elements, elementId)
                : command.action === 'REORDER_ELEMENT'
                  ? this.reorderVideoTimeline(elements, elementId,
                    this.integer(payload.toPosition, 'toPosition'))
                  : this.applyElementCommand(command.action, payload, elements, assetMap, ctx));
          this.validateTimeline(next, assetMap);
        } catch (caught) {
          if (!continueOnInvalid) throw caught;
          record({ status: statusForError(caught), scope: commandScope, affectedElementIds: [],
            affectedCount: 0, code: errorCode(caught), message: errorMessage(caught) });
          continue;
        }
        const violation = rangeViolation(actor, constraints, elements, next);
        if (violation) {
          record({ status: 'BLOCKED_BY_CONSTRAINT', scope: commandScope, affectedElementIds: [],
            affectedCount: 0, constraint: violation.type,
            message: `${command.action} would change the timeline outside the allowed range` });
          continue;
        }
        const described = describeChanges(elements, next);
        const settingsChanged = Object.keys(ctx.settingsPatch).filter((key) =>
          JSON.stringify(style[key] ?? settingsBefore[key]) !== JSON.stringify(ctx.settingsPatch[key]));
        const settingsChanges = settingsChanged.map((key) => ({ field: `settings.${key}`,
          before: style[key] ?? settingsBefore[key], after: ctx.settingsPatch[key] }));
        elements = next;
        style = { ...style, ...ctx.settingsPatch };
        settingsPatch = { ...settingsPatch, ...ctx.settingsPatch };
        for (const changedId of described.affectedElementIds) affected.add(changedId);
        executedCount += 1;
        record({ status: 'DONE', scope: commandScope,
          affectedElementIds: described.affectedElementIds,
          affectedCount: described.affectedElementIds.length,
          changes: [...described.changes, ...settingsChanges], settingsChanged });
        if (creates && command.ref) {
          const created = elements.find((element) => !priorIds.has(element.id));
          if (created) refs.set(command.ref, created.id);
        }
    }

    const commandPlanningMs = Math.round(performance.now() - planningStarted);
    if (executedCount === 0) {
      return this.prisma.$transaction(async (tx) => {
        const locked = await tx.editProject.findUnique({ where: { id }, select: { revision: true } });
        if (!locked) throw new NotFoundException('EditProject not found');
        this.assertRevision(locked.revision, expectedRevision);
        if (bundle.chat !== undefined) await tx.editProject.update({ where: { id },
          data: { settings: { ...settingsBefore, chat: bundle.chat } as Prisma.InputJsonValue } });
        const project = await tx.editProject.findUniqueOrThrow({ where: { id }, include: includeProject });
        return { project: serialize(project), affectedElementIds: [], affectedCount: 0,
          revision: current.revision, commandResults };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    }

    // Serialize both snapshots before opening the transaction. Large caption
    // arrays can make JSON conversion surprisingly expensive.
    const { chat: _liveChat, ...styleSettingsBefore } = settingsBefore;
    const styleSettingsAfter = { ...styleSettingsBefore, ...style, ...settingsPatch };
    const settingsAfter = { ...styleSettingsAfter,
      ...(bundle.chat === undefined ? (settingsBefore.chat === undefined
        ? {} : { chat: settingsBefore.chat }) : { chat: bundle.chat }) } as Prisma.InputJsonValue;
    const beforeState = { elements: serialize(before),
      settings: styleSettingsBefore as Prisma.InputJsonValue };
    const afterState = { elements: serialize(elements),
      settings: styleSettingsAfter as Prisma.InputJsonValue };
    const historyCommand = { proposalId: bundle.proposalId, summary: bundle.summary,
      userMessage: bundle.userMessage.slice(0, 500), commandCount: bundle.commands.length,
      executionActor: actor,
      results: commandResults.map((result) => ({ index: result.index, action: result.action,
        status: result.status, ...(result.constraint ? { constraint: result.constraint } : {}) }))
    } as Prisma.InputJsonValue;
    const mutationStarted = performance.now();
    let historyWriteMs = 0;
    await this.prisma.$transaction(async (tx) => {
      // The conditional revision update is the lock and stale-write check. It
      // occurs before replacing elements, so a concurrent editor can never be
      // partially overwritten by a plan prepared from an older snapshot.
      const claimed = await tx.editProject.updateMany({ where: { id, revision: expectedRevision },
        data: { revision, settings: settingsAfter } });
      if (claimed.count !== 1) {
        const exists = await tx.editProject.findUnique({ where: { id }, select: { revision: true } });
        if (!exists) throw new NotFoundException('EditProject not found');
        this.assertRevision(exists.revision, expectedRevision);
        throw new ConflictException({ code: 'STALE_REVISION', message: 'EditProject revision is stale' });
      }
      await this.replaceElements(tx, id, elements);
      // Provenance: automation driven by a template/style is recorded as TEMPLATE,
      // AI planning as ASSISTANT. Both are one undoable step.
      const historyStarted = performance.now();
      await tx.editHistory.create({ data: { editProjectId: id, revision,
        actor: actor === 'TEMPLATE_ACTION' ? 'TEMPLATE' : 'ASSISTANT',
        action: 'APPLY_ASSISTANT_EDIT',
        command: historyCommand, beforeState, afterState } });
      historyWriteMs = Math.round(performance.now() - historyStarted);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    const canonicalMutationMs = Math.round(performance.now() - mutationStarted);
    // A full project read includes every caption, asset and history entry. It is
    // deliberately outside the interactive transaction: the revision claim,
    // element replacement and one history row above are the complete atomic
    // mutation, while this read only shapes the response.
    const project = await this.prisma.editProject.findUniqueOrThrow({
      where: { id }, include: includeProject });
    for (const result of commandResults) if (result.status === 'DONE') result.revision = revision;
    const live = [...affected].filter((elementId) =>
      elements.some((element) => element.id === elementId));
    this.logger.log(JSON.stringify({ event: 'assistant_bundle_applied', editProjectId: id,
      commandCount: bundle.commands.length, elementCount: elements.length,
      captionCount: elements.filter((element) => element.type === 'SUBTITLE').length,
      revisionBefore: expectedRevision, revisionAfter: revision, commandPlanningMs,
      canonicalMutationMs, historyWriteMs }));
    return { project: serialize(project), affectedElementIds: live, affectedCount: live.length,
      revision, commandResults };
  }

  /** Persists only the chat thread. Used for turns that change no timeline
   * state - a question, a cancellation - so they never consume a revision. */
  async saveChatThread(id: string, chat: Prisma.InputJsonValue) {
    const current = await this.prisma.editProject.findUnique({
      where: { id }, select: { settings: true } });
    if (!current) throw new NotFoundException('EditProject not found');
    const settings = current.settings && typeof current.settings === 'object' &&
      !Array.isArray(current.settings) ? current.settings as Record<string, unknown> : {};
    await this.prisma.editProject.update({ where: { id },
      data: { settings: { ...settings, chat } as Prisma.InputJsonValue } });
  }

  /**
   * What undo and redo would do right now, without doing it.
   *
   * The AI chat editor asks this before offering "undo that", so a turn that
   * cannot be honoured becomes a question instead of a proposal that would
   * fail on Apply. It folds the history exactly as `historyMutation` does -
   * deliberately the same walk, so the answer and the action cannot disagree.
   */
  async historyAvailability(id: string) {
    const history = await this.prisma.editHistory.findMany({
      where: { editProjectId: id }, orderBy: { revision: 'asc' },
      select: { id: true, action: true, command: true } });
    const byId = new Map(history.map((entry) => [entry.id, entry]));
    const active: string[] = [];
    let redo: string[] = [];
    for (const entry of history) {
      if (MANUAL_ACTIONS.has(entry.action)) { active.push(entry.id); redo = []; }
      else if (entry.action === 'UNDO' || entry.action === 'REDO') {
        const target = (entry.command as Record<string, unknown> | null)?.targetHistoryId;
        if (typeof target !== 'string') continue;
        if (entry.action === 'UNDO') {
          const index = active.lastIndexOf(target);
          if (index >= 0) active.splice(index, 1);
          redo.push(target);
        } else {
          active.push(target);
          const index = redo.lastIndexOf(target);
          if (index >= 0) redo.splice(index, 1);
        }
      }
    }
    const undoTarget = active.at(-1);
    const redoTarget = redo.at(-1);
    return {
      canUndo: !!undoTarget, canRedo: !!redoTarget,
      undoAction: undoTarget ? byId.get(undoTarget)?.action ?? null : null,
      redoAction: redoTarget ? byId.get(redoTarget)?.action ?? null : null
    };
  }

  async undo(id: string, revisionValue: unknown) {
    return this.historyMutation(id, revisionValue, 'UNDO');
  }

  async redo(id: string, revisionValue: unknown) {
    return this.historyMutation(id, revisionValue, 'REDO');
  }

  /**
   * One direct command as one revision. Persistent PROJECT locks are enforced
   * here (task-only AI constraints never bind a manual edit); a command that
   * also changes project settings commits them in the SAME revision and the
   * SAME history row; and the response carries a structured `commandResult`.
   */
  private async manualMutation(id: string, revisionValue: unknown, action: string,
    command: Prisma.InputJsonObject, mutate: (elements: TimelineElement[],
      assets: Map<string, CommandAsset>, ctx: CommandContext) => TimelineElement[]) {
    const expectedRevision = parseRevision(revisionValue);
    const planningStarted = Date.now();
    // Loading, command execution, validation, diffing and JSON serialization can
    // be expensive for caption-heavy projects. None of that needs a database
    // lock, so prepare the complete deterministic mutation before opening the
    // interactive transaction.
    const current = await this.prisma.editProject.findUnique({ where: { id }, include: {
      elements: true, assets: { select: { id: true, role: true, duration: true, width: true,
        height: true, transcript: true } }
    } });
    if (!current) throw new NotFoundException('EditProject not found');
    this.assertRevision(current.revision, expectedRevision);
    const before = current.elements.map((element) => timelineElementState(
      element as unknown as Record<string, unknown>));
    const assetMap = new Map(current.assets.map((asset) => [asset.id, asset]));
    const settingsBefore = settingsRecord(current.settings);
    const payload = command as Record<string, unknown>;
    const constraints = readProjectConstraints(settingsBefore);
    const blocked = blockingEditConstraint(action, 'MANUAL_USER_ACTION', constraints,
      this.constraintTargets(action, payload, before));
    if (blocked) throw this.blockedError(blocked, action);
    const ctx = manualContext(settingsBefore);
    const after = normalizeVideoTrack(mutate(before.map((element) => ({ ...element })), assetMap, ctx));
    const violation = rangeViolation('MANUAL_USER_ACTION', constraints, before, after);
    if (violation) throw this.blockedError(violation, action);
    this.validateTimeline(after, assetMap);
    const revision = current.revision + 1;
    const settingsChanged = Object.keys(ctx.settingsPatch).filter((key) =>
      JSON.stringify(settingsBefore[key]) !== JSON.stringify(ctx.settingsPatch[key]));
    const { chat: _chat, ...historySettingsBefore } = settingsBefore;
    const settingsAfter = settingsChanged.length ? { ...settingsBefore, ...ctx.settingsPatch } : null;
    const { chat: _chatAfter, ...historySettingsAfter } = settingsAfter ?? {};
    const described = describeChanges(before, after);
    const commandResult: EditCommandResult = { index: 0, action, status: 'DONE',
      scope: this.resultScope(action, payload), affectedElementIds: described.affectedElementIds,
      affectedCount: described.affectedElementIds.length, revision,
      changes: [...described.changes, ...settingsChanged.map((key) => ({
        field: `settings.${key}`, before: settingsBefore[key], after: ctx.settingsPatch[key] }))],
      settingsChanged };
    const beforeState = { elements: serialize(before),
      ...(settingsAfter ? { settings: historySettingsBefore as Prisma.InputJsonValue } : {}) };
    const afterState = { elements: serialize(after),
      ...(settingsAfter ? { settings: historySettingsAfter as Prisma.InputJsonValue } : {}) };
    const commandPlanningMs = Date.now() - planningStarted;
    const mutationStarted = Date.now();
    let historyWriteMs = 0;
    await this.prisma.$transaction(async (tx) => {
      // updateMany is the compare-and-swap revision guard. If another writer won
      // while this command was being planned, the entire transaction aborts.
      const guarded = await tx.editProject.updateMany({ where: { id, revision: expectedRevision },
        data: { revision, ...(settingsAfter
          ? { settings: settingsAfter as Prisma.InputJsonValue } : {}) } });
      if (guarded.count !== 1) throw new ConflictException({ code: 'STALE_REVISION',
        message: 'EditProject revision is stale' });
      await this.replaceElements(tx, id, after);
      const historyStarted = Date.now();
      await tx.editHistory.create({ data: { editProjectId: id, revision, actor: 'USER', action,
        command, beforeState, afterState } });
      historyWriteMs = Date.now() - historyStarted;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    const canonicalMutationMs = Date.now() - mutationStarted;
    this.logger.log(JSON.stringify({ event: 'manual_edit_applied', route: 'POST /edit-mode/projects/:id/commands',
      projectId: id, assetId: null, errorType: null, action, commandCount: 1,
      elementCount: after.length, captionCount: after.filter((item) => item.type === 'SUBTITLE').length,
      revisionBefore: current.revision, revisionAfter: revision, commandPlanningMs,
      canonicalMutationMs, historyWriteMs }));
    const project = await this.prisma.editProject.findUniqueOrThrow({ where: { id },
      include: includeProject });
    return { ...serialize(project), commandResult };
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
      // The AI chat thread lives in settings but is not part of any edit, so a
      // settings restore keeps the live conversation rather than rewinding it.
      const liveChat = (current.settings && typeof current.settings === 'object' &&
        !Array.isArray(current.settings)
        ? (current.settings as Record<string, unknown>).chat : undefined);
      const restoredSettings = restoresSettings
        ? { ...(state.settings as Record<string, unknown>),
          ...(liveChat === undefined ? {} : { chat: liveChat }) } as Prisma.InputJsonValue
        : undefined;
      await tx.editProject.update({ where: { id }, data: { revision,
        ...(restoredSettings ? { settings: restoredSettings } : {}) } });
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

  private validateTimeline(elements: TimelineElement[], assets: Map<string, CommandAsset>) {
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
          message: 'VIDEO source range is invalid or shorter than the safe minimum ' +
            `(trim ${trimStart}-${trimEnd}, source ${sourceDuration})` });
      }
      this.assertVideoTransform(element, trimStart, trimEnd);
    }
    // Capacity: counted once per validation, so every path that builds a
    // timeline - manual, preset and chat alike - is held to the same ceiling.
    const subtitles = elements.filter((item) => item.type === 'SUBTITLE').length;
    const overlays = elements.filter((item) => item.type !== 'VIDEO' &&
      item.type !== 'SUBTITLE').length;
    if (overlays > maxOverlayElements()) {
      throw new BadRequestException({ code: 'TOO_MANY_OVERLAYS',
        message: `This timeline already has the maximum of ${maxOverlayElements()} overlays. ` +
          'Remove one before adding another.' });
    }
    if (subtitles > maxSubtitleElements()) {
      throw new BadRequestException({ code: 'TOO_MANY_SUBTITLES',
        message: `This timeline already has the maximum of ${maxSubtitleElements()} caption ` +
          'lines. Turn captions off, or use a shorter source.' });
    }
    for (const element of elements.filter((item) => item.type !== 'VIDEO')) {
      if (!Number.isFinite(element.startTime) || element.startTime < 0 ||
        !Number.isFinite(element.duration) || element.duration <= 0 ||
        element.startTime + element.duration > projectDuration + 1e-6) {
        throw new BadRequestException({ code: 'TIMING_OUT_OF_RANGE',
          message: 'Overlay and audio timing must stay within the video timeline' });
      }
      if (element.type === 'EFFECT') {
        try { assertStoredZoom(element.properties); }
        catch (caught) { throw this.zoomError(caught); }
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
    const asset = await this.prisma.editAsset.findUnique({ where: { id: assetId },
      include: { sourceVideo: { select: { bucket: true, objectKey: true, sizeBytes: true,
        mimeType: true } } } });
    if (!asset) throw new NotFoundException('EditAsset not found');
    const shared = asset.storageOwnership === 'SHARED';
    if (shared && (!asset.sourceVideoId || !asset.sourceVideo)) {
      this.logger.error(JSON.stringify({ event: 'edit_asset_file_failed',
        route: 'GET /edit-mode/assets/:assetId/file', projectId: asset.editProjectId,
        assetId, errorType: 'SHARED_SOURCE_MISSING' }));
      throw new NotFoundException({ code: 'MEDIA_SOURCE_MISSING',
        message: 'The original shared video is no longer available' });
    }
    const location = shared
      ? { bucket: asset.sourceVideo!.bucket, objectKey: asset.sourceVideo!.objectKey }
      : editAssetStorageLocation(asset);
    const size = Number(shared ? asset.sourceVideo!.sizeBytes : asset.sizeBytes);
    const mimeType = shared ? asset.sourceVideo!.mimeType : asset.mimeType;
    let range: { start: number; end: number } | null;
    try { range = resolveMediaByteRange(rangeHeader, size); }
    catch (caught) {
      this.logger.warn(JSON.stringify({ event: 'edit_asset_file_failed',
        route: 'GET /edit-mode/assets/:assetId/file', projectId: asset.editProjectId,
        assetId, errorType: caught instanceof Error ? caught.name : 'INVALID_RANGE' }));
      throw caught;
    }
    try {
      if (!range) return { stream: await this.storage.getObject(location.bucket, location.objectKey),
        size, start: 0, end: size - 1, partial: false, mimeType };
      return { stream: await this.storage.getPartialObject(location.bucket, location.objectKey,
        range.start, range.end - range.start + 1), size, ...range, partial: true, mimeType };
    } catch (caught) {
      this.logger.error(JSON.stringify({ event: 'edit_asset_file_failed',
        route: 'GET /edit-mode/assets/:assetId/file', projectId: asset.editProjectId,
        assetId, errorType: caught instanceof Error ? caught.name : 'STORAGE_ERROR' }));
      throw caught;
    }
  }
}
