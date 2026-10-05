/**
 * Audio waveforms for the timeline.
 *
 * Entirely local: the asset is fetched from this project's own API, decoded
 * once with the browser's AudioContext, reduced to a fixed number of peak
 * buckets, and cached in memory by asset id. No external service is contacted,
 * nothing is written to disk, and the source media is never modified — a
 * waveform is a picture of the audio, not a second copy of it.
 *
 * The peak maths is pure and lives at the top of this file so it can be
 * exercised without a browser by scripts/test-timeline-ux.cjs.
 */

/** Peaks stored per asset, whatever its length. A 10-minute track reduces to
 *  the same 2048 numbers as a 10-second one, so memory is bounded by the number
 *  of assets rather than by their duration. */
export const WAVEFORM_BUCKETS = 2048;
/** The most columns ever drawn for one visible span. The canvas is at most a
 *  timeline wide, and one column per ~2 device pixels is already more detail
 *  than the eye resolves at this height. */
export const MAX_WAVEFORM_COLUMNS = 720;
/** Assets kept decoded. Beyond this the least recently used is dropped. */
export const WAVEFORM_CACHE_LIMIT = 8;
/**
 * Above this, the file is not decoded at all.
 *
 * decodeAudioData needs the WHOLE file in memory as an ArrayBuffer plus its
 * decoded PCM, so a long source video would cost hundreds of megabytes for a
 * decoration. Past the limit the track draws a plain band instead and says so —
 * a documented bounded fallback rather than a frozen tab.
 */
export const WAVEFORM_MAX_BYTES = 48 * 1024 * 1024;

export type WaveformPeaks = {
  /** Max absolute sample per bucket, 0..1, one bucket per `durationSec/length`. */
  peaks: Float32Array;
  durationSec: number;
};

export type WaveformState =
  | { status: 'IDLE' }
  | { status: 'LOADING' }
  | { status: 'READY'; peaks: WaveformPeaks }
  | { status: 'UNAVAILABLE'; reason: string };

/**
 * Reduces raw samples to `buckets` peaks.
 *
 * Max-absolute rather than RMS: a waveform is read for where the sound STARTS
 * and stops, and a max keeps a transient visible at any zoom, where an average
 * of a 30-second bucket flattens it away.
 */
export function peaksFromSamples(samples: ArrayLike<number>, buckets = WAVEFORM_BUCKETS) {
  const count = Math.max(1, Math.floor(buckets));
  const peaks = new Float32Array(count);
  if (!samples.length) return peaks;
  const per = samples.length / count;
  for (let bucket = 0; bucket < count; bucket += 1) {
    const from = Math.floor(bucket * per);
    const to = Math.min(samples.length, Math.max(from + 1, Math.floor((bucket + 1) * per)));
    let peak = 0;
    for (let index = from; index < to; index += 1) {
      const value = Math.abs(samples[index]);
      if (value > peak) peak = value;
    }
    peaks[bucket] = peak > 1 ? 1 : peak;
  }
  return peaks;
}

/**
 * The column heights to draw for a visible span.
 *
 * Bounded twice: by `columns` (the caller passes the canvas width, itself
 * capped at MAX_WAVEFORM_COLUMNS) and by the stored bucket count. Zooming in
 * past one bucket per column repeats buckets rather than inventing detail.
 */
export function peakWindow(source: WaveformPeaks, input: {
  fromSec: number; toSec: number; columns: number;
}): number[] {
  const columns = Math.max(1, Math.min(MAX_WAVEFORM_COLUMNS, Math.floor(input.columns)));
  const duration = source.durationSec > 0 ? source.durationSec : 1;
  const from = Math.max(0, input.fromSec);
  const to = Math.max(from + 1e-6, input.toSec);
  const out: number[] = [];
  for (let column = 0; column < columns; column += 1) {
    const spanStart = from + (to - from) * (column / columns);
    const spanEnd = from + (to - from) * ((column + 1) / columns);
    if (spanStart >= duration) { out.push(0); continue; }
    const first = Math.max(0, Math.floor(spanStart / duration * source.peaks.length));
    const last = Math.min(source.peaks.length,
      Math.max(first + 1, Math.ceil(spanEnd / duration * source.peaks.length)));
    let peak = 0;
    for (let index = first; index < last; index += 1) {
      if (source.peaks[index] > peak) peak = source.peaks[index];
    }
    out.push(peak);
  }
  return out;
}

// --- Browser side ------------------------------------------------------------

type Entry = { state: WaveformState; usedAt: number };

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<WaveformState>>();
let audioContext: AudioContext | null = null;

const touch = (assetId: string, state: WaveformState) => {
  cache.set(assetId, { state, usedAt: Date.now() });
  // Bounded and disposable: nothing here survives a reload, and dropping an
  // entry costs a re-decode, never data.
  while (cache.size > WAVEFORM_CACHE_LIMIT) {
    let oldest: string | null = null; let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of cache) if (entry.usedAt < oldestAt) { oldestAt = entry.usedAt; oldest = key; }
    if (!oldest) break;
    cache.delete(oldest);
  }
  return state;
};

export function peekWaveform(assetId: string): WaveformState {
  const entry = cache.get(assetId);
  if (!entry) return { status: 'IDLE' };
  entry.usedAt = Date.now();
  return entry.state;
}

/** Drops every decoded waveform. Called when the editor unmounts, so a long
 *  session does not hold a project's audio after leaving it. */
export function clearWaveformCache() {
  cache.clear();
  inFlight.clear();
  void audioContext?.close().catch(() => undefined);
  audioContext = null;
}

/**
 * Decodes one asset's audio into peaks, once.
 *
 * Concurrent callers share the same promise, a failure is cached as
 * UNAVAILABLE (so a missing or undecodable asset is not retried on every
 * scroll), and an oversized asset is refused before it is fetched at all.
 */
export async function loadWaveform(assetId: string, url: string,
  options?: { sizeBytes?: number | null; signal?: AbortSignal }): Promise<WaveformState> {
  const cached = cache.get(assetId);
  if (cached && cached.state.status !== 'LOADING') { cached.usedAt = Date.now(); return cached.state; }
  const pending = inFlight.get(assetId);
  if (pending) return pending;
  const size = options?.sizeBytes ?? null;
  if (size != null && size > WAVEFORM_MAX_BYTES) {
    return touch(assetId, { status: 'UNAVAILABLE',
      reason: `Waveform skipped: this file is over ${Math.round(WAVEFORM_MAX_BYTES / 1024 / 1024)} MB.` });
  }
  if (typeof window === 'undefined') return { status: 'IDLE' };
  const Constructor = window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) {
    return touch(assetId, { status: 'UNAVAILABLE', reason: 'This browser cannot decode audio.' });
  }
  touch(assetId, { status: 'LOADING' });
  const task = (async (): Promise<WaveformState> => {
    try {
      const response = await fetch(url, { credentials: 'include', signal: options?.signal });
      if (!response.ok) throw new Error(`asset request failed (${response.status})`);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > WAVEFORM_MAX_BYTES) {
        return touch(assetId, { status: 'UNAVAILABLE', reason: 'Waveform skipped: file too large.' });
      }
      audioContext = audioContext ?? new Constructor();
      const decoded = await audioContext.decodeAudioData(buffer);
      // One channel is enough for a picture of the level, and it halves the
      // work on a stereo track.
      const peaks = peaksFromSamples(decoded.getChannelData(0), WAVEFORM_BUCKETS);
      return touch(assetId, { status: 'READY', peaks: { peaks, durationSec: decoded.duration } });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') {
        cache.delete(assetId);
        return { status: 'IDLE' };
      }
      return touch(assetId, { status: 'UNAVAILABLE', reason: 'Waveform unavailable for this file.' });
    } finally {
      inFlight.delete(assetId);
    }
  })();
  inFlight.set(assetId, task);
  return task;
}
