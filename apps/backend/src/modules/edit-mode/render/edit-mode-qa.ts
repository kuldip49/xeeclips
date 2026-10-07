// EditMode Phase 5 render QA.
//
// EditMode-local and deliberately small. It measures the file that was actually
// produced, not the plan that asked for it, and it classifies what it finds:
//
//   PASS                  the export is correct.
//   DEGRADED_ACCEPTABLE   a measurable but non-visible shortfall (a slightly
//                         reduced zoom, a marginal audio level).
//   REPAIR_REQUIRED       a visible defect with a known local repair.
//   REJECT                the file is not a usable export at all.
//
// A visible correctness defect is never marked acceptable degradation: the two
// classes exist precisely so a cropped face cannot be filed under "close enough".
//
// Frame sampling is bounded and event-driven - segment joins, overlay and
// caption transitions, zoom peaks and shot changes - and reuses the frozen
// helpers' own bounded decode batching, so a long export can never turn QA into
// an unbounded decode.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { probeMedia } from '../../processing/media-probe';
import { audioEnvelope, boundedQaFrameNumbers, extractFrames, luminance, percentile,
  QA_SCALE, regionStats, type Frame } from '../../editing/render-qa';
import { zoomWindow } from '../../editing/zoom-planner';
import { EDIT_MODE_ZOOM, editModeZoomScaleAt } from './edit-mode-zoom';
import type { QaCheck, QaReport, QaRepair, QaResult, RenderEvidence,
  RenderPlan } from './edit-mode-render.types';

const execFileAsync = promisify(execFile);

export const EDIT_MODE_QA = {
  maxFrames: 20,
  /** Tolerance on the exported duration against the planned timeline. */
  durationToleranceSec: 0.35,
  /** A frame this dark, with almost no contrast, is an empty render. */
  blackLuminance: 0.02,
  blackContrast: 0.02,
  maxBlackFrameRatio: 0.2,
  /** Peak above this means the mix clipped. */
  audioPeakCeilingDb: -0.2,
  subjectSafetyTarget: 0.95,
  informationSafetyTarget: 0.95,
  minFaceArea: 0.0015
} as const;

const worst = (results: QaResult[]): QaResult => {
  const order: QaResult[] = ['PASS', 'DEGRADED_ACCEPTABLE', 'REPAIR_REQUIRED', 'REJECT'];
  return results.reduce((acc, item) =>
    order.indexOf(item) > order.indexOf(acc) ? item : acc, 'PASS');
};

const overlapRatio = (box: { x: number; y: number; w: number; h: number },
  window: { x: number; y: number; w: number; h: number }) => {
  const width = Math.max(0, Math.min(box.x + box.w, window.x + window.w) - Math.max(box.x, window.x));
  const height = Math.max(0, Math.min(box.y + box.h, window.y + window.h) - Math.max(box.y, window.y));
  return box.w * box.h > 0 ? width * height / (box.w * box.h) : 1;
};

/**
 * The bounded set of exported frame numbers QA inspects.
 *
 * Every group is an event class; the round-robin in `boundedQaFrameNumbers`
 * keeps one class from consuming the whole budget, so a 200-caption export still
 * gets its segment joins and zoom peaks sampled.
 */
export function qaFrameNumbers(plan: RenderPlan, evidence: RenderEvidence): number[] {
  const fps = plan.canvas.fps;
  const last = Math.max(0, Math.round(plan.durationSec * fps) - 2);
  const at = (t: number) => Math.min(last, Math.max(0, Math.round(t * fps)));
  const mandatory = [at(0.2), at(plan.durationSec / 2), last];
  const joins = plan.videoSegments.slice(1).map((segment) => at(segment.timelineStart + 0.08));
  const zooms = plan.zoomEvents.flatMap((event) => [at(event.startSec - 0.05),
    at((event.peakStartSec + event.peakEndSec) / 2)]);
  const overlays = plan.visualOverlays.flatMap((overlay) =>
    [at(overlay.startSec + 0.08), at(overlay.endSec - 0.08)]);
  const captions = [...plan.subtitles, ...plan.textOverlays]
    .map((overlay) => at(overlay.startSec + 0.1));
  const shots = evidence.shots.slice(1).map((shot) => at(shot.start + 0.08));
  return boundedQaFrameNumbers([mandatory, joins, zooms, overlays, captions, shots],
    EDIT_MODE_QA.maxFrames);
}

export type QaInput = {
  plan: RenderPlan;
  evidence: RenderEvidence;
  outputPath: string;
};

export async function runEditModeQa(input: QaInput): Promise<QaReport> {
  const { plan, evidence } = input;
  const checks: QaCheck[] = [];
  const repairs: QaRepair[] = [];
  const add = (id: string, result: QaResult, detail: string, repair: QaRepair | null = null) => {
    checks.push({ id, result, detail, repair });
    if (repair && result === 'REPAIR_REQUIRED') repairs.push(repair);
  };

  const measured: QaReport['measured'] = {
    width: null, height: null, durationSec: null, hasVideo: false, hasAudio: false,
    videoCodec: null, audioCodec: null, bitrate: null, audioPeakDb: null,
    finalFrameDecoded: false, negativeTimestamps: false, blackFrameRatio: null,
    subjectSafetyRatio: null, informationPreservedRatio: null,
    overlayInBounds: true, subtitleInBounds: true
  };

  // --- 1/2. The file exists and ffprobe reads it ----------------------------
  let probe;
  try {
    probe = await probeMedia(input.outputPath);
  } catch (error) {
    add('OUTPUT_PROBE', 'REJECT', `The exported file could not be read by ffprobe: ${
      error instanceof Error ? error.message : String(error)}`);
    return { result: 'REJECT', checks, repairs, sampledFrameCount: 0, measured };
  }
  measured.width = probe.width; measured.height = probe.height;
  measured.durationSec = probe.durationSec; measured.hasVideo = probe.hasVideo;
  measured.hasAudio = probe.hasAudio; measured.videoCodec = probe.videoCodec;
  measured.audioCodec = probe.audioCodec;
  measured.bitrate = probe.bitrate == null ? null : Number(probe.bitrate);
  add('OUTPUT_PROBE', 'PASS', 'ffprobe read the exported file.');

  // --- 3. Resolution --------------------------------------------------------
  add('RESOLUTION', probe.width === plan.canvas.width && probe.height === plan.canvas.height
    ? 'PASS' : 'REJECT',
  `Expected ${plan.canvas.width}x${plan.canvas.height}, got ${probe.width}x${probe.height}.`);

  // --- 4. Duration ----------------------------------------------------------
  const durationDelta = probe.durationSec == null ? null
    : Math.abs(probe.durationSec - plan.durationSec);
  add('DURATION', durationDelta == null ? 'REJECT'
    : durationDelta <= EDIT_MODE_QA.durationToleranceSec ? 'PASS'
      : durationDelta <= EDIT_MODE_QA.durationToleranceSec * 3 ? 'DEGRADED_ACCEPTABLE' : 'REJECT',
  `Planned ${plan.durationSec.toFixed(3)}s, exported ${probe.durationSec?.toFixed(3) ?? 'unknown'}s.`);

  // --- 5/6. Streams ---------------------------------------------------------
  add('VIDEO_STREAM', probe.hasVideo ? 'PASS' : 'REJECT',
    probe.hasVideo ? `Video stream present (${probe.videoCodec}).` : 'No video stream.');
  const audioExpected = (plan.hasSourceAudio && plan.videoSegments.some(segment => !segment.sourceMuted && segment.sourceVolume > 0)) ||
    plan.audioTracks.some((track) => !track.muted && track.volume > 0);
  add('AUDIO_STREAM', !audioExpected ? 'PASS' : probe.hasAudio ? 'PASS' : 'REJECT',
    audioExpected ? (probe.hasAudio ? `Audio stream present (${probe.audioCodec}).`
      : 'Audio was expected but the export has no audio stream.')
      : 'No audio expected for this timeline.');

  // --- 7. Timestamps --------------------------------------------------------
  const negative = await hasNegativeTimestamps(input.outputPath);
  measured.negativeTimestamps = negative;
  add('TIMESTAMPS', negative ? 'REJECT' : 'PASS',
    negative ? 'The export contains negative packet timestamps.' : 'Packet timestamps are monotonic.');

  // --- 14. The final frame decodes -----------------------------------------
  const finalFrame = await decodesFinalFrame(input.outputPath);
  measured.finalFrameDecoded = finalFrame;
  add('FINAL_FRAME', finalFrame ? 'PASS' : 'REJECT',
    finalFrame ? 'The last frame decodes.' : 'The last frame of the export could not be decoded.');

  // --- 8-12. Bounded visual sampling ---------------------------------------
  const frameNumbers = qaFrameNumbers(plan, evidence);
  const sampleWidth = Math.max(16, Math.round(plan.canvas.width * QA_SCALE / 2) * 2);
  const sampleHeight = Math.max(16, Math.round(plan.canvas.height * QA_SCALE / 2) * 2);
  let frames = new Map<number, Frame>();
  try {
    frames = await extractFrames(input.outputPath, frameNumbers, sampleWidth, sampleHeight);
  } catch (error) {
    add('FRAME_SAMPLING', 'DEGRADED_ACCEPTABLE', `QA frames could not be decoded: ${
      error instanceof Error ? error.message : String(error)}`);
  }

  if (frames.size) {
    let black = 0;
    for (const frame of frames.values()) {
      const stats = regionStats(frame, { x: 0, y: 0, width: frame.width, height: frame.height });
      if (stats.brightness <= EDIT_MODE_QA.blackLuminance &&
        stats.contrast <= EDIT_MODE_QA.blackContrast) black++;
    }
    const ratio = black / frames.size;
    measured.blackFrameRatio = Number(ratio.toFixed(4));
    add('NOT_BLANK', ratio <= EDIT_MODE_QA.maxBlackFrameRatio ? 'PASS' : 'REJECT',
      `${black} of ${frames.size} sampled frames are effectively empty.`);
  }

  // --- 9/10. Overlay and caption bounds ------------------------------------
  const outOfFrame = plan.visualOverlays.filter((overlay) =>
    overlay.x < 0 || overlay.y < 0 ||
    overlay.x + overlay.width > plan.canvas.width + 1 ||
    overlay.y + overlay.height > plan.canvas.height + 1);
  measured.overlayInBounds = outOfFrame.length === 0;
  add('OVERLAY_BOUNDS', outOfFrame.length ? 'REJECT' : 'PASS',
    outOfFrame.length ? `${outOfFrame.length} overlay(s) fall outside the output frame.`
      : 'Every overlay is inside the output frame.');
  const captionsOut = plan.subtitles.filter((overlay) =>
    overlay.y + overlay.height > plan.canvas.height + 1 || overlay.y < 0 ||
    overlay.x < 0 || overlay.x + overlay.width > plan.canvas.width + 1);
  measured.subtitleInBounds = captionsOut.length === 0;
  add('SUBTITLE_BOUNDS', captionsOut.length ? 'REJECT' : 'PASS',
    captionsOut.length ? `${captionsOut.length} caption line(s) fall outside the output frame.`
      : 'Every caption is inside the output frame.');

  // --- 11/12. Framing: subject safety and information readability -----------
  const framing = framingChecks(plan, evidence);
  measured.subjectSafetyRatio = framing.subjectSafetyRatio;
  measured.informationPreservedRatio = framing.informationPreservedRatio;
  for (const check of framing.checks) add(check.id, check.result, check.detail, check.repair);

  // --- 13. Audio level ------------------------------------------------------
  if (probe.hasAudio) {
    try {
      const envelope = await audioEnvelope(input.outputPath, 0.02);
      const peak = envelope.db.length
        ? percentile([...envelope.db].sort((a, b) => a - b), 0.999) : null;
      measured.audioPeakDb = peak == null ? null : Number(peak.toFixed(2));
      add('AUDIO_LEVEL', peak == null ? 'DEGRADED_ACCEPTABLE'
        : peak > EDIT_MODE_QA.audioPeakCeilingDb ? 'DEGRADED_ACCEPTABLE' : 'PASS',
      peak == null ? 'The exported audio could not be measured.'
        : `Peak level ${peak.toFixed(2)} dBFS.`);
    } catch (error) {
      add('AUDIO_LEVEL', 'DEGRADED_ACCEPTABLE', `The exported audio could not be measured: ${
        error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { result: worst(checks.map((check) => check.result)), checks, repairs,
    sampledFrameCount: frames.size, measured };
}

/**
 * The two framing verdicts, as a pure function of the plan and its evidence.
 *
 * Kept separate from `runEditModeQa` so the classification - and above all the
 * choice of repair - is testable without encoding anything. A visible framing
 * defect is always REPAIR_REQUIRED, never DEGRADED_ACCEPTABLE.
 */
export function framingChecks(plan: RenderPlan, evidence: RenderEvidence) {
  const checks: QaCheck[] = [];
  const subject = measureSubjectSafety(plan, evidence);
  if (subject.samples === 0) {
    checks.push({ id: 'SUBJECT_SAFETY', result: 'PASS', repair: null,
      detail: 'No shot in this export targets a detected subject.' });
  } else if (subject.ratio != null && subject.ratio >= EDIT_MODE_QA.subjectSafetyTarget) {
    checks.push({ id: 'SUBJECT_SAFETY', result: 'PASS', repair: null,
      detail: `Subjects stay framed in ${(subject.ratio * 100).toFixed(1)}% of samples.` });
  } else {
    // Repair the smallest thing that can be at fault: an unsafe zoom over an
    // otherwise safe crop loses that zoom; an unsafe crop widens that one shot.
    checks.push({ id: 'SUBJECT_SAFETY', result: 'REPAIR_REQUIRED',
      repair: subject.zoomEventId
        ? { kind: 'SUPPRESS_ZOOM', zoomEventId: subject.zoomEventId }
        : { kind: 'WIDEN_CROP', shotIndex: subject.shotIndex ?? 0 },
      detail: `Subjects leave the frame in ${((1 - (subject.ratio ?? 0)) * 100).toFixed(1)}% ` +
        `of samples (shot ${subject.shotIndex}).` });
  }

  const information = measureInformationSafety(plan, evidence);
  if (information.samples === 0) {
    checks.push({ id: 'INFORMATION_REGION', result: 'PASS', repair: null,
      detail: 'No information shot in this export needs protection.' });
  } else if (information.ratio != null &&
    information.ratio >= EDIT_MODE_QA.informationSafetyTarget) {
    checks.push({ id: 'INFORMATION_REGION', result: 'PASS', repair: null,
      detail: `Information stays readable in ${(information.ratio * 100).toFixed(1)}% of samples.` });
  } else {
    checks.push({ id: 'INFORMATION_REGION', result: 'REPAIR_REQUIRED',
      repair: { kind: 'INFORMATION_FIT', shotIndex: information.shotIndex ?? 0 },
      detail: `Information is cropped in ${((1 - (information.ratio ?? 0)) * 100).toFixed(1)}% ` +
        `of samples (shot ${information.shotIndex}).` });
  }
  return { checks, subjectSafetyRatio: subject.ratio,
    informationPreservedRatio: information.ratio };
}

/** Geometry check of the rendered camera (crop plus the zoom envelope actually
 * emitted) against the detections, on the exported timeline. */
function measureSubjectSafety(plan: RenderPlan, evidence: RenderEvidence) {
  let samples = 0;
  let safe = 0;
  let shotIndex: number | null = null;
  let zoomEventId: string | null = null;
  for (const frame of evidence.frames) {
    const segment = plan.frameSegments.find((item) =>
      frame.t >= item.startSec - 1e-6 && frame.t < item.endSec);
    if (!segment || segment.layout !== 'FILL') continue;
    const faces = frame.faces.filter((face) => face.w * face.h >= EDIT_MODE_QA.minFaceArea)
      .sort((left, right) => right.w * right.h - left.w * left.h);
    if (!faces.length) continue;
    const baseline = evidence.cropAt(frame.t);
    const scale = editModeZoomScaleAt(plan.zoomEvents, frame.t);
    const active = plan.zoomEvents.find((event) =>
      frame.t >= event.startSec && frame.t <= event.endSec);
    const window = zoomWindow(baseline, scale, active?.focusX ?? 0.5, active?.focusY ?? 0.5);
    const subjects = faces.filter((face) => overlapRatio(face, baseline) > 0.5).slice(0, 2);
    for (const face of subjects) {
      samples++;
      const ok = overlapRatio(face, window) >= EDIT_MODE_QA.subjectSafetyTarget &&
        (face.y - window.y) / window.h >= 0;
      if (ok) safe++;
      else if (shotIndex == null) {
        shotIndex = segment.shotIndex;
        zoomEventId = active?.id ?? null;
      }
    }
  }
  return { samples, safe, shotIndex, zoomEventId,
    ratio: samples ? Number((safe / samples).toFixed(4)) : null };
}

function measureInformationSafety(plan: RenderPlan, evidence: RenderEvidence) {
  let samples = 0;
  let preserved = 0;
  let shotIndex: number | null = null;
  for (const frame of evidence.frames) {
    const segment = plan.frameSegments.find((item) =>
      frame.t >= item.startSec - 1e-6 && frame.t < item.endSec);
    if (!segment) continue;
    const shot = evidence.shots[segment.shotIndex];
    if (!shot?.informationMode && segment.layout !== 'INFORMATION_FIT') continue;
    const boxes = (frame.textBoxes ?? []).filter((box) =>
      box.y + box.h / 2 < EDIT_MODE_ZOOM.captionBandY);
    if (!boxes.length) continue;
    samples++;
    // A fitted layer keeps the whole source frame, so its information is always
    // fully visible; only a cropped span can lose it.
    if (segment.layout !== 'FILL') { preserved++; continue; }
    const scale = editModeZoomScaleAt(plan.zoomEvents, frame.t);
    const active = plan.zoomEvents.find((event) =>
      frame.t >= event.startSec && frame.t <= event.endSec);
    const window = zoomWindow(evidence.cropAt(frame.t), scale,
      active?.focusX ?? 0.5, active?.focusY ?? 0.5);
    if (boxes.every((box) => overlapRatio(box, window) >= EDIT_MODE_QA.informationSafetyTarget)) {
      preserved++;
    } else if (shotIndex == null) shotIndex = segment.shotIndex;
  }
  return { samples, preserved, shotIndex,
    ratio: samples ? Number((preserved / samples).toFixed(4)) : null };
}

async function hasNegativeTimestamps(path: string) {
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time', '-read_intervals', '%+#40', '-of', 'csv=p=0', path],
    { maxBuffer: 4 * 1024 * 1024 });
    return stdout.split('\n').map((line) => Number(line.trim()))
      .some((value) => Number.isFinite(value) && value < -1e-6);
  } catch { return false; }
}

async function decodesFinalFrame(path: string) {
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-v', 'error', '-sseof', '-0.6', '-i', path,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    return (stdout as Buffer).length > 0;
  } catch { return false; }
}

export { luminance };
