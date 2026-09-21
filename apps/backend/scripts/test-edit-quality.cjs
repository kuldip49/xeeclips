// Unit tests for the AI editing quality subsystems (no database, no FFmpeg).
//   npm run build && node scripts/test-edit-quality.cjs
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const dist = (name) => require(`../dist/modules/editing/${name}`);
const { buildEditedTimeline, sourceToFinal, finalToSource, normalizeCuts } = dist('edit-timeline');
const { optimizeEditBoundaries, isWeakOpeningWord } = dist('edit-boundaries');
const { fitHookText, shortenHook, estimateTextWidth, layoutSubtitleLines, HOOK_TYPE } = dist('text-layout');
const { classifyFrames, classifyShots, fitEnableExpression } = dist('shot-classifier');
const { planZoomEvents, zoomScaleAt, zoomWindow, ZOOM_TUNING, ZOOM_VISIBLE_DELTA,
  detectSemanticZoomCandidates, requiredSemanticZoomCount } = dist('zoom-planner');
const { measureSubjectSafety } = dist('subject-safety');
const { measureOnsets, estimateZoom, contrastRatio, assToRgb, boundedQaFrameNumbers,
  normalQaFrameNumbers, MAX_NORMAL_QA_FRAMES, MAX_QA_DECODE_BATCH_FRAMES } = dist('render-qa');
const { selectMusicTrack, loadMusicLibrary, musicGainDb, fallbackMusicMood, musicPolicy,
  INLINE_FALLBACK_TRACK } = dist('music-library');
const { gradingFilter, predictGradeStrength, resolveGradePreset } = dist('color-grade');
const { check, evaluateGate, fullRenderRepairActions, gradingRepairDecision,
  repairInvalidation } = dist('edit-quality-gate');
const { fallbackEditPlan, EDIT_PLAN_SCHEMA } = dist('edit-plan');
const { applyDeterministicEditorial } = dist('deterministic-editorial');
const { EditingPlanValidator, hookMetaLanguageFree } = dist('editing-plan-validator');
const { analysisFromStoredChunks } = dist('edit-analysis');
const { SubtitleRendererService, placeAroundSourceText, collisionAreaRatio } = dist('subtitle-renderer.service');
const { ReframeService } = dist('reframe.service');
const { classifyPreRenderFailures, envelopeLag, validatePreRenderCamera,
  validatePreRenderStructure, subtitleRetimeDecision } = dist('video-edit-executor.service');
const { PLATFORM_LAYOUT_PRESETS, HOOK_PLACEMENT, sourceAwarePlatformLayout,
  usableContentAreaRatio } = dist('platform-layout');
const { ensureContrastWithWhite, backgroundColors, buildPaletteSegments } = dist('source-palette');
const { detectInformationRegions } = dist('information-region');
const { detectSponsorSegment } = dist('sponsor-segment');

const w = (start, end, text) => ({ start, end, text });
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------- timeline
test('edited timeline maps source to final through cuts', () => {
  const timeline = buildEditedTimeline({ candidateStart: 120, candidateEnd: 154,
    editedStart: 121.4, editedEnd: 151.8, cuts: [{ start: 130, end: 131 }, { start: 140, end: 140.5 }] });
  assert.equal(timeline.rawDuration, 34);
  assert(near(timeline.editedDuration, 30.4 - 1.5, 1e-3));
  assert.deepEqual(timeline.segments.map((s) => [s.sourceStart, s.sourceEnd]),
    [[121.4, 130], [131, 140], [140.5, 151.8]]);
  assert(near(sourceToFinal(timeline, 121.4), 0));
  assert(near(sourceToFinal(timeline, 131), 8.6, 1e-6));
  assert.equal(sourceToFinal(timeline, 130.5), null);
  assert(near(finalToSource(timeline, 8.6), 131 - 0 + 0, 1e-6) || near(finalToSource(timeline, 8.6), 130, 1e-6));
  assert(near(finalToSource(timeline, 10), 132.4, 1e-6));
  // Edited duration is independent from the raw candidate and may be longer.
  const longer = buildEditedTimeline({ candidateStart: 120, candidateEnd: 154, editedStart: 118.9, editedEnd: 153.7 });
  assert(near(longer.editedDuration, 34.8, 1e-6));
  assert.deepEqual(normalizeCuts([{ start: 5, end: 7 }, { start: 6, end: 8 }, { start: 1, end: 2 }], 1.5, 10),
    [{ start: 1.5, end: 2 }, { start: 5, end: 8 }]);
  assert.throws(() => buildEditedTimeline({ candidateStart: 0, candidateEnd: 1, editedStart: 0, editedEnd: 1,
    cuts: [{ start: 0, end: 1 }] }));
});

// ---------------------------------------------------------------- boundaries
const sentence = (start, texts, step = .4) => texts.map((text, i) => w(start + i * step, start + i * step + .32, text));
test('weak lead-in is removed without cutting words', () => {
  const filler = (start) => sentence(start, 'People keep asking what changed this year and why it matters.'.split(' '));
  const words = [...sentence(9, ['This', 'ended.']), ...sentence(10.2, ['So', 'um', 'the', 'real', 'problem', 'is', 'money.']),
    ...filler(13.4), ...filler(18.4), ...filler(23.4), ...sentence(28.4, ['Nobody', 'talks', 'about', 'it.'])];
  const decision = optimizeEditBoundaries({ words, candidateStart: 10.1, candidateEnd: 30, windowStart: 6, windowEnd: 34 });
  assert.deepEqual(decision.removedLeadIn, ['So', 'um']);
  assert.equal(decision.openingReason, 'WEAK_LEAD_IN_REMOVED');
  const first = words[decision.startWordIndex];
  assert.equal(first.text, 'the');
  assert(decision.editedStart <= first.start && decision.editedStart > words[decision.startWordIndex - 1].end);
  assert.equal(decision.clipStartStrong, true);
  assert.equal(decision.clipEndComplete, true);
  assert(decision.deadAirAtEndMs <= 300);
});
test('meaningful "So many" is not treated as a lead-in', () => {
  const words = sentence(10, ['So', 'many', 'people', 'agree', 'with', 'this', 'claim.'], .5);
  const decision = optimizeEditBoundaries({ words, candidateStart: 10, candidateEnd: 13.5, windowStart: 8, windowEnd: 16 });
  assert.deepEqual(decision.removedLeadIn, []);
});
test('incomplete ending extends to finish the thought', () => {
  const words = [...sentence(10, ['The', 'result', 'was', 'clear.']), ...sentence(12, ['And', 'then', 'they', 'left', 'the', 'room.'])];
  const decision = optimizeEditBoundaries({ words, candidateStart: 10, candidateEnd: 13.3, windowStart: 8, windowEnd: 17 });
  assert.equal(decision.endingReason, 'CONTEXT_EXTENDED_TO_COMPLETE_THOUGHT');
  assert.equal(words[decision.endWordIndex].text, 'room.');
  assert(decision.editedEnd > 13.3);
  assert(decision.contextExtendedEndMs > 0);
});
test('mid-thought start extends back to the sentence start', () => {
  const words = [...sentence(5, ['Earlier.']), ...sentence(6, ['What', 'matters', 'most', 'is', 'trust.']),
    ...sentence(8.5, ['Always.'])];
  const decision = optimizeEditBoundaries({ words, candidateStart: 6.7, candidateEnd: 9, windowStart: 3, windowEnd: 12 });
  assert.equal(decision.openingReason, 'CONTEXT_EXTENDED_TO_SENTENCE_START');
  assert.equal(words[decision.startWordIndex].text, 'What');
});
test('Luna opening hint is only accepted at a sentence start', () => {
  const words = [...sentence(10, ['Let', 'me', 'explain.']), ...sentence(11.5, ['Inflation', 'doubled', 'in', 'one', 'year.']),
    ...sentence(14, 'That is huge because wages did not follow and families now pay far more for the same basic things.'.split(' ')),
    ...sentence(22, 'Nobody in charge wants to admit that.'.split(' '))];
  const accepted = optimizeEditBoundaries({ words, candidateStart: 10, candidateEnd: 25, windowStart: 8, windowEnd: 28,
    hints: { hookStartSec: 11.5 } });
  assert.equal(accepted.lunaOpeningApplied, true);
  assert.equal(words[accepted.startWordIndex].text, 'Inflation');
  const rejected = optimizeEditBoundaries({ words, candidateStart: 10, candidateEnd: 25, windowStart: 8, windowEnd: 28,
    hints: { hookStartSec: 12.3 } });
  assert.equal(rejected.lunaOpeningApplied, false);
});
test('internal dead air is shortened within budget', () => {
  const words = [...sentence(10, ['First', 'point', 'here.']), ...sentence(13, ['Second', 'point', 'now.']),
    ...sentence(14.5, 'Third point is the one that matters most for everyone watching this today.'.split(' ')),
    ...sentence(20.5, 'And that is the whole story.'.split(' '))];
  const decision = optimizeEditBoundaries({ words, candidateStart: 10, candidateEnd: 23, windowStart: 8, windowEnd: 26 });
  assert.equal(decision.cuts.length, 2, 'both long pauses are shortened');
  const cut = decision.cuts[0];
  assert(cut.start >= 11.12 + .19 && cut.end <= 13 - .14);
  assert(decision.internalPauseRemovedMs > 1000);
  assert(words.every((word) => word.end <= cut.start || word.start >= cut.end));
  assert(isWeakOpeningWord('Um') && !isWeakOpeningWord('Inflation'));
});

// ------------------------------------------------- retention start/end (§38)
// A long neutral body so every clip below clears the minimum duration without
// the filler itself influencing the opening or ending choice.
// Deliberately neutral wording: the filler must not itself look like a strong
// opening or a payoff, or it would compete with the moment under test.
const body = (start, count = 4) => Array.from({ length: count }, (_, i) =>
  sentence(start + i * 5,
    'We were talking about several different local issues yesterday evening.'.split(' '))).flat();

test('an opening on an unresolved pronoun is expanded to the sentence that names the subject', () => {
  const words = [...sentence(10, 'The city council approved the new housing rule.'.split(' ')),
    ...sentence(14, 'They banned it in every district downtown.'.split(' ')), ...body(18)];
  const decision = optimizeEditBoundaries({ words, candidateStart: 14, candidateEnd: 36,
    windowStart: 8, windowEnd: 40 });
  assert.equal(words[decision.startWordIndex].text, 'The');
  assert.equal(decision.clipStartContextComplete, true);
  assert.equal(decision.openingRepairAttempted, true);
  assert.equal(decision.openingRepairSucceeded, true);
});

test('a housekeeping opening loses to the strongest nearby sentence', () => {
  const words = [...sentence(10, 'Let me explain.'.split(' ')),
    ...sentence(12, 'Inflation doubled in one single year.'.split(' ')), ...body(16)];
  const decision = optimizeEditBoundaries({ words, candidateStart: 10, candidateEnd: 34,
    windowStart: 8, windowEnd: 38 });
  assert.equal(decision.openingStrategy, 'COLD_OPEN_PAYOFF');
  assert.equal(words[decision.startWordIndex].text, 'Inflation');
  assert(decision.startAdjustmentSec > 0);
});

test('a strong selected opening is never shuffled for scoring noise', () => {
  const words = [...sentence(10, 'Inflation doubled in one single year.'.split(' ')), ...body(14)];
  const decision = optimizeEditBoundaries({ words, candidateStart: 10, candidateEnd: 32,
    windowStart: 8, windowEnd: 36 });
  assert.equal(decision.openingReason, 'SELECTED_START');
  assert.equal(words[decision.startWordIndex].text, 'Inflation');
});

test('the first spoken word always keeps a natural pre-roll', () => {
  const words = [...sentence(10, 'Nobody expected that result at all.'.split(' ')), ...body(14)];
  const decision = optimizeEditBoundaries({ words, candidateStart: 10, candidateEnd: 32,
    windowStart: 8, windowEnd: 36 });
  assert.equal(decision.clipFirstWordNotClipped, true);
  assert(decision.firstWordPreRollMs >= 30 && decision.firstWordPreRollMs <= 150,
    `pre-roll ${decision.firstWordPreRollMs}ms outside 30-150ms`);
  assert(decision.editedStart < words[decision.startWordIndex].start);
});

test('an ending that starts a new topic is trimmed back to the payoff', () => {
  const words = [...body(10, 3), ...sentence(25, 'This changed the entire market.'.split(' ')),
    ...sentence(28, 'Anyway, the next thing I wanted to mention is the weather.'.split(' '))];
  const decision = optimizeEditBoundaries({ words, candidateStart: 10, candidateEnd: 32,
    windowStart: 8, windowEnd: 36 });
  assert.equal(words[decision.endWordIndex].text, 'market.');
  assert.equal(decision.endingReason, 'ENDING_TRIMMED_BEFORE_NEW_TOPIC');
  assert.equal(decision.newTopicTrimmed, true);
  assert.equal(decision.clipEndNoNewTopicLeak, true);
  assert.equal(decision.endingStrategy, 'NEW_TOPIC_TRIMMED');
  assert.equal(decision.endingDefectSeverity, 'NONE');
});

test('an ending on a conjunction is a serious defect when it cannot be repaired', () => {
  // The window holds nothing but the fragment, so no repair is available.
  const words = [...body(10, 3), ...sentence(25, 'It mattered because'.split(' '))];
  const decision = optimizeEditBoundaries({ words, candidateStart: 25, candidateEnd: 27,
    windowStart: 24.8, windowEnd: 28 });
  assert.equal(decision.clipEndComplete, false);
  assert.equal(decision.endNotContinuation, false);
  assert.equal(decision.endingDefectSeverity, 'SERIOUS');
  assert.equal(decision.endRepairAttempted, true);
  assert.equal(decision.endRepairSucceeded, false);
  assert.equal(decision.endingStrategy, 'UNRESOLVED_CLOSE');
});

test('an unpunctuated transcript falls back to pauses instead of blocking the clip', () => {
  // Whisper sometimes returns long stretches with no full stop at all. A pause
  // is then the only sentence boundary available, and an ending we cannot verify
  // must degrade the clip rather than fail one that may be perfectly fine.
  const run = (start, texts) => texts.map((text, i) =>
    w(start + i * .4, start + i * .4 + .32, text));
  const words = [...run(10, 'we were talking about several different local issues'.split(' ')),
    ...run(14, 'and the thing that kept coming up was the cost of housing downtown'.split(' ')),
    ...run(20, 'people simply cannot afford to live near where they work'.split(' '))];
  const decision = optimizeEditBoundaries({ words, candidateStart: 10, candidateEnd: 23,
    windowStart: 8, windowEnd: 26 });
  assert.equal(decision.clipEndComplete, false, 'nothing is punctuated, so nothing is provably complete');
  assert.equal(decision.endingDefectSeverity, 'MINOR', 'unverifiable, not proven bad');
  assert.equal(decision.endNotContinuation, true);
  // The chosen end still lands on a pause boundary rather than mid-breath.
  const last = words[decision.endWordIndex];
  const after = words[decision.endWordIndex + 1];
  assert(!after || after.start - last.end >= .6, `ended mid-breath on "${last.text}"`);
});

test('a payoff just past the selected end is extended to, and reported', () => {
  const words = [...body(10, 3), ...sentence(25, 'The whole program collapsed in a single week.'.split(' '))];
  const decision = optimizeEditBoundaries({ words, candidateStart: 10, candidateEnd: 26.5,
    windowStart: 8, windowEnd: 32 });
  assert.equal(words[decision.endWordIndex].text, 'week.');
  assert(decision.contextExtendedEndMs > 0);
  assert(decision.endAdjustmentSec > 0);
  assert.equal(decision.clipEndComplete, true);
  assert.equal(decision.clipEndPayoffDelivered, true);
  assert.equal(decision.payoffPreserved, true);
  assert.equal(decision.endingDefectSeverity, 'NONE');
});

test('Luna context and new-topic hints are honoured only inside word boundaries', () => {
  const words = [...sentence(10, 'The council approved the rule.'.split(' ')),
    ...sentence(13, 'They banned it downtown.'.split(' ')), ...body(16, 2),
    ...sentence(26, 'That decision cost the city millions.'.split(' ')),
    ...sentence(29, 'Separately the mayor resigned last spring.'.split(' '))];
  const decision = optimizeEditBoundaries({ words, candidateStart: 13, candidateEnd: 31,
    windowStart: 8, windowEnd: 34,
    hints: { contextRequiredFromSec: 10, newTopicBeginsAfterSec: 29 } });
  // Starting later than the context Luna marked as required is penalised away.
  assert(words[decision.startWordIndex].start <= 10.01);
  assert.equal(words[decision.endWordIndex].text, 'millions.');
  assert.equal(decision.newTopicTrimmed, true);
  // A hint that lands nowhere near a word is ignored rather than snapped.
  const ignored = optimizeEditBoundaries({ words, candidateStart: 13, candidateEnd: 31,
    windowStart: 8, windowEnd: 34, hints: { payoffEndSec: 22.37 } });
  assert.equal(ignored.lunaEndingApplied, false);
});

test('every opening and ending decision is reported for the analytics loop', () => {
  const words = [...sentence(10, 'Inflation doubled in one single year.'.split(' ')), ...body(14)];
  const decision = optimizeEditBoundaries({ words, candidateStart: 10, candidateEnd: 32,
    windowStart: 8, windowEnd: 36 });
  for (const field of ['originalStartSec', 'optimizedStartSec', 'startAdjustmentSec',
    'originalEndSec', 'optimizedEndSec', 'endAdjustmentSec', 'openingScore', 'endingScore',
    'contextExpandedSec', 'weakLeadRemovedSec'])
    assert.equal(typeof decision[field], 'number', `${field} must be numeric`);
  for (const field of ['payoffPreserved', 'newTopicTrimmed', 'clipStartContextComplete',
    'clipFirstWordNotClipped', 'clipEndNoNewTopicLeak', 'clipEndPayoffDelivered'])
    assert.equal(typeof decision[field], 'boolean', `${field} must be boolean`);
  assert(decision.openingCandidates.length >= 1 && decision.endingCandidates.length >= 1);
  for (const candidate of [...decision.openingCandidates, ...decision.endingCandidates]) {
    assert.equal(typeof candidate.sec, 'number');
    assert.equal(typeof candidate.score, 'number');
    assert(Object.keys(candidate.components).length > 0);
  }
  // No invented "virality" number anywhere in the decision (§40).
  assert(!JSON.stringify(decision).toLowerCase().includes('viral'));
});

// ---------------------------------------------------------------- hook
test('long hooks are wrapped and resized into the header instead of disappearing', () => {
  const zone = PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS.hookZone;
  const long = 'Democratic Support for Abdul Al Sayed in the Senate Race Explained';
  const fit = fitHookText(long, zone);
  assert(fit, 'hook must fit');
  assert(fit.lines.length >= 2 && fit.lines.length <= 3);
  assert(fit.width <= zone.width && fit.height <= zone.height);
  assert.equal(fit.lines.join(' '), long);
  // A pathological hook is shortened deterministically but still rendered.
  const longWords = 'Supercalifragilisticexpialidocious Antidisestablishmentarianism Pneumonoultramicroscopic';
  const small = fitHookText(longWords, zone);
  assert(small && small.width <= zone.width && small.height <= zone.height);
  // A long headline is fitted, not cut: it uses more lines and a smaller size
  // first, and only a genuinely unfittable line is shortened.
  const fittedLong = fitHookText('One two three four five six seven eight nine ten eleven twelve ' +
    'thirteen fourteen fifteen sixteen', zone);
  assert(fittedLong && fittedLong.shortenLevel === 0, 'a 16-word headline keeps its wording');
  assert(fittedLong.lines.length >= 2 && fittedLong.lines.length <= HOOK_TYPE.maxLines);
  const wordy = fitHookText(('Supercalifragilistic Antidisestablishmentarian Pneumonoultramicroscopic ' +
    'Incomprehensibilities Counterrevolutionaries ').repeat(4).trim(), zone);
  assert(wordy && wordy.shortenLevel > 0, 'overlong hooks are shortened deterministically');
  // A single unbreakable token too wide even at 36 px cannot be rendered.
  assert.equal(fitHookText('X'.repeat(80), zone), null);
  assert.equal(shortenHook('Why Prices Rise: A Long Explanation (Part 2)', 1), 'Why Prices Rise');
  assert(estimateTextWidth('WWW', 100) > estimateTextWidth('iii', 100));
  const layout = layoutSubtitleLines(['Unbelievably', 'extraordinary', 'circumstances'], 99, 830, null);
  assert(layout.lines.length === 2 && layout.width <= 830);
});
test('editorial subtitle renderer always places a valid hook and uses frame-exact continuous timing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edit-quality-'));
  try {
    const plan = { ...fallbackEditPlan(0, 6, '9:16'), platformPreset: 'INSTAGRAM_REELS',
      videoTemplate: 'EDITORIAL_FRAME', onScreenHook: { enabled: true, startSec: 0, endSec: 6,
        text: 'Why stay with a wireless company you complain about every single month?',
        position: 'TOP', style: 'TOP_HEADLINE' } };
    plan.subtitleEmphasis = [{ word: 'company', startSec: 1.51, endSec: 1.9, strength: 'STRONG' }];
    const words = [w(.51, .8, 'Why'), w(.8, 1.1, 'stay'), w(1.12, 1.5, 'with'), w(1.51, 1.9, 'company'),
      w(3.2, 3.5, 'Never'), w(3.5, 3.9, 'again.')];
    const stats = await new SubtitleRendererService().write(join(dir, 'e.ass'), plan, words, [], 1080, 1920,
      undefined, [], [], true, PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS, { fps: 30 });
    assert.equal(stats.hookRendered, true);
    assert.equal(stats.hookSuppressionReason, '');
    assert(stats.hookLines.length >= 2);
    const zone = PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS.hookZone;
    assert(stats.hookBounds.x >= zone.x && stats.hookBounds.x + stats.hookBounds.width <= zone.x + zone.width);
    // Word events follow each other without gaps inside a phrase and sit on the frame grid.
    const events = stats.wordEvents;
    for (let i = 1; i < 4; i++) assert.equal(events[i].startFrame, events[i - 1].endFrame);
    assert(events.every((event) => Math.abs(event.renderStart - event.mappedStart) <= 1 / 60 + 1e-9));
    assert(stats.subtitleTimelineErrorWorstMs <= 17);
    assert.equal(events[3].keyword, true);
    assert.equal(stats.subtitleCoverageRatio, 1);
    // Retiming shifts every word by the requested offset.
    const shifted = await new SubtitleRendererService().write(join(dir, 'e.ass'), plan, words, [], 1080, 1920,
      undefined, [], [], true, PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS, { fps: 30, subtitleOffsetSec: .1 });
    assert.equal(shifted.wordEvents[0].startFrame, events[0].startFrame + 3);
    // Placement hints move captions below a fitted frame.
    const fitted = await new SubtitleRendererService().write(join(dir, 'e.ass'), plan, words, [], 1080, 1920,
      undefined, [], [], true, PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS,
      { fps: 30, placementAt: () => ({ fitBottom: 1254 }) });
    assert(fitted.subtitlePositions[0].y * 1920 > 1254);
    assert(fitted.sourceTextAdjustments > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- shots
const face = (x, y, size, extra = {}) => ({ timestamp: 0, x, y, w: size, h: size * 1.3, ...extra });
const frame = (t, faces = [], persons = [], textCoverage = 0, extra = {}) =>
  ({ t, faces: faces.map((f) => ({ ...f, timestamp: t })), persons, textCoverage, textBoxes: [], ocrLines: [], ...extra });
test('shot classification drives layout policy', () => {
  const cropWidth = .515;
  const single = classifyFrames([frame(0, [face(.42, .2, .2)]), frame(.25, [face(.43, .2, .2)])], cropWidth);
  assert.equal(single.shotClass, 'TALKING_HEAD');
  assert.equal(single.frameMode, 'FACE_SINGLE');
  assert.equal(single.layout, 'FILL');
  assert.equal(single.zoomAllowed, true);
  const pairWide = classifyFrames([frame(0, [face(.1, .2, .15), face(.72, .22, .15)])], cropWidth);
  assert.equal(pairWide.shotClass, 'TWO_PERSON');
  assert.equal(pairWide.frameMode, 'FACE_PAIR');
  assert.equal(pairWide.layout, 'FIT', 'two people who do not fit the crop are preserved');
  assert.equal(pairWide.zoomAllowed, false);
  const pairClose = classifyFrames([frame(0, [face(.3, .2, .1), face(.55, .22, .1)])], cropWidth);
  assert.equal(pairClose.shotClass, 'TWO_PERSON');
  assert.equal(pairClose.layout, 'FILL');
  const dominant = classifyFrames([frame(0, [face(.4, .1, .3), face(.8, .3, .08)])], cropWidth);
  assert.equal(dominant.shotClass, 'SINGLE_SPEAKER');
  const group = classifyFrames([frame(0, [face(.1, .2, .1), face(.4, .2, .1), face(.7, .2, .1)])], cropWidth);
  assert.equal(group.layout, 'FIT');
  const tweet = classifyFrames([frame(0, [face(.35, .5, .08)], [], .003, {
    ocrLines: ['SEP 13, 2026', '@AryasTakes', 'I heard UT graduation this year looked like this. I',
      "didn't believe it. The problem is now obviously far worse than anyone imagined."] })], cropWidth);
  assert.equal(tweet.informationMode, true);
  assert.equal(tweet.frameMode, 'INFORMATION_REGION');
  assert.equal(tweet.layout, 'FIT');
  const chart = classifyFrames([frame(0, [], [], .2, { ocrLines: ['GDP 2021 2.1% 2022 3.4% 2023 1.9% 2024 2.7%'] })], cropWidth);
  assert.equal(chart.shotClass, 'CHART');
  const web = classifyFrames([frame(0, [], [], .18, { ocrLines: ['www.example.com Sign in Search news'] })], cropWidth);
  assert.equal(web.shotClass, 'WEBPAGE');
  assert.equal(web.frameMode, 'INFORMATION_REGION');
  const article = classifyFrames([frame(0, [], [], .12, {
    ocrLines: ['analysis '.repeat(40)] })], cropWidth);
  assert.equal(article.shotClass, 'ARTICLE');
  // A talking head with a big lower-third banner stays a talking head.
  const banner = classifyFrames([frame(0, [face(.42, .2, .2)], [], .14, { ocrLines: ['COMING UP', 'rumble'] })], cropWidth);
  assert.equal(banner.layout, 'FILL');
  const bRoll = classifyFrames([frame(0)], cropWidth);
  assert.equal(bRoll.shotClass, 'B_ROLL');
  assert.equal(bRoll.frameMode, 'BROLL_COMPOSITION');
  const preserve = classifyFrames([frame(0, [face(.42, .2, .1)], [], .06)], cropWidth, { preserveInformation: true });
  assert.equal(preserve.layout, 'FIT');
});
test('mixed speaker, B-roll and information shots keep distinct policies', () => {
  const timeline = buildEditedTimeline({ candidateStart: 0, candidateEnd: 15,
    editedStart: 0, editedEnd: 15, cuts: [] });
  const infoText = ['Revenue 2024 18% Costs 2024 7% Margin 2024 11%'];
  const analysis = { source: 'DENSE', shotBoundaries: [5, 10], ocrText: '', fallbackReason: '', runtimeMs: 0,
    frames: [frame(1, [face(.42, .2, .2)]), frame(3, [face(.42, .2, .2)]),
      frame(6), frame(8), frame(11, [], [], .2, { ocrLines: infoText }),
      frame(13, [], [], .2, { ocrLines: infoText })] };
  const shots = classifyShots(analysis, timeline, .515);
  assert.deepEqual(shots.map((shot) => shot.shotClass), ['TALKING_HEAD', 'B_ROLL', 'CHART']);
  assert.deepEqual(shots.map((shot) => shot.zoomAllowed), [true, false, false]);
});
test('shots split at boundaries on the final timeline', () => {
  const timeline = buildEditedTimeline({ candidateStart: 100, candidateEnd: 120, editedStart: 100, editedEnd: 120,
    cuts: [{ start: 104, end: 105 }] });
  const analysis = { source: 'DENSE', shotBoundaries: [110], ocrText: '', fallbackReason: '', runtimeMs: 0,
    frames: [frame(101, [face(.42, .2, .2)]), frame(108, [face(.42, .2, .2)]),
      frame(112, [face(.1, .2, .15), face(.72, .2, .15)]), frame(118, [face(.1, .2, .15), face(.72, .2, .15)])] };
  const shots = classifyShots(analysis, timeline, .515);
  assert.equal(shots.length, 2);
  assert(near(shots[0].end, 9));
  assert.equal(shots[1].layout, 'FIT');
  assert.equal(fitEnableExpression(shots), 'between(t\\,9.000\\,18.999)');
  const sparse = analysisFromStoredChunks([{ startTime: 95, endTime: 125, visualAnalysis: {
    faceTracks: [{ timestamp: 101, x: .4, y: .2, w: .2, h: .3 }], personTracks: [], shotBoundaries: [110],
    textAreaRatio: 3, ocrText: 'long chunk text '.repeat(10), subtitleDetected: false } }], 98, 122);
  assert.equal(sparse.source, 'STORED_SPARSE');
  assert(sparse.frames.every((item) => item.ocrLines.length === 0), 'chunk OCR must not count as frame evidence');
});
test('information regions are calculated independently for every shot', () => {
  const shots = [
    { start: 0, end: 5, sourceStart: 0, sourceEnd: 5, layout: 'FIT', informationMode: true },
    { start: 5, end: 10, sourceStart: 5, sourceEnd: 10, layout: 'FIT', informationMode: true }
  ];
  const boxes = (x) => [{ x, y: .2, w: .22, h: .2 }, { x: x + .03, y: .45, w: .2, h: .16 }];
  const frames = [1, 3].map((t) => frame(t, [], [], .1, { textBoxes: boxes(.08) }))
    .concat([6, 8].map((t) => frame(t, [], [], .1, { textBoxes: boxes(.68) })));
  const regions = detectInformationRegions(frames, shots, { width: 1080, height: 1248 },
    { width: 1920, height: 1080 });
  assert.equal(regions.length, 2);
  assert(regions[0].region.x < .3 && regions[1].region.x > .45,
    'each shot keeps its own information composition');
});

// ---------------------------------------------------------------- zoom
test('zoom starts before the trigger onset, peaks on the word and returns', () => {
  const plan = fallbackEditPlan(10, 40, '9:16');
  plan.subtitleEmphasis = [{ word: 'billion', startSec: 20, endSec: 20.45, strength: 'STRONG' }];
  plan.operations = [{ type: 'ZOOM', startSec: 19.3, endSec: 21.5, reason: 'stat', scale: 1.19,
    focusX: null, focusY: null, target: 'FACE', words: [], triggerText: 'billion' }];
  const words = [w(19.5, 19.9, 'three'), w(20, 20.45, 'billion'), w(20.5, 20.9, 'dollars')];
  const { events } = planZoomEvents({ plan, cuts: [], words, fps: 30 });
  assert.equal(events.length, 1);
  const event = events[0];
  // The push is already moving when the word lands: it starts 80-180 ms early
  // and peaks within 180 ms after the onset (§6).
  const onset = 10;
  assert(event.startSec <= onset - .08 + 1e-9 && event.startSec >= onset - .18 - 1e-9,
    `zoom begins 80-180 ms before onset, got ${event.startSec}`);
  assert.equal(event.zoomStartsBeforeWord, true);
  assert(event.peakOffsetFromWordMs >= 0 && event.peakOffsetFromWordMs <= 180,
    `peak lands ${event.peakOffsetFromWordMs}ms after the word`);
  assert.equal(event.motionKind, 'SEMANTIC_ZOOM');
  assert.equal(event.minVisibleScaleDelta, ZOOM_VISIBLE_DELTA[event.intensity]);
  // The plan asked for 1.19 and gets 1.19: a requested scale is never pushed up.
  assert.equal(event.peakScale, 1.19);
  assert.equal(event.intensity, 'NORMAL');
  assert.equal(event.kind, 'IN');
  assert.equal(event.semanticReason, 'stat');
  assert.equal(event.semanticCategory, 'STATISTIC');
  assert.equal(event.sfxType, 'STAT_HIT');
  assert.equal(event.zoomTriggeredOnStrongWord, true);
  assert.equal(event.zoomPeakSynced, true);
  assert.equal(event.zoomReturned, true);
  assert(near(zoomScaleAt(events, event.zoomInEndSec + .05, 30), event.peakScale, .01));
  assert(near(zoomScaleAt(events, event.endSec + .05, 30), 1, 1e-9));
  assert(near(zoomScaleAt(events, event.startSec - .1, 30), 1, 1e-9));
});
test('local peak detection creates multiple word-timed semantic zooms', () => {
  const plan = fallbackEditPlan(0, 30, '9:16');
  const words = [w(3, 3.35, 'never'), w(8, 8.35, '40%'), w(13, 13.4, 'hidden'),
    w(19, 19.4, 'however'), w(25, 25.4, 'revealed')]
    .map((word, index) => ({ ...word, audioEnergyScore: .55 + index * .08 }));
  plan.subtitleEmphasis = words.map((word) => ({ word: word.text, startSec: word.start,
    endSec: word.end, strength: 'STRONG' }));
  const candidates = detectSemanticZoomCandidates(words, plan.subtitleEmphasis, 0, 30);
  const result = planZoomEvents({ plan, cuts: [], words, fps: 30, finalDuration: 30 });
  assert.equal(candidates.length, 5);
  assert(result.events.length >= 3 && result.events.length <= 5, `${result.events.length} events`);
  assert(result.events.every((event) => event.startSec <= event.wordStartSec &&
    event.peakOffsetFromWordMs >= 80 && event.peakOffsetFromWordMs <= 180));
  assert(result.events.every((event) => event.semanticScore > 0 && event.combinedScore > 0));
  assert.equal(result.zoomCoverageValid, true);
});
test('long talking-head coverage is duration-aware and capped by eligible local peaks', () => {
  const plan = fallbackEditPlan(0, 43, '9:16');
  const words = [3, 10, 17, 24, 31, 38].map((start, index) => ({
    ...w(start, start + .35, ['never', '40%', 'hidden', 'however', 'truth', 'revealed'][index]),
    audioEnergyScore: .7 }));
  plan.subtitleEmphasis = words.map((word) => ({ word: word.text, startSec: word.start,
    endSec: word.end, strength: 'STRONG' }));
  const shot = { start: 0, end: 43, sourceStart: 0, sourceEnd: 43, shotClass: 'TALKING_HEAD',
    layout: 'FILL', zoomAllowed: true, informationMode: false, faceCount: 1, personCount: 1,
    primaryFaceArea: .04, textCoverage: 0, sampleCount: 20, reason: 'TEST' };
  const result = planZoomEvents({ plan, cuts: [], words, fps: 30, finalDuration: 43, shots: [shot] });
  assert.equal(requiredSemanticZoomCount(43, 6), 5);
  assert.equal(result.requiredZoomCount, 5);
  assert(result.events.length >= 5, `${result.events.length} visible plans`);
  assert.equal(result.zoomCoverageValid, true);
  assert(result.events.every((event) => event.endSec <= 42.6));
  assert.deepEqual(result.events[0].verificationFrameTimes.length, 5);
});
test('zoom quota is capped by peaks that survive structural safety', () => {
  const plan = fallbackEditPlan(0, 56, '9:16');
  const words = [3, 9.9, 18, 27, 36, 55.7].map((start, index) => ({
    ...w(start, Math.min(55.95, start + .2),
      ['never', '40%', 'hidden', 'however', 'truth', 'revealed'][index]),
    audioEnergyScore: .8 }));
  plan.subtitleEmphasis = words.map((word) => ({ word: word.text, startSec: word.start,
    endSec: word.end, strength: 'STRONG' }));
  const shot = (start, end) => ({ start, end, sourceStart: start, sourceEnd: end,
    shotClass: 'TALKING_HEAD', layout: 'FILL', zoomAllowed: true, informationMode: false,
    faceCount: 1, personCount: 1, primaryFaceArea: .04, textCoverage: 0,
    sampleCount: 20, reason: 'TEST' });
  const result = planZoomEvents({ plan, cuts: [], words, fps: 30, finalDuration: 56,
    shots: [shot(0, 10), shot(10, 56)] });
  assert.equal(result.nominalRequiredZoomCount, 5);
  assert.equal(result.eligibleSafeZoomCount, 4);
  assert.equal(result.effectiveRequiredZoomCount, 4);
  assert.equal(result.requiredZoomCount, 4);
  assert.equal(result.zoomCoverageValid, true);
});
test('one unsafe zoom is locally removed without disabling earlier safe zooms', () => {
  const plan = fallbackEditPlan(0, 33.2, '9:16');
  const words = [4.2, 10.8, 17.4, 25.1].map((start, index) => ({
    ...w(start, start + .3, ['never', '40%', 'hidden', 'revealed'][index]), audioEnergyScore: .8 }));
  plan.subtitleEmphasis = words.map((word) => ({ word: word.text, startSec: word.start,
    endSec: word.end, strength: 'STRONG' }));
  const shot = { start: 0, end: 33.2, sourceStart: 0, sourceEnd: 33.2,
    shotClass: 'TALKING_HEAD', frameMode: 'FACE_SINGLE', layout: 'FILL', zoomAllowed: true,
    informationMode: false, faceCount: 1, personCount: 1, primaryFaceArea: .04,
    textCoverage: 0, sampleCount: 20, reason: 'REGRESSION_FILE_26' };
  const before = planZoomEvents({ plan, cuts: [], words, fps: 30, finalDuration: 33.2, shots: [shot] });
  assert(before.events.length >= 3);
  const bad = before.events.at(-1);
  const after = planZoomEvents({ plan, cuts: [], words, fps: 30, finalDuration: 33.2, shots: [shot],
    zoomSuppressions: [{ triggerTimestamp: bad.triggerTimestamp, reason: 'ZOOM_ACTIVE_IN_FINAL_FREEZE' }] });
  assert.equal(after.events.length, before.events.length - 1);
  assert.deepEqual(after.events.map((event) => event.triggerTimestamp),
    before.events.slice(0, -1).map((event) => event.triggerTimestamp));
  assert.equal(after.actualZoomCount, after.events.length);
  assert.equal(after.effectiveRequiredZoomCount,
    Math.min(after.nominalRequiredZoomCount, after.eligibleSafeZoomCount));
  assert.equal(after.zeroZoomReason, 'HAS_SAFE_ZOOMS');
  assert(after.zoomSuppressionReasons.includes('LOCAL_REPAIR_ZOOM_ACTIVE_IN_FINAL_FREEZE'));
});
test('zero zoom caused by repair remains a hard sanity failure', () => {
  const plan = fallbackEditPlan(0, 20, '9:16');
  const words = [{ ...w(5, 5.3, 'never'), audioEnergyScore: .9 }];
  plan.subtitleEmphasis = [{ word: 'never', startSec: 5, endSec: 5.3, strength: 'STRONG' }];
  const shot = { start: 0, end: 20, sourceStart: 0, sourceEnd: 20,
    shotClass: 'TALKING_HEAD', frameMode: 'FACE_SINGLE', layout: 'FILL', zoomAllowed: true,
    informationMode: false, faceCount: 1, personCount: 1, primaryFaceArea: .04,
    textCoverage: 0, sampleCount: 10, reason: 'TEST' };
  const result = planZoomEvents({ plan, cuts: [], words, fps: 30, finalDuration: 20, shots: [shot],
    zoomSuppressions: [{ triggerTimestamp: 5, reason: 'REPAIR_REGRESSION' }] });
  assert.equal(result.actualZoomCount, 0);
  assert.equal(result.zeroZoomReason, 'ZERO_ZOOM_CAUSED_BY_REPAIR_BUG');
  assert.equal(result.zoomCoverageValid, false);
});
test('audio energy augments emphatic speech without suppressing calm semantic beats', () => {
  const loud = { ...w(4, 4.4, 'important'), audioEnergyScore: 1 };
  const calm = { ...w(10, 10.4, 'truth'), audioEnergyScore: .08 };
  const emphasis = [{ word: 'truth', startSec: 10, endSec: 10.4, strength: 'STRONG' }];
  const candidates = detectSemanticZoomCandidates([loud, calm], emphasis, 0, 15);
  assert.equal(candidates.length, 2);
  assert(candidates.find((item) => item.word === 'important').audioEnergyScore >
    candidates.find((item) => item.word === 'truth').audioEnergyScore);
  assert(candidates.find((item) => item.word === 'truth').semanticScore >= .88,
    'a calm but meaningful word remains eligible');
});
test('a phrase zoom peaks on its stressed word and locks the active face', () => {
  const plan = fallbackEditPlan(0, 12, '9:16');
  const words = [w(5.8, 6.05, 'the'), w(6.1, 6.35, 'shocking'), w(6.4, 6.75, 'truth')];
  plan.subtitleEmphasis = [{ word: 'truth', startSec: 6.4, endSec: 6.75, strength: 'STRONG' }];
  plan.operations = [{ type: 'ZOOM', startSec: 5.6, endSec: 7.5, reason: 'topic reveal', scale: 1.3,
    focusX: null, focusY: null, target: 'FACE', words: [], triggerText: 'the shocking truth', intensity: 'STRONG' }];
  const faces = [5.8, 6.2, 6.5, 6.9, 7.2].flatMap((t) => [
    { timestamp: t, x: .3, y: .2, w: .11, h: .18, trackId: 'listener', mouthActivity: .02 },
    { timestamp: t, x: .55, y: .2, w: .11, h: .18, trackId: 'speaker', mouthActivity: .8 }
  ]);
  const frames = [5.8, 6.2, 6.5, 6.9, 7.2].map((t) => frame(t,
    faces.filter((face) => face.timestamp === t)));
  const shot = { start: 0, end: 12, sourceStart: 0, sourceEnd: 12, shotClass: 'TWO_PERSON',
    layout: 'FILL', zoomAllowed: true, informationMode: false, faceCount: 2, personCount: 2,
    primaryFaceArea: .02, textCoverage: 0, sampleCount: frames.length, reason: '' };
  const result = planZoomEvents({ plan, cuts: [], words, fps: 30, shots: [shot], frames,
    cropAt: () => ({ x: .24, y: 0, w: .52, h: 1 }), sourceWidth: 1920, sourceHeight: 1080 });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].wordStartSec, 6.4);
  assert.equal(result.events[0].trackId, 'speaker');
  assert.equal(result.events[0].faceLockValid, true);
  assert(result.events[0].peakScale <= 1.24, 'two-person punch-in remains moderate');
});
test('zoom is reduced or rejected when it would clip the subject or information', () => {
  const plan = fallbackEditPlan(0, 20, '9:16');
  plan.operations = [{ type: 'ZOOM', startSec: 4.8, endSec: 7, reason: 'x', scale: 1.22, focusX: null,
    focusY: null, target: 'FACE', words: [], triggerText: 'shocking' }];
  plan.subtitleEmphasis = [{ word: 'shocking', startSec: 5, endSec: 5.5, strength: 'STRONG' }];
  const words = [w(5, 5.5, 'shocking')];
  const crop = { x: .2425, y: 0, w: .515, h: 1 };
  const tall = [0, 5, 5.5, 6, 6.5, 7].map((t) => frame(t, [{ ...face(.3, .02, .2), h: .9 }]));
  const shot = { start: 0, end: 20, sourceStart: 0, sourceEnd: 20, shotClass: 'TALKING_HEAD', layout: 'FILL',
    zoomAllowed: true, informationMode: false, faceCount: 1, personCount: 1, primaryFaceArea: .1,
    textCoverage: 0, sampleCount: 6, reason: '' };
  const unsafe = planZoomEvents({ plan, cuts: [], words, fps: 30, shots: [shot], cropAt: () => crop, frames: tall });
  assert.equal(unsafe.events.length, 0);
  assert.equal(unsafe.rejected[0].reason, 'SUBJECT_UNSAFE');
  const small = [0, 5, 5.5, 6, 6.5, 7].map((t) => frame(t, [face(.44, .25, .12)]));
  const safe = planZoomEvents({ plan, cuts: [], words, fps: 30, shots: [shot], cropAt: () => crop, frames: small });
  assert.equal(safe.events.length, 1);
  const window = zoomWindow(crop, safe.events[0].peakScale, safe.events[0].focusX, safe.events[0].focusY);
  const f = small[2].faces[0];
  assert(f.x >= window.x && f.x + f.w <= window.x + window.w && f.y >= window.y);
  // A burned-in banner is never cropped: the move is walked down to a scale that
  // keeps it readable, and dropped outright when no such scale exists.
  const bannerBox = { x: .3, y: .8, w: .4, h: .12 };
  const banner = small.map((item) => ({ ...item, textBoxes: [bannerBox] }));
  const text = planZoomEvents({ plan, cuts: [], words, fps: 30, shots: [shot], cropAt: () => crop, frames: banner });
  if (text.events.length) {
    const event = text.events[0];
    assert(event.peakScale < 1.21, `banner survived only an unreduced zoom: ${event.peakScale}`);
    assert.equal(event.scaleReducedForSafety, true);
    const window = zoomWindow(crop, event.peakScale, event.focusX, event.focusY);
    const visible = Math.max(0, Math.min(bannerBox.x + bannerBox.w, window.x + window.w) -
      Math.max(bannerBox.x, window.x)) *
      Math.max(0, Math.min(bannerBox.y + bannerBox.h, window.y + window.h) -
      Math.max(bannerBox.y, window.y)) / (bannerBox.w * bannerBox.h);
    assert(visible >= .9, `burned-in banner only ${(visible * 100).toFixed(0)}% visible`);
  } else assert.equal(text.rejected[0].reason, 'TEXT_UNSAFE');
  const info = planZoomEvents({ plan, cuts: [], words, fps: 30,
    shots: [{ ...shot, layout: 'FIT', zoomAllowed: false, informationMode: true, shotClass: 'CHART' }] });
  assert.equal(info.rejected[0].reason, 'INFORMATION_SHOT');
  const nearCut = planZoomEvents({ plan, cuts: [{ start: 6.3, end: 6.8 }], words, fps: 30 });
  assert.equal(nearCut.events.length, 1, 'hold is shortened before the cut');
  assert(nearCut.events[0].endSec <= 6.3 - .03);
  const noRoom = planZoomEvents({ plan, cuts: [{ start: 5.6, end: 6.8 }], words, fps: 30 });
  assert.equal(noRoom.rejected[0].reason, 'NO_ROOM_BEFORE_CUT');
  const disabled = planZoomEvents({ plan, cuts: [], words, fps: 30, disabled: true });
  assert.equal(disabled.rejected[0].reason, 'ZOOM_DISABLED_BY_REPAIR');
});
test('subject safety measures crop and zoom geometry', () => {
  const shots = [{ start: 0, end: 10, layout: 'FILL', shotClass: 'TALKING_HEAD', informationMode: false },
    { start: 10, end: 20, layout: 'FIT', shotClass: 'TWO_PERSON', informationMode: false }];
  const frames = [frame(2, [face(.45, .2, .1)]), frame(4, [face(.9, .2, .08)]),
    frame(12, [face(.05, .2, .1), face(.85, .2, .1)])];
  const result = measureSubjectSafety({ frames, shots, cropAt: () => ({ x: .25, y: 0, w: .5, h: 1 }),
    clipStart: 0, cuts: [], zoomEvents: [], fps: 30, finalDuration: 20 });
  assert.equal(result.subjectSafetyRatio, .5);
  assert.deepEqual(result.unsafeShotIndexes, [0]);
  assert.equal(result.twoPersonPreservedRatio, 1);
});
test('camera re-frames at shot changes without panning', () => {
  const faces = [0, .5, 1, 1.5].map((t) => ({ timestamp: t, x: .2, y: .2, w: .12, h: .2 }))
    .concat([2.5, 3, 3.5, 4].map((t) => ({ timestamp: t, x: .68, y: .2, w: .12, h: .2 })));
  const shots = [{ start: 0, end: 2.2, layout: 'FILL', shotClass: 'TALKING_HEAD' },
    { start: 2.2, end: 5, layout: 'FILL', shotClass: 'TALKING_HEAD' }];
  const camera = new ReframeService().plan('9:16', faces, [], 0, [], 1920, 1080, [], 30,
    PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS.videoViewport, true, { shots });
  assert.equal(camera.shotChangeReframeCount, 1);
  assert.equal(camera.shotCutResetsCamera, true);
  assert(camera.cameraMoves.some((move) => move.snapped && near(move.t, 2.2)),
    'the reset is anchored to the shot boundary, not a later detection');
  assert.equal(camera.cameraNoLongPan, true);
  const before = camera.cropAt(2.1), after = camera.cropAt(2.21);
  assert(after.x - before.x > .3, 'crop jumps at the cut');
  const f = faces[5];
  assert(f.x >= camera.cropAt(3).x && f.x + f.w <= camera.cropAt(3).x + camera.cropAt(3).w);
  assert.deepEqual(validatePreRenderCamera(camera, shots, 5), []);
});

// ---------------------------------------------------------------- audio / QA math
test('onset measurement and envelope lag', () => {
  const hop = .01;
  const db = new Float32Array(600).fill(-70);
  const onsets = [1, 2.5, 4];
  for (const onset of onsets) for (let i = 0; i < 30; i++) db[Math.round((onset + .08) / hop) + i] = -20;
  const offsets = measureOnsets({ db, hopSec: hop }, onsets.map((start) => ({ start, end: start + .4, gapBefore: .6 })));
  assert(offsets.every((value) => value != null && Math.abs(value - .08) <= .015));
  const shifted = new Float32Array(600).fill(-70);
  for (let i = 0; i < 590; i++) shifted[i + 7] = db[i];
  assert.equal(envelopeLag(db, shifted, 20), 7);
  assert(contrastRatio(1, 0) > 20);
  assert.deepEqual(assToRgb('&H006BD6FF'), [255, 214, 107]);
});
test('zoom estimation recognises a magnified frame', () => {
  const size = 48;
  const before = new Float32Array(size * size).map((_, i) => ((i % size) * 7 + Math.floor(i / size) * 13) % 17 / 17);
  const after = new Float32Array(size * size);
  const scale = 1.2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = Math.round((size - size / scale) * .5 + (x + .5) / scale - .5);
    const sy = Math.round((size - size / scale) * .5 + (y + .5) / scale - .5);
    after[y * size + x] = before[sy * size + sx];
  }
  const estimate = estimateZoom(before, after, size, size, .5, .5);
  assert(Math.abs(estimate.estimatedScale - 1.2) <= .04, `estimated ${estimate.estimatedScale}`);
  assert(estimate.bestError < estimate.identityError);
});

// ---------------------------------------------------------------- music / grading / background
test('music library only uses licensed tracks and keeps speech dominant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-lib-'));
  try {
    writeFileSync(join(dir, 'a.m4a'), 'x');
    writeFileSync(join(dir, 'b.m4a'), 'x');
    writeFileSync(join(dir, 'library.json'), JSON.stringify({ tracks: [
      { id: 'a', file: 'a.m4a', moods: ['DOCUMENTARY_TENSION'], license: 'GENERATED_IN_HOUSE' },
      { id: 'b', file: 'b.m4a', moods: ['CLEAN_NEUTRAL'], license: 'UNKNOWN' },
      { id: 'c', file: 'missing.m4a', moods: ['CLEAN_NEUTRAL'], license: 'CC0' }] }));
    // The generated beds now live in their own directory, so an isolated test
    // library points both arguments at the fixture (see scan-music-library.cjs).
    const empty = join(dir, 'no-generated');
    const library = await loadMusicLibrary(dir, empty);
    assert.deepEqual(library.tracks.map((track) => track.id), ['a']);
    assert(library.problems.some((item) => item.startsWith('UNLICENSED_TRACK')));
    assert(library.problems.some((item) => item.startsWith('MISSING_TRACK')));
    assert.equal(selectMusicTrack(library.tracks, 'DOCUMENTARY_TENSION', 'seed').id, 'a');
    assert.equal(selectMusicTrack(library.tracks, 'NONE', 'seed'), null);
    assert(musicGainDb(library.tracks[0], 'CLEAN_NEUTRAL') <= -10);
    assert.equal((await loadMusicLibrary(join(dir, 'nope'), empty)).problems[0], 'MUSIC_LIBRARY_MISSING');
    assert.equal(fallbackMusicMood('the debate over the crisis'), 'DOCUMENTARY_TENSION');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('grading is source-aware and subtle', () => {
  const graded = { brightness: .45, contrast: .32, saturation: .6, highlightClipping: .05 };
  assert.equal(resolveGradePreset('WARM_TALKING_HEAD', graded), 'SOURCE_ALREADY_GRADED');
  const dark = { brightness: .22, contrast: .15, saturation: .25, highlightClipping: 0, meanR: .3, meanB: .3 };
  const preset = resolveGradePreset('WARM_TALKING_HEAD', dark);
  assert.equal(preset, 'WARM_TALKING_HEAD');
  const filter = gradingFilter(preset, dark);
  assert(filter.report.exposureAdjustment > 0);
  assert(filter.values.gamma > 1, 'exposure goes through gamma, not a black-lifting offset');
  assert(Math.abs(filter.values.brightness) < .01);
  assert(filter.report.saturationAdjustment > 0 && filter.report.saturationAdjustment < .15);
  const minimal = gradingFilter('SOURCE_ALREADY_GRADED', graded);
  assert(minimal.report.contrastAdjustment < .01 && minimal.report.exposureAdjustment === 0);
});
test('source-aware header colors keep white text readable', () => {
  const light = ensureContrastWithWhite([230, 225, 210]);
  const lum = (c) => c.map((v) => { const x = v / 255; return x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; })
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  assert(1.05 / (lum(light) + .05) >= 7);
  const palette = { dominant: '#E6E1D2', secondary: '#806040', darkVariant: '#3A382F', lightVariant: '#FFFFFF',
    accent: '#806040', textColor: '#FFFFFF', brightness: .8, saturation: .2, temperature: 'WARM' };
  const [top, bottom] = backgroundColors(palette, 'SOURCE_MATCH_GRADIENT');
  assert.notEqual(top, '#000000');
  assert.notEqual(top, bottom);
  const darker = backgroundColors(palette, 'SOURCE_MATCH_GRADIENT', .3);
  assert(parseInt(darker[0].slice(1, 3), 16) < parseInt(top.slice(1, 3), 16));
});

// ---------------------------------------------------------------- polish pass
const solidFrame = (t, rgb) => ({ t, rgb: Buffer.from(Array.from({ length: 32 * 32 }, () => rgb).flat()) });
test('background palette changes only on meaningful scene changes', () => {
  // Input time == source time (offset 0). Blue scene, a brief flash, then a warm scene.
  const frames = [0, .5, 1, 1.5, 2, 2.5, 3, 3.5].map((t) => solidFrame(t, [30, 40, 120]))
    .concat([4, 4.5].map((t) => solidFrame(t, [32, 42, 118])))
    .concat([5, 5.5, 6, 6.5, 7, 7.5].map((t) => solidFrame(t, [150, 90, 40])));
  const shot = (start, end) => ({ start, end, sourceStart: start, sourceEnd: end });
  const segments = buildPaletteSegments([shot(0, 4), shot(4, 5), shot(5, 5.4), shot(5.4, 8)], frames, 0,
    'SOURCE_MATCH_GRADIENT', 8);
  assert.equal(segments.length, 2, 'near-identical and too-short shots share a palette');
  assert.deepEqual(segments.map((s) => [s.start, s.end]), [[0, 5], [5, 8]]);
  assert.deepEqual(segments[1].shotIndexes, [2, 3]);
  assert.equal(segments[0].palette.temperature, 'COOL');
  assert.equal(segments[1].palette.temperature, 'WARM');
  const [top] = backgroundColors(segments[1].palette, 'SOURCE_MATCH_GRADIENT');
  const rgb = [1, 3, 5].map((i) => parseInt(top.slice(i, i + 2), 16));
  assert(rgb[0] > rgb[2], 'warm scene gives a warm dark header');
  assert.equal(buildPaletteSegments([], frames, 0, 'SOURCE_MATCH_GRADIENT', 8).length, 1);
});
test('captions move away from burned-in lower thirds but never onto faces', () => {
  const viewport = PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS.videoViewport;
  const caption = { x: 540, width: 600, height: 110 };
  const clear = placeAroundSourceText(1251, [], [], caption, viewport);
  assert.deepEqual([clear.bottom, clear.collided], [1251, false]);
  const lowerThird = { x: 0, y: 1180, width: 1080, height: 120 };
  const moved = placeAroundSourceText(1251, [lowerThird], [], caption, viewport);
  assert.equal(moved.collided, true);
  assert(moved.bottom <= lowerThird.y - 10 || moved.bottom - caption.height >= lowerThird.y + lowerThird.height);
  assert(moved.ratio <= .06);
  // Moving up would cover the face: the caption stays put (collision is still reported).
  const face = { x: 300, y: 850, width: 480, height: 250 };
  const tall = { x: 0, y: 1060, width: 1080, height: 470 };
  const blocked = placeAroundSourceText(1251, [tall], [face], caption, viewport);
  assert.equal(blocked.bottom, 1251);
  assert.equal(blocked.collided, true);
  assert.equal(collisionAreaRatio({ x: 0, y: 0, width: 10, height: 10 }, [{ x: 5, y: 5, width: 10, height: 10 }]), .25);
});
test('editorial hook is an uppercase two-line headline visible at frame zero', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edit-hook-'));
  try {
    const plan = { ...fallbackEditPlan(0, 6, '9:16'), platformPreset: 'INSTAGRAM_REELS',
      videoTemplate: 'EDITORIAL_FRAME', onScreenHook: { enabled: true, startSec: 0, endSec: 6,
        text: "Who Benefits From Frisco's Change?", position: 'TOP', style: 'TOP_HEADLINE' } };
    const layout = PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS;
    const stats = await new SubtitleRendererService().write(join(dir, 'h.ass'), plan, [w(.5, .9, 'Who')], [],
      1080, 1920, undefined, [], [], true, layout, { fps: 30 });
    assert.equal(stats.hookLines.length, 2);
    assert.equal(stats.hookText, "WHO BENEFITS FROM FRISCO'S CHANGE?");
    assert(stats.hookFontSize <= 104);
    // Longer headlines keep their case at the regular size.
    const long = await new SubtitleRendererService().write(join(dir, 'h.ass'), { ...plan, onScreenHook: {
      ...plan.onScreenHook, text: 'Assessing Whether Charlie Kirk Position Was Clear To Everyone' } },
    [w(.5, .9, 'Who')], [], 1080, 1920, undefined, [], [], true, layout, { fps: 30 });
    assert.equal(long.hookText, 'Assessing Whether Charlie Kirk Position Was Clear To Everyone');
    assert(long.hookLines.length <= 3);
    assert.equal(stats.hookSettleSec, 0);
    const zone = layout.hookZone;
    // The headline sits low in the header: safe padding above, a clear gap to the
    // video below, and the fitted block is bottom-anchored inside its zone.
    assert(zone.y >= 56, 'hook zone keeps safe top padding');
    assert(layout.videoViewport.y - (zone.y + zone.height) >= HOOK_PLACEMENT.minGapAboveVideo,
      'hook zone clears the video');
    assert(layout.headerBounds.height - (zone.y + zone.height) >= 10, 'hook sits above the header edge');
    assert(stats.hookBounds.y + stats.hookBounds.height <= zone.y + zone.height,
      'hook is bottom-anchored inside its zone');
    assert(stats.hookBounds.y >= zone.y, 'hook stays below the safe top padding');
    assert.equal(stats.hookNotTooHigh, true);
    assert.equal(stats.hookGapAboveVideoValid, true);
    // Exactly one or two accent words, never the whole headline.
    assert(stats.hookAccentWordCount >= 1 && stats.hookAccentWordCount <= 2);
    assert(stats.hookAccentWordCount < stats.hookWordCount);
    const ass = require('node:fs').readFileSync(join(dir, 'h.ass'), 'utf8');
    const hookLine = ass.split('\n').find((line) => line.includes(',Hook,'));
    // The headline fades in where it will stay: no rise, no scale, nothing that
    // would move it off the plate drawn behind it.
    assert(/\\pos\(540,\d+\)\\fad\(0,0\)/u.test(hookLine), hookLine);
    assert(!/\\move\(/u.test(hookLine), 'the headline does not move');
    // The plate is drawn under it, at the same fade, as a rounded rectangle.
    const plateLine = ass.split('\n').find((line) => line.includes(',HookPlate,'));
    assert(plateLine && plateLine.includes('\\p1') && plateLine.includes(' b '), plateLine);
    assert.equal(stats.hookBackgroundRendered, true);
    assert.equal(stats.hookAccentColorSingleFamily, true);
    // Captions carry no scale animation at all: colour is the only emphasis, so
    // the block can never be re-flowed while a word lights up (§31).
    const emphasis = { ...plan, subtitleEmphasis: [{ word: 'Who', startSec: .5, endSec: .9, strength: 'STRONG' }] };
    await new SubtitleRendererService().write(join(dir, 'h.ass'), emphasis, [w(.5, .9, 'Who')], [],
      1080, 1920, undefined, [], [], true, layout, { fps: 30 });
    assert(!require('node:fs').readFileSync(join(dir, 'h.ass'), 'utf8').includes('\\fscx'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('source-aware editorial layout uses empty footer space for video', () => {
  const base = PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS;
  const expanded = sourceAwarePlatformLayout(base, 1920, 1080);
  assert(expanded.videoViewport.height > base.videoViewport.height);
  assert(usableContentAreaRatio(expanded) > usableContentAreaRatio(base));
  assert(expanded.footerBounds.height >= 180);
  assert(expanded.subtitleZone.y >= expanded.videoViewport.y);
  assert(expanded.subtitleZone.y + expanded.subtitleZone.height <=
    expanded.videoViewport.y + expanded.videoViewport.height);
});
test('music is off by default, and its selection still works when re-enabled', () => {
  // Clips ship with dialogue audio only, so nothing is selected, mixed or faded
  // and the music QA checks report N/A rather than failing an edit.
  const savedRequired = process.env.EDIT_MUSIC_REQUIRED;
  const savedEnabled = process.env.EDIT_MUSIC_ENABLED;
  delete process.env.EDIT_MUSIC_REQUIRED;
  delete process.env.EDIT_MUSIC_ENABLED;
  try {
    assert.equal(musicPolicy().enabled, false);
    assert.equal(musicPolicy().required, false);
    process.env.EDIT_MUSIC_ENABLED = 'true';
    process.env.EDIT_MUSIC_REQUIRED = 'true';
    assert.equal(musicPolicy().enabled, true);
    assert.equal(musicPolicy().required, true);
  } finally {
    delete process.env.EDIT_MUSIC_ENABLED;
    delete process.env.EDIT_MUSIC_REQUIRED;
    if (savedRequired !== undefined) process.env.EDIT_MUSIC_REQUIRED = savedRequired;
    if (savedEnabled !== undefined) process.env.EDIT_MUSIC_ENABLED = savedEnabled;
  }
  const track = (id, moods, priority = 0) => ({ id, path: `${id}.m4a`, title: id, moods,
    license: 'GENERATED_IN_HOUSE', loudnessLufs: -20, priority });
  const tracks = [track('n1', ['CLEAN_NEUTRAL']), track('n2', ['CLEAN_NEUTRAL']),
    track('doc', ['SUBTLE_DOCUMENTARY']), track('licensed', ['SUBTLE_DOCUMENTARY'], 10)];
  const picks = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((seed) => selectMusicTrack(tracks, 'CLEAN_NEUTRAL', seed).id));
  assert.equal(picks.size, 2, 'different clips get different beds');
  assert.equal(selectMusicTrack(tracks, 'SUBTLE_DOCUMENTARY', 'x').id, 'licensed', 'approved tracks outrank generated');
  assert.equal(selectMusicTrack(tracks, 'DOCUMENTARY_TENSION', 'x').id, 'licensed', 'related mood fallback');
  assert.equal(selectMusicTrack(tracks, 'ENERGETIC_LIGHT', 'x').moods[0], 'CLEAN_NEUTRAL');
  assert.equal(selectMusicTrack([], 'CLEAN_NEUTRAL', 'x'), null);
  assert(INLINE_FALLBACK_TRACK.path.startsWith('lavfi:aevalsrc='));
  assert.equal(INLINE_FALLBACK_TRACK.license, 'GENERATED_IN_HOUSE');
  assert.equal(fallbackMusicMood('the new AI software startup'), 'MODERN_MINIMAL');
  assert.equal(fallbackMusicMood('the senate passed the policy'), 'SUBTLE_DOCUMENTARY');
});

// ---------------------------------------------------------------- gate / plan
test('quality gate separates applicability, baseline failures and degradations', () => {
  const pass = evaluateGate([check('hookRendered', { applicable: true, passed: true }),
    check('zoomVisible', { applicable: false, passed: false, severity: 'ENHANCEMENT' })]);
  assert.equal(pass.status, 'PASSED');
  assert.equal(pass.summary.zoomVisible, 'N/A');
  const degraded = evaluateGate([check('hookRendered', { applicable: true, passed: true }),
    check('zoomVisible', { applicable: true, passed: false, severity: 'ENHANCEMENT', repair: 'ZOOM_STRENGTHEN' })]);
  assert.equal(degraded.status, 'DEGRADED');
  assert.deepEqual(degraded.repairs, ['ZOOM_STRENGTHEN']);
  const failed = evaluateGate([check('hookRendered', { applicable: true, passed: false, repair: 'HOOK_REFIT' })]);
  assert.equal(failed.status, 'FAILED');
  assert.deepEqual(failed.failedChecks, ['hookRendered']);
});
test('viewer-visible framing failures are baseline failures, not shippable degradation', () => {
  const gate = evaluateGate([
    check('subjectSafetyTarget', { applicable: true, passed: false, repair: 'SUBJECT_REFRAME' }),
    check('informationReadable', { applicable: true, passed: false, repair: 'INFORMATION_FIT' })
  ]);
  assert.equal(gate.status, 'FAILED');
  assert.deepEqual(gate.failedChecks, ['subjectSafetyTarget', 'informationReadable']);
});
test('normal final-frame QA stays bounded and distributes samples across event groups', () => {
  const groups = Array.from({ length: 6 }, (_, group) =>
    Array.from({ length: 100 }, (_, index) => group * 1000 + index));
  const selected = boundedQaFrameNumbers(groups);
  assert.equal(selected.length, MAX_NORMAL_QA_FRAMES);
  assert.equal(MAX_NORMAL_QA_FRAMES, 24);
  assert(MAX_QA_DECODE_BATCH_FRAMES <= 8);
  for (let group = 0; group < groups.length; group++)
    assert(selected.some((value) => Math.floor(value / 1000) === group), `group ${group} sampled`);
});
test('bounded final-frame QA reserves baseline, peak, and settled frames for every zoom', () => {
  // Six timeline anchors, two grade/background samples and one caption sample.
  const mandatory = [0, 3, 30, 300, 588, 600, 90, 372, 140];
  const zoomTriplets = Array.from({ length: 5 }, (_, index) =>
    [60 + index * 90, 68 + index * 90, 82 + index * 90]);
  const selected = normalQaFrameNumbers(mandatory, zoomTriplets,
    [Array.from({ length: 100 }, (_, index) => index + 1)]);
  assert(selected.length <= MAX_NORMAL_QA_FRAMES);
  for (const frame of [...mandatory, ...zoomTriplets.flat()])
    assert(selected.includes(frame), `critical frame ${frame} retained`);
  assert(ZOOM_TUNING.maxZooms <= zoomTriplets.length,
    'planner must not create more zooms than bounded final QA can fully verify');
});
test('minor grading misses stay degraded without a second full render', () => {
  const minor = [check('gradingApplied', { applicable: true, passed: false,
    severity: 'ENHANCEMENT' })];
  assert.deepEqual(fullRenderRepairActions(minor,
    { selectedPreset: 'CLEAN_SOCIAL', gradingStrength: 1 }).actions, []);
  assert.equal(gradingRepairDecision(minor,
    { selectedPreset: 'CLEAN_SOCIAL', gradingStrength: 1 }).allowed, false);
  const severe = [check('highlightSafe', { applicable: true, passed: false,
    severity: 'ENHANCEMENT', repair: 'GRADE_SAFETY' })];
  assert.deepEqual(fullRenderRepairActions(severe,
    { selectedPreset: 'CLEAN_SOCIAL', gradingStrength: 1 }).actions, ['GRADE_SAFETY']);
  const baseline = [check('hookRendered', { applicable: true, passed: false,
    repair: 'HOOK_REFIT' })];
  assert.deepEqual(fullRenderRepairActions(baseline,
    { selectedPreset: 'NO_CHANGE', gradingStrength: 0 }).actions, ['HOOK_REFIT']);
});
test('grading strength is selected from source statistics before encode', () => {
  assert.equal(predictGradeStrength('NO_CHANGE', { brightness: .5, contrast: .2,
    saturation: .3, highlightClipping: 0 }).strength, 0);
  assert.equal(predictGradeStrength('CLEAN_SOCIAL', { brightness: .5, contrast: .2,
    saturation: .7, highlightClipping: .05 }).strength, .65);
});
test('final hook validation rejects generic clip and speaker meta-language', () => {
  assert.equal(hookMetaLanguageFree('Clip Stating That Nothing Is Real'), false);
  assert.equal(hookMetaLanguageFree('The speaker says that nothing is real'), false);
  assert.equal(hookMetaLanguageFree('Why does the speaker say nothing is real?'), false);
  assert.equal(hookMetaLanguageFree('Evidence from this video changes the result'), false);
  assert.equal(hookMetaLanguageFree('Why Nothing Around Us Is Truly Real'), true);
});

test('pre-render camera validation rejects structural hard-cut defects without encoding', () => {
  const shots = [{ start: 0 }, { start: 5 }];
  const good = { cropAt: (t) => t < 5 ? { x: 0, y: 0, w: 1, h: 1 } :
    { x: .2, y: 0, w: 1, h: 1 }, cameraMoves: [{ t: 5, durationSec: 0, snapped: true }],
  shotCutResetsCamera: true };
  assert.deepEqual(validatePreRenderCamera(good, shots, 10), []);
  const stale = { ...good, cameraMoves: [{ t: 5, durationSec: .2, snapped: true }] };
  assert(validatePreRenderCamera(stale, shots, 10).some((item) => item.reason === 'STALE_INTERPOLATION'));
  const invalid = { ...good, cropAt: (t) => t >= 5 ? { x: NaN, y: 0, w: 1, h: 1 } :
    { x: 0, y: 0, w: 1, h: 1 } };
  assert(validatePreRenderCamera(invalid, shots, 10).some((item) => item.reason === 'INVALID_CROP'));
  const movingAtEnd = { ...good, cropAt: (t) => ({ x: t / 10, y: 0, w: 1, h: 1 }),
    cameraMoves: [{ t: 5, durationSec: 0, snapped: true }] };
  assert(validatePreRenderCamera(movingAtEnd, shots, 10)
    .some((item) => item.reason === 'CAMERA_ACTIVE_IN_FINAL_FREEZE'));
});
test('pre-render structure classifies impossible zoom coverage before encoding', () => {
  const shots = [{ start: 0, end: 10, layout: 'FILL' }];
  const camera = { cropAt: () => ({ x: 0, y: 0, w: 1, h: 1 }), cameraMoves: [],
    shotCutResetsCamera: true };
  const failures = validatePreRenderStructure({ camera, shots, finalDuration: 10,
    zoomPlan: { events: [], rejected: [], candidates: [{ timestamp: 2 }],
      eligibleEmphasisCount: 1, requiredZoomCount: 2, zoomCoverageValid: false } });
  assert(failures.some((item) => item.reason === 'ZOOM_COVERAGE_IMPOSSIBLE'));
  assert.equal(classifyPreRenderFailures(failures), 'SKIP_BEFORE_RENDER');
});
test('subtitle retime is a pre-render overlay-only repair and preserves the base plan', () => {
  assert.deepEqual(repairInvalidation(['SUBTITLE_RETIME']),
    { base: false, overlay: true, audio: false, thumbnail: false });
  assert.equal(repairInvalidation(['ZOOM_STRENGTHEN']).base, true);
  const decision = subtitleRetimeDecision([.082, .079, .085, .081, .08]);
  assert(decision && decision.offsetSec > .07 && decision.offsetSec < .09);
  assert(decision.adjustedAverageMs < 5);
  assert.equal(subtitleRetimeDecision([.01, -.01, .015, -.015]), null,
    'jitter without a common offset must not trigger an expensive retry');
});
test('sponsor interruptions are trimmed only at safe edges and otherwise rejected', () => {
  const make = (text, start = 0) => text.split(' ').map((token, index) =>
    w(start + index * .4, start + index * .4 + .32, token));
  const leading = detectSponsorSegment({
    words: [...make('This video is sponsored by Acme. Use code SAVE today.', 0),
      ...make('Now the real explanation continues with enough useful detail for everyone.', 8),
      ...make('The conclusion resolves the original question clearly and completely.', 17)],
    candidateStart: 0, candidateEnd: 28, shotBoundaries: [7.8] });
  assert.equal(leading.detected, true);
  assert.equal(leading.trimmed, true);
  const internal = detectSponsorSegment({
    words: [...make('The useful explanation begins with evidence and context.', 0),
      ...make('This video is sponsored by Acme. Use code SAVE.', 12),
      ...make('Then the explanation resumes with the final result.', 22)],
    candidateStart: 0, candidateEnd: 32, shotBoundaries: [11.8, 21.8] });
  assert.equal(internal.rejected, true);
});
test('edit plan v2 schema, validator window and deterministic editorial', () => {
  for (const key of ['endingStrategy', 'musicMood', 'loopSuitable', 'preserveInformation', 'editorialIntent'])
    assert(EDIT_PLAN_SCHEMA.required.includes(key), key);
  const validator = new EditingPlanValidator();
  const words = [w(8, 8.4, 'Before'), w(10, 10.4, 'Inflation'), w(10.5, 11, 'doubled.'), w(31, 31.5, 'Finally.')];
  const plan = { ...fallbackEditPlan(10, 30, '9:16'), musicMood: 'NOT_A_MOOD', loopSuitable: true,
    endingStrategy: { payoffEndSec: 31.5, reason: 'payoff' },
    operations: [{ type: 'REMOVE_SILENCE', startSec: 8.5, endSec: 9.5, reason: 'window', scale: null,
      focusX: null, focusY: null, target: null, words: [] }] };
  const checked = validator.validate(plan, 10, 30, '9:16', words, 'Inflation doubled', 'Title', { start: 6, end: 34 });
  assert.equal(checked.fallback, false);
  assert.equal(checked.plan.endingStrategy.payoffEndSec, 31.5);
  assert.equal(checked.plan.musicMood, 'CLEAN_NEUTRAL');
  assert.equal(checked.plan.loopSuitable, true);
  assert.equal(checked.plan.operations.length, 1);
  const enriched = applyDeterministicEditorial(fallbackEditPlan(0, 30, '9:16'),
    [w(2, 2.3, 'We'), w(5, 5.5, '40%'), w(9, 9.8, 'unemployment'), w(20, 20.4, 'NASA')], 'we discuss');
  assert(enriched.subtitleEmphasis.some((item) => item.word === '40%' && item.strength === 'STRONG'));
  // Zoom is the only motion device now, so the fallback plans roughly one push
  // per 10 s on the strongest words rather than a single token move.
  const fallbackZooms = enriched.operations.filter((op) => op.type === 'ZOOM');
  assert(fallbackZooms.length >= 2 && fallbackZooms.length <= 4, `${fallbackZooms.length} zooms`);
  assert(fallbackZooms.every((op) => op.triggerText && op.reason));
  assert(fallbackZooms.every((op, index) => index === 0 ||
    op.startSec - fallbackZooms[index - 1].startSec >= 3));
  assert(enriched.subtitleEmphasis.every((item) => ['40%', 'unemployment', 'NASA'].includes(item.word)));
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n     ${error.stack.split('\n').slice(0, 3).join('\n     ')}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} edit-quality tests passed`);
  if (failed) process.exitCode = 1;
})();
