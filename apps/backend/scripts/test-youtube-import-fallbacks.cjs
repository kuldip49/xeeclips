// Exercises the paths real public videos rarely hit, against the real adapter + normalizer:
// format-chain fallback, WebM VP9/Opus -> canonical H.264/AAC MP4, transient retry, and no retry
// for permanent failures. A stub retriever mimics yt-dlp's CLI; FFmpeg makes real media.
// Run inside the backend container after `npm run build`: node scripts/test-youtube-import-fallbacks.cjs
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, chmodSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const work = mkdtempSync(join(tmpdir(), 'yt-fallback-'));
const stub = join(work, 'stub-retriever.sh');
// STUB_PLAN: comma-separated outcomes consumed one per download call:
//   ok-mp4 | ok-webm | noformat | e503 | private | audio-only
writeFileSync(stub, `#!/bin/sh
STATE="${work}/calls"; n=$(cat "$STATE" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$STATE"
case " $* " in *" --version "*) echo stub-1.0; exit 0;; esac
out=""; prev=""; for a in "$@"; do [ "$prev" = "--output" ] && out="$a"; prev="$a"; done
plan=$(echo "$STUB_PLAN" | cut -d, -f$n); [ -z "$plan" ] && plan=ok-mp4
dir=$(dirname "$out")
case "$plan" in
  noformat) echo "ERROR: [youtube] abc: Requested format is not available. Use --list-formats" >&2; exit 1;;
  e503) echo "ERROR: unable to download video data: HTTP Error 503: Service Unavailable" >&2; exit 1;;
  private) echo "ERROR: [youtube] abc: Private video. Sign in if you've been granted access" >&2; exit 1;;
  ok-webm) f="$dir/source.webm"; ffmpeg -v error -y -f lavfi -i testsrc=size=640x360:rate=25:duration=6 -f lavfi -i sine=frequency=440:duration=6 -c:v libvpx-vp9 -b:v 300k -deadline realtime -c:a libopus "$f" || exit 1
    echo "{\\"filepath\\": \\"$f\\", \\"format_id\\": \\"248+251\\", \\"vcodec\\": \\"vp9\\", \\"acodec\\": \\"opus\\", \\"width\\": 640, \\"height\\": 360, \\"requested_formats\\": [{\\"url\\": \\"https://rr1.example.googlevideo.com/videoplayback?sig=secret\\", \\"protocol\\": \\"https\\"}]}";;
  audio-only) f="$dir/source.m4a"; ffmpeg -v error -y -f lavfi -i sine=frequency=440:duration=6 -c:a aac "$f" || exit 1
    echo "{\\"filepath\\": \\"$f\\"}";;
  *) f="$dir/source.mp4"; ffmpeg -v error -y -f lavfi -i testsrc=size=640x360:rate=25:duration=6 -f lavfi -i sine=frequency=440:duration=6 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart "$f" || exit 1
    echo "{\\"filepath\\": \\"$f\\", \\"format_id\\": \\"18\\", \\"vcodec\\": \\"avc1\\", \\"acodec\\": \\"mp4a\\"}";;
esac
`);
chmodSync(stub, 0o755);
process.env.YOUTUBE_IMPORT_BINARY = stub;
process.env.YOUTUBE_IMPORT_MAX_ATTEMPTS = '3';
const adapterModule = require('../dist/modules/videos/youtube-import.adapter.js');
const { normalizeImportedMedia } = require('../dist/modules/videos/media-normalize.js');
const { probeMedia } = require('../dist/modules/processing/media-probe.js');
// Keep retries fast in the test.
const realBackoff = adapterModule.backoffMs;
const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

async function run(plan, label) {
  rmSync(join(work, 'calls'), { force: true });
  process.env.STUB_PLAN = plan;
  const directory = mkdtempSync(join(work, `${label}-`));
  const adapter = new adapterModule.YouTubeImportAdapter();
  const attempts = [];
  try {
    const result = await adapter.download(url, directory, new AbortController().signal, async () => undefined, attempts);
    return { result, attempts, directory };
  } catch (error) {
    return { error, attempts, directory };
  }
}

(async () => {
  assert.equal(realBackoff('NETWORK_TIMEOUT', 1), 2000);

  // 1) Step 1 has no format -> step 2 delivers WebM VP9/Opus -> normalized to H.264/AAC MP4.
  const fallback = await run('noformat,ok-webm', 'fallback');
  assert(!fallback.error, fallback.error && fallback.error.stack);
  assert.equal(fallback.result.formatStep, 'best-video+best-audio');
  assert.deepEqual(fallback.attempts.map((a) => `${a.step}#${a.attempt}=${a.category ?? 'ok'}`),
    ['h264-aac-mp4#1=NO_VIDEO_FORMAT', 'best-video+best-audio#1=ok']);
  assert.deepEqual(fallback.result.mediaHosts, ['rr1.example.googlevideo.com'], 'only hosts are kept, never signed URLs');
  const normalized = await normalizeImportedMedia(fallback.result.filePath, fallback.directory, new AbortController().signal);
  assert.equal(normalized.action, 'transcode');
  const canonical = await probeMedia(normalized.filePath);
  assert.equal(canonical.videoCodec, 'h264');
  assert.equal(canonical.audioCodec, 'aac');
  assert(/mp4/.test(canonical.formatName));
  assert(canonical.durationSec > 5.5, `duration ${canonical.durationSec}`);
  console.log('fallback chain + WebM VP9/Opus normalization: ok', { action: normalized.action,
    codecs: `${canonical.videoCodec}/${canonical.audioCodec}`, duration: canonical.durationSec });

  // 2) A canonical MP4 is stored as-is (no needless re-encode).
  const direct = await run('ok-mp4', 'direct');
  assert(!direct.error);
  const untouched = await normalizeImportedMedia(direct.result.filePath, direct.directory, new AbortController().signal);
  assert.equal(untouched.action, 'none');

  // 3) A step that yields audio only moves on to the next step.
  const audioOnly = await run('audio-only,ok-mp4', 'audio-only');
  assert(!audioOnly.error);
  assert.deepEqual(audioOnly.attempts.map((a) => a.category ?? 'ok'), ['NO_VIDEO_FORMAT', 'ok']);

  // 4) Transient 503 retries the same step with backoff, then succeeds.
  const startedAt = Date.now();
  const transient = await run('e503,ok-mp4', 'transient');
  assert(!transient.error, transient.error && transient.error.stack);
  assert.deepEqual(transient.attempts.map((a) => `${a.step}#${a.attempt}=${a.category ?? 'ok'}`),
    ['h264-aac-mp4#1=NETWORK_TIMEOUT', 'h264-aac-mp4#2=ok']);
  assert(Date.now() - startedAt >= 1900, 'backoff applied');

  // 5) Permanent failure: no retry, no further format steps.
  const permanent = await run('private,ok-mp4,ok-mp4', 'permanent');
  assert.equal(permanent.error?.code, 'PRIVATE_VIDEO');
  assert.equal(permanent.attempts.length, 1);

  // 6) Transient failures exhaust the bounded attempts and surface the real category.
  const exhausted = await run('e503,e503,e503,ok-mp4', 'exhausted');
  assert.equal(exhausted.error?.code, 'NETWORK_TIMEOUT');
  assert.equal(exhausted.attempts.length, 3);

  rmSync(work, { recursive: true, force: true });
  console.log('YouTube import fallback, normalization and retry checks passed');
})().catch((error) => { console.error(error); rmSync(work, { recursive: true, force: true }); process.exitCode = 1; });
