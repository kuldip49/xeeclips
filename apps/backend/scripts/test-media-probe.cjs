// Focused, offline tests for media-stream detection and classification.
// Exercises the real ffprobe/ffmpeg binaries against small generated fixtures, with no
// dependency on Postgres/Redis/MinIO/the BullMQ worker.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, rm, readFile, writeFile, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const execFileAsync = promisify(execFile);

const {
  probeMedia,
  extractAudioToWav,
  hasTrustworthyMediaMetadata,
  isStorageCorrupted,
  isRetryableErrorCode,
  MediaProcessingError,
  isMediaProcessingError,
  MEDIA_ERROR_MESSAGES
} = require('../dist/modules/processing/media-probe');

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'media-probe-test-'));
  try {
    const videoAudioPath = join(dir, 'video-audio.mp4');
    const videoOnlyPath = join(dir, 'video-only.mp4');
    const audioOnlyPath = join(dir, 'audio-only.wav');
    const corruptPath = join(dir, 'corrupt.mp4');

    await execFileAsync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
      '-c:v', 'libx264', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', videoAudioPath
    ]);
    await execFileAsync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=1',
      '-c:v', 'libx264', '-an', videoOnlyPath
    ]);
    await execFileAsync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      audioOnlyPath
    ]);
    await writeFile(corruptPath, Buffer.from('this is not a media file, just garbage bytes'));

    // 1. valid video + audio
    {
      const probe = await probeMedia(videoAudioPath);
      assert.equal(probe.hasVideo, true);
      assert.equal(probe.hasAudio, true);
      assert.equal(probe.videoCodec, 'h264');
      assert.equal(probe.audioCodec, 'aac');
      assert.equal(probe.videoStreamIndex, 0);
      assert.equal(probe.audioStreamIndex, 1);
      assert.ok(probe.durationSec > 0);
      assert.ok(probe.formatName);
    }
    console.log('PASS: valid video + audio is detected as hasVideo=true, hasAudio=true');

    // 2. video-only MP4
    {
      const probe = await probeMedia(videoOnlyPath);
      assert.equal(probe.hasVideo, true);
      assert.equal(probe.hasAudio, false);
      assert.equal(probe.audioCodec, null);
      assert.equal(probe.audioStreamIndex, null);
    }
    console.log('PASS: video-only file is detected as hasVideo=true, hasAudio=false (NO_AUDIO_STREAM path)');

    // 3. audio-only file
    {
      const probe = await probeMedia(audioOnlyPath);
      assert.equal(probe.hasVideo, false);
      assert.equal(probe.hasAudio, true);
    }
    console.log('PASS: audio-only file is detected as hasVideo=false (NO_VIDEO_STREAM path)');

    // 4. corrupt media
    {
      await assert.rejects(
        () => probeMedia(corruptPath),
        (error) => isMediaProcessingError(error) && error.code === 'INVALID_MEDIA_FILE'
      );
    }
    console.log('PASS: corrupt/unparseable file raises INVALID_MEDIA_FILE');

    // 5. audio stream exists but extraction fails (bad output path forces ffmpeg to fail)
    {
      const probe = await probeMedia(videoAudioPath);
      assert.equal(probe.hasAudio, true, 'fixture must have audio for this case to be meaningful');
      const unwritableOutput = join(dir, 'does-not-exist', 'audio.wav');
      await assert.rejects(
        () => extractAudioToWav(videoAudioPath, unwritableOutput),
        (error) => isMediaProcessingError(error) && error.code === 'AUDIO_EXTRACTION_FAILED'
      );
    }
    console.log('PASS: extraction failure on a file with a real audio stream is AUDIO_EXTRACTION_FAILED, ' +
      'not misclassified as NO_AUDIO_STREAM');

    // 5b. successful extraction produces a real mono 16kHz WAV, using explicit -map 0:a:0
    {
      const outputPath = join(dir, 'extracted.wav');
      const diagnostics = await extractAudioToWav(videoAudioPath, outputPath, 5);
      const extracted = await probeMedia(outputPath);
      assert.equal(extracted.hasAudio, true);
      assert.equal(extracted.hasVideo, false);
      assert.ok((await stat(outputPath)).size > 0);
      assert.equal(diagnostics.recoveryAttempted, false);
      assert.equal(diagnostics.recoverySucceeded, false);
    }
    console.log('PASS: valid extraction with explicit stream mapping succeeds, no recovery needed');

    // Helper: zero out a byte range of a copy of the known-good fixture to simulate damaged AAC
    // packets (this reproduces ffmpeg's real "malformed/corrupt packet" AAC decode errors without
    // depending on any external damaged sample file). Fractions are of total file size so this
    // stays correct regardless of exact encoder output size.
    async function makeCorruptedCopy(name, startFraction, lengthFraction) {
      const source = await readFile(videoAudioPath);
      const corrupted = Buffer.from(source);
      const start = Math.floor(corrupted.length * startFraction);
      const end = Math.min(corrupted.length, start + Math.floor(corrupted.length * lengthFraction));
      corrupted.fill(0, start, end);
      const path = join(dir, name);
      await writeFile(path, corrupted);
      return path;
    }

    // 5c. lightly damaged AAC (small corrupted region) — ffmpeg conceals it and still produces
    // a usably-complete WAV, so this must succeed without needing the recovery attempt to matter.
    {
      const lightlyCorruptPath = await makeCorruptedCopy('light-corrupt.mp4', 0.55, 0.008);
      const outputPath = join(dir, 'light-corrupt-extracted.wav');
      await extractAudioToWav(lightlyCorruptPath, outputPath, 5);
      const extracted = await probeMedia(outputPath);
      assert.ok(extracted.durationSec > 4, `expected near-complete duration coverage, got ${extracted.durationSec}s`);
    }
    console.log('PASS: lightly damaged AAC recovers a usably-complete WAV (B: damaged AAC recoverable)');

    // 5d. heavily damaged AAC (large corrupted region) — neither the primary attempt nor the one
    // tolerant recovery attempt can recover enough of the source; must fail cleanly and exactly
    // once (no infinite retry loop), classified as AUDIO_RECOVERY_FAILED and non-retryable.
    const heavilyCorruptPath = await makeCorruptedCopy('heavy-corrupt.mp4', 0.3, 0.5);
    {
      const outputPath = join(dir, 'heavy-corrupt-extracted.wav');
      await assert.rejects(
        () => extractAudioToWav(heavilyCorruptPath, outputPath, 5),
        (error) => {
          assert.ok(isMediaProcessingError(error) && error.code === 'AUDIO_RECOVERY_FAILED');
          assert.equal(error.retryable, false, 'irrecoverable audio damage must not invite endless retries');
          assert.ok(error.message.toLowerCase().includes('damaged'),
            'user-facing message must explain the audio is damaged, not just "try again"');
          return true;
        }
      );
    }
    console.log('PASS: heavily damaged/unrecoverable AAC fails cleanly as AUDIO_RECOVERY_FAILED ' +
      '(C: damaged AAC not recoverable)');

    // 5e. a "recovery" that produces too little audio relative to the source duration must be
    // rejected even if ffmpeg exits 0 for both attempts (E: recovered WAV too short).
    {
      const outputPath = join(dir, 'short-recovery-extracted.wav');
      await assert.rejects(
        () => extractAudioToWav(heavilyCorruptPath, outputPath, 60),
        (error) => isMediaProcessingError(error) && error.code === 'AUDIO_RECOVERY_FAILED'
      );
    }
    console.log('PASS: a recovered WAV covering too little of a much-longer source is rejected, ' +
      'not silently accepted because ffmpeg exited 0');

    // 5f. bounded logging: even a heavily-corrupted file (hundreds of repeated decoder error lines)
    // must never surface an unbounded stderr blob on the thrown error.
    {
      const outputPath = join(dir, 'bounded-log-extracted.wav');
      try {
        await extractAudioToWav(heavilyCorruptPath, outputPath, 5);
        throw new Error('expected extraction to fail for the bounded-logging assertion to be meaningful');
      } catch (error) {
        assert.ok(isMediaProcessingError(error));
        const cause = error.cause || {};
        for (const key of ['primaryStderrExcerpt', 'recoveryStderrExcerpt']) {
          if (typeof cause[key] === 'string') {
            assert.ok(cause[key].length <= 4100, `${key} must be bounded, got ${cause[key].length} chars`);
          }
        }
      }
    }
    console.log('PASS: ffmpeg stderr attached to a failure is bounded, never an unbounded blob ' +
      '(F: bounded FFmpeg stderr)');

    // 6. legacy metadata missing stream flags must trigger a re-probe
    {
      assert.equal(hasTrustworthyMediaMetadata({
        duration: 10, width: 640, height: 480, codec: 'h264', hasVideo: null, hasAudio: null
      }), false, 'legacy rows without hasVideo/hasAudio must be considered untrustworthy');
      assert.equal(hasTrustworthyMediaMetadata({
        duration: 10, width: 640, height: 480, codec: 'h264', hasVideo: true, hasAudio: false
      }), true, 'fully probed rows (including a genuine hasAudio=false) are trustworthy');
      assert.equal(hasTrustworthyMediaMetadata({
        duration: null, width: null, height: null, codec: null, hasVideo: null, hasAudio: null
      }), false);
    }
    console.log('PASS: legacy/incomplete metadata is detected and forces a re-probe');

    // 7. non-retryable vs retryable error codes
    {
      assert.equal(isRetryableErrorCode('NO_AUDIO_STREAM'), false);
      assert.equal(isRetryableErrorCode('NO_VIDEO_STREAM'), false);
      assert.equal(isRetryableErrorCode('INVALID_MEDIA_FILE'), false);
      assert.equal(isRetryableErrorCode('AUDIO_EXTRACTION_FAILED'), true);
      assert.equal(isRetryableErrorCode('AUDIO_RECOVERY_FAILED'), false,
        'irrecoverable audio damage will fail identically on retry, so must not be retryable');
      assert.equal(isRetryableErrorCode('STORAGE_OR_DOWNLOAD_CORRUPTION'), true);
      assert.equal(isRetryableErrorCode(null), true);
      assert.equal(isRetryableErrorCode(undefined), true);
    }
    console.log('PASS: retry classification matches the required non-retryable/retryable split');

    // 8. MinIO-downloaded file integrity check (simulated via reported sizes)
    {
      assert.equal(isStorageCorrupted({
        storedSizeBytes: 1000, remoteSizeBytes: 1000, downloadedSizeBytes: 1000
      }), false, 'matching sizes across DB, MinIO stat, and the local temp file are not corruption');
      assert.equal(isStorageCorrupted({
        storedSizeBytes: 1000, remoteSizeBytes: 1000, downloadedSizeBytes: 400
      }), true, 'a truncated download must be flagged as storage/download corruption');
      assert.equal(isStorageCorrupted({
        storedSizeBytes: 1000, remoteSizeBytes: undefined, downloadedSizeBytes: 0
      }), true, 'a zero-byte download is always corruption');
    }
    console.log('PASS: storage/download integrity check distinguishes corruption from a genuine ' +
      'silent source');

    // Error messages are present and distinct for every code exposed to the API/UI.
    for (const code of Object.keys(MEDIA_ERROR_MESSAGES)) {
      assert.ok(MEDIA_ERROR_MESSAGES[code].length > 10);
    }
    assert.ok(new MediaProcessingError('NO_AUDIO_STREAM').message.includes('audio track'));

    console.log(JSON.stringify({ result: 'PASS media probe/extraction/retry classification checks' }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
