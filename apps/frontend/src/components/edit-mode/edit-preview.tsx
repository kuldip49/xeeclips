'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Pause, Play, RotateCw } from 'lucide-react';
import type { EditAspectRatio, EditAsset, EditElement,
  VisualElementProperties } from '@/lib/edit-mode-types';
import { editAssetPlaybackUrl, editSourcePosterUrl } from '@/lib/edit-mode-api';
import { elementsAtTime, resolvePreviewPosition, timelineDuration,
  videoTrack } from '@/lib/edit-mode-timeline';
import { previewGain, readAudioState, readSourceAudio } from '@/lib/edit-mode-audio';
import { colorOverlayLayers, colorPreviewStyle,
  readColorAdjustments } from '@/lib/edit-mode-color';
import { readCropInsets, transformStyle } from '@/lib/edit-mode-transform';
import { sourceCropToViewport, type CropAspectPreset,
  type CropRect } from '@/lib/edit-mode-crop';
import { clampBox, fitCanvas, resizeBox, snapBox, snapRotation, type ResizeCorner,
  type SnapGuide } from '@/lib/edit-mode-snap';
import { EditPreviewText } from './edit-preview-text';
import { EditCropOverlay } from './edit-crop-overlay';

const clock = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${Math.floor(Math.max(0, seconds) % 60).toString().padStart(2, '0')}`;
export type EditPreviewHandle = { toggle: () => void; pause: () => void };
export type CropEditorState = { rect: CropRect; preset: CropAspectPreset; sourceAspect: number;
  sourceWidth: number; sourceHeight: number; sourceAssetId?: string;
  onChange: (rect: CropRect) => void };

/** What a pointer gesture on a selected element is doing. */
export type PreviewGesture = 'move' | 'resize' | 'rotate';

/**
 * One music clip, played against the edited timeline.
 *
 * Volume, mute and the two fades are approximated here from the same canonical
 * state the export reads. Two things the preview deliberately does NOT claim:
 * a gain above 100% (an HTMLMediaElement clamps at 1, so a boosted track plays
 * at 100% here and exports at its real level), and ducking (the render builds a
 * per-frame automation curve from the transcript; reproducing it in the browser
 * would cost a Web Audio graph per clip for a difference the Audio panel can
 * simply state). Both are said plainly in the Audio panel rather than papered
 * over here.
 */
function AudioLayer({ element, playing, timelineTime }: { element: EditElement; playing: boolean; timelineTime: number }) {
  const ref = useRef<HTMLAudioElement>(null);
  const properties = element.properties;
  const state = readAudioState(properties);
  const offset = Math.max(0, timelineTime - element.startTime);
  let gain = state.volume;
  if (state.fadeInSec > 0) gain *= Math.min(1, offset / state.fadeInSec);
  if (state.fadeOutSec > 0) gain *= Math.min(1, (element.duration - offset) / state.fadeOutSec);
  const level = previewGain(gain);
  useEffect(() => {
    const audio = ref.current; if (!audio) return;
    const sourceTime = element.trimStart + offset;
    if (Math.abs(audio.currentTime - sourceTime) > 0.2) audio.currentTime = sourceTime;
    audio.volume = level; audio.muted = state.muted;
    if (playing) void audio.play().catch(() => undefined); else audio.pause();
  }, [element.trimStart, level, offset, playing, state.muted]);
  return <audio ref={ref} src={element.assetId ? editAssetPlaybackUrl(element.assetId) : undefined} preload='metadata' />;
}

/** The preview canvas is the export canvas: normalized element boxes only agree
 * with the rendered frame when both are the same shape. */
const canvasAspect = (aspectRatio: EditAspectRatio | undefined, source?: EditAsset) => {
  if (aspectRatio === '9:16') return 9 / 16;
  if (aspectRatio === '1:1') return 1;
  if (aspectRatio === '16:9') return 16 / 9;
  return source?.width && source?.height ? source.width / source.height : 16 / 9;
};

const CORNERS: Array<{ corner: ResizeCorner; className: string; cursor: string }> = [
  { corner: 'nw', className: '-left-1.5 -top-1.5', cursor: 'nwse-resize' },
  { corner: 'ne', className: '-right-1.5 -top-1.5', cursor: 'nesw-resize' },
  { corner: 'sw', className: '-bottom-1.5 -left-1.5', cursor: 'nesw-resize' },
  { corner: 'se', className: '-bottom-1.5 -right-1.5', cursor: 'nwse-resize' }
];

/**
 * Step 5 framing parity (approximate): the renderer FILLS the canvas unless the
 * segment says FIT, the policy is SOURCE, or the canvas keeps the source shape.
 * A tracked camera (AUTO/FACE_FOCUSED) is previewed as a centred fill - the
 * export may pan to follow a face; the preview does not.
 */
const previewFill = (aspectRatio: EditAspectRatio | undefined, reframePolicy: string | undefined,
  properties: Record<string, unknown> | undefined) => {
  const layout = properties?.frameLayout;
  if (layout === 'FIT') return false;
  if (layout === 'FILL') return true;
  if (!aspectRatio || aspectRatio === 'SOURCE') return false;
  return reframePolicy !== 'SOURCE';
};

export const EditPreview = forwardRef<EditPreviewHandle, { source?: EditAsset; assets: EditAsset[];
  aspectRatio?: EditAspectRatio;
  /** Project reframe policy; decides FIT vs FILL where a segment has no override. */
  reframePolicy?: string;
  /** What the renderer draws behind a FITTED frame (settings.fitBackground; BLUR by default). */
  fitBackground?: string;
  resolvedVisualLayout?: { editingProfile?: string; videoFrame?: {
    x: number; y: number; width: number; height: number; mode: string };
    cameraPath?: Array<{ t: number; x: number; y: number; w: number; h: number }> };
  elements: EditElement[]; selectedElementId: string | null; currentPlayheadSec: number;
  onPlayheadChange: (seconds: number) => void; onSelect: (id: string) => void;
  onPreviewElements: (elements: EditElement[]) => void;
  onCommitTransform: (kind: PreviewGesture, element: EditElement, before: EditElement[]) => void;
  cropEditor?: CropEditorState | null;
}>(({ source, assets, aspectRatio, reframePolicy, fitBackground, resolvedVisualLayout, elements, selectedElementId, currentPlayheadSec, onPlayheadChange, onSelect,
  onPreviewElements, onCommitTransform, cropEditor }, forwardedRef) => {
  const video = useRef<HTMLVideoElement>(null); const canvas = useRef<HTMLDivElement>(null);
  const activeId = useRef<string | null>(null); const syncing = useRef(false);
  const frame = useRef<HTMLDivElement>(null);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const [mediaState, setMediaState] = useState<'LOADING' | 'READY' | 'FAILED'>('LOADING');
  const [mediaAttempt, setMediaAttempt] = useState(0);
  const [playing, setPlaying] = useState(false); const duration = timelineDuration(elements);
  // Alignment guides are pure gesture feedback: they exist only while a pointer
  // is down and never touch canonical state.
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const mapping = resolvePreviewPosition(elements, currentPlayheadSec);
  const active = elementsAtTime(elements, currentPlayheadSec);
  const compositionCanvasSize = fitCanvas(frameSize, canvasAspect(aspectRatio, source));
  // View zoom (never stored, never exported). A card layout such as Automatic 2 puts the video
  // in a window with wide empty bands above and below; "Focus" scales the view so the hook and
  // that window fill the stage, "Fit" shows the whole export frame. Same canvas, just larger:
  // text, overlays and drag gestures all scale with it because they are canvas-relative.
  const cardFrame = resolvedVisualLayout?.videoFrame?.mode === 'CARD' ? resolvedVisualLayout.videoFrame : null;
  const focusRegion = cardFrame && cardFrame.height < 0.7
    ? { top: Math.max(0, cardFrame.y - 0.09), bottom: Math.min(1, cardFrame.y + cardFrame.height + 0.03) } : null;
  const [viewMode, setViewMode] = useState<'FIT' | 'FOCUS'>('FOCUS');
  const focusing = !cropEditor && viewMode === 'FOCUS' && !!focusRegion && compositionCanvasSize.height > 0;
  const viewScale = focusing && focusRegion ? Math.max(1, Math.min(
    frameSize.height / ((focusRegion.bottom - focusRegion.top) * compositionCanvasSize.height),
    frameSize.width / compositionCanvasSize.width)) : 1;
  // Crop owns the complete preview viewport. The normal export-shaped canvas is
  // restored after Done/Cancel; only normalized source crop survives.
  const canvasSize = cropEditor ? frameSize : { width: Math.floor(compositionCanvasSize.width * viewScale),
    height: Math.floor(compositionCanvasSize.height * viewScale) };
  // Centre the focus region in the stage (the canvas is flex-centred, so shift by the offset).
  const focusShiftY = focusing && focusRegion
    ? Math.round((0.5 - (focusRegion.top + focusRegion.bottom) / 2) * canvasSize.height) : 0;
  const cropTransform = cropEditor && canvasSize.width > 0 && canvasSize.height > 0
    ? sourceCropToViewport(cropEditor.rect, cropEditor.sourceWidth, cropEditor.sourceHeight,
      canvasSize.width, canvasSize.height, cropEditor.preset)
    : null;
  // Generated projects retain an OWNED, fast-start copy of the clean generated
  // clip as a REFERENCE asset. Prefer it for the browser preview when the
  // canonical SOURCE is a large SHARED upload whose MP4 metadata may live at
  // EOF. IDs and storage identity remain canonical; this is runtime selection
  // of a playable representation, never a persisted/signed URL.
  const previewProxy = source?.storageOwnership === 'SHARED'
    ? assets.find((asset) => asset.role === 'REFERENCE' &&
      (asset.metadata as { sourceMapping?: string } | null)?.sourceMapping === 'FLATTENED_GENERATED_OUTPUT' &&
      asset.sourceVideoId === source.sourceVideoId)
    : undefined;
  // A generated-output proxy can have the composition's aspect and is useful
  // for normal playback, but crop must expose the canonical source pixels.
  const cropSourceAsset = cropEditor?.sourceAssetId
    ? assets.find((asset) => asset.id === cropEditor.sourceAssetId) : source;
  const automatic2 = resolvedVisualLayout?.editingProfile === 'AUTOMATIC_2';
  // Automatic 2's persisted camera path addresses original-source pixels. A
  // flattened generated proxy already contains another crop and cannot be used
  // without double-framing it.
  const mediaAsset = cropEditor ? (cropSourceAsset ?? source)
    : automatic2 ? source : (previewProxy ?? source);
  const generatedStart = Number(((source?.metadata as { origin?: { generatedStart?: unknown } } | null)
    ?.origin?.generatedStart) ?? 0);
  const usingPreviewProxy = mediaAsset?.id === previewProxy?.id;
  const mediaOffset = usingPreviewProxy && Number.isFinite(generatedStart) ? generatedStart : 0;
  const mediaTime = (sourceTime: number) => Math.max(0, sourceTime - mediaOffset);
  const sourceTime = (previewTime: number) => previewTime + mediaOffset;
  const toggle = async () => {
    if (!video.current || !mapping || mediaState === 'FAILED') return;
    if (video.current.paused) {
      try { await video.current.play(); }
      catch { setPlaying(false); setMediaState('FAILED'); }
    } else video.current.pause();
  };
  useImperativeHandle(forwardedRef, () => ({ toggle,
    pause: () => { video.current?.pause(); setPlaying(false); } }));
  useEffect(() => { if (!video.current || !mapping) return; const target = mediaTime(mapping.sourceTime);
    if (activeId.current !== mapping.element.id || (!playing && Math.abs(video.current.currentTime - target) > 0.04)) {
      syncing.current = true; video.current.currentTime = target; activeId.current = mapping.element.id;
    } }, [mapping?.element.id, mapping?.sourceTime, mediaOffset, playing]);
  // The canvas is sized from the space the row actually gives it, remeasured
  // whenever that space changes, so it survives a window resize and a panel open.
  useEffect(() => {
    const node = frame.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = () => setFrameSize({ width: node.clientWidth, height: node.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setMediaState('LOADING');
    setPlaying(false);
    setMediaAttempt(0);
  }, [mediaAsset?.id]);
  // The element's playback rate, so a 2x segment previews at 2x rather than
  // playing at 1x and disagreeing with both the timeline and the export.
  const segmentSpeed = Number(mapping?.element.properties.speed ?? 1) || 1;
  useEffect(() => {
    if (video.current) video.current.playbackRate = Math.max(0.0625, Math.min(16, segmentSpeed));
  }, [segmentSpeed]);
  // The segment's own source-audio level. Per segment, exactly as the export
  // applies it, so muting one clip is audible here on that clip alone.
  const sourceAudio = readSourceAudio(mapping?.element.properties ?? {});
  useEffect(() => {
    if (!video.current) return;
    video.current.volume = previewGain(sourceAudio.volume);
    video.current.muted = sourceAudio.muted;
  }, [sourceAudio.muted, sourceAudio.volume]);
  // The segment's grade. Drawn on the video element itself and, for fade and
  // vignette, as two layers above it - below the overlays, so a logo or caption
  // is not washed out by a grade that in the export is applied to the footage
  // before anything is composited onto it.
  const segmentColor = readColorAdjustments(mapping?.element.properties ?? {});
  const colorStyle = colorPreviewStyle(segmentColor);
  const colorLayers = colorOverlayLayers(segmentColor);
  if (!source) return <section className='grid min-h-[360px] place-items-center rounded-2xl border border-dashed border-border bg-black/20 text-center'><div><p className='text-sm font-semibold text-soft'>No source attached</p><p className='mt-2 text-xs text-faint'>Choose one exact video from the media panel.</p></div></section>;
  const timeUpdate = (media: HTMLVideoElement) => {
    if (syncing.current) { syncing.current = false; return; }
    const item = videoTrack(elements).find((element) => element.id === activeId.current) ?? mapping?.element; if (!item) return;
    const trimEnd = item.trimEnd ?? item.trimStart + item.duration;
    const canonicalSourceTime = sourceTime(media.currentTime);
    if (canonicalSourceTime >= trimEnd - 0.025) { const next = videoTrack(elements).find((element) => element.position === item.position + 1); if (!next) { media.pause(); onPlayheadChange(duration); return; } activeId.current = next.id; syncing.current = true; media.currentTime = mediaTime(next.trimStart); onPlayheadChange(next.startTime); return; }
    const itemSpeed = Number(item.properties.speed ?? 1) || 1;
    onPlayheadChange(Math.min(duration, item.startTime +
      Math.max(0, canonicalSourceTime - item.trimStart) / itemSpeed));
  };

  /**
   * Direct manipulation.
   *
   * The gesture is entirely LOCAL while the pointer is down: every move patches
   * the in-memory element and redraws, and nothing is sent. Exactly one command
   * is issued, on release. That is what makes dragging a caption feel immediate
   * and still cost one history revision rather than a hundred.
   */
  const interaction = (event: React.PointerEvent, element: EditElement,
    kind: PreviewGesture, corner?: ResizeCorner) => {
    event.preventDefault(); event.stopPropagation(); onSelect(element.id);
    const bounds = canvas.current?.getBoundingClientRect();
    if (!bounds || element.properties.locked) return;
    const before = elements.map((item) => ({ ...item, properties: { ...item.properties } }));
    const origin = element.properties as unknown as VisualElementProperties;
    const startX = event.clientX; const startY = event.clientY;
    const centreX = bounds.left + (origin.x + origin.width / 2) * bounds.width;
    const centreY = bounds.top + (origin.y + origin.height / 2) * bounds.height;
    const startAngle = Math.atan2(startY - centreY, startX - centreX) * 180 / Math.PI;
    const startRotation = Number(origin.rotation ?? 0);
    let latest = element;
    const apply = (next: Record<string, unknown>) => {
      latest = { ...element, properties: { ...element.properties, ...next } };
      onPreviewElements(elements.map((item) => item.id === element.id ? latest : item));
    };
    const move = (pointer: PointerEvent) => {
      const dx = (pointer.clientX - startX) / bounds.width;
      const dy = (pointer.clientY - startY) / bounds.height;
      if (kind === 'rotate') {
        const angle = Math.atan2(pointer.clientY - centreY, pointer.clientX - centreX) *
          180 / Math.PI;
        apply({ rotation: snapRotation(startRotation + angle - startAngle) });
        return;
      }
      if (kind === 'resize') {
        const box = resizeBox({ x: origin.x, y: origin.y, width: origin.width,
          height: origin.height }, corner ?? 'se', dx, dy);
        // Images keep their aspect; text and captions are free-form boxes.
        if (element.type === 'IMAGE' && origin.width > 0) {
          const ratio = origin.height / origin.width;
          const sized = clampBox({ ...box, height: Math.min(1 - box.y, box.width * ratio) });
          apply({ x: sized.x, y: sized.y, width: sized.width, height: sized.height });
        } else apply(box);
        setGuides([]);
        return;
      }
      const snapped = snapBox(clampBox({ x: origin.x + dx, y: origin.y + dy,
        width: origin.width, height: origin.height }));
      setGuides(snapped.guides);
      apply({ x: snapped.x, y: snapped.y });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setGuides([]);
      onCommitTransform(kind, latest, before);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  const visible = (cropEditor ? [] : active).filter((item) => (item.type === 'IMAGE' || item.type === 'TEXT' ||
    item.type === 'SUBTITLE') && item.properties.hidden !== true);

  // A persisted manual crop owns the uncovered canvas. Keep this decision on
  // the canvas behind the video (never on a layer above it), so the retained
  // source pixels remain completely untouched.
  const activeCrop = readCropInsets(mapping?.element.properties ?? {});
  const manualCropBackground = Boolean(cropEditor) || activeCrop.left > 0 ||
    activeCrop.right > 0 || activeCrop.top > 0 || activeCrop.bottom > 0;

  // Render parity for a fitted frame: white and black are exact; the renderer's default
  // BLUR (a blurred copy of the frame) would need a second synced video, so it is shown
  // as a neutral backdrop and labelled rather than drawn as black (which it never is).
  const fitted = !previewFill(aspectRatio, reframePolicy, mapping?.element.properties);
  const card = resolvedVisualLayout?.videoFrame?.mode === 'CARD'
    ? resolvedVisualLayout.videoFrame : null;
  const cameraPath = resolvedVisualLayout?.cameraPath ?? [];
  const cameraCrop = (() => {
    if (!cameraPath.length) return null;
    const after = cameraPath.findIndex((key) => key.t >= currentPlayheadSec);
    if (after <= 0) return cameraPath[Math.max(0, after)];
    const right = cameraPath[after] ?? cameraPath[cameraPath.length - 1];
    const left = cameraPath[after - 1];
    const mix = Math.max(0, Math.min(1,
      (currentPlayheadSec - left.t) / Math.max(.001, right.t - left.t)));
    return { t: currentPlayheadSec, x: left.x + (right.x - left.x) * mix,
      y: left.y + (right.y - left.y) * mix, w: left.w + (right.w - left.w) * mix,
      h: left.h + (right.h - left.h) * mix };
  })();
  const zoom = elements.find((element) => element.type === 'EFFECT' &&
    element.properties.effect === 'ZOOM' && element.properties.enabled !== false &&
    currentPlayheadSec >= element.startTime &&
    currentPlayheadSec <= element.startTime + element.duration);
  const zoomState = (() => {
    if (!zoom) return { scale: 1, x: .5, y: .5 };
    const local = currentPlayheadSec - zoom.startTime;
    const duration = zoom.duration;
    const rampIn = Math.min(.35, duration / 3);
    const rampOut = Math.min(.45, duration / 3);
    const riseU = Math.max(0, Math.min(1, local / Math.max(.001, rampIn)));
    const fallU = Math.max(0, Math.min(1,
      (duration - local) / Math.max(.001, rampOut)));
    const rise = riseU * (2 - riseU);
    const fall = fallU * fallU * (3 - 2 * fallU);
    const peak = Number(zoom.properties.scale) || 1;
    return { scale: 1 + (peak - 1) * Math.min(rise, fall),
      x: Number(zoom.properties.focusX) || .5, y: Number(zoom.properties.focusY) || .5 };
  })();
  const segmentTransform = mapping
    ? transformStyle(mapping.element.properties, { includeScaleAndOffset: true }) : {};
  const combinedTransform = [zoomState.scale > 1.0001
    ? `scale(${zoomState.scale.toFixed(5)})` : '', segmentTransform.transform ?? '']
    .filter(Boolean).join(' ') || undefined;
  const backdrop = fitBackground === 'WHITE' ? '#ffffff' : fitBackground === 'BLACK' ? '#000000' : '#262b36';
  const blurBackdrop = !manualCropBackground && fitted &&
    fitBackground !== 'WHITE' && fitBackground !== 'BLACK';

  return <section className='flex h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-border bg-black/40 max-md:rounded-none max-md:border-0'>
    <div className='flex min-h-0 w-full flex-1 bg-[radial-gradient(ellipse_at_center,#1a2030_0%,#0d1018_70%)] p-3 max-md:p-1.5'
      data-testid='edit-preview-stage'>
    <div ref={frame} className='relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden'>
    {/* The canvas is the export canvas: the export's aspect ratio, fitted to the
        measured space, in explicit pixels. `canvasSize.width` is then the same
        number the renderer calls `canvas.width`, which is what lets the text
        layer size type with the renderer's own formula instead of an
        approximation of it. */}
    <div ref={canvas} style={{ width: `${canvasSize.width}px`, height: `${canvasSize.height}px`, flexShrink: 0,
      ...(focusShiftY ? { transform: `translateY(${focusShiftY}px)` } : {}),
      background: manualCropBackground ? '#000000' : fitted ? backdrop : '#000000' }}
    className={`relative overflow-hidden ${cropEditor ? '' : 'rounded-[3px] shadow-[0_0_0_1px_rgba(255,255,255,.16),0_18px_48px_rgba(0,0,0,.55)]'}`}
    data-testid='edit-preview-canvas' data-canvas-width={canvasSize.width} data-view-mode={focusing ? 'FOCUS' : 'FIT'}
    data-fit-background={manualCropBackground ? 'BLACK' : fitted ? (fitBackground ?? 'BLUR') : 'NONE'}>
      {blurBackdrop && <span className='pointer-events-none absolute left-1.5 top-1.5 z-10 rounded bg-black/50 px-1.5 py-0.5 text-[9px] text-soft'>
        Blurred backdrop appears in export</span>}
      {/* The transform of the segment under the playhead. Crop, flip, rotation,
          scale and position are drawn here in the same order the renderer
          applies them, so what is framed is what is exported. */}
      <video key={`${mediaAsset?.id}-${mediaAttempt}`} ref={video}
        src={mediaAsset ? `${editAssetPlaybackUrl(mediaAsset.id)}${mediaAttempt ? `?retry=${mediaAttempt}` : ''}` : undefined}
        poster={source.sourceVideoId ? editSourcePosterUrl(source.sourceVideoId) : undefined}
        data-testid='edit-preview-video' data-media-state={mediaState}
        className={`absolute ${cropEditor ? 'max-w-none object-fill' : `${card ? '' : 'inset-0 h-full w-full'} ${
          previewFill(aspectRatio, reframePolicy, mapping?.element.properties)
            ? 'object-cover' : 'object-contain'}`}`} preload='metadata'
        style={cropTransform
          ? { left: cropTransform.translateX, top: cropTransform.translateY,
            width: cropTransform.sourceWidth * cropTransform.scale,
            height: cropTransform.sourceHeight * cropTransform.scale, maxWidth: 'none', ...colorStyle }
          : mapping ? { ...(card && cameraCrop ? {
            left: `${(card.x - cameraCrop.x / cameraCrop.w * card.width) * 100}%`,
            top: `${(card.y - cameraCrop.y / cameraCrop.h * card.height) * 100}%`,
            width: `${card.width / cameraCrop.w * 100}%`,
            height: `${card.height / cameraCrop.h * 100}%`, objectFit: 'fill' as const,
            // The camera crop makes the element wider than the canvas; without this the base
            // `video { max-width: 100% }` rule squeezes it and the preview stops matching the export.
            maxWidth: 'none', maxHeight: 'none',
            transformOrigin: `${(cameraCrop.x + zoomState.x * cameraCrop.w) * 100}% ` +
              `${(cameraCrop.y + zoomState.y * cameraCrop.h) * 100}%`
          } : card ? { left: `${card.x * 100}%`, top: `${card.y * 100}%`,
            width: `${card.width * 100}%`, height: `${card.height * 100}%`, objectFit: 'cover' as const }
            : {}), ...segmentTransform,
            ...(card && cameraCrop ? { transformOrigin:
              `${(cameraCrop.x + zoomState.x * cameraCrop.w) * 100}% ` +
              `${(cameraCrop.y + zoomState.y * cameraCrop.h) * 100}%` } : {}),
            ...(combinedTransform ? { transform: combinedTransform } : {}),
            ...colorStyle } : colorStyle}
        onLoadedMetadata={(event) => {
          if (mapping) event.currentTarget.currentTime = mediaTime(mapping.sourceTime);
        }}
        onLoadedData={() => setMediaState('READY')} onCanPlay={() => setMediaState('READY')}
        onError={() => { setPlaying(false); setMediaState('FAILED'); }}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => timeUpdate(event.currentTarget)} />
      {card && <>
        <span aria-hidden className='pointer-events-none absolute left-0 top-0 w-full bg-black'
          style={{ height: `${card.y * 100}%` }} />
        <span aria-hidden className='pointer-events-none absolute bottom-0 left-0 w-full bg-black'
          style={{ height: `${(1 - card.y - card.height) * 100}%` }} />
        {card.x > 0 && <span aria-hidden className='pointer-events-none absolute bg-black'
          style={{ left: 0, top: `${card.y * 100}%`, width: `${card.x * 100}%`,
            height: `${card.height * 100}%` }} />}
        {card.x + card.width < 1 && <span aria-hidden className='pointer-events-none absolute bg-black'
          style={{ right: 0, top: `${card.y * 100}%`, width: `${(1 - card.x - card.width) * 100}%`,
            height: `${card.height * 100}%` }} />}
      </>}

      {cropEditor && cropTransform && <EditCropOverlay rect={cropEditor.rect}
        preset={cropEditor.preset} sourceAspect={cropEditor.sourceAspect}
        transform={cropTransform} onChange={cropEditor.onChange} />}

      {mediaState === 'LOADING' && <div role='status'
        className='pointer-events-none absolute inset-0 z-40 grid place-items-center bg-black/35 text-xs text-soft'>
        Loading preview media…
      </div>}
      {mediaState === 'FAILED' && <div role='alert' data-error-code='MEDIA_LOAD_FAILED'
        className='absolute inset-0 z-40 grid place-items-center bg-black/80 p-6 text-center'>
        <div><p className='text-sm font-semibold text-foreground'>Preview media could not be loaded</p>
          <button type='button' className='mt-3 rounded-lg border border-border-strong bg-white/10 px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-white/15'
            onClick={() => { setMediaState('LOADING'); setMediaAttempt((value) => value + 1); }}>
            Retry
          </button>
        </div>
      </div>}

      {colorLayers.map((layer) => <div key={layer.key} aria-hidden
        data-testid={`color-layer-${layer.key}`}
        className='pointer-events-none absolute inset-0' style={{ zIndex: 1,
          // Fade/vignette belong to the retained video pixels. Reuse the crop
          // geometry so these effects cannot tint the black canvas around it.
          ...(manualCropBackground && !cropEditor && mapping
            ? transformStyle(mapping.element.properties, { includeScaleAndOffset: true }) : {}),
          ...layer.style }} />)}

      {visible.map((element) => {
        const p = element.properties as unknown as VisualElementProperties;
        const selected = element.id === selectedElementId;
        const asset = element.assetId ? assets.find((item) => item.id === element.assetId) : undefined;
        const text = element.type === 'TEXT' || element.type === 'SUBTITLE';
        return <div key={element.id} role='button' tabIndex={0}
          data-testid='preview-element' data-element-id={element.id}
          onPointerDown={(event) => interaction(event, element, 'move')}
          className={`absolute cursor-move touch-none select-none ${selected ? 'outline outline-2 outline-offset-2 outline-secondary' : ''}`}
          style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: `${p.width * 100}%`,
            height: `${p.height * 100}%`, opacity: p.opacity, zIndex: p.zIndex,
            ...(text
              ? { transform: p.rotation ? `rotate(${p.rotation}deg)` : undefined,
                transformOrigin: 'center' }
              : transformStyle(element.properties)) }}>
          {element.type === 'IMAGE'
            ? <img src={asset ? editAssetPlaybackUrl(asset.id) : ''}
              alt={asset?.originalName ?? 'Overlay'} draggable={false}
              className='pointer-events-none h-full w-full object-contain' />
            : <EditPreviewText element={element} canvasWidth={canvasSize.width}
              offsetSec={currentPlayheadSec - element.startTime} />}

          {selected && <>
            {CORNERS.map(({ corner, className, cursor }) => <span key={corner}
              aria-label={`Resize ${corner}`} style={{ cursor }}
              onPointerDown={(event) => interaction(event, element, 'resize', corner)}
              className={`touch-hit absolute h-3 w-3 rounded-sm border border-black bg-secondary coarse:h-4 coarse:w-4 ${className}`} />)}
            <span aria-label='Rotate' title='Rotate'
              onPointerDown={(event) => interaction(event, element, 'rotate')}
              className='touch-hit absolute -top-7 left-1/2 grid h-5 w-5 -translate-x-1/2 cursor-grab place-items-center rounded-full border border-black bg-secondary text-black coarse:-top-9 coarse:h-7 coarse:w-7'>
              <RotateCw size={11} /></span>
          </>}
        </div>;
      })}

      {guides.map((guide) => <div key={`${guide.axis}-${guide.at}`} aria-hidden
        data-testid='snap-guide'
        className='pointer-events-none absolute z-50 bg-accent/80'
        style={guide.axis === 'x'
          ? { left: `${guide.at * 100}%`, top: 0, bottom: 0, width: 1 }
          : { top: `${guide.at * 100}%`, left: 0, right: 0, height: 1 }} />)}

      {active.filter((item) => item.type === 'AUDIO').map((element) =>
        <AudioLayer key={element.id} element={element} playing={playing}
          timelineTime={currentPlayheadSec} />)}
    </div>
    </div>
    </div>
    <div className='flex shrink-0 items-center gap-3 border-t border-border px-4 py-2 max-md:gap-2.5 max-md:px-3 max-md:py-1.5'><button onClick={() => void toggle()} aria-label={playing ? 'Pause preview' : 'Play preview'} className='grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white text-black disabled:opacity-40 coarse:h-11 coarse:w-11' disabled={!!cropEditor || !mapping || mediaState !== 'READY'}>{playing ? <Pause size={16} /> : <Play size={16} className='ml-0.5' />}</button><input aria-label='Seek edited timeline' type='range' min={0} max={duration || 0} step={0.01} value={Math.min(currentPlayheadSec, duration)} disabled={!!cropEditor} onChange={(event) => onPlayheadChange(Number(event.target.value))} className='h-1 min-w-0 flex-1 accent-primary disabled:opacity-40 coarse:h-8' /><span className='shrink-0 text-xs tabular-nums text-muted-foreground'>{clock(currentPlayheadSec)} / {clock(duration)}</span>
      {focusRegion && !cropEditor ? <div role='group' aria-label='Preview view' className='flex shrink-0 rounded-lg border border-border bg-white/[.03] p-0.5 text-[11px]'>
        {([['FOCUS', 'Focus', 'Fill the preview with the hook and video'], ['FIT', 'Fit', 'Show the whole export frame']] as const).map(([mode, label, hint]) =>
          <button key={mode} type='button' title={hint} aria-pressed={viewMode === mode} onClick={() => setViewMode(mode)}
            className={`rounded-md px-2 py-0.5 font-semibold transition-colors coarse:min-h-[34px] coarse:px-2.5 ${viewMode === mode ? 'bg-white/15 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{label}</button>)}
      </div> : null}</div>
  </section>;
});
EditPreview.displayName = 'EditPreview';
