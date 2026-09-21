// EditMode Phase 5 pre-render validation.
//
// Deterministically invalid state costs nothing to detect and a full encode to
// discover, so every predictable failure is caught here - before FFmpeg is
// invoked - and reported as a typed error the UI can explain.

import { EditExportError, type PlanAsset } from './edit-mode-render-plan';
import type { RenderPlan } from './edit-mode-render.types';

/** Containers/codecs EditMode is prepared to decode as an overlay or a bed. */
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const AUDIO_MIMES = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav',
  'audio/mp4', 'audio/x-m4a', 'audio/aac']);

export type ValidationContext = {
  assets: PlanAsset[];
  /** Source probe from the downloaded file, when the service has already read it. */
  sourceProbe?: { hasVideo: boolean; hasAudio: boolean; durationSec: number | null } | null;
};

const fail = (code: ConstructorParameters<typeof EditExportError>[0], message: string,
  detail?: Record<string, unknown>) => { throw new EditExportError(code, message, detail); };

export function validateRenderPlan(plan: RenderPlan, context: ValidationContext) {
  const assets = new Map(context.assets.map((asset) => [asset.id, asset]));
  const source = assets.get(plan.sourceAssetId);
  if (!source) fail('SOURCE_MISSING', 'The source asset is no longer attached to this project.');

  // --- Canvas ---------------------------------------------------------------
  const { width, height, fps } = plan.canvas;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 ||
    width % 2 !== 0 || height % 2 !== 0) {
    fail('INVALID_TIMELINE', 'The requested output dimensions are not a valid video canvas.',
      { width, height });
  }
  if (!(fps > 0) || fps > 120) {
    fail('INVALID_TIMELINE', 'The requested frame rate is out of range.', { fps });
  }

  // --- Video timeline -------------------------------------------------------
  if (!plan.videoSegments.length) {
    fail('INVALID_TIMELINE', 'The timeline has no playable video segment to export.');
  }
  const sourceDuration = source?.duration ?? null;
  let cursor = 0;
  for (const segment of plan.videoSegments) {
    if (!(segment.sourceEnd > segment.sourceStart)) {
      fail('INVALID_TIMELINE', 'A clip on the timeline has an empty or reversed trim range.',
        { elementId: segment.elementId });
    }
    if (segment.sourceStart < -1e-6) {
      fail('INVALID_TIMELINE', 'A clip on the timeline starts before the beginning of the source.',
        { elementId: segment.elementId });
    }
    if (sourceDuration != null && segment.sourceEnd > sourceDuration + 0.25) {
      fail('INVALID_TIMELINE', 'A clip on the timeline runs past the end of the source video.',
        { elementId: segment.elementId, sourceEnd: segment.sourceEnd, sourceDuration });
    }
    if (Math.abs(segment.timelineStart - cursor) > 1e-3) {
      fail('INVALID_TIMELINE', 'The timeline has a gap or overlap between clips.',
        { elementId: segment.elementId });
    }
    cursor = segment.timelineEnd;
  }
  if (Math.abs(cursor - plan.durationSec) > 1e-3 || !(plan.durationSec > 0)) {
    fail('INVALID_TIMELINE', 'The timeline duration does not match its clips.');
  }

  // --- Source media ---------------------------------------------------------
  if (context.sourceProbe && !context.sourceProbe.hasVideo) {
    fail('UNSUPPORTED_MEDIA', 'The source file has no decodable video stream.');
  }

  // --- Overlays -------------------------------------------------------------
  const timed = (item: { elementId: string; startSec: number; endSec: number }, label: string) => {
    if (!(item.endSec > item.startSec)) {
      fail('INVALID_TIMELINE', `A ${label} on the timeline has a non-positive duration.`,
        { elementId: item.elementId });
    }
    if (item.startSec < -1e-6) {
      fail('INVALID_TIMELINE', `A ${label} on the timeline starts before zero.`,
        { elementId: item.elementId });
    }
    if (item.startSec > plan.durationSec + 1e-3) {
      fail('INVALID_TIMELINE', `A ${label} starts after the end of the timeline.`,
        { elementId: item.elementId });
    }
  };

  for (const overlay of plan.visualOverlays) {
    timed(overlay, 'overlay');
    const asset = assets.get(overlay.assetId);
    if (!asset) {
      fail('ASSET_MISSING', 'An image overlay references an asset that is no longer available.',
        { elementId: overlay.elementId, assetId: overlay.assetId });
    } else if (!IMAGE_MIMES.has(asset.mimeType)) {
      fail('UNSUPPORTED_MEDIA', `An image overlay uses an unsupported file type (${asset.mimeType}).`,
        { elementId: overlay.elementId });
    }
    if (overlay.width < 2 || overlay.height < 2 ||
      overlay.x < 0 || overlay.y < 0 ||
      overlay.x + overlay.width > plan.canvas.width + 1 ||
      overlay.y + overlay.height > plan.canvas.height + 1) {
      fail('INVALID_TIMELINE', 'An image overlay is positioned outside the output frame.',
        { elementId: overlay.elementId });
    }
    if (!Number.isFinite(overlay.zIndex)) {
      fail('INVALID_TIMELINE', 'An overlay has an invalid layer order.',
        { elementId: overlay.elementId });
    }
  }

  for (const overlay of [...plan.textOverlays, ...plan.subtitles]) {
    timed(overlay, overlay.kind === 'SUBTITLE' ? 'caption' : 'text overlay');
    if (!overlay.content.trim()) {
      fail('INVALID_TIMELINE', 'A text element on the timeline has no content.',
        { elementId: overlay.elementId });
    }
    if (overlay.fontSizePx < 4 || !Number.isFinite(overlay.zIndex)) {
      fail('INVALID_TIMELINE', 'A text element has invalid typography or layer values.',
        { elementId: overlay.elementId });
    }
    if (overlay.x < 0 || overlay.y < 0 ||
      overlay.x > plan.canvas.width || overlay.y > plan.canvas.height) {
      fail('INVALID_TIMELINE', 'A text element is positioned outside the output frame.',
        { elementId: overlay.elementId });
    }
  }

  // --- Audio ----------------------------------------------------------------
  for (const track of plan.audioTracks) {
    timed(track, 'audio clip');
    const asset = track.assetId ? assets.get(track.assetId) : undefined;
    if (track.assetId && !asset) {
      fail('ASSET_MISSING', 'An audio clip references an asset that is no longer available.',
        { elementId: track.elementId, assetId: track.assetId });
    }
    if (asset && !AUDIO_MIMES.has(asset.mimeType)) {
      fail('UNSUPPORTED_MEDIA', `An audio clip uses an unsupported file type (${asset.mimeType}).`,
        { elementId: track.elementId });
    }
    if (!(track.trimEnd > track.trimStart)) {
      fail('INVALID_TIMELINE', 'An audio clip has an empty or reversed trim range.',
        { elementId: track.elementId });
    }
    if (track.fadeInSec + track.fadeOutSec > (track.endSec - track.startSec) + 1e-6) {
      fail('INVALID_TIMELINE', 'An audio clip fades for longer than it plays.',
        { elementId: track.elementId });
    }
    if (track.volume < 0 || track.volume > 1) {
      fail('INVALID_TIMELINE', 'An audio clip has an out-of-range volume.',
        { elementId: track.elementId });
    }
  }

  // --- Zoom -----------------------------------------------------------------
  for (const event of plan.zoomEvents) {
    if (!(event.endSec > event.peakEndSec && event.peakEndSec >= event.peakStartSec &&
      event.peakStartSec > event.startSec)) {
      fail('INVALID_TIMELINE', 'A semantic zoom has an invalid envelope.', { zoom: event.id });
    }
    if (event.endSec > plan.durationSec + 1e-3 || event.startSec < -1e-6) {
      fail('INVALID_TIMELINE', 'A semantic zoom falls outside the timeline.', { zoom: event.id });
    }
  }
  return true;
}
