import type { PlatformPreset, SubtitleThemeName } from './edit-plan';

export type SubtitleTheme = {
  // accent: the active spoken word; keyword: semantically emphasized words.
  base: string; accent: string; keyword: string; hook: string; stroke: string; shadow: string;
  box: string; boxOpacity: number; fontWeight: 700 | 800; subtitleBox: boolean;
};

// ASS colors are &HAABBGGRR. Each preset keeps a dark stroke for bright footage.
export const SUBTITLE_THEMES: Record<SubtitleThemeName, SubtitleTheme> = {
  CLEAN_WHITE: { base: '&H00FFFFFF', accent: '&H00F0DDAD', keyword: '&H004AD5FF', hook: '&H00FFFFFF',
    stroke: '&H000D111C', shadow: '&H70000000', box: '&H900B1018',
    boxOpacity: .45, fontWeight: 700, subtitleBox: false },
  HIGH_CONTRAST: { base: '&H00FFFFFF', accent: '&H0000E4FF', keyword: '&H00FFE500', hook: '&H00FFFFFF',
    stroke: '&H00000000', shadow: '&H50000000', box: '&H70000000',
    boxOpacity: .55, fontWeight: 800, subtitleBox: false },
  WARM_ACCENT: { base: '&H00FFFFFF', accent: '&H0059CFFF', keyword: '&H00457AFF', hook: '&H00FFFFFF',
    stroke: '&H00100D13', shadow: '&H65000000', box: '&H850E0B12',
    boxOpacity: .48, fontWeight: 800, subtitleBox: false },
  COOL_ACCENT: { base: '&H00FFFFFF', accent: '&H00EBCB8B', keyword: '&H004AD5FF', hook: '&H00FFFFFF',
    stroke: '&H00121117', shadow: '&H65000000', box: '&H850D1218',
    boxOpacity: .48, fontWeight: 800, subtitleBox: false },
  BOLD_SOCIAL: { base: '&H00FFFFFF', accent: '&H006BD6FF', keyword: '&H003D8FFF', hook: '&H00FFFFFF',
    stroke: '&H000A0D16', shadow: '&H50000000', box: '&H800A0D16',
    boxOpacity: .52, fontWeight: 800, subtitleBox: false }
};

export type PlatformSafeZone = { top: number; bottom: number; left: number; right: number;
  hookY: number[]; subtitleY: number[]; calloutY: number[] };

// Coordinates are fractions of the output frame. Vertical presets deliberately
// keep text away from bottom controls and the right-side action rail.
export const PLATFORM_SAFE_ZONES: Record<PlatformPreset, PlatformSafeZone> = {
  UNIVERSAL: { top: .07, bottom: .79, left: .09, right: .09,
    hookY: [.17, .24, .31], subtitleY: [.65, .60, .70], calloutY: [.47, .55, .38] },
  UNIVERSAL_SOCIAL: { top: .07, bottom: .79, left: .09, right: .09,
    hookY: [.17, .24, .31], subtitleY: [.65, .60, .70], calloutY: [.47, .55, .38] },
  INSTAGRAM_REELS: { top: .12, bottom: .78, left: .12, right: .17,
    hookY: [.22, .30, .38], subtitleY: [.68, .60, .73], calloutY: [.46, .54, .37] },
  YOUTUBE_SHORTS: { top: .11, bottom: .79, left: .12, right: .17,
    hookY: [.21, .29, .37], subtitleY: [.68, .60, .73], calloutY: [.47, .55, .38] },
  TIKTOK: { top: .13, bottom: .76, left: .12, right: .18,
    hookY: [.23, .31, .39], subtitleY: [.66, .59, .71], calloutY: [.47, .54, .39] }
};

export function resolveTheme(name: SubtitleThemeName): SubtitleTheme {
  return SUBTITLE_THEMES[name] ?? SUBTITLE_THEMES.BOLD_SOCIAL;
}
export function resolveSafeZone(name: PlatformPreset, vertical: boolean): PlatformSafeZone {
  if (vertical) return PLATFORM_SAFE_ZONES[name] ?? PLATFORM_SAFE_ZONES.UNIVERSAL;
  return { top: .09, bottom: .88, left: .08, right: .08,
    hookY: [.16, .26, .38], subtitleY: [.84, .73, .65], calloutY: [.48, .58, .38] };
}
