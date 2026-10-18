import { apiFetch, getPublicApiBaseUrl } from './api';
import type { CampaignCompliance, CampaignMode, CampaignStyle, SocialPostPackage, StructuredCampaignBrief } from '@ai-content-platform/shared';
export type { CampaignMode, CampaignStyle, StructuredCampaignBrief };
export const campaignRequest = <T>(path: string, method = 'GET', body?: unknown) => apiFetch<T>(path, { method, cache: 'no-store', ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
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
