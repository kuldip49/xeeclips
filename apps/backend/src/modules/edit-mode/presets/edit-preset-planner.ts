// The content-aware preset planner.
//
// A preset states policy; this file decides what the specific source actually
// justifies and emits a typed command bundle. Every decision below is driven by
// evidence from the cached transcript and visual analysis:
//
//   * one visible speaker            -> single-speaker framing
//   * two faces that both matter     -> pair composition is preserved
//   * charts / slides / screenshots  -> readability wins, zoom is refused
//   * no semantic emphasis in words  -> no zoom, whatever the preset asks for
//   * no grounded headline available -> no hook, whatever the preset asks for
//   * source already vertical        -> no destructive reframe
//   * no product asset uploaded      -> no product overlay is invented
//
// There is no "podcast always gets five zooms" anywhere in here, by design.

import { deterministicHook } from '../../editing/hook-generator';
import type { EditElementType } from '@prisma/client';
import {
  emptyEstimatedChanges, type PresetCommand, type PresetElementCommand, type PresetPlan
} from './edit-preset-commands';
import type { PresetEvidence } from './edit-preset-evidence';
import {
  type EditPresetPolicy, type EditPresetRun, type EditProjectStyle, type PlannedZoomMoment
} from './edit-preset-policy';

/** Normalised overlay geometry on the 16:9 preview canvas (see docs/edit-mode-phase3.md). */
const LAYOUT = {
  hook: { x: 0.08, y: 0.07, width: 0.84, height: 0.15, fontSize: 56, zIndex: 40 },
  subtitle: { x: 0.1, y: 0.73, width: 0.8, height: 0.13, fontSize: 40, zIndex: 35 },
  keyPoint: { x: 0.1, y: 0.22, width: 0.8, height: 0.12, fontSize: 40, zIndex: 32 },
  cta: { x: 0.14, y: 0.6, width: 0.72, height: 0.12, fontSize: 44, zIndex: 34 },
  // A corner plate: large enough to read, placed clear of the centre subject.
  product: { x: 0.62, y: 0.55, width: 0.33, height: 0.33, zIndex: 25 }
} as const;

const HOOK_DURATION_SEC = 3;
const KEY_POINT_DURATION_SEC = 3.5;
const CTA_DURATION_SEC = 3;
const MIN_VIDEO_DURATION_SEC = 0.05;
/** Beyond this the caption track stops being an editable timeline and the
 * policy is persisted for the render phase instead. */
const MAX_SUBTITLE_ELEMENTS = Number(process.env.EDIT_MODE_MAX_SUBTITLE_ELEMENTS) || 400;

const CTA_PATTERN = /\b(link in bio|check (?:it |them )?out|try it (?:free|out|today)|sign up|learn more|get started|find out more|visit (?:our|the) (?:site|website|store)|download (?:it|the app)|order now|shop now|book a (?:demo|call))\b/iu;

export type PlannerElement = {
  id: string; type: EditElementType; track: number; position: number;
  startTime: number; duration: number; trimStart: number; trimEnd: number | null;
  assetId: string | null; properties: Record<string, unknown>;
};
export type PlannerAsset = { id: string; role: string; duration: number | null;
  width: number | null; height: number | null; originalName: string };

export type PlannerInput = {
  policy: EditPresetPolicy;
  evidence: PresetEvidence;
  elements: PlannerElement[];
  assets: PlannerAsset[];
  currentStyle: EditProjectStyle;
  previousRun: EditPresetRun | null;
  /** Grounded headline supplied by the LLM path; rejected upstream if unusable. */
  hookOverride?: { text: string; source: 'LLM_ASSISTED' } | null;
};

const round = (value: number) => Number(value.toFixed(3));

/** Source seconds -> timeline seconds across the current video track, so a
 * timeline the user already split or reordered still maps correctly. */
function sourceMapper(videos: PlannerElement[]) {
  const ranges = videos.map((element) => ({
    sourceStart: element.trimStart,
    sourceEnd: element.trimEnd ?? element.trimStart + element.duration,
    timelineStart: element.startTime
  }));
  return (sourceTime: number): number | null => {
    const range = ranges.find((item) => sourceTime >= item.sourceStart - 1e-6 &&
      sourceTime < item.sourceEnd);
    return range ? range.timelineStart + (sourceTime - range.sourceStart) : null;
  };
}

function resolveAspectRatio(policy: EditPresetPolicy, evidence: PresetEvidence,
  warnings: string[]): EditProjectStyle['aspectRatio'] {
  if (policy.aspectRatio === 'SOURCE') return 'SOURCE';
  if (policy.aspectRatio === '9:16' && evidence.sourceAspect <= 0.7) {
    warnings.push('The source is already vertically composed, so its framing is kept as-is.');
    return 'SOURCE';
  }
  if (policy.sourceAwareAspect && evidence.informationShotRatio >= 0.5) {
    warnings.push('Most of the source is charts, slides or screen content, so the source frame ' +
      'shape is kept to protect readability.');
    return 'SOURCE';
  }
  return policy.aspectRatio;
}

function resolveReframe(policy: EditPresetPolicy, evidence: PresetEvidence,
  aspectRatio: EditProjectStyle['aspectRatio'], warnings: string[]): EditProjectStyle['reframePolicy'] {
  if (policy.reframingPolicy === 'SOURCE') return 'SOURCE';
  if (aspectRatio === 'SOURCE' && evidence.informationShotRatio < 0.5) return 'SOURCE';
  if (evidence.informationShotRatio >= 0.4 || policy.informationRegionPolicy === 'PRESERVE') {
    return 'INFORMATION_PRESERVING';
  }
  if (policy.reframingPolicy === 'FACE_FOCUSED') {
    if (evidence.faceShotRatio < 0.25) {
      warnings.push('No reliably detected face covers enough of the source, so framing falls ' +
        'back to automatic composition instead of speaker framing.');
      return 'AUTO';
    }
    if (evidence.pairShotRatio >= 0.35) {
      warnings.push('Two people are framed together for much of the source, so pair composition ' +
        'is preserved rather than punching in on one speaker.');
    }
  }
  return policy.reframingPolicy;
}

function resolveZoom(policy: EditPresetPolicy, evidence: PresetEvidence,
  warnings: string[]): EditProjectStyle['zoomPolicy'] {
  if (policy.zoomPolicy === 'OFF') return 'OFF';
  if (!evidence.semanticPeaks.length) {
    warnings.push('Nothing in the transcript reads as an emphasis beat, so no zoom is planned.');
    return 'OFF';
  }
  if (policy.informationRegionPolicy === 'PRESERVE' && evidence.informationShotRatio >= 0.3) {
    warnings.push('Information-heavy shots must stay readable, so zoom is disabled.');
    return 'OFF';
  }
  const zoomable = evidence.shots.some((shot) => shot.zoomAllowed);
  if (evidence.shots.length && !zoomable) {
    warnings.push('No shot in the source is safe to punch in on, so no zoom is planned.');
    return 'OFF';
  }
  if (evidence.informationShotRatio >= 0.4 && policy.zoomPolicy !== 'SUBTLE') {
    warnings.push('Zoom is held to a subtle level because much of the source carries on-screen ' +
      'information.');
    return 'SUBTLE';
  }
  return policy.zoomPolicy;
}

function resolveSubtitles(policy: EditPresetPolicy, evidence: PresetEvidence,
  warnings: string[]): EditProjectStyle['subtitlePolicy'] {
  if (policy.subtitlePolicy === 'OFF') return 'OFF';
  if (!evidence.transcriptAvailable) {
    warnings.push('The cached transcript has no usable speech, so subtitles are left off.');
    return 'OFF';
  }
  if (policy.subtitlePolicy === 'ALWAYS') return 'ALWAYS';
  const spoken = evidence.words.reduce((total, word) => total + (word.end - word.start), 0);
  const density = evidence.sourceDurationSec > 0 ? spoken / evidence.sourceDurationSec : 0;
  if (evidence.phrases.length < 3 || density < 0.2) {
    warnings.push('The source carries little continuous speech, so subtitles are left off.');
    return 'OFF';
  }
  return 'ALWAYS';
}

function resolveHook(policy: EditPresetPolicy, evidence: PresetEvidence,
  override: PlannerInput['hookOverride'], warnings: string[]) {
  if (policy.hookPolicy === 'OFF') return { policy: 'OFF' as const, text: null };
  if (!evidence.transcriptAvailable) {
    warnings.push('No transcript is available to ground a headline, so no hook is added.');
    return { policy: 'OFF' as const, text: null };
  }
  if (override?.text) return { policy: policy.hookPolicy, text: override.text };
  const scored = deterministicHook({ transcript: evidence.transcriptText, title: '', synopsis: '' });
  if (!scored) {
    warnings.push('No headline could be grounded in the source words at an acceptable quality, ' +
      'so no hook is added.');
    return { policy: 'OFF' as const, text: null };
  }
  return { policy: policy.hookPolicy, text: scored.text };
}

function plannedZoomMoments(style: EditProjectStyle, evidence: PresetEvidence): PlannedZoomMoment[] {
  if (style.zoomPolicy === 'OFF') return [];
  const safe = (t: number) => {
    const shot = evidence.shots.find((item) => t >= item.sourceStart && t < item.sourceEnd);
    return !shot || (shot.zoomAllowed && !shot.informationMode);
  };
  return evidence.semanticPeaks.filter((peak) => safe(peak.timestamp)).map((peak) => ({
    startSec: round(peak.timestamp), endSec: round(Math.max(peak.endSec, peak.timestamp + 0.8)),
    reason: peak.reason, triggerText: peak.word,
    intensity: style.zoomPolicy as Exclude<EditProjectStyle['zoomPolicy'], 'OFF'>
  }));
}

/** Builds the full Phase 4 plan. Pure: it reads state and returns commands. */
export function planPreset(input: PlannerInput): PresetPlan {
  const { policy, evidence } = input;
  const warnings: string[] = [];
  const commands: PresetCommand[] = [];
  const plannedChanges: string[] = [];
  const affected = new Set<string>();
  const estimated = emptyEstimatedChanges();

  const videos = input.elements.filter((element) => element.type === 'VIDEO' && element.track === 0)
    .sort((left, right) => left.position - right.position);
  const previousPresetElements = input.elements.filter((element) =>
    element.properties?.origin === 'PRESET');
  const audioElements = input.elements.filter((element) => element.type === 'AUDIO');
  const imageAssets = input.assets.filter((asset) => asset.role === 'IMAGE');
  const logoAssets = input.assets.filter((asset) => asset.role === 'LOGO');
  const audioAssets = input.assets.filter((asset) => asset.role === 'AUDIO');

  // --- SOURCE_MANUAL: record the choice, transform nothing -------------------
  if (!policy.automatic) {
    const style: EditProjectStyle = { ...input.currentStyle, selectedPreset: policy.id };
    commands.push({ kind: 'SETTINGS', action: 'SET_PROJECT_STYLE',
      payload: { selectedPreset: policy.id },
      reason: 'Source / Manual records the selection and applies no transformation.' });
    return {
      presetId: policy.id, displayName: policy.displayName, description: policy.description,
      summary: 'Keeps the current timeline exactly as it is. No automatic changes are applied.',
      plannedChanges: ['No timeline or policy changes — your current edit is preserved.'],
      commands, affectedElements: [], warnings, estimatedChanges: estimated, style,
      plannedZoomMoments: [], evidence: evidenceSummary(evidence), generation: 'DETERMINISTIC'
    };
  }

  // --- Resolve the policy against the evidence -------------------------------
  const aspectRatio = resolveAspectRatio(policy, evidence, warnings);
  const reframePolicy = resolveReframe(policy, evidence, aspectRatio, warnings);
  const zoomPolicy = resolveZoom(policy, evidence, warnings);
  const subtitlePolicy = resolveSubtitles(policy, evidence, warnings);
  const hook = resolveHook(policy, evidence, input.hookOverride, warnings);
  const musicPolicy: EditProjectStyle['musicPolicy'] = audioElements.length
    ? 'KEEP_EXISTING' : policy.audioPolicy;
  const overlayPolicy: EditProjectStyle['overlayPolicy'] =
    policy.overlayPolicy === 'PRODUCT_FORWARD' && !imageAssets.length && !logoAssets.length
      ? 'MINIMAL' : policy.overlayPolicy;
  const textPolicy: EditProjectStyle['textPolicy'] = evidence.transcriptAvailable
    ? policy.textPolicy : 'OFF';
  const pacing: EditProjectStyle['pacing'] = evidence.transcriptAvailable ? policy.pacing : 'SOURCE';

  const style: EditProjectStyle = {
    selectedPreset: policy.id, aspectRatio, pacing, subtitlePolicy,
    hookPolicy: hook.policy, zoomPolicy, reframePolicy, musicPolicy,
    gradingPolicy: policy.gradingPolicy, textPolicy, overlayPolicy,
    informationRegionPolicy: policy.informationRegionPolicy, hookText: hook.text
  };

  // --- Replace only what a previous run of a preset created ------------------
  for (const element of previousPresetElements) {
    affected.add(element.id);
    estimated.removedPresetElements += 1;
    commands.push({ kind: 'ELEMENT', action: 'REMOVE_ELEMENT',
      payload: { elementId: element.id },
      reason: 'Replaces an element a previous preset run created.' });
  }
  if (previousPresetElements.length) {
    plannedChanges.push(`Replace ${previousPresetElements.length} element${
      previousPresetElements.length === 1 ? '' : 's'} from the previous preset run ` +
      '(your own edits are kept).');
  }

  // --- Source-aware lead-in / tail trim --------------------------------------
  let plannedVideos = videos.map((element) => ({ ...element }));
  if (pacing !== 'SOURCE' && videos.length === 1 && evidence.transcriptAvailable) {
    const element = videos[0];
    const sourceEnd = element.trimEnd ?? element.trimStart + element.duration;
    const previousTrim = input.previousRun?.trims.find((trim) => trim.elementId === element.id);
    const pristine = element.trimStart <= 1e-6 &&
      Math.abs(sourceEnd - evidence.sourceDurationSec) <= 0.05;
    const presetOwned = previousTrim &&
      Math.abs(previousTrim.trimStart - element.trimStart) <= 1e-3 &&
      Math.abs(previousTrim.trimEnd - sourceEnd) <= 1e-3;
    if (!pristine && !presetOwned) {
      warnings.push('The source clip was trimmed by hand, so the preset leaves its in and out ' +
        'points untouched.');
    } else {
      const tolerance = policy.leadInToleranceSec;
      const lead = evidence.leadInSilenceSec > tolerance
        ? Math.max(0, evidence.leadInSilenceSec - 0.15) : 0;
      const tail = evidence.tailSilenceSec > tolerance
        ? Math.max(0, evidence.tailSilenceSec - 0.25) : 0;
      const trimStart = round(lead);
      const trimEnd = round(evidence.sourceDurationSec - tail);
      // A shorter video track would push a surviving manual overlay out of
      // range, so the trim is skipped rather than invalidating the user's work.
      const keptOverlayEnd = input.elements
        .filter((item) => item.type !== 'VIDEO' && item.properties?.origin !== 'PRESET')
        .reduce((latest, item) => Math.max(latest, item.startTime + item.duration), 0);
      if (keptOverlayEnd > trimEnd - trimStart + 1e-6) {
        warnings.push('Your own overlays reach the end of the timeline, so the preset leaves the ' +
          'clip length alone.');
      } else if ((Math.abs(trimStart - element.trimStart) > 0.05 ||
        Math.abs(trimEnd - sourceEnd) > 0.05) &&
        trimEnd - trimStart >= Math.max(MIN_VIDEO_DURATION_SEC, 1)) {
        affected.add(element.id);
        estimated.trims += 1;
        commands.push({ kind: 'ELEMENT', action: 'TRIM_ELEMENT',
          payload: { elementId: element.id, trimStart, trimEnd },
          reason: 'Removes silent lead-in and tail so the clip opens and ends on speech.' });
        plannedChanges.push(`Trim ${round(trimStart - element.trimStart)}s of silent lead-in and ` +
          `${round(sourceEnd - trimEnd)}s of tail.`);
        plannedVideos = [{ ...element, trimStart, trimEnd, duration: trimEnd - trimStart,
          startTime: 0 }];
      }
    }
  }

  const toTimeline = sourceMapper(plannedVideos);
  const timelineDuration = plannedVideos.reduce((total, element) => total + element.duration, 0);
  const fits = (startTime: number, duration: number) =>
    startTime >= 0 && duration > 0 && startTime + duration <= timelineDuration + 1e-6;

  // --- Hook ------------------------------------------------------------------
  if (hook.text && timelineDuration > HOOK_DURATION_SEC * 1.2) {
    const duration = Math.min(HOOK_DURATION_SEC, timelineDuration * 0.4);
    estimated.overlays += 1;
    estimated.hookChanged = true;
    commands.push(...textElement('hook', hook.text, 0, duration, LAYOUT.hook, policy.id,
      'HOOK', 'Opens with a headline grounded in the source words.'));
    plannedChanges.push(`Add an opening headline: "${hook.text}".`);
  } else if (hook.text) {
    warnings.push('The timeline is too short to carry an opening headline, so none is added.');
  }

  // --- Subtitles -------------------------------------------------------------
  if (subtitlePolicy === 'ALWAYS' && evidence.wordTimingsAvailable) {
    const placed = evidence.phrases.flatMap((phrase) => {
      const startTime = toTimeline(phrase.start);
      if (startTime === null) return [];
      const duration = round(Math.max(0.3, phrase.end - phrase.start));
      const content = phrase.lines.join('\n');
      return fits(startTime, duration) ? [{ startTime: round(startTime), duration, content }] : [];
    });
    if (placed.length > MAX_SUBTITLE_ELEMENTS) {
      warnings.push(`The transcript yields ${placed.length} caption lines, which is more than an ` +
        'editable caption track should hold. The subtitle policy is saved for the render phase ' +
        'instead of placing them on the timeline.');
    } else {
      for (const item of placed) {
        estimated.subtitles += 1;
        commands.push({ kind: 'ELEMENT', action: 'ADD_SUBTITLE',
          payload: { content: item.content, startTime: item.startTime, duration: item.duration,
            ...LAYOUT.subtitle, origin: 'PRESET', presetId: policy.id, presetRole: 'SUBTITLE' },
          reason: 'Caption line taken verbatim from the cached transcript with its own timing.' });
      }
      if (placed.length) plannedChanges.push(`Add ${placed.length} caption lines from the ` +
        'transcript, word for word and on their own timings.');
    }
  } else if (subtitlePolicy === 'ALWAYS') {
    warnings.push('The cached transcript has no word timings, so the subtitle policy is saved ' +
      'for the render phase instead of placing caption elements.');
  }

  // --- Key-point callouts (ceiling, never a quota) ---------------------------
  if (textPolicy === 'KEY_POINTS' && policy.maxKeyPointTexts > 0) {
    const peaks = [...evidence.semanticPeaks]
      .sort((left, right) => right.combinedScore - left.combinedScore)
      .filter((peak) => peak.phrase.trim().split(/\s+/u).length >= 3)
      .slice(0, policy.maxKeyPointTexts)
      .sort((left, right) => left.timestamp - right.timestamp);
    let index = 0;
    for (const peak of peaks) {
      const startTime = toTimeline(peak.timestamp);
      const duration = Math.min(KEY_POINT_DURATION_SEC, timelineDuration);
      if (startTime === null || !fits(startTime, duration)) continue;
      estimated.overlays += 1;
      commands.push(...textElement(`key-point-${index}`, peak.phrase.trim().slice(0, 90),
        round(startTime), duration, LAYOUT.keyPoint, policy.id, 'KEY_POINT',
        `Highlights a ${peak.reason} the speaker states at ${round(peak.timestamp)}s.`));
      index += 1;
    }
    if (index) plannedChanges.push(`Add ${index} key-point callout${index === 1 ? '' : 's'} using ` +
      'the speaker’s own words.');
    else warnings.push('Nothing in the transcript stands out enough to caption as a key point, ' +
      'so no callouts are added.');
  }

  // --- Call to action, only when the source actually states one --------------
  if (textPolicy === 'CTA_ONLY') {
    const match = CTA_PATTERN.exec(evidence.transcriptText);
    if (match) {
      const duration = Math.min(CTA_DURATION_SEC, timelineDuration);
      const startTime = round(Math.max(0, timelineDuration - duration));
      if (fits(startTime, duration)) {
        estimated.overlays += 1;
        commands.push(...textElement('cta', titleCaseShort(match[0]), startTime, duration,
          LAYOUT.cta, policy.id, 'CTA',
          'Repeats a call to action the speaker states in the source.'));
        plannedChanges.push(`Add a closing call to action: "${titleCaseShort(match[0])}".`);
      }
    } else {
      warnings.push('The source never states a call to action, so none is invented.');
    }
  }

  // --- Product / logo overlays from assets the user uploaded -----------------
  if (overlayPolicy === 'PRODUCT_FORWARD') {
    const image = imageAssets[0];
    const logo = logoAssets[0];
    if (image) {
      estimated.overlays += 1;
      commands.push({ kind: 'ELEMENT', action: 'ADD_IMAGE', ref: 'product',
        payload: { assetId: image.id, origin: 'PRESET', presetId: policy.id,
          presetRole: 'PRODUCT' },
        reason: `Foregrounds the product image you uploaded (${image.originalName}).` });
      commands.push(...placeCommands('product', LAYOUT.product));
      commands.push({ kind: 'ELEMENT', action: 'SET_ELEMENT_Z_INDEX',
        payload: { ref: 'product', zIndex: LAYOUT.product.zIndex },
        reason: 'Keeps the product above the video and below captions.' });
      plannedChanges.push('Place your product image in a corner plate that keeps the subject visible.');
    }
    if (logo) {
      estimated.overlays += 1;
      commands.push({ kind: 'ELEMENT', action: 'ADD_LOGO', ref: 'brand-logo',
        payload: { assetId: logo.id, origin: 'PRESET', presetId: policy.id, presetRole: 'LOGO' },
        reason: `Adds the logo you uploaded (${logo.originalName}).` });
      plannedChanges.push('Add your uploaded logo to the corner.');
    }
  } else if (policy.overlayPolicy === 'PRODUCT_FORWARD') {
    warnings.push('No product image or logo has been uploaded, so no product overlay is created. ' +
      'Upload one and reapply the preset to place it.');
  }

  // --- Music: never fetched, never removed -----------------------------------
  if (musicPolicy === 'OPTIONAL_USER_ASSET' && audioAssets.length && !audioElements.length) {
    const asset = audioAssets[0];
    const duration = round(Math.min(asset.duration ?? timelineDuration, timelineDuration));
    if (duration > MIN_VIDEO_DURATION_SEC) {
      estimated.overlays += 1;
      commands.push({ kind: 'ELEMENT', action: 'ADD_AUDIO', ref: 'music',
        payload: { assetId: asset.id, origin: 'PRESET', presetId: policy.id, presetRole: 'MUSIC' },
        reason: `Places the music track you uploaded (${asset.originalName}).` });
      commands.push({ kind: 'ELEMENT', action: 'SET_AUDIO_VOLUME',
        payload: { ref: 'music', volume: policy.pacing === 'STRONG' ? 0.22 : 0.18 },
        reason: 'Keeps music under the speech so the words stay intelligible.' });
      commands.push({ kind: 'ELEMENT', action: 'SET_AUDIO_FADE',
        payload: { ref: 'music', fadeInSec: Math.min(1, duration / 4),
          fadeOutSec: Math.min(1.5, duration / 4) },
        reason: 'Fades the music in and out instead of cutting it.' });
      plannedChanges.push('Place your uploaded music under the edit at a speech-safe level.');
    }
  } else if (audioElements.length) {
    plannedChanges.push('Keep the music you already added, untouched.');
  }

  // --- Project style commands ------------------------------------------------
  const current = input.currentStyle;
  estimated.aspectRatioChanged = current.aspectRatio !== style.aspectRatio;
  estimated.subtitlePolicyChanged = current.subtitlePolicy !== style.subtitlePolicy;
  estimated.zoomPolicyChanged = current.zoomPolicy !== style.zoomPolicy;
  estimated.reframePolicyChanged = current.reframePolicy !== style.reframePolicy;
  estimated.hookChanged = estimated.hookChanged || current.hookText !== style.hookText;

  commands.push({ kind: 'SETTINGS', action: 'SET_PROJECT_STYLE',
    payload: { selectedPreset: style.selectedPreset, pacing: style.pacing,
      textPolicy: style.textPolicy, overlayPolicy: style.overlayPolicy,
      musicPolicy: style.musicPolicy, informationRegionPolicy: style.informationRegionPolicy },
    reason: `Records the ${policy.displayName} policy on the project.` });
  commands.push({ kind: 'SETTINGS', action: 'SET_ASPECT_RATIO',
    payload: { aspectRatio: style.aspectRatio },
    reason: style.aspectRatio === 'SOURCE' ? 'Keeps the source frame shape.'
      : `Targets ${style.aspectRatio} output.` });
  commands.push({ kind: 'SETTINGS', action: 'SET_SUBTITLE_POLICY',
    payload: { subtitlePolicy: style.subtitlePolicy },
    reason: 'Persists the subtitle policy for the render phase.' });
  commands.push({ kind: 'SETTINGS', action: 'SET_AUTO_REFRAME',
    payload: { reframePolicy: style.reframePolicy },
    reason: 'Persists how framing should follow the subject or the information.' });
  commands.push({ kind: 'SETTINGS', action: 'SET_AUTO_ZOOM',
    payload: { zoomPolicy: style.zoomPolicy },
    reason: 'Persists the semantic zoom strength the evidence supports.' });
  commands.push({ kind: 'SETTINGS', action: 'SET_COLOR_GRADE',
    payload: { gradingPolicy: style.gradingPolicy },
    reason: 'Records grading intent; Phase 4 does not render grading.' });
  commands.push({ kind: 'SETTINGS', action: 'SET_HOOK',
    payload: { hookPolicy: style.hookPolicy, hookText: style.hookText },
    reason: style.hookText ? 'Records the resolved headline.' : 'Records that no hook is used.' });

  if (style.aspectRatio !== current.aspectRatio) {
    plannedChanges.push(`Set the output shape to ${style.aspectRatio === 'SOURCE'
      ? 'match the source' : style.aspectRatio}.`);
  }
  if (style.reframePolicy !== 'SOURCE') {
    plannedChanges.push(`Set framing to ${style.reframePolicy.toLowerCase().replace(/_/gu, ' ')}.`);
  }
  plannedChanges.push(style.zoomPolicy === 'OFF' ? 'No zoom.'
    : `Plan ${style.zoomPolicy.toLowerCase()} zoom on ` +
      `${plannedZoomMoments(style, evidence).length} emphasis beat(s).`);

  const summary = buildSummary(policy, style, estimated);
  return {
    presetId: policy.id, displayName: policy.displayName, description: policy.description,
    summary, plannedChanges, commands, affectedElements: [...affected], warnings,
    estimatedChanges: estimated, style, plannedZoomMoments: plannedZoomMoments(style, evidence),
    evidence: evidenceSummary(evidence),
    generation: input.hookOverride ? 'LLM_ASSISTED' : 'DETERMINISTIC'
  };
}

export function plannedZoomMomentsFor(style: EditProjectStyle, evidence: PresetEvidence) {
  return plannedZoomMoments(style, evidence);
}

/**
 * Position and size an overlay using the existing validated commands.
 *
 * MOVE_ELEMENT clamps against the element's current size and RESIZE_ELEMENT
 * clamps against its current position, so a single move/resize pair lands
 * somewhere else whenever the default box is larger than the target one. Moving
 * into the target corner, resizing, then reasserting the position is exact for
 * any starting box, which is why the position is set twice.
 */
function placeCommands(ref: string, layout: { x: number; y: number; width: number;
  height: number }): PresetElementCommand[] {
  return [
    { kind: 'ELEMENT', action: 'MOVE_ELEMENT', payload: { ref, x: layout.x, y: layout.y },
      reason: 'Positions the overlay inside the safe area.' },
    { kind: 'ELEMENT', action: 'RESIZE_ELEMENT',
      payload: { ref, width: layout.width, height: layout.height },
      reason: 'Sizes the overlay for the canvas.' },
    { kind: 'ELEMENT', action: 'MOVE_ELEMENT', payload: { ref, x: layout.x, y: layout.y },
      reason: 'Reasserts the position now that the overlay has its final size.' }
  ];
}

/** A TEXT overlay built from the existing validated commands: add, then set its
 * content, timing, position, size and paint order. */
function textElement(ref: string, content: string, startTime: number, duration: number,
  layout: { x: number; y: number; width: number; height: number; fontSize: number; zIndex: number },
  presetId: string, presetRole: string, reason: string): PresetElementCommand[] {
  return [
    { kind: 'ELEMENT', action: 'ADD_TEXT', ref,
      payload: { origin: 'PRESET', presetId, presetRole }, reason },
    { kind: 'ELEMENT', action: 'UPDATE_TEXT',
      payload: { ref, content, fontSize: layout.fontSize, fontWeight: 800,
        fontFamily: 'Arial, sans-serif', textAlign: 'center', color: '#ffffff' },
      reason: 'Sets the overlay wording and typography.' },
    { kind: 'ELEMENT', action: 'SET_ELEMENT_TIMING',
      payload: { ref, startTime: round(startTime), duration: round(duration) },
      reason: 'Places the overlay on the timeline.' },
    ...placeCommands(ref, layout),
    { kind: 'ELEMENT', action: 'SET_ELEMENT_Z_INDEX', payload: { ref, zIndex: layout.zIndex },
      reason: 'Fixes the overlay paint order.' }
  ];
}

const titleCaseShort = (text: string) => text.trim().replace(/\s+/gu, ' ')
  .replace(/\b\p{Ll}/gu, (letter) => letter.toUpperCase()).slice(0, 60);

function buildSummary(policy: EditPresetPolicy, style: EditProjectStyle,
  estimated: ReturnType<typeof emptyEstimatedChanges>) {
  const parts: string[] = [];
  parts.push(style.aspectRatio === 'SOURCE' ? 'keeps the source frame'
    : `targets ${style.aspectRatio}`);
  if (estimated.trims) parts.push('tightens the opening and ending');
  if (estimated.subtitles) parts.push(`adds ${estimated.subtitles} transcript-exact caption lines`);
  else if (style.subtitlePolicy !== 'OFF') parts.push('enables subtitles for the render phase');
  if (style.hookText) parts.push('opens with a grounded headline');
  if (style.zoomPolicy !== 'OFF') parts.push(`plans ${style.zoomPolicy.toLowerCase()} semantic zoom`);
  if (estimated.overlays) parts.push(`places ${estimated.overlays} overlay element(s)`);
  return `${policy.displayName} ${parts.join(', ')}.`;
}

const evidenceSummary = (evidence: PresetEvidence): PresetPlan['evidence'] => ({
  sourceDurationSec: round(evidence.sourceDurationSec),
  transcriptAvailable: evidence.transcriptAvailable,
  analysisAvailable: evidence.analysisAvailable,
  analysisSource: evidence.analysisSource,
  shotCount: evidence.shots.length,
  informationShotRatio: evidence.informationShotRatio,
  faceShotRatio: evidence.faceShotRatio,
  pairShotRatio: evidence.pairShotRatio,
  semanticPeakCount: evidence.semanticPeaks.length,
  usedCachedTranscript: evidence.transcriptAvailable,
  usedCachedAnalysis: evidence.analysisAvailable
});
