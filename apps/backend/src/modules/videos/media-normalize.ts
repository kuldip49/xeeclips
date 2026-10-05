import { spawn } from 'child_process';
import { stat } from 'fs/promises';
import { join } from 'path';
import { MediaProbeResult, probeMedia } from '../processing/media-probe';
import { ImportError, importFailure } from './youtube-import.adapter';

export type NormalizedMedia = {
  filePath: string; size: number; probe: MediaProbeResult;
  action: 'none' | 'remux' | 'transcode';
};

/** The checks every imported source must pass before it is stored. */
export function validateImportedProbe(probe: MediaProbeResult, size: number, label: string) {
  const problems: string[] = [];
  if (!size) problems.push('empty file');
  if (!probe.hasVideo) problems.push('no video stream');
  if (!probe.hasAudio) problems.push('no audio stream');
  if (!probe.durationSec || probe.durationSec <= 0) problems.push('no duration');
  if (!probe.width || !probe.height || probe.width < 16 || probe.height < 16 ||
      probe.width > 8192 || probe.height > 8192) problems.push(`dimensions ${probe.width}x${probe.height}`);
  if (!probe.videoCodec || !probe.audioCodec) problems.push('unknown codec');
  if (!probe.formatName) problems.push('unknown container');
  if (problems.length) {
    const code = !probe.hasVideo ? 'NO_VIDEO_FORMAT' : !probe.hasAudio ? 'NO_AUDIO_FORMAT' : 'MEDIA_INVALID';
    throw importFailure(code, `${label}: ${problems.join(', ')}`);
  }
}

/**
 * Turns whatever YouTube provided (MP4, WebM, MKV; H.264/VP9/AV1; AAC/Opus) into the canonical
 * source an upload would normally be: H.264 + AAC in MP4 with faststart. Streams that already
 * match are copied (a remux); only mismatching streams are transcoded. From here on, nothing
 * downstream can tell the source came from YouTube.
 */
export async function normalizeImportedMedia(inputPath: string, outputDir: string,
  signal: AbortSignal): Promise<NormalizedMedia> {
  const inputProbe = await probeMedia(inputPath).catch(() => {
    throw importFailure('MEDIA_INVALID', 'ffprobe could not read the retrieved file');
  });
  validateImportedProbe(inputProbe, (await stat(inputPath)).size, 'retrieved');
  const videoOk = inputProbe.videoCodec === 'h264';
  const audioOk = inputProbe.audioCodec === 'aac';
  const containerOk = /(^|,)mp4(,|$)/.test(inputProbe.formatName ?? '') || /mov,mp4/.test(inputProbe.formatName ?? '');
  if (videoOk && audioOk && containerOk) {
    return { filePath: inputPath, size: (await stat(inputPath)).size, probe: inputProbe, action: 'none' };
  }
  const outputPath = join(outputDir, 'canonical.mp4');
  await runFfmpeg(['-hide_banner', '-v', 'error', '-y', '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a:0', '-sn', '-dn',
    ...(videoOk ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']),
    ...(audioOk ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']),
    '-movflags', '+faststart', outputPath], signal);
  const size = (await stat(outputPath)).size;
  const probe = await probeMedia(outputPath).catch(() => {
    throw importFailure('MEDIA_INVALID', 'ffprobe could not read the normalized file');
  });
  validateImportedProbe(probe, size, 'normalized');
  // Normalization must never shorten the source.
  if (inputProbe.durationSec && probe.durationSec && probe.durationSec < inputProbe.durationSec - 2)
    throw importFailure('MEDIA_INVALID', `normalized ${probe.durationSec}s < retrieved ${inputProbe.durationSec}s`);
  return { filePath: outputPath, size, probe, action: videoOk && audioOk ? 'remux' : 'transcode' };
}

function runFfmpeg(args: string[], signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const onAbort = () => child.kill('SIGKILL');
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('error', (error) => { signal.removeEventListener('abort', onAbort);
      reject(importFailure('MEDIA_INVALID', `ffmpeg failed to start: ${error.message}`)); });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(signal.reason instanceof ImportError ? signal.reason
        : new ImportError('IMPORT_CANCELLED', 'Import cancelled.'));
      else if (code !== 0) reject(importFailure('MEDIA_INVALID', `ffmpeg exit ${code}: ${stderr.trim().slice(-800)}`));
      else resolve();
    });
  });
}
