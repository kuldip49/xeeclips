// Step 12: reference video -> measured editing PRINCIPLES -> our styles.
//
// A reference is analysed, never copied: nothing from it (frames, words,
// audio, its creator's content) is ever placed into the user's clips. We
// measure how it is edited - shape, cut rhythm, caption and hook placement,
// framing, colour, loudness, pacing - and map each measurement onto OUR
// supported component styles. What cannot be measured is listed as such.

import { postAiServiceJson } from '../../processing/ai-service-http';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { extname, join } from 'path';
import { promisify } from 'util';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { probeMedia } from '../../processing/media-probe';
import type { StyleCategory } from './creative-style-library';
import type { StyleChoice } from './creative-style-resolver';

const execFileAsync = promisify(execFile);
const MAX_REFERENCE_BYTES = 300 * 1024 * 1024;
const MAX_REFERENCE_SEC = 10 * 60;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.m4v', '.mkv']);

export type ReferenceMeasurements = {
  durationSec: number; width: number; height: number; aspectRatio: string;
  cutCount: number; cutsPerMinute: number; averageShotSec: number;
  brightness: number | null; saturation: number | null; contrast: number | null; warmth: number | null;
  letterboxed: boolean; contentRatio: number | null;
  loudnessLufs: number | null; silenceRatio: number | null;
  wordsPerMinute: number | null;
  faceShare: number | null; faceSize: number | null;
  captionBandY: number | null; captionFrameShare: number | null;
  hookTopTextInOpening: boolean | null;
};

export type DerivedReferenceStyle = {
  choices: Partial<Record<StyleCategory, StyleChoice>>;
  principles: string[];
  notMeasured: string[];
};

const nearestAspect = (width: number, height: number) => {
  const ratio = width / height;
  return [['9:16', 9 / 16], ['4:5', 0.8], ['1:1', 1], ['16:9', 16 / 9]]
    .sort((a, b) => Math.abs(Number(a[1]) - ratio) - Math.abs(Number(b[1]) - ratio))[0][0] as string;
};
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Pure: measurements -> our component styles + plain-language principles. */
export function deriveReferenceStyle(m: ReferenceMeasurements): DerivedReferenceStyle {
  const choices: Partial<Record<StyleCategory, StyleChoice>> = {};
  const principles: string[] = [];
  const notMeasured: string[] = ['zoom frequency and strength (no reliable zoom detector)',
    'transition types beyond hard cuts', 'music vs speech balance (no source separation)'];
  principles.push(`${m.aspectRatio} frame, ${m.cutsPerMinute.toFixed(1)} cuts/min (avg shot ${m.averageShotSec.toFixed(1)}s)`);

  // Pacing -> zoom energy is the closest supported lever to a fast-cut feel.
  choices.ZOOM = { styleId: m.cutsPerMinute >= 20 ? 'ZOOM_ENERGETIC' : m.cutsPerMinute >= 10
    ? 'ZOOM_BALANCED' : m.cutsPerMinute >= 4 ? 'ZOOM_SUBTLE' : 'ZOOM_DOC_PUSH' };
  principles.push(m.cutsPerMinute >= 20 ? 'Very fast pacing' : m.cutsPerMinute >= 10 ? 'Brisk pacing'
    : m.cutsPerMinute >= 4 ? 'Moderate pacing' : 'Slow, lingering shots');

  // Captions: where the text band sits, when there is one.
  if (m.captionBandY !== null && (m.captionFrameShare ?? 0) >= 0.3) {
    const y = Math.max(0.05, Math.min(0.85, m.captionBandY));
    choices.CAPTIONS = { styleId: y < 0.55 ? 'CAP_KARAOKE' : 'CAP_CLEAN_LOWER_THIRD', overrides: { y: Number(y.toFixed(3)) } };
    principles.push(`Burned-in captions on ${Math.round((m.captionFrameShare ?? 0) * 100)}% of frames, around ${Math.round(y * 100)}% down`);
  } else if (m.captionBandY === null) notMeasured.push('caption placement (text detection unavailable)');
  else principles.push('Little or no on-screen captioning');

  if (m.hookTopTextInOpening) {
    choices.HOOK = { styleId: 'HOOK_BOLD_QUESTION' };
    principles.push('Opens with headline text near the top');
  } else if (m.hookTopTextInOpening === null) notMeasured.push('hook treatment (text detection unavailable)');

  // Framing / background.
  if (m.letterboxed) {
    choices.BACKGROUND = { styleId: 'BG_BLACK' };
    principles.push('Video sits inside bars (letterboxed/fitted frame)');
  } else choices.BACKGROUND = { styleId: 'BG_FULL_FRAME' };
  if (m.faceShare !== null) {
    if (m.faceShare >= 0.5) {
      choices.FRAMING = { styleId: (m.faceSize ?? 0) >= 0.08 ? 'FRAME_TALKING_HEAD' : 'FRAME_FACE_PRIORITY' };
      principles.push(`Face-led framing (faces in ${Math.round(m.faceShare * 100)}% of frames)`);
    } else choices.FRAMING = { styleId: 'FRAME_AUTO' };
  } else notMeasured.push('face framing (face detection unavailable)');

  // Colour.
  if (m.saturation !== null && m.brightness !== null) {
    const id = m.saturation < 4 ? 'COLOR_BW' : m.saturation < 18 ? 'COLOR_MUTED'
      : m.brightness < 70 ? 'COLOR_DARK_DRAMATIC' : m.saturation > 45 ? 'COLOR_VIBRANT'
        : (m.warmth ?? 0) > 6 ? 'COLOR_WARM' : (m.warmth ?? 0) < -6 ? 'COLOR_COOL'
          : (m.contrast ?? 0) > 170 ? 'COLOR_HIGH_CONTRAST' : 'COLOR_CLEAN';
    choices.COLOR = { styleId: id };
    principles.push(`Colour: saturation ${m.saturation.toFixed(0)}, brightness ${m.brightness.toFixed(0)}` +
      (m.warmth !== null ? `, ${m.warmth > 6 ? 'warm' : m.warmth < -6 ? 'cool' : 'neutral'} tint` : ''));
  } else notMeasured.push('colour grading');

  // Audio: we can measure loudness and pauses, not what is music.
  if (m.silenceRatio !== null) {
    choices.AUDIO = { styleId: m.silenceRatio > 0.25 ? 'AUDIO_SPEECH_FIRST' : 'AUDIO_PODCAST_BALANCE' };
    principles.push(`${Math.round(m.silenceRatio * 100)}% near-silence`);
  }
  if (m.wordsPerMinute !== null) principles.push(`Speech pace ~${Math.round(m.wordsPerMinute)} words/min`);
  else notMeasured.push('speech pace (transcription unavailable)');
  return { choices, principles, notMeasured };
}

@Injectable()
export class ReferenceAnalysisService {
  private readonly logger = new Logger(ReferenceAnalysisService.name);
  private readonly aiServiceUrl = process.env.AI_SERVICE_URL ?? 'http://localhost:8000';

  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService) {}

  async get(id: string) {
    const reference = await this.prisma.referenceAsset.findUnique({ where: { id } });
    if (!reference) throw new NotFoundException('Reference not found');
    return { ...reference, sizeBytes: Number(reference.sizeBytes) };
  }

  async upload(file: Express.Multer.File, videoId: string | null) {
    const extension = extname(file.originalname).toLowerCase();
    if (!file.mimetype.startsWith('video/') && !VIDEO_EXTENSIONS.has(extension)) {
      throw new BadRequestException('A reference must be a video file');
    }
    if (file.size > MAX_REFERENCE_BYTES) throw new BadRequestException('A reference must be under 300 MB');
    return this.store(file.buffer, file.originalname, file.mimetype || 'video/mp4', videoId, null);
  }

  /** Only direct video-file URLs are supported; streaming sites are not downloaded. */
  async fromUrl(url: string, videoId: string | null) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new BadRequestException('That is not a valid URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new BadRequestException('Only http(s) URLs are supported');
    // The server fetches this URL, so internal hosts are refused (no SSRF into the stack).
    const host = parsed.hostname.toLowerCase();
    if (/^(?:localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/u.test(host) ||
      !host.includes('.') || ['minio', 'postgres', 'redis', 'backend', 'frontend', 'ai-service']
        .some((name) => host === name || host.startsWith(`${name}.`))) {
      throw new BadRequestException('That host is not allowed for reference downloads');
    }
    if (!VIDEO_EXTENSIONS.has(extname(parsed.pathname).toLowerCase())) {
      throw new BadRequestException('Only direct video-file links (.mp4, .mov, .webm) are supported; ' +
        'streaming-site pages are not downloaded. Upload the file instead.');
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) }).catch(() => null);
    if (!response?.ok || !response.body) throw new BadRequestException('The reference URL could not be downloaded');
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_REFERENCE_BYTES) throw new BadRequestException('A reference must be under 300 MB');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_REFERENCE_BYTES) throw new BadRequestException('A reference must be under 300 MB');
    return this.store(buffer, parsed.pathname.split('/').pop() || 'reference.mp4',
      response.headers.get('content-type') || 'video/mp4', videoId, url);
  }

  private async store(buffer: Buffer, name: string, mimeType: string, videoId: string | null,
    sourceUrl: string | null) {
    const id = randomUUID();
    const objectKey = `references/${id}/${name.replace(/[^\w.-]+/gu, '_').slice(0, 80)}`;
    const uploaded = await this.storage.uploadBuffer({ buffer, objectKey, mimeType });
    const reference = await this.prisma.referenceAsset.create({ data: { id, videoId,
      originalName: name.slice(0, 200), bucket: uploaded.bucket, objectKey: uploaded.objectKey,
      mimeType, sizeBytes: BigInt(buffer.length), sourceUrl, status: 'ANALYZING' } });
    void this.analyze(id).catch((error) => this.logger.warn(JSON.stringify({
      event: 'reference_analysis_failed', referenceId: id,
      error: error instanceof Error ? error.message : String(error) })));
    return { ...reference, sizeBytes: Number(reference.sizeBytes) };
  }

  async analyze(id: string) {
    const reference = await this.prisma.referenceAsset.findUniqueOrThrow({ where: { id } });
    const directory = await mkdtemp(join(tmpdir(), 'reference-'));
    try {
      const path = join(directory, `reference${extname(reference.objectKey) || '.mp4'}`);
      await this.storage.downloadToFile(reference.bucket, reference.objectKey, path);
      const measured = await this.measure(path, reference.bucket, reference.objectKey);
      const derived = deriveReferenceStyle(measured);
      await this.prisma.referenceAsset.update({ where: { id }, data: { status: 'READY', error: null,
        analysis: measured as unknown as Prisma.InputJsonValue,
        derivedStyle: derived as unknown as Prisma.InputJsonValue } });
      this.logger.log(JSON.stringify({ event: 'reference_analysed', referenceId: id,
        cutsPerMinute: measured.cutsPerMinute, aspect: measured.aspectRatio,
        choices: Object.keys(derived.choices) }));
      return derived;
    } catch (error) {
      await this.prisma.referenceAsset.update({ where: { id }, data: { status: 'FAILED',
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300) } });
      throw error;
    } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
  }

  /** Real measurements. Each optional source degrades to null, never to a guess. */
  async measure(path: string, bucket?: string, objectKey?: string): Promise<ReferenceMeasurements> {
    const probe = await probeMedia(path);
    if (!probe.hasVideo || !probe.width || !probe.height) throw new BadRequestException('The reference has no video stream');
    const durationSec = probe.durationSec ?? 0;
    if (durationSec > MAX_REFERENCE_SEC) throw new BadRequestException('A reference must be 10 minutes or shorter');
    const ffmpeg = async (args: string[]) => {
      const result = await execFileAsync('ffmpeg', ['-hide_banner', '-nostats', ...args],
        { maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 }).catch((error: { stderr?: string }) =>
        ({ stderr: error.stderr ?? '', stdout: '' }));
      return String(result.stderr ?? '');
    };
    // Cuts: scene changes over a downscaled stream.
    const scenes = await ffmpeg(['-i', path, '-an', '-vf', "scale=320:-2,select='gt(scene,0.32)',showinfo", '-f', 'null', '-']);
    const cutTimes = [...scenes.matchAll(/pts_time:([\d.]+)/gu)].map((match) => Number(match[1]))
      .filter((time) => time > 0.2 && time < durationSec - 0.2);
    const cutCount = cutTimes.length;
    // Colour: signalstats at 1 fps.
    const stats = await ffmpeg(['-i', path, '-an', '-vf', 'fps=1,scale=320:-2,signalstats,metadata=print', '-f', 'null', '-']);
    const series = (key: string) => [...stats.matchAll(new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.]+)`, 'gu'))]
      .map((match) => Number(match[1]));
    const avg = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    const brightness = avg(series('YAVG'));
    const saturation = avg(series('SATAVG'));
    const contrast = avg(series('YHIGH').map((high, index) => high - (series('YLOW')[index] ?? 0)));
    const warmth = (() => { const v = avg(series('VAVG')); const u = avg(series('UAVG'));
      return v !== null && u !== null ? v - u : null; })();
    // Letterbox: how much of the frame cropdetect keeps.
    const crop = await ffmpeg(['-i', path, '-an', '-t', '60', '-vf', 'cropdetect=24:2:0', '-f', 'null', '-']);
    const crops = [...crop.matchAll(/crop=(\d+):(\d+):\d+:\d+/gu)].map((match) =>
      (Number(match[1]) * Number(match[2])) / (probe.width! * probe.height!));
    const contentRatio = median(crops);
    // Audio: loudness and near-silence share.
    let loudnessLufs: number | null = null; let silenceRatio: number | null = null;
    if (probe.hasAudio) {
      const loud = await ffmpeg(['-i', path, '-vn', '-af', 'ebur128', '-f', 'null', '-']);
      const integrated = /I:\s+(-?[\d.]+) LUFS/u.exec(loud.split('Summary:').pop() ?? '');
      loudnessLufs = integrated ? Number(integrated[1]) : null;
      const silence = await ffmpeg(['-i', path, '-vn', '-af', 'silencedetect=n=-35dB:d=0.4', '-f', 'null', '-']);
      const silent = [...silence.matchAll(/silence_duration: ([\d.]+)/gu)].reduce((total, match) => total + Number(match[1]), 0);
      silenceRatio = durationSec ? Math.min(1, silent / durationSec) : null;
    }
    // Faces, text placement and speech pace from the AI service, when reachable.
    let faceShare: number | null = null; let faceSize: number | null = null;
    let captionBandY: number | null = null; let captionFrameShare: number | null = null;
    let hookTopTextInOpening: boolean | null = null; let wordsPerMinute: number | null = null;
    if (bucket && objectKey) {
      const analysis = await this.post('/edit-analysis', { bucket, object_key: objectKey, fps: 2 });
      const frames = Array.isArray(analysis?.frames) ? analysis!.frames as Array<Record<string, unknown>> : null;
      if (frames?.length) {
        const withFaces = frames.filter((frame) => Array.isArray(frame.faces) && frame.faces.length);
        faceShare = withFaces.length / frames.length;
        faceSize = median(withFaces.flatMap((frame) => (frame.faces as Array<Record<string, number>>)
          .map((face) => Number(face.w) * Number(face.h))).filter(Number.isFinite));
        const lowerBands = frames.map((frame) => (Array.isArray(frame.text_boxes)
          ? frame.text_boxes as Array<Record<string, number>> : [])
          .filter((box) => Number(box.y) > 0.3 && Number(box.w) > 0.25));
        const banded = lowerBands.filter((boxes) => boxes.length);
        captionFrameShare = banded.length / frames.length;
        captionBandY = median(banded.map((boxes) => Math.min(...boxes.map((box) => Number(box.y)))));
        const opening = frames.filter((frame) => Number(frame.t) <= 3);
        hookTopTextInOpening = opening.some((frame) => (Array.isArray(frame.text_boxes)
          ? frame.text_boxes as Array<Record<string, number>> : []).some((box) => Number(box.y) < 0.3 && Number(box.w) > 0.3));
      }
      const transcript = await this.post('/transcriptions', { bucket, object_key: objectKey });
      const segments = Array.isArray(transcript?.segments) ? transcript!.segments as Array<Record<string, unknown>> : null;
      if (segments && durationSec) {
        const words = segments.reduce((total, segment) => total + String(segment.text ?? '').split(/\s+/u).filter(Boolean).length, 0);
        wordsPerMinute = words / (durationSec / 60);
      }
    }
    return { durationSec, width: probe.width, height: probe.height,
      aspectRatio: nearestAspect(probe.width, probe.height), cutCount,
      cutsPerMinute: durationSec ? cutCount / (durationSec / 60) : 0,
      averageShotSec: durationSec / (cutCount + 1),
      brightness, saturation, contrast, warmth,
      letterboxed: contentRatio !== null && contentRatio < 0.8, contentRatio,
      loudnessLufs, silenceRatio, wordsPerMinute, faceShare, faceSize,
      captionBandY, captionFrameShare, hookTopTextInOpening };
  }

  private async post(path: string, body: Record<string, unknown>) {
    try {
      // Not fetch: its hidden 300 s headers timeout would cut off a long reference.
      const response = await postAiServiceJson(`${this.aiServiceUrl}${path}`, body, 10 * 60 * 1000);
      return response.ok ? await response.json() as Record<string, unknown> : null;
    } catch { return null; }
  }
}
