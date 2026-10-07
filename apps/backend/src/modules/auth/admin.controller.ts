import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { publicUser } from './auth.service';
import { requestIdentity } from './request-context';
import { UsageService } from './usage.service';
const pageNumber = (v: string | undefined) => Math.max(1, Math.min(100000, Number(v) || 1));
const safe = (v: unknown): any => JSON.parse(JSON.stringify(v, (_k, value) => typeof value === 'bigint' ? Number(value) : value));
@Controller('admin')
export class AdminController {
  constructor(private readonly prisma: PrismaService, private readonly usage: UsageService) {}
  @Get('users') async users(@Query('q') q = '', @Query('page') page?: string) {
    const current = pageNumber(page); if (!Number.isInteger(current)) throw new BadRequestException();
    const where = q ? { OR: [{ email: { contains: q.slice(0, 100), mode: 'insensitive' as const } }, { displayName: { contains: q.slice(0, 100), mode: 'insensitive' as const } }] } : {};
    const [total, users] = await this.prisma.$transaction([this.prisma.user.count({ where }), this.prisma.user.findMany({ where, select: { ...publicUser, _count: { select: { reservations: true } } }, skip: (current - 1) * 25, take: 25, orderBy: { createdAt: 'desc' } })]);
    return { total, page: current, pageSize: 25, users };
  }
  @Get('users/:id') async user(@Param('id') id: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id }, select: publicUser });
    const [ledger, generations, quickReframe, failures, audit] = await Promise.all([
      this.prisma.creditTransaction.findMany({ where: { userId: id }, take: 100, orderBy: { createdAt: 'desc' } }),
      this.prisma.processingJob.findMany({ where: { video: { project: { userId: id } } }, take: 50, orderBy: { createdAt: 'desc' }, select: { id: true, videoId: true, status: true, clipRenderStatus: true, createdAt: true, error: true, aiMode: true } }),
      this.prisma.quickReframe.findMany({ where: { editProject: { userId: id } }, take: 50, orderBy: { createdAt: 'desc' } }),
      this.prisma.processingJob.findMany({ where: { video: { project: { userId: id } }, OR: [{ status: 'FAILED' }, { clipRenderStatus: 'FAILED' }] }, take: 20, orderBy: { updatedAt: 'desc' }, select: { id: true, error: true, clipRenderError: true, updatedAt: true } }),
      this.prisma.auditLog.findMany({ where: { targetUserId: id }, take: 100, orderBy: { createdAt: 'desc' } })]);
    return safe({ user, ledger, generations, quickReframe, failures, audit });
  }
  @Post('users/:id/credits') credits(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.usage.adjust(requestIdentity.getStore()!.userId!, id, body.mode, body.amount, body.reason);
  }
  private async status(id: string, status: 'ACTIVE' | 'SUSPENDED', reason: unknown) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id} FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({ where: { id } });
      if (user.role === 'ADMIN') throw new BadRequestException('The owner account cannot be suspended.');
      await tx.user.update({ where: { id }, data: { status } });
      if (status === 'SUSPENDED') await tx.session.deleteMany({ where: { userId: id } });
      await tx.auditLog.create({ data: { adminId: requestIdentity.getStore()!.userId!, targetUserId: id, action: status === 'SUSPENDED' ? 'USER_SUSPEND' : 'USER_REACTIVATE', before: { status: user.status }, after: { status }, reason: typeof reason === 'string' ? reason.slice(0, 500) : null } });
      return { id, status };
    });
  }
  @Post('users/:id/suspend') suspend(@Param('id') id: string, @Body() body: Record<string, unknown>) { return this.status(id, 'SUSPENDED', body.reason); }
  @Post('users/:id/reactivate') reactivate(@Param('id') id: string, @Body() body: Record<string, unknown>) { return this.status(id, 'ACTIVE', body.reason); }
  @Get('legacy') async legacy() {
    const [projects, videos, clips, editors, reframes, imports, jobs, exports, references, styles, templates] = await Promise.all([
      this.prisma.project.count({ where: { userId: null } }), this.prisma.video.count({ where: { project: { userId: null } } }),
      this.prisma.generatedClip.count({ where: { video: { project: { userId: null } } } }), this.prisma.editProject.count({ where: { userId: null } }),
      this.prisma.quickReframe.count({ where: { editProject: { userId: null } } }), this.prisma.videoImport.count({ where: { project: { userId: null } } }),
      this.prisma.processingJob.count({ where: { video: { project: { userId: null } } } }), this.prisma.editAsset.count({ where: { role: 'EXPORT', editProject: { userId: null } } }),
      this.prisma.referenceAsset.count({ where: { userId: null } }), this.prisma.savedStyle.count({ where: { userId: null } }), this.prisma.editTemplate.count({ where: { userId: null } })]);
    return { projects, videos, clips, editors, reframes, imports, jobs, exports, references, styles, templates };
  }
  @Get('stats') async stats() {
    const now = new Date(); const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const week = new Date(today.getTime() - 6 * 86400000);
    const [users, active, newToday, newWeek, sources, clips, reframeOutputs, genToday, genWeek, genTotal, success, failed, processing, exports, recentUsers, recentGenerations, recentFailures, daily] = await Promise.all([
      this.prisma.user.count(), this.prisma.user.count({ where: { status: 'ACTIVE' } }), this.prisma.user.count({ where: { createdAt: { gte: today } } }), this.prisma.user.count({ where: { createdAt: { gte: week } } }),
      this.prisma.video.count(), this.prisma.generatedClip.count(), this.prisma.editAsset.count({ where: { role: 'EXPORT', editProject: { quickReframe: { isNot: null } } } }),
      this.prisma.creditReservation.count({ where: { createdAt: { gte: today } } }), this.prisma.creditReservation.count({ where: { createdAt: { gte: week } } }), this.prisma.creditReservation.count(),
      this.prisma.creditReservation.count({ where: { status: 'CONSUMED' } }), this.prisma.creditReservation.count({ where: { status: 'REFUNDED' } }), this.prisma.creditReservation.count({ where: { status: 'RESERVED' } }),
      this.prisma.editAsset.count({ where: { role: 'EXPORT' } }), this.prisma.user.findMany({ select: publicUser, take: 8, orderBy: { createdAt: 'desc' } }),
      this.prisma.creditReservation.findMany({ take: 10, orderBy: { createdAt: 'desc' }, include: { user: { select: { email: true } } } }),
      this.prisma.processingJob.findMany({ where: { OR: [{ status: 'FAILED' }, { clipRenderStatus: 'FAILED' }] }, take: 10, orderBy: { updatedAt: 'desc' }, select: { id: true, videoId: true, error: true, clipRenderError: true, updatedAt: true } }),
      this.prisma.$queryRaw`SELECT d::date::text AS day, (SELECT count(*)::int FROM "CreditReservation" WHERE "createdAt" >= d AND "createdAt" < d + interval '1 day') AS generations, (SELECT count(*)::int FROM "User" WHERE "createdAt" >= d AND "createdAt" < d + interval '1 day') AS users FROM generate_series(${week}::timestamp, ${today}::timestamp, interval '1 day') d`
    ]);
    const [modes, styles, sourceStorage, clipStorage, assetStorage, referenceStorage] = await Promise.all([
      this.prisma.processingJob.groupBy({ by: ['aiMode'], _count: true }),
      this.prisma.generatedClip.groupBy({ by: ['templateId'], _count: true }),
      this.prisma.video.aggregate({ _sum: { sizeBytes: true } }), this.prisma.generatedClip.aggregate({ _sum: { sizeBytes: true } }),
      this.prisma.editAsset.aggregate({ where: { storageOwnership: 'OWNED' }, _sum: { sizeBytes: true } }), this.prisma.referenceAsset.aggregate({ _sum: { sizeBytes: true } })]);
    const trackedStorageBytes = [sourceStorage, clipStorage, assetStorage, referenceStorage].reduce((sum, result) => sum + Number(result._sum.sizeBytes ?? 0), 0);
    return safe({ timezone: 'UTC', users, active, newToday, newWeek, sources, clips, reframeOutputs, genToday, genWeek, genTotal, success, failed, processing, exports, recentUsers, recentGenerations, recentFailures, daily, modes, styles, trackedStorageBytes, storageNote: 'Recorded source, clip, owned editor and reference files; excludes temporary files, audio derivatives and storage overhead.' });
  }
}
