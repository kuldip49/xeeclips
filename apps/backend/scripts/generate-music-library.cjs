// Synthesizes the in-house background-music library used by EDITED_CLIPS.
// Every bed is generated procedurally with FFmpeg here, so the library contains
// no third-party recordings and needs no external license.
//   node scripts/generate-music-library.cjs [outputDir]
//
// Each bed is built from three separately filtered lavfi voices instead of one
// raw sine stack, because a stack of continuous sines is exactly what makes a
// generated bed sound cheap:
//   1. tonal   - a felt pad plus a plucked arpeggio and a sub bass, all with
//                per-note decay envelopes and harmonic partials, moving through
//                a four-chord progression (8 s per chord, 32 s cycle).
//   2. rhythm  - noise transients (soft hats) and a filtered low thump, only on
//                the beds whose mood calls for motion.
//   3. air     - very quiet filtered pink noise, so the bed has a noise floor
//                and does not read as a synthetic test tone.
// The three are mixed, de-harshened, lightly compressed and loudness-normalised.
const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

// Separate from the curated library so a read-only mount of the mood folders
// cannot hide the generated fallback beds.
const output = resolve(process.argv[2] || process.env.EDIT_MUSIC_GENERATED_DIR ||
  join(__dirname, '..', 'assets', 'music-generated'));
// 96 s = three full progression cycles: long enough that a short-form clip never
// hears the same bar twice.
const DURATION = 96;
// Bumped whenever the synthesis changes: the rendered files carry the version in
// their name, so an existing library directory picks up new beds instead of
// silently reusing the old ones.
const LIBRARY_VERSION = 'v2';
const CYCLE = 32;
const CHORD = CYCLE / 4;

const NOTES = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
// Equal temperament from scientific pitch notation, e.g. freq('A3') === 220.
function freq(note) {
  const match = /^([A-G]#?)(-?\d)$/u.exec(note);
  if (!match) throw new Error(`Bad note: ${note}`);
  return 440 * Math.pow(2, (NOTES[match[1]] + (Number(match[2]) - 4) * 12 - 9) / 12);
}
const fixed = (value) => Number(value).toFixed(4);
// Picks a per-chord value out of the 32 s progression: if(lt(mod(t,32),8),a,...).
const perChord = (values) => values.slice(0, -1).reduceRight((rest, value, index) =>
  `if(lt(mod(t\\,${CYCLE})\\,${(index + 1) * CHORD})\\,${value}\\,${rest})`,
values[values.length - 1]);

// --- Voices -----------------------------------------------------------------
// A sustained tone with two quiet partials and a slow amplitude drift, crossfaded
// across chord changes so nothing ever switches abruptly.
function pad(chords, gain) {
  const fade = `(0.5-0.5*cos(2*PI*mod(t\\,${CHORD})/${CHORD}))`;
  const voice = (index, partial, amp) => {
    const frequencies = chords.map((chord) => fixed((chord[index % chord.length] ?? chord[0]) * partial));
    const next = chords.map((_, i) => chords[(i + 1) % chords.length])
      .map((chord) => fixed((chord[index % chord.length] ?? chord[0]) * partial));
    // Crossfade this chord's tone into the next one across the chord's own bar.
    return `${amp}*((1-${fade})*sin(2*PI*(${perChord(frequencies)})*t)+` +
      `${fade}*sin(2*PI*(${perChord(next)})*t))`;
  };
  const drift = `(0.82+0.18*sin(2*PI*0.043*t))`;
  return `${gain}*${drift}*(` + [voice(0, 1, 1), voice(1, 1, .8), voice(2, 1, .62),
    voice(0, 2, .18), voice(1, 3, .08)].join('+') + ')';
}
// A struck note: fast attack, exponential decay, three harmonics. `step` is the
// note spacing in seconds; successive notes walk up the chord.
function pluck(chords, gain, step, pattern) {
  const slot = `mod(t\\,${step * pattern.length})`;
  const env = `exp(-${fixed(3.2 / step)}*mod(t\\,${step}))*(1-exp(-260*mod(t\\,${step})))`;
  const noteAt = (position) => chords.map((chord) =>
    fixed(chord[pattern[position] % chord.length] * (pattern[position] >= chord.length ? 2 : 1)));
  const frequency = pattern.slice(0, -1).reduceRight((rest, _, index) =>
    `if(lt(${slot}\\,${fixed((index + 1) * step)})\\,${perChord(noteAt(index))}\\,${rest})`,
  perChord(noteAt(pattern.length - 1)));
  return `${gain}*${env}*(sin(2*PI*(${frequency})*t)+0.34*sin(4*PI*(${frequency})*t)+` +
    `0.12*sin(6*PI*(${frequency})*t))`;
}
// Root note an octave down, soft attack so it never clicks under speech.
function bass(chords, gain, period) {
  const env = `(1-exp(-26*mod(t\\,${period})))*exp(-${fixed(1.5 / period)}*mod(t\\,${period}))`;
  const roots = chords.map((chord) => fixed(chord[0] / 2));
  return `${gain}*${env}*(sin(2*PI*(${perChord(roots)})*t)+0.25*sin(4*PI*(${perChord(roots)})*t))`;
}
// Noise transients used as hats; `random(1)` gives FFmpeg's own PRNG.
function hats(gain, step, accent) {
  return `${gain}*(random(1)*2-1)*exp(-${fixed(90 / (step * 8))}*mod(t\\,${step}))*` +
    `(0.55+0.45*cos(2*PI*mod(t\\,${step * accent})/${step * accent}))`;
}
// A filtered low thump on the down-beat, not a drum-machine kick.
function thump(gain, period) {
  return `${gain}*sin(2*PI*(58-22*exp(-26*mod(t\\,${period})))*t)*exp(-9*mod(t\\,${period}))`;
}

// --- Beds -------------------------------------------------------------------
const C = (...notes) => notes.map(freq);
const tracks = [
  // Podcast / interview / news: low minor pad, slow felt pluck, no percussion.
  { id: 'subtle-documentary-01', title: 'Subtle Documentary Bed', moods: ['SUBTLE_DOCUMENTARY', 'DOCUMENTARY_TENSION'],
    energy: 'LOW', texture: 'PAD',
    chords: [C('A2', 'C3', 'E3', 'G3'), C('F2', 'A2', 'C3', 'E3'), C('C3', 'E3', 'G3', 'B3'), C('G2', 'B2', 'D3', 'F3')],
    pad: .055, pluck: { gain: .028, step: .75, pattern: [0, 2, 1, 3] }, bass: { gain: .05, period: 4 },
    air: .006, lowpass: 4200 },
  { id: 'subtle-documentary-02', title: 'Subtle Documentary Air', moods: ['SUBTLE_DOCUMENTARY', 'ATMOSPHERIC'],
    energy: 'LOW', texture: 'PAD',
    chords: [C('D3', 'F3', 'A3', 'C4'), C('A2', 'C3', 'E3', 'G3'), C('B2', 'D3', 'F3', 'A3'), C('G2', 'B2', 'D3', 'F3')],
    pad: .052, pluck: { gain: .022, step: 1, pattern: [0, 3, 2, 1] }, bass: { gain: .045, period: 8 },
    air: .008, lowpass: 3800 },
  // Political / debate / serious analysis: restrained tension, no melody at all.
  { id: 'documentary-tension-01', title: 'Documentary Tension Drone', moods: ['DOCUMENTARY_TENSION', 'ATMOSPHERIC'],
    energy: 'LOW', texture: 'DRONE',
    chords: [C('D2', 'A2', 'D3', 'F3'), C('D2', 'A2', 'C3', 'F3'), C('C2', 'G2', 'C3', 'E3'), C('A1', 'E2', 'A2', 'C3')],
    pad: .062, bass: { gain: .055, period: 8 }, air: .01, lowpass: 3200 },
  { id: 'documentary-tension-02', title: 'Documentary Tension Pulse', moods: ['DOCUMENTARY_TENSION'],
    energy: 'MEDIUM', texture: 'DRONE',
    chords: [C('E2', 'B2', 'E3', 'G3'), C('C2', 'G2', 'C3', 'E3'), C('D2', 'A2', 'D3', 'F3'), C('B1', 'F#2', 'B2', 'D3')],
    pad: .05, bass: { gain: .05, period: 2 }, thump: { gain: .05, period: 2 }, air: .008, lowpass: 3400 },
  // Educational: clean and neutral, nothing to listen to.
  { id: 'clean-neutral-01', title: 'Clean Neutral Pad', moods: ['CLEAN_NEUTRAL'],
    energy: 'LOW', texture: 'PAD',
    chords: [C('C3', 'E3', 'G3', 'B3'), C('A2', 'C3', 'E3', 'G3'), C('F2', 'A2', 'C3', 'E3'), C('G2', 'B2', 'D3', 'F3')],
    pad: .055, pluck: { gain: .024, step: 1, pattern: [0, 2, 1, 3] }, bass: { gain: .045, period: 4 },
    air: .005, lowpass: 4200 },
  { id: 'clean-neutral-02', title: 'Clean Neutral Drift', moods: ['CLEAN_NEUTRAL'],
    energy: 'LOW', texture: 'PAD',
    chords: [C('D3', 'F#3', 'A3', 'C#4'), C('B2', 'D3', 'F#3', 'A3'), C('G2', 'B2', 'D3', 'F#3'), C('A2', 'C#3', 'E3', 'G3')],
    pad: .052, pluck: { gain: .022, step: .75, pattern: [0, 1, 2, 1] }, bass: { gain: .042, period: 4 },
    air: .005, lowpass: 4000 },
  // Technology: modern minimal, a clean repeating figure with light motion.
  { id: 'modern-minimal-01', title: 'Modern Minimal Pulse', moods: ['MODERN_MINIMAL'],
    energy: 'MEDIUM', texture: 'PULSE',
    chords: [C('A2', 'E3', 'A3', 'C4'), C('F2', 'C3', 'F3', 'A3'), C('G2', 'D3', 'G3', 'B3'), C('E2', 'B2', 'E3', 'G3')],
    pad: .04, pluck: { gain: .034, step: .375, pattern: [0, 2, 1, 3, 2, 1] }, bass: { gain: .05, period: 1.5 },
    hats: { gain: .016, step: .375, accent: 4 }, air: .004, lowpass: 5200 },
  { id: 'modern-minimal-02', title: 'Modern Minimal Grid', moods: ['MODERN_MINIMAL', 'CLEAN_NEUTRAL'],
    energy: 'MEDIUM', texture: 'PULSE',
    chords: [C('D3', 'A3', 'D4', 'F4'), C('C3', 'G3', 'C4', 'E4'), C('A2', 'E3', 'A3', 'C4'), C('G2', 'D3', 'G3', 'B3')],
    pad: .036, pluck: { gain: .03, step: .5, pattern: [0, 1, 2, 3] }, bass: { gain: .046, period: 2 },
    hats: { gain: .014, step: .25, accent: 8 }, thump: { gain: .04, period: 2 }, air: .004, lowpass: 5000 },
  // Motivational: light energy, never a workout track.
  { id: 'energetic-light-01', title: 'Energetic Light Pulse', moods: ['ENERGETIC_LIGHT'],
    energy: 'HIGH', texture: 'PULSE',
    chords: [C('F3', 'A3', 'C4', 'F4'), C('C3', 'E3', 'G3', 'C4'), C('D3', 'F3', 'A3', 'D4'), C('A#2', 'D3', 'F3', 'A#3')],
    pad: .034, pluck: { gain: .036, step: .3, pattern: [0, 2, 3, 1, 2, 0] }, bass: { gain: .05, period: 1.2 },
    hats: { gain: .018, step: .3, accent: 4 }, thump: { gain: .045, period: 1.2 }, air: .004, lowpass: 5600 },
  { id: 'energetic-light-02', title: 'Energetic Light Steps', moods: ['ENERGETIC_LIGHT', 'MODERN_MINIMAL'],
    energy: 'HIGH', texture: 'PULSE',
    chords: [C('G3', 'B3', 'D4', 'G4'), C('E3', 'G3', 'B3', 'E4'), C('C3', 'E3', 'G3', 'C4'), C('D3', 'F#3', 'A3', 'D4')],
    pad: .032, pluck: { gain: .034, step: .333, pattern: [0, 1, 3, 2] }, bass: { gain: .048, period: 1.333 },
    hats: { gain: .016, step: .1665, accent: 8 }, thump: { gain: .042, period: 1.333 }, air: .004, lowpass: 5400 },
  // Emotional: subtle warm ambient, slow and unhurried.
  { id: 'calm-warm-01', title: 'Calm Warm Pad', moods: ['CALM_WARM'],
    energy: 'LOW', texture: 'PAD',
    chords: [C('F3', 'A3', 'C4', 'E4'), C('C3', 'E3', 'G3', 'B3'), C('D3', 'F3', 'A3', 'C4'), C('A#2', 'D3', 'F3', 'A3')],
    pad: .058, pluck: { gain: .02, step: 1.5, pattern: [2, 0, 3, 1] }, bass: { gain: .042, period: 8 },
    air: .006, lowpass: 3800 },
  { id: 'calm-warm-02', title: 'Calm Warm Glow', moods: ['CALM_WARM', 'ATMOSPHERIC'],
    energy: 'LOW', texture: 'PAD',
    chords: [C('E3', 'G#3', 'B3', 'D#4'), C('C#3', 'E3', 'G#3', 'B3'), C('A2', 'C#3', 'E3', 'G#3'), C('B2', 'D#3', 'F#3', 'A3')],
    pad: .056, pluck: { gain: .018, step: 2, pattern: [0, 2, 1, 3] }, bass: { gain: .04, period: 8 },
    air: .007, lowpass: 3600 },
  // Reflective / open: texture only, for clips that need presence but no motion.
  { id: 'atmospheric-01', title: 'Atmospheric Swell', moods: ['ATMOSPHERIC', 'DOCUMENTARY_TENSION'],
    energy: 'LOW', texture: 'DRONE',
    chords: [C('C3', 'G3', 'C4', 'D4'), C('A2', 'E3', 'A3', 'B3'), C('F2', 'C3', 'F3', 'G3'), C('G2', 'D3', 'G3', 'A3')],
    pad: .055, bass: { gain: .04, period: 8 }, air: .012, lowpass: 3000 }
];

function voices(track) {
  const parts = [pad(track.chords, fixed(track.pad))];
  if (track.pluck) parts.push(pluck(track.chords, fixed(track.pluck.gain), track.pluck.step, track.pluck.pattern));
  if (track.bass) parts.push(bass(track.chords, fixed(track.bass.gain), track.bass.period));
  return parts.join('+');
}

function render(track, path) {
  const tonal = voices(track);
  // The right channel is the same material a few milliseconds later, which is
  // enough to open the stereo image without phasing under a mono playback.
  const tonalRight = tonal.replace(/\*t\b/gu, '*(t+0.011)');
  const inputs = ['-f', 'lavfi', '-i', `aevalsrc=${tonal}|${tonalRight}:s=44100:d=${DURATION}`,
    '-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=${track.air}:d=${DURATION}:r=44100`];
  const chain = [`[0:a]lowpass=f=${track.lowpass},highpass=f=42,aformat=channel_layouts=stereo[tonal]`,
    '[1:a]lowpass=f=1100,aformat=channel_layouts=stereo[air]'];
  const mix = ['[tonal]', '[air]'];
  if (track.hats || track.thump) {
    const rhythm = [track.hats ? hats(fixed(track.hats.gain), track.hats.step, track.hats.accent) : null,
      track.thump ? thump(fixed(track.thump.gain), track.thump.period) : null].filter(Boolean).join('+');
    inputs.push('-f', 'lavfi', '-i', `aevalsrc=${rhythm}|${rhythm}:s=44100:d=${DURATION}`);
    // Hats live above 4 kHz, the thump below 120 Hz: both stay out of the band
    // speech occupies, so the bed never fights the voice.
    chain.push(`[2:a]highpass=f=${track.hats && !track.thump ? 4200 : 48},aformat=channel_layouts=stereo[rhythm]`);
    mix.push('[rhythm]');
  }
  chain.push(`${mix.join('')}amix=inputs=${mix.length}:normalize=0,` +
    // De-harshen, keep the level steady, then land on a predictable loudness.
    'equalizer=f=2600:width_type=o:width=1.6:g=-2.5,' +
    'acompressor=threshold=0.15:ratio=2:attack=25:release=350,' +
    `afade=t=in:d=2.5,afade=t=out:st=${DURATION - 3.5}:d=3.5,` +
    'loudnorm=I=-20:TP=-3:LRA=9[a]');
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs,
    '-filter_complex', chain.join(';'), '-map', '[a]', '-ar', '44100',
    '-c:a', 'aac', '-b:a', '160k', path]);
}

function main() {
  mkdirSync(output, { recursive: true });
  const manifest = { generatedBy: 'scripts/generate-music-library.cjs', tracks: [] };
  for (const track of tracks) {
    const file = `${track.id}.${LIBRARY_VERSION}.m4a`;
    const path = join(output, file);
    if (!existsSync(path) || process.env.FORCE_MUSIC_REGEN === 'true') render(track, path);
    manifest.tracks.push({ id: track.id, file, title: track.title, moods: track.moods,
      license: 'GENERATED_IN_HOUSE', loudnessLufs: -20, durationSec: DURATION,
      energy: track.energy, texture: track.texture });
  }
  writeFileSync(join(output, 'library.json'), JSON.stringify(manifest, null, 2));
  console.log(`Music library ready: ${manifest.tracks.length} tracks in ${output}`);
}
main();
