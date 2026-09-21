import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { extname, isAbsolute, join, resolve } from 'path';

// SUBTLE_DOCUMENTARY: podcasts/interviews/news; MODERN_MINIMAL: technology.
export type MusicMood = 'DOCUMENTARY_TENSION' | 'CLEAN_NEUTRAL' | 'ENERGETIC_LIGHT' |
  'CALM_WARM' | 'ATMOSPHERIC' | 'SUBTLE_DOCUMENTARY' | 'MODERN_MINIMAL' | 'NONE';
export const MUSIC_MOODS: MusicMood[] = ['DOCUMENTARY_TENSION', 'CLEAN_NEUTRAL',
  'ENERGETIC_LIGHT', 'CALM_WARM', 'ATMOSPHERIC', 'SUBTLE_DOCUMENTARY', 'MODERN_MINIMAL', 'NONE'];
// Only tracks whose manifest declares one of these licenses are ever used. A
// track with an unknown or missing license is never production material; set
// EDIT_MUSIC_ALLOW_UNLICENSED=true to audition one locally.
export const ALLOWED_MUSIC_LICENSES = new Set(['OWNED', 'LICENSED', 'ROYALTY_FREE_APPROVED',
  'GENERATED_IN_HOUSE', 'CC0', 'ROYALTY_FREE_LICENSED']);
// Formats FFmpeg decodes safely; the render graph normalises them anyway.
export const SUPPORTED_MUSIC_FORMATS = ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac'];
// A curated folder's name is the track's default mood, so dropping a file into
// assets/music/tension/ is all the classification a track needs.
export const MUSIC_FOLDER_MOODS: Record<string, MusicMood> = {
  documentary: 'SUBTLE_DOCUMENTARY', podcast: 'SUBTLE_DOCUMENTARY', interview: 'SUBTLE_DOCUMENTARY',
  tension: 'DOCUMENTARY_TENSION', dramatic: 'DOCUMENTARY_TENSION',
  technology: 'MODERN_MINIMAL', tech: 'MODERN_MINIMAL',
  motivational: 'ENERGETIC_LIGHT', energetic: 'ENERGETIC_LIGHT', upbeat: 'ENERGETIC_LIGHT',
  emotional: 'CALM_WARM', warm: 'CALM_WARM', calm: 'CALM_WARM',
  neutral: 'CLEAN_NEUTRAL', clean: 'CLEAN_NEUTRAL', educational: 'CLEAN_NEUTRAL',
  atmospheric: 'ATMOSPHERIC', ambient: 'ATMOSPHERIC'
};
// `priority` lets approved/licensed tracks dropped into the library outrank the
// generated beds (default: 0 for generated, 10 otherwise). A `lavfi:` path is an
// in-graph FFmpeg source instead of a file.
export type MusicEnergy = 'LOW' | 'MEDIUM' | 'HIGH';
export type MusicTexture = 'PAD' | 'DRONE' | 'PULSE';
export type MusicTrack = { id: string; path: string; title: string; moods: MusicMood[];
  license: string; loudnessLufs: number; priority: number; attribution?: string;
  energy?: MusicEnergy; texture?: MusicTexture;
  // Curated-library metadata. `weight` biases selection inside a priority tier
  // (1 = normal); `durationSec` and `format` come from the library scan.
  weight?: number; durationSec?: number; format?: string; curated?: boolean };
// Moods to borrow from when the library has no track for the requested one.
const RELATED_MOODS: Record<MusicMood, MusicMood[]> = {
  DOCUMENTARY_TENSION: ['SUBTLE_DOCUMENTARY', 'ATMOSPHERIC'],
  SUBTLE_DOCUMENTARY: ['ATMOSPHERIC', 'CLEAN_NEUTRAL'],
  ATMOSPHERIC: ['SUBTLE_DOCUMENTARY', 'CALM_WARM'],
  MODERN_MINIMAL: ['CLEAN_NEUTRAL', 'ENERGETIC_LIGHT'],
  ENERGETIC_LIGHT: ['MODERN_MINIMAL', 'CLEAN_NEUTRAL'],
  CALM_WARM: ['ATMOSPHERIC', 'CLEAN_NEUTRAL'],
  CLEAN_NEUTRAL: ['SUBTLE_DOCUMENTARY', 'CALM_WARM'],
  NONE: []
};
// Last-resort bed synthesized inside the render graph (same recipe as
// clean-neutral-01, measured at about -20 LUFS), so a required bed never depends
// on library files being present.
const PAD = [[130.81, .07], [164.81, .079], [196, .088], [246.94, .097]].map(([f, lfo], i) =>
  `0.07*sin(2*PI*${f}*t)*(0.75+0.25*sin(2*PI*${lfo}*t+${i}))`).join('+');
export const INLINE_FALLBACK_TRACK: MusicTrack = { id: 'inline-neutral-pad', title: 'Inline Neutral Pad',
  path: `lavfi:aevalsrc=${PAD}|${PAD}:s=48000:d=600,lowpass=f=5000,highpass=f=45`,
  moods: ['CLEAN_NEUTRAL'], license: 'GENERATED_IN_HOUSE', loudnessLufs: -20, priority: -1,
  energy: 'LOW', texture: 'PAD' };

/**
 * Music is OFF by default: the current editorial standard for AI_EDITED clips is
 * dialogue only, so no bed is selected, mixed or faded and the music QA checks
 * report N/A rather than failing. The whole library/selection/mix architecture
 * below is deliberately left intact - turning EDIT_MUSIC_ENABLED back on is the
 * only thing needed to restore beds.
 */
export function musicPolicy() {
  const flag = (name: string, fallback: boolean) => {
    const value = process.env[name]?.toLowerCase();
    return value == null || value === '' ? fallback : value === 'true';
  };
  return { enabled: flag('EDIT_MUSIC_ENABLED', false), required: flag('EDIT_MUSIC_REQUIRED', false) };
}

/** Your curated library: the mood folders and the curated.json scanned from them. */
export function musicLibraryDir() {
  return resolve(process.env.EDIT_MUSIC_DIR || join(process.cwd(), 'assets', 'music'));
}
/**
 * The generated in-house beds. Deliberately a separate directory: the curated
 * library is a bind mount you own, so the generated fallback cannot live inside
 * it without being hidden by the mount.
 */
export function generatedMusicDir() {
  return resolve(process.env.EDIT_MUSIC_GENERATED_DIR ||
    join(process.cwd(), 'assets', 'music-generated'));
}

/** true when unapproved tracks may be auditioned (never in production). */
export function allowUnlicensedMusic() {
  return process.env.EDIT_MUSIC_ALLOW_UNLICENSED?.toLowerCase() === 'true';
}

function parseTrack(item: Record<string, unknown>, directory: string, curated: boolean,
  problems: string[]): MusicTrack | null {
  const file = typeof item.file === 'string' ? item.file : '';
  const path = isAbsolute(file) ? file : join(directory, file);
  const license = String(item.license ?? item.licenseType ?? '').toUpperCase();
  if (item.enabled === false) { problems.push(`DISABLED_TRACK:${file}`); return null; }
  if (!ALLOWED_MUSIC_LICENSES.has(license) && !allowUnlicensedMusic()) {
    problems.push(`UNLICENSED_TRACK:${file}`); return null;
  }
  if (!file || !existsSync(path)) { problems.push(`MISSING_TRACK:${file}`); return null; }
  const format = (typeof item.format === 'string' ? item.format : extname(path)).toLowerCase();
  if (format && !SUPPORTED_MUSIC_FORMATS.includes(format.startsWith('.') ? format : `.${format}`)) {
    problems.push(`UNSUPPORTED_FORMAT:${file}`); return null;
  }
  const moods = (Array.isArray(item.moods) ? item.moods : [item.mood])
    .map((mood) => String(mood ?? '').toUpperCase())
    .filter((mood): mood is MusicMood => MUSIC_MOODS.includes(mood as MusicMood) && mood !== 'NONE');
  if (!moods.length) { problems.push(`TRACK_WITHOUT_MOOD:${file}`); return null; }
  const weight = Number.isFinite(Number(item.weight)) ? Math.max(0, Number(item.weight)) : 1;
  if (weight === 0) { problems.push(`ZERO_WEIGHT_TRACK:${file}`); return null; }
  return { id: String(item.id ?? file), path, title: String(item.title ?? file), moods, license,
    loudnessLufs: Number.isFinite(Number(item.loudnessLufs)) ? Number(item.loudnessLufs) : -20,
    // Curated material outranks the generated beds by default: the point of the
    // local library is that real tracks are used when they exist.
    priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) :
      license === 'GENERATED_IN_HOUSE' ? 0 : 10,
    weight, curated,
    ...(Number.isFinite(Number(item.durationSec)) ? { durationSec: Number(item.durationSec) } : {}),
    ...(format ? { format: format.startsWith('.') ? format : `.${format}` } : {}),
    ...(['LOW', 'MEDIUM', 'HIGH'].includes(String(item.energy).toUpperCase()) ?
      { energy: String(item.energy).toUpperCase() as MusicEnergy } : {}),
    ...(['PAD', 'DRONE', 'PULSE'].includes(String(item.texture).toUpperCase()) ?
      { texture: String(item.texture).toUpperCase() as MusicTexture } : {}),
    ...(typeof item.attribution === 'string' ? { attribution: item.attribution } : {}) };
}

/**
 * Loads both manifests:
 *   <musicDir>/curated.json           - your own tracks, scanned from the mood folders
 *   <generatedDir>/library.json       - the generated in-house beds
 * They are kept apart on purpose: regenerating the beds can never drop a curated
 * track, and a read-only bind mount over the curated folder cannot hide the
 * generated fallback. A curated track wins an id collision.
 */
export async function loadMusicLibrary(directory = musicLibraryDir(),
  generatedDirectory = generatedMusicDir()) {
  const problems: string[] = [];
  const tracks: MusicTrack[] = [];
  const seen = new Set<string>();
  let found = false;
  const manifests: Array<[string, string, boolean]> = [
    [directory, 'curated.json', true],
    [generatedDirectory, 'library.json', false],
    // Older layouts kept the generated manifest inside the music directory.
    [directory, 'library.json', false]
  ];
  for (const [base, name, curated] of manifests) {
    const manifestPath = join(base, name);
    if (!existsSync(manifestPath)) continue;
    found = true;
    let raw: unknown;
    try { raw = JSON.parse(await readFile(manifestPath, 'utf8')); }
    catch { problems.push(`MUSIC_MANIFEST_INVALID:${name}`); continue; }
    const entries = Array.isArray((raw as { tracks?: unknown })?.tracks) ?
      (raw as { tracks: unknown[] }).tracks : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const track = parseTrack(entry as Record<string, unknown>, base, curated, problems);
      // curated.json is read first, so a curated track wins an id collision.
      if (track && !seen.has(track.id)) { seen.add(track.id); tracks.push(track); }
    }
  }
  if (!found) return { tracks: [], problems: ['MUSIC_LIBRARY_MISSING'] };
  if (!tracks.length && !problems.length) problems.push('MUSIC_LIBRARY_EMPTY');
  return { tracks, problems };
}

const hash = (value: string) => [...value].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);

export type MusicIntent = { energy?: MusicEnergy; texture?: MusicTexture };
const ENERGY_ORDER: MusicEnergy[] = ['LOW', 'MEDIUM', 'HIGH'];

/**
 * Deterministic pick: the requested mood, then related moods, then anything.
 * Within a mood, curated material outranks generated beds (highest `priority`
 * tier wins), and inside that tier tracks are ranked by how well they match the
 * requested energy and texture, then by `weight`. `avoid` holds the track ids
 * already used for other clips from the same source video, so five clips from
 * one video do not all get the same bed; when every candidate has been heard
 * recently the best musical match still wins over variety. `seed` spreads
 * equally-ranked tracks across clips and `attempt` rotates on repair.
 */
export function selectMusicTrack(tracks: MusicTrack[], mood: MusicMood, seed: string, attempt = 0,
  avoid: ReadonlySet<string> = new Set(), intent: MusicIntent = {}) {
  if (mood === 'NONE') return null;
  const fit = (track: MusicTrack) => {
    let score = (track.weight ?? 1);
    if (intent.energy && track.energy)
      score += track.energy === intent.energy ? 1.5 :
        Math.abs(ENERGY_ORDER.indexOf(track.energy) - ENERGY_ORDER.indexOf(intent.energy)) === 1 ? .5 : 0;
    if (intent.texture && track.texture) score += track.texture === intent.texture ? 1 : 0;
    return score;
  };
  for (const candidate of [mood, ...RELATED_MOODS[mood], null]) {
    const matching = tracks.filter((track) => candidate == null || track.moods.includes(candidate));
    if (!matching.length) continue;
    const top = Math.max(...matching.map((track) => track.priority));
    const tier = matching.filter((track) => track.priority === top);
    const bestFit = Math.max(...tier.map(fit));
    const pool = tier.filter((track) => fit(track) >= bestFit - 1e-6)
      .sort((a, b) => a.id.localeCompare(b.id));
    const fresh = pool.filter((track) => !avoid.has(track.id));
    // Variety never costs mood quality: the reuse penalty only picks between
    // tracks that already matched equally well.
    const chosen = fresh.length ? fresh :
      tier.filter((track) => !avoid.has(track.id)).sort((a, b) => fit(b) - fit(a) || a.id.localeCompare(b.id));
    const final = chosen.length ? chosen : pool;
    return final[(hash(seed) + attempt) % final.length];
  }
  return null;
}

// Bed level before ducking, relative to the track's own loudness. Speech is
// normalized to -16 LUFS afterwards; with sidechain ducking the measured bed
// sits roughly 27-32 dB below speech while words are spoken.
// Texture matters as much as mood: a rhythmic bed is far more audible than a
// pad at the same measured level, so it is placed lower.
export function musicGainDb(track: MusicTrack, mood: MusicMood) {
  const base = mood === 'ENERGETIC_LIGHT' ? -30 : -32;
  const textureTrim = track.texture === 'PULSE' ? -1.5 : track.texture === 'DRONE' ? .5 : 0;
  return Math.max(-30, Math.min(6, base + textureTrim - track.loudnessLufs));
}

// Deterministic fallback mood when no editorial model is available. Grave or
// solemn subject matter never gets a bed: a plain NONE reads more professional
// than any track competing with it.
export function fallbackMusicMood(text: string): MusicMood {
  const value = text.toLowerCase();
  if (/\b(death|died|dying|funeral|grief|tragedy|victims?|killed|murder|suicide|abuse|trauma|genocide|massacre|terminal|mourning)\b/u.test(value))
    return 'NONE';
  if (/\b(war|crisis|attack|threat|collapse|scandal|fraud|corruption|violence|debate|protest|lawsuit|indicted|cover-?up|conspiracy)\b/u.test(value))
    return 'DOCUMENTARY_TENSION';
  if (/\b(love|grief|family|lost|remember|faith|hope|forgive|childhood|healing|gratitude)\b/u.test(value))
    return 'CALM_WARM';
  if (/\b(ai|software|app|startup|technology|tech|computer|algorithm|robot|chip|dataset|engineering|saas|crypto)\b/u.test(value))
    return 'MODERN_MINIMAL';
  if (/\b(interview|podcast|government|election|policy|president|congress|senate|economy|court|journalist|reporting)\b/u.test(value))
    return 'SUBTLE_DOCUMENTARY';
  if (/\b(training|workout|hustle|discipline|momentum|motivation|motivated|achieve|launch|milestone)\b/u.test(value))
    return 'ENERGETIC_LIGHT';
  if (/\b(reflect|silence|meaning|universe|philosophy|philosophical|consciousness|existence)\b/u.test(value))
    return 'ATMOSPHERIC';
  return 'CLEAN_NEUTRAL';
}
