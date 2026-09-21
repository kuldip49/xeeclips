// Headline treatment across the whole allowed length band, rendered with the
// real libass stack (no database, no LLM; FFmpeg only).
//
// Covers §15-§25 and §35 of the visual polish pass: a headline is a complete
// thought of at least seven words, it grows UPWARD from a fixed bottom edge one
// deliberate gap above the footage, it sits on a near-white rounded plate in
// dark charcoal, and every accent word in it shares ONE colour family.
//
//   npm run build && node scripts/test-hook-plate-lengths.cjs
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const dist = (name) => require(`../dist/modules/editing/${name}`);
const { fallbackEditPlan } = dist('edit-plan');
const { SubtitleRendererService, HOOK_PLATE } = dist('subtitle-renderer.service');
const { PLATFORM_LAYOUT_PRESETS, HOOK_PLACEMENT } = dist('platform-layout');
const { HOOK_ACCENT_FAMILY_COLORS, HOOK_TEXT_COLOR } = dist('hook-accent');
const { HOOK_LENGTH } = dist('hook-generator');
const { HOOK_TYPE, hookMinFont } = dist('text-layout');

// One headline per band the pass calls out: the seven-word floor, the preferred
// 8-16 band, a long line past ten words, and a very long one past sixteen.
const HEADLINES = [
  'Why Was This Local Market Suddenly Banned?',
  'The Council Banned the Market Every Trader Here Relied On',
  'Nobody Expected This One Council Decision to Change the Whole Local Market',
  'Nobody Expected This One Council Decision to Change Everything About How the Local ' +
    'Market Was Actually Run Every Single Day'
];

const word = (start, end, text) => ({ start, end, text });
const WORDS = [word(.5, .9, 'The'), word(1, 1.4, 'council'), word(1.5, 2.1, 'banned'),
  word(2.2, 2.6, 'the'), word(2.7, 3.2, 'market')];

async function main() {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error?.code === 'ENOENT') {
    console.log('SKIP hook plate test: FFmpeg is unavailable on this host.');
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), 'hook-plate-'));
  try {
    const layout = PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS;
    const bottoms = new Set();
    for (const text of HEADLINES) {
      const words = text.split(/\s+/u).filter(Boolean).length;
      const plan = { ...fallbackEditPlan(0, 6, '9:16'), platformPreset: 'INSTAGRAM_REELS',
        videoTemplate: 'EDITORIAL_FRAME',
        onScreenHook: { enabled: true, startSec: 0, endSec: 6, text,
          position: 'TOP', style: 'TOP_HEADLINE' } };
      const path = join(directory, 'hook.ass');
      const stats = await new SubtitleRendererService().write(path, plan, WORDS, [],
        1080, 1920, undefined, [], [], true, layout, { fps: 30 });
      const ass = readFileSync(path, 'utf8');
      const label = `${words}w`;

      // The headline is rendered, complete, and never silently cut down.
      assert.equal(stats.hookPlaced, true, `${label}: not placed`);
      assert.equal(stats.hookSuppressionReason, '', label);
      assert(stats.hookWordCount >= HOOK_LENGTH.min, `${label}: ${stats.hookWordCount} words`);
      assert.equal(stats.hookShortenLevel, 0, `${label}: wording was cut`);
      assert.equal(stats.hookText, text, label);
      // A long line uses more of the header - up to four lines - rather than
      // shrinking below the readable floor.
      assert(stats.hookLineCount >= 1 && stats.hookLineCount <= HOOK_TYPE.maxLines,
        `${label}: ${stats.hookLineCount} lines`);
      assert(stats.hookFontSize >= hookMinFont(words),
        `${label}: font ${stats.hookFontSize}`);

      // The plate: a rounded rectangle drawn under the text, sized to it.
      assert.equal(stats.hookBackgroundRendered, true, label);
      const plate = stats.hookPlateBounds;
      assert(plate && plate.width > 0 && plate.height > 0, label);
      assert.equal(plate.height, Math.round(stats.hookBounds.height), label);
      const plateLine = ass.split(/\r?\n/u).find((line) => line.includes(',HookPlate,'));
      assert(plateLine && plateLine.includes('\\p1') && plateLine.includes(' b '),
        `${label}: plate is not a rounded drawing`);
      assert(ass.includes(HOOK_PLATE.fill), `${label}: plate fill missing`);

      // Dark text on it, never white on white.
      const hookStyle = ass.split(/\r?\n/u).find((line) => line.startsWith('Style: Hook,'));
      assert(hookStyle.includes(HOOK_TEXT_COLOR), `${label}: headline is not dark`);

      // The plate's BOTTOM edge is the anchor: it is the same for every length,
      // sits the target gap above the footage, and the block grows upward.
      bottoms.add(plate.y + plate.height);
      assert.equal(stats.hookGapAboveVideoValid, true, label);
      assert(stats.hookGapAboveVideoPx >= HOOK_PLACEMENT.minGapAboveVideo &&
        stats.hookGapAboveVideoPx <= HOOK_PLACEMENT.maxGapAboveVideo,
      `${label}: gap ${stats.hookGapAboveVideoPx}`);
      assert(plate.y >= layout.hookZone.y, `${label}: plate climbs past the safe top`);
      assert.equal(stats.hookNotTooHigh, true, label);
      assert.equal(stats.platformLayoutSafe, true,
        `${label}: ${stats.platformSafeZoneViolations.join(',')}`);

      // One accent family, within the budget for this length, never every word.
      assert.equal(stats.hookAccentColorSingleFamily, true, label);
      assert(stats.hookAccentWordCount >= 1, `${label}: no accent`);
      assert(stats.hookAccentWordCount < stats.hookWordCount, `${label}: whole line coloured`);
      const family = stats.hookAccentFamily;
      assert(family in HOOK_ACCENT_FAMILY_COLORS, `${label}: ${family}`);
      const hookLine = ass.split(/\r?\n/u).find((line) => line.includes(',Hook,'));
      assert(hookLine.includes(HOOK_ACCENT_FAMILY_COLORS[family]), label);
      for (const [other, color] of Object.entries(HOOK_ACCENT_FAMILY_COLORS))
        if (other !== family) assert(!hookLine.includes(color),
          `${label}: ${family} mixed with ${other}`);

      console.log(JSON.stringify({ event: 'hook_plate', words, lines: stats.hookLineCount,
        fontSize: stats.hookFontSize, plate, gapPx: stats.hookGapAboveVideoPx,
        accentFamily: family, accents: stats.hookAccentWords }));
    }
    // Every length presents the same bottom edge to the video (§19).
    assert.equal(bottoms.size, 1, `plate bottoms drifted: ${[...bottoms].join(',')}`);
    console.log('Hook plate tests passed: length band, plate, placement and accent family.');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
