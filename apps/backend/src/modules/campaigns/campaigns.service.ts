import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { CampaignGenerationContext, CampaignMode, CampaignStyle, StructuredCampaignBrief, SocialPostPackage } from '@ai-content-platform/shared';
import { PrismaService } from '../database/prisma.service';
import { VideosService } from '../videos/videos.service';
import { EditModeService, type AssistantBundleCommand } from '../edit-mode/edit-mode.service';
import { EditModeRenderService } from '../edit-mode/render/edit-mode-render.service';
import { GenerationStylingService } from '../edit-mode/styles/generation-styling.service';
import { StorageService } from '../storage/storage.service';
import { requestIdentity } from '../auth/request-context';
import { assertXeeProAvailable, isXeeProBusyError, XEEPRO_BUSY_MESSAGE } from '../processing/generation-availability';
import { editProjectEvidence } from '../content-intelligence/edit-project-evidence';
import { videoLayout } from '../edit-mode/edit-mode-transform';
import { CampaignAssetsService, campaignOwner } from './campaign-assets.service';
import { CampaignUnderstandingService } from './campaign-understanding.service';
import { emptyBrief, normalizeBrief, evaluateCampaignCompliance, socialPackage } from './campaign-rules';
const json = (v: unknown) => v as Prisma.InputJsonValue;
const publicJson = <T>(v: T): T => JSON.parse(JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? Number(x) : x));
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const text = (v: unknown, max = 4000) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const templates = { STYLEZERO: 'AUTOMATIC_1', STYLEONE: 'AUTOMATIC_2', STYLETWO: 'AUTOMATIC_3_STYLE_TWO' };
const modeOf = (v: unknown): CampaignMode => { if (v !== 'XEEFREE' && v !== 'XEEPRO')
    throw new BadRequestException('Choose XeeFree or XeePro.'); return v; };
const dateOf = (v: unknown) => { if (v === null || v === '')
    return null; const date = typeof v === 'string' ? new Date(v) : new Date(NaN); if (!Number.isFinite(date.getTime()))
    throw new BadRequestException('Enter a valid date.'); return date; };
@Injectable()
export class CampaignsService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(CampaignsService.name);
    private timer?: NodeJS.Timeout;
    private sweeping = false;
    constructor(private readonly prisma: PrismaService, private readonly videos: VideosService, private readonly edit: EditModeService, private readonly render: EditModeRenderService, private readonly styling: GenerationStylingService, private readonly storage: StorageService, readonly assets: CampaignAssetsService, private readonly understanding: CampaignUnderstandingService) { }
    onApplicationBootstrap() { this.timer = setInterval(() => void this.sweep(), 2500); this.timer.unref(); }
    onModuleDestroy() { if (this.timer)
        clearInterval(this.timer); }
    async mode(value: unknown) { const mode = modeOf(value); if (mode === 'XEEPRO') {
        assertXeeProAvailable();
        const user = await this.prisma.user.findUnique({ where: { id: campaignOwner() }, select: { aiProcessingConsentAt: true } });
        if (!user?.aiProcessingConsentAt)
            throw new ForbiddenException({ code: 'AI_CONSENT_REQUIRED', message: 'Allow AI processing in Settings first.' });
    } return mode; }
    async list() { return this.prisma.campaign.findMany({ where: { userId: campaignOwner() }, include: { brief: { select: { version: true, confirmedByUser: true } }, _count: { select: { assets: true, sources: true, clips: true } } }, orderBy: { createdAt: 'desc' } }); }
    async campaign(id: string) { return this.assets.campaign(id); }
    async create(body: Record<string, unknown>) {
        const name = text(body.name, 120);
        if (!name)
            throw new BadRequestException('Enter a campaign name.');
        const platforms = this.platforms(body.platforms ?? []), deadline = body.deadline ? dateOf(body.deadline) : null, userId = campaignOwner();
        return this.prisma.$transaction(async (tx) => { const project = await tx.project.create({ data: { userId, name: 'Campaign · ' + name } }); return tx.campaign.create({ data: { userId, projectId: project.id, name, description: text(body.description, 10000), platforms, deadline, payoutDescription: text(body.payoutDescription), brief: { create: { sourceText: text(body.sourceText, 50000), data: json({ ...emptyBrief(), targetPlatforms: platforms }) } } } }); });
    }
    private platforms(value: unknown) { if (!Array.isArray(value) || value.length > 10 || value.some(v => typeof v !== 'string' || v.length > 80))
        throw new BadRequestException('Enter up to ten platform names.'); return [...new Set(value.map(v => v.trim()).filter(Boolean))] as string[]; }
    async update(id: string, body: Record<string, unknown>) {
        const c = await this.campaign(id);
        const data: any = {};
        if (body.name !== undefined) {
            data.name = text(body.name, 120);
            if (!data.name)
                throw new BadRequestException('Campaign name is required.');
        }
        for (const key of ['description', 'payoutDescription'])
            if (body[key] !== undefined)
                data[key] = text(body[key], key === 'description' ? 10000 : 4000);
        if (body.platforms !== undefined)
            data.platforms = this.platforms(body.platforms);
        if (body.deadline !== undefined)
            data.deadline = dateOf(body.deadline);
        if (body.defaultClipCount !== undefined) {
            if (!Number.isInteger(body.defaultClipCount) || Number(body.defaultClipCount) < 1 || Number(body.defaultClipCount) > 20)
                throw new BadRequestException('Clip count must be 1–20.');
            data.defaultClipCount = body.defaultClipCount;
        }
        if (body.status !== undefined) {
            if (!['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'].includes(String(body.status)))
                throw new BadRequestException('Invalid campaign status.');
            if (body.status === 'ACTIVE' && !(await this.prisma.campaignBrief.findUnique({ where: { campaignId: id } }))?.confirmedByUser)
                throw new ConflictException('Confirm the campaign brief first.');
            data.status = body.status;
        }
        const next = await this.prisma.campaign.update({ where: { id: c.id }, data });
        if (body.description !== undefined || body.platforms !== undefined)
            await this.assets.invalidate(id);
        return next;
    }
    async detail(id: string) { const c = await this.campaign(id); const [brief, assets, sources, runs, clips] = await Promise.all([this.prisma.campaignBrief.findUnique({ where: { campaignId: id } }), this.prisma.campaignAsset.findMany({ where: { campaignId: id }, orderBy: { uploadedAt: 'asc' } }), this.prisma.campaignSource.findMany({ where: { campaignId: id }, include: { video: { select: { id: true, originalName: true, duration: true, processingJobs: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, errorCode: true, error: true, aiMode: true } } } } } }), this.prisma.campaignRun.findMany({ where: { campaignId: id }, orderBy: { createdAt: 'desc' }, take: 50 }), this.clips(id)]); return publicJson({ ...c, brief, assets: assets.map(a => this.assets.public(a)), sources, runs: runs.map(({ snapshot, ...run }) => run), clips }); }
    async understand(id: string, body: Record<string, unknown>) {
        const c = await this.campaign(id), mode = await this.mode(body.mode);
        const current = await this.prisma.campaignBrief.findUniqueOrThrow({ where: { campaignId: id } });
        if (body.version !== current.version)
            throw new ConflictException('Campaign rules changed. Refresh and retry.');
        const sourceText = typeof body.sourceText === 'string' ? body.sourceText.slice(0, 50000) : current.sourceText;
        const assets = await this.prisma.campaignAsset.findMany({ where: { campaignId: id } });
        const result = await this.understanding.understand({ mode, text: [sourceText, ...assets.filter(a => a.extractedText).map(a => a.extractedText)].join('\n'), platforms: c.platforms, assetLabels: assets.map(a => `${a.type}: ${a.label || a.fileName} (${a.intendedUse || 'reference only'})`) });
        result.brief.assetInstructions = assets.filter(a => a.required && ['LOGO_TOP_RIGHT', 'BACKGROUND_MUSIC', 'IMAGE_OVERLAY'].includes(a.intendedUse)).map(a => ({ assetId: a.id, use: a.intendedUse as never, required: true }));
        const changed = await this.prisma.campaignBrief.updateMany({ where: { campaignId: id, version: current.version }, data: { sourceText, mode, data: json(result.brief), version: { increment: 1 }, confirmedByUser: false, confirmedAt: null } });
        if (!changed.count)
            throw new ConflictException('Rules changed during interpretation. Refresh.');
        return { brief: await this.prisma.campaignBrief.findUnique({ where: { campaignId: id } }), audit: result.audit };
    }
    async saveBrief(id: string, body: Record<string, unknown>) {
        await this.campaign(id);
        if (!Number.isInteger(body.version) || Number(body.version) < 1)
            throw new BadRequestException('A valid brief version is required.');
        let data: StructuredCampaignBrief;
        try {
            data = normalizeBrief(body.data);
        }
        catch (e) {
            throw new BadRequestException((e as Error).message);
        }
        await this.validateMappings(id, data);
        const changed = await this.prisma.campaignBrief.updateMany({ where: { campaignId: id, version: Number(body.version) }, data: { data: json(data), ...(typeof body.sourceText === 'string' ? { sourceText: body.sourceText.slice(0, 50000) } : {}), version: { increment: 1 }, confirmedByUser: false, confirmedAt: null } });
        if (!changed.count)
            throw new ConflictException('Rules changed. Refresh before saving.');
        return this.prisma.campaignBrief.findUniqueOrThrow({ where: { campaignId: id } });
    }
    private async validateMappings(id: string, b: StructuredCampaignBrief) { const ids = b.assetInstructions.map(a => a.assetId); const uses = b.assetInstructions.filter(a => a.required).map(a => a.use); if (new Set(uses).size !== uses.length)
        throw new BadRequestException('Choose one required asset per intended use; other files may remain optional references.'); const assets = await this.prisma.campaignAsset.findMany({ where: { campaignId: id, id: { in: ids } } }); if (new Set(ids).size !== ids.length || assets.length !== ids.length)
        throw new BadRequestException('Every mapped asset must belong to this campaign, without duplicates.'); for (const a of b.assetInstructions) {
        const row = assets.find(v => v.id === a.assetId)!;
        if (a.use === 'LOGO_TOP_RIGHT' && row.type !== 'LOGO' || a.use === 'BACKGROUND_MUSIC' && row.type !== 'MUSIC' || a.use === 'IMAGE_OVERLAY' && row.type !== 'IMAGE')
            throw new BadRequestException('An asset mapping has the wrong media type.');
    } }
    async confirm(id: string, body: Record<string, unknown>) { await this.campaign(id); const brief = await this.prisma.campaignBrief.findUniqueOrThrow({ where: { campaignId: id } }); if (brief.version !== body.version || body.confirmedByUser !== true)
        throw new ConflictException('Review and explicitly confirm the latest campaign brief.'); const data = normalizeBrief(brief.data); await this.validateMappings(id, data); if (data.warnings.length && body.warningsAcknowledged !== true)
        throw new BadRequestException('Acknowledge the visible campaign warnings before confirming.'); await this.prisma.$transaction(async (tx) => { const changed = await tx.campaignBrief.updateMany({ where: { campaignId: id, version: brief.version }, data: { confirmedByUser: true, confirmedAt: new Date() } }); if (!changed.count)
        throw new ConflictException('Campaign changed.'); await tx.campaign.update({ where: { id }, data: { status: 'ACTIVE' } }); }); return this.prisma.campaignBrief.findUnique({ where: { campaignId: id } }); }
    async source(id: string, body: Record<string, unknown>) { await this.campaign(id); if (body.authorized !== true)
        throw new BadRequestException('Confirm that you own or have permission to use this source.'); if (typeof body.videoId !== 'string')
        throw new BadRequestException('Choose a source video.'); const video = await this.prisma.video.findFirst({ where: { id: body.videoId, project: { userId: campaignOwner() } } }); if (!video)
        throw new NotFoundException('Authorized source not found.'); return this.prisma.campaignSource.upsert({ where: { campaignId_videoId: { campaignId: id, videoId: video.id } }, create: { campaignId: id, videoId: video.id, ownershipNote: text(body.ownershipNote, 1000) }, update: { ownershipNote: text(body.ownershipNote, 1000) } }); }
    async generate(id: string, body: Record<string, unknown>) {
        const c = await this.campaign(id);
        if (c.status !== 'ACTIVE')
            throw new ConflictException('Activate a confirmed campaign first.');
        const brief = await this.prisma.campaignBrief.findUniqueOrThrow({ where: { campaignId: id } });
        if (!brief.confirmedByUser)
            throw new ConflictException('Confirm the current campaign brief before generation.');
        const mode = await this.mode(body.mode), style = String(body.style) as CampaignStyle;
        if (!Object.hasOwn(templates, style))
            throw new BadRequestException('Choose StyleZero, StyleOne or StyleTwo.');
        if (!Number.isInteger(body.count) || Number(body.count) < 1 || Number(body.count) > 20)
            throw new BadRequestException('Request 1–20 clips per source.');
        if (!Array.isArray(body.sourceIds) || !body.sourceIds.length || body.sourceIds.length > 10 || new Set(body.sourceIds).size !== body.sourceIds.length || body.sourceIds.some(v => typeof v !== 'string'))
            throw new BadRequestException('Choose 1–10 unique campaign sources.');
        const requestKey = text(body.requestKey, 100);
        if (!/^[a-zA-Z0-9-]{8,100}$/.test(requestKey))
            throw new BadRequestException('A unique request key is required.');
        const sources = await this.prisma.campaignSource.findMany({ where: { campaignId: id, id: { in: body.sourceIds as string[] } } });
        if (sources.length !== body.sourceIds.length)
            throw new NotFoundException('Campaign source not found.');
        const data = normalizeBrief(brief.data);
        await this.validateMappings(id, data);
        const runs = [];
        for (const source of sources) {
            const context: CampaignGenerationContext = { campaignId: id, runId: randomUUID(), briefVersion: brief.version, mode, brief: data };
            runs.push(await this.prisma.campaignRun.upsert({ where: { campaignId_requestKey_sourceId: { campaignId: id, requestKey, sourceId: source.id } }, update: {}, create: { id: context.runId, campaignId: id, sourceId: source.id, requestKey, mode, style, requestedClipCount: Number(body.count), briefVersion: brief.version, snapshot: json({ context, notes: text(body.notes, 1500) }) } }));
        }
        void this.sweep();
        return runs;
    }
    /** Persistent workflow orchestration only: the existing queues still transcribe/select/render. */
    async sweep() { if (this.sweeping)
        return; this.sweeping = true; try {
        const runs = await requestIdentity.run({}, () => this.prisma.campaignRun.findMany({ where: { status: { in: ['QUEUED', 'STARTING', 'GENERATING', 'PREPARING'] } }, include: { campaign: { select: { userId: true } }, source: true }, orderBy: { createdAt: 'asc' }, take: 20 }));
        for (const run of runs)
            await requestIdentity.run({ userId: run.campaign.userId }, async () => { try {
                await this.advance(run);
            }
            catch (error) {
                const busy = isXeeProBusyError(error);
                await this.prisma.campaignRun.update({ where: { id: run.id }, data: { status: 'FAILED', errorCode: busy ? 'XEEPRO_BUSY' : 'CAMPAIGN_RUN_FAILED', error: busy ? XEEPRO_BUSY_MESSAGE : error instanceof Error ? error.message.slice(0, 500) : 'Campaign processing failed.' } });
                this.logger.warn('Campaign run ended: ' + run.id);
            } });
    }
    catch {
        this.logger.warn('Campaign workflow scan will retry.');
    }
    finally {
        this.sweeping = false;
    } }
    private async advance(run: any) {
        const video = await this.prisma.video.findUnique({ where: { id: run.source.videoId }, include: { processingJobs: { orderBy: { createdAt: 'desc' }, take: 1 } } });
        if (!video)
            throw new NotFoundException('Source was removed.');
        const job = video.processingJobs[0];
        if (!job || job.status === 'PENDING' || job.status === 'PROCESSING')
            return;
        if (job.status === 'FAILED') {
            if (job.errorCode === 'XEEPRO_BUSY')
                throw new (await import('../processing/generation-availability')).XeeProBusyError('PROVIDER_UNAVAILABLE');
            throw new ConflictException(job.error || 'Source analysis failed.');
        }
        const snapshot = object(run.snapshot), context = snapshot.context as CampaignGenerationContext;
        if (run.status === 'QUEUED' || run.status === 'STARTING') {
            const currentContext = object(job.generationSettings).campaign;
            if (currentContext?.runId === run.id && ['QUEUED', 'RENDERING', 'COMPLETED', 'FAILED'].includes(job.clipRenderStatus ?? '')) {
                await this.prisma.campaignRun.update({ where: { id: run.id }, data: { status: 'GENERATING' } });
                return;
            }
            const current = await this.prisma.campaign.findUniqueOrThrow({ where: { id: run.campaignId }, include: { brief: true } });
            if (current.status !== 'ACTIVE' || !current.brief?.confirmedByUser || current.brief.version !== run.briefVersion)
                throw new ConflictException('Campaign rules or status changed before generation. Review and confirm before trying again.');
            if (['QUEUED', 'RENDERING'].includes(job.clipRenderStatus ?? '') && currentContext?.runId !== run.id)
                return;
            await this.prisma.campaignRun.update({ where: { id: run.id }, data: { status: 'STARTING' } });
            const brief = [context.brief.requiredTopics.length ? 'Focus on ' + context.brief.requiredTopics.join(', ') : '', context.brief.hookRequirements, context.brief.referenceStyleHints, text(snapshot.notes, 1500)].filter(Boolean).join('. ').slice(0, 1500);
            await this.videos.selectClips(video.id, { requestedClipCount: run.requestedClipCount, outputStyle: 'AI_EDITED', generation: { templateId: templates[run.style as CampaignStyle], look: templates[run.style as CampaignStyle], components: {}, referenceId: null, brief, campaign: context } });
            await this.prisma.campaignRun.update({ where: { id: run.id }, data: { status: 'GENERATING' } });
            return;
        }
        if (object(job.generationSettings).campaign?.runId !== run.id)
            throw new ConflictException('Another source request superseded this campaign run.');
        if (job.clipRenderStatus === 'FAILED') {
            if (job.errorCode === 'XEEPRO_BUSY')
                throw new (await import('../processing/generation-availability')).XeeProBusyError('PROVIDER_UNAVAILABLE');
            throw new ConflictException(job.clipRenderError || 'Clip generation failed.');
        }
        if (job.clipRenderStatus !== 'COMPLETED')
            return;
        const generated = await this.prisma.generatedClip.findMany({ where: { videoId: video.id, generationJobId: job.id, createdAt: { gte: run.createdAt }, candidateId: { in: job.selectedCandidateIds } }, include: { candidate: true, editProject: { select: { id: true, revision: true, settings: true } } }, orderBy: { createdAt: 'desc' } });
        const clips = [...new Map(generated.map(g => [g.candidateId, g])).values()];
        if (!clips.length)
            throw new ConflictException('No complete campaign-matched moments were delivered.');
        let waiting = false;
        for (const g of clips) {
            let project = g.editProject;
            if (project && ['BASE_READY', 'STYLE_APPLYING', 'STYLE_READY', 'STYLING', 'RENDERING'].includes(object(object(project.settings).generationStyle).status)) {
                await this.styling.ensureStyled(video.id);
                waiting = true;
                continue;
            }
            if (project && ['STYLE_FAILED', 'FAILED'].includes(object(object(project.settings).generationStyle).status))
                throw new ConflictException('Style application needs review in the canonical editor.');
            if (!project) {
                const materialized = await this.styling.materializeStyled(g.id);
                project = await this.prisma.editProject.findUniqueOrThrow({ where: { id: materialized.editProjectId }, select: { id: true, revision: true, settings: true } });
            }
            const creative = object(object(g.contentPackaging).sharedPackage);
            const pack = socialPackage(context.brief, { caption: creative.captions?.[0]?.text ?? g.candidate?.caption, hashtags: creative.hashtagSets?.find((s: any) => s.label === 'Focused')?.hashtags ?? g.candidate?.hashtags, transcriptText: g.candidate?.transcriptText });
            let clip = await this.prisma.campaignClip.upsert({ where: { campaignId_generatedClipId: { campaignId: run.campaignId, generatedClipId: g.id } }, update: {}, create: { campaignId: run.campaignId, runId: run.id, generatedClipId: g.id, editProjectId: project.id, mode: run.mode, style: run.style, checkedRevision: project.revision, compliance: json({ checks: [], status: 'UNKNOWN' }), socialPackage: json(pack) } });
            if (!clip.brandingApplied) {
                await this.prisma.campaignClip.update({ where: { id: clip.id }, data: { brandingApplied: true } });
                const now = await this.edit.get(project.id);
                if (now.revision === clip.checkedRevision)
                    await this.applyBranding(clip.id, context.brief, false);
                else
                    await this.prisma.campaignClip.update({ where: { id: clip.id }, data: { lifecycleStatus: 'NEEDS_REVIEW' } });
                const edited = await this.edit.get(project.id);
                await this.render.startExport(project.id, edited.revision);
                waiting = true;
                continue;
            }
            const progress = await this.render.progress(project.id);
            if (progress && progress.phase !== 'COMPLETED' && progress.phase !== 'FAILED') {
                waiting = true;
                continue;
            }
            if (progress?.phase === 'FAILED')
                throw new ConflictException(progress.message || 'Canonical export needs review.');
            await this.checkClip(clip.id, true);
        }
        await this.prisma.campaignRun.update({ where: { id: run.id }, data: { status: waiting ? 'PREPARING' : 'COMPLETED' } });
    }
    async ownClip(id: string) { const clip = await this.prisma.campaignClip.findFirst({ where: { id, campaign: { userId: campaignOwner() } }, include: { campaign: { include: { brief: true } }, post: true, generatedClip: { include: { candidate: true } } } }); if (!clip)
        throw new NotFoundException('Campaign clip not found.'); return clip; }
    async checkClip(id: string, force = false) {
        const clip = await this.ownClip(id);
        if (!clip.editProjectId)
            return clip;
        const p = await this.edit.get(clip.editProjectId), brief = clip.campaign.brief;
        if (!brief)
            return clip;
        if (!force && clip.checkedRevision === p.revision && clip.checkedBriefVersion === brief.version && !(brief.confirmedByUser && object(clip.compliance).checks?.some((c: any) => c.code === 'BRIEF_CONFIRMATION')))
            return clip;
        const data = normalizeBrief(brief.data), evidence = editProjectEvidence(p), speech = evidence.transcript ?? '';
        const comp = evaluateCampaignCompliance(data, p as any, speech, clip.socialPackage as unknown as SocialPostPackage, brief.version);
        if (!brief.confirmedByUser) {
            comp.checks.push({ code: 'BRIEF_CONFIRMATION', status: 'UNKNOWN', detail: 'Campaign rules changed; confirm the current brief.', fixable: false });
            comp.status = 'UNKNOWN';
        }
        const changed = clip.checkedRevision !== p.revision;
        const lifecycle = clip.lifecycleStatus === 'POSTED' ? 'POSTED' : changed || ['FAIL', 'UNKNOWN'].includes(comp.status) ? 'NEEDS_REVIEW' : clip.lifecycleStatus;
        await this.prisma.campaignClip.update({ where: { id }, data: { compliance: json(comp), complianceScore: comp.overallScore ?? 0, complianceStatus: comp.status, checkedRevision: p.revision, checkedBriefVersion: brief.version, lifecycleStatus: lifecycle } });
        return this.ownClip(id);
    }
    async clips(campaignId?: string) { const rows = await this.prisma.campaignClip.findMany({ where: { ...(campaignId ? { campaignId } : {}), campaign: { userId: campaignOwner() } }, orderBy: { createdAt: 'desc' }, select: { id: true } }); const output = []; for (const row of rows) {
        const c = await this.checkClip(row.id);
        const { campaign, generatedClip, ...clip } = c as any;
        let exports: any[] = [];
        if (c.editProjectId)
            exports = await this.render.listExports(c.editProjectId);
        const latest = exports[0], previewUrl = latest ? `/edit-mode/assets/${latest.id}/file` : null;
        output.push(publicJson({ ...clip, campaignName: campaign.name, title: object(generatedClip?.editTelemetry).hookFinalText || object(object(generatedClip?.contentPackaging).sharedPackage).selectedHook || generatedClip?.candidate?.title || campaign.name, exportCurrent: latest?.current === true, previewUrl, downloadUrl: previewUrl ? previewUrl + '?download=1' : null, editorUrl: c.editProjectId ? `/edit-mode/${c.editProjectId}` : null, compliance: c.compliance }));
    } return output; }
    async applyBranding(id: string, b: StructuredCampaignBrief, explicit = true) {
        const clip = await this.ownClip(id);
        if (!clip.editProjectId)
            throw new ConflictException('Canonical project is not ready.');
        let p = await this.edit.get(clip.editProjectId);
        const [frameWidth, frameHeight] = String(b.aspectRatio ?? object(p.settings).aspectRatio ?? '9:16').split(':').map(Number);
        const frameAspect = frameWidth > 0 && frameHeight > 0 ? frameWidth / frameHeight : 9 / 16;
        const logoHeight = (media: {width?: number | null; height?: number | null}) => Math.max(.02, Math.min(.8, .2 * (media.height ?? 1) / (media.width ?? 1) * frameAspect));
        for (const instruction of b.assetInstructions.filter(a => a.required)) {
            const existing = p.elements.filter(e => { const asset = p.assets.find(a => a.id === e.assetId); return object(asset?.metadata).campaignAssetId === instruction.assetId && object(e.properties).hidden !== true && Number(object(e.properties).opacity ?? 1) > 0 && e.duration > 0; });
            if (existing.length && instruction.use !== 'BACKGROUND_MUSIC') {
                if (explicit && instruction.use === 'LOGO_TOP_RIGHT')
                    for (const e of existing) {
                        const media = p.assets.find(a => a.id === e.assetId);
                        p = await this.edit.phase3Command(p.id, 'resize-element', { revision: p.revision, elementId: e.id, width: .2, height: logoHeight(media ?? {}) }) as any;
                        p = await this.edit.phase3Command(p.id, 'move-element', { revision: p.revision, elementId: e.id, x: .76, y: .04 }) as any;
                    }
                continue;
            }
            if (existing.length && instruction.use === 'BACKGROUND_MUSIC') {
                if (!explicit)
                    continue;
                for (const e of existing)
                    p = await this.edit.phase3Command(p.id, 'remove-element', { revision: p.revision, elementId: e.id }) as any;
            }
            const a = await this.assets.get(clip.campaignId, instruction.assetId);
            const stream = await this.storage.getObject(a.bucket, a.storageKey), chunks: Buffer[] = [];
            for await (const chunk of stream)
                chunks.push(Buffer.from(chunk));
            const buffer = Buffer.concat(chunks);
            const uploaded = await this.edit.uploadAsset(p.id, { buffer, size: buffer.length, originalname: a.fileName, mimetype: a.mimeType } as Express.Multer.File, instruction.use === 'BACKGROUND_MUSIC' ? 'AUDIO' : instruction.use === 'LOGO_TOP_RIGHT' ? 'LOGO' : 'IMAGE', p.revision);
            const newAsset = uploaded.asset as any;
            await this.prisma.editAsset.update({ where: { id: newAsset.id }, data: { metadata: json({ ...object(newAsset.metadata), campaignAssetId: a.id }) } });
            p = await this.edit.get(p.id);
            if (p.revision !== uploaded.revision)
                throw new ConflictException('Manual edits changed the project. Review before applying campaign assets.');
            if (instruction.use === 'BACKGROUND_MUSIC') {
                const duration = videoLayout(p.elements).reduce((n, s) => Math.max(n, s.end), 0);
                let start = 0;
                for (let loop = 0; loop < 24 && start < duration - .1; loop++) {
                    p = await this.edit.phase3Command(p.id, 'add-audio', { revision: p.revision, assetId: newAsset.id, startTime: start }) as any;
                    const e = p.elements.filter(e => e.assetId === newAsset.id && e.type === 'AUDIO').sort((a, b) => b.startTime - a.startTime)[0];
                    if (!e?.duration)
                        break;
                    start = e.startTime + e.duration;
                }
            }
            else {
                p = await this.edit.phase3Command(p.id, instruction.use === 'LOGO_TOP_RIGHT' ? 'add-logo' : 'add-image', { revision: p.revision, assetId: newAsset.id, startTime: 0 }) as any;
                if (instruction.use === 'LOGO_TOP_RIGHT') {
                    const element = p.elements.find(e => e.assetId === newAsset.id && e.type === 'IMAGE')!;
                    p = await this.edit.phase3Command(p.id, 'resize-element', {revision: p.revision, elementId: element.id, width: .2, height: logoHeight(newAsset)}) as any;
                }
            }
        }
        const texts = p.elements.filter(e => e.type === 'TEXT' && object(e.properties).hidden !== true && Number(object(e.properties).opacity ?? 1) > 0).map(e => String(object(e.properties).content ?? ''));
        const commands: AssistantBundleCommand[] = [];
        // Keep automatically created headlines below the required brand mark.
        // User-authored or manually edited text keeps its chosen geometry.
        const logos = p.elements.filter(e => e.type === 'IMAGE' && b.assetInstructions.some(a => a.required && a.use === 'LOGO_TOP_RIGHT' && object(p.assets.find(asset => asset.id === e.assetId)?.metadata).campaignAssetId === a.assetId));
        for (const headline of p.elements.filter(e => e.type === 'TEXT' && object(e.properties).presetRole === 'HOOK' && object(e.properties).manualEdited !== true && object(e.properties).origin !== 'USER')) {
            const props = object(headline.properties);
            const colliding = logos.filter(logo => {const mark = object(logo.properties); return Number(props.x) < Number(mark.x) + Number(mark.width) && Number(props.x) + Number(props.width) > Number(mark.x) && Number(props.y) < Number(mark.y) + Number(mark.height) + .015 && Number(props.y) + Number(props.height) > Number(mark.y) - .015;});
            if (colliding.length) {
                const y = Math.max(...colliding.map(logo => Number(object(logo.properties).y) + Number(object(logo.properties).height) + .02));
                if (y + Number(props.height) <= .32) commands.push({kind:'ELEMENT',action:'MOVE_ELEMENT',payload:{elementId:headline.id,x:Number(props.x),y}});
            }
        }
        for (const [index, content] of [...new Set([b.requiredCTA, b.requiredText].filter(Boolean))].entries())
            if (!texts.some(t => t.includes(content))) {
                const ref = 'campaign-text-' + index;
                commands.push({ kind: 'ELEMENT', action: 'ADD_TEXT', ref, payload: { content, fontSize: 40, height: .1 } }, { kind: 'ELEMENT', action: 'MOVE_ELEMENT', payload: { ref, x: .08, y: .84 - index * .12 } });
            }
        if (b.aspectRatio && object(p.settings).aspectRatio !== b.aspectRatio)
            commands.push({ kind: 'ELEMENT', action: 'SET_VIDEO_FRAMING', payload: { scope: 'PROJECT', mode: 'ASPECT', aspectRatio: b.aspectRatio } });
        if (b.captionRequirements && !p.elements.some(e => e.type === 'SUBTITLE' && object(e.properties).hidden !== true && Number(object(e.properties).opacity ?? 1) > 0) && !/^(none|off|no captions)$/i.test(b.captionRequirements))
            commands.push({ kind: 'ELEMENT', action: 'GENERATE_CAPTIONS', payload: {} });
        if (commands.length)
            await this.edit.applyAssistantBundle(p.id, p.revision, { proposalId: randomUUID(), summary: 'Apply confirmed campaign requirements', userMessage: explicit ? 'Fix campaign compliance' : 'Initial campaign branding', commands, actor: explicit ? 'MANUAL_USER_ACTION' : 'TEMPLATE_ACTION' });
        await this.prisma.campaignClip.update({ where: { id }, data: { checkedRevision: -1, lifecycleStatus: clip.lifecycleStatus === 'POSTED' ? 'POSTED' : 'NEEDS_REVIEW' } });
        return this.checkClip(id, true);
    }
    async fix(id: string) { const c = await this.ownClip(id); if (!c.campaign.brief?.confirmedByUser)
        throw new ConflictException('Confirm campaign rules before applying fixes.'); return this.applyBranding(id, normalizeBrief(c.campaign.brief.data)); }
    async exportClip(id: string) { const c = await this.ownClip(id); if (!c.editProjectId)
        throw new ConflictException('Project is not ready.'); const p = await this.edit.get(c.editProjectId); return this.render.startExport(p.id, p.revision); }
    async ready(id: string, body: Record<string, unknown>) { const c = await this.checkClip(id, true); if (!c.editProjectId)
        throw new ConflictException('Canonical project is missing.'); if (c.lifecycleStatus === 'POSTED')
        throw new ConflictException('This clip is already recorded as posted.'); if (['FAIL', 'UNKNOWN'].includes(c.complianceStatus) || c.complianceStatus === 'WARN' && body.acceptWarnings !== true)
        throw new ConflictException('Resolve failures/unknown checks and explicitly review warnings before Ready to Post.'); const exports = await this.render.listExports(c.editProjectId); if (!exports[0]?.current)
        throw new ConflictException('Export the current edit before marking it ready.'); const changed = await this.prisma.campaignClip.updateMany({ where: { id, editProject: { revision: c.checkedRevision }, campaign: { brief: { version: c.checkedBriefVersion, confirmedByUser: true } } }, data: { lifecycleStatus: 'READY' } }); if (!changed.count)
        throw new ConflictException('The edit or brief changed. Review current compliance.'); return this.ownClip(id); }
    async social(id: string, body: Record<string, unknown>) { const c = await this.ownClip(id), old = c.socialPackage as unknown as SocialPostPackage; const value: SocialPostPackage = { caption: text(body.caption ?? old.caption, 4000), alternateCaptions: old.alternateCaptions, hashtags: Array.isArray(body.hashtags) ? body.hashtags.filter((v): v is string => typeof v === 'string' && /^#[\p{L}\p{N}_]+$/u.test(v)).slice(0, 50) : old.hashtags, requiredMentions: old.requiredMentions, cta: old.cta, postingNotes: old.postingNotes }; await this.prisma.campaignClip.update({ where: { id }, data: { socialPackage: json(value), checkedRevision: -1 } }); return this.checkClip(id, true); }
    async posted(id: string, body: Record<string, unknown>) {
        const c = await this.checkClip(id, true);
        if (c.lifecycleStatus !== 'READY')
            throw new ConflictException('Mark the current exported clip Ready to Post first.');
        if (!c.editProjectId || (await this.render.listExports(c.editProjectId))[0]?.current !== true)
            throw new ConflictException('Export the current edit first.');
        const platform = text(body.platform, 80);
        if (!platform)
            throw new BadRequestException('Choose the platform you posted to.');
        const url = text(body.postUrl, 2000);
        if (url) {
            let parsed: URL;
            try {
                parsed = new URL(url);
            }
            catch {
                throw new BadRequestException('Enter an HTTPS post URL.');
            }
            if (parsed.protocol !== 'https:')
                throw new BadRequestException('Post URL must use HTTPS.');
        }
        return this.prisma.$transaction(async (tx) => { const changed = await tx.campaignClip.updateMany({ where: { id, lifecycleStatus: 'READY', editProject: { revision: c.checkedRevision }, campaign: { brief: { version: c.checkedBriefVersion, confirmedByUser: true } } }, data: { lifecycleStatus: 'POSTED' } }); if (!changed.count)
            throw new ConflictException('Clip or rules changed.'); return tx.campaignPost.create({ data: { campaignClipId: id, platform, postUrl: url, postedAt: body.postedAt ? dateOf(body.postedAt)! : new Date(), notes: text(body.notes) } }); });
    }
    async metrics(id: string, body: Record<string, unknown>) { const c = await this.ownClip(id); if (!c.post)
        throw new ConflictException('Record the post before entering performance.'); const data: any = {}; for (const k of ['views', 'likes', 'comments', 'shares'])
        if (body[k] !== undefined) {
            if (!Number.isInteger(body[k]) || Number(body[k]) < 0 || Number(body[k]) > 2147483647)
                throw new BadRequestException('Metrics must be non-negative whole numbers up to 2,147,483,647.');
            data[k] = body[k];
        } if (body.earnings !== undefined) {
        const s = String(body.earnings);
        if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(s))
            throw new BadRequestException('Enter recorded earnings with at most two decimal places.');
        data.earnings = new Prisma.Decimal(s);
    } if (body.currency !== undefined) {
        if (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency))
            throw new BadRequestException('Use a three-letter uppercase currency.');
        data.currency = body.currency;
    } if (body.notes !== undefined)
        data.notes = text(body.notes); return publicJson(await this.prisma.campaignPost.update({ where: { campaignClipId: id }, data })); }
    async overview(campaignId?: string) { const all = await this.prisma.campaign.findMany({ where: { userId: campaignOwner(), ...(campaignId ? { id: campaignId } : {}) }, include: { brief: { select: { version: true, confirmedByUser: true } }, clips: { include: { post: true, editProject: { select: { revision: true } } } } } }); const clips = all.flatMap(c => c.clips), posts = clips.flatMap(c => c.post ? [c.post] : []), earningsByCurrency: Record<string, string> = {}; for (const p of posts)
        earningsByCurrency[p.currency] = new Prisma.Decimal(earningsByCurrency[p.currency] ?? 0).add(p.earnings).toFixed(2); const totalViews = posts.reduce((n, p) => n + p.views, 0), best = posts.slice().sort((a, b) => b.views - a.views)[0]; return { activeCampaigns: all.filter(c => c.status === 'ACTIVE').length, campaigns: all.length, clipsGenerated: clips.length, ready: all.reduce((n, c) => n + c.clips.filter(x => x.lifecycleStatus === 'READY' && !['FAIL', 'UNKNOWN'].includes(x.complianceStatus) && c.brief?.confirmedByUser && x.checkedBriefVersion === c.brief.version && x.checkedRevision === x.editProject?.revision).length, 0), posted: posts.length, totalViews, totalEngagement: posts.reduce((n, p) => n + p.likes + p.comments + p.shares, 0), earningsByCurrency, averageViews: posts.length ? totalViews / posts.length : null, bestClipId: best?.campaignClipId ?? null, bestCampaign: all.map(c => ({ id: c.id, name: c.name, views: c.clips.reduce((n, x) => n + (x.post?.views ?? 0), 0) })).filter(c => c.views > 0).sort((a, b) => b.views - a.views)[0] ?? null, averageCampaignMatch: clips.length ? clips.reduce((n, c) => n + c.complianceScore, 0) / clips.length : null }; }
}
