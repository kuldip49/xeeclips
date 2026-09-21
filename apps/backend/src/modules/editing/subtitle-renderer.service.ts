import { Injectable } from '@nestjs/common';
import { writeFile } from 'fs/promises';
import { EditPlan, SubtitleEmphasis, TimedWord } from './edit-plan';
import type { VisualTrack } from './reframe.service';
import { createTimelineMapper, Cut } from './timeline-remap';
import { buildSubtitlePhrases } from './subtitle-phrases';
import { resolveSafeZone, resolveTheme, SubtitleTheme, SUBTITLE_THEMES } from './visual-style-tokens';
import { escapeAssText, invalidSubtitleCharacters, sanitizeSubtitleText } from './subtitle-text';
import { PLATFORM_LAYOUT_PRESETS, PlatformLayoutPreset,
  validatePlatformLayout, Rect } from './platform-layout';
import { fitHookText, HookFit, HOOK_TYPE, layoutSubtitleLines } from './text-layout';
import { applyHookAccents, hookAccentCandidates, hookAccentFamily, HookAccentFamily,
  HOOK_ACCENT_FAMILY_COLORS, HOOK_TEXT_COLOR } from './hook-accent';
import { fontWidthFactor, HOOK_FONT, resolveFontFamily, SUBTITLE_FONT } from './fonts';

export type { Cut } from './timeline-remap';
export function editedTime(sourceTime: number, clipStart: number, cuts: Cut[]) {
  return createTimelineMapper(clipStart, cuts).point(sourceTime);
}
// ASS centiseconds, floored so that the frame at exactly `seconds` is included.
export function assTime(seconds: number) {
  const centiseconds = Math.max(0, Math.floor(seconds * 100 + 1e-6));
  const cs = centiseconds % 100;
  const s = Math.floor(centiseconds / 100) % 60;
  const m = Math.floor(centiseconds / 6000) % 60;
  const h = Math.floor(centiseconds / 360000);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
const escapeAss = escapeAssText;
function dialogue(layer: number, start: number, end: number, style: string, text: string) {
  return `Dialogue: ${layer},${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`;
}
function withOpacity(assColor: string, opacity: number) {
  const alpha = Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255)
    .toString(16).padStart(2, '0').toUpperCase();
  return `&H${alpha}${assColor.slice(4)}`;
}
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: Rect) =>
  a.x < b.x + b.width && a.x + a.w > b.x && a.y < b.y + b.height && a.y + a.h > b.y;
function safestY(tracks: VisualTrack[], candidates: number[], halfHeight: number,
  reserved: number[] = []) {
  const faceScore = (center: number) => tracks.reduce((sum, face) => {
    const top = face.y - .035;
    const bottom = face.y + face.h + .035;
    return sum + (center + halfHeight > top && center - halfHeight < bottom ? 1 : 0);
  }, 0);
  const reservedScore = (center: number) =>
    reserved.filter((other) => Math.abs(other - center) < .15).length;
  const score = (center: number) => faceScore(center) * 10 + reservedScore(center) * 3;
  const selected = [...candidates].sort((a, b) => score(a) - score(b))[0];
  return { y: selected,
    faceAdjusted: selected !== candidates[0] && faceScore(selected) < faceScore(candidates[0]),
    collisionRepair: selected !== candidates[0] &&
      reservedScore(selected) < reservedScore(candidates[0]),
    collision: score(selected) > 0 };
}
/**
 * Caption placement (§28/§31/§33). The block is bottom-anchored (`\an2`) at one
 * fixed baseline and never moves: no entry scale, no slide, no per-phrase
 * reposition. A scale or a move on the whole phrase re-centres the line, which
 * is exactly the jitter the caption system is supposed to be free of - the only
 * entry treatment left is a short fade, which changes nothing geometric.
 */
function subtitleAnimation(style: EditPlan['subtitleStyle']['animationStyle'],
  firstWord: boolean, x: number, y: number) {
  const at = `\\an2\\pos(${x},${y})`;
  return firstWord && style === 'FADE' ? `${at}\\fad(120,0)` : at;
}

export const DEFAULT_SUBTITLE_THEME = resolveTheme('BOLD_SOCIAL');
// Production caption contract. Values are canvas pixels at 1080x1920; the
// renderer scales the nominal size with output width and clamps to the agreed
// safety range. ASS uses BGR colour ordering.
export const PODCAST_BOLD_STYLE = {
  fontRequested: 'Inter ExtraBold', baselineFontPx: 72, minFontPx: 64, maxFontPx: 84,
  primaryColor: '#FFFFFF', activeColor: '#FFD400', outlineColor: '#111111',
  outlinePx: 6, shadowPx: 2, uppercase: true, maxWordsPerPhrase: 6,
  preferredWordsPerPhrase: [2, 5] as const, maxLines: 2, maxWidthRatio: .78,
  backgroundBox: false, activeAnimation: 'COLOR_ONLY'
} as const;
// The active word changes COLOUR only. Scaling a word inside a centred line
// re-flows the whole line, which moves the block horizontally - the one thing
// §31 forbids - so every scale here is 100.
export const SUBTITLE_TIMING = { holdAfterPhraseSec: .3, minEventSec: .03, activePopMs: 70,
  activeSettleMs: 190, activeScale: 100, keywordScale: 100, keywordActiveScale: 100,
  boostScale: 100, boostKeywordScale: 100, maxKeywordsPerPhrase: 2, maxOffsetSec: .3 } as const;
/**
 * Two fixed caption baselines, as a share of the caption zone's height measured
 * from its top (§28/§29). NORMAL is where captions live; SAFE_HIGH is the single
 * alternate a shot may move to when burned-in source text owns the normal band.
 * The choice is made once per shot and never per phrase.
 */
export const SUBTITLE_BASELINES = { normal: .72, safeHigh: .06 } as const;
// Editorial headline: dark text on a white plate, one short fade on entry and
// then locked in place - it never rises, slides or scales, because any of those
// would move the headline off the plate drawn behind it. Short headlines are set
// in uppercase (restrained size, slight tracking); longer ones keep their case.
export const EDITORIAL_HOOK = { uppercaseMaxWords: 6, uppercaseMaxChars: 36, uppercaseMaxFont: 104,
  // On its plate the headline needs no outline or shadow to stay readable.
  // The normal hook is packaging, not an entrance effect: it must exist on the
  // first displayable frame. A zero-duration ASS fade keeps the plate/text
  // timing identical while avoiding a blank first second on real encoders.
  uppercaseSpacing: 2, outline: 0, shadow: 0, fadeMs: 0 } as const;
/**
 * The headline's background treatment (§20/§21): a near-white rounded plate
 * sized to the fitted text block, not a full-width band. The plate - not the
 * glyphs - is what is bottom-anchored one deliberate gap above the footage, so a
 * one-line and a four-line headline present the same edge to the video.
 */
export const HOOK_PLATE = {
  // #F7F7F7: reads as paper rather than a blown-out white rectangle.
  // `padY` is what a headline gets when the zone can afford it; a long line that
  // needs the room takes `minPadY` instead, because losing the wording to keep a
  // generous margin is the wrong trade (§16).
  fill: '&H00F7F7F7', padX: 34, padY: 22, minPadY: 14, radius: 22,
  // Glyph luminance never approaches the plate's, so render QA separates text
  // from plate by looking for the DARK pixels inside the plate.
  maxTextLuminance: .55 } as const;
// Share of the caption box that burned-in source text may cover before the
// caption moves.
export const SUBTITLE_COLLISION = { maxAreaRatio: .06, margin: 14, minTopRatio: .4 } as const;

/**
 * ASS drawing path for a rounded rectangle, in drawing-local pixels. Emitted
 * under `\an7\pos(left,top)`, so it starts at the plate's own origin. The corner
 * arcs are cubic beziers with both control points on the corner itself, which is
 * the standard libass approximation of a quarter round.
 */
export function roundedRectPath(width: number, height: number, radius: number) {
  const w = Math.max(2, Math.round(width));
  const h = Math.max(2, Math.round(height));
  const r = Math.max(0, Math.min(Math.round(radius), Math.floor(Math.min(w, h) / 2)));
  if (!r) return `m 0 0 l ${w} 0 l ${w} ${h} l 0 ${h} l 0 0`;
  return `m ${r} 0 l ${w - r} 0 b ${w} 0 ${w} 0 ${w} ${r} ` +
    `l ${w} ${h - r} b ${w} ${h} ${w} ${h} ${w - r} ${h} ` +
    `l ${r} ${h} b 0 ${h} 0 ${h} 0 ${h - r} ` +
    `l 0 ${r} b 0 0 0 0 ${r} 0`;
}

export type SubtitleRenderOptions = {
  fps?: number; hookFontScale?: number; hookShortenLevel?: number;
  subtitleOffsetSec?: number; emphasisBoost?: boolean; subtitleFontScale?: number;
  // measured / estimated glyph width, from a libass probe of the previous attempt
  hookWidthScale?: number; hookHeightScale?: number;
  // When set, an extra ASS file holding only the hook (same fit, position and
  // accent colours) is written there, for the clip's thumbnail.
  hookOnlyPath?: string;
  // Canvas-pixel constraints for a final-timeline range: the bottom of a fitted
  // (FIT) source frame, and the top of burned-in source text below mid-frame.
  placementAt?: (start: number, end: number) => { fitBottom?: number; sourceTextTop?: number;
    sourceTextBoxes?: Rect[] };
  // Shot ranges on the final timeline. Caption placement is decided once per
  // shot (§29), so without them the whole clip shares one baseline.
  shotRanges?: Array<{ start: number; end: number }>;
};
// One rendered word event, on the final timeline, for render QA.
export type WordEvent = { text: string; sourceStart: number; mappedStart: number;
  renderStart: number; renderEnd: number; startFrame: number; endFrame: number;
  keyword: boolean; activeColor: string; y: number };

@Injectable()
export class SubtitleRendererService {
  async write(path: string, plan: EditPlan, words: TimedWord[], cuts: Cut[],
    width: number, height: number, theme?: SubtitleTheme,
    faceTracks: VisualTrack[] = [], personTracks: VisualTrack[] = [],
    headlineCanvas = false, layout?: PlatformLayoutPreset, options: SubtitleRenderOptions = {}) {
    const isVertical = height > width;
    const fps = options.fps ?? 30;
    const podcastBold = plan.subtitleStyle.template === 'PODCAST_BOLD';
    const requestedPalette = theme ?? resolveTheme(plan.subtitleTheme);
    const basePalette = podcastBold ? { ...requestedPalette,
      base: '&H00FFFFFF', accent: '&H0000D4FF', keyword: '&H0000D4FF',
      stroke: '&H00111111', shadow: '&H70000000', subtitleBox: false,
      fontWeight: 800 as const } : requestedPalette;
    // Emphasis repair switches to the most saturated accent pair.
    const palette = options.emphasisBoost ? { ...basePalette,
      accent: SUBTITLE_THEMES.HIGH_CONTRAST.accent, keyword: SUBTITLE_THEMES.WARM_ACCENT.keyword } : basePalette;
    const safe = resolveSafeZone(plan.platformPreset, isVertical);
    const mapper = createTimelineMapper(plan.clipStartSec, cuts);
    const finalDuration = mapper.point(plan.clipEndSec);
    const offset = Math.max(-SUBTITLE_TIMING.maxOffsetSec,
      Math.min(SUBTITLE_TIMING.maxOffsetSec, options.subtitleOffsetSec ?? 0));
    const frameOf = (t: number) => Math.max(0, Math.round(t * fps));
    const relevantTracks = (start: number, end: number) => {
      const nearby = (tracks: VisualTrack[]) => tracks.filter((track) =>
        track.timestamp >= start - 1.5 && track.timestamp <= end + 1.5);
      const faces = nearby(faceTracks);
      if (faces.length) return faces;
      const people = nearby(personTracks);
      if (people.length) return people;
      return [...(faceTracks.length ? faceTracks : personTracks)].sort((a, b) =>
        Math.abs(a.timestamp - (start + end) / 2) -
        Math.abs(b.timestamp - (start + end) / 2)).filter((track) =>
        Math.abs(track.timestamp - (start + end) / 2) <= 3).slice(0, 2);
    };
    const requestedFontSize = podcastBold ? PODCAST_BOLD_STYLE.baselineFontPx * width / 1080 :
      width * (isVertical ? 0.092 : 0.046);
    const fontSize = Math.round(Math.max(podcastBold ? PODCAST_BOLD_STYLE.minFontPx : 1,
      Math.min(podcastBold ? PODCAST_BOLD_STYLE.maxFontPx : Infinity,
        requestedFontSize * (options.subtitleFontScale ?? 1))));
    // Ask fontconfig what the requested faces actually resolve to, so a missing
    // font falls back to Noto Sans visibly (reported below) instead of silently
    // rendering the whole clip in whatever the system default happens to be.
    const [subtitleFont, hookFont] = await Promise.all([
      resolveFontFamily(SUBTITLE_FONT), resolveFontFamily(HOOK_FONT)]);
    const editorial = headlineCanvas && isVertical;
    const platformLayout = layout ?? PLATFORM_LAYOUT_PRESETS[plan.platformPreset] ??
      PLATFORM_LAYOUT_PRESETS.UNIVERSAL;
    const outline = podcastBold ? PODCAST_BOLD_STYLE.outlinePx : palette.fontWeight === 800 ? 3 : 2;
    const subtitleShadow = podcastBold ? PODCAST_BOLD_STYLE.shadowPx : 1;
    const boxColor = withOpacity(palette.box, palette.boxOpacity);
    const subtitleZone = editorial ? platformLayout.subtitleZone : {
      x: Math.round(width * safe.left), y: 0,
      width: Math.round(width * (1 - safe.left - safe.right)), height };
    const x = editorial ? Math.round(subtitleZone.x + subtitleZone.width / 2) :
      Math.round(width * (safe.left + 1 - safe.right) / 2);
    const sideMargin = Math.round(width * Math.max(safe.left, safe.right));
    const subtitleCandidates = plan.subtitleStyle.position === 'CENTER'
      ? [safe.calloutY[1], safe.subtitleY[1], safe.subtitleY[0]] : safe.subtitleY;
    let faceAvoidanceAdjustments = 0;
    let overlayCollisionRepairs = 0;
    const place = (start: number, end: number, candidates: number[],
      reserved: number[] = [], halfHeight = .045) => {
      const chosen = safestY(relevantTracks(start, end), candidates, halfHeight, reserved);
      if (chosen.faceAdjusted) faceAvoidanceAdjustments++;
      if (chosen.collisionRepair) overlayCollisionRepairs++;
      return chosen;
    };

    // --- Hook: fit, then place. A valid hook is never silently dropped. ---
    const editorialHook = headlineCanvas && isVertical;
    const plainHook = plan.onScreenHook.enabled ? sanitizeSubtitleText(plan.onScreenHook.text) : '';
    const uppercaseHook = editorialHook && plainHook.length <= EDITORIAL_HOOK.uppercaseMaxChars &&
      plainHook.split(/\s+/u).filter(Boolean).length <= EDITORIAL_HOOK.uppercaseMaxWords;
    const hookText = uppercaseHook ? plainHook.toLocaleUpperCase('en-US') : plainHook;
    const hookMaxFont = uppercaseHook ? EDITORIAL_HOOK.uppercaseMaxFont : HOOK_TYPE.maxFont;
    const hookFontScale = options.hookFontScale ?? 1;
    let hookFit: HookFit | null = null;
    let hookZone: Rect | null = null;
    let hookFaceOverlap = false;
    let hookSuppressionReason = plan.onScreenHook.enabled ? '' : 'NOT_REQUESTED';
    if (hookText) {
      const fitOptions = { maxFont: Math.round(hookMaxFont * hookFontScale),
        minFont: Math.min(HOOK_TYPE.minFont, Math.round(hookMaxFont * hookFontScale)),
        startShortenLevel: options.hookShortenLevel ?? 0,
        widthScale: (options.hookWidthScale ?? 1) * fontWidthFactor(hookFont.family),
        heightScale: options.hookHeightScale ?? 1 };
      // The plate, not the text, is what has to fit the zone: the text is fitted
      // into the zone minus the plate's padding, so a long headline uses more of
      // the header area rather than shrinking to make room for its own margin.
      // The fit budget uses the tightest padding the plate may have; the actual
      // padding is then taken back below out of whatever room the fit left over,
      // so a short headline still gets its generous margin.
      const insetForPlate = (zone: Rect): Rect => ({ x: zone.x, y: zone.y,
        width: zone.width - HOOK_PLATE.padX * 2,
        height: zone.height - HOOK_PLATE.minPadY * 2 - 4 });
      if (editorial) {
        hookZone = platformLayout.hookZone;
        hookFit = fitHookText(hookText, insetForPlate(hookZone), fitOptions);
      } else {
        const zoneHeight = Math.round(height * (isVertical ? .17 : .22));
        const zones = safe.hookY.map((y) => ({ x: Math.round(width * safe.left),
          y: Math.max(Math.round(height * safe.top), Math.round(height * y - zoneHeight / 2)),
          width: Math.round(width * (1 - safe.left - safe.right)), height: zoneHeight }));
        hookFit = fitHookText(hookText, insetForPlate(zones[0]), fitOptions);
        if (hookFit) {
          const fit = hookFit;
          const tracks = relevantTracks(plan.clipStartSec, plan.clipStartSec + 2.8);
          const boundsIn = (zone: Rect): Rect => ({ x: zone.x + (zone.width - fit.width) / 2,
            y: zone.y + (zone.height - fit.height) / 2, width: fit.width, height: fit.height });
          const collisions = (zone: Rect) => tracks.filter((face) => overlaps(
            { x: face.x * width, y: face.y * height, w: face.w * width, h: face.h * height },
            boundsIn(zone))).length;
          hookZone = [...zones].sort((a, b) => collisions(a) - collisions(b))[0];
          if (hookZone !== zones[0]) faceAvoidanceAdjustments++;
          hookFaceOverlap = collisions(hookZone) > 0;
        }
      }
      if (!hookFit) hookSuppressionReason = 'TEXT_DOES_NOT_FIT_AFTER_SHORTENING';
    } else if (plan.onScreenHook.enabled) hookSuppressionReason = 'EMPTY_TEXT';
    // Editorial headlines are bottom-anchored in their zone by the BOTTOM EDGE OF
    // THEIR PLATE: the gap to the footage is then fixed and the hook reads as
    // belonging to the video below it, instead of drifting up whenever the text
    // happens to be short. A long headline grows upward from that same edge
    // (§19), so one-, two-, three- and four-line headlines all present the same
    // bottom line to the video.
    // Generous padding whenever the zone can still afford it after the fit.
    const hookPadY = hookFit && hookZone ? Math.max(HOOK_PLATE.minPadY, Math.min(HOOK_PLATE.padY,
      Math.floor((hookZone.height - 4 - hookFit.height) / 2))) : HOOK_PLATE.padY;
    const hookHeight = hookFit ?
      Math.round(hookFit.height) + hookPadY * 2 : 0;
    const hookTop = hookZone && hookFit ? (editorial ?
      Math.max(hookZone.y, hookZone.y + hookZone.height - hookHeight) :
      Math.round(hookZone.y + (hookZone.height - hookHeight) / 2)) : 0;
    const hookCenter = hookZone ? { x: Math.round(hookZone.x + hookZone.width / 2),
      y: hookFit ? hookTop + hookHeight / 2 : Math.round(hookZone.y + hookZone.height / 2) } : null;
    // The plate itself: the fitted text block plus its padding, centred on the
    // zone. This rectangle is the hook's bounds for layout validation and for
    // render QA, because it is what a viewer sees as the headline.
    const hookPlate: Rect | null = hookFit && hookCenter ? {
      x: Math.round(hookCenter.x - (hookFit.width + HOOK_PLATE.padX * 2) / 2), y: hookTop,
      width: Math.round(hookFit.width) + HOOK_PLATE.padX * 2, height: hookHeight } : null;
    const showHook = Boolean(hookFit && hookCenter && finalDuration > .01);
    if (hookFit && !(finalDuration > .01)) hookSuppressionReason = 'CLIP_TOO_SHORT';
    const hookFontSize = hookFit?.fontSize ?? Math.round(hookMaxFont * hookFontScale);
    const hookY = hookCenter ? hookCenter.y / height : safe.hookY[0];

    const lines = [
      '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`,
      'ScaledBorderAndShadow: yes', 'WrapStyle: 2', '',
      '[V4+ Styles]',
      'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
      // Captions: a geometric extra-bold face, white with a dark stroke and no
      // opaque box (§27). Bold is 0 because the face already carries the weight -
      // asking libass to embolden an ExtraBold face only smears its edges.
      `Style: Subtitle,${subtitleFont.family},${fontSize},${palette.base},${palette.accent},${palette.stroke},${palette.subtitleBox ? boxColor : palette.shadow},0,0,0,0,100,100,0,0,${palette.subtitleBox ? 3 : 1},${outline},${subtitleShadow},2,${sideMargin},${sideMargin},0,1`,
      // Headline: dark charcoal on its white plate, so no outline or shadow is
      // needed to make it readable (§21).
      editorialHook ?
        `Style: Hook,${hookFont.family},${hookFontSize},${HOOK_TEXT_COLOR},${palette.accent},${palette.stroke},${palette.shadow},-1,0,0,0,100,100,${uppercaseHook ? EDITORIAL_HOOK.uppercaseSpacing : 0},0,1,${EDITORIAL_HOOK.outline},${EDITORIAL_HOOK.shadow},5,0,0,0,1` :
        `Style: Hook,${hookFont.family},${hookFontSize},${HOOK_TEXT_COLOR},${palette.accent},${palette.stroke},${palette.shadow},-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
      `Style: HookBox,${hookFont.family},${hookFontSize},${HOOK_TEXT_COLOR},${palette.accent},${palette.stroke},&H480A0D16,-1,0,0,0,100,100,0,0,3,5,0,5,0,0,0,1`,
      // The plate itself: a filled drawing, no border, no shadow, anchored top-left.
      `Style: HookPlate,${hookFont.family},${hookFontSize},${HOOK_PLATE.fill},${HOOK_PLATE.fill},${HOOK_PLATE.fill},&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
      `Style: Callout,${subtitleFont.family},${Math.round(fontSize * .88)},${palette.base},${palette.accent},${palette.stroke},${palette.shadow},0,0,0,0,100,100,0,0,1,3,1,5,${sideMargin},${sideMargin},0,1`,
      '', '[Events]',
      'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text'
    ];

    // --- Subtitles on the final edited timeline ---
    const invalidCharacters = [...new Set(words.flatMap((word) =>
      invalidSubtitleCharacters(word.text)))];
    const surviving = words.filter((word) => word.start >= plan.clipStartSec - .001 &&
      word.end <= plan.clipEndSec + .001 && word.end > word.start &&
      !mapper.removed(word.start, word.end)).map((word) => ({
        start: word.start, end: word.end,
        text: sanitizeSubtitleText(word.text) })).filter((word) => word.text);
    const phrases = buildSubtitlePhrases(surviving, Math.max(2,
      Math.min(PODCAST_BOLD_STYLE.maxWordsPerPhrase, plan.subtitleStyle.maxWordsPerLine)));
    const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const emphasis = plan.subtitleEmphasis.filter((item) => !mapper.removed(item.startSec, item.endSec));
    const matchKeyword = (word: TimedWord) => emphasis.find((item) =>
      normalized(item.word) === normalized(word.text) &&
      Math.abs(item.startSec - word.start) <= .18 && Math.abs(item.endSec - word.end) <= .25);
    // Usually one emphasized word per phrase, occasionally two - and the second
    // only when the phrase is long enough to carry it and the word is STRONG in
    // its own right. Constant emphasis reads as animation noise rather than
    // meaning, so the cap tightens as the phrase gets shorter.
    const phraseKeywords = new Map<TimedWord, SubtitleEmphasis>();
    for (const phrase of phrases) {
      const ranked = phrase.words.map((word) => ({ word, item: matchKeyword(word) }))
        .filter((entry): entry is { word: TimedWord; item: SubtitleEmphasis } => Boolean(entry.item))
        .sort((a, b) => Number(b.item.strength === 'STRONG') - Number(a.item.strength === 'STRONG') ||
          a.word.start - b.word.start);
      const allowed = ranked.length > 1 && phrase.words.length >= 4 &&
        ranked[1].item.strength === 'STRONG' ? SUBTITLE_TIMING.maxKeywordsPerPhrase : 1;
      ranked.slice(0, allowed).forEach((entry) => phraseKeywords.set(entry.word, entry.item));
    }
    const keywordOf = (word: TimedWord) => phraseKeywords.get(word);
    const highlighted = new Set<string>();
    const subtitlePlacements: Array<{ start: number; end: number; y: number }> = [];
    const coveredWords = new Set<TimedWord>();
    const wordEvents: WordEvent[] = [];
    const maxLineWidth = Math.min(editorial ? subtitleZone.width :
      width * (1 - safe.left - safe.right), width * PODCAST_BOLD_STYLE.maxWidthRatio);
    let activeAnimationCount = 0;
    let sourceTextAdjustments = 0;
    let subtitleCollisionDetected = 0;
    let subtitlePositionAdjusted = 0;
    let subtitleCollisionAreaRatio = 0;
    const phraseFaces = (start: number, end: number) => faceTracks.filter((face) =>
      face.timestamp >= start - .5 && face.timestamp <= end + .5).map((face) =>
      ({ x: face.x * width, y: face.y * height, width: face.w * width, height: face.h * height }));
    let maxRenderedSubtitleWidth = 0;
    // How many shot-level baselines ended up away from the normal one, for QA.
    let subtitleAlternateBaselines = 0;
    let subtitleFontSizeUsed = fontSize;
    if (plan.subtitleStyle.enabled) {
      // --- Pass 1: geometry. One font size for the whole clip (§33) -----------
      // A phrase with an unusually long word would otherwise shrink only itself,
      // so the smallest size any phrase needs becomes the size every phrase uses.
      const widthFactor = fontWidthFactor(subtitleFont.family);
      const displayWord = (text: string) => podcastBold && PODCAST_BOLD_STYLE.uppercase ?
        text.toLocaleUpperCase('en-US') : text;
      const layoutAt = (phrase: typeof phrases[number], size: number) =>
        layoutSubtitleLines(phrase.words.map((word) => escapeAss(displayWord(word.text))), size,
          maxLineWidth / widthFactor, phrase.lineBreakIndex);
      subtitleFontSizeUsed = phrases.reduce((size, phrase) =>
        Math.min(size, layoutAt(phrase, fontSize).fontSize), fontSize);
      const layouts = phrases.map((phrase) => layoutAt(phrase, subtitleFontSizeUsed));
      maxRenderedSubtitleWidth = layouts.reduce((widest, item) =>
        Math.max(widest, item.width * widthFactor), 0);

      // --- Pass 2: one fixed baseline per shot (§28/§29) ----------------------
      // Captions are bottom-anchored, so the baseline IS the bottom edge and a
      // one- or two-line phrase never shifts it. The baseline is chosen once per
      // shot and only ever moves when burned-in source text or a letterboxed
      // fitted frame makes the normal band unusable for that whole shot.
      const zone = editorial ? platformLayout.subtitleZone : null;
      const normalBottom = zone ?
        zone.y + zone.height * SUBTITLE_BASELINES.normal : height * subtitleCandidates[0];
      const safeHighBottom = zone ?
        zone.y + zone.height * SUBTITLE_BASELINES.safeHigh : height * subtitleCandidates[1];
      const shotRanges = options.shotRanges?.length ? options.shotRanges :
        [{ start: 0, end: Math.max(finalDuration, .01) }];
      const shotOf = (phrase: typeof phrases[number]) => {
        const at = mapper.point(phrase.start);
        const index = shotRanges.findIndex((shot) => at >= shot.start && at < shot.end);
        return index < 0 ? Math.max(0, shotRanges.length - 1) : index;
      };
      const shotBaselines = shotRanges.map((shot, shotIndex) => {
        const own = phrases.map((phrase, index) => ({ phrase, index }))
          .filter((item) => shotOf(item.phrase) === shotIndex);
        if (!own.length) return { bottom: normalBottom, alternate: false };
        const lineCount = Math.max(...own.map((item) => layouts[item.index].lines.length));
        const textHeight = lineCount * subtitleFontSizeUsed * 1.05;
        const widest = Math.max(...own.map((item) => layouts[item.index].width * widthFactor));
        // `shotRanges` are final-timeline seconds, which is what `placementAt`
        // expects; face tracks are keyed by SOURCE time, so anything that looks
        // at them gets the shot's own source span instead.
        const sourceFrom = own[0].phrase.start;
        const sourceTo = own[own.length - 1].phrase.end;
        if (!editorial) {
          const chosen = place(sourceFrom, sourceTo, subtitleCandidates, showHook ? [hookY] : []);
          return { bottom: chosen.y * height, alternate: chosen.y !== subtitleCandidates[0] };
        }
        if (!options.placementAt) return { bottom: normalBottom, alternate: false };
        const viewportBox = platformLayout.videoViewport;
        const hint = options.placementAt(shot.start, shot.end);
        // A fitted (letterboxed) shot has a hard edge captions must clear; that
        // edge is a property of the shot, so it is still one position per shot.
        if (hint.fitBottom != null) {
          const bottom = Math.max(normalBottom, Math.min(viewportBox.y + viewportBox.height - 16,
            hint.fitBottom + 14 + textHeight));
          return { bottom, alternate: Math.abs(bottom - normalBottom) > 1 };
        }
        const boxes = hint.sourceTextBoxes ?? (hint.sourceTextTop != null ? [{ x: 0,
          y: hint.sourceTextTop, width, height: viewportBox.y + viewportBox.height - hint.sourceTextTop }] : []);
        if (!boxes.length) return { bottom: normalBottom, alternate: false };
        // The normal band is only abandoned when the source's own text genuinely
        // occupies it for this shot; then the shot takes the single alternate
        // baseline rather than drifting to a bespoke position per phrase.
        const caption = { x, width: widest, height: textHeight };
        const normalRatio = collisionAreaRatio({ x: caption.x - widest / 2 - 8,
          y: normalBottom - textHeight - 8, width: widest + 16, height: textHeight + 16 }, boxes);
        if (normalRatio <= SUBTITLE_COLLISION.maxAreaRatio)
          return { bottom: normalBottom, alternate: false };
        subtitleCollisionDetected++;
        const highRatio = collisionAreaRatio({ x: caption.x - widest / 2 - 8,
          y: safeHighBottom - textHeight - 8, width: widest + 16, height: textHeight + 16 }, boxes);
        subtitleCollisionAreaRatio = Math.max(subtitleCollisionAreaRatio, highRatio);
        // Placement is fixed for the entire shot: NORMAL or SAFE_HIGH only.
        // A phrase-local free search caused visible jumping and could also hide
        // a collision from the rendered-coordinate QA.
        return { bottom: Math.round(safeHighBottom), alternate: true };
      });
      subtitleAlternateBaselines = shotBaselines.filter((item) => item.alternate).length;
      subtitlePositionAdjusted = subtitleAlternateBaselines;
      sourceTextAdjustments = subtitleAlternateBaselines;

      const phraseStarts = phrases.map((phrase) => frameOf(mapper.point(phrase.start) + offset));
      for (let phraseIndex = 0; phraseIndex < phrases.length; phraseIndex++) {
        const phrase = phrases[phraseIndex];
        const group = phrase.words;
        const texts = group.map((word) => escapeAss(podcastBold && PODCAST_BOLD_STYLE.uppercase ?
          word.text.toLocaleUpperCase('en-US') : word.text));
        const lineLayout = layouts[phraseIndex];
        const subtitleY = shotBaselines[shotOf(phrase)].bottom / height;
        subtitlePlacements.push({ start: phrase.start, end: phrase.end, y: subtitleY });
        const nextPhraseFrame = phraseStarts[phraseIndex + 1] ?? Infinity;
        const lastEndFrame = Math.min(nextPhraseFrame, frameOf(Math.min(finalDuration,
          mapper.point(group[group.length - 1].end) + SUBTITLE_TIMING.holdAfterPhraseSec + offset)));
        const startFrames = group.map((word) => frameOf(mapper.point(word.start) + offset));
        for (let j = 0; j < group.length; j++) {
          // Word j stays active until word j+1 starts: no flicker inside a phrase.
          const startFrame = startFrames[j];
          const endFrame = j < group.length - 1 ? startFrames[j + 1] : Math.max(lastEndFrame,
            startFrame + 1);
          if (endFrame <= startFrame) { group.forEach((word) => coveredWords.add(word)); continue; }
          group.forEach((word) => coveredWords.add(word));
          const activeKeyword = keywordOf(group[j]);
          const content = group.map((word, index) => {
            const text = texts[index];
            const separator = index === 0 ? '' : index === lineLayout.breakIndex ? '\\N' : ' ';
            const keyword = keywordOf(word);
            const active = plan.subtitleStyle.highlightCurrentWord && index === j;
            // Colour only: a per-word scale would re-flow a centred line and
            // shift the whole caption sideways as each word lights up (§31).
            if (!active && !keyword) return separator + text;
            if (!active) return separator +
              `{\\1c${palette.keyword}&}` + text + `{\\1c${palette.base}&}`;
            if (keyword) highlighted.add(`${word.start}:${word.text}`);
            activeAnimationCount++;
            return separator + `{\\1c${keyword ? palette.keyword : palette.accent}&}` +
              text + `{\\1c${palette.base}&}`;
          }).join('');
          const renderStart = startFrame / fps;
          const renderEnd = endFrame / fps;
          const scaleTag = lineLayout.fontSize !== fontSize ? `\\fs${lineLayout.fontSize}` : '';
          lines.push(dialogue(3, renderStart, renderEnd, 'Subtitle',
            `{${subtitleAnimation(plan.subtitleStyle.animationStyle, j === 0,
              x, Math.round(height * subtitleY))}${scaleTag}}${content}`));
          wordEvents.push({ text: group[j].text, sourceStart: group[j].start,
            mappedStart: mapper.point(group[j].start), renderStart, renderEnd, startFrame, endFrame,
            keyword: Boolean(activeKeyword),
            activeColor: plan.subtitleStyle.highlightCurrentWord ?
              (activeKeyword ? palette.keyword : palette.accent) : palette.base,
            y: subtitleY });
        }
      }
    }

    let hookWordCount = 0;
    let hookAccentWords: string[] = [];
    let hookAccentIndexes: number[] = [];
    let hookDialogue = '';
    // Same headline with no entrance animation, for the still cover.
    let hookStaticDialogue = '';
    let hookPlateDialogue = '';
    let hookAccentFamilyName: HookAccentFamily | null = null;
    if (showHook && hookFit && hookCenter && hookPlate) {
      const boxed = plan.onScreenHook.style === 'MINIMAL_BOX';
      // Visible from the first frame to the last.
      const { x: hx, y: hy } = hookCenter;
      // The plate and the headline share one entrance so they never separate; a
      // scale animation is deliberately gone - it would grow the text off its
      // own plate.
      const entrance = editorialHook ?
        `\\fad(${EDITORIAL_HOOK.fadeMs},0)` : '\\fad(70,0)';
      const placement = `\\pos(${hx},${hy})${entrance}`;
      // A controlled number of genuinely strong words carry ONE accent colour;
      // the rest of the headline stays dark charcoal, so the emphasis reads as
      // deliberate rather than as a coloured template (§22-§25).
      hookAccentFamilyName = hookAccentFamily(hookFit.text);
      const accentColor = HOOK_ACCENT_FAMILY_COLORS[hookAccentFamilyName];
      const accents = boxed ? [] : hookAccentCandidates(hookFit.text, plan.subtitleEmphasis);
      const accented = applyHookAccents(hookFit.lines, accents, HOOK_TEXT_COLOR, escapeAss,
        accentColor);
      hookAccentWords = accents.map((accent) => accent.word);
      hookAccentIndexes = accents.map((accent) => accent.index);
      const body = accented.lines.join('\\N');
      hookDialogue = `{\\an5\\q2${placement}\\fs${hookFit.fontSize}}` + body;
      // The cover is a single frame, so it takes the settled headline directly:
      // no fade, no rise.
      hookStaticDialogue = `{\\an5\\q2\\pos(${hx},${hy})\\fs${hookFit.fontSize}}` + body;
      hookPlateDialogue = `{\\an7\\pos(${hookPlate.x},${hookPlate.y})${entrance}\\p1}` +
        roundedRectPath(hookPlate.width, hookPlate.height, HOOK_PLATE.radius) + '{\\p0}';
      const hookEnd = Math.ceil(finalDuration * fps + 1) / fps;
      // Layer 1 so the plate sits under the headline and over the background.
      lines.push(dialogue(1, 0, hookEnd, 'HookPlate', hookPlateDialogue));
      lines.push(dialogue(2, 0, hookEnd, boxed ? 'HookBox' : 'Hook', hookDialogue));
      hookWordCount = hookFit.text.split(/\s+/u).filter(Boolean).length;
    }
    let onScreenTextCount = 0;
    for (const item of plan.onScreenText) {
      const range = mapper.range(item.startSec, item.endSec);
      if (!range) continue;
      if (phrases.some((phrase) => phrase.start < range.end && phrase.end > range.start &&
        normalized(phrase.words.map((word) => word.text).join(' ')) === normalized(item.text))) {
        overlayCollisionRepairs++; continue;
      }
      const calloutCandidates = item.position === 'TOP'
        ? [safe.hookY[0], safe.hookY[1], safe.calloutY[2]]
        : item.position === 'LOWER_THIRD'
          ? [safe.calloutY[1], safe.calloutY[0], safe.subtitleY[1]]
          : safe.calloutY;
      const calloutPlacement = place(item.startSec, item.endSec, calloutCandidates,
        [showHook ? hookY : -1,
          ...subtitlePlacements.filter((phrase) => phrase.start < range.end &&
            phrase.end > range.start).map((phrase) => phrase.y)]);
      if (calloutPlacement.collision || (editorial && showHook &&
        Math.abs(calloutPlacement.y - hookY) < .12)) {
        overlayCollisionRepairs++; continue;
      }
      lines.push(dialogue(1, range.start, range.end, 'Callout',
        `{\\an5\\pos(${x},${Math.round(height * calloutPlacement.y)})` +
        `\\fad(100,150)}${escapeAss(item.text)}`));
      onScreenTextCount++;
    }
    const subtitleCoverageRatio = surviving.length ?
      surviving.filter((word) => coveredWords.has(word)).length / surviving.length : 1;
    const duplicateSubtitleWords = phrases.flatMap((phrase) => phrase.words)
      .filter((word, index, all) => all.indexOf(word) !== index).map((word) => word.text);
    const missingSubtitleWords = surviving.filter((word) => !coveredWords.has(word))
      .map((word) => word.text);
    if (plan.subtitleStyle.enabled && subtitleCoverageRatio < .98)
      throw new Error(`Subtitle coverage below 98%: ${subtitleCoverageRatio.toFixed(3)}`);
    // The plate is the headline as far as layout is concerned: it is what the
    // viewer sees, so it is what must clear the platform UI and hold the gap
    // above the footage.
    const hookBounds: Rect | null = showHook ? hookPlate : null;
    const subtitleBounds: Rect | null = editorial && plan.subtitleStyle.enabled ?
      platformLayout.subtitleZone : null;
    const platformQA = editorial ? validatePlatformLayout(platformLayout,
      hookBounds, subtitleBounds, null) : null;
    const timelineErrors = wordEvents.map((event) =>
      Math.abs(event.renderStart - (event.mappedStart + offset)) * 1000);
    await writeFile(path, lines.join('\n'), 'utf8');
    // Thumbnail overlay: the identical headline (same fit, position and accent
    // colours), without captions or callouts, held for the whole clip so any
    // frame can serve as the cover.
    if (options.hookOnlyPath) {
      const headerEnd = lines.indexOf(
        'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text');
      const hookOnly = lines.slice(0, headerEnd + 1);
      const coverEnd = Math.ceil(finalDuration * fps + 1) / fps;
      // The cover carries the same plate, so the thumbnail and the clip show the
      // identical headline treatment.
      if (hookPlateDialogue) hookOnly.push(dialogue(1, 0, coverEnd, 'HookPlate',
        hookPlateDialogue.replace(/\\fad\([^)]*\)/u, '')));
      if (hookStaticDialogue) hookOnly.push(dialogue(2, 0, coverEnd, 'Hook', hookStaticDialogue));
      await writeFile(options.hookOnlyPath, hookOnly.join('\n'), 'utf8');
    }
    const phraseWordCounts = phrases.map((phrase) => phrase.words.length);
    const renderedLineCounts = plan.subtitleStyle.enabled ? phrases.map((phrase) =>
      layoutSubtitleLines(phrase.words.map((word) => escapeAss(podcastBold ?
        word.text.toLocaleUpperCase('en-US') : word.text)), subtitleFontSizeUsed,
      maxLineWidth / fontWidthFactor(subtitleFont.family), phrase.lineBreakIndex).lines.length) : [];
    return { subtitlePhraseCount: plan.subtitleStyle.enabled ? phrases.length : 0,
      subtitleTemplate: plan.subtitleStyle.template,
      averageWordsPerPhrase: phraseWordCounts.length ? Number((phraseWordCounts.reduce((a, b) =>
        a + b, 0) / phraseWordCounts.length).toFixed(2)) : 0,
      maxWordsPerPhrase: phraseWordCounts.length ? Math.max(...phraseWordCounts) : 0,
      oneLinePhraseCount: renderedLineCounts.filter((count) => count === 1).length,
      twoLinePhraseCount: renderedLineCounts.filter((count) => count === 2).length,
      maxSubtitleLineCount: renderedLineCounts.length ? Math.max(...renderedLineCounts) : 0,
      subtitleMaxWidthRatio: Number((maxLineWidth / width).toFixed(3)),
      activeWordHighlightCount: activeAnimationCount,
      subtitleCollisionRepairs: subtitleAlternateBaselines,
      highlightedWordCount: highlighted.size, animationEventCount: activeAnimationCount,
      activeWordAnimationCount: activeAnimationCount,
      hookWordCount,
      hookRequested: plan.onScreenHook.enabled, hookValidated: Boolean(hookText),
      hookPlaced: Boolean(showHook), hookRendered: Boolean(showHook), hookSuppressionReason,
      hookText: hookFit?.text ?? '', hookLines: hookFit?.lines ?? [],
      hookShortenLevel: hookFit?.shortenLevel ?? 0, hookFitAttempts: hookFit?.attempts ?? 0,
      hookZone, hookFaceOverlap, hookAccentWords, hookAccentIndexes,
      hookAccentWordCount: hookAccentWords.length,
      // Accents are spread across the headline rather than clustered, so the eye
      // scans the whole line instead of one bright cluster.
      hookAccentDistributionValid: hookAccentIndexes.length <= 1 ? true :
        hookAccentIndexes.every((index, position) => position === 0 ||
          index - hookAccentIndexes[position - 1] > 1),
      hookLineCount: hookFit?.lines.length ?? 0,
      hookOnlyRendered: Boolean(options.hookOnlyPath && hookStaticDialogue),
      hookPosition: hookCenter ? { x: hookCenter.x / width, y: hookCenter.y / height } : null,
      hookFontSize,
      // Headline treatment (§20-§25): the plate that was drawn, the one accent
      // family every accent word shares, and the text colour on it.
      hookPlateBounds: showHook ? hookPlate : null,
      hookBackgroundRendered: Boolean(showHook && hookPlateDialogue),
      hookBackgroundColor: HOOK_PLATE.fill, hookTextColor: HOOK_TEXT_COLOR,
      hookAccentFamily: hookAccentFamilyName,
      hookAccentColor: hookAccentFamilyName ? HOOK_ACCENT_FAMILY_COLORS[hookAccentFamilyName] : null,
      // Only one family is ever emitted, so this is a rendered fact, not a guess.
      hookAccentColorSingleFamily: true,
      hookFontName: hookFont.family, hookFontAvailable: hookFont.available,
      subtitleFontName: subtitleFont.family, subtitleFontAvailable: subtitleFont.available,
      subtitleFontRequested: subtitleFont.requested,
      subtitleFontFallbackUsed: !subtitleFont.available,
      subtitleFontSize: subtitleFontSizeUsed,
      // Every phrase renders at the same size and the baseline is decided once
      // per shot, so geometry is stable across the clip (§28/§33).
      subtitleGeometryStable: true,
      subtitleAlternateBaselines,
      subtitleBaselineCount: new Set(subtitlePlacements.map((item) =>
        Math.round(item.y * height))).size,
      subtitlePosition: subtitlePlacements[0]?.y ?? subtitleCandidates[0],
      subtitlePositions: subtitlePlacements,
      subtitleZone, maxSubtitleLineWidth: Math.round(maxRenderedSubtitleWidth),
      onScreenTextCount, overlayCollisionRepairs, faceAvoidanceAdjustments, sourceTextAdjustments,
      originalTranscriptWordCount: words.filter((word) => word.start >= plan.clipStartSec &&
        word.end <= plan.clipEndSec && word.end > word.start).length,
      captionCoveredWordCount: coveredWords.size,
      subtitleCoverageRatio, duplicateSubtitleWords, missingSubtitleWords,
      invalidSubtitleCharacters: invalidCharacters,
      hookStartSec: showHook ? 0 : null,
      // First time the hook is fully visible and locked in place.
      hookSettleSec: showHook ? (editorialHook ? EDITORIAL_HOOK.fadeMs / 1000 : .2) : null,
      subtitleCollisionDetected, subtitlePositionAdjusted,
      subtitleCollisionAreaRatio: Number(subtitleCollisionAreaRatio.toFixed(3)),
      hookEndSec: showHook ? finalDuration : null,
      hookBounds, subtitleBounds, platformLayoutSafe: platformQA?.platformLayoutSafe ?? null,
      platformSafeZoneViolations: platformQA?.violations ?? [],
      rightSideUIClearance: platformQA?.rightSideUIClearance ?? null,
      bottomUIClearance: platformQA?.bottomUIClearance ?? null,
      topClearance: platformQA?.topClearance ?? null,
      hookPositionValid: platformQA?.hookPositionValid ?? null,
      hookNotTooHigh: platformQA?.hookNotTooHigh ?? null,
      hookGapAboveVideoValid: platformQA?.hookGapAboveVideoValid ?? null,
      hookGapAboveVideoPx: platformQA?.hookGapAboveVideoPx ?? null,
      wordEvents, subtitleOffsetSec: offset,
      subtitleTimelineErrorAverageMs: timelineErrors.length ?
        Number((timelineErrors.reduce((a, b) => a + b, 0) / timelineErrors.length).toFixed(1)) : 0,
      subtitleTimelineErrorWorstMs: timelineErrors.length ? Number(Math.max(...timelineErrors).toFixed(1)) : 0,
      timelineRemapApplied: cuts.length > 0, subtitleTheme: plan.subtitleTheme,
      platformPreset: plan.platformPreset, subtitleAnimationStyle: plan.subtitleStyle.animationStyle,
      palette };
  }
}

// Share of the caption box covered by the given rectangles.
export function collisionAreaRatio(caption: Rect, boxes: Rect[]) {
  const area = Math.max(1, caption.width * caption.height);
  const covered = boxes.reduce((sum, box) => {
    const w = Math.min(caption.x + caption.width, box.x + box.width) - Math.max(caption.x, box.x);
    const h = Math.min(caption.y + caption.height, box.y + box.height) - Math.max(caption.y, box.y);
    return sum + (w > 0 && h > 0 ? w * h : 0);
  }, 0);
  return Math.min(1, covered / area);
}
// Keeps the caption at its normal lower-middle position unless burned-in source
// text (lower thirds, banners, logos, chart labels) sits under it; then moves it
// just above/below that text or slightly higher, never onto a face and never
// out of the lower part of the video viewport.
export function placeAroundSourceText(bottom: number, boxes: Rect[], faces: Rect[],
  caption: { x: number; width: number; height: number }, viewport: Rect) {
  const pad = 8;
  const rectAt = (b: number): Rect => ({ x: caption.x - caption.width / 2 - pad, y: b - caption.height - pad,
    width: caption.width + pad * 2, height: caption.height + pad * 2 });
  const ratio = (b: number) => collisionAreaRatio(rectAt(b), boxes);
  const initial = ratio(bottom);
  if (initial <= SUBTITLE_COLLISION.maxAreaRatio) return { bottom, ratio: initial, collided: false };
  const minBottom = viewport.y + viewport.height * SUBTITLE_COLLISION.minTopRatio + caption.height;
  const maxBottom = viewport.y + viewport.height - 16;
  const near = boxes.filter((box) => collisionAreaRatio(rectAt(bottom), [box]) > 0);
  const candidates = [bottom,
    ...near.map((box) => box.y - SUBTITLE_COLLISION.margin),
    ...near.map((box) => box.y + box.height + SUBTITLE_COLLISION.margin + caption.height),
    bottom - viewport.height * .12, bottom - viewport.height * .2]
    .map(Math.round).filter((b) => b >= minBottom && b <= maxBottom);
  const score = (b: number) => ratio(b) * 100 + (collisionAreaRatio(rectAt(b), faces) > .02 ? 1000 : 0) +
    Math.abs(b - bottom) / viewport.height * 10;
  const best = candidates.sort((a, b) => score(a) - score(b))[0] ?? bottom;
  const chosen = ratio(best) < initial - .02 ? best : bottom;
  return { bottom: chosen, ratio: ratio(chosen), collided: true };
}
