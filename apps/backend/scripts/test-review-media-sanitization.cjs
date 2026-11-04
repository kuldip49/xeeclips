require("reflect-metadata");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  http = require("node:http"),
  assert = require("node:assert/strict"),
  { execFileSync } = require("node:child_process");
const {
  MediaReviewService,
} = require("../dist/modules/media-review/media-review.service");
const {
  MediaReviewEvidenceService,
} = require("../dist/modules/media-review/media-review-evidence.service");
(async () => {
  const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "xeeclip-review-sanitization-"),
    ),
    source = path.join(dir, "tagged.mp4"),
    clean = path.join(dir, "clean.mp4");
  let server;
  try {
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:r=12",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=16000",
        "-t",
        "1.5",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-metadata",
        "comment=PRIVATE_REVIEW_TEST_TAG",
        "-metadata",
        "title=PRIVATE_REVIEW_TEST_TITLE",
        "-bsf:v",
        "h264_metadata=sei_user_data=12345678123456781234567812345678+PRIVATE_REVIEW_TEST_SEI",
        "-movflags",
        "+faststart",
        source,
      ],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 20000 },
    );
    const original = fs.readFileSync(source);
    assert(original.includes(Buffer.from("PRIVATE_REVIEW_TEST_TAG")));
    assert(original.includes(Buffer.from("PRIVATE_REVIEW_TEST_SEI")));
    server = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": original.length,
      });
      res.end(original);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const review = Object.create(MediaReviewService.prototype);
    review.streams = new Map();
    review.openingStreams = new Set();
    review.storage = {
      presignedGetUrl: async () =>
        `http://127.0.0.1:${server.address().port}/owned-render.mp4`,
    };
    const file = await review.openReviewStream(
      { bucket: "private", key: "owned-render" },
      "one-approved-grant",
      new Date(Date.now() + 60000),
    );
    const chunks = [];
    for await (const chunk of file.stream) chunks.push(chunk);
    const sanitized = Buffer.concat(chunks);
    assert(sanitized.length > 1000);
    assert(
      !sanitized.includes(Buffer.from("PRIVATE_REVIEW_TEST")),
      "hidden tags/SEI must not reach review clients",
    );
    fs.writeFileSync(clean, sanitized);
    const meta = JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type:format_tags",
          "-of",
          "json",
          clean,
        ],
        { encoding: "utf8" },
      ),
    );
    assert.deepEqual(meta.streams.map((s) => s.codec_type).sort(), [
      "audio",
      "video",
    ]);
    assert(!JSON.stringify(meta).includes("PRIVATE_REVIEW_TEST"));
    const media = {
        kind: "EXPORT",
        id: "approved-render",
        bucket: "private",
        key: "owned-render",
        duration: 1.5,
        fingerprint: "one-render",
      },
      request = {
        id: "one-review",
        userId: "one-user",
        clientId: "one-client",
        clipId: "one-clip",
        grant: { maxPasses: 1, expiresAt: new Date(Date.now() + 60000) },
      };
    const fakeReview = {
      storage: review.storage,
      pass: async () => ({
        request,
        pass: { id: "one-pass", coverage: [], evidenceCalls: 0 },
        media,
      }),
      authorized: async () => request,
      media: async () => media,
      markAccess: async () => undefined,
    };
    const fakeDb = {
      aiVideoReviewPass: {
        updateMany: async () => ({ count: 1 }),
        update: async () => undefined,
      },
      aiVideoReviewRequest: { updateMany: async () => ({ count: 1 }) },
    };
    const sample = await new MediaReviewEvidenceService(
      fakeDb,
      fakeReview,
    ).inspect({}, "one-review", 0, 1);
    assert.equal(sample.reviewContent.length, 9);
    for (const block of sample.reviewContent)
      assert(
        !Buffer.from(block.data, "base64").includes(
          Buffer.from("PRIVATE_REVIEW_TEST"),
        ),
        "native JPEG/WAV must not carry hidden source metadata",
      );
    console.log(
      "PASS media-only review: actual H.264/AAC and native JPEG/WAV delivered; private title/comment and SEI user data removed.",
    );
  } finally {
    if (server) await new Promise((r) => server.close(r));
    for (const file of [source, clean])
      if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
