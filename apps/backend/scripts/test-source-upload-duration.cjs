// Real FFmpeg media and HTTP uploads at the source-duration boundary.
// Only persistence, storage and queue side effects are in-memory; no database/provider is used.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtemp, readFile, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { VideosService } = require('../dist/modules/videos/videos.service');
const { VideosController } = require('../dist/modules/videos/videos.controller');
const { VideoUploadSessionService } = require('../dist/modules/videos/video-upload-session.service');
const { probeMedia, MediaProcessingError } = require('../dist/modules/processing/media-probe');
const { VIDEO_TOO_LONG_MESSAGE } = require('../dist/modules/processing/clip-selection-policy');

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'source-duration-test-'));
  process.env.UPLOAD_STAGING_DIR = root;
  const counts = { stored: 0, created: 0, reserved: 0, enqueued: 0 };
  const service = Object.create(VideosService.prototype);
  service.prisma = {
    project: { findUnique: async () => ({ id: 'duration-test' }),
      findUniqueOrThrow: async () => ({ userId: 'owner' }) },
    video: { create: async ({ data }) => {
      counts.created++;
      return { ...data, id: `video-${counts.created}`, processingJobs: [{ id: `job-${counts.created}` }] };
    } },
    processingJob: { update: async () => ({}) }, creditReservation: { update: async () => ({}) },
    $transaction: async fn => fn(service.prisma)
  };
  service.storage = {
    uploadFile: async ({ filePath }) => {
      assert.ok((await stat(filePath)).size > 0);
      counts.stored++; return { bucket: 'test', objectKey: 'test' };
    },
    uploadVideo: async ({ buffer }) => {
      assert.ok(buffer.length > 0);
      counts.stored++; return { bucket: 'test', objectKey: 'test' };
    }
  };
  Object.defineProperty(service, 'usage', { value: { reserve: async () => { counts.reserved++; } } });
  service.processingQueue = { enqueue: async () => { counts.enqueued++; } };
  const videos = { createFromUpload: (...args) => service.createFromUpload(...args) };
  const sessions = new VideoUploadSessionService(videos);
  class DurationTestModule {}
  Module({ controllers: [VideosController], providers: [
    { provide: VideosService, useValue: videos },
    { provide: VideoUploadSessionService, useValue: sessions }
  ] })(DurationTestModule);
  let app;
  try {
    const fixtures = new Map();
    for (const duration of [7201, 10800, 10801]) {
      const path = join(root, `${duration}.mp4`);
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1',
        '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', String(duration),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '8k', '-movflags', '+faststart', path], { timeout: 120000 });
      const media = await probeMedia(path);
      assert.equal(media.durationSec, duration, 'real media has the exact boundary duration');
      assert.equal(media.hasVideo, true); assert.equal(media.hasAudio, true);
      fixtures.set(duration, await readFile(path));
    }
    app = await NestFactory.create(DurationTestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    const generation = { requestedClipCount: 1, outputStyle: 'NORMAL',
      generation: { templateId: 'AUTOMATIC_RAW' } };
    const settings = { aiMode: 'FALLBACK_ONLY', processingType: 'NORMAL_CLIPS',
      targetPlatform: 'YOUTUBE_SHORTS', generationRequest: JSON.stringify(generation) };
    for (const [duration, buffer] of fixtures) {
      const before = { ...counts };
      const form = new FormData();
      form.set('file', new Blob([buffer], { type: 'video/mp4' }), `${duration}.mp4`);
      for (const [key, value] of Object.entries(settings)) form.set(key, value);
      const response = await fetch(`${base}/projects/duration-test/videos`, { method: 'POST', body: form });
      const body = await response.json();
      if (duration <= 10800) {
        assert.equal(response.status, 201, JSON.stringify(body));
        for (const key of Object.keys(counts)) assert.equal(counts[key], before[key] + 1, key);
      } else {
        assert.equal(response.status, 400);
        assert.deepEqual(body, { code: 'VIDEO_TOO_LONG', message: VIDEO_TOO_LONG_MESSAGE });
        assert.deepEqual(counts, before, 'over-limit multipart creates no storage, job or credit reservation');
      }
    }
    for (const duration of [10800, 10801]) {
      const buffer = fixtures.get(duration), before = { ...counts };
      const created = await fetch(`${base}/projects/duration-test/videos/upload-sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...settings, name: `${duration}.mp4`, mimeType: 'video/mp4', size: buffer.length })
      });
      assert.equal(created.status, 201);
      const session = await created.json();
      for (let i = 0; i < session.chunks; i++) {
        const response = await fetch(`${base}/upload-sessions/${session.id}/chunks/${i}`, {
          method: 'PUT', headers: { 'content-type': 'application/octet-stream' },
          body: buffer.subarray(i * session.chunkBytes, (i + 1) * session.chunkBytes)
        });
        assert.equal(response.status, 200);
      }
      const complete = () => fetch(`${base}/upload-sessions/${session.id}/complete`, { method: 'POST' });
      const response = await complete();
      const body = await response.json();
      if (duration === 10800) {
        assert.equal(response.status, 201, JSON.stringify(body));
        assert.deepEqual(await (await complete()).json(), body);
        for (const key of Object.keys(counts)) assert.equal(counts[key], before[key] + 1,
          `${key}: repeated completion must not duplicate the upload or reservation`);
      } else {
        assert.equal(response.status, 400);
        assert.equal(body.code, 'VIDEO_TOO_LONG');
        assert.deepEqual(counts, before, 'over-limit assembled upload has no side effects');
      }
    }
    // Legacy in-memory uploads share the same probe and guard.
    for (const duration of [10800, 10801]) {
      const buffer = fixtures.get(duration), before = { ...counts };
      const upload = () => service.createFromUpload('duration-test', {
        buffer, size: buffer.length, mimetype: 'video/mp4', originalname: `${duration}.mp4`
      }, 'FALLBACK_ONLY', 'NORMAL_CLIPS', undefined, 'YOUTUBE_SHORTS', undefined, generation);
      if (duration === 10800) {
        await upload();
        for (const key of Object.keys(counts)) assert.equal(counts[key], before[key] + 1);
      } else {
        await assert.rejects(upload(), error => error.getResponse().code === 'VIDEO_TOO_LONG');
        assert.deepEqual(counts, before);
      }
    }
    assert.equal(new MediaProcessingError('VIDEO_TOO_LONG').message, VIDEO_TOO_LONG_MESSAGE);
    assert.equal(new MediaProcessingError('VIDEO_TOO_LONG').retryable, false);
    console.log('PASS real 2h+1s/3h/3h+1s media: multipart, chunk completion, buffer uploads, one reservation per accepted upload, zero side effects on refusal.');
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
