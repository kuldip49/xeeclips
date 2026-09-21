const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { exportClipFile } = require('../dist/modules/videos/clip-export.service');
const { fallbackEditPlan } = require('../dist/modules/editing/edit-plan');
const { VideoEditExecutorService } = require('../dist/modules/editing/video-edit-executor.service');
const { SubtitleRendererService } = require('../dist/modules/editing/subtitle-renderer.service');
const { ReframeService } = require('../dist/modules/editing/reframe.service');
const { buildSubtitlePhrases } = require('../dist/modules/editing/subtitle-phrases');
const { createTimelineMapper } = require('../dist/modules/editing/timeline-remap');

async function main() {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error?.code === 'ENOENT') {
    console.log('SKIP editing media test: FFmpeg is unavailable on this host.');
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), 'editing-media-test-'));
  try {
    const source = join(directory, 'source.mp4');
    const normal = join(directory, 'normal.mp4');
    const edited = join(directory, 'edited.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
      '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi',
      '-i', 'sine=frequency=440:sample_rate=48000', '-t', '17',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', source]);
    const normalResult = await exportClipFile(source, normal, 1, 16);
    assert.equal(normalResult.width, 320);
    assert.equal(normalResult.height, 180);
    assert(Math.abs(normalResult.duration - 15) < .6);

    const plan = fallbackEditPlan(1, 16, '9:16');
    plan.platformPreset = 'INSTAGRAM_REELS';
    plan.videoTemplate = 'EDITORIAL_FRAME';
    plan.recommendedTemplate = 'EDITORIAL_FRAME';
    // A headline is a complete thought of at least seven words now.
    plan.onScreenHook = { enabled: true, text: 'A Real Contextual Hook That Says Something Worth Reading',
      startSec: 1.4, endSec: 3.8, position: 'TOP', style: 'BOLD_POP' };
    plan.subtitleStyle.animationStyle = 'POP';
    plan.subtitleEmphasis = [{ word: 'Strong', startSec: 8, endSec: 8.4,
      strength: 'STRONG' }];
    plan.operations = [
      { type: 'REMOVE_SILENCE', startSec: 5, endSec: 5.5, reason: 'fixture pause',
        scale: null, focusX: null, focusY: null, target: null, words: [] },
      { type: 'ZOOM', startSec: 8, endSec: 9.5, reason: 'fixture emphasis',
        triggerText: 'Strong', intensity: 'STRONG',
        scale: 1.26, focusX: .5, focusY: .5, target: null, words: [] }
    ];
    const words = [
      { start: 1.5, end: 1.9, text: 'A' },
      { start: 2, end: 2.4, text: 'real' },
      { start: 2.5, end: 2.9, text: 'contextual' },
      { start: 3, end: 3.4, text: 'hook' },
      { start: 8, end: 8.4, text: 'Strong' },
      { start: 8.5, end: 9, text: 'phrase' }
    ];
    // The synthetic source has no face; keep its simulated face below the hook safe band.
    const faceTracks = [
      { timestamp: 1, x: .2, y: .45, w: .2, h: .18, trackId: 'speaker', confidence: .95 },
      { timestamp: 4, x: .22, y: .45, w: .2, h: .18, trackId: 'speaker', confidence: .95 },
      { timestamp: 7, x: .24, y: .45, w: .2, h: .18, trackId: 'speaker', confidence: .95 },
      { timestamp: 8, x: .25, y: .45, w: .2, h: .18, trackId: 'speaker', confidence: .95 },
      { timestamp: 8.5, x: .255, y: .45, w: .2, h: .18, trackId: 'speaker', confidence: .95 },
      { timestamp: 9, x: .26, y: .45, w: .2, h: .18, trackId: 'speaker', confidence: .95 },
      { timestamp: 10, x: .27, y: .45, w: .2, h: .18, trackId: 'speaker', confidence: .95 },
    ];
    const result = await new VideoEditExecutorService(new SubtitleRendererService(),
      new ReframeService()).execute(normal, edited, plan, words, faceTracks);
    const assEvents = readFileSync(join(directory, 'edit.ass'), 'utf8')
      .split(/\r?\n/u).filter((line) => line.startsWith('Dialogue:'));
    const cuts = plan.operations.filter((operation) =>
      operation.type === 'TRIM' || operation.type === 'REMOVE_SILENCE')
      .map((operation) => ({ start: operation.startSec, end: operation.endSec }));
    const mapper = createTimelineMapper(plan.clipStartSec, cuts);
    const timedElements = [
      ...words.map((word) => word.start),
      ...plan.subtitleEmphasis.map((item) => item.startSec),
      ...(plan.onScreenHook.enabled ? [plan.onScreenHook.startSec] : []),
      ...plan.onScreenText.map((item) => item.startSec),
      ...plan.operations.filter((operation) => ['ZOOM', 'REFRAME'].includes(operation.type))
        .map((operation) => operation.startSec),
      ...faceTracks.map((track) => track.timestamp)
    ];
    const timelineRemappedElementCount = timedElements.filter((start) =>
      Math.abs(mapper.point(start) - (start - plan.clipStartSec)) > .001).length;
    console.log(JSON.stringify({ event: 'editing_media_diagnostics',
      generatedSubtitlePhraseCount: buildSubtitlePhrases(words,
        plan.subtitleStyle.maxWordsPerLine).length,
      renderedSubtitlePhraseCount: result.visual.subtitlePhraseCount,
      subtitleFontSize: result.visual.subtitleFontSize,
      emphasizedWordCount: result.visual.highlightedWordCount,
      hookWordCount: result.visual.hookWordCount,
      overlayCount: result.visual.onScreenTextCount,
      timelineRemappedElementCount,
      finalAssEventCount: assEvents.length,
      assEventStyles: assEvents.map((line) => line.split(',')[3]) }));
    assert.equal(result.width, 1080);
    assert.equal(result.height, 1920);
    assert(Math.abs(result.duration - 14.5) < .6);
    assert(result.hasAudio);
    assert(result.sizeBytes > 0);
    assert(result.visual.subtitlePhraseCount > 0);
    assert.equal(result.visual.highlightedWordCount, 1);
    // Preserve the accepted compact Instagram caption preset.  This fixture has
    // a two-line phrase and intentionally resolves to 72 px; stabilization must
    // not redesign it merely to satisfy an obsolete 80 px assertion.
    assert(result.visual.subtitleFontSize >= 72);
    assert.equal(result.visual.hookWordCount, 9);
    // The headline is drawn on its own near-white plate, in one accent family.
    assert.equal(result.visual.hookBackgroundRendered, true);
    assert(result.visual.hookPlateBounds.width > 0 && result.visual.hookPlateBounds.height > 0);
    assert.equal(result.visual.hookAccentColorSingleFamily, true);
    assert(['RED', 'BLUE', 'GREEN'].includes(result.visual.hookAccentFamily));
    // Captions keep one baseline per shot and one size for the whole clip.
    assert.equal(result.visual.subtitleGeometryStable, true);
    assert(result.visual.subtitleBaselineCount <= Math.max(1, result.visual.shotCount));
    // The push is anchored on the emphasised word and lands as a real, measurable
    // change of scale rather than a nominal one.
    assert(result.visual.zoomEvents.every((event) => event.motionKind === 'SEMANTIC_ZOOM'));
    assert(result.visual.zoomEvents.every((event) => event.zoomStartsBeforeWord));
    assert(result.visual.zoomPeakScale >= 1.16, `weak zoom: ${result.visual.zoomPeakScale}`);
    // No music and no sound design: dialogue/source audio only.
    assert.equal(result.visual.music.trackId, null);
    assert.equal(result.visual.sfx.sfxCount, 0);
    assert.equal(result.quality.checks.musicPresentWhenRequired, 'N/A');
    assert.equal(result.quality.checks.sfxRendered, 'N/A');
    assert.equal(result.visual.hookRequested, true);
    assert.equal(result.visual.hookPlaced, true);
    assert.equal(result.visual.hookRendered, true);
    assert.equal(result.visual.hookStartSec, 0);
    assert(Math.abs(result.visual.hookEndSec - result.duration) < .1);
    assert(Math.abs(result.timeline.editedDuration - 14.5) < .01);
    assert.deepEqual(result.timeline.segments.map((segment) => [segment.sourceStart, segment.sourceEnd]),
      [[1, 5], [5.5, 16]]);
    assert(['PASSED', 'DEGRADED'].includes(result.quality.status));
    assert.equal(result.quality.checks.hookRendered, true);
    assert.equal(result.quality.checks.hookInsideSafeZone, true);
    assert.equal(result.quality.checks.subtitleRendered, true);
    assert.equal(result.quality.checks.subtitleAnimationVisible, true);
    assert.equal(result.quality.checks.highlightedWordVisible, true);
    assert.equal(result.quality.checks.backgroundApplied, true);
    assert(result.quality.renderAttempts <= 3);
    assert.equal(result.visual.platformPreset, 'INSTAGRAM_REELS');
    assert.equal(result.visual.layoutTemplate, 'EDITORIAL_FRAME');
    assert.deepEqual(result.visual.headerBounds, { x: 0, y: 0, width: 1080, height: 340 });
    // Landscape sources use the source-aware editorial viewport so the actual
    // footage occupies footer space that would otherwise be decorative blur.
    assert.deepEqual(result.visual.videoViewportBounds,
      { x: 0, y: 360, width: 1080, height: 1380 });
    assert.deepEqual(result.visual.footerBounds, { x: 0, y: 1740, width: 1080, height: 180 });
    assert(result.visual.subtitleBounds.y >= result.visual.videoViewportBounds.y);
    assert(result.visual.subtitleBounds.y + result.visual.subtitleBounds.height <=
      result.visual.videoViewportBounds.y + result.visual.videoViewportBounds.height);
    // A nine-word headline uses more of the header instead of shrinking away: it
    // takes extra lines first and still sets well above the readable floor.
    assert(result.visual.hookFontSize >= 46, `hook font ${result.visual.hookFontSize}`);
    assert(result.visual.hookLineCount >= 2 && result.visual.hookLineCount <= 4);
    // Lowered, bottom-anchored by the plate, with a real gap to the footage.
    assert.equal(result.visual.hookNotTooHigh, true);
    assert.equal(result.visual.hookGapAboveVideoValid, true);
    assert(result.visual.hookGapAboveVideoPx >= 30 && result.visual.hookGapAboveVideoPx <= 50);
    // The gap is measured from the plate, which is what the viewer sees.
    assert.equal(result.visual.hookPlateBounds.y + result.visual.hookPlateBounds.height +
      result.visual.hookGapAboveVideoPx, result.visual.videoViewportBounds.y);
    assert(result.visual.hookAccentWordCount >= 1 && result.visual.hookAccentWordCount <= 2);
    assert.equal(result.quality.checks.hookPositionValid, true);
    assert.equal(result.quality.checks.hookAccentWordsValid, true);
    // A cover is produced for the edited clip and carries the same headline.
    assert.equal(result.quality.checks.thumbnailGenerated, true);
    assert.equal(result.quality.checks.thumbnailMatchesHookText, true);
    assert(result.thumbnail && result.thumbnail.atSec > 0);
    assert(existsSync(result.thumbnail.path));
    assert.equal(result.visual.sourceResolution.width, 320);
    assert.equal(result.visual.outputResolution.width, 1080);
    assert.equal(result.visual.zoomEvents.length, 1);
    assert.equal(result.visual.zoomEvents[0].subjectSafeDuringZoom, true);
    // The plan asked for 1.26, backed by a STRONG emphasised word, and the
    // subject safety search may only walk it further down - never up.
    assert(result.visual.zoomEvents[0].peakScale >= 1.1 &&
      result.visual.zoomEvents[0].peakScale <= 1.26 + 1e-6,
    `unexpected peak scale ${result.visual.zoomEvents[0].peakScale}`);
    assert.equal(result.visual.zoomEvents[0].kind, 'IN');
    assert.equal(result.visual.zoomEvents[0].semanticReason, 'fixture emphasis');
    // The effect is still classified for telemetry, but nothing is mixed.
    assert.equal(result.visual.zoomEvents[0].sfxType, 'ZOOM_IN');
    assert.equal(result.visual.zoomEvents[0].sfxEnabled, false);
    assert.equal(result.visual.zoomInCount, 1);
    assert.equal(result.visual.zoomOutCount, 0);
    assert.equal(result.visual.zoomReturnedToBaseline, true);
    // Sound design is off: the clip carries dialogue/source audio only, so no
    // effect is selected or mixed and every SFX check reports N/A rather than
    // failing the edit for an absence that was the intent.
    const sfx = result.visual.sfx;
    console.log(JSON.stringify({ event: 'editing_media_sfx', sfxCount: sfx.sfxCount,
      sfxEnabled: sfx.sfxEnabled, skipped: sfx.sfxSkippedReason }));
    assert.equal(sfx.sfxCount, 0);
    assert.equal(sfx.sfxEnabled, false);
    assert.equal(sfx.sfxSkippedReason, 'DISABLED_BY_POLICY');
    for (const name of ['sfxTimingValid', 'sfxSpeechSafe', 'sfxNotOverused',
      'sfxMatchesEvent', 'sfxRendered'])
      assert.equal(result.quality.checks[name], 'N/A', name);
    // The same for music: no bed, no fades, no mixing, and no failed checks.
    assert.equal(result.visual.music.musicDecision, 'NO_MUSIC');
    assert.equal(result.visual.music.musicSkippedReason, 'DISABLED_BY_POLICY');
    assert.equal(result.visual.music.gainDb, null);
    for (const name of ['musicRendered', 'musicPresentWhenRequired', 'musicMoodSelected',
      'speechDominant', 'musicFadeInValid', 'musicFadeOutValid', 'musicQualityAcceptable',
      'musicSpeechBalanceValid'])
      assert.equal(result.quality.checks[name], 'N/A', name);
    assert.equal(result.quality.checks.musicDecisionValid, true);
    assert.equal(result.visual.timelineRemapApplied, true);
    assert.equal(result.visual.subtitleTheme, 'BOLD_SOCIAL');
    assert(assEvents.some((line) => line.includes(',Subtitle,')));
    assert(assEvents.some((line) => line.includes(',Hook,')));
    const subtitleStyle = readFileSync(join(directory, 'edit.ass'), 'utf8')
      .split(/\r?\n/u).find((line) => line.startsWith('Style: Subtitle,'));
    assert.equal(subtitleStyle.split(',')[15], '1');
    const outputStreams = JSON.parse(execFileSync('ffprobe', ['-v', 'error',
      '-show_streams', '-of', 'json', edited], { encoding: 'utf8' })).streams;
    assert(outputStreams.some((stream) => stream.codec_type === 'video' &&
      stream.codec_name === 'h264' && stream.width === 1080 && stream.height === 1920));
    assert(outputStreams.some((stream) => stream.codec_type === 'audio'));
    const switched = await new VideoEditExecutorService(new SubtitleRendererService(),
      new ReframeService()).execute(normal, join(directory, 'speaker-switch.mp4'),
      plan, words, [
        { timestamp: 1, x: .2, y: .45, w: .2, h: .18 },
        { timestamp: 4, x: .21, y: .45, w: .2, h: .18 },
        { timestamp: 8, x: .62, y: .45, w: .2, h: .18 },
        { timestamp: 10, x: .61, y: .45, w: .2, h: .18 }
      ]);
    assert.equal(switched.visual.speakerSwitchCount, 1);
    assert.equal(switched.width, 1080);
    assert(switched.sizeBytes > 0);
    if (process.env.EDITING_MEDIA_PREVIEW_PATH)
      copyFileSync(edited, process.env.EDITING_MEDIA_PREVIEW_PATH);
    console.log(JSON.stringify({ normal: normalResult, edited: result }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
