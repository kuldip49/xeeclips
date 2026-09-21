// Scans the curated music folders you populate yourself and writes
// assets/music/curated.json, the manifest the renderer reads alongside the
// generated beds in library.json.
//
//   node scripts/scan-music-library.cjs [musicDir] [--license OWNED] [--no-loudness]
//
// Drop your own licensed / royalty-free / owned / in-house-generated audio into
// the mood folders:
//
//   assets/music/documentary/   assets/music/tension/    assets/music/neutral/
//   assets/music/podcast/       assets/music/technology/ assets/music/energetic/
//   assets/music/motivational/  assets/music/emotional/  assets/music/atmospheric/
//
// The folder name supplies the default mood. Per-track metadata can override
// anything by placing <track>.json next to the file, or a meta.json in the
// folder keyed by filename. Nothing is ever downloaded: only files already on
// disk are indexed.
//
// License is mandatory for production. A track whose license is not one of
// OWNED / LICENSED / ROYALTY_FREE_APPROVED / GENERATED_IN_HOUSE / CC0 /
// ROYALTY_FREE_LICENSED is written to the manifest but the renderer refuses it
// unless EDIT_MUSIC_ALLOW_UNLICENSED=true.
const { execFileSync, spawnSync } = require('node:child_process');
const { readdirSync, readFileSync, writeFileSync, existsSync, statSync } = require('node:fs');
const { join, resolve, extname, basename } = require('node:path');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const positional = args.filter((value, index) =>
  !value.startsWith('--') && args[index - 1] !== '--license');
const root = resolve(positional[0] || process.env.EDIT_MUSIC_DIR ||
  join(__dirname, '..', 'assets', 'music'));
const defaultLicense = String(option('--license', process.env.EDIT_MUSIC_DEFAULT_LICENSE || 'UNKNOWN')).toUpperCase();
const measureLoudness = !flag('--no-loudness');

// Kept in step with SUPPORTED_MUSIC_FORMATS / MUSIC_FOLDER_MOODS in
// src/modules/editing/music-library.ts.
const FORMATS = ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac'];
const FOLDER_MOODS = {
  documentary: 'SUBTLE_DOCUMENTARY', podcast: 'SUBTLE_DOCUMENTARY', interview: 'SUBTLE_DOCUMENTARY',
  tension: 'DOCUMENTARY_TENSION', dramatic: 'DOCUMENTARY_TENSION',
  technology: 'MODERN_MINIMAL', tech: 'MODERN_MINIMAL',
  motivational: 'ENERGETIC_LIGHT', energetic: 'ENERGETIC_LIGHT', upbeat: 'ENERGETIC_LIGHT',
  emotional: 'CALM_WARM', warm: 'CALM_WARM', calm: 'CALM_WARM',
  neutral: 'CLEAN_NEUTRAL', clean: 'CLEAN_NEUTRAL', educational: 'CLEAN_NEUTRAL',
  atmospheric: 'ATMOSPHERIC', ambient: 'ATMOSPHERIC'
};
const ALLOWED_LICENSES = new Set(['OWNED', 'LICENSED', 'ROYALTY_FREE_APPROVED',
  'GENERATED_IN_HOUSE', 'CC0', 'ROYALTY_FREE_LICENSED']);
// The renderer places a rhythmic bed lower than a pad, so the guess matters.
const ENERGY_BY_MOOD = { DOCUMENTARY_TENSION: 'MEDIUM', SUBTLE_DOCUMENTARY: 'LOW',
  ATMOSPHERIC: 'LOW', CALM_WARM: 'LOW', CLEAN_NEUTRAL: 'LOW', MODERN_MINIMAL: 'MEDIUM',
  ENERGETIC_LIGHT: 'HIGH' };

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

function probe(path) {
  const { duration, format } = (() => {
    try {
      const stdout = execFileSync('ffprobe', ['-v', 'error', '-show_entries',
        'format=duration,format_name', '-of', 'json', path], { encoding: 'utf8' });
      const info = JSON.parse(stdout).format ?? {};
      return { duration: Number(info.duration), format: info.format_name };
    } catch { return { duration: NaN, format: null }; }
  })();
  let loudnessLufs = null;
  if (measureLoudness) {
    // ebur128 prints its integrated loudness on stderr at the end of the pass,
    // so stderr is the output that matters here.
    const run = spawnSync('ffmpeg', ['-v', 'info', '-nostats', '-i', path,
      '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    let last = null;
    for (const found of String(run.stderr ?? '').matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/gu))
      last = Number(found[1]);
    if (Number.isFinite(last)) loudnessLufs = last;
  }
  return { durationSec: Number.isFinite(duration) ? Number(duration.toFixed(2)) : null,
    container: format, loudnessLufs };
}

function scanFolder(folder) {
  const directory = join(root, folder);
  const mood = FOLDER_MOODS[folder.toLowerCase()];
  if (!mood) return [];
  const folderMeta = readJson(join(directory, 'meta.json')) ?? {};
  const tracks = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (!statSync(path).isFile()) continue;
    const extension = extname(name).toLowerCase();
    if (!FORMATS.includes(extension)) continue;
    const stem = basename(name, extension);
    const override = { ...(folderMeta[name] ?? folderMeta[stem] ?? {}),
      ...(readJson(join(directory, `${stem}.json`)) ?? {}) };
    const probed = probe(path);
    const license = String(override.license ?? override.licenseType ?? defaultLicense).toUpperCase();
    if (!ALLOWED_LICENSES.has(license))
      console.warn(`  ! ${folder}/${name}: license ${license} is not production-approved`);
    if (probed.durationSec == null)
      console.warn(`  ! ${folder}/${name}: could not be decoded by ffprobe - skipped`);
    if (probed.durationSec == null) continue;
    tracks.push({
      id: override.id ?? `curated-${folder}-${stem}`.toLowerCase().replace(/[^a-z0-9-]+/gu, '-'),
      file: `${folder}/${name}`,
      title: override.title ?? stem.replace(/[_-]+/gu, ' ').trim(),
      moods: Array.isArray(override.moods) && override.moods.length ? override.moods : [mood],
      license,
      loudnessLufs: Number.isFinite(Number(override.loudnessLufs)) ? Number(override.loudnessLufs) :
        probed.loudnessLufs ?? -20,
      durationSec: probed.durationSec,
      format: extension,
      energy: override.energy ?? ENERGY_BY_MOOD[mood] ?? 'LOW',
      texture: override.texture ?? (mood === 'ENERGETIC_LIGHT' ? 'PULSE' : 'PAD'),
      enabled: override.enabled !== false,
      weight: Number.isFinite(Number(override.weight)) ? Number(override.weight) : 1,
      ...(override.priority != null ? { priority: Number(override.priority) } : {}),
      ...(override.attribution ? { attribution: String(override.attribution) } : {})
    });
  }
  return tracks;
}

function main() {
  if (!existsSync(root)) {
    console.error(`Music directory not found: ${root}`);
    process.exit(1);
  }
  const folders = readdirSync(root).filter((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() && FOLDER_MOODS[name.toLowerCase()];
  }).sort();
  const tracks = [];
  for (const folder of folders) {
    const found = scanFolder(folder);
    if (found.length) console.log(`  ${folder}: ${found.length} track(s)`);
    tracks.push(...found);
  }
  const manifest = { generatedBy: 'scripts/scan-music-library.cjs',
    scannedAt: new Date().toISOString(), root: '.', tracks };
  writeFileSync(join(root, 'curated.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const usable = tracks.filter((track) => track.enabled && ALLOWED_LICENSES.has(track.license));
  console.log(`Curated music manifest written: ${usable.length} usable of ${tracks.length} scanned in ${root}`);
  if (!tracks.length)
    console.log('Drop your own licensed or royalty-free audio into the mood folders and re-run.');
}
main();
