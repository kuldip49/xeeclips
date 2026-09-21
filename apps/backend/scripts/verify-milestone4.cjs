const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const { Client } = require('minio');
const { VideoProcessorService } = require('../dist/modules/processing/video-processor.service');
const { StorageService } = require('../dist/modules/storage/storage.service');
const prisma = new PrismaClient();
const storage = new StorageService();
const worker = new VideoProcessorService(prisma, storage);
const minio = new Client({ endPoint: process.env.MINIO_ENDPOINT, port: Number(process.env.MINIO_PORT), useSSL: false, accessKey: process.env.MINIO_ROOT_USER, secretKey: process.env.MINIO_ROOT_PASSWORD });
const base = 'http://localhost:4000';
let project;
let objectKey;
let audioKey;
let bucket;

async function main() {
  const source = await prisma.video.findFirstOrThrow({ where: { transcript: { isNot: null } }, orderBy: { sizeBytes: 'asc' } });
  project = await prisma.project.create({ data: { name: 'Milestone 4 disposable verification' } });
  bucket = source.bucket;
  objectKey = `projects/${project.id}/verification.mp4`;
  await minio.copyObject(bucket, objectKey, `/${bucket}/${source.objectKey}`);
  const video = await prisma.video.create({ data: { projectId: project.id, originalName: 'verification.mp4', objectKey, bucket, mimeType: source.mimeType, sizeBytes: source.sizeBytes, processingJobs: { create: {} } }, include: { processingJobs: true } });
  audioKey = `projects/${project.id}/videos/${video.id}/audio.wav`;
  assert.deepEqual(await (await fetch(`${base}/videos/${video.id}/chunks`)).json(), []);
  assert.equal((await fetch(`${base}/videos/missing-milestone4/chunks`)).status, 404);
  let previous;
  for (let run = 0; run < 2; run++) {
    const progress = [];
    await worker.process({ name: 'process-video', data: { videoId: video.id, processingJobId: video.processingJobs[0].id }, updateProgress: async (value) => {
      progress.push(value);
      if (value === 95) {
        const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: video.processingJobs[0].id } });
        assert.equal(job.status, 'PROCESSING');
      }
    } });
    assert.deepEqual(progress, [5, 20, 35, 50, 60, 90, 95, 100]);
    const response = await fetch(`${base}/videos/${video.id}/chunks`);
    assert.equal(response.status, 200);
    const chunks = await response.json();
    const transcript = await (await fetch(`${base}/videos/${video.id}/transcript`)).json();
    assert.ok(chunks.length > 0);
    assert.equal(chunks.map((chunk) => chunk.text).join(' '), transcript.segments.map((segment) => segment.text.trim()).filter(Boolean).join(' ').replace(/\s+/gu, ' '));
    chunks.forEach((chunk, index) => {
      assert.equal(chunk.videoId, video.id);
      assert.equal(chunk.position, index);
      assert.ok(Math.abs(chunk.duration - (chunk.endTime - chunk.startTime)) < 1e-9);
      assert.equal(chunk.wordCount, chunk.text.split(/\s+/u).length);
    });
    assert.equal(await prisma.transcriptChunk.count({ where: { videoId: video.id } }), chunks.length);
    const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: video.processingJobs[0].id } });
    assert.equal(job.status, 'COMPLETED');
    assert.equal(job.progress, 100);
    const stable = chunks.map(({ id, ...chunk }) => chunk);
    if (previous) assert.deepEqual(stable, previous);
    previous = stable;
    console.log(JSON.stringify({ run: run + 1, segments: transcript.segments.length, chunks: chunks.length, progress, status: job.status }));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (audioKey) await minio.removeObject(bucket, audioKey);
  if (objectKey) await minio.removeObject(bucket, objectKey);
  if (project) await prisma.project.delete({ where: { id: project.id } });
  await worker.onModuleDestroy();
  await prisma.$disconnect();
  console.log('Disposable verification records and copied media removed.');
});
