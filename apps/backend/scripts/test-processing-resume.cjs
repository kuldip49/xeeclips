const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { Queue, Worker, QueueEvents } = require('bullmq');
const { Test } = require('@nestjs/testing');
const { VideoProcessorService } = require('../dist/modules/processing/video-processor.service');
const { ProcessingQueueService } = require('../dist/modules/processing/processing-queue.service');
const { VideosService } = require('../dist/modules/videos/videos.service');
const { VideosController } = require('../dist/modules/videos/videos.controller');
const { PROCESS_VIDEO_JOB } = require('../dist/modules/processing/processing.constants');

async function main() {
  const prisma = new PrismaClient();
  const project = await prisma.project.create({ data: { name: 'Resumability integration ' + randomUUID() } });
  const storage = {
    downloadToFile() { throw new Error('Completed media must not be downloaded'); },
    uploadFile() { throw new Error('Completed audio must not be extracted/uploaded'); },
    async removeObject() {}
  };
  const processor = new VideoProcessorService(prisma, storage);
  processor.visualAnalysisEnabled = true;
  const queueService = new ProcessingQueueService();
  await queueService.queue.close();
  const queueName = 'resume-test-' + randomUUID();
  queueService.queue = new Queue(queueName, { connection: queueService.connection });
  const events = new QueueEvents(queueName, { connection: queueService.connection });
  await events.waitUntilReady();
  const worker = new Worker(queueName, (job) => processor.process(job), {
    connection: queueService.connection
  });
  const videos = new VideosService(prisma, storage, queueService);
  const module = await Test.createTestingModule({
    controllers: [VideosController], providers: [{ provide: VideosService, useValue: videos }]
  }).compile();
  const app = module.createNestApplication();
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  let transcriptionCalls = 0;
  let visualCalls = [];
  let failPosition = 1;
  let failuresLeft = 1;
  processor.requestTranscription = async () => {
    transcriptionCalls++;
    return { text: 'First. Second. Third.', language: 'en', language_probability: 1, duration: 6,
      segments: [0, 1, 2].map((position) => ({
        position, start: position * 2, end: position * 2 + 1, text: ['First.', 'Second.', 'Third.'][position]
      })) };
  };
  processor.requestVisualAnalysis = async (_bucket, _key, chunks) => {
    assert.equal(chunks.length, 1);
    const position = chunks[0].position;
    visualCalls.push(position);
    if (position === failPosition && failuresLeft-- > 0) throw new Error('Injected visual timeout');
    return new Map([[position, { position, shot_boundaries: [], scene_change_count: 0,
      average_motion: 0, face_count: 0, largest_face_ratio: 0, brightness: 50,
      contrast: 20, colorfulness: 10, ocr_text: '', subtitle_detected: false }]]);
  };
  const fixture = async () => {
    const video = await prisma.video.create({ data: {
      projectId: project.id, originalName: 'resume-fixture.mp4',
      objectKey: 'resume-tests/' + randomUUID(), bucket: 'unused', mimeType: 'video/mp4',
      sizeBytes: 1n, duration: 6, width: 320, height: 240, fps: 25, codec: 'h264',
      bitrate: 1000n,
      audioBucket: 'unused', audioObjectKey: 'persisted.wav',
      processingJobs: { create: {} }
    }, include: { processingJobs: true } });
    return { video, data: { videoId: video.id, processingJobId: video.processingJobs[0].id } };
  };
  const snapshot = (id) => prisma.video.findUniqueOrThrow({ where: { id }, include: {
    transcript: { include: { segments: { orderBy: { position: 'asc' } } } },
    chunks: { include: { analysis: true, visualAnalysis: true }, orderBy: { position: 'asc' } },
    processingStages: true, processingJobs: true
  } });
  const core = (value) => ({
    transcript: value.transcript,
    chunks: value.chunks.map(({ visualAnalysis, ...chunk }) => chunk)
  });
  const stage = (value, name) => value.processingStages.find((s) => s.stage === name);
  const direct = (data) => ({ name: PROCESS_VIDEO_JOB, data, updateProgress: async () => {} });
  const enqueue = async (data) => {
    await queueService.enqueue(data);
    return queueService.queue.getJob(data.processingJobId);
  };
  try {
    const first = await fixture();
    await assert.rejects(processor.process(direct(first.data)), /Injected visual timeout/);
    const failed = await snapshot(first.video.id);
    assert.equal(failed.transcript.segments.length, 3);
    assert.equal(failed.chunks.length, 3);
    assert(failed.chunks.every((c) => c.analysis));
    assert.equal(failed.chunks.filter((c) => c.visualAnalysis).length, 1);
    const failedApiVideo = (await (await fetch(base + '/videos?projectId=' + project.id)).json())
      .find((item) => item.id === first.video.id);
    assert.equal(failedApiVideo.hasTranscript, true);
    assert.equal(failedApiVideo.hasChunks, true);
    assert.equal(stage(failed, 'VISUAL_ANALYSIS').status, 'FAILED');
    for (const name of ['INSPECT_MEDIA', 'EXTRACT_AUDIO', 'TRANSCRIBE', 'BUILD_CHUNKS', 'ANALYZE_CHUNKS'])
      assert.equal(stage(failed, name).status, 'COMPLETED');
    const response = await fetch(base + '/videos/' + first.video.id + '/retry', { method: 'POST' });
    assert.equal(response.status, 201);
    const retried = await queueService.queue.getJob(first.data.processingJobId);
    await retried.waitUntilFinished(events, 30000);
    const finished = await snapshot(first.video.id);
    assert.deepEqual(core(finished), core(failed));
    assert.equal(transcriptionCalls, 1);
    assert.deepEqual(visualCalls, [0, 1, 1, 2]);
    assert.equal(finished.processingJobs[0].progress, 100);
    assert.equal(stage(finished, 'FAILED').status, 'PENDING');
    for (const name of ['TRANSCRIBE', 'BUILD_CHUNKS', 'ANALYZE_CHUNKS'])
      assert.deepEqual(stage(finished, name).completedAt, stage(failed, name).completedAt);
    assert.equal((await fetch(base + '/videos/' + first.video.id + '/retry', { method: 'POST' })).status, 409);
    assert.equal((await fetch(base + '/videos/' + randomUUID() + '/retry', { method: 'POST' })).status, 404);
    console.log('PASS visual failure preserves transcript/chunks/analyses; HTTP retry reuses outputs and skips completed visual chunks.');

    // BullMQ gets one attempt. Recovery only starts after the manual retry endpoint is called.
    const automatic = await fixture();
    visualCalls = [];
    transcriptionCalls = 0;
    failuresLeft = 1;
    const automaticJob = await enqueue(automatic.data);
    assert.equal(automaticJob.opts.attempts, 1);
    await assert.rejects(automaticJob.waitUntilFinished(events, 30000), /Injected visual timeout/);
    assert.equal(transcriptionCalls, 1);
    assert.deepEqual(visualCalls, [0, 1]);
    failuresLeft = 0;
    const automaticRetry = await fetch(base + '/videos/' + automatic.video.id + '/retry', { method: 'POST' });
    assert.equal(automaticRetry.status, 201);
    await (await queueService.queue.getJob(automatic.data.processingJobId)).waitUntilFinished(events, 30000);
    assert.equal(transcriptionCalls, 1);
    assert.deepEqual(visualCalls, [0, 1, 1, 2]);
    assert.equal((await snapshot(automatic.video.id)).processingJobs[0].status, 'COMPLETED');
    console.log('PASS BullMQ attempts=1; manual retry resumes the missing visual chunk.');

    // Exhaust the queue job, then retry the retained failed ID via HTTP.
    const exhausted = await fixture();
    failuresLeft = 100;
    transcriptionCalls = 0;
    const exhaustedJob = await enqueue(exhausted.data);
    await assert.rejects(exhaustedJob.waitUntilFinished(events, 30000), /Injected visual timeout/);
    const exhaustedCore = core(await snapshot(exhausted.video.id));
    assert.equal(transcriptionCalls, 1);
    failuresLeft = 0;
    const duplicateRetries = await Promise.all([1, 2].map(() =>
      fetch(base + '/videos/' + exhausted.video.id + '/retry', { method: 'POST' })));
    assert(duplicateRetries.every((r) => r.ok));
    const resumed = await queueService.queue.getJob(exhausted.data.processingJobId);
    await resumed.waitUntilFinished(events, 30000);
    assert.equal(transcriptionCalls, 1);
    assert.deepEqual(core(await snapshot(exhausted.video.id)), exhaustedCore);
    console.log('PASS exhausted queue job can be manually retried; concurrent retry requests share one job.');

    const disabled = await fixture();
    processor.visualAnalysisEnabled = false;
    processor.requestVisualAnalysis = async () => { throw new Error('Disabled visual stage called'); };
    await processor.process(direct(disabled.data));
    const disabledResult = await snapshot(disabled.video.id);
    assert.equal(stage(disabledResult, 'VISUAL_ANALYSIS').status, 'SKIPPED');
    assert.equal(disabledResult.processingJobs[0].status, 'COMPLETED');
    assert.equal(disabledResult.processingJobs[0].progress, 100);
    console.log('PASS disabled visual analysis skips requests and completes at 100%.');

    // Existing artifacts are authoritative; a missing per-chunk output is repaired.
    const missingChunk = disabledResult.chunks[1];
    await prisma.chunkAnalysis.delete({ where: { chunkId: missingChunk.id } });
    await prisma.processingJob.update({ where: { id: disabled.data.processingJobId }, data: { status: 'FAILED' } });
    processor.requestTranscription = async () => { throw new Error('Existing transcript repeated'); };
    await processor.process(direct(disabled.data));
    const repaired = await snapshot(disabled.video.id);
    assert.equal(repaired.chunks[0].analysis.id, disabledResult.chunks[0].analysis.id);
    assert(repaired.chunks[1].analysis);
    assert.deepEqual(repaired.transcript, disabledResult.transcript);
    console.log('PASS retry reuses transcript/chunks and computes only a missing analysis.');

    const silent = await fixture();
    let silentCalls = 0;
    processor.requestTranscription = async () => {
      silentCalls++;
      return { text: '', language: null, language_probability: null, duration: 6, segments: [] };
    };
    await processor.process(direct(silent.data));
    await prisma.processingJob.update({ where: { id: silent.data.processingJobId }, data: { status: 'FAILED' } });
    await processor.process(direct(silent.data));
    assert.equal(silentCalls, 1);
    assert.equal((await snapshot(silent.video.id)).chunks.length, 0);
    console.log('PASS silent transcription and empty chunks remain resumable.');

    await prisma.processingJob.update({ where: { id: silent.data.processingJobId }, data: { status: 'PROCESSING' } });
    await prisma.videoProcessingStage.update({
      where: { videoId_stage: { videoId: silent.video.id, stage: 'VISUAL_ANALYSIS' } },
      data: { status: 'PROCESSING' }
    });
    await processor.recordWorkerFailure(direct(silent.data), new Error('Stalled worker'));
    assert.equal(stage(await snapshot(silent.video.id), 'VISUAL_ANALYSIS').status, 'FAILED');
    console.log('PASS stalled worker failure persists stage failure.');
  } finally {
    await worker.close();
    await events.close();
    await queueService.queue.obliterate({ force: true });
    await app.close();
    await queueService.onModuleDestroy();
    await processor.onModuleDestroy();
    // Only this test's uniquely identified fixture project is removed.
    await prisma.project.delete({ where: { id: project.id } });
    await prisma.$disconnect();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
