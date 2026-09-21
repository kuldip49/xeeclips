import type { PlatformPreset } from './edit-plan';

export type Rect = { x: number; y: number; width: number; height: number };
export type VideoTemplate = 'FULL_SCREEN_SOCIAL' | 'EDITORIAL_FRAME' |
  'PODCAST_FRAME' | 'DUAL_SPEAKER' | 'CLEAN_DOCUMENTARY';
export type BackgroundMode = 'SOURCE_MATCH_SOLID' | 'SOURCE_MATCH_GRADIENT' |
  'DARK_NEUTRAL' | 'SOFT_BLUR_EXTENSION';
export type PlatformLayoutPreset = { id: PlatformPreset; canvasWidth: number;
  canvasHeight: number; headerBounds: Rect; footerBounds: Rect;
  topSafeZone: Rect; bottomSafeZone: Rect;
  leftSafeZone: Rect; rightSafeZone: Rect; hookZone: Rect;
  // Distance between the bottom of the hook zone and the top of the video
  // viewport: the deliberate editorial breathing room under the headline.
  hookGapAboveVideo: number;
  videoViewport: Rect; subtitleZone: Rect; subjectSafeZone: Rect;
  avoidUIZones: Rect[]; preferredComposition: VideoTemplate };

// Editorial headline placement. The hook block is anchored from the TOP OF THE
// VIDEO VIEWPORT, not from the top of the canvas:
//
//   hookTopY = videoViewport.y - targetGapAboveVideo - renderedHookHeight
//
// The renderer bottom-anchors the fitted block inside `hookZone`, whose bottom
// edge is exactly `videoViewport.y - targetGapAboveVideo`. A one-, two- or
// three-line headline therefore always ends on the same baseline just above the
// footage and grows upward, so placement is identical across every clip using
// the same layout. `topSafe` only caps how high a very tall headline may climb.
// The gap is measured from the bottom of the headline's white plate, not from
// its glyphs, so the plate is what sits the deliberate 30-50 px above the
// footage and the headline reads as belonging to the video under it.
export const HOOK_PLACEMENT = { topSafe: 64, targetGapAboveVideo: 34,
  minGapAboveVideo: 30, maxGapAboveVideo: 50, minZoneHeight: 120 } as const;

const rect = (x: number, y: number, width: number, height: number): Rect =>
  ({ x, y, width, height });
function preset(id: PlatformPreset, top: number, bottom: number,
  right: number, headerBottom = top - 20): PlatformLayoutPreset {
  const canvasWidth = 1080, canvasHeight = 1920;
  const videoViewport = rect(0, top, 1080, bottom - top);
  const headerBounds = rect(0, 0, 1080, headerBottom);
  const footerBounds = rect(0, bottom, 1080, 1920 - bottom);
  // Anchored off the video, not the canvas: the zone's bottom edge IS the
  // headline's baseline, one deliberate gap above the footage. Ambient
  // background keeps the unused space above it; the headline never floats up
  // into it just because the header is tall.
  const hookBottom = top - HOOK_PLACEMENT.targetGapAboveVideo;
  const hookZone = rect(100, HOOK_PLACEMENT.topSafe, 880,
    Math.max(HOOK_PLACEMENT.minZoneHeight, hookBottom - HOOK_PLACEMENT.topSafe));
  // Lower-middle of the viewport, clear of the right-side action rail.
  const subtitleZone = rect(110, Math.round(top + (bottom - top) * .59),
    1080 - 110 - Math.max(110, right - 40), Math.round((bottom - top) * .23));
  return { id, canvasWidth, canvasHeight, headerBounds, footerBounds,
    topSafeZone: rect(0, 0, 1080, 80),
    bottomSafeZone: footerBounds,
    leftSafeZone: rect(0, 0, 100, 1920),
    rightSafeZone: rect(1080 - right, top, right, 1920 - top),
    hookZone, hookGapAboveVideo: top - (hookZone.y + hookZone.height),
    videoViewport, subtitleZone,
    subjectSafeZone: rect(115, top + 110, 1080 - 230 - right,
      Math.round((bottom - top) * .61)),
    avoidUIZones: [rect(1080 - right, top, right, 1920 - top),
      rect(0, bottom, 1080, 1920 - bottom)],
    preferredComposition: 'EDITORIAL_FRAME' };
}
export const PLATFORM_LAYOUT_PRESETS: Record<PlatformPreset, PlatformLayoutPreset> = {
  UNIVERSAL: preset('UNIVERSAL', 422, 1668, 175),
  UNIVERSAL_SOCIAL: preset('UNIVERSAL_SOCIAL', 422, 1668, 175),
  INSTAGRAM_REELS: preset('INSTAGRAM_REELS', 360, 1540, 180, 340),
  YOUTUBE_SHORTS: preset('YOUTUBE_SHORTS', 422, 1670, 170),
  TIKTOK: preset('TIKTOK', 461, 1632, 195)
};

/**
 * Expands a landscape source's meaningful video region into footer space that
 * would otherwise be decorative blur. The hook geometry and platform UI safe
 * rails remain unchanged; subtitles and subject-safe bounds are recalculated
 * against the larger viewport.
 */
export function sourceAwarePlatformLayout(base: PlatformLayoutPreset,
  sourceWidth: number, sourceHeight: number): PlatformLayoutPreset {
  if (sourceWidth <= sourceHeight) return base;
  const footerHeight = base.id === 'TIKTOK' ? 250 : 180;
  const bottom = Math.max(base.videoViewport.y + 720,
    base.canvasHeight - footerHeight);
  if (bottom <= base.videoViewport.y + base.videoViewport.height) return base;
  const videoViewport = rect(base.videoViewport.x, base.videoViewport.y,
    base.videoViewport.width, bottom - base.videoViewport.y);
  const footerBounds = rect(0, bottom, base.canvasWidth, base.canvasHeight - bottom);
  const right = base.rightSafeZone.width;
  const subtitleZone = rect(110,
    Math.round(videoViewport.y + videoViewport.height * .59),
    base.canvasWidth - 110 - Math.max(110, right - 40),
    Math.round(videoViewport.height * .23));
  const subjectSafeZone = rect(115, videoViewport.y + 110,
    base.canvasWidth - 230 - right, Math.round(videoViewport.height * .61));
  const rightSafeZone = rect(base.canvasWidth - right, videoViewport.y, right,
    base.canvasHeight - videoViewport.y);
  return { ...base, videoViewport, footerBounds, bottomSafeZone: footerBounds,
    subtitleZone, subjectSafeZone, rightSafeZone,
    avoidUIZones: [rightSafeZone, footerBounds] };
}

export function usableContentAreaRatio(layout: PlatformLayoutPreset) {
  return Number((layout.videoViewport.width * layout.videoViewport.height /
    (layout.canvasWidth * layout.canvasHeight)).toFixed(4));
}
export function chooseVideoTemplate(sourceWidth: number, sourceHeight: number,
  selected?: VideoTemplate, recommended?: VideoTemplate): VideoTemplate {
  const allowed: VideoTemplate[] = ['FULL_SCREEN_SOCIAL', 'EDITORIAL_FRAME',
    'PODCAST_FRAME', 'DUAL_SPEAKER', 'CLEAN_DOCUMENTARY'];
  if (selected && allowed.includes(selected)) return selected;
  if (recommended && allowed.includes(recommended)) return recommended;
  return sourceWidth > sourceHeight ? 'EDITORIAL_FRAME' : 'FULL_SCREEN_SOCIAL';
}
const inside = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y &&
  a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
export function validatePlatformLayout(layout: PlatformLayoutPreset,
  hookBounds: Rect | null, subtitleBounds: Rect | null,
  subjectBounds: Rect | null) {
  const canvas = rect(0, 0, layout.canvasWidth, layout.canvasHeight);
  const violations: string[] = [];
  if (hookBounds && !inside(hookBounds, layout.hookZone))
    violations.push('HOOK_TOP_MARGIN');
  // The headline must clear the platform UI band at the top...
  const hookNotTooHigh = hookBounds ? hookBounds.y >= layout.hookZone.y - 2 : null;
  if (hookNotTooHigh === false) violations.push('HOOK_TOO_HIGH');
  // ...and keep a visible gap above the footage.
  const hookGapAboveVideoPx = hookBounds ?
    layout.videoViewport.y - (hookBounds.y + hookBounds.height) : null;
  // Both bounds matter: too small and the headline crowds the footage, too large
  // and it drifts back up toward the top edge it is supposed to have left.
  const hookGapAboveVideoValid = hookGapAboveVideoPx == null ? null :
    hookGapAboveVideoPx >= HOOK_PLACEMENT.minGapAboveVideo &&
    hookGapAboveVideoPx <= HOOK_PLACEMENT.maxGapAboveVideo;
  if (hookGapAboveVideoValid === false) violations.push('HOOK_GAP_ABOVE_VIDEO');
  if (subtitleBounds && !inside(subtitleBounds, layout.subtitleZone))
    violations.push('SUBTITLE_BOTTOM_UI_COLLISION');
  if (subjectBounds && !inside(subjectBounds, layout.subjectSafeZone))
    violations.push('FACE_RIGHT_UI_COLLISION');
  if ([layout.videoViewport, hookBounds, subtitleBounds].some((item) =>
    item && !inside(item, canvas))) violations.push('OUTSIDE_CANVAS');
  return { platformLayoutSafe: violations.length === 0, violations,
    hookNotTooHigh, hookGapAboveVideoValid, hookGapAboveVideoPx,
    hookPositionValid: hookBounds ? violations.every((item) => !item.startsWith('HOOK')) : null,
    rightSideUIClearance: subtitleBounds ?
      layout.canvasWidth - (subtitleBounds.x + subtitleBounds.width) -
      layout.rightSafeZone.width : null,
    bottomUIClearance: subtitleBounds ?
      layout.bottomSafeZone.y - (subtitleBounds.y + subtitleBounds.height) : null,
    topClearance: hookBounds ? hookBounds.y : null };
}
