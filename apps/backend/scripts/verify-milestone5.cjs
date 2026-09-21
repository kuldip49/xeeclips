const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const { Client } = require('minio');
const { VideoProcessorService } = require('../dist/modules/processing/video-processor.service');
const { StorageService } = require('../dist/modules/storage/storage.service');
const { PROCESS_VIDEO_JOB } = require('../dist/modules/processing/processing.constants');

const prisma = new PrismaClient();
const storage = new StorageService();
const processor = new VideoProcessorService(prisma, storage);
const minio = new Client({
  endPoint: process.env.MINIO_ENDPOINT,
  port: Number(process.env.MINIO_PORT),
  useSSL: false,
  accessKey: process.env.MINIO_ROOT_USER,
  secretKey: process.env.MINIO_ROOT_PASSWORD
});

let project;
let bucket;
let objectKey;
let audioObjectKey;

async function main() {
  const source = await prisma.video.findFirstOrThrow({
    where: { transcript: { isNot: null } },
    orderBy: { sizeBytes: 'asc' }
  });
  project = await prisma.project.create({ data: { name: 'Milestone 5 disposable verification' } });
  bucket = source.bucket;
  objectKey = `projects/${project.id}/verification.mp4`;
  await minio.copyObject(bucket, objectKey, `/${bucket}/${source.objectKey}`);

  const video = await prisma.video.create({
    data: {
      projectId: project.id,
      originalName: 'verification.mp4',
      objectKey,
      bucket,
      mimeType: source.mimeType,
      sizeBytes: source.sizeBytes,
      processingJobs: { create: {} }
    },
    include: { processingJobs: true }
  });
  audioObjectKey = `projects/${project.id}/videos/${video.id}/audio.wav`;
  const progress = [];
  await processor.process({
    name: PROCESS_VIDEO_JOB,
    data: { processingJobId: video.processingJobs[0].id, videoId: video.id },
    updateProgress: async (value) => { progress.push(value); }
  });

  const stored = await prisma.transcriptChunk.findMany({
    where: { videoId: video.id },
    orderBy: { position: 'asc' },
    include: { analysis: true }
  });
  const job = await prisma.processingJob.findUniqueOrThrow({
    where: { id: video.processingJobs[0].id }
  });
  assert.ok(stored.length > 0);
  assert.ok(stored.every((chunk) => chunk.analysis));
  assert.equal(new Set(stored.map((chunk) => chunk.analysis.chunkId)).size, stored.length);
  for (const { analysis } of stored) {
    for (const field of [
      'questionCount', 'exclamationCount', 'keywordDensity', 'averageSentenceLength',
      'speechRate', 'informationDensity', 'readabilityScore'
    ]) assert.ok(Number.isFinite(analysis[field]), `${field} must be finite`);
  }
  assert.deepEqual(progress, [5, 20, 35, 50, 60, 90, 95, 97, 99, 100]);
  assert.equal(job.status, 'COMPLETED');
  assert.equal(job.progress, 100);
  console.log(JSON.stringify({ chunks: stored.length, analyses: stored.length, progress }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (audioObjectKey) await minio.removeObject(bucket, audioObjectKey).catch(() => undefined);
  if (objectKey) await minio.removeObject(bucket, objectKey).catch(() => undefined);
  if (project) await prisma.project.delete({ where: { id: project.id } }).catch(() => undefined);
  await processor.onModuleDestroy();
  await prisma.$disconnect();
  console.log('Disposable Milestone 5 verification data removed.');
});
