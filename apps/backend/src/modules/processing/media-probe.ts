import { execFile } from 'child_process';
import { stat } from 'fs/promises';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type MediaErrorCode =
  | 'NO_AUDIO_STREAM'
  | 'NO_VIDEO_STREAM'
  | 'INVALID_MEDIA_FILE'
  | 'AUDIO_EXTRACTION_FAILED'
  | 'AUDIO_RECOVERY_FAILED'
  | 'STORAGE_OR_DOWNLOAD_CORRUPTION'
  | 'VIDEO_TOO_LONG';

export const MEDIA_ERROR_MESSAGES: Record<MediaErrorCode, string> = {
  NO_AUDIO_STREAM:
    'This video does not contain an audio track. Please upload a video with audio.',
  NO_VIDEO_STREAM:
    'This file does not contain a video stream. Please upload a valid video file.',
  INVALID_MEDIA_FILE:
    'This file could not be read as a valid media file. It may be corrupted or use an ' +
    'unsupported format.',
  AUDIO_EXTRACTION_FAILED:
    'Audio extraction failed even though an audio stream was detected. You can retry; if it ' +
    'keeps failing, try re-uploading the source file.',
  AUDIO_RECOVERY_FAILED:
    'We found an audio track, but parts of it are damaged or unsupported. Please re-export the ' +
    'video or upload another copy.',
  STORAGE_OR_DOWNLOAD_CORRUPTION:
    'The uploaded video could not be read back correctly from storage. You can retry; if it ' +
    'keeps failing, re-upload the source file.',
  VIDEO_TOO_LONG:
    'This video is longer than the 2-hour limit. Please upload a video shorter than 2 hours.'
};

// A media failure is retryable only when a fresh attempt against the *same* stored object could
// plausibly succeed (a transient ffmpeg hiccup, a bad download). Failures that describe the
// source file itself (no audio/video stream, unparsable container, audio damaged beyond the one
// tolerant recovery attempt) will fail identically forever.
export const MEDIA_ERROR_RETRYABLE: Record<MediaErrorCode, boolean> = {
  NO_AUDIO_STREAM: false,
  NO_VIDEO_STREAM: false,
  INVALID_MEDIA_FILE: false,
  AUDIO_EXTRACTION_FAILED: true,
  AUDIO_RECOVERY_FAILED: false,
  STORAGE_OR_DOWNLOAD_CORRUPTION: true,
  VIDEO_TOO_LONG: false
};

export class MediaProcessingError extends Error {
  readonly code: MediaErrorCode;
  readonly retryable: boolean;

  constructor(code: MediaErrorCode, cause?: unknown) {
    super(MEDIA_ERROR_MESSAGES[code], cause !== undefined ? { cause } : undefined);
    this.name = 'MediaProcessingError';
    this.code = code;
    this.retryable = MEDIA_ERROR_RETRYABLE[code];
  }
}

export function isMediaProcessingError(error: unknown): error is MediaProcessingError {
  return error instanceof MediaProcessingError;
}

export function isRetryableErrorCode(code: string | null | undefined): boolean {
  if (!code) return true;
  return MEDIA_ERROR_RETRYABLE[code as MediaErrorCode] ?? true;
}

type ProbeStream = {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  bit_rate?: string;
  duration?: string;
};

type ProbeFormat = { duration?: string; bit_rate?: string; format_name?: string };

export type ProbeOutput = { streams?: ProbeStream[]; format?: ProbeFormat };

export function parseFrameRate(value?: string) {
  if (!value) return undefined;
  const [numerator, denominator = 1] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return undefined;
  }
  return numerator / denominator;
}

export type MediaProbeResult = {
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  videoStreamIndex: number | null;
  audioStreamIndex: number | null;
  durationSec: number | null;
  /** Video stream end when known; containers can have a longer trailing audio stream. */
  videoDurationSec: number | null;
  formatName: string | null;
  fps: number | undefined;
  width: number | null;
  height: number | null;
  bitrate: bigint | undefined;
};

/**
 * Probes a downloaded media file with ffprobe and classifies its streams.
 *
 * Only throws (INVALID_MEDIA_FILE) when ffprobe itself cannot make sense of the file. Whether the
 * file has a usable video/audio stream is a business decision the caller makes from the returned
 * flags, not something this function decides.
 */
export async function probeMedia(filePath: string, options?: { timeoutMs?: number; localOnly?: boolean }): Promise<MediaProbeResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', ...(options?.localOnly ? ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm'] : []),
      '-show_streams', '-show_format', '-of', 'json', filePath
    ], { maxBuffer: 10 * 1024 * 1024, timeout: options?.timeoutMs }));
  } catch (error) {
    throw new MediaProcessingError('INVALID_MEDIA_FILE', error);
  }

  let probe: ProbeOutput;
  try {
    probe = JSON.parse(stdout) as ProbeOutput;
  } catch (error) {
    throw new MediaProcessingError('INVALID_MEDIA_FILE', error);
  }

  const streams = probe.streams ?? [];
  if (streams.length === 0 && !probe.format) {
    throw new MediaProcessingError('INVALID_MEDIA_FILE');
  }

  const videoStream = streams.find((item) => item.codec_type === 'video');
  const audioStream = streams.find((item) => item.codec_type === 'audio');
  const durationSec = Number(probe.format?.duration);
  const videoDurationSec = Number(videoStream?.duration);
  const bitrate = probe.format?.bit_rate ?? videoStream?.bit_rate;

  return {
    hasVideo: !!videoStream,
    hasAudio: !!audioStream,
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    videoStreamIndex: typeof videoStream?.index === 'number' ? videoStream.index : null,
    audioStreamIndex: typeof audioStream?.index === 'number' ? audioStream.index : null,
    durationSec: Number.isFinite(durationSec) ? durationSec : null,
    videoDurationSec: Number.isFinite(videoDurationSec) && videoDurationSec > 0
      ? videoDurationSec : null,
    formatName: probe.format?.format_name ?? null,
    fps: parseFrameRate(videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate),
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    bitrate: bitrate && /^\d+$/.test(bitrate) ? BigInt(bitrate) : undefined
  };
}

const AUDIO_CORRUPTION_PATTERNS = [
  /malformed/i, /corrupt/i, /invalid data found/i, /error while decoding/i,
  /header missing/i, /concealing bit/i, /error submitting a packet/i, /non-monotonic dts/i
];

function looksLikeCorruptAudio(stderr: string): boolean {
  return AUDIO_CORRUPTION_PATTERNS.some((pattern) => pattern.test(stderr));
}

// Bounds how much ffmpeg stderr ever reaches logs/DB rows: a head and tail excerpt plus the
// original length, never the raw (potentially hundreds-of-KB) blob.
function boundedStderrExcerpt(stderr: string, maxChars = 4000): { excerpt: string; length: number } {
  const length = stderr.length;
  if (length <= maxChars) return { excerpt: stderr, length };
  const headLen = Math.floor(maxChars / 2);
  const tailLen = maxChars - headLen;
  return {
    excerpt: `${stderr.slice(0, headLen)}\n...[truncated ${length - maxChars} chars]...\n${stderr.slice(-tailLen)}`,
    length
  };
}

type FfmpegAttempt = { exitOk: boolean; stderr: string; error?: unknown };

// ffmpeg's AAC decoder often *conceals* corrupt packets and still exits 0, silently producing a
// short/degraded WAV rather than failing — so stderr is captured on the success path too, and the
// caller decides whether the output is usable from the actual decoded duration, not the exit code.
async function runFfmpegExtraction(
  inputPath: string, outputPath: string, extraArgs: string[]
): Promise<FfmpegAttempt> {
  try {
    const { stderr } = await execFileAsync('ffmpeg', [
      '-v', 'error', '-y', ...extraArgs, '-i', inputPath, '-map', '0:a:0', '-vn', '-ac', '1',
      '-ar', '16000', '-c:a', 'pcm_s16le', outputPath
    ], { maxBuffer: 10 * 1024 * 1024 });
    return { exitOk: true, stderr: stderr ?? '' };
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown })?.stderr === 'string'
      ? (error as { stderr: string }).stderr
      : '';
    return { exitOk: false, stderr, error };
  }
}

type WavProbeResult = { channels: number | null; sampleRate: number | null; durationSec: number | null };

async function probeWavAudio(path: string): Promise<WavProbeResult> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path
    ], { maxBuffer: 10 * 1024 * 1024 });
    const probe = JSON.parse(stdout) as {
      streams?: Array<{ codec_type?: string; channels?: number; sample_rate?: string }>;
      format?: { duration?: string };
    };
    const audioStream = (probe.streams ?? []).find((item) => item.codec_type === 'audio');
    const durationSec = Number(probe.format?.duration);
    return {
      channels: audioStream?.channels ?? null,
      sampleRate: audioStream?.sample_rate ? Number(audioStream.sample_rate) : null,
      durationSec: Number.isFinite(durationSec) ? durationSec : null
    };
  } catch {
    return { channels: null, sampleRate: null, durationSec: null };
  }
}

/**
 * Whether an extracted WAV is actually usable, not just that ffmpeg exited 0 — ffmpeg's AAC
 * decoder can conceal corrupt packets and still exit cleanly while producing a short/degraded
 * file. Checks the file is non-trivial, mono, ~16kHz, has a positive duration, and (when the
 * source duration is known) covers a large enough fraction of the source that transcription
 * would still be meaningful.
 */
async function validateExtractedAudio(
  outputPath: string, sourceDurationSec: number | null | undefined
): Promise<boolean> {
  let sizeBytes: number;
  try {
    sizeBytes = (await stat(outputPath)).size;
  } catch {
    return false;
  }
  if (sizeBytes < 2048) return false;

  const probe = await probeWavAudio(outputPath);
  if (probe.channels !== 1) return false;
  if (!probe.sampleRate || Math.abs(probe.sampleRate - 16000) > 100) return false;
  if (!probe.durationSec || probe.durationSec <= 0) return false;

  if (typeof sourceDurationSec === 'number' && Number.isFinite(sourceDurationSec) &&
    sourceDurationSec > 2) {
    const coverage = probe.durationSec / sourceDurationSec;
    if (coverage < 0.5) return false;
  }

  return true;
}

export type AudioExtractionDiagnostics = {
  recoveryAttempted: boolean;
  recoverySucceeded: boolean;
  primaryStderrExcerpt?: string;
  primaryStderrLength?: number;
};

/**
 * Extracts a 16kHz mono PCM WAV from the first audio stream of the given input file. Callers are
 * responsible for checking `hasAudio` beforehand so this never gets called on a source that was
 * already known to have no audio track (that case is NO_AUDIO_STREAM, decided by the caller).
 *
 * The primary extraction's output is always validated — a zero exit code alone is not proof the
 * audio is usable, since ffmpeg can conceal corrupt AAC packets and exit cleanly with a truncated
 * result. If the primary attempt fails outright or its output doesn't validate, this makes exactly
 * one tolerant recovery attempt (ffmpeg error-tolerant decode flags) rather than retrying
 * indefinitely, and validates that output too before accepting it. `sourceDurationSec` (when
 * known) is used to reject an extraction that only captured a small fraction of the source.
 */
export async function extractAudioToWav(
  inputPath: string, outputPath: string, sourceDurationSec?: number | null
): Promise<AudioExtractionDiagnostics> {
  const primary = await runFfmpegExtraction(inputPath, outputPath, []);
  const { excerpt: primaryStderrExcerpt, length: primaryStderrLength } =
    boundedStderrExcerpt(primary.stderr);

  if (primary.exitOk && await validateExtractedAudio(outputPath, sourceDurationSec)) {
    return { recoveryAttempted: false, recoverySucceeded: false, primaryStderrExcerpt, primaryStderrLength };
  }

  // The primary attempt either failed to run or produced unusable output. Only worth a recovery
  // attempt when that looks like decodable-but-damaged audio; a hard failure with no corruption
  // signature (bad args, missing codec, disk full) will just fail identically again.
  if (!primary.exitOk && !looksLikeCorruptAudio(primary.stderr)) {
    throw new MediaProcessingError('AUDIO_EXTRACTION_FAILED', {
      primaryStderrExcerpt, primaryStderrLength
    });
  }

  const recovery = await runFfmpegExtraction(inputPath, outputPath, [
    '-err_detect', 'ignore_err', '-fflags', '+discardcorrupt+genpts'
  ]);
  const { excerpt: recoveryStderrExcerpt, length: recoveryStderrLength } =
    boundedStderrExcerpt(recovery.stderr);

  const recoveryUsable = recovery.exitOk && await validateExtractedAudio(outputPath, sourceDurationSec);
  if (!recoveryUsable) {
    throw new MediaProcessingError('AUDIO_RECOVERY_FAILED', {
      primaryStderrExcerpt, primaryStderrLength, recoveryAttempted: true, recoverySucceeded: false,
      recoveryStderrExcerpt, recoveryStderrLength
    });
  }

  return {
    recoveryAttempted: true, recoverySucceeded: true, primaryStderrExcerpt, primaryStderrLength
  };
}

/**
 * Whether previously persisted probe metadata is trustworthy enough to skip re-probing.
 * Rows written before stream-level detection existed (or any row missing a flag) are treated as
 * untrustworthy so they get re-probed instead of silently reusing an incomplete legacy record.
 */
export function hasTrustworthyMediaMetadata(video: {
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  codec?: string | null;
  hasVideo?: boolean | null;
  hasAudio?: boolean | null;
}): boolean {
  return (
    video.hasVideo != null &&
    video.hasAudio != null &&
    video.duration != null &&
    video.width != null &&
    video.height != null &&
    video.codec != null
  );
}

/**
 * Detects whether the locally downloaded copy of a stored object does not match its recorded
 * size, which points at storage/download corruption rather than a genuine property of the source
 * media (e.g. a video that never had audio).
 */
export function isStorageCorrupted(sizes: {
  storedSizeBytes?: number | null;
  remoteSizeBytes?: number | null;
  downloadedSizeBytes: number;
}): boolean {
  if (!Number.isFinite(sizes.downloadedSizeBytes) || sizes.downloadedSizeBytes <= 0) return true;
  const known = [sizes.storedSizeBytes, sizes.remoteSizeBytes, sizes.downloadedSizeBytes]
    .filter((value): value is number => Number.isFinite(value as number) && (value as number) >= 0);
  return known.length > 1 && new Set(known).size > 1;
}
