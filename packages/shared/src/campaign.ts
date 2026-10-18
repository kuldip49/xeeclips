export const CAMPAIGN_LIST_FIELDS = ['targetPlatforms', 'requiredTopics', 'preferredTopics', 'forbiddenTopics', 'requiredKeywords', 'forbiddenKeywords', 'contentDo', 'contentDont', 'requiredHashtags', 'requiredMentions', 'unresolvedRules'] as const;
export const CAMPAIGN_TEXT_FIELDS = ['requiredCTA', 'forbiddenCTA', 'hookRequirements', 'captionRequirements', 'hashtagRequirements', 'brandingRequirements', 'musicRequirements', 'logoRequirements', 'postingRules', 'submissionRules', 'tone', 'audience', 'referenceStyleHints', 'requiredText', 'brandColor', 'deadlineText', 'payoutText'] as const;
export type CampaignMode = 'XEEFREE' | 'XEEPRO';
export type CampaignStyle = 'STYLEZERO' | 'STYLEONE' | 'STYLETWO';
export type StructuredCampaignBrief = Record<typeof CAMPAIGN_LIST_FIELDS[number], string[]> & Record<typeof CAMPAIGN_TEXT_FIELDS[number], string> & {
    minDurationSec: number | null;
    maxDurationSec: number | null;
    aspectRatio: string | null;
    warnings: string[];
    confidence: 'EXPLICIT' | 'NEEDS_CONFIRMATION';
    assetInstructions: Array<{
        assetId: string;
        use: 'LOGO_TOP_RIGHT' | 'BACKGROUND_MUSIC' | 'IMAGE_OVERLAY';
        required: boolean;
    }>;
};
export type CampaignGenerationContext = {
    campaignId: string;
    runId: string;
    briefVersion: number;
    mode: CampaignMode;
    brief: StructuredCampaignBrief;
};
export type CampaignCheck = {
    code: string;
    status: 'PASS' | 'WARN' | 'FAIL' | 'NOT_APPLICABLE' | 'UNKNOWN';
    detail: string;
    fixable: boolean;
};
export type CampaignCompliance = {
    overallScore: number | null;
    status: 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';
    checks: CampaignCheck[];
    revision: number;
    briefVersion: number;
};
export type SocialPostPackage = {
    caption: string;
    alternateCaptions: string[];
    hashtags: string[];
    requiredMentions: string[];
    cta: string;
    postingNotes: string;
};
