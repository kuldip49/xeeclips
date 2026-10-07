import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
type Tx = Prisma.TransactionClient;
export const USAGE_POLICY = { CREATE_CLIPS: 1, QUICK_REFRAME: 1 } as const;
@Injectable()
export class UsageService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private reconciling = false;
  private readonly logger = new Logger(UsageService.name);
  constructor(private readonly prisma: PrismaService) {}
  onModuleInit() { this.timer = setInterval(() => void this.reconcile().catch(() => this.logger.warn('credit_reconciliation_retry')), 15000); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  /** Repairs a crash between output commit and settlement. Never refunds a live job by age alone. */
  async reconcile() {
    if (this.reconciling) return; this.reconciling = true;
    try {
      const reservations = await this.prisma.creditReservation.findMany({ where: { status: 'RESERVED' }, take: 200, orderBy: { createdAt: 'asc' } });
      for (const r of reservations) {
        if (r.operation === 'CREATE_CLIPS') {
          if (r.resourceId.startsWith('import:')) {
            const imported = await this.prisma.videoImport.findUnique({ where: { id: r.resourceId.slice(7) } });
            if (!imported || ['IMPORT_FAILED', 'CANCELLED'].includes(imported.status)) await this.settle(r.jobKey, false);
            continue;
          }
          const job = await this.prisma.processingJob.findUnique({ where: { id: r.resourceId } });
          if (!job) { await this.settle(r.jobKey, false); continue; }
          const terminal = job.status === 'FAILED' || job.autoGenerationStatus === 'FAILED' || ['FAILED', 'COMPLETED'].includes(job.clipRenderStatus ?? '');
          if (!terminal) continue;
          const output = await this.prisma.generatedClip.count({ where: { generationJobId: job.id, sizeBytes: { gt: 0 }, createdAt: { gte: r.createdAt } } });
          await this.settle(r.jobKey, output > 0);
        } else {
          const q = await this.prisma.quickReframe.findUnique({ where: { id: r.resourceId } });
          const operationId = r.jobKey.slice('reframe:'.length);
          const output = await this.prisma.editAsset.count({ where: { role: 'EXPORT', editProject: { quickReframe: { id: r.resourceId } }, metadata: { path: ['operationId'], equals: operationId } } });
          if (output) await this.settle(r.jobKey, true);
          else if (!q || q.operationId !== operationId && ['FAILED', 'CANCELED', 'COMPLETE'].includes(q.status)) await this.settle(r.jobKey, false);
        }
      }
    } finally { this.reconciling = false; }
  }
  async reserve(tx: Tx, userId: string | null, jobKey: string, operation: keyof typeof USAGE_POLICY, resourceId: string) {
    if (!userId) throw new ForbiddenException('Legacy resources cannot start generation. Assign ownership first.');
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.status !== 'ACTIVE') throw new ForbiddenException('Your account is currently unavailable.');
    const existing = await tx.creditReservation.findUnique({ where: { jobKey } });
    if (existing) { if (existing.userId !== userId || existing.status !== 'RESERVED') throw new ConflictException('Generation request has already settled.'); return existing; }
    const amount = user.role === 'ADMIN' ? 0 : USAGE_POLICY[operation];
    const changed = await tx.user.updateMany({ where: { id: userId, status: 'ACTIVE', creditBalance: { gte: amount } }, data: { creditBalance: { decrement: amount } } });
    if (!changed.count) { this.logger.warn('generation_blocked_no_credits'); throw new ForbiddenException({ code: 'NO_CREDITS', message: 'No generations remaining.' }); }
    const reservation = await tx.creditReservation.create({ data: { userId, jobKey, operation, resourceId, amount } });
    await tx.creditTransaction.create({ data: { userId, amount: -amount, type: 'GENERATION_RESERVE', jobId: jobKey, reason: operation } });
    this.logger.log('credit_reserved'); return reservation;
  }
  async settle(jobKey: string, delivered: boolean) {
    await this.prisma.$transaction(tx => this.settleInTransaction(tx, jobKey, delivered));
  }
  async settleInTransaction(tx: Tx, jobKey: string, delivered: boolean) {
      const reservation = await tx.creditReservation.findUnique({ where: { jobKey } });
      if (!reservation) return;
      const changed = await tx.creditReservation.updateMany({ where: { id: reservation.id, status: 'RESERVED' }, data: { status: delivered ? 'CONSUMED' : 'REFUNDED' } });
      if (!changed.count) return;
      await tx.user.update({ where: { id: reservation.userId }, data: delivered ? { creditsConsumed: { increment: reservation.amount } } : { creditBalance: { increment: reservation.amount } } });
      await tx.creditTransaction.create({ data: { userId: reservation.userId, amount: delivered ? 0 : reservation.amount, type: delivered ? 'GENERATION_CONSUME' : 'GENERATION_REFUND', jobId: jobKey, reason: delivered ? 'Usable output delivered' : 'No usable output delivered' } });
      this.logger.log(delivered ? 'credit_consumed' : 'credit_refunded');
  }
  async adjust(adminId: string, userId: string, mode: unknown, amount: unknown, reason: unknown) {
    if (!['ADD', 'REMOVE', 'SET'].includes(String(mode)) || !Number.isSafeInteger(amount) || Number(amount) < 0 || Number(amount) > 1000000) throw new BadRequestException('Enter a valid credit amount.');
    return this.prisma.$transaction(async tx => {
      // Lock the account before reading: SET and concurrent generation/admin changes serialize.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      const admin = await tx.user.findUniqueOrThrow({ where: { id: adminId } });
      if (admin.role !== 'ADMIN' || admin.status !== 'ACTIVE') throw new ForbiddenException();
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      const delta = mode === 'SET' ? Number(amount) - user.creditBalance : mode === 'REMOVE' ? -Number(amount) : Number(amount);
      if (user.creditBalance + delta < 0 || user.creditBalance + delta > 1000000) throw new BadRequestException('Credit balance is out of range.');
      const updated = await tx.user.update({ where: { id: userId }, data: { creditBalance: { increment: delta } }, select: { id: true, creditBalance: true, creditsConsumed: true } });
      const note = typeof reason === 'string' ? reason.slice(0, 500) : '';
      await tx.creditTransaction.create({ data: { userId, adminId, amount: delta, type: mode === 'SET' ? 'MANUAL_ADJUSTMENT' : delta >= 0 ? 'ADMIN_GRANT' : 'ADMIN_DEDUCTION', reason: note || 'Owner adjustment' } });
      await tx.auditLog.create({ data: { adminId, targetUserId: userId, action: 'CREDIT_CHANGE', before: { balance: user.creditBalance }, after: { balance: updated.creditBalance }, reason: note } });
      this.logger.log('admin_credit_adjustment'); return updated;
    });
  }
}
