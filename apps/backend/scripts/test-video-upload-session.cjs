const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { VideoUploadSessionService } = require('../dist/modules/videos/video-upload-session.service');
const { VideosController } = require('../dist/modules/videos/videos.controller');
const { VideosService } = require('../dist/modules/videos/videos.service');

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'video-upload-session-test-'));
  process.env.UPLOAD_STAGING_DIR = root;
  const size = 21 * 1024 * 1024 + 17;
  const source = Buffer.alloc(size);
  for (let index = 0; index < size; index++) source[index] = index % 251;
  let calls = 0;
  const videos = {
    async createFromUpload(projectId, file, aiMode, processingType, aspectRatio,
      targetPlatform, _source, generationRequest) {
      calls++;
      assert.equal(projectId, 'project-test');
      assert.equal(file.originalname, 'sample.mp4');
      assert.equal(file.mimetype, 'video/mp4');
      assert.equal(file.size, size);
      assert.equal(aiMode, 'ONLINE');
      assert.equal(processingType, 'EDITED_CLIPS');
      assert.equal(aspectRatio, '9:16');
      assert.equal(targetPlatform, 'YOUTUBE_SHORTS');
      assert.equal(generationRequest, null);
      assert.equal(createHash('sha256').update(await readFile(file.path)).digest('hex'),
        createHash('sha256').update(source).digest('hex'));
      return { id: 'video-test', projectId };
    }
  };
  try {
    const sessions = new VideoUploadSessionService(videos);
    const session = await sessions.create('project-test', {
      name: 'sample.mp4', mimeType: 'video/mp4', size, aiMode: 'ONLINE',
      processingType: 'EDITED_CLIPS', aspectRatio: '9:16',
      targetPlatform: 'YOUTUBE_SHORTS'
    });
    assert.equal(session.chunkBytes, 20 * 1024 * 1024);
    assert.equal(session.chunks, 2);
    await assert.rejects(() => sessions.complete(session.id), /missing or incomplete/);
    await assert.rejects(() => sessions.writeChunk(session.id, '1',
      Readable.from(source.subarray(session.chunkBytes, size - 1))), /Incomplete upload chunk/);
    await assert.rejects(() => sessions.writeChunk(session.id, '2',
      Readable.from(Buffer.alloc(1))), /Invalid chunk index/);
    await sessions.writeChunk(session.id, '1', Readable.from(source.subarray(session.chunkBytes)));
    await sessions.writeChunk(session.id, '0', Readable.from(source.subarray(0, session.chunkBytes)));
    const result = await sessions.complete(session.id);
    assert.deepEqual(result, { id: 'video-test', projectId: 'project-test' });
    assert.deepEqual(await sessions.complete(session.id), result);
    assert.equal(calls, 1);

    class UploadTestModule {}
    Module({ controllers: [VideosController], providers: [
      { provide: VideosService, useValue: videos },
      { provide: VideoUploadSessionService, useValue: sessions }
    ] })(UploadTestModule);
    const app = await NestFactory.create(UploadTestModule, { logger: false });
    try {
      await app.listen(0, '127.0.0.1');
      const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
      const created = await fetch(`${base}/projects/project-test/videos/upload-sessions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'sample.mp4', mimeType: 'video/mp4', size,
          aiMode: 'ONLINE', processingType: 'EDITED_CLIPS', aspectRatio: '9:16',
          targetPlatform: 'YOUTUBE_SHORTS' })
      });
      assert.equal(created.status, 201);
      const remote = await created.json();
      for (let index = 0; index < remote.chunks; index++) {
        const chunk = source.subarray(index * remote.chunkBytes,
          Math.min(size, (index + 1) * remote.chunkBytes));
        const written = await fetch(`${base}/upload-sessions/${remote.id}/chunks/${index}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk
        });
        assert.equal(written.status, 200);
      }
      const retried = await fetch(`${base}/upload-sessions/${remote.id}/chunks/1`, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
        body: source.subarray(remote.chunkBytes)
      });
      assert.equal(retried.status, 200);
      const completed = await fetch(`${base}/upload-sessions/${remote.id}/complete`, {
        method: 'POST'
      });
      assert.equal(completed.status, 201);
      assert.deepEqual(await completed.json(), result);
    } finally { await app.close(); }
    assert.equal(calls, 2);
    console.log('Video upload session: streaming HTTP chunks, assembly and idempotent completion passed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
