import { isXeeProEnabled, assertNewProcessingMode } from '../processing/generation-availability';
import { CanActivate, ExecutionContext, ForbiddenException, HttpException, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { projectExecutionPolicy } from '../processing/execution-policy';
import { withTrustedProjectTier } from '../processing/project-execution-policy';
import Redis from 'ioredis';
import type { Request } from 'express';
import { AuthService, digest } from './auth.service';
import { cookieToken } from './auth.controller';
import { requestIdentity } from './request-context';

@Injectable()
export class SecurityGuard implements CanActivate {
  private readonly redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1 });
  constructor(private readonly auth: AuthService, @Optional() private readonly prisma?: PrismaService) {}
  async onModuleDestroy() { await this.redis.quit(); }
  private async limit(key: string, max: number, seconds: number) {
    const count = Number(await this.redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n", 1, 'rate:' + key, seconds));
    if (count > max) throw new HttpException('Too many requests. Please try again later.', 429);
  }
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    const path = req.path;
    if (path === '/health' || req.method === 'GET' && path === '/videos/import-capabilities') return true;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const allowed = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000').split(',').map(v => v.trim());
      if (!req.headers.origin || !allowed.includes(req.headers.origin)) throw new ForbiddenException('Request origin is not allowed.');
    }
    if (['/auth/login', '/auth/signup'].includes(path)) {
      // Tunnel overwrites CF-Connecting-IP; direct loopback clients cannot spoof the public edge.
      const ip = process.env.TRUST_CLOUDFLARE_IP === 'true' ? String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress) : String(req.socket.remoteAddress);
      await this.limit('auth-ip:' + digest(ip), 30, 900);
      await this.limit('auth-email:' + digest(String(req.body?.email ?? '').trim().toLowerCase()), 10, 900);
      return true;
    }
    if (path === '/auth/logout') return true;
    const user = await this.auth.authenticate(cookieToken(req));
    const identity = requestIdentity.getStore();
    if (!identity) throw new ForbiddenException();
    identity.userId = user.id; identity.admin = user.role === 'ADMIN';
    if (path.startsWith('/admin') || path.startsWith('/ai-providers')) {
      if (!identity.admin) throw new ForbiddenException('Administrator access required.');
      identity.adminView = path.startsWith('/admin');
    }
    if (req.method === 'POST') assertNewProcessingMode(req.body?.aiMode);
    const submission = req.method === 'POST' && /clip-selection|\/export$|\/retry$|\/import|\/analyze$|\/hooks$|\/post-copy$|\/styleone$|\/agent\/run|\/chat\/plan|\/creative\/resolve|\/review|\/brief/.test(path);
    if (submission) await this.limit('submit:' + user.id, 30, 60);
    // Avoid uploads/import downloads when the definitive current balance is already zero.
    if (user.role !== 'ADMIN' && user.creditBalance <= 0 && req.method === 'POST' &&
      (/^\/videos\/[^/]+\/clip-selection$/.test(path) || /^\/quick-reframe\/[^/]+\/export$/.test(path) ||
       path === '/videos/import-url' && req.body?.generationRequest || /\/videos\/upload-sessions$/.test(path) && req.body?.generationRequest)) {
      Logger.warn('generation_blocked_no_credits', 'Security');
      throw new ForbiddenException({ code: 'NO_CREDITS', message: 'No generations remaining.' });
    }
    const askAi = /\/agent\/run|\/chat\/(plan|apply)|\/review(\/propose)?$|\/brief/.test(path) || path.endsWith('/creative/resolve') && req.body?.useAi === true
      || /\/(post-copy|hooks)$/.test(path) && req.body?.externalAiAuthorized === true;
    if (askAi && isXeeProEnabled() && !user.aiProcessingConsentAt) {
      const editId = /^\/edit-mode\/projects\/([^/]+)\//.exec(path)?.[1];
      const reframeId = /^\/quick-reframe\/([^/]+)\/(hooks|post-copy)$/.exec(path)?.[1];
      const project = editId ? await this.prisma?.editProject.findFirst({
        where: { id: editId, userId: user.id }, select: { settings: true, generatedClipId: true, userId: true } })
        : reframeId ? (await this.prisma?.quickReframe?.findFirst({where:{id:reframeId,editProject:{userId:user.id}},
          select:{editProject:{select:{settings:true,generatedClipId:true,userId:true}}}}))?.editProject : null;
      const scoped = project && this.prisma ? await withTrustedProjectTier(this.prisma, project) : project;
      const localOnly = scoped && projectExecutionPolicy(scoped.settings)?.mode === 'XEEFREE';
      if (!localOnly) throw new ForbiddenException({ code: 'AI_CONSENT_REQUIRED', message: 'Allow AI processing in Settings first.' });
    }
    return true;
  }
}
