// Real-video EDITED_CLIPS verification against the dockerized stack.
// Exports disposable edited clones of real clip candidates, prints the render
// QA / quality-gate telemetry, copies the MP4s to QA_OUTPUT_DIR for visual
// review, and removes every row/object it created (job telemetry is restored).
//   node scripts/verify-edited-clips.cjs [--limit 3] [--mode FALLBACK_ONLY|ONLINE] [--video <id>]
const { mkdirSync, copyFileSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const { StorageService } = require('../dist/modules/storage/storage.service');
const { ClipExportService } = require('../dist/modules/videos/clip-export.service');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

async function main() {
  const prisma = new PrismaClient();
  const storage = new StorageService();
  const limit = Number(arg('limit', '3'));
  const mode = arg('mode', 'FALLBACK_ONLY');
  const onlyVideo = arg('video', '');
  const outputDir = process.env.QA_OUTPUT_DIR || '/tmp/edited-clip-qa';
  mkdirSync(outputDir, { recursive: true });
  const videos = await prisma.video.findMany({
    where: { ...(onlyVideo ? { id: onlyVideo } : {}), clipCandidates: { some: {} },
      processingJobs: { some: { status: 'COMPLETED' } } },
    orderBy: { createdAt: 'desc' },
    include: { processingJobs: { orderBy: { createdAt: 'desc' }, take: 1 } }
  });
  // One candidate per distinct source title, strongest first.
  const seen = new Set();
  const picks = [];
  for (const video of videos) {
    const key = video.originalName.replace(/\s+/gu, ' ').toLowerCase();
    if (seen.has(key)) continue;
    const candidate = await prisma.clipCandidate.findFirst({ where: { videoId: video.id },
      orderBy: [{ viralPotentialScore: 'desc' }] });
    if (!candidate) continue;
    seen.add(key);
    picks.push({ video, candidate });
    if (picks.length >= limit) break;
  }
  const created = [];
  const summaries = [];
  try {
    for (const { video, candidate } of picks) {
      const job = video.processingJobs[0];
      const savedTelemetry = job.telemetry;
      // Force the edited path and the requested AI mode without touching the job row.
      const scoped = new Proxy(prisma, { get(target, property) {
        if (property !== 'processingJob') return target[property];
        return { ...target.processingJob,
          findFirst: async (query) => ({ ...(await target.processingJob.findFirst(query)),
            processingType: 'EDITED_CLIPS', outputAspectRatio: '9:16', aiMode: mode }),
          update: target.processingJob.update.bind(target.processingJob) };
      } });
      const exporter = new ClipExportService(scoped, storage);
      const rangeKey = `qa-${Date.now()}-${candidate.rangeKey}`;
      const started = Date.now();
      let clip = null;
      let error = null;
      try {
        clip = await exporter.export(video, { ...candidate, id: undefined, rangeKey });
        created.push(clip);
      } catch (caught) {
        error = caught;
      } finally {
        await prisma.processingJob.update({ where: { id: job.id },
          data: { telemetry: savedTelemetry ?? undefined } });
      }
      const name = `${summaries.length + 1}-${video.originalName.replace(/[^\w]+/gu, '-').slice(0, 40)}`;
      if (!clip) {
        summaries.push({ name, video: video.originalName, error: error?.message,
          report: error?.report ? { failedChecks: error.report.failedChecks, repairs: error.report.repairs,
            measurements: error.report.measurements } : null });
        continue;
      }
      const local = join(outputDir, `${name}.mp4`);
      await storage.downloadToFile(clip.bucket, clip.objectKey, local);
      writeContactSheet(local, join(outputDir, `${name}-sheet.png`), clip.duration);
      // The designed cover ships with the clip; pull it down for visual review too.
      if (clip.thumbnailObjectKey)
        await storage.downloadToFile(clip.bucket, clip.thumbnailObjectKey,
          join(outputDir, `${name}-cover.jpg`)).catch(() => undefined);
      const t = clip.editTelemetry;
      summaries.push({ name, video: video.originalName, exportMs: Date.now() - started,
        candidate: [candidate.startTime, candidate.endTime],
        edited: [t.editedStart, t.editedEnd], rawDuration: t.rawDuration, editedDuration: t.editedDuration,
        opening: t.openingReason, ending: t.endingReason, removedLeadIn: t.removedLeadIn,
        // Retention boundary decisions, so a reviewer can watch the clip and
        // compare what the editor claims it did with what they actually see.
        start: { strategy: t.openingStrategy, score: t.openingScore,
          from: t.originalStartSec, to: t.optimizedStartSec, adjust: t.startAdjustmentSec,
          strong: t.clipStartStrong, natural: t.clipStartNatural,
          contextComplete: t.clipStartContextComplete, preRollMs: t.firstWordPreRollMs,
          firstWordSafe: t.clipFirstWordNotClipped, preRollAvailableMs: t.firstWordPreRollAvailableMs,
          contextExpandedSec: t.contextExpandedSec,
          weakLeadRemovedSec: t.weakLeadRemovedSec, hookRealigned: t.hookRealignedToFinalBoundaries,
          candidates: (t.openingCandidates ?? []).map((c) => `${c.origin}@${c.sec}=${c.score}`) },
        end: { strategy: t.endingStrategy, score: t.endingScore,
          from: t.originalEndSec, to: t.optimizedEndSec, adjust: t.endAdjustmentSec,
          complete: t.clipEndComplete, natural: t.clipEndNatural,
          notContinuation: t.endNotContinuation, payoff: t.clipEndPayoffDelivered,
          payoffPreserved: t.payoffPreserved, newTopicTrimmed: t.newTopicTrimmed,
          noNewTopicLeak: t.clipEndNoNewTopicLeak, severity: t.endingDefectSeverity,
          deadAirMs: t.deadAirAtEndMs, repair: [t.endRepairAttempted, t.endRepairSucceeded],
          candidates: (t.endingCandidates ?? []).map((c) => `${c.origin}@${c.sec}=${c.score}`) },
        cuts: t.timelineCuts, source: t.editDecisionSource, llmCalls: t.editingPlanLlmCalls,
        analysis: `${t.analysisSource}/${t.analysisFrameCount}/${t.analysisMs}ms`,
        shots: t.shots.map((shot) => `${shot.start}-${shot.end}:${shot.shotClass}/${shot.layout}`),
        hook: { text: t.hookFinalText, lines: t.hookLines, font: t.hookFontSize, rendered: t.hookRendered,
          inside: t.hookInsideSafeZone, readable: t.hookReadable, contrast: t.hookContrastRatio,
          bounds: t.hookBounds, accents: t.hookAccentWords, notTooHigh: t.hookNotTooHigh,
          gapAboveVideo: t.hookGapAboveVideoPx },
        camera: { smooth: t.shotSwitchMotionSmooth, longestSwitchMoveSec: t.longestSwitchMoveSec,
          longPans: t.longPanCount },
        thumbnail: t.thumbnail ? { at: t.thumbnail.atSec, reason: t.thumbnail.reason,
          hook: t.thumbnail.thumbnailContainsHook, readable: t.thumbnail.thumbnailReadable,
          contrast: t.thumbnail.thumbnailHookContrastRatio,
          stored: clip.thumbnailObjectKey } : null,
        subtitles: { phrases: t.subtitlePhraseCount, coverage: t.subtitleCoverageRatio,
          sync: [t.subtitleSyncMeasurement, t.subtitleSyncSamples, t.subtitleSyncErrorAverageMs,
            t.subtitleSyncErrorP95Ms, t.subtitleResidualOffsetMs, t.subtitleOffsetMs],
          rendered: t.subtitleRenderedRatio, animation: t.subtitleAnimationVisibleRatio,
          highlight: t.highlightedWordVisibleRatio, highlighted: t.highlightedWordCount },
        subject: { safety: t.subjectSafetyRatio, visible: t.mainSubjectVisibleRatio,
          headroom: t.headroomSafeRatio, twoPerson: t.twoPersonPreservedRatio,
          information: t.informationPreservedRatio, switches: t.speakerSwitchCount,
          shotReframes: t.shotChangeReframeCount },
        zoom: { events: t.zoomEvents.map((event) => `${event.triggerText}@${event.startSec.toFixed(2)}x${event.peakScale}`),
          measured: t.zoomMeasurements, rejected: t.zoomRejections },
        background: { mode: t.backgroundMode, colors: t.backgroundColors, applied: t.backgroundApplied,
          matched: t.backgroundSourceMatched, distance: t.backgroundColorDistance,
          notGenericBlack: t.backgroundNotGenericBlack, smooth: t.backgroundTransitionSmooth,
          segments: (t.backgroundSegments ?? []).map((s) => `${s.start}-${s.end}:${s.colors.join('/')}:${s.temperature}`),
          transitions: t.backgroundTransitionMeasurements },
        hookStyle: { stable: t.hookPositionStable, drift: t.hookPositionDriftPx, safe: t.hookSafe,
          typography: t.hookTypographyReadable, lineHeight: t.hookLineHeightPx, settle: t.hookSettleSec },
        collision: { detected: t.subtitleCollisionDetected, adjusted: t.subtitlePositionAdjusted,
          plannedRatio: t.subtitleCollisionAreaRatio, measuredRatio: t.subtitleSourceGraphicCollisionRatio,
          samples: t.subtitleSourceGraphicSamples },
        grading: { preset: t.colorPreset, applied: t.gradingApplied, delta: t.grading?.measuredDelta,
          exposure: t.exposureAdjustment, contrast: t.contrastAdjustment, saturation: t.saturationAdjustment },
        music: t.music, loop: [t.loopSuitable, t.loopApplied, t.loopRejectedReason],
        quality: { status: t.editQualityStatus, failed: t.editQualityFailedChecks,
          degraded: t.editQualityDegradedChecks, attempts: t.editRenderAttempts, repairs: t.editRepairs },
        renderMs: t.renderMs, output: local });
    }
  } finally {
    for (const clip of created) {
      await storage.removeObject(clip.bucket, clip.objectKey).catch(() => undefined);
      if (clip.thumbnailObjectKey)
        await storage.removeObject(clip.bucket, clip.thumbnailObjectKey).catch(() => undefined);
      await prisma.generatedClip.delete({ where: { id: clip.id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
  console.log(JSON.stringify(summaries, null, 2));
  console.log(`Cleaned up ${created.length} disposable clip(s). Outputs kept in ${outputDir}.`);
  if (summaries.some((item) => item.error)) process.exitCode = 1;
}

function writeContactSheet(video, output, duration) {
  const times = [0.1, duration * .25, duration * .5, duration * .75, Math.max(0, duration - .3)];
  const inputs = times.flatMap((t) => ['-ss', t.toFixed(2), '-i', video]);
  const filter = times.map((_, i) => `[${i}:v]scale=270:480,setsar=1[f${i}]`).join(';') + ';' +
    times.map((_, i) => `[f${i}]`).join('') + `hstack=inputs=${times.length}[out]`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', filter,
    '-map', '[out]', '-frames:v', '1', output]);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
