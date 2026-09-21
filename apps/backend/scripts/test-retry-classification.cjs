// Focused, offline test for the /videos/:id/retry non-retryable-media-failure guard.
// Instantiates VideosService directly against stub collaborators — no DB/Redis/MinIO needed.
const assert = require('node:assert/strict');
const { VideosService } = require('../dist/modules/videos/videos.service');

function makeVideo(job) {
  return { id: 'video-1', bucket: 'b', objectKey: 'k', processingJobs: [job] };
}

function makeStubPrisma(video) {
  const updates = [];
  return {
    stub: {
      video: { findUnique: async () => video },
      processingJob: {
        update: async ({ data }) => { updates.push(data); return { ...video.processingJobs[0], ...data }; },
        findUniqueOrThrow: async () => ({ ...video.processingJobs[0], ...(updates[updates.length - 1] || {}) })
      }
    },
    updates
  };
}

async function expectUnprocessable(fn, expectedCode) {
  try {
    await fn();
  } catch (error) {
    assert.equal(error.constructor.name, 'UnprocessableEntityException',
      `expected UnprocessableEntityException, got ${error.constructor.name}: ${error.message}`);
    const response = error.getResponse();
    assert.equal(response.code, expectedCode);
    assert.equal(response.retryable, false);
    assert.ok(response.message && response.message.length > 5);
    return;
  }
  throw new Error('Expected retry() to throw UnprocessableEntityException, but it did not');
}

async function main() {
  const noAudioJob = { id: 'job-1', status: 'FAILED', errorCode: 'NO_AUDIO_STREAM',
    error: 'This video does not contain an audio track. Please upload a video with audio.', aiMode: 'FALLBACK_ONLY' };
  const { stub: prisma1 } = makeStubPrisma(makeVideo(noAudioJob));
  const service1 = new VideosService(prisma1, {}, { resume: async () => { throw new Error('must not enqueue'); } });
  await expectUnprocessable(() => service1.retry('video-1'), 'NO_AUDIO_STREAM');
  console.log('PASS: retry() refuses to re-enqueue NO_AUDIO_STREAM and returns a non-retryable response');

  for (const code of ['NO_VIDEO_STREAM', 'INVALID_MEDIA_FILE', 'AUDIO_RECOVERY_FAILED']) {
    const job = { id: 'job-x', status: 'FAILED', errorCode: code, error: 'x', aiMode: 'FALLBACK_ONLY' };
    const { stub } = makeStubPrisma(makeVideo(job));
    const service = new VideosService(stub, {}, { resume: async () => { throw new Error('must not enqueue'); } });
    await expectUnprocessable(() => service.retry('video-1'), code);
  }
  console.log('PASS: retry() refuses NO_VIDEO_STREAM and INVALID_MEDIA_FILE the same way');

  // A retryable media failure (transient extraction failure) must still be allowed to re-enqueue.
  let resumed = false;
  const extractionFailedJob = { id: 'job-2', status: 'FAILED', errorCode: 'AUDIO_EXTRACTION_FAILED',
    error: 'ffmpeg failed', aiMode: 'FALLBACK_ONLY' };
  const { stub: prisma2 } = makeStubPrisma(makeVideo(extractionFailedJob));
  const service2 = new VideosService(prisma2, {}, {
    resume: async (data, prepare) => { resumed = true; await prepare(); }
  });
  const result = await service2.retry('video-1');
  assert.ok(resumed, 'a retryable media failure must still be enqueued');
  assert.equal(result.id, 'job-2');
  console.log('PASS: retry() still re-enqueues a retryable media failure (AUDIO_EXTRACTION_FAILED)');

  // A job with no errorCode at all (unrelated/legacy failure) keeps the original retry behavior.
  let resumedLegacy = false;
  const legacyJob = { id: 'job-3', status: 'FAILED', errorCode: null, error: 'some other failure', aiMode: 'FALLBACK_ONLY' };
  const { stub: prisma3 } = makeStubPrisma(makeVideo(legacyJob));
  const service3 = new VideosService(prisma3, {}, {
    resume: async (data, prepare) => { resumedLegacy = true; await prepare(); }
  });
  await service3.retry('video-1');
  assert.ok(resumedLegacy, 'jobs without a classified error code must remain retryable');
  console.log('PASS: retry() keeps default (retryable) behavior for uncategorized failures');

  console.log(JSON.stringify({ result: 'PASS retry non-retryable classification checks' }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
