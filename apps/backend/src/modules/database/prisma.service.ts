import { Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { ownerFilter, requestIdentity } from '../auth/request-context';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super();
    this.$use(async (params, next) => {
      const identity = requestIdentity.getStore();
      if (!identity?.userId || identity.adminView || !params.model) return next(params);
      const scope = ownerFilter(params.model, identity.userId);
      if (!scope) return next(params);
      const args = params.args ??= {};
      // Existing LOCAL scopes become account-specific without changing callers.
      const scopeNames = (value: any) => {
        if (!value || typeof value !== 'object') return;
        if (value.ownerScope === 'LOCAL') value.ownerScope = identity.userId;
        for (const item of Object.values(value)) scopeNames(item);
      };
      scopeNames(args);
      const roots = ['Project', 'EditProject', 'ReferenceAsset', 'SavedStyle', 'EditTemplate'];
      if (roots.includes(params.model)) {
        const stamp = (data: any) => { if (data) data.userId = identity.userId; };
        if (params.action === 'create') stamp(args.data);
        if (params.action === 'createMany') (Array.isArray(args.data) ? args.data : [args.data]).forEach(stamp);
        if (params.action === 'upsert') stamp(args.create);
      }
      if (!['create', 'createMany'].includes(params.action)) {
        // Prisma 6 accepts relation predicates alongside the unique id.
        args.where = { ...args.where, AND: [args.where?.AND ?? {}, scope] };
      }
      try { return await next(params); }
      catch (error: any) { if (error.code === 'P2025') throw new NotFoundException('Resource not found.'); throw error; }
    });
  }
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
