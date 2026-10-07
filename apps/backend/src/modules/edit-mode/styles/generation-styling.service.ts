// Step 9-10/14: applying the requested style to every delivered clip - in the
// editor, canonically.
//
//   GeneratedClip (clean cut) -> materialized EditProject (Step 2/3 bridge,
//   original-source-backed) -> ONE TEMPLATE revision of canonical commands
//   (compiled from the resolved style) -> the EditMode renderer -> EXPORT asset
//
// So the clip a user previews after generation IS the project they open in the
// editor: there is no separate "generated version" and "editable version".
// Status lives on the project (settings.generationStyle) so a reload, or a
// restart mid-way, can see exactly where each clip is and resume.

import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { EditModeService } from '../edit-mode.service';
import { EditChatService } from '../chat/edit-chat.service';
import { GeneratedClipEditProjectMaterializerService } from '../generated-clip-edit-project-materializer.service';
import { EditModeRenderService } from '../render/edit-mode-render.service';
import { compileCreativeStyle, type HookOption } from './creative-style-commands';
import type { ResolvedCreativeStyle } from './creative-style-resolver';
import { readGenerationSettings } from '../../videos/clip-selection.service';
import { processingTypeForOutputStyle } from '../../processing/clip-selection-policy';
import type { CreativePackage } from '../../content-intelligence/creative-package.service';

export type GenerationStyleStatus = 'BASE_READY' | 'STYLE_APPLYING' | 'STYLE_READY' | 'STYLE_FAILED' |
  'EXPORT_READY' | 'SKIPPED' | 'STYLING' | 'RENDERING' | 'READY' | 'FAILED';
export type GenerationStyleState = {
  status: GenerationStyleStatus; styleHash: string; startedAt: string; updatedAt: string;
  templateId?: string | null;
  lines: string[]; skipped: string[]; exportAssetId: string | null; revision: number | null;
  error: string | null;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const STALE_MS = 20 * 60 * 1000;
const IN_PROGRESS: GenerationStyleStatus[] = ['STYLE_APPLYING', 'STYLE_READY', 'STYLING', 'RENDERING'];
const SETTLED: GenerationStyleStatus[] = ['EXPORT_READY', 'READY', 'STYLE_FAILED', 'FAILED', 'SKIPPED'];
/** Clips styled side by side (separate projects, separate exports). */
const STYLE_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.GENERATION_STYLE_CONCURRENCY) || 2));
/** How often, and how far back, delivered-but-unstyled requests are picked up again. */
const SWEEP_MS = 60_000;
const SWEEP_WINDOW_MS = 12 * 60 * 60 * 1000;

export const readGenerationStyle = (settings: unknown): GenerationStyleState | null => {
  const value = record(record(settings).generationStyle);
  return typeof value.status === 'string' ? value as unknown as GenerationStyleState : null;
};

@Injectable()
export class GenerationStylingService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(GenerationStylingService.name);
  private readonly running = new Set<string>();
  /** Clips THIS process is styling. Anything else marked in progress was orphaned by a restart. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly prisma: PrismaService,
    private readonly materializer: GeneratedClipEditProjectMaterializerService,
    private readonly editMode: EditModeService,
    private readonly chat: EditChatService,
    private readonly render: EditModeRenderService) {}

  /**
   * A restart kills in-flight styling (it runs in this process), leaving clips
   * marked STYLING/RENDERING that nothing owns. Resume those videos on boot.
   */
  async onApplicationBootstrap() {
    if (process.env.GENERATION_STYLING_RECOVERY === 'false') return;
    // Also catches requests whose styling never started (a restart between delivery and the
    // first style write left nothing marked in progress, so the card waited forever).
    this.sweep = setInterval(() => void this.resumeUnstyled(), SWEEP_MS);
    this.sweep.unref?.();
    void this.resumeUnstyled();
    try {
      const orphaned = await this.prisma.editProject.findMany({ where: { generatedClipId: { not: null },
        OR: IN_PROGRESS.map((status) => ({ settings: { path: ['generationStyle', 'status'], equals: status } })) },
      select: { id: true, generatedClip: { select: { videoId: true } } } });
      const videoIds = [...new Set(orphaned.map((row) => row.generatedClip?.videoId).filter((id): id is string => !!id))];
      for (const videoId of videoIds) {
        const result = await this.ensureStyled(videoId);
        this.logger.log(JSON.stringify({ event: 'generation_style_recovered', videoId,
          orphanedClips: orphaned.filter((row) => row.generatedClip?.videoId === videoId).length, ...result }));
      }
    } catch (error) {
      this.logger.warn(JSON.stringify({ event: 'generation_style_recovery_failed',
        error: error instanceof Error ? error.message : String(error) }));
    }
  }

  private sweep?: NodeJS.Timeout;

  onModuleDestroy() { if (this.sweep) clearInterval(this.sweep); }

  /**
   * Recent styled requests whose delivered clips are not all settled (ready or failed) and that
   * no live run owns get `ensureStyled` again. Idempotent: finished clips return immediately.
   */
  async resumeUnstyled() {
    try {
      const jobs = await this.prisma.processingJob.findMany({ where: { clipRenderStatus: 'COMPLETED',
        generationSettings: { not: Prisma.DbNull }, updatedAt: { gt: new Date(Date.now() - SWEEP_WINDOW_MS) } },
      select: { id: true, videoId: true, generationSettings: true, selectedCandidateIds: true } });
      for (const job of jobs) {
        if (this.running.has(job.videoId) || !readGenerationSettings(job.generationSettings)?.resolved.styled) continue;
        const clips = await this.prisma.generatedClip.findMany({ where: { videoId: job.videoId,
          generationJobId: job.id, candidateId: { in: job.selectedCandidateIds } },
        select: { editProject: { select: { id: true, settings: true } } } });
        const waiting = clips.some((clip) => {
          const state = readGenerationStyle(clip.editProject?.settings);
          if (state && SETTLED.includes(state.status)) return false;
          return !clip.editProject || !this.inFlight.has(clip.editProject.id);
        });
        if (!waiting) continue;
        const result = await this.ensureStyled(job.videoId);
        if (result.started) this.logger.log(JSON.stringify({ event: 'generation_style_resumed',
          videoId: job.videoId, clips: clips.length }));
      }
    } catch (error) {
      this.logger.warn(JSON.stringify({ event: 'generation_style_sweep_failed',
        error: error instanceof Error ? error.message : String(error) }));
    }
  }

  /** Styles every delivered clip of the video's current request. Idempotent. */
  async ensureStyled(videoId: string) {
    if (this.running.has(videoId)) return { started: false, reason: 'ALREADY_RUNNING' };
    const job = await this.prisma.processingJob.findFirst({ where: { videoId },
      orderBy: { createdAt: 'desc' } });
    const settings = readGenerationSettings(job?.generationSettings);
    if (!job || !settings?.resolved.styled || job.clipRenderStatus !== 'COMPLETED') {
      return { started: false, reason: 'NOTHING_TO_STYLE' };
    }
    if (settings.requestedTemplate !== settings.effectiveTemplate)
      throw new Error('CONTRACT_VIOLATION: requested and effective templates differ');
    const video = await this.prisma.video.findUniqueOrThrow({ where: { id: videoId },
      select: { targetPlatform: true } });
    // Scoped by generationJobId + processingType + targetPlatform - the real, stable columns
    // that identify this request's output - rather than variantKey, a rendering-cache key whose
    // format has changed over time. `job.id` alone is not enough: it is one ProcessingJob row
    // reused across every clip-generation request for this video, so a same-template regenerate
    // can leave two rows for the same candidate; ordering newest-first and taking the first match
    // per candidate below always resolves to the current request's row.
    const clips = await this.prisma.generatedClip.findMany({ where: { videoId,
      candidateId: { in: job.selectedCandidateIds },
      generationJobId: job.id, processingType: processingTypeForOutputStyle(job.outputStyle ?? 'NORMAL'),
      targetPlatform: video.targetPlatform ?? null },
      orderBy: { createdAt: 'desc' },
    include: { candidate: true } });
    this.running.add(videoId);
    void (async () => {
      try {
        const ordered = job.selectedCandidateIds.map((id) => clips.find((clip) => clip.candidateId === id))
          .filter((clip): clip is NonNullable<typeof clip> => !!clip);
        // Older queued jobs only persisted templateId. A resumed job must stay
        // pinned to that request instead of silently falling back to a default.
        const requestedTemplate = settings.requestedTemplate ?? settings.templateId ?? 'AUTOMATIC_1';
        const effectiveTemplate = settings.effectiveTemplate ?? requestedTemplate;
        let styledCount = 0;
        let failedCount = 0;
        // Clips are independent projects with independent exports, so a small pool styles
        // them side by side instead of one after another.
        let next = 0;
        const styleNext = async (): Promise<void> => {
          const clip = ordered[next++];
          if (!clip) return;
          try {
            let state = await this.styleClip(clip, settings.resolved, effectiveTemplate);
            // One deterministic retry covers transient export failures without
            // changing the requested template or rebuilding intent from defaults.
            if (state.status === 'STYLE_FAILED' || state.status === 'FAILED')
              state = await this.styleClip(clip, settings.resolved, effectiveTemplate);
            if (state.status === 'EXPORT_READY' || state.status === 'READY') styledCount++;
            else failedCount++;
            this.logger.log(JSON.stringify({ event: 'generation_clip_summary', videoId,
              clipIndex: clip.requestedClipIndex, candidateId: clip.candidateId,
              templateId: effectiveTemplate, renderStatus: 'SUCCEEDED', styleStatus: state.status }));
          } catch (error) {
            failedCount++;
            this.logger.warn(JSON.stringify({ event: 'generation_style_clip_failed', generatedClipId: clip.id,
              clipIndex: clip.requestedClipIndex, candidateId: clip.candidateId,
              templateId: effectiveTemplate, renderStatus: 'SUCCEEDED', styleStatus: 'STYLE_FAILED',
              error: error instanceof Error ? error.message : String(error) }));
          }
          return styleNext();
        };
        await Promise.all(Array.from({ length: Math.min(STYLE_CONCURRENCY, ordered.length) }, () => styleNext()));
        const selection = record(record(job.telemetry).clipSelection);
        this.logger.log(JSON.stringify({ event: 'generation_summary', videoId,
          requestedTemplate, effectiveTemplate,
          candidatePoolCount: Number(selection.candidatePoolCount) || ordered.length,
          eligibleCandidateCount: Number(selection.eligibleCandidateCount) || ordered.length,
          requestedClipCount: job.requestedClipCount, selectedCandidateCount: ordered.length,
          renderRequestedCount: Number(selection.renderRequestedCount) || ordered.length,
          renderSucceededCount: Number(selection.renderSucceededCount) || ordered.length,
          renderFailedCount: Number(selection.renderFailedCount) || 0,
          styledCount, deliveredClipCount: styledCount,
          backfillAttempts: Number(selection.backfillAttempts) || 0,
          failedCandidateCount: (Number(selection.failedCandidateCount) || 0) + failedCount,
          deliveryStatus: failedCount > 0 ? 'FAILED' :
            styledCount === job.requestedClipCount ? 'COMPLETE' :
              styledCount > 0 ? 'PARTIAL' : 'FAILED',
          partialReason: failedCount === 0 && styledCount < (job.requestedClipCount ?? 0)
            ? 'INSUFFICIENT_DISTINCT_SOURCE_MOMENTS' : null,
          failureReason: failedCount > 0 ? 'STYLING_OR_EXPORT_FAILURES' : null,
          totalWallMs: job.clipRequestedAt ? Date.now() - job.clipRequestedAt.getTime() :
            Number(selection.totalWallMs) || null }));
      } finally { this.running.delete(videoId); }
    })();
    return { started: true, clips: clips.length };
  }

  /** One clip: materialize -> one canonical style revision -> canonical export. */
  async styleClip(clip: { id: string; candidate: { bestHook: string | null; hooks: unknown;
    hookCandidate: string | null } | null }, resolved: ResolvedCreativeStyle,
    templateId: string | null = null) {
    const styleHash = createHash('sha256').update(JSON.stringify({ templateId,
      components: resolved.components })).digest('hex').slice(0, 16);
    const { editProjectId } = await this.materializer.materialize(clip.id);
    const project = await this.prisma.editProject.findUniqueOrThrow({ where: { id: editProjectId } });
    const previous = readGenerationStyle(project.settings);
    // In progress only counts while a live process owns it; an orphan is redone.
    const owned = this.inFlight.has(editProjectId) && Date.now() - Date.parse(previous?.updatedAt ?? '') < STALE_MS;
    if (previous && previous.styleHash === styleHash &&
      (previous.status === 'EXPORT_READY' || previous.status === 'READY' || owned)) {
      return previous;
    }
    this.inFlight.add(editProjectId);
    try {
      return await this.styleOwned(clip, resolved, editProjectId, styleHash, previous, templateId);
    } finally { this.inFlight.delete(editProjectId); }
  }

  private async styleOwned(clip: Parameters<GenerationStylingService['styleClip']>[0],
    resolved: ResolvedCreativeStyle, editProjectId: string, styleHash: string,
    previous: GenerationStyleState | null, templateId: string | null) {
    let project = await this.prisma.editProject.findUniqueOrThrow({ where: { id: editProjectId } });
    const started = new Date().toISOString();
    const save = async (patch: Partial<GenerationStyleState>) => {
      const current = await this.prisma.editProject.findUniqueOrThrow({ where: { id: editProjectId } });
      const state = { ...(readGenerationStyle(current.settings) ?? { status: 'STYLE_APPLYING', styleHash,
        startedAt: started, lines: [], skipped: [], exportAssetId: null, revision: null, error: null }),
      ...patch, templateId, updatedAt: new Date().toISOString() };
      await this.prisma.editProject.update({ where: { id: editProjectId }, data: { settings: {
        ...record(current.settings), generationStyle: state } as Prisma.InputJsonValue } });
      return state as GenerationStyleState;
    };
    // Orphaned mid-render with nobody editing since: the style revision is already
    // applied, so only the export is redone (no second style revision / undo step).
    if ((['STYLE_READY', 'RENDERING', 'STYLE_FAILED'] as GenerationStyleStatus[]).includes(previous?.status as GenerationStyleStatus) &&
      previous?.styleHash === styleHash &&
      previous.revision != null && previous.revision === project.revision) {
      const exportStartedAt = Date.now();
      try {
        await save({ status: 'STYLE_READY', error: null });
        const exportId = await this.exportAndWait(editProjectId, project.revision);
        this.logger.log(JSON.stringify({ event: 'generation_style_clip_ready', generatedClipId: clip.id,
          editProjectId, templateId, revision: project.revision, resumed: true, styleResolveMs: 0,
          canonicalMutationMs: 0, exportMs: Date.now() - exportStartedAt, exportAssetId: exportId }));
        return save({ status: 'EXPORT_READY', exportAssetId: exportId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(JSON.stringify({ event: 'generation_style_failed', generatedClipId: clip.id,
          editProjectId, resumed: true, exportMs: Date.now() - exportStartedAt, error: message }));
        return save({ status: 'STYLE_FAILED', error: message.slice(0, 300) });
      }
    }
    await save({ status: 'STYLE_APPLYING', styleHash, startedAt: started, error: null, exportAssetId: null });
    try {
      const styleResolveStartedAt = Date.now();
      // Styling is applied once, on the untouched materialized project. If the
      // user has already edited the clip, their edits win: nothing is re-styled.
      const history = await this.prisma.editHistory.count({ where: { editProjectId,
        action: { notIn: ['PROJECT_CREATED', 'GENERATED_CLIP_MATERIALIZED'] } } });
      if ((previous?.status === 'EXPORT_READY' || previous?.status === 'READY') && history > 1) {
        return save({ status: 'SKIPPED', error: 'This clip was edited after styling; your edits were kept.' });
      }
      const { context } = await this.chat.loadContext(editProjectId, 'apply generation style', {});
      const stored = await this.prisma.generatedClip.findUnique({where:{id:clip.id},select:{contentPackaging:true}});
      const shared = record(stored?.contentPackaging).sharedPackage as CreativePackage | undefined;
      const hookOptions: HookOption[] = shared ? shared.hooks.map(h => ({text:h.text,style:h.category})) : [
        ...(Array.isArray(clip.candidate?.hooks) ? (clip.candidate!.hooks as Array<Record<string, unknown>>)
          .map((hook) => ({ text: String(hook.text ?? ''), style: String(hook.style ?? '') })) : []),
        ...(clip.candidate?.bestHook ? [{ text: clip.candidate.bestHook, style: null }] : []),
        ...(clip.candidate?.hookCandidate ? [{ text: clip.candidate.hookCandidate, style: null }] : [])
      ];
      const compiled = compileCreativeStyle(resolved, context, { hookOptions,
        supportingLine: shared?.supportingLine,
        hasWordTimings: context.project.hasWordTimings });
      const styleResolveMs = Date.now() - styleResolveStartedAt;
      project = await this.prisma.editProject.findUniqueOrThrow({ where: { id: editProjectId } });
      let revision = project.revision;
      const mutationStartedAt = Date.now();
      if (compiled.commands.length) {
        const applied = await this.editMode.applyAssistantBundle(editProjectId, project.revision, {
          proposalId: `generation-style-${styleHash}`, summary: 'Apply the generation style',
          userMessage: 'Generation style', commands: compiled.commands,
          actor: 'TEMPLATE_ACTION', onInvalid: 'CONTINUE' });
        revision = applied.revision;
        const rejected = applied.commandResults.filter((result) => result.status !== 'DONE');
        compiled.skipped.push(...rejected.map((result) => `${result.action}: ${result.message ?? result.status}`));
        if (rejected.length) {
          throw new Error(`CONTRACT_VIOLATION: ${rejected.length} template commands were rejected (${rejected.slice(0, 3)
            .map((result) => `${result.action}: ${result.message ?? result.status} ${JSON.stringify((result as { details?: unknown }).details ?? '')}`).join('; ')})`);
        }
      }
      const canonicalMutationMs = Date.now() - mutationStartedAt;
      await save({ status: 'STYLE_READY', lines: compiled.lines.slice(0, 40),
        skipped: compiled.skipped.slice(0, 20), revision });
      const exportStartedAt = Date.now();
      const exportId = await this.exportAndWait(editProjectId, revision);
      const exportMs = Date.now() - exportStartedAt;
      this.logger.log(JSON.stringify({ event: 'generation_style_clip_ready', generatedClipId: clip.id,
        editProjectId, templateId, revision, commandCount: compiled.commands.length,
        elementCount: context.elements.length,
        captionCount: context.elements.filter((element) => element.semantic === 'CAPTION').length,
        styleResolveMs, canonicalMutationMs, exportMs,
        skipped: compiled.skipped.length, exportAssetId: exportId }));
      return save({ status: 'EXPORT_READY', exportAssetId: exportId, revision });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(JSON.stringify({ event: 'generation_style_failed', generatedClipId: clip.id,
        editProjectId, error: message }));
      return save({ status: 'STYLE_FAILED', error: message.slice(0, 300) });
    }
  }

  /** Retry only styling/export for one materialized clip. Transcription and
   * candidate generation are intentionally untouched. */
  async retryClip(generatedClipId: string) {
    const clip = await this.prisma.generatedClip.findUnique({ where: { id: generatedClipId },
      include: { candidate: true } });
    if (!clip) throw new Error('Generated clip not found');
    const job = await this.prisma.processingJob.findFirst({ where: { videoId: clip.videoId },
      orderBy: { createdAt: 'desc' } });
    const settings = readGenerationSettings(job?.generationSettings);
    if (!settings?.resolved.styled) throw new Error('This clip has no generation style to retry');
    const requestedTemplate = settings.requestedTemplate ?? settings.templateId ?? 'AUTOMATIC_1';
    const effectiveTemplate = settings.effectiveTemplate ?? requestedTemplate;
    void this.styleClip(clip, settings.resolved, effectiveTemplate).catch((error) => this.logger.warn(JSON.stringify({
      event: 'generation_style_retry_failed', generatedClipId,
      error: error instanceof Error ? error.message : String(error) })));
    return { accepted: true, generatedClipId };
  }

  private async exportAndWait(editProjectId: string, revision: number) {
    const started = await this.render.startExport(editProjectId, revision);
    const exportId = started.export?.exportId;
    const deadline = Date.now() + 20 * 60 * 1000;
    let progress: Awaited<ReturnType<EditModeRenderService['progress']>> = started.export;
    while (progress && progress.phase !== 'COMPLETED' && progress.phase !== 'FAILED') {
      if (Date.now() > deadline) throw new Error('The styled render did not finish in time');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      progress = await this.render.progress(editProjectId);
    }
    if (!progress || progress.phase === 'FAILED') throw new Error(progress?.message ?? 'Styled render failed');
    const exports = await this.render.listExports(editProjectId) as Array<{ id?: unknown; current: boolean }>;
    const asset = exports.find((item) => item.current) ?? exports[0];
    if (!asset?.id) throw new Error(`Styled render ${exportId ?? ''} produced no export`);
    return String(asset.id);
  }
}
