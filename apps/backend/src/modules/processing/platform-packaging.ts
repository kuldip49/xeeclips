import type { TargetPlatform } from './clip-selection-policy';

// Platform-aware packaging of an already-understood clip.
//
// The clip's meaning is produced once (transcript, evidence, clip understanding)
// and never varies by platform. What varies is packaging: the register of the
// caption, how many hashtags are worth carrying, and which angle of the same
// truthful promise reads as native on the surface. Nothing here invents facts,
// claims a trend, or promises performance - these are ranking and formatting
// preferences, not guarantees.

export type CaptionStyle = 'CONVERSATIONAL_EMOTIONAL' | 'PUNCHY_CURIOSITY' |
  'CLEAR_SEARCHABLE' | 'PLATFORM_NEUTRAL';
export type HashtagStrategy = 'BROAD_PLUS_NICHE' | 'TIGHT_TOPICAL' | 'MINIMAL_SEARCH' |
  'BALANCED_DEFAULT';

export type PlatformPackaging = {
  captionStyle: CaptionStyle;
  hashtagStrategy: HashtagStrategy;
  // Defaults, not hard rules: a compact relevant set always beats a padded one,
  // so the minimum is what the platform needs and the maximum is where extra
  // tags stop adding discovery.
  hashtags: { min: number; target: number; max: number };
  captionChars: { target: number; max: number };
  guidance: string;
};

export const PLATFORM_PACKAGING: Record<TargetPlatform, PlatformPackaging> = {
  INSTAGRAM_REELS: {
    captionStyle: 'CONVERSATIONAL_EMOTIONAL', hashtagStrategy: 'BROAD_PLUS_NICHE',
    hashtags: { min: 3, target: 6, max: 8 }, captionChars: { target: 220, max: 600 },
    guidance: 'Instagram Reels: a short conversational opening line, then the context that makes ' +
      'the clip land emotionally. A natural reaction prompt only when the clip genuinely invites ' +
      'one. No hashtag spam, no wall of text, no emoji clutter. 3-8 highly relevant hashtags ' +
      'mixing the broad topic with the specific niche and any central named entity.'
  },
  TIKTOK: {
    captionStyle: 'PUNCHY_CURIOSITY', hashtagStrategy: 'TIGHT_TOPICAL',
    hashtags: { min: 3, target: 5, max: 6 }, captionChars: { target: 140, max: 400 },
    guidance: 'TikTok: punchy and conversational, curiosity first, context fast, in the register ' +
      'a person would actually speak. Humour only when the clip supports it. 3-6 strong hashtags ' +
      'tied to the actual topic - never a hashtag cloud, never a trend tag the clip has nothing ' +
      'to do with.'
  },
  YOUTUBE_SHORTS: {
    captionStyle: 'CLEAR_SEARCHABLE', hashtagStrategy: 'MINIMAL_SEARCH',
    hashtags: { min: 2, target: 3, max: 4 }, captionChars: { target: 200, max: 500 },
    guidance: 'YouTube Shorts: a clear topic statement in searchable wording, concise, and ' +
      'accurate about what the viewer will actually get. Name the subject and the concrete ' +
      'point. Keep hashtags minimal (2-4): the title, thumbnail and content matter far more ' +
      'than tags here, so do not stuff them.'
  }
};

const DEFAULT_PACKAGING: PlatformPackaging = {
  captionStyle: 'PLATFORM_NEUTRAL', hashtagStrategy: 'BALANCED_DEFAULT',
  hashtags: { min: 3, target: 5, max: 5 }, captionChars: { target: 200, max: 600 },
  guidance: 'No target platform selected: write a clear, natural caption that would read well on ' +
    'any short-form surface, with 5 relevant hashtags.'
};

export function packagingFor(platform: TargetPlatform | null | undefined): PlatformPackaging {
  return platform ? PLATFORM_PACKAGING[platform] : DEFAULT_PACKAGING;
}

/** The packaging instructions appended to a creative-generation system prompt. */
export function platformPackagingPrompt(platform: TargetPlatform | null | undefined) {
  const packaging = packagingFor(platform);
  return (platform ? `Target platform: ${platform}. ` : '') + packaging.guidance +
    ' Packaging only: never change, soften or exaggerate what the clip actually says to fit a ' +
    'platform, and never claim or imply a trend that is not evidenced here.';
}

const tagKey = (tag: string) => tag.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const terms = (value: string) => new Set((value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  .filter((word) => word.length >= 4));

/**
 * Trims or tops up an already-relevant, already-ranked hashtag set to the count
 * the platform actually rewards. Tags only ever come from the pool the generator
 * produced for this clip, so this can add discovery but never invents a tag.
 */
export function adaptHashtagsForPlatform(platform: TargetPlatform | null | undefined,
  chosen: string[], pool: string[] = [], relevanceText = ''): string[] {
  const { hashtags } = packagingFor(platform);
  const source = terms(relevanceText);
  const seen = new Set<string>();
  const clean = (tag: string) => {
    const value = '#' + String(tag ?? '').replace(/^#+/u, '').replace(/[^\p{L}\p{N}_]/gu, '');
    return value.length > 1 ? value : '';
  };
  const ordered: string[] = [];
  for (const tag of [...chosen, ...pool].map(clean)) {
    const key = tagKey(tag);
    if (!tag || !key || seen.has(key) || /^(?:viral|fyp|foryou|foryoupage|trending)$/u.test(key)) continue;
    seen.add(key);
    ordered.push(tag);
  }
  if (!ordered.length) return [];
  // Beyond the platform's target, a tag has to be demonstrably about this clip
  // to be worth carrying; padding a set with loosely related tags is spam.
  const relevant = (tag: string) => !source.size ||
    [...source].some((term) => tagKey(tag).includes(term));
  const kept = ordered.slice(0, hashtags.target);
  for (const tag of ordered.slice(hashtags.target)) {
    if (kept.length >= hashtags.max) break;
    if (relevant(tag)) kept.push(tag);
  }
  return kept.slice(0, Math.max(hashtags.min, Math.min(kept.length, hashtags.max)));
}

/**
 * Package consistency: every delivered part must be about the same clip. This is
 * a measurement, not a rewrite - the critic already enforces grounding, and this
 * records whether the shipped hook, caption, synopsis and hashtags still point at
 * the same subject after packaging.
 */
export function packageConsistency(input: { transcript: string; hook?: string;
  caption?: string; synopsis?: string; hashtags?: string[] }) {
  const source = terms(input.transcript);
  const shares = (value: string) => !source.size || [...terms(value)]
    .some((word) => source.has(word));
  const tagShares = (tag: string) => [...source].some((word) => tagKey(tag).includes(word));
  const parts = { hookOnTopic: input.hook ? shares(input.hook) : null,
    captionOnTopic: input.caption ? shares(input.caption) : null,
    synopsisOnTopic: input.synopsis ? shares(input.synopsis) : null,
    hashtagsOnTopic: input.hashtags?.length ? input.hashtags.some(tagShares) : null };
  return { ...parts,
    packageConsistent: Object.values(parts).every((value) => value !== false) };
}

/** Packaging metadata recorded with the clip so analytics can correlate it later. */
export function packagingTelemetry(platform: TargetPlatform | null | undefined,
  hashtags: string[]) {
  const packaging = packagingFor(platform);
  return { platform: platform ?? null, captionStyle: packaging.captionStyle,
    hashtagStrategy: packaging.hashtagStrategy, hashtagCount: hashtags.length };
}
