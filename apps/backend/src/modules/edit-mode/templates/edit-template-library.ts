// EditMode Workstream F: the built-in template library.
//
// Twelve product-owned style policies, defined in code and version-controlled
// with it. Each one is an opinion about typography, colour, framing and audio
// for a kind of video - nothing here is copied from any third-party product,
// and nothing here makes a claim about the content of a particular video.
//
// A built-in is exactly the same shape as a user-saved template, so the preview,
// the diff, the apply path and the tests are shared rather than duplicated.

import { readTemplate, TEMPLATE_SCHEMA_VERSION, type EditTemplate } from './edit-template-schema';

export const BUILTIN_TEMPLATE_IDS = ['CLEAN_REEL', 'BOLD_SOCIAL', 'PODCAST_PRO', 'EDUCATIONAL',
  'PRODUCT_PROMO', 'MINIMAL_BUSINESS', 'MOTIVATIONAL', 'CINEMATIC', 'TALKING_HEAD',
  'SCREEN_TUTORIAL', 'GAMING_CLIP', 'NEWS_EXPLAINER'] as const;
export type BuiltinTemplateId = typeof BUILTIN_TEMPLATE_IDS[number];

/** A short, neutral line for the card. Describes the STYLE, never the content. */
type Definition = Omit<EditTemplate, 'version' | 'source'>;

const template = (definition: Definition): EditTemplate =>
  readTemplate({ ...definition, version: TEMPLATE_SCHEMA_VERSION },
    { id: definition.id, name: definition.name, description: definition.description,
      source: 'BUILTIN' });

const DEFINITIONS: Definition[] = [
  {
    id: 'CLEAN_REEL', name: 'Clean Reel',
    description: 'Vertical, clean captions, a safe amount of movement and a neutral grade.',
    project: { aspectRatio: '9:16', pacing: 'MODERATE' },
    text: { defaultStyleId: 'BASIC', hookStyleId: 'HOOK', ctaStyleId: 'CTA' },
    captions: { styleId: 'CLEAN', placement: 'LOWER', activeWord: false, uppercase: false },
    logo: { placement: 'TOP_RIGHT', scale: 0.16 },
    color: { filterId: 'CLEAN', strength: 1 },
    audio: { musicVolume: 0.22, duckEnabled: true, duckStrength: 'MEDIUM', fadeInSec: 0.6,
      fadeOutSec: 0.8 },
    zoom: 'SUBTLE', reframe: 'AUTO', informationRegion: 'RESPECT',
    assets: { logoAssetId: null, musicAssetId: null }
  },
  {
    id: 'BOLD_SOCIAL', name: 'Bold Social',
    description: 'Heavy outlined captions with a live word, a strong headline and vivid colour.',
    project: { aspectRatio: '9:16', pacing: 'TIGHT' },
    text: { defaultStyleId: 'BOLD_SOCIAL', hookStyleId: 'BOLD_SOCIAL', ctaStyleId: 'CTA' },
    captions: { styleId: 'BOLD_HIGHLIGHT', placement: 'CENTER', activeWord: true,
      uppercase: true },
    logo: { placement: 'TOP_RIGHT', scale: 0.18 },
    color: { filterId: 'VIBRANT', strength: 1 },
    audio: { musicVolume: 0.35, duckEnabled: true, duckStrength: 'STRONG', fadeInSec: 0.3,
      fadeOutSec: 0.6 },
    zoom: 'MODERATE', reframe: 'FACE_FOCUSED', informationRegion: 'RESPECT',
    assets: { logoAssetId: null, musicAssetId: null }
  },
  {
    id: 'PODCAST_PRO', name: 'Podcast Pro',
    description: 'Speech first: a wide readable caption band, gentle movement and ducked music.',
    project: { aspectRatio: '9:16', pacing: 'MODERATE' },
    text: { defaultStyleId: 'LOWER_THIRD', hookStyleId: 'HOOK', ctaStyleId: 'CTA' },
    captions: { styleId: 'PODCAST', placement: 'LOWER', activeWord: true, uppercase: false },
    logo: { placement: 'TOP_LEFT', scale: 0.14 },
    color: { filterId: 'CLEAN', strength: 0.8 },
    audio: { musicVolume: 0.15, duckEnabled: true, duckStrength: 'STRONG', fadeInSec: 1,
      fadeOutSec: 1.2 },
    zoom: 'SUBTLE', reframe: 'FACE_FOCUSED', informationRegion: 'RESPECT',
    assets: { logoAssetId: null, musicAssetId: null }
  },
  {
    id: 'EDUCATIONAL', name: 'Educational',
    description: 'Maximum readability: a quiet caption band, minimal movement, protected frames.',
    project: { aspectRatio: '9:16', pacing: 'RELAXED' },
    text: { defaultStyleId: 'HEADING', hookStyleId: 'TITLE', ctaStyleId: 'CTA' },
    captions: { styleId: 'EDUCATIONAL', placement: 'LOWER', activeWord: true, uppercase: false },
    logo: { placement: 'TOP_RIGHT', scale: 0.14 },
    color: { filterId: 'CLEAN', strength: 0.6 },
    audio: { musicVolume: 0.12, duckEnabled: true, duckStrength: 'STRONG', fadeInSec: 1,
      fadeOutSec: 1 },
    zoom: 'OFF', reframe: 'INFORMATION_PRESERVING', informationRegion: 'PRESERVE',
    assets: { logoAssetId: null, musicAssetId: null }
  },
  {
    id: 'PRODUCT_PROMO', name: 'Product Promo',
    description: 'Commercial contrast, a call-to-action style and room for a logo.',
    project: { aspectRatio: '9:16', pacing: 'TIGHT' },
    text: { defaultStyleId: 'TITLE', hookStyleId: 'HOOK', ctaStyleId: 'CTA' },
    captions: { styleId: 'SOCIAL', placement: 'CENTER', activeWord: true, uppercase: true },
    logo: { placement: 'TOP_RIGHT', scale: 0.22 },
    color: { filterId: 'HIGH_CONTRAST', strength: 0.75 },
    audio: { musicVolume: 0.4, duckEnabled: true, duckStrength: 'MEDIUM', fadeInSec: 0.3,
      fadeOutSec: 0.5 },
    zoom: 'MODERATE', reframe: 'AUTO', informationRegion: 'RESPECT',
    assets: { logoAssetId: null, musicAssetId: null }
  },
  {
    id: 'MINIMAL_BUSINESS', name: 'Minimal Business',
    description: 'Restrained type, a barely-there grade and almost no movement.',
    project: { aspectRatio: 'SOURCE', pacing: 'MODERATE' },
    text: { defaultStyleId: 'MINIMAL', hookStyleId: 'MINIMAL', ctaStyleId: 'MINIMAL' },
    captions: { styleId: 'MINIMAL', placement: 'LOWER', activeWord: false, uppercase: false },
    logo: { placement: 'BOTTOM_RIGHT', scale: 0.12 },
    color: { filterId: 'CLEAN', strength: 0.4 },
    audio: { musicVolume: 0.12, duckEnabled: true, duckStrength: 'SUBTLE', fadeInSec: 1,
      fadeOutSec: 1 },
    zoom: 'OFF', reframe: 'SOURCE', informationRegion: 'RESPECT',
    assets: { logoAssetId: null, musicAssetId: null }
  },
  {
    id: 'MOTIVATIONAL', name: 'Motivational',
    description: 'Bold uppercase captions, a warm vivid look and stronger emphasis.',
    project: { aspectRatio: '9:16', pacing: 'STRONG' },
    text: { defaultStyleId: 'BOLD_SOCIAL', hookStyleId: 'BOLD_SOCIAL', ctaStyleId: 'CTA' },
    captions: { styleId: 'BOLD_HIGHLIGHT', placement: 'CENTER', activeWord: true,
      uppercase: true },
    logo: { placement: 'TOP_RIGHT', scale: 0.16 },
    color: { filterId: 'WARM', strength: 1 },
    audio: { musicVolume: 0.38, duckEnabled: true, duckStrength: 'MEDIUM', fadeInSec: 0.4,
      fadeOutSec: 1 },
    zoom: 'MODERATE', reframe: 'FACE_FOCUSED', informationRegion: 'RESPECT',
    assets: { logoAssetId: null, musicAssetId: null }
  },
  {
    id: 'CINEMATIC', name: 'Cinematic',
    description: 'A graded filmic look with quiet typography and restrained movement.',
    project: { aspectRatio: '16:9', pacing: 'RELAXED' },
    text: { defaultStyleId: 'MINIMAL', hookStyleId: 'TITLE', ctaStyleId: 'MINIMAL' },
    captions: { styleId: 'MINIMAL', placement: 'LOWER', activeWord: false, uppercase: false },
    logo: { placement: 'BOTTOM_RIGHT', scale: 0.1 },
    color: { filterId: 'CINEMATIC', strength: 1 },
    audio: { musicVolume: 0.3, duckEnabled: true, duckStrength: 'SUBTLE', fadeInSec: 1.5,
      fadeOutSec: 2 },
    zoom: 'SUBTLE', reframe: 'AUTO', informationRegion: 'RESPECT',
    assets: { logoAssetId: null, musicAssetId: null }
  },
  {
    id: 'TALKING_HEAD', name: 'Talking Head',
    description: 'Face-safe framing with large readable captions and moderate movement.',
    project: { aspectRatio: '9:16', pacing: 'MODERATE' },
    text: { defaultStyleId: 'LOWER_THIRD', hookStyleId: 'HOOK', ctaStyleId: 'CTA' },
    captions: { styleId: 'HIGH_CONTRAST', placement: 'LOWER', activeWord: true,
      uppercase: false },
    logo: { placement: 'TOP_LEFT', scale: 0.14 },
    color: { filterId: 'CLEAN', strength: 0.9 },
    audio: { musicVolume: 0.16, duckEnabled: true, duckStrength: 'STRONG', fadeInSec: 0.8,
      fadeOutSec: 1 },
    zoom: 'MODERATE', reframe: 'FACE_FOCUSED', informationRegion: 'RESPECT',
    assets: { logoAssetId: null, musicAssetId: null }
  },
  {
    id: 'SCREEN_TUTORIAL', name: 'Screen Tutorial',
    description: 'Protects on-screen detail: no crop-in, no movement, captions kept clear of it.',
    project: { aspectRatio: 'SOURCE', pacing: 'RELAXED' },
    text: { defaultStyleId: 'LOWER_THIRD', hookStyleId: 'TITLE', ctaStyleId: 'MINIMAL' },
    captions: { styleId: 'HIGH_CONTRAST', placement: 'UPPER', activeWord: false,
      uppercase: false },
    logo: { placement: 'BOTTOM_RIGHT', scale: 0.1 },
    color: { filterId: 'ORIGINAL', strength: 1 },
    audio: { musicVolume: 0.1, duckEnabled: true, duckStrength: 'STRONG', fadeInSec: 0.8,
      fadeOutSec: 0.8 },
    zoom: 'OFF', reframe: 'INFORMATION_PRESERVING', informationRegion: 'PRESERVE',
    assets: { logoAssetId: null, musicAssetId: null }
  },
  {
    id: 'GAMING_CLIP', name: 'Gaming Clip',
    description: 'High contrast and punchy colour with heavy captions and quick emphasis.',
    project: { aspectRatio: '9:16', pacing: 'STRONG' },
    text: { defaultStyleId: 'BOLD_SOCIAL', hookStyleId: 'BOLD_SOCIAL', ctaStyleId: 'CTA' },
    captions: { styleId: 'SOCIAL', placement: 'CENTER', activeWord: true, uppercase: true },
    logo: { placement: 'TOP_LEFT', scale: 0.18 },
    color: { filterId: 'HIGH_CONTRAST', strength: 1 },
    audio: { musicVolume: 0.45, duckEnabled: true, duckStrength: 'MEDIUM', fadeInSec: 0.2,
      fadeOutSec: 0.4 },
    zoom: 'STRONG', reframe: 'AUTO', informationRegion: 'RESPECT',
    assets: { logoAssetId: null, musicAssetId: null }
  },
  {
    id: 'NEWS_EXPLAINER', name: 'News / Explainer',
    description: 'A professional lower caption band, steady framing and no aggressive movement.',
    project: { aspectRatio: '9:16', pacing: 'MODERATE' },
    text: { defaultStyleId: 'LOWER_THIRD', hookStyleId: 'TITLE', ctaStyleId: 'MINIMAL' },
    captions: { styleId: 'CLEAN', placement: 'LOWER', activeWord: false, uppercase: false },
    logo: { placement: 'TOP_RIGHT', scale: 0.14 },
    color: { filterId: 'COOL', strength: 0.7 },
    audio: { musicVolume: 0.14, duckEnabled: true, duckStrength: 'STRONG', fadeInSec: 0.8,
      fadeOutSec: 1 },
    zoom: 'SUBTLE', reframe: 'INFORMATION_PRESERVING', informationRegion: 'PRESERVE',
    assets: { logoAssetId: null, musicAssetId: null }
  }
];

export const BUILTIN_TEMPLATES: Readonly<Record<string, EditTemplate>> = Object.freeze(
  Object.fromEntries(DEFINITIONS.map((definition) => [definition.id, template(definition)])));

export const builtinTemplateList = (): EditTemplate[] =>
  BUILTIN_TEMPLATE_IDS.map((id) => BUILTIN_TEMPLATES[id]);

export const isBuiltinTemplateId = (value: unknown): value is BuiltinTemplateId =>
  typeof value === 'string' && (BUILTIN_TEMPLATE_IDS as readonly string[]).includes(value);
