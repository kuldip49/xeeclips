import { CAMPAIGN_LIST_FIELDS, CAMPAIGN_TEXT_FIELDS, type StructuredCampaignBrief, type CampaignGenerationContext, type CampaignCheck, type CampaignCompliance, type SocialPostPackage } from '@ai-content-platform/shared';
import { semanticSimilarity } from '../processing/semantic-similarity.service';
import { videoLayout } from '../edit-mode/edit-mode-transform';
const unique = (items: string[]) => [...new Set(items.map(s => s.trim()).filter(Boolean))];
export const words = (s: string) => s.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? [];
export const contains=(text:string,term:string)=>words(term).length?(' '+words(text).join(' ')+' ').includes(' '+words(term).join(' ')+' '):!!term.trim()&&text.includes(term.trim());
export const hasMention=(text:string,mention:string)=>{let at=text.indexOf(mention);while(at>=0){if(!/[\p{L}\p{N}_.]/u.test(text[at+mention.length]??' '))return true;at=text.indexOf(mention,at+mention.length);}return false;};
export function requirementPolicy(value:string):'OFF'|'OPTIONAL'|'REQUIRED'{return /^(?:none|off|no(?: (?:logo|music|captions|subtitles))?)$/i.test(value.trim())?'OFF':/^(?:optional|not required)$/i.test(value.trim())?'OPTIONAL':'REQUIRED';}
const parts = (s: string) => unique(s.replace(/[“”"']/g, '').split(/[,;\n]|\s+and\s+/i));
export function emptyBrief(): StructuredCampaignBrief { return { ...Object.fromEntries(CAMPAIGN_LIST_FIELDS.map(k => [k, []])), ...Object.fromEntries(CAMPAIGN_TEXT_FIELDS.map(k => [k, ''])), minDurationSec: null, maxDurationSec: null, aspectRatio: null, warnings: [], confidence: 'EXPLICIT', assetInstructions: [] } as unknown as StructuredCampaignBrief; }
/** Only explicit, attributable rules become constraints. Unclassified instructions stay visible. */
export function parseCampaignRules(source: string, platforms: string[] = []): StructuredCampaignBrief {
    const b = emptyBrief();
    b.targetPlatforms = unique(platforms);
    let heading = '';
    const listKeys: Record<string, typeof CAMPAIGN_LIST_FIELDS[number]> = { 'required topics': 'requiredTopics', 'topics': 'requiredTopics', 'preferred topics': 'preferredTopics', 'forbidden topics': 'forbiddenTopics', 'banned topics': 'forbiddenTopics', 'required keywords': 'requiredKeywords', 'required words': 'requiredKeywords', 'banned words': 'forbiddenKeywords', 'forbidden keywords': 'forbiddenKeywords', do: 'contentDo', dont: 'contentDont', "don't": 'contentDont', 'do not': 'contentDont', 'required hashtags': 'requiredHashtags', 'hashtags': 'requiredHashtags', 'mentions': 'requiredMentions' };
    const scalar: Record<string, typeof CAMPAIGN_TEXT_FIELDS[number]> = { cta: 'requiredCTA', 'required cta': 'requiredCTA', 'forbidden cta': 'forbiddenCTA', hook: 'hookRequirements', hooks: 'hookRequirements', captions: 'captionRequirements', 'branding': 'brandingRequirements', logo: 'logoRequirements', music: 'musicRequirements', posting: 'postingRules', submission: 'submissionRules', tone: 'tone', audience: 'audience', 'reference style': 'referenceStyleHints', 'required text': 'requiredText', 'brand color': 'brandColor', deadline: 'deadlineText', payout: 'payoutText', reward: 'payoutText' };
    for (const original of source.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
        const line = original.replace(/^[-*•\d.)\s]+/, '').trim();
        if (!line)
            continue;
        const kv = /^([^:]{1,40}):\s*(.*)$/.exec(line);
        const key = (kv?.[1] ?? '').trim().toLowerCase();
        const value = kv?.[2] ?? line;
        if (kv && !value) {
            heading = key;
            continue;
        }
        if (kv && Object.hasOwn(listKeys, key)) {
            const field = listKeys[key];
            b[field].push(...(field === 'requiredHashtags' ? (value.match(/#[\p{L}\p{N}_]+/gu) ?? []) : field === 'requiredMentions' ? (value.match(/@[\p{L}\p{N}_.]+/gu) ?? []) : parts(value)));
            heading = '';
            continue;
        }
        if (kv && Object.hasOwn(scalar, key)) {
            b[scalar[key]] = [b[scalar[key]], value.replace(/^["“](.*)["”]$/, '$1')].filter(Boolean).join('; ');
            heading = '';
            continue;
        }
        if (!kv && Object.hasOwn(listKeys, heading)) {
            const field=listKeys[heading];b[field].push(...(field==='requiredHashtags'?(line.match(/#[\p{L}\p{N}_]+/gu)??[]):field==='requiredMentions'?(line.match(/@[\p{L}\p{N}_.]+/gu)??[]):parts(line)));
            continue;
        }
        if (!kv && Object.hasOwn(scalar, heading)) {
            const field = scalar[heading];
            b[field] = [b[field], line].filter(Boolean).join('; ');
            continue;
        }
        if(!kv&&/^no (?:music|soundtrack|captions|subtitles|logo)$/i.test(line)){const field=/music|soundtrack/i.test(line)?'musicRequirements':/logo/i.test(line)?'logoRequirements':'captionRequirements';b[field]=line;continue;}
        let known = false;
        const range = /(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)\s*(?:sec(?:ond)?s?\b|s\b)/i.exec(line);
        if (range) {
            const min = +range[1], max = +range[2];
            if (b.minDurationSec !== null && (b.minDurationSec !== min || b.maxDurationSec !== max))
                b.unresolvedRules.push('Conflicting duration: ' + line);
            else {
                b.minDurationSec = min;
                b.maxDurationSec = max;
            }
            known = true;
        }
        const ratio = /\b(9:16|16:9|1:1|4:5)\b/.exec(line);
        if (ratio) {
            if (b.aspectRatio && b.aspectRatio !== ratio[1])
                b.unresolvedRules.push('Conflicting aspect ratios: ' + line);
            else
                b.aspectRatio = ratio[1];
            known = true;
        }
        for (const [pattern, name] of [[/\btiktok\b/i, 'TikTok'], [/\breels?\b|instagram/i, 'Instagram Reels'], [/youtube|shorts/i, 'YouTube Shorts']] as const)
            if (pattern.test(line)) {
                b.targetPlatforms.push(name);
                known = true;
            }
        if (/^(duration|length|platform|aspect ratio|deadline|payout|reward)\s*:/i.test(line) && (/deadline|payout|reward/i.test(key) || known))
            known = true;
        if (/^(?:avoid|no|forbid(?:den)?|ban(?:ned)?)\s+/i.test(line)) {
            b.forbiddenTopics.push(...parts(line.replace(/^(?:avoid|no|forbid(?:den)?|ban(?:ned)?)\s+/i, '')));
            known = true;
        }
        if (/\blogo\b/i.test(line)) {
            b.logoRequirements = [b.logoRequirements, line].filter(Boolean).join('; ');
            known = true;
        }
        if (/\b(music|soundtrack)\b/i.test(line)) {
            b.musicRequirements = [b.musicRequirements, line].filter(Boolean).join('; ');
            known = true;
        }
        if (/\b(captions|subtitles)\b/i.test(line)) {
            b.captionRequirements = [b.captionRequirements, line].filter(Boolean).join('; ');
            known = true;
        }
        if (/#[\p{L}\p{N}_]+/u.test(line)) {
            b.requiredHashtags.push(...line.match(/#[\p{L}\p{N}_]+/gu)!);
            b.hashtagRequirements = line;
            known = true;
        }
        if (/\b(?:must|required|include)\b.*\b(?:say|cta|call to action)\b/i.test(line)) {
            const quote = /["“]([^"”]+)["”]/.exec(line);
            if (quote) {
                b.requiredCTA = quote[1];
                known = true;
            }
        }
        const explicit=kv&&['duration','length','platform','platforms','aspect ratio'].includes(key);
        if (!known||!explicit) b.unresolvedRules.push(line);
    }
    for (const k of CAMPAIGN_LIST_FIELDS)
        b[k] = unique(b[k]);
    if (b.minDurationSec !== null && b.maxDurationSec !== null && b.minDurationSec > b.maxDurationSec)
        b.unresolvedRules.push('Minimum duration exceeds maximum duration.');
    const conflicts = [...b.requiredTopics.filter(t => b.forbiddenTopics.some(f => contains(t, f) || contains(f, t))), ...b.requiredKeywords.filter(t => b.forbiddenKeywords.some(f => contains(t, f)))];
    if (conflicts.length)
        b.unresolvedRules.push('Required and forbidden rules conflict: ' + conflicts.join(', '));
    addCampaignConflicts(b);
    b.warnings = b.unresolvedRules.map(s => 'NEEDS_CONFIRMATION: ' + s);
    b.confidence = b.warnings.length ? 'NEEDS_CONFIRMATION' : 'EXPLICIT';
    return b;
}
export function normalizeBrief(value: unknown): StructuredCampaignBrief {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('A structured campaign brief is required.');
    const raw = value as Record<string, unknown>, b = emptyBrief();
    for (const k of CAMPAIGN_LIST_FIELDS) {
        if (!Array.isArray(raw[k]) || raw[k].some((v: unknown) => typeof v !== 'string' || v.length > 1500) || raw[k].length > 100)
            throw Error('Invalid ' + k);
        b[k] = unique(raw[k] as string[]);
    }
    for (const k of CAMPAIGN_TEXT_FIELDS) {
        if (typeof raw[k] !== 'string' || raw[k].length > 4000)
            throw Error('Invalid ' + k);
        b[k] = raw[k] as string;
    }
    for (const k of ['minDurationSec', 'maxDurationSec'] as const) {
        const v = raw[k];
        if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 120))
            throw Error('Duration must be 1–120 seconds, or unset.');
        b[k] = v as number | null;
    }
    if (b.minDurationSec !== null && b.maxDurationSec !== null && b.minDurationSec > b.maxDurationSec)
        throw Error('Minimum duration exceeds maximum.');
    if (raw.aspectRatio !== null && !['9:16', '16:9', '1:1', '4:5'].includes(String(raw.aspectRatio)))
        throw Error('Unsupported aspect ratio.');
    b.aspectRatio = raw.aspectRatio as string | null;
    if (!Array.isArray(raw.assetInstructions) || raw.assetInstructions.length > 30)
        throw Error('Invalid asset instructions.');
    b.assetInstructions = raw.assetInstructions.map((a: any) => { if (!a || typeof a.assetId !== 'string' || !['LOGO_TOP_RIGHT', 'BACKGROUND_MUSIC', 'IMAGE_OVERLAY'].includes(a.use) || typeof a.required !== 'boolean')
        throw Error('Invalid asset instruction.'); return { assetId: a.assetId, use: a.use, required: a.required }; });
    addCampaignConflicts(b);
    b.warnings = b.unresolvedRules.map(s => 'NEEDS_CONFIRMATION: ' + s);
    b.confidence = b.warnings.length ? 'NEEDS_CONFIRMATION' : 'EXPLICIT';
    return b;
}
export function addCampaignConflicts(b:StructuredCampaignBrief){const conflicts=[...b.requiredTopics.filter(t=>b.forbiddenTopics.some(f=>contains(t,f)||contains(f,t))),...b.requiredKeywords.filter(t=>b.forbiddenKeywords.some(f=>contains(t,f)||contains(f,t)))];if(conflicts.length)b.unresolvedRules.push('Required and forbidden rules conflict: '+conflicts.join(', '));if(b.requiredCTA&&b.forbiddenCTA&&(contains(b.requiredCTA,b.forbiddenCTA)||contains(b.forbiddenCTA,b.requiredCTA)))b.unresolvedRules.push('Required and forbidden CTA rules conflict.');for(const [value,use]of [[b.logoRequirements,'LOGO_TOP_RIGHT'],[b.musicRequirements,'BACKGROUND_MUSIC']]as const)if(value&&requirementPolicy(value)==='OFF'&&b.assetInstructions.some(a=>a.required&&a.use===use))b.unresolvedRules.push('A required asset conflicts with the instruction to omit it: '+use);b.unresolvedRules=[...new Set(b.unresolvedRules)];}
export type CampaignCandidate = {
    id: string;
    transcriptText: string;
    topic?: string | null;
    chapterSummary?: string | null;
    contentPotential?: number;
    overallScore?: number;
    duration?: number;
    startTime: number;
    endTime: number;
    standaloneScore?: number;
    hookScore?: number;
    endCompleteness?: number;
};
export function campaignMatch(c: CampaignCandidate, b: StructuredCampaignBrief) {
    const text = [c.transcriptText, c.topic, c.chapterSummary].filter(Boolean).join(' '), duration = c.endTime - c.startTime;
    const forbidden = [...b.forbiddenTopics, ...b.forbiddenKeywords].filter(t => contains(text, t));
    const topics = b.requiredTopics.map(t => Math.max(semanticSimilarity.similarity(text, t), semanticSimilarity.similarity(c.topic ?? '', t), semanticSimilarity.similarity(c.chapterSummary ?? '', t)));
    const requiredKeywords = b.requiredKeywords.filter(t => contains(text, t)).length;
    const durationPass = (b.minDurationSec === null || duration >= b.minDurationSec - .05) && (b.maxDurationSec === null || duration <= b.maxDurationSec + .05);
    const topicScore = topics.length ? topics.reduce((a, v) => a + v, 0) / topics.length : 1;
    const preferred = b.preferredTopics.length ? Math.max(...b.preferredTopics.map(t => semanticSimilarity.similarity(text, t))) : 0;
    const match = Math.round(100 * (.5 * topicScore + .2 * (b.requiredKeywords.length ? requiredKeywords / b.requiredKeywords.length : 1) + .2 * Number(durationPass) + .1 * preferred));
    return { score: Math.min(100, match), excluded: forbidden.length > 0 || !durationPass || topics.some(v => v < .15) || requiredKeywords < b.requiredKeywords.length, reasons: [...forbidden.map(t => 'Forbidden: ' + t), ...(!durationPass ? ['Outside confirmed duration range'] : []), ...(topics.some(v => v < .15) ? ['Required topic not supported by cached content evidence'] : []), ...(requiredKeywords < b.requiredKeywords.length ? ['Required keyword is not supported by source speech'] : [])] };
}
/** Receives only the engine's already usable, semantically complete candidates. It never repairs or expands boundaries. */
export function rankCampaignCandidates<T extends CampaignCandidate>(pool: T[], context: CampaignGenerationContext, semantic?: Map<string, number>): T[] {
    return pool.map(c => ({ c, match: campaignMatch(c, context.brief) })).filter(v => !v.match.excluded).sort((a, b) => {
        const score = (v: typeof a) => .55 * (v.c.contentPotential ?? v.c.overallScore ?? 0) + .3 * (semantic?.get(v.c.id) ?? v.match.score) + .1 * (v.c.standaloneScore ?? 50) + .05 * (v.c.hookScore ?? 50);
        return score(b) - score(a) || a.c.startTime - b.c.startTime;
    }).map(v => v.c);
}
export type ComplianceProject = {
    revision: number;
    settings: any;
    elements: Array<any>;
    assets: Array<any>;
};
export function socialPackage(b: StructuredCampaignBrief, content: {
    caption?: string | null;
    hashtags?: unknown;
    transcriptText?: string | null;
}): SocialPostPackage {
    const caption = content.caption?.trim() || content.transcriptText?.trim().slice(0, 400) || '';
    const banned = (s: string) => b.forbiddenKeywords.some(k => contains(s, k));
    const mentions = b.requiredMentions.filter(mention => !hasMention(caption,mention));
    return { caption: banned(caption) ? '' : [caption, mentions.join(' ')].filter(Boolean).join('\n'), alternateCaptions: [], hashtags: unique([...b.requiredHashtags, ...(Array.isArray(content.hashtags) ? content.hashtags.filter((v): v is string => typeof v === 'string' && /^#[\p{L}\p{N}_]+$/u.test(v)) : [])]).filter(v => !banned(v)), requiredMentions: b.requiredMentions, cta: b.requiredCTA, postingNotes: [b.postingRules, b.submissionRules].filter(Boolean).join('\n') };
}
export function evaluateCampaignCompliance(b: StructuredCampaignBrief, p: ComplianceProject, sourceText: string, social: SocialPostPackage, version: number): CampaignCompliance {
    const checks: CampaignCheck[] = [], add = (code: string, status: CampaignCheck['status'], detail: string, fixable = false) => checks.push({ code, status, detail, fixable });
    const layout = videoLayout(p.elements), duration = layout.reduce((n, e) => Math.max(n, e.end), 0);
    const visible = p.elements.filter(e => e.properties?.hidden !== true && Number(e.properties?.opacity ?? 1) > 0 && Number(e.duration)>0&&Number(e.startTime??0)<duration&&Number(e.startTime??0)+Number(e.duration)>0), texts = visible.filter(e => ['TEXT', 'SUBTITLE'].includes(e.type)).map(e => String(e.properties?.content ?? '')).join(' ');
    add('DURATION', duration > 0 && (b.minDurationSec === null || duration >= b.minDurationSec - .05) && (b.maxDurationSec === null || duration <= b.maxDurationSec + .05) ? 'PASS' : 'FAIL', `Edited duration ${duration.toFixed(2)}s; allowed ${b.minDurationSec ?? 'any'}–${b.maxDurationSec ?? 'any'}s.`);
    for (const [code, terms, forbidden] of [['REQUIRED_TOPIC', b.requiredTopics, false], ['FORBIDDEN_TOPIC', b.forbiddenTopics, true], ['REQUIRED_KEYWORD', b.requiredKeywords, false], ['FORBIDDEN_KEYWORD', b.forbiddenKeywords, true]] as const) {
        if (!terms.length) {
            add(code, 'NOT_APPLICABLE', 'No confirmed rule.');
            continue;
        }
        const checkText=sourceText+' '+texts+(forbidden?' '+social.caption+' '+social.hashtags.join(' ')+' '+social.cta:'');
        const hits=terms.filter(t=>contains(checkText,t)||(code==='REQUIRED_TOPIC'&&semanticSimilarity.similarity(sourceText,t)>=.4));
        if(forbidden&&hits.length){add(code,'FAIL','Forbidden content found: '+hits.join(', '));continue;}
        if (!sourceText.trim()) {
            add(code, 'UNKNOWN', 'Source speech evidence is missing.');
            continue;
        }
        const okay = forbidden ? !hits.length : hits.length === terms.length;
        add(code, okay?'PASS':forbidden||code==='REQUIRED_KEYWORD'?'FAIL':'UNKNOWN', okay ? 'Supported by available transcript/text evidence.' : forbidden ? 'Forbidden content found: ' + hits.join(', ') : 'Review topic/word support in the edited speech.');
    }
    const assetById = new Map(p.assets.map(a => [a.id, a]));
    const mappedLogos = visible.filter(e => e.type === 'IMAGE' && b.assetInstructions.some(a => a.required && a.use === 'LOGO_TOP_RIGHT' && assetById.get(e.assetId)?.metadata?.campaignAssetId === a.assetId));
    const overlap = mappedLogos.some(logo => visible.some(e => {
        if (e.type !== 'TEXT' || Number(e.properties?.zIndex ?? 30) <= Number(logo.properties?.zIndex ?? 20)) return false;
        const a = logo.properties ?? {}, t = e.properties ?? {};
        return Number(t.x) < Number(a.x) + Number(a.width) && Number(t.x) + Number(t.width) > Number(a.x) && Number(t.y) < Number(a.y) + Number(a.height) + .015 && Number(t.y) + Number(t.height) > Number(a.y) - .015;
    }));
    if (overlap) add('LOGO_VISIBILITY', 'WARN', 'Text overlaps the required logo. Review the visible brand mark in the editor and export; manual text placement is preserved.');
    for (const [code, requirement, use, type] of [['LOGO', b.logoRequirements, 'LOGO_TOP_RIGHT', 'IMAGE'], ['MUSIC', b.musicRequirements, 'BACKGROUND_MUSIC', 'AUDIO'], ['IMAGE', b.brandingRequirements, 'IMAGE_OVERLAY', 'IMAGE']] as const) {
        const policy=requirement?requirementPolicy(requirement):'REQUIRED';
        if(policy==='OFF'){const present=visible.some(e=>e.type===type&&(type==='AUDIO'||assetById.get(e.assetId)?.metadata?.campaignAssetId));add(code,present?'FAIL':'PASS','The confirmed rule excludes '+code.toLowerCase()+'.');continue;}
        if(policy==='OPTIONAL'){add(code,'NOT_APPLICABLE','This media is optional.');continue;}
        const required = b.assetInstructions.filter(a => a.required && a.use === use);
        if (!requirement && !required.length) {
            add(code, 'NOT_APPLICABLE', 'No confirmed requirement.');
            continue;
        }
        if (!required.length) {
            add(code, 'UNKNOWN', 'Select an explicit required campaign asset and intended use.');
            continue;
        }
        const missing = required.filter(a => { const matched = visible.filter(e => e.type === type && assetById.get(e.assetId)?.metadata?.campaignAssetId === a.assetId); if (type === 'AUDIO') {
            let end = 0;
            for (const e of matched.filter(e => !e.properties?.muted && Number(e.properties?.volume ?? 1) > 0).sort((a, b) => a.startTime - b.startTime)) {
                if (e.startTime > end + .05)
                    break;
                end = Math.max(end, e.startTime + e.duration);
            }
            return end < duration - .05;
        } return !matched.some(e => a.use !== 'LOGO_TOP_RIGHT' || Number(e.properties?.x) >= .5 && Number(e.properties?.x) + Number(e.properties?.width ?? .2) >= .9 && Number(e.properties?.y) <= .15); });
        add(code, missing.length ? 'FAIL' : 'PASS', missing.length ? 'Required mapped asset is absent, hidden or muted.' : 'Confirmed campaign asset is present.', !!missing.length);
    }
    add('CAPTIONS', !b.captionRequirements||requirementPolicy(b.captionRequirements)==='OPTIONAL'?'NOT_APPLICABLE':requirementPolicy(b.captionRequirements)==='OFF' ? (visible.some(e=>e.type==='SUBTITLE'&&String(e.properties?.content??'').trim()) ? 'FAIL' : 'PASS') : visible.some(e=>e.type==='SUBTITLE'&&String(e.properties?.content??'').trim()) ? 'PASS' : 'FAIL', b.captionRequirements || 'No caption rule.', !!b.captionRequirements && !/^(none|off|no captions)$/i.test(b.captionRequirements));
    add('HEADLINE', !b.hookRequirements ? 'NOT_APPLICABLE' : visible.some(e=>e.type==='TEXT'&&e.properties?.content&&(e.properties.presetRole==='HOOK'||e.properties.templateRole==='HOOK')) ? 'WARN' : 'FAIL', b.hookRequirements ? 'Review the headline against: ' + b.hookRequirements : 'No hook rule.');
    add('CTA', !b.requiredCTA ? 'NOT_APPLICABLE' : contains(texts, b.requiredCTA) ? 'PASS' : 'FAIL', b.requiredCTA ? 'Required on-screen CTA: ' + b.requiredCTA : 'No CTA requirement.', !!b.requiredCTA);
    add('FORBIDDEN_CTA', !b.forbiddenCTA ? 'NOT_APPLICABLE' : contains(texts + ' ' + social.caption, b.forbiddenCTA) ? 'FAIL' : 'PASS', b.forbiddenCTA || 'No forbidden CTA.');
    add('REQUIRED_TEXT', !b.requiredText ? 'NOT_APPLICABLE' : contains(texts, b.requiredText) ? 'PASS' : 'FAIL', b.requiredText || 'No text requirement.', !!b.requiredText);
    add('ASPECT_RATIO', !b.aspectRatio ? 'NOT_APPLICABLE' : p.settings?.aspectRatio === b.aspectRatio ? 'PASS' : 'FAIL', `Expected ${b.aspectRatio ?? 'any'}; current ${p.settings?.aspectRatio ?? 'unknown'}.`, !!b.aspectRatio);
    add('HASHTAGS', !b.requiredHashtags.length ? 'NOT_APPLICABLE' : b.requiredHashtags.every(h => social.hashtags.includes(h)) ? 'PASS' : 'FAIL', b.requiredHashtags.join(', ') || 'No required hashtags.');
    add('MENTIONS', !b.requiredMentions.length ? 'NOT_APPLICABLE' : b.requiredMentions.every(mention => hasMention(social.caption,mention)) ? 'PASS' : 'FAIL', b.requiredMentions.join(', ') || 'No required mentions.');
    for (const [code, rule] of [['TONE', b.tone], ['AUDIENCE', b.audience], ['BRANDING', b.brandingRequirements], ['MUSIC_DETAIL', b.musicRequirements], ['CAPTION_DETAIL', b.captionRequirements], ['REFERENCE_STYLE', b.referenceStyleHints], ['BRAND_COLOR', b.brandColor], ['POSTING', b.postingRules], ['SUBMISSION', b.submissionRules], ['CONTENT_DO', b.contentDo.join('; ')], ['CONTENT_DONT', b.contentDont.join('; ')]] as const)
        if (rule)
            add(code, 'WARN', 'Human review: ' + rule);
    if (b.unresolvedRules.length)
        add('UNKNOWN_RULE', 'UNKNOWN', 'Unresolved: ' + b.unresolvedRules.join('; '));
    const applicable = checks.filter(c => c.status !== 'NOT_APPLICABLE'), score = applicable.length ? Math.round(100 * applicable.filter(c => c.status === 'PASS').length / applicable.length) : null;
    const status = checks.some(c => c.status === 'FAIL') ? 'FAIL' : checks.some(c => c.status === 'UNKNOWN') ? 'UNKNOWN' : checks.some(c => c.status === 'WARN') ? 'WARN' : 'PASS';
    return { overallScore: score, status, checks, revision: p.revision, briefVersion: version };
}
