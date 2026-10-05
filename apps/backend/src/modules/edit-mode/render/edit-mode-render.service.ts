// EditMode Phase 5 render orchestration.
//
// This is EditMode's OWN rendering path. It never calls the frozen processing
// queue, video processor, clip selector, clip render queue or clip exporter,
// never creates a processing job, clip candidate or generated clip row, and
// never enqueues background-queue work. It reuses the frozen editing
// intelligence only as pure functions (camera solver, shot classifier,
// information region, grade filter builder, ASS primitives, QA measurement).
//
// An export is deterministic from the canonical state: EditProject revision +
// EditElements + EditAssets + settings. No LLM call happens here.
//
//   load -> validate -> resolve assets -> plan -> pre-render validation ->
//   FFmpeg -> probe -> QA -> (local repair -> re-render, capped) -> upload ->
//   EditAsset(role: EXPORT)

import { BadRequestException, ConflictException, Injectable, Logger,
  NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { sampleImageStats, type ImageStats } from '../../editing/color-grade';
import { PrismaService } from '../../database/prisma.service';
import { editAssetStorageLocation } from '../edit-asset-storage';
import { probeMedia } from '../../processing/media-probe';
import { normalizeProbedSourceTrims } from './edit-mode-source-trim';
import { StorageService } from '../../storage/storage.service';
import { buildEditModeAss } from './edit-mode-ass';
import { buildFfmpegArgs } from './edit-mode-filtergraph';
import { runEditModeQa } from './edit-mode-qa';
import { buildRenderPlan, EditExportError, type PlanAsset,
  type PlanElement } from './edit-mode-render-plan';
import { validateRenderPlan } from './edit-mode-render-validate';
import type { EditExportErrorCode, EditExportProgress, EditExportResult, QaRepair,
  QaReport, RenderPlan, RenderRepairLog } from './edit-mode-render.types';

const execFileAsync = promisify(execFile);

/** A normal export gets one render plus at most one repair re-render. */
export const MAX_RENDER_ATTEMPTS = Math.min(3,
  Math.max(1, Number(process.env.EDIT_MODE_MAX_RENDER_ATTEMPTS) || 2));
const RENDER_TIMEOUT_MS = Number(process.env.EDIT_MODE_RENDER_TIMEOUT_MS) || 45 * 60 * 1000;

const PHASE_PERCENT = { PREPARING: 5, RENDERING: 25, QA: 75, UPLOADING: 90,
  COMPLETED: 100, FAILED: 100 } as const;

const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg',
  'image/webp': '.webp' };

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
export class EditModeRenderService {
  private readonly logger = new Logger(EditModeRenderService.name);
  /** One in-flight export per project. EditMode adds no queue infrastructure. */
  private readonly running = new Map<string, EditExportProgress>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService
  ) {}

  /**
   * Starts an export and returns immediately with its initial progress, so the
   * HTTP request never waits on an encode.
   */
  async startExport(id: string, revisionValue: unknown) {
    const revision = parseRevision(revisionValue);
    const project = await this.prisma.editProject.findUnique({
      where: { id }, include: { assets: true, elements: true } });
    if (!project) throw new NotFoundException('EditProject not found');
    if (project.revision !== revision) {
      throw new ConflictException({ code: 'STALE_REVISION',
        message: 'EditProject revision is stale', currentRevision: project.revision });
    }
    const active = this.running.get(id);
    if (active && active.phase !== 'COMPLETED' && active.phase !== 'FAILED') {
      throw new ConflictException({ code: 'EXPORT_ALREADY_RUNNING',
        message: 'An export is already running for this project.', progress: active });
    }
    if (!project.assets.some((asset) => asset.role === 'SOURCE')) {
      throw new BadRequestException({ code: 'SOURCE_MISSING',
        message: 'Attach a source video before exporting.' });
    }

    const now = new Date().toISOString();
    const progress: EditExportProgress = { exportId: randomUUID(), phase: 'PREPARING',
      percent: PHASE_PERCENT.PREPARING, sourceRevision: revision, startedAt: now,
      updatedAt: now, attempt: 1, assetId: null, errorCode: null, message: null };
    this.running.set(id, progress);
    await this.persistProgress(id, progress, 'EXPORTING');

    // Direct async execution: no background queue, no worker, no job row.
    void this.run(id, progress).catch((error) => {
      this.logger.error(`EditMode export ${progress.exportId} failed unexpectedly: ${
        error instanceof Error ? error.stack ?? error.message : String(error)}`);
    });
    return { export: progress, project: serialize(project) };
  }

  /** Live progress, falling back to the last persisted block after a restart. */
  async progress(id: string): Promise<EditExportProgress | null> {
    const active = this.running.get(id);
    if (active) return active;
    const project = await this.prisma.editProject.findUnique({ where: { id },
      select: { settings: true } });
    if (!project) throw new NotFoundException('EditProject not found');
    const settings = project.settings && typeof project.settings === 'object'
      ? project.settings as Record<string, unknown> : {};
    const stored = settings.export;
    return stored && typeof stored === 'object' ? stored as EditExportProgress : null;
  }

  /** Every export this project has produced, newest first. Exports accumulate:
   * a new one never overwrites the asset a previous revision produced. */
  async listExports(id: string) {
    const project = await this.prisma.editProject.findUnique({ where: { id },
      select: { id: true, revision: true } });
    if (!project) throw new NotFoundException('EditProject not found');
    const assets = await this.prisma.editAsset.findMany({
      where: { editProjectId: id, role: 'EXPORT' }, orderBy: { createdAt: 'desc' } });
    return serialize(assets.map((asset) => this.decorate(asset, project.revision)));
  }

  async getExport(id: string, assetId: string) {
    const project = await this.prisma.editProject.findUnique({ where: { id },
      select: { id: true, revision: true } });
    if (!project) throw new NotFoundException('EditProject not found');
    const asset = await this.prisma.editAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.editProjectId !== id || asset.role !== 'EXPORT') {
      throw new NotFoundException('Export not found');
    }
    return serialize(this.decorate(asset, project.revision));
  }

  /** An export is stale once the timeline has moved on from the revision it was
   * rendered from. The asset is kept; only its currency changes. */
  private decorate(asset: { metadata: Prisma.JsonValue } & Record<string, unknown>,
    currentRevision: number) {
    const metadata = asset.metadata && typeof asset.metadata === 'object'
      ? asset.metadata as Record<string, unknown> : {};
    const sourceRevision = Number(metadata.sourceRevision);
    return { ...asset, sourceRevision: Number.isFinite(sourceRevision) ? sourceRevision : null,
      current: Number.isFinite(sourceRevision) && sourceRevision === currentRevision };
  }

  // --- Execution ------------------------------------------------------------

  private async run(id: string, progress: EditExportProgress) {
    const directory = await mkdtemp(join(tmpdir(), 'edit-mode-export-'));
    const started = Date.now();
    try {
      const result = await this.render(id, progress, directory);
      await this.update(id, progress, { phase: 'COMPLETED', assetId: result.assetId });
      const wallMs = Date.now() - started;
      this.logger.log(`EditMode export ${progress.exportId} completed in ` +
        `${wallMs}ms (${result.qa.result}${result.stale ? ', stale' : ''})`);
      // Structured counters for Phase 7: durations, the render factor and the
      // QA outcome. Counts and category names only - no timeline content, no
      // transcript text, no user wording.
      this.logger.log(JSON.stringify({ event: 'edit_mode_export_completed',
        editProjectId: id, exportId: progress.exportId,
        wallMs, renderMs: result.renderMs,
        outputDurationSec: result.qa.measured.durationSec,
        renderFactor: (result.qa.measured.durationSec ?? 0) > 0
          ? Number((result.renderMs / 1000 / result.qa.measured.durationSec!).toFixed(3)) : null,
        attempts: result.attempts, rerenders: Math.max(0, result.attempts - 1),
        qaResult: result.qa.result, stale: result.stale,
        aspectRatio: result.qa.measured.width && result.qa.measured.height
          ? `${result.qa.measured.width}x${result.qa.measured.height}` : null }));
      return result;
    } catch (error) {
      const code: EditExportErrorCode = error instanceof EditExportError ? error.code
        : 'RENDER_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`EditMode export ${progress.exportId} failed (${code}): ${message}`);
      this.logger.log(JSON.stringify({ event: 'edit_mode_export_failed', editProjectId: id,
        exportId: progress.exportId, failureCategory: code,
        wallMs: Date.now() - started, attempt: progress.attempt }));
      await this.update(id, progress, { phase: 'FAILED', errorCode: code, message }, 'FAILED');
      return null;
    } finally {
      // The job directory is unique per export (mkdtemp) and is removed on
      // success and on every failure path alike, so a crashed render leaves no
      // multi-gigabyte intermediate behind for the next one to trip over.
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async render(id: string, progress: EditExportProgress,
    directory: string): Promise<EditExportResult> {
    const project = await this.prisma.editProject.findUnique({
      where: { id }, include: { assets: true, elements: true } });
    if (!project) throw new EditExportError('INVALID_TIMELINE', 'EditProject not found');
    const source = project.assets.find((asset) => asset.role === 'SOURCE');
    if (!source) throw new EditExportError('SOURCE_MISSING', 'No source is attached.');

    // --- Resolve media once and reuse it for every attempt ------------------
    const sourcePath = join(directory, 'source.mp4');
    const sourceLocation = editAssetStorageLocation(source);
    await this.download(sourceLocation.bucket, sourceLocation.objectKey, sourcePath, 'SOURCE_MISSING');
    const sourceProbe = await probeMedia(sourcePath).catch(() => {
      throw new EditExportError('UNSUPPORTED_MEDIA',
        'The source video could not be read as a valid media file.');
    });
    if (!sourceProbe.hasVideo) {
      throw new EditExportError('UNSUPPORTED_MEDIA', 'The source file has no video stream.');
    }

    const planAssets: PlanAsset[] = project.assets.map((asset) => ({
      id: asset.id, role: asset.role, mimeType: asset.mimeType,
      duration: asset.id === source.id && (sourceProbe.videoDurationSec ?? sourceProbe.durationSec) != null
        ? sourceProbe.videoDurationSec ?? sourceProbe.durationSec : asset.duration,
      width: asset.width, height: asset.height, fps: asset.fps, metadata: asset.metadata,
      transcript: asset.transcript, analysis: asset.analysis }));
    const rawPlanElements: PlanElement[] = project.elements.map((element) => ({
      id: element.id, assetId: element.assetId, type: element.type, track: element.track,
      position: element.position, startTime: element.startTime, duration: element.duration,
      trimStart: element.trimStart, trimEnd: element.trimEnd, properties: element.properties }));
    const normalizedSource = normalizeProbedSourceTrims(rawPlanElements, source.id,
      sourceProbe.videoDurationSec ?? sourceProbe.durationSec ?? Number.NaN);
    const planElements = normalizedSource.elements;
    if (normalizedSource.corrections.length) this.logger.warn(JSON.stringify({
      event: 'edit_mode_source_trim_clamped', editProjectId: id,
      probedDurationSec: sourceProbe.videoDurationSec ?? sourceProbe.durationSec,
      corrections: normalizedSource.corrections }));

    let imageStats: ImageStats | null = null;
    try { imageStats = await sampleImageStats(sourcePath); }
    catch { this.logger.warn('EditMode grading stats unavailable; using neutral source stats.'); }

    const overlayPaths: Record<string, string> = {};
    const audioPaths: Record<string, string> = {};
    const byId = new Map(project.assets.map((asset) => [asset.id, asset]));
    for (const element of project.elements) {
      if (!element.assetId || (element.type !== 'IMAGE' && element.type !== 'AUDIO')) continue;
      const asset = byId.get(element.assetId);
      if (!asset) {
        throw new EditExportError('ASSET_MISSING',
          'An element references an asset that is no longer in this project.',
          { elementId: element.id });
      }
      const target = element.type === 'IMAGE' ? overlayPaths : audioPaths;
      if (target[element.id]) continue;
      const extension = element.type === 'IMAGE'
        ? IMAGE_EXTENSIONS[asset.mimeType] ?? '.png' : '.bin';
      const path = join(directory, `asset-${element.id}${extension}`);
      const location = editAssetStorageLocation(asset);
      await this.download(location.bucket, location.objectKey, path, 'ASSET_MISSING');
      target[element.id] = path;
    }

    // --- Render, QA and at most one local repair ---------------------------
    const repairs: RenderRepairLog[] = [];
    const suppressedZoomIds: string[] = [];
    const zoomScaleCeilings: Record<string, number> = {};
    const widenShots: number[] = [];
    const informationFitShots: number[] = [];
    let attempt = 0;
    let plan: RenderPlan | null = null;
    let qa: QaReport | null = null;
    let outputPath = '';
    let cameraTelemetry: Record<string, unknown> | null = null;
    const renderStarted = Date.now();

    while (attempt < MAX_RENDER_ATTEMPTS) {
      attempt += 1;
      await this.update(id, progress, { phase: 'RENDERING', attempt });
      const built = buildRenderPlan({
        project: { id: project.id, revision: progress.sourceRevision, settings: project.settings },
        assets: planAssets, elements: planElements, imageStats,
        hasSourceAudio: sourceProbe.hasAudio,
        fps: Math.max(1, Math.round(sourceProbe.fps ?? 30)),
        suppressedZoomIds, zoomScaleCeilings, widenShots, informationFitShots
      });
      plan = built.plan;
      validateRenderPlan(plan, { assets: planAssets, sourceProbe });
      cameraTelemetry = {
        framesWithFaces: built.evidence.frames.filter((frame) => frame.faces.length > 0).length,
        sampledFrames: built.evidence.frames.length,
        speakerSwitchCount: built.evidence.speakerSwitchCount,
        speakerSegments: built.evidence.speakerSegments.slice(0, 40),
        faceSafetyViolations: built.evidence.faceSafetyViolations,
        cameraMoves: built.evidence.cameraMoves.length,
        punches: built.evidence.punches.slice(0, 30).map((punch) => ({ start: punch.startSec,
          end: punch.endSec, scale: punch.scale, framing: punch.framing })),
        shots: built.evidence.shots.slice(0, 40).map((shot) => ({ start: shot.start, end: shot.end,
          shotClass: shot.shotClass, layout: shot.layout, informationMode: shot.informationMode,
          zoomAllowed: shot.zoomAllowed, faceCount: shot.faceCount }))
      };

      const textOverlays = [...plan.textOverlays, ...plan.subtitles];
      const assFileName = textOverlays.length ? 'edit-mode.ass' : null;
      if (assFileName) {
        const ass = buildEditModeAss(plan.canvas, textOverlays);
        await writeFile(join(directory, assFileName), ass.content, 'utf8');
        for (const elementId of ass.overflowed) {
          plan.warnings.push(`Text element ${elementId} needed more lines than its box holds; ` +
            'it renders slightly outside the box you drew.');
        }
        // Where a browser CSS effect has no exact ASS equivalent the builder
        // chooses a documented closest match and says so, rather than letting
        // the export quietly differ from the preview.
        for (const note of ass.parityNotes) plan.warnings.push(note);
      }

      outputPath = join(directory, `export-${attempt}.mp4`);
      const args = buildFfmpegArgs({ plan, sourcePath, overlayPaths, audioPaths, assFileName,
        outputPath, informationCrop: built.evidence.informationCrop,
        fitExpression: built.evidence.fitExpression,
        informationFitExpression: built.evidence.informationFitExpression,
        cameraFilter: built.evidence.cameraFilter });
      try {
        await execFileAsync('ffmpeg', args, { cwd: directory, maxBuffer: 20 * 1024 * 1024,
          timeout: RENDER_TIMEOUT_MS });
      } catch (error) {
        const stderr = typeof (error as { stderr?: unknown })?.stderr === 'string'
          ? (error as { stderr: string }).stderr.slice(-600) : '';
        throw new EditExportError('RENDER_FAILED',
          `The export render failed. ${stderr || (error instanceof Error ? error.message : '')}`.trim());
      }

      await this.update(id, progress, { phase: 'QA' });
      qa = await runEditModeQa({ plan, evidence: built.evidence, outputPath });
      if (qa.result === 'PASS' || qa.result === 'DEGRADED_ACCEPTABLE') break;
      if (qa.result === 'REJECT' || !qa.repairs.length) {
        throw new EditExportError('QA_FAILED',
          `The exported file did not pass EditMode QA: ${qa.checks
            .filter((check) => check.result === 'REJECT' || check.result === 'REPAIR_REQUIRED')
            .map((check) => check.detail).join(' ')}`.slice(0, 600));
      }
      if (attempt >= MAX_RENDER_ATTEMPTS) {
        throw new EditExportError('QA_FAILED',
          'The export still failed EditMode QA after a repair pass: ' +
          qa.checks.filter((check) => check.result !== 'PASS')
            .map((check) => check.detail).join(' ').slice(0, 500));
      }
      // Apply only the named local repairs and re-render. Nothing is disabled
      // globally: one zoom, or one shot's crop, at a time.
      for (const repair of qa.repairs) {
        this.applyRepair(repair, { suppressedZoomIds, zoomScaleCeilings, widenShots,
          informationFitShots });
        repairs.push({ attempt, repair, reason: qa.checks
          .find((check) => check.repair === repair)?.detail ?? 'QA repair' });
      }
      this.logger.log(`EditMode export ${progress.exportId} re-rendering after ` +
        `${qa.repairs.length} local repair(s): ${qa.repairs.map((item) => item.kind).join(', ')}`);
    }
    if (!plan || !qa) throw new EditExportError('RENDER_FAILED', 'The export produced no output.');
    const renderMs = Date.now() - renderStarted;

    // --- Persist ------------------------------------------------------------
    await this.update(id, progress, { phase: 'UPLOADING' });
    const assetId = randomUUID();
    const objectKey = `edit-mode/${id}/exports/${assetId}/final.mp4`;
    const size = (await stat(outputPath)).size;
    let stored: { bucket: string; objectKey: string };
    try {
      stored = await this.storage.uploadFile({ filePath: outputPath, objectKey,
        mimeType: 'video/mp4' });
    } catch (error) {
      throw new EditExportError('UPLOAD_FAILED',
        `The finished export could not be stored: ${
          error instanceof Error ? error.message : String(error)}`);
    }

    const latest = await this.prisma.editProject.findUnique({ where: { id },
      select: { revision: true, status: true } });
    const stale = !!latest && latest.revision !== progress.sourceRevision;
    const metadata = {
      sourceRevision: progress.sourceRevision,
      exportId: progress.exportId,
      stale,
      preset: plan.presetId,
      aspectRatio: plan.canvas.aspectRatio,
      resolution: { width: qa.measured.width, height: qa.measured.height },
      durationSec: qa.measured.durationSec,
      codec: { video: qa.measured.videoCodec, audio: qa.measured.audioCodec },
      bitrate: qa.measured.bitrate,
      fileSizeBytes: size,
      renderDurationMs: renderMs,
      attempts: attempt,
      repairs: repairs.map((item) => ({ attempt: item.attempt, kind: item.repair.kind,
        reason: item.reason.slice(0, 240) })),
      qa: { result: qa.result, sampledFrameCount: qa.sampledFrameCount,
        checks: qa.checks.map((check) => ({ id: check.id, result: check.result,
          detail: check.detail.slice(0, 240) })), measured: qa.measured },
      policies: plan.policies,
      // Camera evidence of the rendered plan, so speaker switching and face safety are
      // checkable on the stored export rather than only in a dry-run harness.
      camera: cameraTelemetry,
      zoom: { rendered: plan.zoomEvents.length, rejected: plan.zoomRejections.length,
        reduced: plan.zoomEvents.filter((event) => event.reducedFromScale != null).length },
      grading: { policy: plan.grading.policy, preset: plan.grading.preset,
        strengthScale: plan.grading.strengthScale },
      segments: plan.videoSegments.length,
      overlays: plan.visualOverlays.length,
      textElements: plan.textOverlays.length,
      subtitles: plan.subtitles.length,
      subtitlesFromTranscript: plan.subtitlesFromTranscript,
      audioTracks: plan.audioTracks.length,
      warnings: plan.warnings.slice(0, 20)
    };

    // The export records its own provenance. It creates no history revision:
    // rendering is not an edit, so undo/redo is untouched by it.
    //
    // If the row cannot be written the object is removed again, so a failure
    // here leaves neither a dangling MinIO object nor a half-recorded export.
    // The project is then simply an export short, which a retry fixes.
    let asset: Awaited<ReturnType<typeof this.prisma.editAsset.create>>;
    try {
      asset = await this.prisma.editAsset.create({ data: {
        id: assetId, editProjectId: id, role: 'EXPORT',
        originalName: `${plan.presetId.toLowerCase()}-r${progress.sourceRevision}.mp4`,
        bucket: stored.bucket, objectKey: stored.objectKey, mimeType: 'video/mp4',
        sizeBytes: BigInt(size), duration: qa.measured.durationSec,
        width: qa.measured.width, height: qa.measured.height, fps: plan.canvas.fps,
        metadata: metadata as unknown as Prisma.InputJsonValue } });
    } catch (error) {
      await this.storage.removeObject(stored.bucket, stored.objectKey).catch(() => undefined);
      throw new EditExportError('UPLOAD_FAILED',
        `The finished export could not be recorded: ${
          error instanceof Error ? error.message : String(error)}`);
    }
    await this.prisma.editProject.update({ where: { id },
      // A stale export is retained but is not declared the project's result.
      data: { status: stale ? 'READY' : 'COMPLETED' } });

    return serialize({ exportId: progress.exportId, assetId: asset.id, editProjectId: id,
      sourceRevision: progress.sourceRevision, stale, qa, attempts: attempt, renderMs,
      metadata: metadata as unknown as Record<string, unknown> });
  }

  private applyRepair(repair: QaRepair, state: { suppressedZoomIds: string[];
    zoomScaleCeilings: Record<string, number>; widenShots: number[];
    informationFitShots: number[] }) {
    if (repair.kind === 'SUPPRESS_ZOOM') state.suppressedZoomIds.push(repair.zoomEventId);
    else if (repair.kind === 'REDUCE_ZOOM') state.zoomScaleCeilings[repair.zoomEventId] = repair.scale;
    else if (repair.kind === 'WIDEN_CROP') state.widenShots.push(repair.shotIndex);
    else state.informationFitShots.push(repair.shotIndex);
  }

  private async download(bucket: string, objectKey: string, path: string,
    code: EditExportErrorCode) {
    try {
      await this.storage.downloadToFile(bucket, objectKey, path);
    } catch (error) {
      throw new EditExportError(code, `A file this export needs is missing from storage: ${
        error instanceof Error ? error.message : String(error)}`, { objectKey });
    }
  }

  private async update(id: string, progress: EditExportProgress,
    patch: Partial<EditExportProgress>, status?: 'EXPORTING' | 'FAILED') {
    Object.assign(progress, patch, { updatedAt: new Date().toISOString() });
    if (patch.phase) progress.percent = PHASE_PERCENT[patch.phase];
    this.running.set(id, progress);
    await this.persistProgress(id, progress, status);
  }

  /**
   * Progress lives on `settings.export`, written directly and WITHOUT bumping
   * the revision or writing an EditHistory row - an export is not an edit, so it
   * must not appear in undo/redo or invalidate a client's revision.
   */
  private async persistProgress(id: string, progress: EditExportProgress,
    status?: 'EXPORTING' | 'FAILED') {
    try {
      const current = await this.prisma.editProject.findUnique({ where: { id },
        select: { settings: true } });
      if (!current) return;
      const settings = current.settings && typeof current.settings === 'object' &&
        !Array.isArray(current.settings) ? current.settings as Record<string, unknown> : {};
      await this.prisma.editProject.update({ where: { id },
        data: { settings: { ...settings, export: progress } as Prisma.InputJsonValue,
          ...(status ? { status } : {}) } });
    } catch (error) {
      this.logger.warn(`EditMode export progress could not be persisted: ${
        error instanceof Error ? error.message : String(error)}`);
    }
  }
}

