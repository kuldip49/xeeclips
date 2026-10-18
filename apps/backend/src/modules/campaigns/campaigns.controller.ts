import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { tmpdir } from 'node:os';
import type { Response } from 'express';
import { CampaignsService } from './campaigns.service';
import { CampaignAssetsService } from './campaign-assets.service';
const responseJson = async (value: Promise<unknown>) => JSON.parse(JSON.stringify(await value, (_key, v) => typeof v === 'bigint' ? Number(v) : v));
@Controller()
export class CampaignsController {
    constructor(private readonly campaigns: CampaignsService, private readonly assets: CampaignAssetsService) { }
    @Get('campaigns/overview')
    overview() { return this.campaigns.overview(); }
    @Get('campaigns')
    list() { return this.campaigns.list(); }
    @Post('campaigns')
    create(
    @Body()
    body: Record<string, unknown>) { return this.campaigns.create(body); }
    @Get('campaign-assets')
    allAssets() { return this.assets.list(); }
    @Get('campaign-clips')
    allClips() { return this.campaigns.clips(); }
    @Get('campaigns/:id')
    get(
    @Param('id')
    id: string) { return this.campaigns.detail(id); }
    @Patch('campaigns/:id')
    update(
    @Param('id')
    id: string, 
    @Body()
    body: Record<string, unknown>) { return this.campaigns.update(id, body); }
    @Delete('campaigns/:id')
    archive(
    @Param('id')
    id: string) { return this.campaigns.update(id, { status: 'ARCHIVED' }); }
    @Get('campaigns/:id/performance')
    async performance(
    @Param('id')
    id: string) { await this.campaigns.campaign(id); return this.campaigns.overview(id); }
    @Post('campaigns/:id/understand')
    understand(
    @Param('id')
    id: string, 
    @Body()
    body: Record<string, unknown>) { return this.campaigns.understand(id, body); }
    @Patch('campaigns/:id/brief')
    brief(
    @Param('id')
    id: string, 
    @Body()
    body: Record<string, unknown>) { return this.campaigns.saveBrief(id, body); }
    @Post('campaigns/:id/confirm')
    confirm(
    @Param('id')
    id: string, 
    @Body()
    body: Record<string, unknown>) { return this.campaigns.confirm(id, body); }
    @Post('campaigns/:id/assets')
    @UseInterceptors(FileInterceptor('file', { storage: diskStorage({ destination: tmpdir() }), limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 5 } }))
    upload(
    @Param('id')
    id: string, 
    @UploadedFile()
    file: Express.Multer.File, 
    @Body()
    body: Record<string, unknown>) { return this.assets.upload(id, file, body); }
    @Patch('campaigns/:id/assets/:assetKey')
    asset(
    @Param('id')
    id: string, 
    @Param('assetKey')
    assetKey: string, 
    @Body()
    body: Record<string, unknown>) { return this.assets.update(id, assetKey, body); }
    @Delete('campaigns/:id/assets/:assetKey')
    removeAsset(
    @Param('id')
    id: string, 
    @Param('assetKey')
    assetKey: string) { return this.assets.remove(id, assetKey); }
    @Get('campaigns/:id/assets/:assetKey/file')
    async file(
    @Param('id')
    id: string, 
    @Param('assetKey')
    assetKey: string, 
    @Headers('range')
    range: string | undefined, 
    @Res({ passthrough: true })
    res: Response) { const f = await this.assets.file(id, assetKey, range); res.setHeader('Content-Type', f.a.mimeType); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'"); res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Length', f.end - f.start + 1); if (f.a.type === 'DOCUMENT')
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.a.fileName)}`); if (f.partial) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${f.start}-${f.end}/${f.size}`);
    } return new StreamableFile(f.stream); }
    @Post('campaigns/:id/sources')
    source(
    @Param('id')
    id: string, 
    @Body()
    body: Record<string, unknown>) { return this.campaigns.source(id, body); }
    @Post('campaigns/:id/generate')
    generate(
    @Param('id')
    id: string, 
    @Body()
    body: Record<string, unknown>) { return this.campaigns.generate(id, body); }
    @Get('campaigns/:id/clips')
    async clips(
    @Param('id')
    id: string) { await this.campaigns.campaign(id); return this.campaigns.clips(id); }
    @Get('campaign-clips/:id/compliance')
    async compliance(
    @Param('id')
    id: string) { return (await this.campaigns.checkClip(id)).compliance; }
    @Post('campaign-clips/:id/fix')
    fix(
    @Param('id')
    id: string) { return responseJson(this.campaigns.fix(id)); }
    @Post('campaign-clips/:id/export')
    export(
    @Param('id')
    id: string) { return this.campaigns.exportClip(id); }
    @Post('campaign-clips/:id/ready')
    ready(
    @Param('id')
    id: string, 
    @Body()
    body: Record<string, unknown>) { return responseJson(this.campaigns.ready(id, body)); }
    @Patch('campaign-clips/:id/social')
    social(
    @Param('id')
    id: string, 
    @Body()
    body: Record<string, unknown>) { return responseJson(this.campaigns.social(id, body)); }
    @Post('campaign-clips/:id/mark-posted')
    posted(
    @Param('id')
    id: string, 
    @Body()
    body: Record<string, unknown>) { return this.campaigns.posted(id, body); }
    @Patch('campaign-clips/:id/metrics')
    metrics(
    @Param('id')
    id: string, 
    @Body()
    body: Record<string, unknown>) { return this.campaigns.metrics(id, body); }
}
