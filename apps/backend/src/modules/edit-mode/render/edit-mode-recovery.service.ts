// EditMode Phase 7 startup recovery.
//
// An EditMode export runs in the backend process itself - no queue, no worker,
// no job row. That fits the laptop-hosted editor, but it has one
// consequence: if the process dies mid-render, the EditProject is left saying
// EXPORTING forever and the UI waits on progress that will never move again.
//
// This runs once at boot, before any new export can start, and settles every
// project left in that transient state. It is deliberately conservative:
//
//   - An export is only declared COMPLETED when a finished EXPORT asset exists
//     for it AND its object is really in storage. A status is never inferred
//     from the progress block alone, because the progress block is exactly the
//     thing the crash interrupted.
//   - Anything else becomes FAILED with a stated reason, which the export panel
//     shows and which a plain retry clears.
//   - Elements, revisions, history and previous exports are never touched. This
//     changes `status` and the `settings.export` progress block. Quick Reframe
//     exports also settle their usage reservation and workflow state.
//
// It touches only EditMode rows. Nothing here reads or writes Project, Video,
// ProcessingJob, ClipCandidate or GeneratedClip.

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../../storage/storage.service';
import type { EditExportProgress } from './edit-mode-render.types';
import { UsageService } from '../../auth/usage.service';

export type EditModeRecoveryOutcome = {
  editProjectId: string;
  exportId: string | null;
  status: 'COMPLETED' | 'READY' | 'FAILED';
  reason: string;
};

@Injectable()
export class EditModeRecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EditModeRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService
  ) {}

  async onApplicationBootstrap() {
    if ((process.env.EDIT_MODE_STARTUP_RECOVERY ?? 'true').toLowerCase() === 'false') return;
    try {
      const outcomes = await this.recoverInterruptedExports();
      if (outcomes.length) {
        this.logger.log(JSON.stringify({ event: 'edit_mode_startup_recovery',
          recovered: outcomes.length,
          byStatus: outcomes.reduce<Record<string, number>>((totals, outcome) => ({
            ...totals, [outcome.status]: (totals[outcome.status] ?? 0) + 1 }), {}) }));
      }
    } catch (error) {
      // Recovery must never stop the backend from starting.
      this.logger.warn(`EditMode startup recovery could not run: ${
        error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Settles every project left EXPORTING by a previous process.
   *
   * Exported (rather than private) so a verification script can call it
   * directly and assert the outcome without restarting a container.
   */
  async recoverInterruptedExports(): Promise<EditModeRecoveryOutcome[]> {
    const stranded = await this.prisma.editProject.findMany({
      where: { status: 'EXPORTING' },
      select: { id: true, revision: true, settings: true } });
    const outcomes: EditModeRecoveryOutcome[] = [];
    for (const project of stranded) {
      outcomes.push(await this.recoverOne(project));
    }
    return outcomes;
  }

  private async recoverOne(project: { id: string; revision: number; settings: Prisma.JsonValue }):
    Promise<EditModeRecoveryOutcome> {
    const settings = project.settings && typeof project.settings === 'object' &&
      !Array.isArray(project.settings) ? project.settings as Record<string, unknown> : {};
    const progress = settings.export && typeof settings.export === 'object' &&
      !Array.isArray(settings.export)
      ? settings.export as unknown as EditExportProgress : null;
    const exportId = progress?.exportId ?? null;

    // Did the interrupted run actually finish and persist its output? The
    // EXPORT asset is written last, so its existence means the render, the QA
    // and the upload all completed - but the object is still checked, because a
    // row without its object is not a deliverable export.
    const finished = exportId
      ? await this.prisma.editAsset.findFirst({
        where: { editProjectId: project.id, role: 'EXPORT' },
        orderBy: { createdAt: 'desc' } })
      : null;
    const metadata = finished?.metadata && typeof finished.metadata === 'object' &&
      !Array.isArray(finished.metadata) ? finished.metadata as Record<string, unknown> : {};
    const matches = !!finished && metadata.exportId === exportId;
    const verified = matches && await this.storage
      .statObject(finished!.bucket, finished!.objectKey).then(() => true).catch(() => false);

    if (verified) {
      const sourceRevision = Number(metadata.sourceRevision);
      const stale = !Number.isFinite(sourceRevision) || sourceRevision !== project.revision;
      const status = stale ? 'READY' as const : 'COMPLETED' as const;
      const reason = stale
        ? 'The export finished before the restart, but the timeline has moved on since, so it ' +
          'is kept as a previous export rather than the current result.'
        : 'The export finished before the restart and its file was verified in storage.';
      await this.settle(project.id, status, progress
        ? { ...progress, phase: 'COMPLETED', percent: 100, assetId: finished!.id,
          errorCode: null, message: reason, recoveredAt: new Date().toISOString() }
        : null);
      this.log(project.id, exportId, status, reason);
      return { editProjectId: project.id, exportId, status, reason };
    }

    const reason = matches
      ? 'The export was recorded but its file is missing from storage. Export again to produce ' +
        'a new one.'
      : 'The backend restarted while this export was running, so it did not finish. Nothing ' +
        'was changed in your timeline - press Export again.';
    await this.settle(project.id, 'FAILED', progress
      ? { ...progress, phase: 'FAILED', percent: 100, assetId: null,
        errorCode: 'INTERRUPTED', message: reason, recoveredAt: new Date().toISOString() }
      : { exportId: exportId ?? 'unknown', phase: 'FAILED', percent: 100,
        sourceRevision: project.revision, startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), attempt: 1, assetId: null,
        errorCode: 'INTERRUPTED', message: reason,
        recoveredAt: new Date().toISOString() } as unknown as EditExportProgress);
    this.log(project.id, exportId, 'FAILED', reason);
    return { editProjectId: project.id, exportId, status: 'FAILED', reason };
  }

  /**
   * Writes the settled status and progress block.
   *
   * Like the export itself, this never bumps `revision` and never writes an
   * EditHistory row: recovering an export is not an edit, so it must not appear
   * in undo/redo or invalidate a client's revision.
   */
  private async settle(id: string, status: 'COMPLETED' | 'READY' | 'FAILED',
    progress: EditExportProgress | null) {
    const current = await this.prisma.editProject.findUnique({ where: { id },
      select: { settings: true } });
    if (!current) return;
    const settings = current.settings && typeof current.settings === 'object' &&
      !Array.isArray(current.settings) ? current.settings as Record<string, unknown> : {};
    await this.prisma.editProject.update({ where: { id }, data: { status,
      ...(progress ? { settings: { ...settings, export: progress } as Prisma.InputJsonValue }
        : {}) } });
    if (progress?.exportId) {
      const quickReframe = await this.prisma.quickReframe.findUnique({ where: { editProjectId: id } });
      if (quickReframe?.operationId === progress.exportId) {
        await this.prisma.$transaction(async tx => {
          await new UsageService(this.prisma).settleInTransaction(tx, `reframe:${progress.exportId}`, status !== 'FAILED');
          await tx.quickReframe.update({ where: { id: quickReframe.id }, data: {
            status: status === 'FAILED' ? 'FAILED' : 'COMPLETE', operationId: null,
            error: status === 'FAILED' ? 'Export interrupted by restart. Please try again.' : null
          } });
        });
      }
    }
  }

  private log(editProjectId: string, exportId: string | null, status: string, reason: string) {
    this.logger.log(JSON.stringify({ event: 'edit_mode_export_recovered', editProjectId,
      exportId, status, reason }));
  }
}
