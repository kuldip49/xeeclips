const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const { VideoProcessorService } = require('../dist/modules/processing/video-processor.service');
const { StorageService } = require('../dist/modules/storage/storage.service');
const { PROCESS_VIDEO_JOB } = require('../dist/modules/processing/processing.constants');

const prisma = new PrismaClient();
const processor = new VideoProcessorService(prisma, new StorageService());
let project;

const metrics = (position) => ({
  questionCount: position % 5 === 0 ? 1 : 0,
  exclamationCount: position % 5 === 0 ? 1 : 0,
  keywordDensity: 10 + position % 4,
  averageSentenceLength: 11,
  speechRate: 140 + position % 10,
  informationDensity: 68 + position % 8,
  readabilityScore: 65 + position % 12
});

async function createAnalyzedVideo(name, chunkCount, chunkDuration) {
  const video = await prisma.video.create({
    data: {
      projectId: project.id,
      originalName: `${name}.mp4`,
      objectKey: `verification/${project.id}/${name}.mp4`,
      bucket: 'verification',
      mimeType: 'video/mp4',
      sizeBytes: 1n,
      duration: chunkCount * chunkDuration,
      fps: 30,
      width: 1280,
      height: 720,
      codec: 'h264',
      bitrate: 1000n,
      audioBucket: 'verification',
      audioObjectKey: `verification/${project.id}/${name}.wav`,
      processingJobs: { create: {} },
      transcript: {
        create: {
          text: 'Pre-analyzed verification transcript.',
          segments: { create: { position: 0, start: 0, end: 1, text: 'Verification.' } }
        }
      }
    },
    include: { processingJobs: true }
  });

  for (let position = 0; position < chunkCount; position += 1) {
    const startTime = position * chunkDuration;
    const endTime = startTime + chunkDuration;
    const text = position % 5 === 0
      ? `Why does lesson ${position} change everything? Concept${position} signal${position} pattern${position} reveals the answer and why this practical result matters!`
      : `Lesson ${position} explains concept${position}, method${position}, example${position}, outcome${position}, and insight${position} that the audience can use today.`;
    await prisma.transcriptChunk.create({
      data: {
        videoId: video.id,
        position,
        startTime,
        endTime,
        duration: chunkDuration,
        text,
        wordCount: text.split(/\s+/u).length,
        analysis: { create: metrics(position) }
      }
    });
  }

  await processor.process({
    name: PROCESS_VIDEO_JOB,
    data: { processingJobId: video.processingJobs[0].id, videoId: video.id },
    updateProgress: async () => undefined
  });
  return video;
}

async function fetchCandidates(videoId, limit) {
  const response = await fetch(`http://localhost:4000/videos/${videoId}/clip-candidates?limit=${limit}`);
  assert.equal(response.status, 200);
  return response.json();
}

async function main() {
  project = await prisma.project.create({ data: { name: 'Milestone 7 disposable verification' } });
  const smallVideo = await createAnalyzedVideo('small', 6, 5);
  const longVideo = await createAnalyzedVideo('long', 120, 5);

  const [smallCandidates, allLongCandidates, top5, top10, stages] = await Promise.all([
    prisma.clipCandidate.findMany({ where: { videoId: smallVideo.id } }),
    prisma.clipCandidate.findMany({
      where: { videoId: longVideo.id, reject: false, rank: { not: null } },
      orderBy: [{ overallScore: 'desc' }, { rank: 'asc' }]
    }),
    fetchCandidates(longVideo.id, 5),
    fetchCandidates(longVideo.id, 10),
    prisma.videoProcessingStage.findMany({ where: { videoId: longVideo.id } })
  ]);

  assert.ok(smallCandidates.length > 0, 'small video should create a candidate');
  assert.ok(allLongCandidates.length >= 10, 'long video should create at least 10 candidates');
  assert.ok(allLongCandidates.every((candidate, index) => index === 0 ||
    allLongCandidates[index - 1].overallScore >= candidate.overallScore));
  assert.equal(top5.length, 5);
  assert.equal(top10.length, 10);
  assert.deepEqual(top5.map(({ id }) => id), top10.slice(0, 5).map(({ id }) => id));
  assert.equal(stages.find(({ stage }) => stage === 'GENERATE_CLIP_CANDIDATES').status, 'COMPLETED');
  assert.equal(stages.find(({ stage }) => stage === 'VISUAL_ANALYSIS').status, 'SKIPPED');

  const beforeRetry = await prisma.clipCandidate.findMany({
    where: { videoId: longVideo.id }, select: { id: true }, orderBy: { id: 'asc' }
  });
  await prisma.processingJob.update({
    where: { id: longVideo.processingJobs[0].id }, data: { status: 'FAILED' }
  });
  await processor.process({
    name: PROCESS_VIDEO_JOB,
    data: { processingJobId: longVideo.processingJobs[0].id, videoId: longVideo.id },
    updateProgress: async () => undefined
  });
  const afterRetry = await prisma.clipCandidate.findMany({
    where: { videoId: longVideo.id }, select: { id: true }, orderBy: { id: 'asc' }
  });
  assert.deepEqual(afterRetry, beforeRetry, 'retry must reuse candidates without duplicates');

  console.log(JSON.stringify({
    smallVideoCandidates: smallCandidates.length,
    longVideoCandidates: allLongCandidates.length,
    limit5: top5.length,
    limit10: top10.length,
    bestScore: top5[0].overallScore,
    retryDuplicateCandidates: 0,
    visualIntelligence: 'SKIPPED'
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (project) await prisma.project.delete({ where: { id: project.id } }).catch(() => undefined);
  await processor.onModuleDestroy();
  await prisma.$disconnect();
  console.log('Disposable Milestone 7 verification data removed.');
});
