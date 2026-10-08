// Step 10: full templates + independent component styles.
//
// A FULL template is only a default bundle: it names one style per component.
// Every component style is independent, so a user can combine "Podcast Pro" +
// "Yellow active word" captions + "Cinematic" colour + "Subtle" zoom + "Black"
// background. Each component style is a small typed SPEC that compiles to the
// same canonical EditMode commands the editor uses (creative-style-commands.ts).
//
// Honesty rule: a style the renderer cannot really produce is listed with
// `supported: false` and a note, never silently faked.

import { AUTOMATIC_2_STREET3_LAYOUT as STREET3 } from './automatic-2-street3-layout';
import { STYLE_TWO as TWO, STYLE_TWO_ID } from '@ai-content-platform/shared/style-two.cjs';

export const STYLE_CATEGORIES = ['HOOK', 'CAPTIONS', 'TEXT', 'COLOR', 'ZOOM', 'FRAMING', 'AUDIO',
  'BACKGROUND', 'OVERLAY'] as const;
export type StyleCategory = typeof STYLE_CATEGORIES[number];

export type CaptionSpec = { preset: string; fontSize?: number; color?: string; fontWeight?: number;
  fontFamily?: string;
  uppercase?: boolean; activeWord?: boolean; activeWordColor?: string; plate?: string | 'none';
  plateOpacity?: number; strokeWidth?: number; shadow?: boolean; y?: number; hidden?: boolean };
export type HookSpec = { textStyle: string; fontSize?: number; color?: string; fontFamily?: string;
  semanticHighlightColor?: string | readonly string[]; plate?: string | 'none';
  fontWeight?: number; noStroke?: boolean; persistent?: boolean;
  /** The whole hook in `color`: inherited per-word accent runs are replaced by one run. */
  singleColor?: boolean;
  uppercase?: boolean; position?: 'TOP' | 'UPPER' | 'CENTER'; writing: 'QUESTION' | 'STATEMENT' |
    'CURIOSITY' | 'KEEP'; durationSec?: number; none?: boolean };
export type TextSpec = { textStyle: string; role?: 'SUPPORTING_LINE'; fontSize?: number;
  fontFamily?: string; color?: string; maxLines?: number; fontWeight?: number; noStroke?: boolean };
export type ColorSpec = { filterId: string; strength: number; overrides?: Record<string, number> };
export type ZoomSpec = { maxCount: number; scale: number; minSpacingSec: number;
  /** Cover the scored phrase instead of emitting a fixed short pulse. */
  phraseTimed?: boolean };
export type FramingSpec = { reframePolicy: string; layout?: 'FILL' | 'FIT';
  /** Opts into the stricter talking-head camera without changing shared defaults. */
  profile?: 'AUTOMATIC_2' };
export type AudioSpec = { musicVolume?: number; ducking?: 'LIGHT' | 'MEDIUM' | 'STRONG' | null;
  sourceVolume?: number; muteMusic?: boolean };
export type BackgroundSpec = { layout: 'FILL' | 'FIT'; fitBackground?: 'BLUR' | 'BLACK' | 'WHITE';
  hookY?: number; captionY?: number; videoScale?: number;
  composition?: 'STREET_EDITORIAL' | 'STYLE_TWO' };
export type OverlaySpec = { logoPosition: string; logoOpacity?: number };

export type StyleSpec = CaptionSpec | HookSpec | TextSpec | ColorSpec | ZoomSpec | FramingSpec |
  AudioSpec | BackgroundSpec | OverlaySpec;

export type ComponentStyle = {
  id: string; category: StyleCategory; name: string; description: string;
  supported: boolean; note?: string; spec: StyleSpec;
};

const c = (id: string, category: StyleCategory, name: string, description: string, spec: StyleSpec,
  extra: { supported?: boolean; note?: string } = {}): ComponentStyle =>
  ({ id, category, name, description, spec, supported: extra.supported ?? true,
    ...(extra.note ? { note: extra.note } : {}) });

// ------------------------------------------------------------------ HOOK (10)
const HOOKS: ComponentStyle[] = [
  c('HOOK_STYLE_TWO', 'HOOK', 'StyleTwo headline', 'Heavy condensed black headline on white.',
    { textStyle: 'HEADING', fontFamily: TWO.hookFont, fontSize: TWO.hookSize, fontWeight: 700,
      color: '#000000', singleColor: true, noStroke: true, persistent: true,
      uppercase: false, writing: 'KEEP', plate: 'none', position: 'TOP' }),
  c('HOOK_MINIMAL_QUESTION', 'HOOK', 'Minimal Question', 'Short question, clean small type.',
    { textStyle: 'HEADING', fontSize: 46, writing: 'QUESTION', position: 'UPPER', plate: 'none' }),
  c('HOOK_BOLD_QUESTION', 'HOOK', 'Bold Question', 'Loud question on a solid plate.',
    { textStyle: 'HOOK', fontSize: 60, writing: 'QUESTION', position: 'TOP', uppercase: true }),
  c('HOOK_CURIOSITY', 'HOOK', 'Curiosity', 'Open-loop line that makes people stay.',
    { textStyle: 'HOOK', fontSize: 56, writing: 'CURIOSITY', position: 'TOP' }),
  c('HOOK_STATEMENT', 'HOOK', 'Statement', 'A confident claim from the clip.',
    { textStyle: 'HEADING', fontSize: 58, writing: 'STATEMENT', position: 'UPPER' }),
  c('HOOK_DOCUMENTARY', 'HOOK', 'Documentary', 'Quiet serif title, lower emphasis.',
    { textStyle: 'TITLE', fontSize: 44, writing: 'STATEMENT', position: 'UPPER', plate: 'none' }),
  c('HOOK_NEWS', 'HOOK', 'News', 'Headline bar on a dark plate.',
    { textStyle: 'LOWER_THIRD', fontSize: 44, writing: 'STATEMENT', position: 'TOP', plate: '#B91C1C' }),
  c('HOOK_PODCAST', 'HOOK', 'Podcast', 'Clean question over a talking head.',
    { textStyle: 'HOOK', fontSize: 50, writing: 'QUESTION', position: 'TOP', plate: '#0B0F1A' }),
  c('HOOK_GAMING', 'HOOK', 'Gaming', 'Punchy uppercase with a bright plate.',
    { textStyle: 'BOLD_SOCIAL', fontSize: 64, writing: 'CURIOSITY', position: 'TOP', uppercase: true }),
  c('HOOK_LUXURY', 'HOOK', 'Luxury', 'Thin elegant serif, no plate.',
    { textStyle: 'TITLE', fontSize: 42, color: '#F5E6C8', writing: 'STATEMENT', position: 'UPPER', plate: 'none' }),
  c('HOOK_CLEAN', 'HOOK', 'Clean', 'Plain white hook, soft plate.',
    { textStyle: 'HOOK', fontSize: 52, writing: 'KEEP', position: 'TOP' }),
  c('HOOK_STREET_EDITORIAL', 'HOOK', 'Editorial serif',
    'White serif headline, highlighted words in red.',
    // street3.mp4 geometry and Garamond-class serif, no plate/outline/shadow, present
    // for the whole reel. Colour (user choice 2026-10-03): white text, the semantically
    // highlighted words in one red (replacing street3's off-white with amber/red emphasis).
    { textStyle: 'TITLE', fontFamily: STREET3.typography.fontFamily,
      fontSize: STREET3.typography.hook.fontSize, color: STREET3.colors.hookText,
      fontWeight: STREET3.typography.hook.fontWeight, noStroke: true, persistent: true,
      semanticHighlightColor: STREET3.colors.hookHighlight, writing: 'KEEP', position: 'TOP',
      plate: 'none' }),
  c('HOOK_NONE', 'HOOK', 'No hook', 'No on-screen hook text.', { textStyle: 'HOOK', writing: 'KEEP', none: true })
];

// -------------------------------------------------------------- CAPTIONS (20)
const CAPTIONS: ComponentStyle[] = [
  c('CAP_STYLE_TWO', 'CAPTIONS', 'StyleTwo red captions', 'White condensed phrase in a rounded red box.',
    { preset: 'STYLE_TWO', fontFamily: TWO.captionFont, fontSize: TWO.captionSize,
      uppercase: true, activeWord: false }),
  c('CAP_CLEAN_LOWER_THIRD', 'CAPTIONS', 'Clean lower-third', 'White on a soft plate, low.', { preset: 'CLEAN', y: 0.76 }),
  c('CAP_BOLD_SOCIAL', 'CAPTIONS', 'Bold social', 'Heavy outlined social captions.', { preset: 'BOLD_HIGHLIGHT', activeWord: false }),
  c('CAP_YELLOW_ACTIVE', 'CAPTIONS', 'Yellow active word', 'White captions, the spoken word in yellow.',
    { preset: 'BOLD_HIGHLIGHT', color: '#FFFFFF', activeWord: true, activeWordColor: '#FFD400' }),
  c('CAP_KARAOKE', 'CAPTIONS', 'Karaoke', 'Word-by-word highlight, centre screen.',
    { preset: 'SOCIAL', activeWord: true, activeWordColor: '#22D3EE' }),
  c('CAP_PODCAST', 'CAPTIONS', 'Podcast', 'Wide serif band for talking heads.', { preset: 'PODCAST' }),
  c('CAP_EDUCATIONAL', 'CAPTIONS', 'Educational', 'Quiet readable band for explainers.', { preset: 'EDUCATIONAL' }),
  c('CAP_GAMING', 'CAPTIONS', 'Gaming', 'Big uppercase with a green live word.',
    { preset: 'SOCIAL', fontSize: 54, activeWord: true, activeWordColor: '#4ADE80' }),
  c('CAP_DOCUMENTARY', 'CAPTIONS', 'Documentary', 'Small serif, no plate.',
    { preset: 'MINIMAL', fontSize: 30, shadow: true, y: 0.8 }),
  c('CAP_NEWS', 'CAPTIONS', 'News', 'Dark bar, strong legibility.',
    { preset: 'HIGH_CONTRAST', fontSize: 38, plate: '#111827', plateOpacity: 0.95 }),
  c('CAP_LUXURY', 'CAPTIONS', 'Luxury', 'Cream serif, restrained.',
    { preset: 'PODCAST', color: '#F5E6C8', plate: 'none', shadow: true, activeWord: false }),
  c('CAP_MINIMAL_WHITE', 'CAPTIONS', 'Minimal white', 'Small, plain, no plate.', { preset: 'MINIMAL' }),
  c('CAP_ACCESSIBILITY', 'CAPTIONS', 'Accessibility', 'Large, solid plate, maximum contrast.',
    { preset: 'HIGH_CONTRAST', fontSize: 50, activeWord: false }),
  c('CAP_HIGH_CONTRAST', 'CAPTIONS', 'High contrast', 'Black plate, heavy white type.', { preset: 'HIGH_CONTRAST' }),
  c('CAP_SUBTITLE_BOX', 'CAPTIONS', 'Subtitle box', 'Classic boxed subtitles.',
    { preset: 'CLEAN', plate: '#000000', plateOpacity: 0.85, fontSize: 36 }),
  c('CAP_OUTLINED', 'CAPTIONS', 'Outlined', 'No plate, thick outline.',
    { preset: 'MINIMAL', fontSize: 42, fontWeight: 800, strokeWidth: 6 }),
  c('CAP_SHADOW', 'CAPTIONS', 'Shadow', 'No plate, soft drop shadow.',
    { preset: 'MINIMAL', fontSize: 40, fontWeight: 700, shadow: true }),
  c('CAP_COMPACT', 'CAPTIONS', 'Compact', 'Small and tucked low.', { preset: 'CLEAN', fontSize: 30, y: 0.8 }),
  c('CAP_LARGE_READABLE', 'CAPTIONS', 'Large readable', 'Big, clear, plate behind.', { preset: 'CLEAN', fontSize: 52 }),
  c('CAP_TWO_LINE_PUNCHY', 'CAPTIONS', 'Two-line punchy', 'Heavy uppercase, centre.',
    { preset: 'SOCIAL', uppercase: true, activeWord: false }),
  c('CAP_MODERN_CREATOR', 'CAPTIONS', 'Modern creator', 'Clean bold with a live word.',
    { preset: 'SOCIAL', uppercase: false, activeWord: true, activeWordColor: '#FACC15' }),
  c('CAP_NONE', 'CAPTIONS', 'No captions', 'No burned-in captions.', { preset: 'CLEAN', hidden: true })
  ,c('CAP_STREET_EDITORIAL', 'CAPTIONS', 'Lime active word',
    'Heavy uppercase captions with a lime spoken word and thick black outline.',
    { preset: 'BOLD_HIGHLIGHT', fontFamily: 'Inter ExtraBold, sans-serif',
      fontSize: STREET3.typography.captions.fontSize,
      fontWeight: 900, color: STREET3.colors.captionBase, uppercase: true, activeWord: true,
      activeWordColor: STREET3.colors.captionActive, plate: 'none', strokeWidth: 7, shadow: true,
      y: STREET3.captionSafeBox.y })
];

// ------------------------------------------------------------------ TEXT (3)
const TEXTS: ComponentStyle[] = [
  c('TEXT_BASIC', 'TEXT', 'Basic', 'Plain white text with a legible stroke.', { textStyle: 'BASIC' }),
  c('TEXT_BOLD_SOCIAL', 'TEXT', 'Bold social', 'Thick outlined social text.', { textStyle: 'BOLD_SOCIAL' }),
  c('TEXT_MINIMAL', 'TEXT', 'Minimal', 'Thin, unstyled.', { textStyle: 'MINIMAL' }),
  c('TEXT_STREET_SUPPORT', 'TEXT', 'Editorial supporting line',
    'A short grounded serif line below the picture.',
    { textStyle: 'TITLE', role: 'SUPPORTING_LINE', fontFamily: STREET3.typography.fontFamily,
      fontSize: STREET3.typography.support.fontSize, color: STREET3.colors.text,
      fontWeight: STREET3.typography.support.fontWeight, noStroke: true, maxLines: 2 })
];

// ----------------------------------------------------------------- COLOR (20)
const COLORS: ComponentStyle[] = [
  c('COLOR_ORIGINAL', 'COLOR', 'Original', 'No colour change.', { filterId: 'ORIGINAL', strength: 1 }),
  c('COLOR_CLEAN', 'COLOR', 'Clean', 'Neutral, slightly crisper.', { filterId: 'CLEAN', strength: 0.8 }),
  c('COLOR_WARM', 'COLOR', 'Warm', 'Golden skin tones.', { filterId: 'WARM', strength: 0.7 }),
  c('COLOR_COOL', 'COLOR', 'Cool', 'Cooler, cleaner.', { filterId: 'COOL', strength: 0.7 }),
  c('COLOR_CINEMATIC', 'COLOR', 'Cinematic', 'Filmic contrast and tone.', { filterId: 'CINEMATIC', strength: 0.7 }),
  c('COLOR_VIBRANT', 'COLOR', 'Vibrant', 'Punchy colour.', { filterId: 'VIBRANT', strength: 0.7 }),
  c('COLOR_SOFT', 'COLOR', 'Soft', 'Lower contrast, gentle fade.', { filterId: 'SOFT', strength: 0.7 }),
  c('COLOR_HIGH_CONTRAST', 'COLOR', 'High Contrast', 'Hard, graphic.', { filterId: 'HIGH_CONTRAST', strength: 0.7 }),
  c('COLOR_VINTAGE', 'COLOR', 'Vintage', 'Faded and warm.', { filterId: 'VINTAGE', strength: 0.7 }),
  c('COLOR_BW', 'COLOR', 'B&W', 'Monochrome.', { filterId: 'BLACK_AND_WHITE', strength: 1 }),
  c('COLOR_FILMIC', 'COLOR', 'Filmic', 'Cinematic with a light fade.',
    { filterId: 'CINEMATIC', strength: 0.55, overrides: { fade: 0.12 } }),
  c('COLOR_LUXURY', 'COLOR', 'Luxury', 'Warm, rich, restrained saturation.',
    { filterId: 'WARM', strength: 0.5, overrides: { contrast: 0.12, saturation: -0.08, vignette: 0.2 } }),
  c('COLOR_MUTED', 'COLOR', 'Muted', 'Low saturation, calm.', { filterId: 'CLEAN', strength: 0.5, overrides: { saturation: -0.35 } }),
  c('COLOR_NATURAL_SKIN', 'COLOR', 'Natural Skin', 'Subtle warmth for faces.', { filterId: 'WARM', strength: 0.35 }),
  c('COLOR_BRIGHT_SOCIAL', 'COLOR', 'Bright Social', 'Bright and lively.',
    { filterId: 'VIBRANT', strength: 0.55, overrides: { exposure: 0.1 } }),
  c('COLOR_DARK_DRAMATIC', 'COLOR', 'Dark Dramatic', 'Deep shadows, vignette.',
    { filterId: 'HIGH_CONTRAST', strength: 0.55, overrides: { exposure: -0.12, vignette: 0.35 } }),
  c('COLOR_PASTEL', 'COLOR', 'Pastel', 'Soft, airy, lighter.',
    { filterId: 'SOFT', strength: 0.6, overrides: { saturation: -0.15, exposure: 0.08 } }),
  c('COLOR_DESATURATED', 'COLOR', 'Desaturated', 'Nearly monochrome.', { filterId: 'CLEAN', strength: 0.4, overrides: { saturation: -0.55 } }),
  c('COLOR_DOC_NEUTRAL', 'COLOR', 'Documentary Neutral', 'True-to-life, lightly cleaned.', { filterId: 'CLEAN', strength: 0.5 }),
  c('COLOR_GAMING_PUNCH', 'COLOR', 'Gaming Punch', 'Saturated and contrasty.',
    { filterId: 'VIBRANT', strength: 1, overrides: { contrast: 0.18 } })
];

// ------------------------------------------------------------------ ZOOM (12)
const ZOOMS: ComponentStyle[] = [
  c('ZOOM_NONE', 'ZOOM', 'None', 'No zoom.', { maxCount: 0, scale: 1.06, minSpacingSec: 0 }),
  c('ZOOM_SUBTLE', 'ZOOM', 'Subtle', 'A few gentle pushes on key words.', { maxCount: 2, scale: 1.05, minSpacingSec: 5 }),
  c('ZOOM_BALANCED', 'ZOOM', 'Balanced', 'Moderate emphasis.', { maxCount: 3, scale: 1.09, minSpacingSec: 4 }),
  c('ZOOM_STRONG', 'ZOOM', 'Strong', 'Frequent, noticeable punches.', { maxCount: 5, scale: 1.14, minSpacingSec: 3 }),
  c('ZOOM_SUBTLE_EMPHASIS', 'ZOOM', 'Subtle Emphasis', 'Only the strongest moments.', { maxCount: 2, scale: 1.06, minSpacingSec: 6 }),
  c('ZOOM_PUNCH', 'ZOOM', 'Punch Zoom', 'Quick hard punches.', { maxCount: 4, scale: 1.15, minSpacingSec: 3 }),
  c('ZOOM_SMOOTH_PUSH', 'ZOOM', 'Smooth Push', 'Slow gentle pushes.', { maxCount: 3, scale: 1.07, minSpacingSec: 5 }),
  c('ZOOM_DOC_PUSH', 'ZOOM', 'Slow Documentary Push', 'Very slow, very light.', { maxCount: 2, scale: 1.04, minSpacingSec: 8 }),
  c('ZOOM_FACE_SAFE', 'ZOOM', 'Face Safe', 'Light zooms the renderer keeps face-safe.', { maxCount: 3, scale: 1.06, minSpacingSec: 5 }),
  c('ZOOM_PRODUCT_FOCUS', 'ZOOM', 'Product Focus', 'Moderate pushes on emphasis.', { maxCount: 3, scale: 1.1, minSpacingSec: 4 }),
  c('ZOOM_NO_MOTION', 'ZOOM', 'No Motion Professional', 'Static, no zoom.', { maxCount: 0, scale: 1.06, minSpacingSec: 0 }),
  c('ZOOM_ENERGETIC', 'ZOOM', 'Energetic Social', 'Lots of energy.', { maxCount: 6, scale: 1.12, minSpacingSec: 2.5 })
  ,c('ZOOM_AUTOMATIC_2', 'ZOOM', 'Automatic 2 semantic emphasis',
    'Phrase-timed, face-safe emphasis on the strongest moments only (about one per 20 s).',
    { maxCount: 3, scale: 1.08, minSpacingSec: 8, phraseTimed: true })
];

// --------------------------------------------------------------- FRAMING (10)
const FRAMINGS: ComponentStyle[] = [
  c('FRAME_TALKING_HEAD', 'FRAMING', 'Talking-head center', 'Follow the speaker.', { reframePolicy: 'FACE_FOCUSED', layout: 'FILL' }),
  c('FRAME_FACE_PRIORITY', 'FRAMING', 'Face priority', 'Keep faces in frame.', { reframePolicy: 'FACE_FOCUSED' }),
  c('FRAME_TWO_PERSON', 'FRAMING', 'Two-person safe', 'Keep both speakers.', { reframePolicy: 'AUTO', layout: 'FIT' },
    { note: 'Approximated: the renderer has no pair-aware camera, so both people are kept by fitting the whole frame.' }),
  c('FRAME_SCREEN_TUTORIAL', 'FRAMING', 'Screen tutorial', 'Keep on-screen information readable.', { reframePolicy: 'INFORMATION_PRESERVING' }),
  c('FRAME_INFORMATION', 'FRAMING', 'Information priority', 'Protect text and charts.', { reframePolicy: 'INFORMATION_PRESERVING' }),
  c('FRAME_PRODUCT_CENTER', 'FRAMING', 'Product center', 'Static centre crop.', { reframePolicy: 'CENTERED', layout: 'FILL' },
    { note: 'Approximated as a centred crop: there is no product detector.' }),
  c('FRAME_PODCAST', 'FRAMING', 'Podcast crop', 'Speaker-focused vertical crop.', { reframePolicy: 'FACE_FOCUSED', layout: 'FILL' }),
  c('FRAME_LANDSCAPE_TO_REEL', 'FRAMING', 'Landscape-to-Reel', 'Keep the whole wide frame.', { reframePolicy: 'AUTO', layout: 'FIT' }),
  c('FRAME_CENTERED', 'FRAMING', 'Centered', 'Static centre crop.', { reframePolicy: 'CENTERED', layout: 'FILL' }),
  c('FRAME_AUTO', 'FRAMING', 'Auto', 'The shot classifier decides per shot.', { reframePolicy: 'AUTO' })
  ,c('FRAME_AUTOMATIC_2', 'FRAMING', 'Automatic 2 speaker safe',
    'Card-aware face-safe framing with stable active-speaker switching.',
    { reframePolicy: 'FACE_FOCUSED', profile: 'AUTOMATIC_2' })
];

// ----------------------------------------------------------------- AUDIO (8)
const AUDIOS: ComponentStyle[] = [
  c('AUDIO_SPEECH_FIRST', 'AUDIO', 'Speech First', 'Voice clear, music very low.', { musicVolume: 0.12, ducking: 'STRONG', sourceVolume: 1 }),
  c('AUDIO_PODCAST_BALANCE', 'AUDIO', 'Podcast Balance', 'Voice-led with a quiet bed.', { musicVolume: 0.15, ducking: 'MEDIUM', sourceVolume: 1 }),
  c('AUDIO_BACKGROUND_LOW', 'AUDIO', 'Background Low', 'Music present but low.', { musicVolume: 0.2, ducking: null }),
  c('AUDIO_CINEMATIC_BED', 'AUDIO', 'Cinematic Bed', 'A fuller music bed.', { musicVolume: 0.3, ducking: 'LIGHT' }),
  c('AUDIO_ENERGETIC_REEL', 'AUDIO', 'Energetic Reel', 'Louder music, light ducking.', { musicVolume: 0.4, ducking: 'LIGHT' }),
  c('AUDIO_SUBTLE_DUCKING', 'AUDIO', 'Subtle Ducking', 'Music dips gently under speech.', { ducking: 'LIGHT' }),
  c('AUDIO_STRONG_DUCKING', 'AUDIO', 'Strong Ducking', 'Music dips hard under speech.', { ducking: 'STRONG' }),
  c('AUDIO_VOICE_ONLY', 'AUDIO', 'Voice Only', 'No music.', { muteMusic: true, sourceVolume: 1 })
];

// ------------------------------------------------------------ BACKGROUND (8)
const BACKGROUNDS: ComponentStyle[] = [
  c('BG_STYLE_TWO', 'BACKGROUND', 'StyleTwo white composition', 'Fixed measured footage window and white lower area.',
    { layout: 'FILL', fitBackground: 'WHITE', composition: 'STYLE_TWO' }),
  c('BG_FULL_FRAME', 'BACKGROUND', 'Full frame', 'Video fills the frame.', { layout: 'FILL' }),
  c('BG_BLURRED', 'BACKGROUND', 'Blurred', 'Whole frame over a blurred copy of itself.', { layout: 'FIT', fitBackground: 'BLUR' }),
  c('BG_BLACK', 'BACKGROUND', 'Black', 'Whole frame on black.', { layout: 'FIT', fitBackground: 'BLACK' }),
  c('BG_WHITE', 'BACKGROUND', 'White', 'Whole frame on white.', { layout: 'FIT', fitBackground: 'WHITE' }),
  c('BG_SPLIT', 'BACKGROUND', 'Split', 'Two views stacked.', { layout: 'FIT', fitBackground: 'BLACK' },
    { supported: false, note: 'Split-screen needs multi-view compositing, which the renderer does not have.' }),
  c('BG_VIDEO_CARD', 'BACKGROUND', 'Video card', 'Framed card over a blurred backdrop.',
    { layout: 'FIT', fitBackground: 'BLUR', videoScale: 0.9 },
    { note: 'Approximated: a slightly inset fitted frame over blur; the card has square corners.' }),
  c('BG_HOOK_ABOVE', 'BACKGROUND', 'Hook above video', 'Headline band above the video.',
    { layout: 'FIT', fitBackground: 'BLACK', hookY: 0.08, captionY: 0.74 }),
  c('BG_CAPTION_BELOW', 'BACKGROUND', 'Caption below video', 'Captions in the band under the video.',
    { layout: 'FIT', fitBackground: 'BLACK', captionY: 0.72 }),
  c('BG_STREET_EDITORIAL', 'BACKGROUND', 'Editorial black composition',
    'Black canvas with a central picture and dedicated headline/supporting regions.',
    { layout: 'FILL', fitBackground: 'BLACK', composition: 'STREET_EDITORIAL',
      hookY: STREET3.hookBox.y, captionY: STREET3.captionSafeBox.y })
];

// --------------------------------------------------------------- OVERLAY (4)
const OVERLAYS: ComponentStyle[] = [
  c('LOGO_TOP_RIGHT', 'OVERLAY', 'Logo top right', 'Brand mark top right.', { logoPosition: 'TOP_RIGHT', logoOpacity: 0.9 }),
  c('LOGO_TOP_LEFT', 'OVERLAY', 'Logo top left', 'Brand mark top left.', { logoPosition: 'TOP_LEFT', logoOpacity: 0.9 }),
  c('LOGO_BOTTOM_RIGHT', 'OVERLAY', 'Logo bottom right', 'Quiet corner mark.', { logoPosition: 'BOTTOM_RIGHT', logoOpacity: 0.8 }),
  c('LOGO_BOTTOM_LEFT', 'OVERLAY', 'Logo bottom left', 'Quiet corner mark.', { logoPosition: 'BOTTOM_LEFT', logoOpacity: 0.8 })
];

export const COMPONENT_STYLES: ComponentStyle[] = [...HOOKS, ...CAPTIONS, ...TEXTS, ...COLORS,
  ...ZOOMS, ...FRAMINGS, ...AUDIOS, ...BACKGROUNDS, ...OVERLAYS];
const BY_ID = new Map(COMPONENT_STYLES.map((style) => [style.id, style]));
export const componentStyle = (id: string | null | undefined) => (id ? BY_ID.get(id) : undefined);
export const componentStylesFor = (category: StyleCategory) =>
  COMPONENT_STYLES.filter((style) => style.category === category);

// ------------------------------------------------------- FULL TEMPLATES
export type FullTemplate = { id: string; name: string; description: string; aspectRatio: '9:16';
  components: Partial<Record<StyleCategory, string>> };
const t = (id: string, name: string, description: string,
  components: Partial<Record<StyleCategory, string>>): FullTemplate =>
  ({ id, name, description, aspectRatio: '9:16', components });

export const FULL_TEMPLATES: FullTemplate[] = [
  // Presentation plus the shared phrase-timed zoom policy. It retains the base edit's audio, grade
  // and framing policy, but NOT the base edit's zoom events: those are Automatic 1's short punch-ins
  // (about 1.1-1.6 s). ZOOM_AUTOMATIC_2 is the one canonical emphasis policy of the stable pipeline
  // (2.5-5 s phrase-timed, face-safe, spaced, replacing inherited punches), so StyleTwo consumes
  // that decision instead of carrying a second zoom policy.
  t(STYLE_TWO_ID, 'StyleTwo', 'White canvas, condensed black headline and red boxed captions',
    { HOOK: 'HOOK_STYLE_TWO', CAPTIONS: 'CAP_STYLE_TWO', BACKGROUND: 'BG_STYLE_TWO',
      ZOOM: 'ZOOM_AUTOMATIC_2' }),
  // Automatic 2 keeps Automatic 1's timeline/cuts/grade/audio, but deliberately
  // overrides camera and zoom policy. Those are canonical editable settings and
  // EFFECT elements, not a forked renderer.
  t('AUTOMATIC_2', 'Automatic 2', 'Editorial black / serif / highlighted captions',
    // No supporting line under the picture (user choice 2026-10-03); the region stays black.
    { HOOK: 'HOOK_STREET_EDITORIAL', CAPTIONS: 'CAP_STREET_EDITORIAL',
      BACKGROUND: 'BG_STREET_EDITORIAL',
      FRAMING: 'FRAME_AUTOMATIC_2', ZOOM: 'ZOOM_AUTOMATIC_2' }),
  t('CLEAN_REEL', 'Clean Reel', 'Tidy social reel: clean captions, subtle motion.',
    { HOOK: 'HOOK_CLEAN', CAPTIONS: 'CAP_CLEAN_LOWER_THIRD', COLOR: 'COLOR_CLEAN', ZOOM: 'ZOOM_SUBTLE', FRAMING: 'FRAME_AUTO', AUDIO: 'AUDIO_BACKGROUND_LOW', BACKGROUND: 'BG_FULL_FRAME' }),
  t('PODCAST_PRO', 'Podcast Pro', 'Speaker-first podcast clip.',
    { HOOK: 'HOOK_PODCAST', CAPTIONS: 'CAP_PODCAST', COLOR: 'COLOR_NATURAL_SKIN', ZOOM: 'ZOOM_SUBTLE', FRAMING: 'FRAME_PODCAST', AUDIO: 'AUDIO_PODCAST_BALANCE', BACKGROUND: 'BG_FULL_FRAME' }),
  t('EDUCATIONAL', 'Educational', 'Readable explainer, information kept visible.',
    { HOOK: 'HOOK_STATEMENT', CAPTIONS: 'CAP_EDUCATIONAL', COLOR: 'COLOR_CLEAN', ZOOM: 'ZOOM_NONE', FRAMING: 'FRAME_INFORMATION', AUDIO: 'AUDIO_SPEECH_FIRST', BACKGROUND: 'BG_BLURRED' }),
  t('PRODUCT_PROMO', 'Product Promo', 'Punchy, bright, product-forward.',
    { HOOK: 'HOOK_BOLD_QUESTION', CAPTIONS: 'CAP_BOLD_SOCIAL', COLOR: 'COLOR_BRIGHT_SOCIAL', ZOOM: 'ZOOM_PRODUCT_FOCUS', FRAMING: 'FRAME_PRODUCT_CENTER', AUDIO: 'AUDIO_ENERGETIC_REEL', BACKGROUND: 'BG_FULL_FRAME' }),
  t('MINIMAL_BUSINESS', 'Minimal Business', 'Restrained and professional.',
    { HOOK: 'HOOK_MINIMAL_QUESTION', CAPTIONS: 'CAP_MINIMAL_WHITE', COLOR: 'COLOR_DOC_NEUTRAL', ZOOM: 'ZOOM_NO_MOTION', FRAMING: 'FRAME_FACE_PRIORITY', AUDIO: 'AUDIO_SPEECH_FIRST', BACKGROUND: 'BG_FULL_FRAME' }),
  t('MOTIVATIONAL', 'Motivational', 'Bold words, strong emphasis.',
    { HOOK: 'HOOK_STATEMENT', CAPTIONS: 'CAP_YELLOW_ACTIVE', COLOR: 'COLOR_DARK_DRAMATIC', ZOOM: 'ZOOM_BALANCED', FRAMING: 'FRAME_TALKING_HEAD', AUDIO: 'AUDIO_CINEMATIC_BED', BACKGROUND: 'BG_FULL_FRAME' }),
  t('CINEMATIC', 'Cinematic', 'Filmic look, slow pushes.',
    { HOOK: 'HOOK_DOCUMENTARY', CAPTIONS: 'CAP_SHADOW', COLOR: 'COLOR_FILMIC', ZOOM: 'ZOOM_SMOOTH_PUSH', FRAMING: 'FRAME_AUTO', AUDIO: 'AUDIO_CINEMATIC_BED', BACKGROUND: 'BG_FULL_FRAME' }),
  t('TALKING_HEAD', 'Talking Head', 'Speaker centred, clear captions.',
    { HOOK: 'HOOK_CLEAN', CAPTIONS: 'CAP_MODERN_CREATOR', COLOR: 'COLOR_NATURAL_SKIN', ZOOM: 'ZOOM_FACE_SAFE', FRAMING: 'FRAME_TALKING_HEAD', AUDIO: 'AUDIO_SPEECH_FIRST', BACKGROUND: 'BG_FULL_FRAME' }),
  t('SCREEN_TUTORIAL', 'Screen Tutorial', 'Keeps the screen readable.',
    { HOOK: 'HOOK_STATEMENT', CAPTIONS: 'CAP_COMPACT', COLOR: 'COLOR_ORIGINAL', ZOOM: 'ZOOM_NONE', FRAMING: 'FRAME_SCREEN_TUTORIAL', AUDIO: 'AUDIO_SPEECH_FIRST', BACKGROUND: 'BG_BLURRED' }),
  t('GAMING_CLIP', 'Gaming Clip', 'Loud, saturated, energetic.',
    { HOOK: 'HOOK_GAMING', CAPTIONS: 'CAP_GAMING', COLOR: 'COLOR_GAMING_PUNCH', ZOOM: 'ZOOM_ENERGETIC', FRAMING: 'FRAME_AUTO', AUDIO: 'AUDIO_ENERGETIC_REEL', BACKGROUND: 'BG_FULL_FRAME' }),
  t('NEWS_EXPLAINER', 'News/Explainer', 'Headline hook, boxed captions.',
    { HOOK: 'HOOK_NEWS', CAPTIONS: 'CAP_NEWS', COLOR: 'COLOR_DOC_NEUTRAL', ZOOM: 'ZOOM_SUBTLE', FRAMING: 'FRAME_INFORMATION', AUDIO: 'AUDIO_SPEECH_FIRST', BACKGROUND: 'BG_HOOK_ABOVE' }),
  t('FINANCE', 'Finance', 'Credible and clean with readable numbers.',
    { HOOK: 'HOOK_STATEMENT', CAPTIONS: 'CAP_EDUCATIONAL', COLOR: 'COLOR_COOL', ZOOM: 'ZOOM_SUBTLE_EMPHASIS', FRAMING: 'FRAME_INFORMATION', AUDIO: 'AUDIO_SPEECH_FIRST', BACKGROUND: 'BG_FULL_FRAME' }),
  t('REAL_ESTATE', 'Real Estate', 'Bright, warm, calm.',
    { HOOK: 'HOOK_CLEAN', CAPTIONS: 'CAP_CLEAN_LOWER_THIRD', COLOR: 'COLOR_BRIGHT_SOCIAL', ZOOM: 'ZOOM_SMOOTH_PUSH', FRAMING: 'FRAME_CENTERED', AUDIO: 'AUDIO_BACKGROUND_LOW', BACKGROUND: 'BG_FULL_FRAME' }),
  t('TECH_REVIEW', 'Tech Review', 'Crisp and cool.',
    { HOOK: 'HOOK_BOLD_QUESTION', CAPTIONS: 'CAP_MODERN_CREATOR', COLOR: 'COLOR_COOL', ZOOM: 'ZOOM_BALANCED', FRAMING: 'FRAME_AUTO', AUDIO: 'AUDIO_BACKGROUND_LOW', BACKGROUND: 'BG_FULL_FRAME' }),
  t('DOCUMENTARY', 'Documentary', 'Quiet, neutral, slow.',
    { HOOK: 'HOOK_DOCUMENTARY', CAPTIONS: 'CAP_DOCUMENTARY', COLOR: 'COLOR_DOC_NEUTRAL', ZOOM: 'ZOOM_DOC_PUSH', FRAMING: 'FRAME_AUTO', AUDIO: 'AUDIO_CINEMATIC_BED', BACKGROUND: 'BG_FULL_FRAME' }),
  t('INTERVIEW', 'Interview', 'Both speakers kept, clear captions.',
    { HOOK: 'HOOK_PODCAST', CAPTIONS: 'CAP_PODCAST', COLOR: 'COLOR_NATURAL_SKIN', ZOOM: 'ZOOM_NONE', FRAMING: 'FRAME_TWO_PERSON', AUDIO: 'AUDIO_SPEECH_FIRST', BACKGROUND: 'BG_BLURRED' }),
  t('VLOG', 'Vlog', 'Warm and personal.',
    { HOOK: 'HOOK_CURIOSITY', CAPTIONS: 'CAP_MODERN_CREATOR', COLOR: 'COLOR_WARM', ZOOM: 'ZOOM_SUBTLE', FRAMING: 'FRAME_FACE_PRIORITY', AUDIO: 'AUDIO_BACKGROUND_LOW', BACKGROUND: 'BG_FULL_FRAME' }),
  t('LUXURY', 'Luxury', 'Rich, restrained, elegant.',
    { HOOK: 'HOOK_LUXURY', CAPTIONS: 'CAP_LUXURY', COLOR: 'COLOR_LUXURY', ZOOM: 'ZOOM_DOC_PUSH', FRAMING: 'FRAME_CENTERED', AUDIO: 'AUDIO_CINEMATIC_BED', BACKGROUND: 'BG_FULL_FRAME' }),
  t('CREATOR', 'Creator', 'Modern creator look.',
    { HOOK: 'HOOK_CURIOSITY', CAPTIONS: 'CAP_YELLOW_ACTIVE', COLOR: 'COLOR_VIBRANT', ZOOM: 'ZOOM_BALANCED', FRAMING: 'FRAME_TALKING_HEAD', AUDIO: 'AUDIO_ENERGETIC_REEL', BACKGROUND: 'BG_FULL_FRAME' }),
  t('SOCIAL_STORY', 'Social Story', 'Story-style with hook band.',
    { HOOK: 'HOOK_BOLD_QUESTION', CAPTIONS: 'CAP_KARAOKE', COLOR: 'COLOR_BRIGHT_SOCIAL', ZOOM: 'ZOOM_ENERGETIC', FRAMING: 'FRAME_AUTO', AUDIO: 'AUDIO_ENERGETIC_REEL', BACKGROUND: 'BG_HOOK_ABOVE' })
];
export const fullTemplate = (id: string | null | undefined) =>
  id ? FULL_TEMPLATES.find((template) => template.id === id) : undefined;

/** The whole catalogue, for the UI. */
export function creativeCatalog() {
  return {
    categories: STYLE_CATEGORIES,
    // Legacy definitions remain resolvable for old projects/requests, but new
    // generation exposes StyleOne and StyleTwo beside the default StyleZero.
    templates: FULL_TEMPLATES.filter((template) => template.id === 'AUTOMATIC_2' || template.id === STYLE_TWO_ID),
    components: Object.fromEntries(STYLE_CATEGORIES.map((category) => [category,
      componentStylesFor(category)])) as Record<StyleCategory, ComponentStyle[]>
  };
}
