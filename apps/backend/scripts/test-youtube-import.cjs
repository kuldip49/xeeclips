const assert = require('node:assert/strict');
const { parseYouTubeUrl, YouTubeImportAdapter, classifyYtDlpError, FORMAT_CHAIN, backoffMs,
  TRANSIENT_IMPORT_FAILURES, IMPORT_FAILURE_MESSAGES, importFailure } =
  require('../dist/modules/videos/youtube-import.adapter.js');
const { VideoImportService } = require('../dist/modules/videos/video-import.service.js');

const id = 'dQw4w9WgXcQ';
for (const url of [
  `https://www.youtube.com/watch?v=${id}&t=5`,
  `https://youtu.be/${id}`,
  `https://youtube.com/shorts/${id}`,
  `https://www.youtube.com/live/${id}`
]) {
  assert.deepEqual(parseYouTubeUrl(url), { externalVideoId: id,
    sourceUrl: `https://www.youtube.com/watch?v=${id}` });
}
for (const url of [
  'http://youtube.com/watch?v=' + id,
  'https://youtube.com.evil.example/watch?v=' + id,
  'https://127.0.0.1/watch?v=' + id,
  'file:///tmp/video.mp4',
  `https://user:pass@youtube.com/watch?v=${id}`,
  'https://youtu.be/../../etc/passwd',
  'https://youtube.com/watch?v=invalid'
]) assert.throws(() => parseYouTubeUrl(url));

// Classification uses the wording yt-dlp's YouTube extractor actually emits.
const cases = [
  ['ERROR: [youtube] AAAAAAAAAAA: This video is unavailable', 'metadata', 'VIDEO_NOT_FOUND'],
  ['ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader', 'metadata', 'VIDEO_NOT_FOUND'],
  ["ERROR: [youtube] x: Private video. Sign in if you've been granted access to this video", 'metadata', 'PRIVATE_VIDEO'],
  ["ERROR: [youtube] x: Sign in to confirm you're not a bot. Use --cookies-from-browser", 'metadata', 'BOT_CHALLENGE'],
  ['ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate for some users.', 'metadata', 'AGE_RESTRICTED'],
  ['ERROR: [youtube] x: Join this channel to get access to members-only content like this video', 'metadata', 'LOGIN_REQUIRED'],
  ['ERROR: [youtube] x: This video is only available for registered users', 'metadata', 'LOGIN_REQUIRED'],
  ['ERROR: [youtube] x: The uploader has not made this video available in your country', 'metadata', 'REGION_RESTRICTED'],
  ['ERROR: [youtube] x: This live event will begin in 3 hours.', 'metadata', 'LIVE_STREAM_UNSUPPORTED'],
  ['ERROR: [youtube] x: This video is DRM protected', 'metadata', 'NO_VIDEO_FORMAT'],
  ['ERROR: [youtube] x: Requested format is not available. Use --list-formats', 'download', 'NO_VIDEO_FORMAT'],
  ['ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests', 'metadata', 'RATE_LIMITED'],
  ["ERROR: [youtube] x: This content isn't available, try again later. The current session has been rate-limited by YouTube", 'metadata', 'RATE_LIMITED'],
  ['ERROR: Unable to download webpage: <urlopen error timed out>', 'metadata', 'NETWORK_TIMEOUT'],
  ['ERROR: Unable to download API page: HTTP Error 503: Service Unavailable', 'metadata', 'NETWORK_TIMEOUT'],
  ['ERROR: [download] Got error: Connection reset by peer', 'download', 'NETWORK_TIMEOUT'],
  ['ERROR: unable to download video data: HTTP Error 403: Forbidden', 'download', 'DOWNLOAD_FAILED'],
  ['ERROR: something new and unexpected', 'metadata', 'UNKNOWN_PROVIDER_ERROR'],
  // A sign-in warning must not relabel a different error.
  ['WARNING: [youtube] Sign in to see more formats\nERROR: [youtube] x: This video is unavailable', 'metadata', 'VIDEO_NOT_FOUND']
];
for (const [stderr, phase, expected] of cases)
  assert.equal(classifyYtDlpError(stderr, phase), expected, stderr);

// Only transient categories retry, with bounded exponential backoff.
assert.deepEqual([...TRANSIENT_IMPORT_FAILURES].sort(), ['NETWORK_TIMEOUT', 'RATE_LIMITED']);
for (const permanent of ['PRIVATE_VIDEO', 'LOGIN_REQUIRED', 'VIDEO_NOT_FOUND', 'AGE_RESTRICTED', 'BOT_CHALLENGE'])
  assert(!TRANSIENT_IMPORT_FAILURES.has(permanent));
assert.deepEqual([1, 2, 3, 6].map((n) => backoffMs('NETWORK_TIMEOUT', n)), [2000, 4000, 8000, 60000]);
assert.equal(backoffMs('RATE_LIMITED', 1), 15000);

// The chain never names a YouTube format id and ends with fully generic selectors.
assert.equal(FORMAT_CHAIN.length, 4);
for (const step of FORMAT_CHAIN) assert(!/\b\d{2,3}\b(?!0)/.test(step.format.replace(/height<=1080/g, '')), step.format);
assert.equal(FORMAT_CHAIN[0].merge, 'mp4');
assert.equal(FORMAT_CHAIN[1].format, 'bv*[height<=1080]+ba');

// Every category has a friendly message free of internals.
for (const [code, message] of Object.entries(IMPORT_FAILURE_MESSAGES)) {
  assert(!/yt-dlp|retriever|deployment|stderr/i.test(message), code);
  assert.equal(importFailure(code, 'detail').message, message);
}

async function main() {
  delete process.env.YOUTUBE_IMPORT_APPROVED;
  await assert.rejects(VideoImportService.prototype.submit.call({}, {
    url: `https://www.youtube.com/watch?v=${id}`, rightsConfirmed: true
  }), { code: 'IMPORT_UNAVAILABLE' });
  process.env.YOUTUBE_IMPORT_BINARY = '__missing_youtube_retriever__';
  const adapter = new YouTubeImportAdapter();
  await assert.rejects(adapter.metadata(`https://www.youtube.com/watch?v=${id}`,
    new AbortController().signal), { code: 'IMPORT_UNAVAILABLE' });
  assert.equal((await adapter.describeBinary()).version, null);
  // Timeouts come from the new variables, with the platform's 2-hour cap on duration.
  process.env.YOUTUBE_IMPORT_TOTAL_TIMEOUT = '7200';
  process.env.YOUTUBE_IMPORT_MAX_DURATION = '99999';
  const configured = new YouTubeImportAdapter().config;
  assert.equal(configured.totalTimeoutMs, 7_200_000);
  assert.equal(configured.maxDuration, 7200);
  console.log('YouTube URL validation, failure classification, retry policy and config checks passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
