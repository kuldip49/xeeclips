/**
 * Video thumbnail strips for the timeline.
 *
 * Entirely local: frames are grabbed from the same source media the preview
 * already plays, by seeking one off-screen <video> and drawing it into a small
 * canvas. No external service, no server round trip beyond the asset stream the
 * editor already opens, and the source file is never touched.
 *
 * Bounded on every axis that could run away:
 *   - only the VISIBLE timeline range is ever asked for;
 *   - at most MAX_SLOTS frames are laid out for one paint;
 *   - frame times are quantized, so scrolling a few pixels reuses cached
 *     frames instead of asking for new ones;
 *   - the cache is an LRU of CACHE_LIMIT small JPEG data URLs;
 *   - exactly one decode is in flight at a time, so generation can never
 *     compete with playback or with the editor's first paint.
 *
 * The layout maths is pure and lives at the top of this file so it can be
 * exercised without a browser by scripts/test-timeline-ux.cjs.
 */

/** Nominal on-screen width of one frame. Also the layout step. */
export const THUMBNAIL_WIDTH_PX = 72;
/** Decoded frame size. Small on purpose: this is a strip a few pixels tall. */
export const THUMBNAIL_PIXEL_WIDTH = 96;
/** The most frames laid out for one paint, across the whole video track. */
export const MAX_SLOTS = 48;
/** Cached frames, across all assets. */
export const CACHE_LIMIT = 300;
/** Frame times are rounded to this, so a small scroll reuses what is cached. */
export const THUMBNAIL_QUANTUM_SEC = 0.5;

export type ThumbnailBlock = {
  id: string;
  assetId: string | null | undefined;
  startTime: number;
  duration: number;
  trimStart: number;
  /** Playback rate, so a 2x segment's strip advances through the source twice
   *  as fast — the same mapping the preview and the renderer use. */
  speed?: number;
};

export type ThumbnailSlot = {
  /** Cache key: asset plus quantized source second. */
  key: string;
  assetId: string;
  elementId: string;
  leftPx: number;
  widthPx: number;
  sourceSec: number;
};

const quantize = (seconds: number) =>
  Math.round(Math.max(0, seconds) / THUMBNAIL_QUANTUM_SEC) * THUMBNAIL_QUANTUM_SEC;

export const thumbnailKey = (assetId: string, sourceSec: number) =>
  `${assetId}@${quantize(sourceSec).toFixed(2)}`;

/**
 * The frames to draw for the currently visible timeline range.
 *
 * Every slot is clipped to both its own block and the visible window, so a
 * 10-minute project at a working zoom lays out a screenful of frames rather
 * than a strip for the whole project. Past MAX_SLOTS the layout simply stops:
 * a bounded fallback, visible as a strip that thins out at the edges, rather
 * than hundreds of pending decodes.
 */
export function thumbnailSlots(blocks: ThumbnailBlock[], view: {
  pxPerSecond: number; windowStartSec: number; windowEndSec: number;
}, options?: { widthPx?: number; maxSlots?: number }): ThumbnailSlot[] {
  const width = Math.max(16, options?.widthPx ?? THUMBNAIL_WIDTH_PX);
  const limit = Math.max(0, options?.maxSlots ?? MAX_SLOTS);
  const pxPerSecond = view.pxPerSecond;
  if (!(pxPerSecond > 0) || limit === 0) return [];
  const stepSec = width / pxPerSecond;
  const slots: ThumbnailSlot[] = [];
  for (const block of blocks) {
    if (!block.assetId) continue;
    const blockEnd = block.startTime + block.duration;
    const from = Math.max(block.startTime, view.windowStartSec);
    const to = Math.min(blockEnd, view.windowEndSec);
    if (!(to > from)) continue;
    const speed = Math.max(0.0001, Number(block.speed ?? 1) || 1);
    // Slots are aligned to the BLOCK's own grid, not the viewport's, so
    // scrolling slides an unchanged strip instead of reshuffling every frame.
    const firstIndex = Math.floor((from - block.startTime) / stepSec);
    const lastIndex = Math.ceil((to - block.startTime) / stepSec);
    for (let index = firstIndex; index < lastIndex; index += 1) {
      if (slots.length >= limit) return slots;
      const slotStart = block.startTime + index * stepSec;
      const slotEnd = Math.min(blockEnd, slotStart + stepSec);
      if (slotEnd <= from || slotStart >= to) continue;
      const sourceSec = block.trimStart + Math.max(0, slotStart - block.startTime) * speed;
      slots.push({
        key: thumbnailKey(block.assetId, sourceSec),
        assetId: block.assetId,
        elementId: block.id,
        leftPx: slotStart * pxPerSecond,
        widthPx: Math.max(1, (slotEnd - slotStart) * pxPerSecond),
        sourceSec: quantize(sourceSec)
      });
    }
  }
  return slots;
}

// --- Browser side ------------------------------------------------------------

const frames = new Map<string, string>();
const failed = new Set<string>();
const queue: Array<{ key: string; assetId: string; url: string; sourceSec: number }> = [];
const videos = new Map<string, HTMLVideoElement>();
let running = false;
let listeners: Array<() => void> = [];

export const peekThumbnail = (key: string) => frames.get(key);

export function onThumbnailsChanged(listener: () => void) {
  listeners.push(listener);
  return () => { listeners = listeners.filter((entry) => entry !== listener); };
}

/** Everything here is derived and disposable: dropping it costs a re-decode. */
export function clearThumbnailCache() {
  frames.clear();
  failed.clear();
  queue.length = 0;
  for (const video of videos.values()) { video.removeAttribute('src'); video.load(); }
  videos.clear();
  listeners = [];
}

const store = (key: string, dataUrl: string) => {
  frames.set(key, dataUrl);
  while (frames.size > CACHE_LIMIT) {
    const oldest = frames.keys().next();
    if (oldest.done) break;
    frames.delete(oldest.value);
  }
};

function element(assetId: string, url: string) {
  const existing = videos.get(assetId);
  if (existing) return existing;
  const video = document.createElement('video');
  // Needed for a cross-origin frame to be readable: without it drawImage taints
  // the canvas and toDataURL throws a SecurityError.
  video.crossOrigin = 'use-credentials';
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  videos.set(assetId, video);
  return video;
}

/** A decode that timed out is RETRYABLE; a decode that errored is not. The
 *  distinction matters because a browser refuses to load media in a background
 *  tab: without it, opening the editor in a background tab would poison every
 *  frame key for the rest of the session and the strip would stay blank after
 *  the tab was brought forward. */
type FrameResult = { dataUrl: string } | { retry: true } | { failed: true };

const seekFrame = (video: HTMLVideoElement, sourceSec: number) =>
  new Promise<FrameResult>((resolve) => {
    let settled = false;
    const finish = (value: FrameResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      resolve(value);
    };
    const onSeeked = () => {
      try {
        const height = Math.max(1, Math.round(THUMBNAIL_PIXEL_WIDTH *
          (video.videoHeight || 9) / (video.videoWidth || 16)));
        const canvas = document.createElement('canvas');
        canvas.width = THUMBNAIL_PIXEL_WIDTH; canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) return finish({ failed: true });
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish({ dataUrl: canvas.toDataURL('image/jpeg', 0.55) });
      } catch { finish({ failed: true }); }
    };
    const onError = () => finish({ failed: true });
    // A seek that never lands (a stalled range request, a backgrounded tab)
    // must not wedge the queue behind it - but it is worth trying again later.
    const timer = setTimeout(() => finish({ retry: true }), 4000);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    try { video.currentTime = Math.max(0, sourceSec); } catch { finish({ failed: true }); }
  });

/** A background tab will not load media at all, so there is nothing to do until
 *  it comes forward. Waiting for that is what turns "blank strip forever" into
 *  "strip fills in when you look at it". */
const hiddenNow = () => typeof document !== 'undefined' && document.hidden;
let awaitingVisible = false;
function resumeWhenVisible() {
  if (awaitingVisible || typeof document === 'undefined') return;
  awaitingVisible = true;
  document.addEventListener('visibilitychange', function once() {
    if (document.hidden) return;
    document.removeEventListener('visibilitychange', once);
    awaitingVisible = false;
    void pump();
  });
}

async function pump() {
  if (running) return;
  if (hiddenNow()) { resumeWhenVisible(); return; }
  running = true;
  try {
    let produced = 0;
    while (queue.length) {
      const job = queue.shift()!;
      if (frames.has(job.key) || failed.has(job.key)) continue;
      const video = element(job.assetId, job.url);
      if (video.readyState < 1) {
        const ready = await new Promise<'ready' | 'retry' | 'failed'>((resolve) => {
          const timer = setTimeout(
            () => resolve(video.readyState >= 1 ? 'ready' : 'retry'), 6000);
          video.addEventListener('loadedmetadata',
            () => { clearTimeout(timer); resolve('ready'); }, { once: true });
          video.addEventListener('error',
            () => { clearTimeout(timer); resolve('failed'); }, { once: true });
        });
        if (ready === 'failed') { failed.add(job.key); continue; }
        // Nothing is decoding: stop rather than burn six seconds per frame, and
        // pick the work up again when the tab is looked at.
        if (ready === 'retry') { queue.length = 0; resumeWhenVisible(); break; }
      }
      const result = await seekFrame(video, job.sourceSec);
      if ('dataUrl' in result) { store(job.key, result.dataUrl); produced += 1; }
      else if ('failed' in result) failed.add(job.key);
      else { queue.length = 0; resumeWhenVisible(); break; }
      // Repaint in batches rather than per frame, so a strip fills in visibly
      // without a render per decode.
      if (produced >= 4) { produced = 0; for (const listener of listeners) listener(); }
    }
    for (const listener of listeners) listener();
  } finally {
    running = false;
  }
}

/**
 * Asks for the frames a strip needs. Already-cached and already-failed keys are
 * dropped, the rest are queued newest-request-first and produced one at a time.
 * Returns immediately — nothing here is awaited on a render path, which is what
 * keeps thumbnail work off the editor's first paint.
 */
export function requestThumbnails(slots: ThumbnailSlot[], urlFor: (assetId: string) => string) {
  if (typeof window === 'undefined') return;
  const wanted = slots.filter((slot) => !frames.has(slot.key) && !failed.has(slot.key));
  if (!wanted.length) return;
  // The queue only ever holds what is on screen now; a stale request from a
  // range the user has scrolled away from is simply dropped.
  queue.length = 0;
  const seen = new Set<string>();
  for (const slot of wanted) {
    if (seen.has(slot.key)) continue;
    seen.add(slot.key);
    queue.push({ key: slot.key, assetId: slot.assetId, url: urlFor(slot.assetId),
      sourceSec: slot.sourceSec });
  }
  void pump();
}
