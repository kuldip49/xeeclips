import { Body, Query, UseFilters, Controller, Delete, Get, Headers, Param, Patch, Post, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { tmpdir } from 'node:os';
import type { Response } from 'express';
import { CampaignsService } from './campaigns.service';
import { CampaignAssetsService } from './campaign-assets.service';
import {CampaignExceptionFilter} from './campaign-exception.filter';
import {CampaignBodyPipe,campaignDto,postDto} from './campaign-contract';
@UseFilters(CampaignExceptionFilter)
@Controller()
export class CampaignsController {
    constructor(private readonly campaigns: CampaignsService, private readonly assets: CampaignAssetsService) { }
    @Get('campaigns/overview')
    overview() { return this.campaigns.overview(); }
    @Get('campaigns')
    list(@Query() page:Record<string,unknown>) {return this.campaigns.list(page);}
    @Post('campaigns')
    async create(
    @Body(new CampaignBodyPipe())
    body: Record<string, unknown>) { return campaignDto(await this.campaigns.create(body)); }
    @Get('campaign-assets')
    allAssets(@Query() page:Record<string,unknown>) {return this.assets.list(page);}
    @Get('campaign-clips')
    allClips(@Query() page:Record<string,unknown>) {return this.campaigns.clips(undefined,page);}
    @Get('campaigns/:id')
    get(
    @Param('id')
    id:string,@Query() page:Record<string,unknown>){return this.campaigns.detail(id,page);}
    @Patch('campaigns/:id')
    async update(
    @Param('id')
    id: string, 
    @Body(new CampaignBodyPipe())
    body: Record<string, unknown>) { return campaignDto(await this.campaigns.update(id,body)); }
    @Delete('campaigns/:id')
    async archive(
    @Param('id')
    id: string) { return campaignDto(await this.campaigns.update(id,{status:'ARCHIVED'})); }
    @Get('campaigns/:id/performance')
    async performance(
    @Param('id')
    id: string) { await this.campaigns.campaign(id); return this.campaigns.overview(id); }
    @Post('campaigns/:id/understand')
    understand(
    @Param('id')
    id: string, 
    @Body(new CampaignBodyPipe())
    body: Record<string, unknown>) { return this.campaigns.understand(id, body); }
    @Patch('campaigns/:id/brief')
    brief(
    @Param('id')
    id: string, 
    @Body(new CampaignBodyPipe())
    body: Record<string, unknown>) { return this.campaigns.saveBrief(id, body); }
    @Post('campaigns/:id/confirm')
    confirm(
    @Param('id')
    id: string, 
    @Body(new CampaignBodyPipe())
    body: Record<string, unknown>) { return this.campaigns.confirm(id, body); }
    @Post('campaigns/:id/assets')
    @UseInterceptors(FileInterceptor('file', { storage: diskStorage({ destination: tmpdir() }), limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 5 } }))
    upload(
    @Param('id')
    id: string, 
    @UploadedFile()
    file: Express.Multer.File, 
    @Body(new CampaignBodyPipe())
    body: Record<string, unknown>) { return this.assets.upload(id, file, body); }
    @Patch('campaigns/:id/assets/:assetKey')
    asset(
    @Param('id')
    id: string, 
    @Param('assetKey')
    assetKey: string, 
    @Body(new CampaignBodyPipe())
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
    @Body(new CampaignBodyPipe())
    body: Record<string, unknown>) { return this.campaigns.source(id, body); }
    @Post('campaigns/:id/generate')
    generate(
    @Param('id')
    id: string, 
    @Body(new CampaignBodyPipe())
    body: Record<string, unknown>) { return this.campaigns.generate(id, body); }
    @Get('campaigns/:id/clips')
    async clips(
    @Param('id')
    id:string,@Query() page:Record<string,unknown>){await this.campaigns.campaign(id);return this.campaigns.clips(id,page);}
    @Get('campaign-clips/:id/compliance')
    async compliance(
    @Param('id')
    id: string) { return (await this.campaigns.checkClip(id)).compliance; }
    @Post('campaign-clips/:id/fix')
    async fix(
    @Param('id')
    id: string) { return this.campaigns.publicClip(await this.campaigns.fix(id)); }
    @Post('campaign-clips/:id/export')
    export(
    @Param('id')
    id: string) { return this.campaigns.exportClip(id); }
    @Post('campaign-clips/:id/ready')
    async ready(
    @Param('id')
    id: string, 
    @Body(new CampaignBodyPipe())
    body: Record<string, unknown>) { return this.campaigns.publicClip(await this.campaigns.ready(id, body)); }
    @Patch('campaign-clips/:id/social')
    async social(
    @Param('id')
    id: string, 
    @Body(new CampaignBodyPipe())
    body: Record<string, unknown>) { return this.campaigns.publicClip(await this.campaigns.social(id, body)); }
    @Post('campaign-clips/:id/mark-posted')
    async posted(
    @Param('id')
    id: string, 
    @Body(new CampaignBodyPipe())
    body: Record<string, unknown>) { return postDto(await this.campaigns.posted(id,body)); }
    @Patch('campaign-clips/:id/metrics')
    metrics(
    @Param('id')
    id: string, 
    @Body(new CampaignBodyPipe())
    body: Record<string, unknown>) { return this.campaigns.metrics(id, body); }
}
