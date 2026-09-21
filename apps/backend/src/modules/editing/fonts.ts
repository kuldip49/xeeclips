import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Typefaces the renderer asks libass for.
 *
 * `Inter ExtraBold` is an exact fontconfig family name provided by the `font-inter`
 * package installed in the backend image (see apps/backend/Dockerfile) - a clean
 * geometric sans that reads as a modern caption face rather than the system UI
 * font. `Inter` (resolved bold) carries the editorial headline on its plate.
 *
 * Nothing here is assumed: `resolveFontFamily` asks fontconfig what the name
 * actually resolves to and falls back to Noto Sans - which the image has always
 * carried - when the requested family is not installed, so a missing font shows
 * up as a reported fallback instead of silently rendering in a random face.
 */
export const SUBTITLE_FONT = process.env.EDIT_SUBTITLE_FONT || 'Inter ExtraBold';
export const HOOK_FONT = process.env.EDIT_HOOK_FONT || 'Inter';
export const FALLBACK_FONT = 'Noto Sans';

// Inter's caps are a little wider than Noto Sans' at the same nominal size, so
// the width estimates in text-layout are scaled by this before fitting. The hook
// re-measures itself against real libass glyph bounds anyway; this only has to
// keep the first attempt close and keep captions inside their zone.
export const FONT_WIDTH_FACTOR: Record<string, number> = { Inter: 1.06 };
export function fontWidthFactor(family: string) {
  const key = Object.keys(FONT_WIDTH_FACTOR).find((name) => family.startsWith(name));
  return key ? FONT_WIDTH_FACTOR[key] : 1;
}

export type ResolvedFont = { requested: string; family: string; available: boolean };
const cache = new Map<string, ResolvedFont>();

/**
 * What fontconfig (and therefore libass) will actually use for `requested`.
 * A family that resolves to something else is not installed, so the caller is
 * given `fallback` instead and `available: false` to report.
 */
export async function resolveFontFamily(requested: string,
  fallback = FALLBACK_FONT): Promise<ResolvedFont> {
  const cached = cache.get(requested);
  if (cached) return cached;
  let resolved: ResolvedFont = { requested, family: fallback, available: false };
  try {
    const { stdout } = await execFileAsync('fc-match', ['-f', '%{family}', requested],
      { timeout: 5000 });
    // fc-match prints every alias of the matched face, e.g. "Inter,Inter ExtraBold".
    const families = stdout.split(',').map((name) => name.trim()).filter(Boolean);
    const available = families.some((name) =>
      name.toLowerCase() === requested.toLowerCase());
    resolved = { requested, family: available ? requested : fallback, available };
  } catch { /* no fontconfig on this host: fall back rather than guess */ }
  cache.set(requested, resolved);
  return resolved;
}
