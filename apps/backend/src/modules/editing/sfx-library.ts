import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { extname, join, resolve } from 'path';

/**
 * Editorial sound design for AI_EDITED clips: one short, subtle effect per
 * camera-motion or emphasis event. Deliberately not a meme-sound system - every
 * effect sits under the dialogue and exists only because an edit event happened.
 */
export type SfxType = 'ZOOM_IN' | 'ZOOM_OUT' | 'REVEAL' | 'STAT_HIT' | 'TRANSITION' | 'IMPACT_LIGHT';
export const SFX_TYPES: SfxType[] = ['ZOOM_IN', 'ZOOM_OUT', 'REVEAL', 'STAT_HIT',
  'TRANSITION', 'IMPACT_LIGHT'];

// A category's folder name is all the classification a dropped-in file needs,
// exactly like the curated music library's mood folders.
export const SFX_CATEGORY_FOLDERS: Record<SfxType, string> = {
  ZOOM_IN: 'zoom-in', ZOOM_OUT: 'zoom-out', REVEAL: 'reveal',
  STAT_HIT: 'stat', TRANSITION: 'transition', IMPACT_LIGHT: 'impact' };
const FOLDER_TYPES: Record<string, SfxType> = Object.fromEntries(
  Object.entries(SFX_CATEGORY_FOLDERS).map(([type, folder]) => [folder, type as SfxType]));

export const SUPPORTED_SFX_FORMATS = ['.wav', '.mp3', '.m4a', '.ogg', '.flac'];

// Category fallbacks: a missing folder borrows from the nearest relative rather
// than dropping the effect, so sound design degrades in character, not presence.
const RELATED_SFX: Record<SfxType, SfxType[]> = {
  ZOOM_IN: ['TRANSITION', 'IMPACT_LIGHT'],
  ZOOM_OUT: ['TRANSITION', 'ZOOM_IN'],
  TRANSITION: ['ZOOM_IN', 'ZOOM_OUT'],
  REVEAL: ['IMPACT_LIGHT', 'STAT_HIT'],
  STAT_HIT: ['IMPACT_LIGHT', 'REVEAL'],
  IMPACT_LIGHT: ['STAT_HIT', 'REVEAL']
};

export type SfxAsset = { id: string; type: SfxType; path: string; title: string;
  license: string; loudnessLufs: number; priority: number; weight: number;
  format?: string; generated: boolean };

/**
 * Target level of each effect, in LUFS, before the clip's final loudness
 * normalization pulls speech to -16. Every category lands at least 8 dB under
 * the voice on its own, and the speech sidechain pushes it further down while
 * words are actually being spoken.
 */
export const SFX_TARGET_LUFS: Record<SfxType, number> = {
  ZOOM_IN: -26, ZOOM_OUT: -26, TRANSITION: -28, REVEAL: -24, STAT_HIT: -24, IMPACT_LIGHT: -27 };
// Matched to the category target in both directions, but with bounded makeup:
// a quiet asset is brought up to where the effect belongs, never further, so a
// mis-declared file cannot turn into the loudest thing in the mix.
export const SFX_MAX_MAKEUP_DB = 12;
export function sfxGainDb(asset: SfxAsset, type: SfxType) {
  return Math.max(-40, Math.min(SFX_MAX_MAKEUP_DB, SFX_TARGET_LUFS[type] - asset.loudnessLufs));
}

/**
 * In-house generated effects, synthesized inside the render graph. They exist so
 * that motion always has matching sound design even before anyone drops a file
 * into assets/sfx/, and they are deliberately plain: a filtered noise swell or a
 * soft low sine, never a cartoon sting. A real asset always outranks them.
 */
// `lufs` is each source's own measured RMS, so sfxGainDb lands it on its category
// target; scripts/test-motion-sfx.cjs re-measures them and fails if they drift.
export const GENERATED_SFX: Record<SfxType, { source: string; durationSec: number; lufs: number }> = {
  // Soft rising whoosh: pink noise swelling into the motion, then gone.
  // The swell has to be audible from the frame the motion starts on, so it rises
  // on a quadratic rather than an exponential curve: an exp fade is still near
  // silence 130 ms in, which reads as a late effect however it was placed.
  ZOOM_IN: { durationSec: .42, lufs: -32.8,
    source: 'anoisesrc=c=pink:a=0.5:d=0.42:r=48000,flanger=delay=3:depth=5:speed=1.6,' +
      'bandpass=f=1600:width_type=o:width=2.6,afade=t=in:st=0:d=0.16:curve=qua,' +
      'afade=t=out:st=0.30:d=0.12' },
  // Reverse whoosh / air pull: the energy is at the front and breathes away.
  ZOOM_OUT: { durationSec: .42, lufs: -40,
    source: 'anoisesrc=c=pink:a=0.5:d=0.42:r=48000,flanger=delay=3:depth=5:speed=1.2,' +
      'bandpass=f=900:width_type=o:width=2.6,afade=t=in:st=0:d=0.05,afade=t=out:st=0.06:d=0.34:curve=exp' },
  // Subtle sweep across a hard change of frame.
  TRANSITION: { durationSec: .5, lufs: -32.8,
    source: 'anoisesrc=c=pink:a=0.4:d=0.5:r=48000,bandpass=f=1200:width_type=o:width=3,' +
      'afade=t=in:st=0:d=0.22:curve=tri,afade=t=out:st=0.24:d=0.26:curve=tri' },
  // Short tonal hit on the reveal word.
  REVEAL: { durationSec: .5, lufs: -21.9,
    source: "aevalsrc='0.35*sin(2*PI*523.25*t)+0.2*sin(2*PI*784*t)':d=0.5:s=48000," +
      'lowpass=f=4000,afade=t=out:st=0.02:d=0.46:curve=exp' },
  // Very light low impact under a number or statistic.
  STAT_HIT: { durationSec: .35, lufs: -20.4,
    source: "aevalsrc='0.5*sin(2*PI*96*t)+0.12*sin(2*PI*192*t)':d=0.35:s=48000," +
      'lowpass=f=1200,afade=t=out:st=0.01:d=0.33:curve=exp' },
  // Low-intensity accent for a punchline or hard statement.
  IMPACT_LIGHT: { durationSec: .4, lufs: -21.4,
    source: "aevalsrc='0.4*sin(2*PI*140*t)':d=0.4:s=48000," +
      'lowpass=f=900,afade=t=out:st=0.02:d=0.37:curve=exp' }
};

export function generatedSfxAsset(type: SfxType): SfxAsset {
  const spec = GENERATED_SFX[type];
  return { id: `generated-${SFX_CATEGORY_FOLDERS[type]}`, type, path: `lavfi:${spec.source}`,
    title: `Generated ${type}`, license: 'GENERATED_IN_HOUSE', loudnessLufs: spec.lufs,
    priority: 0, weight: 1, generated: true };
}

export function sfxLibraryDir() {
  return resolve(process.env.EDIT_SFX_DIR || join(process.cwd(), 'assets', 'sfx'));
}

export function sfxPolicy() {
  const flag = (name: string, fallback: boolean) => {
    const value = process.env[name]?.toLowerCase();
    return value == null || value === '' ? fallback : value === 'true';
  };
  // Sound design is OFF by default for the same reason music is (see musicPolicy):
  // AI_EDITED clips carry dialogue/source audio only. No zoom whoosh, transition,
  // impact or stat hit is selected or mixed, and the SFX checks become N/A.
  return { enabled: flag('EDIT_SFX_ENABLED', false),
    // The generated effects are why sound design works out of the box; turn them
    // off to ship only your own assets.
    allowGenerated: flag('EDIT_SFX_ALLOW_GENERATED', true) };
}

type Override = { type?: SfxType; license?: string; loudnessLufs?: number; weight?: number;
  priority?: number; enabled?: boolean; title?: string };

function parseOverride(item: Record<string, unknown>): [string, Override] | null {
  const file = typeof item.file === 'string' ? item.file : '';
  if (!file) return null;
  const type = String(item.type ?? '').toUpperCase();
  return [file.replace(/\\/gu, '/'), {
    ...(SFX_TYPES.includes(type as SfxType) ? { type: type as SfxType } : {}),
    ...(typeof item.license === 'string' ? { license: item.license.toUpperCase() } : {}),
    ...(Number.isFinite(Number(item.loudnessLufs)) ? { loudnessLufs: Number(item.loudnessLufs) } : {}),
    ...(Number.isFinite(Number(item.weight)) ? { weight: Math.max(0, Number(item.weight)) } : {}),
    ...(Number.isFinite(Number(item.priority)) ? { priority: Number(item.priority) } : {}),
    ...(typeof item.enabled === 'boolean' ? { enabled: item.enabled } : {}),
    ...(typeof item.title === 'string' ? { title: item.title } : {}) }];
}

/**
 * Scans `<sfxDir>/<category>/` for audio files. Unlike the music library there is
 * no mandatory manifest: a file dropped into assets/sfx/zoom-in/ is a ZOOM_IN
 * effect. An optional `sfx.json` at the root refines individual files
 * (`{ "assets": [{ "file": "zoom-in/whoosh-a.wav", "loudnessLufs": -18 }] }`).
 * Nothing is ever downloaded, so only assets you put there are ever used.
 */
export async function loadSfxLibrary(directory = sfxLibraryDir()) {
  const problems: string[] = [];
  const assets: SfxAsset[] = [];
  if (!existsSync(directory)) return { assets, problems: ['SFX_LIBRARY_MISSING'] };
  const overrides = new Map<string, Override>();
  const manifestPath = join(directory, 'sfx.json');
  if (existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as { assets?: unknown };
      for (const entry of Array.isArray(raw.assets) ? raw.assets : []) {
        if (!entry || typeof entry !== 'object') continue;
        const parsed = parseOverride(entry as Record<string, unknown>);
        if (parsed) overrides.set(parsed[0], parsed[1]);
      }
    } catch { problems.push('SFX_MANIFEST_INVALID'); }
  }
  for (const [folder, type] of Object.entries(FOLDER_TYPES)) {
    const folderPath = join(directory, folder);
    if (!existsSync(folderPath)) continue;
    let names: string[] = [];
    try { names = await readdir(folderPath); }
    catch { problems.push(`SFX_FOLDER_UNREADABLE:${folder}`); continue; }
    for (const name of names.sort()) {
      const format = extname(name).toLowerCase();
      if (!format) continue;
      const key = `${folder}/${name}`;
      if (!SUPPORTED_SFX_FORMATS.includes(format)) {
        problems.push(`UNSUPPORTED_SFX_FORMAT:${key}`); continue;
      }
      const override = overrides.get(key) ?? {};
      if (override.enabled === false) { problems.push(`DISABLED_SFX:${key}`); continue; }
      const weight = override.weight ?? 1;
      if (weight === 0) { problems.push(`ZERO_WEIGHT_SFX:${key}`); continue; }
      assets.push({ id: key, type: override.type ?? type, path: join(folderPath, name),
        title: override.title ?? name, license: override.license ?? 'LOCAL_ASSET',
        loudnessLufs: override.loudnessLufs ?? -20,
        // Your own files always outrank the generated ones.
        priority: override.priority ?? 10, weight, format, generated: false });
    }
  }
  if (!assets.length && !problems.length) problems.push('SFX_LIBRARY_EMPTY');
  return { assets, problems };
}

const hash = (value: string) => [...value].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 11);

/**
 * Deterministic pick with variety: the requested category, then a related one,
 * then the generated effect. `seed` spreads choices across clips and `index`
 * rotates within one clip so two zoom-ins in a row are not the identical whoosh.
 */
export function selectSfx(assets: SfxAsset[], type: SfxType, seed: string, index = 0,
  allowGenerated = true): SfxAsset | null {
  for (const candidate of [type, ...RELATED_SFX[type]]) {
    const matching = assets.filter((asset) => asset.type === candidate);
    if (!matching.length) continue;
    const top = Math.max(...matching.map((asset) => asset.priority));
    const pool = matching.filter((asset) => asset.priority === top)
      .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
    const best = pool.filter((asset) => asset.weight >= pool[0].weight - 1e-6);
    return best[(hash(seed) + index) % best.length];
  }
  return allowGenerated ? generatedSfxAsset(type) : null;
}
