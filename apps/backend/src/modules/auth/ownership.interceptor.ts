import { CallHandler, ExecutionContext, Injectable, NestInterceptor, NotFoundException, Logger } from '@nestjs/common';
import { from, switchMap } from 'rxjs';
import { PrismaService } from '../database/prisma.service';
import { requestIdentity } from './request-context';
@Injectable()
export class OwnershipInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    return from(this.validate(context.switchToHttp().getRequest())).pipe(switchMap(() => next.handle()));
  }
  private async validate(req: any) {
    if (!requestIdentity.getStore()?.userId || requestIdentity.getStore()?.adminView) return;
    const mapping: Record<string, string> = { projectId: 'project', sourceProjectId: 'project', videoId: 'video', sourceVideoId: 'video', originalVideoId: 'video', clipId: 'generatedClip', generatedClipId: 'generatedClip', candidateId: 'clipCandidate', editProjectId: 'editProject', fromProjectId: 'editProject', assetId: 'editAsset', elementId: 'editElement', fromElementId: 'editElement', referenceId: 'referenceAsset', styleId: 'savedStyle', templateId: 'editTemplate' };
    const path = req.path as string;
    if (req.params.id) {
      if (path.startsWith('/edit-mode/projects/')) mapping.id = 'editProject';
      else if (path.startsWith('/quick-reframe/') && !path.includes('/uploads/')) mapping.id = 'quickReframe';
      else if (path.startsWith('/videos/import-jobs/')) mapping.id = 'videoImport';
      else if (path.startsWith('/videos/')) mapping.id = 'video';
      else if (path.startsWith('/projects/')) mapping.id = 'project';
    }
    const check = async (v: any): Promise<void> => {
      if (!v || typeof v !== 'object') return;
      for (const [key, value] of Object.entries(v)) {
        if (key === 'userId' || key === 'ownerScope') throw new NotFoundException('Owner is managed by your account.');
        if (mapping[key] && typeof value === 'string' && value) {
          if (['styleId', 'templateId'].includes(key) && !/^[0-9a-f-]{36}$/i.test(value)) continue;
          const found = await (this.prisma as any)[mapping[key]].findFirst({ where: { id: value }, select: { id: true } });
          if (!found) { Logger.warn('ownership_denial', 'Security'); throw new NotFoundException('Resource not found.'); }
        }
        await check(value);
      }
    };
    await check(req.params); await check(req.query); await check(req.body);
  }
}
