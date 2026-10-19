import { ApiError, apiFetch, getPublicApiBaseUrl, XEEPRO_BUSY_MESSAGE } from './api';
import type { CampaignCompliance, CampaignMode, CampaignStyle, SocialPostPackage, StructuredCampaignBrief } from '@ai-content-platform/shared';
export type { CampaignMode, CampaignStyle, StructuredCampaignBrief };
export function campaignError(error: unknown): string {
    if (error instanceof ApiError && error.code === 'XEEPRO_BUSY') return XEEPRO_BUSY_MESSAGE;
    const message = error instanceof Error ? error.message : '';
    if (!message || /prisma|ffmpeg|openai|\bgpt\b|provider|stack trace|objectkey|storagekey|bucket|s3:\/\/|\/app\/|node_modules|\bat \w+.*\(/i.test(message))
        return 'This request could not finish. Refresh and try again.';
    return message.slice(0, 500);
}
export const campaignRequest = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    try { return await apiFetch<T>(path, { method, cache: 'no-store', ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) }); }
    catch (error) { throw new ApiError(campaignError(error), error instanceof ApiError ? error.status : 0, error instanceof ApiError ? error.code : undefined); }
};
export const campaignPageSize = 50;
export async function campaignCollection<T>(path: string, pages = 1): Promise<{rows:T[];more:boolean}> {
    const batches = await Promise.all(Array.from({length:pages}, (_,i) => campaignRequest<T[]>(`${path}?limit=${campaignPageSize}&offset=${i*campaignPageSize}`)));
    return {rows:batches.flat(), more:batches.at(-1)?.length===campaignPageSize};
}
export async function campaignDetail(id:string,pages=1):Promise<{campaign:Campaign;more:boolean}> {
    const batches=await Promise.all(Array.from({length:pages},(_,i)=>campaignRequest<Campaign>(`/campaigns/${encodeURIComponent(id)}?limit=${campaignPageSize}&offset=${i*campaignPageSize}`)));
    const campaign={...batches[0]};const keys=['assets','sources','runs','clips'] as const;
    for(const key of keys)(campaign[key] as unknown[]) = batches.flatMap(c=>c[key] as unknown[]);
    return {campaign,more:keys.some(key=>batches.at(-1)?.[key].length===campaignPageSize)};
}
export const campaignMedia = (path: string | null | undefined) => path ? getPublicApiBaseUrl() + path : undefined;
export type CampaignAsset = {
    id: string;
    campaignId: string;
    type: string;
    fileName: string;
    mimeType: string;
    label: string;
    required: boolean;
    intendedUse: string;
    fileUrl: string;
    sizeBytes: number;
    metadata: {
        handling: string;
        relativePath?: string;
    };
    extractedTextAvailable: boolean;
};
export type CampaignPost = {
    platform: string;
    postedAt: string;
    postUrl: string;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    earnings: string;
    currency: string;
    notes: string;
};
export type CampaignClip = {
    id: string;
    campaignId: string;
    campaignName: string;
    title: string;
    mode: CampaignMode;
    style: CampaignStyle;
    lifecycleStatus: string;
    complianceStatus: string;
    complianceScore: number;
    compliance: CampaignCompliance;
    socialPackage: SocialPostPackage;
    previewUrl: string | null;
    downloadUrl: string | null;
    exportCurrent: boolean;
    editorUrl: string | null;
    editProjectId?: string | null;
    checkedRevision?: number;
    checkedBriefVersion?: number;
    post: CampaignPost | null;
};
export type CampaignBrief = {
    campaignId: string;
    version: number;
    sourceText: string;
    mode: CampaignMode;
    confirmedByUser: boolean;
    data: StructuredCampaignBrief;
};
export type Campaign = {
    id: string;
    projectId: string;
    name: string;
    description: string;
    platforms: string[];
    status: string;
    payoutDescription: string;
    deadline: string | null;
    defaultClipCount: number;
    createdAt: string;
    brief: CampaignBrief | null;
    assets: CampaignAsset[];
    sources: Array<{
        id: string;
        videoId: string;
        ownershipNote: string;
        video: {
            id: string;
            originalName: string;
            duration: number | null;
            processingJobs: Array<{
                status: string;
                error: string | null;
            }>;
        };
    }>;
    runs: Array<{
        id: string;
        mode: CampaignMode;
        style: CampaignStyle;
        status: string;
        error: string | null;
        errorCode: string | null;
        requestedClipCount: number;
    }>;
    clips: CampaignClip[];
    _count?: {
        assets: number;
        sources: number;
        clips: number;
    };
};
export type CampaignOverview = {
    activeCampaigns: number;
    campaigns: number;
    clipsGenerated: number;
    ready: number;
    posted: number;
    totalViews: number;
    totalEngagement: number;
    earningsByCurrency: Record<string, string>;
    averageViews: number | null;
    bestClipId: string | null;
    bestCampaign: {
        name: string;
        views: number;
    } | null;
    averageCampaignMatch: number | null;
};
