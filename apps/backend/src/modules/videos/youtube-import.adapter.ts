import { spawn } from 'child_process';
import { access, mkdir, readdir, rm, stat } from 'fs/promises';
import { constants } from 'fs';
import { delimiter, isAbsolute, join } from 'path';
import { probeMedia } from '../processing/media-probe';
import { MAX_SOURCE_VIDEO_DURATION_SECONDS } from '../processing/clip-selection-policy';

/**
 * Structured import failure. `code` is the real category (persisted as VideoImport.errorCode and
 * logged), `message` is the user-facing sentence, `detail` is the provider's own reason for logs.
 */
export class ImportError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: string) { super(message); }
}

export const IMPORT_FAILURE_CODES = ['VIDEO_NOT_FOUND', 'PRIVATE_VIDEO', 'LOGIN_REQUIRED',
  'AGE_RESTRICTED', 'REGION_RESTRICTED', 'LIVE_STREAM_UNSUPPORTED', 'NO_VIDEO_FORMAT',
  'NO_AUDIO_FORMAT', 'RATE_LIMITED', 'BOT_CHALLENGE', 'NETWORK_TIMEOUT', 'DOWNLOAD_FAILED',
  'MEDIA_INVALID', 'STORAGE_FAILED', 'UNKNOWN_PROVIDER_ERROR'] as const;
export type ImportFailureCode = typeof IMPORT_FAILURE_CODES[number];

const UPLOAD = 'You can upload the video file instead.';
export const IMPORT_FAILURE_MESSAGES: Record<ImportFailureCode, string> = {
  VIDEO_NOT_FOUND: `This video doesn't exist or has been removed. Check the link, or upload the file instead.`,
  PRIVATE_VIDEO: `This video is private and can't be imported. ${UPLOAD}`,
  LOGIN_REQUIRED: `This video requires sign-in and can't be imported automatically. ${UPLOAD}`,
  AGE_RESTRICTED: `This video is age-restricted and can't be imported automatically. ${UPLOAD}`,
  REGION_RESTRICTED: `This video is not available in this region. ${UPLOAD}`,
  LIVE_STREAM_UNSUPPORTED: `Live streams can't be imported while they are live. Try again after the stream has ended, or upload the file.`,
  NO_VIDEO_FORMAT: `Automatic import isn't available for this video. ${UPLOAD}`,
  NO_AUDIO_FORMAT: `This video has no usable audio track, so clips can't be made from it automatically. ${UPLOAD}`,
  RATE_LIMITED: `Import temporarily failed. Try again in a few minutes, or upload the file instead.`,
  BOT_CHALLENGE: `YouTube is temporarily blocking automatic import. Try again later, or upload the file instead.`,
  NETWORK_TIMEOUT: `Import temporarily failed. Try again, or upload the file instead.`,
  DOWNLOAD_FAILED: `Import failed while downloading. Try again, or upload the file instead.`,
  MEDIA_INVALID: `The imported video couldn't be used. ${UPLOAD}`,
  STORAGE_FAILED: `Import failed while saving the video. Try again.`,
  UNKNOWN_PROVIDER_ERROR: `Automatic import isn't available for this video. ${UPLOAD}`
};

export function importFailure(code: ImportFailureCode, detail?: string) {
  return new ImportError(code, IMPORT_FAILURE_MESSAGES[code], detail);
}

/** Failures worth retrying with backoff: the same request can succeed moments later. */
export const TRANSIENT_IMPORT_FAILURES = new Set<string>(['NETWORK_TIMEOUT', 'RATE_LIMITED']);

export function parseYouTubeUrl(input: unknown) {
  if (typeof input !== 'string' || input.length > 2048) {
    throw new ImportError('INVALID_URL', 'Enter a valid YouTube video URL.');
  }
  let url: URL;
  try { url = new URL(input.trim()); } catch {
    throw new ImportError('INVALID_URL', 'Enter a valid YouTube video URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    throw new ImportError('INVALID_URL', 'Use a public HTTPS YouTube video URL.');
  }
  const host = url.hostname.toLowerCase();
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) {
    throw new ImportError('UNSUPPORTED_PROVIDER', 'Only YouTube video links are supported.');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const id = host === 'youtu.be' && segments.length === 1 ? segments[0]
    : segments.length === 1 && segments[0] === 'watch' ? url.searchParams.get('v')
    : segments.length === 2 && ['shorts', 'live'].includes(segments[0]) ? segments[1] : null;
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) {
    throw new ImportError('INVALID_URL', 'The YouTube link must identify one video.');
  }
  return { externalVideoId: id, sourceUrl: `https://www.youtube.com/watch?v=${id}` };
}

/**
 * Classifies yt-dlp's stderr into a failure category. Order matters: YouTube's private,
 * bot-check and age-gate messages all also contain "sign in", so they are matched before the
 * generic login rule. Patterns follow the messages yt-dlp's YouTube extractor actually emits.
 */
export function classifyYtDlpError(stderr: string, phase: 'metadata' | 'download'): ImportFailureCode {
  // The ERROR lines carry the reason; warnings (e.g. about sign-in for other clients) must not.
  const errors = stderr.split('\n').filter((line) => /^\s*ERROR:/.test(line)).join('\n');
  const text = (errors || stderr).toLowerCase();
  const has = (pattern: RegExp) => pattern.test(text);
  if (has(/private video|this video is private/)) return 'PRIVATE_VIDEO';
  if (has(/not a bot|captcha challenge/)) return 'BOT_CHALLENGE';
  if (has(/rate-limited by youtube|this content isn't available, try again later|http error 429|too many requests/))
    return 'RATE_LIMITED';
  if (has(/confirm your age|age-restricted|inappropriate for some users|age verification/)) return 'AGE_RESTRICTED';
  if (has(/available in your country|geo restriction|not available from your location|geo-restricted/))
    return 'REGION_RESTRICTED';
  if (has(/members-only|members only|join this channel|available to this channel's members|only available for registered users|premium|requires payment|purchase|sign in|log in|login required|--cookies/))
    return 'LOGIN_REQUIRED';
  if (has(/live event will begin|premieres in|is_upcoming|this live stream recording is not available|live stream|is live|post-live/))
    return 'LIVE_STREAM_UNSUPPORTED';
  if (has(/drm protected|requested format is not available|no video formats found/)) return 'NO_VIDEO_FORMAT';
  if (has(/this video is unavailable|video unavailable|has been removed|no longer available|account associated with this video has been terminated|does not exist|incomplete youtube id|http error 404|http error 410/))
    return 'VIDEO_NOT_FOUND';
  if (has(/timed? ?out|connection (reset|refused|aborted)|temporary failure in name resolution|name or service not known|network is unreachable|remote end closed|incompleteread|eof occurred|http error 5\d\d|ssl:|unable to download (webpage|api page)/))
    return 'NETWORK_TIMEOUT';
  if (phase === 'download' && has(/http error 403|forbidden|fragment|unable to download|error: .*download/))
    return 'DOWNLOAD_FAILED';
  return phase === 'download' ? 'DOWNLOAD_FAILED' : 'UNKNOWN_PROVIDER_ERROR';
}

export type ImportConfig = {
  binary: string;
  connectTimeoutSec: number;
  totalTimeoutMs: number;
  stallTimeoutMs: number;
  metadataTimeoutMs: number;
  maxDuration: number;
  maxBytes: number;
  maxAttempts: number;
  concurrency: number;
};

function positive(names: string[], fallback: number) {
  for (const name of names) {
    const parsed = Number(process.env[name]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

/** Deployment limits. Old variable names still work as fallbacks. */
export function importConfig(): ImportConfig {
  const legacyTimeoutSec = Number(process.env.IMPORT_TIMEOUT_MS) / 1000;
  return {
    binary: process.env.YOUTUBE_IMPORT_BINARY || 'yt-dlp',
    connectTimeoutSec: positive(['YOUTUBE_IMPORT_CONNECT_TIMEOUT'], 30),
    // Whole import (metadata, every attempt, normalization). Long sources need hours, not minutes.
    totalTimeoutMs: 1000 * positive(['YOUTUBE_IMPORT_TOTAL_TIMEOUT'],
      Number.isFinite(legacyTimeoutSec) && legacyTimeoutSec > 0 ? legacyTimeoutSec : 3 * 3600),
    // A download that makes no progress for this long is a network failure, not a slow line.
    stallTimeoutMs: 1000 * positive(['YOUTUBE_IMPORT_STALL_TIMEOUT'], 300),
    metadataTimeoutMs: 1000 * positive(['YOUTUBE_IMPORT_METADATA_TIMEOUT'], 180),
    // Never above the platform's accepted source length; longer sources are rejected downstream.
    maxDuration: Math.min(MAX_SOURCE_VIDEO_DURATION_SECONDS,
      positive(['YOUTUBE_IMPORT_MAX_DURATION', 'MAX_IMPORT_DURATION_SECONDS'], MAX_SOURCE_VIDEO_DURATION_SECONDS)),
    maxBytes: positive(['YOUTUBE_IMPORT_MAX_BYTES', 'MAX_IMPORT_FILE_BYTES'], 4 * 1024 * 1024 * 1024),
    maxAttempts: Math.min(6, Math.floor(positive(['YOUTUBE_IMPORT_MAX_ATTEMPTS'], 3))),
    // Imports run side by side so one long import never holds up another user's link.
    concurrency: Math.min(8, Math.floor(positive(['YOUTUBE_IMPORT_CONCURRENCY'], 2)))
  };
}

export type ImportMetadata = {
  id: string; title: string | null; duration: number; availability: string | null;
  liveStatus: string | null; thumbnail: string | null; width: number | null; height: number | null;
  estimatedBytes: number | null; formatCount: number;
};

type RawFormat = { format_id?: string; ext?: string; vcodec?: string | null; acodec?: string | null;
  protocol?: string; height?: number | null; has_drm?: boolean | string; filesize?: number | null;
  filesize_approx?: number | null; tbr?: number | null };

/**
 * Format fallback chain, tried in order. Each step is a yt-dlp selector that itself falls back
 * with `/`; a later step only runs when an earlier one cannot be downloaded or yields unusable
 * media. No step depends on a specific YouTube format id, and none requires MP4: the result is
 * normalized to the canonical H.264/AAC MP4 with FFmpeg afterwards.
 */
export const FORMAT_CHAIN = [
  { name: 'h264-aac-mp4', format: 'bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b[vcodec^=avc1][acodec^=mp4a][height<=1080]',
    sort: 'res:1080,proto:https', merge: 'mp4' },
  { name: 'best-video+best-audio', format: 'bv*[height<=1080]+ba',
    sort: 'res:1080,vcodec:h264,acodec:aac,proto:https', merge: 'mkv' },
  { name: 'best-single-file', format: 'b[height<=1080]/b', sort: 'res:1080,vcodec:h264,acodec:aac', merge: null },
  { name: 'any-compatible-hls', format: 'bv*+ba/b', sort: 'res:1080,proto:m3u8,vcodec:h264', merge: 'mkv' }
] as const;

export type DownloadResult = {
  filePath: string; size: number; formatStep: string; formatId: string | null;
  vcodec: string | null; acodec: string | null; width: number | null; height: number | null;
  protocols: string[]; mediaHosts: string[];
};

export type AttemptLog = { phase: 'metadata' | 'download'; step?: string; attempt: number;
  exitCode: number | null; category?: string; stderr?: string; ms: number };

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', onAbort, { once: true });
});

/** Bounded exponential backoff; rate limits back off harder. */
export function backoffMs(code: string, attempt: number) {
  const base = code === 'RATE_LIMITED' ? 15_000 : 2_000;
  return Math.min(60_000, base * 2 ** (attempt - 1));
}

type RunResult = { stdout: string; stderr: string; code: number | null };

export class YouTubeImportAdapter {
  readonly config = importConfig();
  get maxDuration() { return this.config.maxDuration; }
  get maxBytes() { return this.config.maxBytes; }

  /** Version and resolved path of the retriever actually on PATH, for the startup log. */
  async describeBinary() {
    const resolved = await resolveExecutable(this.config.binary);
    try {
      const { stdout } = await this.run(['--version'], new AbortController().signal, 15_000);
      return { binary: this.config.binary, resolvedPath: resolved, version: stdout.trim() || null };
    } catch {
      return { binary: this.config.binary, resolvedPath: resolved, version: null };
    }
  }

  /**
   * Resolves the video before any download and fails early, with the real category, when it is
   * clearly unsupported. Only compact fields are printed: the full JSON dump carries megabytes of
   * caption tables (the original failure: a 2.8 MB dump tripped the output cap).
   */
  async metadata(sourceUrl: string, signal: AbortSignal, attempts: AttemptLog[] = []): Promise<ImportMetadata> {
    const expectedId = parseYouTubeUrl(sourceUrl).externalVideoId;
    const result = await this.withRetries('metadata', undefined, attempts, signal, async () => {
      const run = await this.run(['--ignore-config', '--no-playlist', '--skip-download',
        '--socket-timeout', String(this.config.connectTimeoutSec), '--extractor-retries', '2',
        '-O', '%(.{id,title,duration,availability,age_limit,is_live,was_live,live_status,extractor_key,thumbnail,width,height})j',
        '-O', '%(formats.:.{format_id,ext,vcodec,acodec,protocol,height,has_drm,filesize,filesize_approx,tbr})j',
        sourceUrl], signal, this.config.metadataTimeoutMs);
      if (run.code !== 0) throw this.failure(run, 'metadata');
      return run;
    });
    const [infoLine, formatsLine] = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    let info: Record<string, unknown>;
    let formats: RawFormat[];
    try {
      info = JSON.parse(infoLine) as Record<string, unknown>;
      const parsed = JSON.parse(formatsLine ?? '[]') as unknown;
      formats = Array.isArray(parsed) ? parsed as RawFormat[] : [];
    } catch {
      throw importFailure('UNKNOWN_PROVIDER_ERROR', 'Unreadable metadata output');
    }
    if (info.extractor_key !== 'Youtube' || info.id !== expectedId)
      throw importFailure('UNKNOWN_PROVIDER_ERROR', `Unexpected extractor result ${String(info.extractor_key)}/${String(info.id)}`);
    const liveStatus = typeof info.live_status === 'string' ? info.live_status : null;
    // An active, upcoming or still-processing broadcast is not a VOD; an archived one is.
    if (info.is_live === true || liveStatus === 'is_live' || liveStatus === 'is_upcoming' || liveStatus === 'post_live')
      throw importFailure('LIVE_STREAM_UNSUPPORTED', `live_status=${liveStatus}`);
    const availability = typeof info.availability === 'string' ? info.availability : null;
    const ageLimit = typeof info.age_limit === 'number' ? info.age_limit : 0;
    if (availability === 'private') throw importFailure('PRIVATE_VIDEO', 'availability=private');
    if (ageLimit > 0) throw importFailure('AGE_RESTRICTED', `age_limit=${ageLimit}`);
    // Unlisted videos are reachable without signing in; everything else gated is refused.
    if (availability && !['public', 'unlisted'].includes(availability))
      throw importFailure('LOGIN_REQUIRED', `availability=${availability}`);
    const duration = typeof info.duration === 'number' && Number.isFinite(info.duration) ? info.duration : 0;
    if (duration <= 0) throw importFailure('UNKNOWN_PROVIDER_ERROR', 'No duration in metadata');
    if (duration > this.config.maxDuration) throw new ImportError('DURATION_LIMIT',
      `This video is longer than the ${Math.floor(this.config.maxDuration / 60)} minute limit. Upload a shorter video instead.`,
      `duration=${duration}`);
    const usable = formats.filter((format) => !format.has_drm && format.protocol !== 'mhtml');
    if (!usable.length && formats.some((format) => format.has_drm))
      throw importFailure('NO_VIDEO_FORMAT', 'All formats are DRM protected');
    if (!usable.some((format) => format.vcodec && format.vcodec !== 'none'))
      throw importFailure('NO_VIDEO_FORMAT', `No video formats among ${formats.length}`);
    if (!usable.some((format) => format.acodec && format.acodec !== 'none'))
      throw importFailure('NO_AUDIO_FORMAT', `No audio formats among ${formats.length}`);
    return {
      id: expectedId, duration, availability, liveStatus,
      title: typeof info.title === 'string' ? info.title : null,
      thumbnail: typeof info.thumbnail === 'string' ? info.thumbnail : null,
      width: typeof info.width === 'number' ? info.width : null,
      height: typeof info.height === 'number' ? info.height : null,
      estimatedBytes: estimateBytes(usable, duration), formatCount: formats.length
    };
  }

  /**
   * Retrieves the media through FORMAT_CHAIN. Transient failures retry the same step with backoff;
   * a step that cannot be downloaded (format unavailable, 403, unusable result) moves to the next.
   * Permanent access failures (private, sign-in, region, ...) stop immediately.
   */
  async download(sourceUrl: string, directory: string, signal: AbortSignal,
    onProgress: (bytes: number) => Promise<void>, attempts: AttemptLog[] = []): Promise<DownloadResult> {
    let lastError: ImportError | undefined;
    for (const [index, step] of FORMAT_CHAIN.entries()) {
      const stepDir = join(directory, `step${index + 1}`);
      try {
        return await this.withRetries('download', step.name, attempts, signal, async () => {
          await rm(stepDir, { recursive: true, force: true });
          await mkdir(stepDir, { recursive: true });
          return this.downloadStep(sourceUrl, stepDir, step, signal, onProgress);
        });
      } catch (error) {
        if (!(error instanceof ImportError)) throw error;
        lastError = error;
        await rm(stepDir, { recursive: true, force: true }).catch(() => undefined);
        // Only "this format route did not work" moves on; access/size/cancel failures are final.
        if (!['NO_VIDEO_FORMAT', 'NO_AUDIO_FORMAT', 'DOWNLOAD_FAILED', 'MEDIA_INVALID'].includes(error.code)) throw error;
      }
    }
    throw lastError ?? importFailure('DOWNLOAD_FAILED', 'No format step succeeded');
  }

  private async downloadStep(sourceUrl: string, directory: string, step: typeof FORMAT_CHAIN[number],
    signal: AbortSignal, onProgress: (bytes: number) => Promise<void>): Promise<DownloadResult> {
    const controller = new AbortController();
    const forward = () => controller.abort(signal.reason);
    signal.addEventListener('abort', forward, { once: true });
    let lastBytes = 0;
    let lastProgressAt = Date.now();
    const monitor = setInterval(() => {
      void readdir(directory).then(async (names) => {
        const sizes = await Promise.all(names.map((name) =>
          stat(join(directory, name)).then((value) => value.size).catch(() => 0)));
        const bytes = sizes.reduce((sum, size) => sum + size, 0);
        if (bytes > this.config.maxBytes) controller.abort(new ImportError('SIZE_LIMIT',
          'This video is larger than the import size limit. Upload the file instead.', `bytes=${bytes}`));
        if (bytes > lastBytes) { lastBytes = bytes; lastProgressAt = Date.now(); await onProgress(bytes); }
        else if (Date.now() - lastProgressAt > this.config.stallTimeoutMs)
          controller.abort(importFailure('NETWORK_TIMEOUT', `No download progress for ${this.config.stallTimeoutMs / 1000}s`));
      }).catch(() => undefined);
    }, 1000);
    try {
      const run = await this.run(['--ignore-config', '--no-playlist', '--no-part', '--no-mtime',
        '--socket-timeout', String(this.config.connectTimeoutSec), '--retries', '3',
        '--fragment-retries', '10', '--extractor-retries', '2', '--concurrent-fragments', '4',
        '--match-filter', '!is_live', '-f', step.format, '-S', step.sort,
        ...(step.merge ? ['--merge-output-format', step.merge] : []),
        '--no-simulate', '-O',
        'after_move:%(.{filepath,format_id,vcodec,acodec,width,height,protocol,requested_formats})j',
        '--output', join(directory, 'source.%(ext)s'), sourceUrl], controller.signal, this.config.totalTimeoutMs);
      if (run.code !== 0) throw this.failure(run, 'download');
      const printed = parsePrinted(run.stdout);
      const files = (await readdir(directory)).filter((name) => name.startsWith('source.') &&
        !/\.(part|ytdl|temp)$/.test(name) && !/\.f[\w-]+\.\w+$/.test(name));
      const filePath = typeof printed?.filepath === 'string' ? printed.filepath
        : files.length === 1 ? join(directory, files[0]) : null;
      if (!filePath) throw importFailure('DOWNLOAD_FAILED', `Expected one output file, found ${files.join(',') || 'none'}`);
      const size = (await stat(filePath)).size;
      if (!size) throw importFailure('DOWNLOAD_FAILED', 'Downloaded file is empty');
      if (size > this.config.maxBytes) throw new ImportError('SIZE_LIMIT',
        'This video is larger than the import size limit. Upload the file instead.', `bytes=${size}`);
      // A step whose result is missing a stream is a format problem: the next step may fix it.
      const probe = await probeMedia(filePath).catch(() => null);
      if (!probe) throw importFailure('MEDIA_INVALID', `ffprobe could not read ${step.name} output`);
      if (!probe.hasVideo) throw importFailure('NO_VIDEO_FORMAT', `${step.name} produced no video stream`);
      if (!probe.hasAudio) throw importFailure('NO_AUDIO_FORMAT', `${step.name} produced no audio stream`);
      const requested = Array.isArray(printed?.requested_formats)
        ? printed.requested_formats as Array<{ url?: string; protocol?: string }> : [printed ?? {}];
      return {
        filePath, size, formatStep: step.name,
        formatId: typeof printed?.format_id === 'string' ? printed.format_id : null,
        vcodec: typeof printed?.vcodec === 'string' ? printed.vcodec : null,
        acodec: typeof printed?.acodec === 'string' ? printed.acodec : null,
        width: typeof printed?.width === 'number' ? printed.width : null,
        height: typeof printed?.height === 'number' ? printed.height : null,
        protocols: [...new Set(requested.map((item) => String(item.protocol ?? 'unknown')))],
        // Signed media URLs are credentials-like; only their hosts are logged.
        mediaHosts: [...new Set(requested.map((item) => hostOf(item.url)).filter((host): host is string => !!host))]
      };
    } catch (error) {
      if (controller.signal.reason instanceof ImportError) throw controller.signal.reason;
      throw error;
    } finally {
      clearInterval(monitor);
      signal.removeEventListener('abort', forward);
    }
  }

  private async withRetries<T>(phase: 'metadata' | 'download', step: string | undefined,
    attempts: AttemptLog[], signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const started = Date.now();
      try {
        const value = await task();
        attempts.push({ phase, step, attempt, exitCode: 0, ms: Date.now() - started });
        return value;
      } catch (error) {
        const failure = error instanceof ImportError ? error : importFailure(
          phase === 'download' ? 'DOWNLOAD_FAILED' : 'UNKNOWN_PROVIDER_ERROR',
          error instanceof Error ? error.message : String(error));
        attempts.push({ phase, step, attempt, exitCode: (error as { exitCode?: number }).exitCode ?? null,
          category: failure.code, stderr: failure.detail?.slice(-1500), ms: Date.now() - started });
        if (!TRANSIENT_IMPORT_FAILURES.has(failure.code) || attempt >= this.config.maxAttempts || signal.aborted)
          throw failure;
        await sleep(backoffMs(failure.code, attempt), signal);
      }
    }
  }

  private failure(run: RunResult, phase: 'metadata' | 'download') {
    const error = importFailure(classifyYtDlpError(run.stderr, phase),
      `exit=${run.code}; ${run.stderr.trim().split('\n').filter((line) => !/^\[download\]\s+\d/.test(line)).slice(-12).join(' | ')}`);
    return Object.assign(error, { exitCode: run.code });
  }

  private run(args: string[], signal: AbortSignal, timeoutMs: number): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.binary, args, { shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      let timedOut = false;
      let overflow = false;
      const stop = () => {
        if (child.pid && process.platform !== 'win32') {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        } else if (child.pid && process.platform === 'win32') {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'],
            { shell: false, windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
        } else child.kill();
      };
      const onAbort = () => stop();
      if (signal.aborted) stop(); else signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        // Compact prints are a few KB; this only guards against a runaway process.
        if (stdout.length > 16_000_000) { overflow = true; stop(); }
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
      child.on('error', (error: NodeJS.ErrnoException) => {
        finish();
        reject(signal.aborted ? abortReason(signal) : error.code === 'ENOENT'
          ? new ImportError('IMPORT_UNAVAILABLE',
            "YouTube import isn't available right now. You can upload the video file instead.",
            `Retriever ${this.config.binary} not found`)
          : importFailure('UNKNOWN_PROVIDER_ERROR', error.message));
      });
      child.on('close', (code) => {
        finish();
        if (signal.aborted) reject(abortReason(signal));
        else if (timedOut) reject(importFailure('NETWORK_TIMEOUT', `Retriever exceeded ${Math.round(timeoutMs / 1000)}s`));
        else if (overflow) reject(importFailure('UNKNOWN_PROVIDER_ERROR', 'Retriever output exceeded 16 MB'));
        else resolve({ stdout, stderr, code });
      });
    });
  }
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof ImportError ? signal.reason
    : new ImportError('IMPORT_CANCELLED', 'Import cancelled.');
}

function parsePrinted(stdout: string): Record<string, unknown> | null {
  const line = stdout.split('\n').map((item) => item.trim()).filter((item) => item.startsWith('{')).pop();
  if (!line) return null;
  try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
}

function hostOf(url: unknown) {
  if (typeof url !== 'string') return null;
  try { return new URL(url).hostname; } catch { return null; }
}

/** Expected size of the first chain step (H.264 <=1080p + AAC), for progress only. */
function estimateBytes(formats: RawFormat[], duration: number) {
  // YouTube often omits sizes for DASH video; the average bitrate (kbit/s) covers those.
  const size = (format?: RawFormat) => !format ? null : format.filesize ?? format.filesize_approx ??
    (format.tbr ? Math.round(format.tbr * 125 * duration) : null);
  const video = formats.filter((format) => format.vcodec?.startsWith('avc1') && (format.acodec ?? 'none') === 'none' &&
    (format.height ?? 0) <= 1080).sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
  const audio = formats.filter((format) => format.acodec?.startsWith('mp4a') && (format.vcodec ?? 'none') === 'none')
    .sort((a, b) => (size(b) ?? 0) - (size(a) ?? 0))[0];
  const total = (size(video) ?? 0) + (size(audio) ?? 0);
  return total > 0 ? total : null;
}

async function resolveExecutable(binary: string) {
  if (isAbsolute(binary)) return binary;
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, binary);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return null;
}
