const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { PrismaClient } = require('@prisma/client');
const { Client } = require('minio');
const base = process.env.SMOKE_API_URL || 'http://localhost:4000';
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 180000);
const verifyRetry = process.env.SMOKE_VERIFY_RETRY === '1';
async function request(path, init) {
  const response = await fetch(base + path, init);
  assert(response.ok, path + ': ' + response.status + ' ' + (!response.ok ? await response.text() : ''));
  return response.json();
}
async function main() {
  assert(process.argv[2], 'Usage: node scripts/test-processing-media.cjs /path/to/short-speech.mp4');
  const prisma = new PrismaClient();
  let project, video, deletedViaApi = false;
  try {
    project = await request('/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Short-video resumability smoke test ' + Date.now() })
    });
    const body = new FormData();
    body.append('file', new Blob([await readFile(process.argv[2])], { type: 'video/mp4' }), 'resume-smoke.mp4');
    video = await request('/projects/' + project.id + '/videos', { method: 'POST', body });
    let status;
    const deadline = Date.now() + timeoutMs;
    do {
      const result = await request('/videos?projectId=' + project.id);
      video = result.find((item) => item.id === video.id);
      status = video.processingJobs[0].status;
      if (status === 'COMPLETED') break;
      if (status === 'FAILED') throw new Error(video.processingJobs[0].error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);
    assert.equal(status, 'COMPLETED');
    assert.equal(video.processingJobs[0].progress, 100);
    assert.equal(video.processingStages.length, 9);
    for (const name of ['UPLOADED', 'INSPECT_MEDIA', 'EXTRACT_AUDIO', 'TRANSCRIBE', 'BUILD_CHUNKS', 'ANALYZE_CHUNKS', 'COMPLETED']) {
      assert.equal(video.processingStages.find((stage) => stage.stage === name).status, 'COMPLETED');
    }
    const visual = video.processingStages.find((stage) => stage.stage === 'VISUAL_ANALYSIS');
    assert(['SKIPPED', 'COMPLETED'].includes(visual.status));
    const transcript = await request('/videos/' + video.id + '/transcript');
    const chunks = await request('/videos/' + video.id + '/chunks');
    const analyses = await request('/videos/' + video.id + '/chunk-analysis');
    assert(transcript.segments.length > 0, 'Use a fixture with audible speech');
    assert(chunks.length > 0);
    assert.equal(analyses.length, chunks.length);

    let retryReusedArtifacts = false;
    if (verifyRetry) {
      const before = {
        transcriptId: transcript.id,
        transcriptUpdatedAt: transcript.updatedAt,
        segmentIds: transcript.segments.map((segment) => segment.id),
        chunkIds: chunks.map((chunk) => chunk.id),
        analysisIds: analyses.map((analysis) => analysis.id)
      };
      const jobId = video.processingJobs[0].id;
      await prisma.$transaction([
        prisma.processingJob.update({
          where: { id: jobId },
          data: { status: 'FAILED', error: 'Injected retry verification', completedAt: new Date() }
        }),
        prisma.videoProcessingStage.update({
          where: { videoId_stage: { videoId: video.id, stage: 'TRANSCRIBE' } },
          data: { status: 'FAILED', error: 'Injected retry verification' }
        })
      ]);
      await request('/videos/' + video.id + '/retry', { method: 'POST' });
      const retryDeadline = Date.now() + timeoutMs;
      do {
        const result = await request('/videos?projectId=' + project.id);
        video = result.find((item) => item.id === video.id);
        status = video.processingJobs[0].status;
        if (status === 'COMPLETED') break;
        if (status === 'FAILED') throw new Error(video.processingJobs[0].error);
        await new Promise((resolve) => setTimeout(resolve, 500));
      } while (Date.now() < retryDeadline);
      assert.equal(status, 'COMPLETED');
      const [afterTranscript, afterChunks, afterAnalyses] = await Promise.all([
        request('/videos/' + video.id + '/transcript'),
        request('/videos/' + video.id + '/chunks'),
        request('/videos/' + video.id + '/chunk-analysis')
      ]);
      assert.deepEqual({
        transcriptId: afterTranscript.id,
        transcriptUpdatedAt: afterTranscript.updatedAt,
        segmentIds: afterTranscript.segments.map((segment) => segment.id),
        chunkIds: afterChunks.map((chunk) => chunk.id),
        analysisIds: afterAnalyses.map((analysis) => analysis.id)
      }, before);
      retryReusedArtifacts = true;
    }

    const deleted = await request('/videos/' + video.id, { method: 'DELETE' });
    assert.deepEqual(deleted, { id: video.id, deleted: true });
    deletedViaApi = true;
    console.log(JSON.stringify({
      result: 'PASS real upload, ffprobe, ffmpeg, MinIO, Whisper, chunks, and analysis',
      duration: video.duration, segments: transcript.segments.length, chunks: chunks.length,
      analyses: analyses.length, visual: visual.status, progress: video.processingJobs[0].progress,
      retryReusedArtifacts, deleteEndpoint: 'PASS'
    }));
  } finally {
    // Clean only objects and rows created by this test.
    if (video && !deletedViaApi) {
      const client = new Client({
        endPoint: process.env.MINIO_ENDPOINT || 'localhost',
        port: Number(process.env.MINIO_PORT || 9000),
        useSSL: process.env.MINIO_USE_SSL === 'true',
        accessKey: process.env.MINIO_ROOT_USER || 'minioadmin',
        secretKey: process.env.MINIO_ROOT_PASSWORD || 'minioadmin'
      });
      await client.removeObject(video.bucket, video.objectKey);
      if (video.audioBucket && video.audioObjectKey)
        await client.removeObject(video.audioBucket, video.audioObjectKey);
    }
    if (project) await prisma.project.delete({ where: { id: project.id } });
    await prisma.$disconnect();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
