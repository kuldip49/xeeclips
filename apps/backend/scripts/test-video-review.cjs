require("reflect-metadata");
const assert = require("node:assert/strict");
const {
  MediaReviewService,
} = require("../dist/modules/media-review/media-review.service");
const {
  reviewSign,
  equalSignature,
  VideoReviewError,
} = require("../dist/modules/media-review/media-review.policy");
const { safeMcpError } = require("../dist/modules/mcp/mcp-operations.service");
const { MCP_TOOLS } = require("../dist/modules/mcp/mcp-tools");
const { ownerFilter } = require("../dist/modules/auth/request-context");
(async () => {
  process.env.PASSWORD_HASH_PEPPER = "only-disposable-review-unit-key-20261104";
  const signed = reviewSign("one-user:one-client:one-render:one-session");
  assert(equalSignature(signed, signed));
  assert(!equalSignature(signed, reviewSign("another-render")));
  assert(!equalSignature("!", signed));
  for (const name of [
    "get_approved_video_reviews",
    "request_video_review",
    "get_review_media",
    "review_video",
    "complete_video_review",
  ]) {
    const t = MCP_TOOLS.find((t) => t.name === "xeeclip_" + name);
    assert.deepEqual(t.scopes, ["xeeclip:media:review"]);
    assert(!t.schema.safeParse({ untrustedExtra: "secret" }).success);
  }
  assert.deepEqual(ownerFilter("AiVideoReviewGrant", "owner-a"), {
    userId: "owner-a",
  });
  assert.deepEqual(ownerFilter("AiVideoReviewPass", "owner-a"), {
    grant: { userId: "owner-a" },
  });
  for (const code of [
    "AI_VIDEO_REVIEW_DISABLED",
    "AI_VIDEO_REVIEW_DENIED",
    "AI_VIDEO_REVIEW_EXPIRED",
    "AI_VIDEO_REVIEW_REVOKED",
  ]) {
    const safe = safeMcpError(new VideoReviewError(code));
    assert.equal(safe.code, code);
    assert(!/Prisma|ffmpeg|MinIO|bucket|objectKey|stack/.test(safe.message));
  }
  let created = 0;
  const service = Object.create(MediaReviewService.prototype);
  service.authorized = async () => ({
    id: "request",
    userId: "owner-a",
    clipId: "clip-a",
    renderFingerprint: "old",
    grant: { id: "grant", maxPasses: 3, allowRevisions: true },
  });
  service.resolve = async () => ({
    kind: "EXPORT",
    id: "owned-export",
    duration: 10,
    fingerprint: "new-render",
  });
  const tx = {
    $queryRaw: async () => [],
    user: { findUnique: async () => ({ aiVideoReviewEnabled: true }) },
    aiVideoReviewGrant: {
      findUnique: async () => ({
        status: "APPROVED",
        expiresAt: new Date(Date.now() + 60000),
      }),
    },
    aiVideoReviewPass: {
      findUnique: async () => null,
      count: async () => 3,
      create: async () => {
        created++;
      },
    },
  };
  service.prisma = { $transaction: (fn) => fn(tx) };
  await assert.rejects(
    () => service.pass({}, "request"),
    (e) => e.code === "AI_VIDEO_REVIEW_LIMIT",
  );
  assert.equal(created, 0, "fourth render version cannot be allocated");
  service.authorized = async () => ({
    id: "request",
    userId: "owner-a",
    clipId: "clip-a",
    renderFingerprint: "old",
    grant: { id: "grant", maxPasses: 1, allowRevisions: false },
  });
  await assert.rejects(
    () => service.pass({}, "request"),
    (e) => e.code === "AI_VIDEO_REVIEW_CHANGED",
  );
  service.authorized = async () => ({
    id: "request",
    userId: "owner-a",
    clipId: "clip-a",
    renderFingerprint: "old",
    grant: { id: "grant", maxPasses: 3, allowRevisions: true },
  });
  tx.user.findUnique = async () => ({ aiVideoReviewEnabled: false });
  await assert.rejects(
    () => service.pass({}, "request"),
    (e) => e.code === "AI_VIDEO_REVIEW_DISABLED",
  );
  assert.equal(
    created,
    0,
    "OFF between authorization and claim must prevent access",
  );
  tx.user.findUnique=async()=>({aiVideoReviewEnabled:true});
  tx.aiVideoReviewPass.findUnique=async()=>({status:"COMPLETE"});
  await assert.rejects(()=>service.pass({},"request"),e=>e.code==="AI_VIDEO_REVIEW_PASS_COMPLETE");
  console.log(
    "PASS review-only scopes, strict schemas, signed grant binding, safe errors, owner filters, default single render, max-three passes and OFF/claim race.",
  );
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
