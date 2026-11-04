// Explicit disposable acceptance. No real user's settings or grants are changed.
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto"),
  { execFileSync } = require("node:child_process");
const {
  request,
  grant,
  connect,
  call,
  accounts,
  base,
  origin,
} = require("./mcp-acceptance-client.cjs");
const dir = path.resolve(
  process.env.MCP_QA_DIR || path.join(__dirname, "../../../.cache/mcp"),
);
const scope = "xeeclip:media:review",
  stamp = Date.now(),
  mediaReport = JSON.parse(
    fs.readFileSync(path.join(dir, "media-acceptance.json")),
  ),
  target = mediaReport.create.find((c) => c.style === "STYLE_ONE");
assert(target);
assert.equal(accounts.length, 2);
for (const a of accounts)
  assert.match(a.email, /^mcp-qa-\d+-[01]@example\.invalid$/);
const previous = fs.existsSync(path.join(dir, "video-review-acceptance.json"))
  ? JSON.parse(fs.readFileSync(path.join(dir, "video-review-acceptance.json")))
  : {};
const report = { ...previous, passed: false, at: new Date().toISOString() },
  a = accounts[0],
  b = accounts[1],
  clients = [];
const key = (label) => "review-" + stamp + "-" + label;
const set = (enabled) =>
  request("/mcp/reviews/settings", {
    method: "PATCH",
    cookie: a.cookie,
    body: { enabled },
  });
const error = async (c, name, args, code) => {
  const r = await c.callTool({ name: "xeeclip_" + name, arguments: args });
  assert(r.isError, name + " must be denied");
  assert.equal(r.structuredContent.error.code, code, name);
  return r;
};
const ask = (c, label, clipId = target.clipId) =>
  call(c, "request_video_review", {
    clipId,
    purpose:
      "Inspect this rendered video's editing quality for disposable acceptance.",
    idempotencyKey: key(label),
  });
async function decide(id, approve = true, allowRevisions = false) {
  const { value } = await request(`/mcp/reviews/${id}/consent`, {
    cookie: a.cookie,
  });
  return request(`/mcp/reviews/${id}/decision`, {
    method: "POST",
    expected: 201,
    cookie: a.cookie,
    body: { nonce: value.nonce, approve, allowRevisions },
  });
}
const stream = async (url, g, expected) => {
  const r = await fetch(url, {
    headers: {
      ...(g ? { Authorization: "Bearer " + g.tokens.access_token } : {}),
      Range: "bytes=0-1023",
      ...(process.env.MCP_QA_GATE_STATE ? { Cookie: a.cookie } : {}),
    },
    redirect: "manual",
  });
  assert.equal(r.status, expected);
  if (r.ok) {
    assert.match(r.headers.get("cache-control"), /no-store/);
    assert.match(r.headers.get("x-robots-tag"), /noindex/);
    assert.equal(r.headers.get("content-type"), "video/mp4");
    assert.equal(r.headers.get("accept-ranges"), "none");
    const data = Buffer.from(await r.arrayBuffer());
    assert(data.length > 1024);
    assert(data.includes(Buffer.from("ftyp")));
    assert(!data.includes(Buffer.from("PRIVATE_REVIEW_TEST")));
  } else await r.arrayBuffer();
  return r;
};
const qaDb = (code) => {
  const container =
    base === "http://localhost:4400"
      ? "xeeclip-mcp-qa-backend-1"
      : "ai-content-backend";
  if (container === "ai-content-backend")
    assert.equal(process.env.MCP_PRODUCTION_QA, "1");
  const script = `const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();(async()=>{const id=${JSON.stringify(a.userId)};const u=await p.user.findUnique({where:{id}});if(u?.email!==${JSON.stringify(a.email)}||u.role!=='USER')throw Error('Disposable QA identity required');${code}})().catch(()=>{console.error('Disposable review fault check failed');process.exitCode=1}).finally(()=>p.$disconnect());`;
  return JSON.parse(
    execFileSync("docker", ["exec", "-i", container, "node", "-"], {
      input: script,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
};
async function evidence(c, id, label) {
  const result = await c.callTool({
    name: "xeeclip_review_video",
    arguments: {
      reviewRequestId: id,
      startSeconds: 0,
      durationSeconds: Math.min(20, 3),
    },
  });
  assert(!result.isError, JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent.evidenceType, "ACTUAL_RENDERED_MEDIA");
  const images = result.content.filter((x) => x.type === "image"),
    audio = result.content.filter((x) => x.type === "audio");
  assert.equal(images.length, 8);
  assert(audio.length > 0);
  fs.writeFileSync(
    path.join(dir, `review-${label}.jpg`),
    Buffer.from(images[0].data, "base64"),
  );
  fs.writeFileSync(
    path.join(dir, `review-${label}.wav`),
    Buffer.from(audio[0].data, "base64"),
  );
  const forbidden = new Set([
    "bucket",
    "objectKey",
    "storageKey",
    "sourceId",
    "editProjectId",
    "transcript",
    "email",
    "credits",
    "userId",
    "clientId",
    "metadata",
    "settings",
  ]);
  const check = (v) => {
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      assert(!forbidden.has(k), "Unexpected review field: " + k);
      check(x);
    }
  };
  check(result.structuredContent);
  assert(
    !/xmcp_at_|xmcp_rt_|s3:\/\//.test(JSON.stringify(result.structuredContent)),
  );
  return result.structuredContent;
}
async function main() {
  const full = await connect(a);
  clients.push(full);
  const before = await call(full, "get_credits");
  const clientsFile = path.join(dir, "review-clients.private.json");
  const cached = fs.existsSync(clientsFile)
    ? JSON.parse(fs.readFileSync(clientsFile))
    : null;
  const reusable =
    cached && Date.now() - fs.statSync(clientsFile).mtimeMs < 600000;
  const renew = (account, scopes, saved) =>
    reusable && saved ? saved : grant(account, scopes, false, saved?.client);
  const onlyGrant = await renew(a, [scope], cached?.onlyGrant),
    otherGrant = await renew(a, [scope], cached?.otherGrant),
    foreignGrant = await renew(b, [scope], cached?.foreignGrant),
    editGrant = await renew(
      a,
      [
        scope,
        "xeeclip:clips:read",
        "xeeclip:clips:edit",
        "xeeclip:clips:export",
      ],
      cached?.editGrant,
    );
  const only = await connect(onlyGrant),
    other = await connect(otherGrant),
    foreign = await connect(foreignGrant),
    edit = await connect(editGrant);
  clients.push(only, other, foreign, edit);
  fs.writeFileSync(
    path.join(dir, "review-clients.private.json"),
    JSON.stringify({ onlyGrant, otherGrant, foreignGrant, editGrant }, null, 2),
  );
  const initial = (await request("/mcp/reviews", { cookie: a.cookie })).value;
  if (!report.defaultOff)
    assert.equal(
      initial.enabled,
      false,
      "review must default OFF even with the OAuth scope",
    );
  else await set(false);
  const input = {
    clipId: target.clipId,
    purpose: "Check rendered editing quality.",
    idempotencyKey: key("off-then-on"),
  };
  await error(only, "request_video_review", input, "AI_VIDEO_REVIEW_DISABLED");
  assert.equal(
    (await request("/mcp/reviews", { cookie: a.cookie })).value.requests.length,
    initial.requests.length,
  );
  report.defaultOff = true;
  await set(true);
  const pending = await call(only, "request_video_review", input);
  assert.equal(pending.status, "AWAITING_USER_APPROVAL");
  assert(!pending.reviewUrl && !pending.mimeType);
  report.scopeAndSettingNotApproval = true;
  await error(
    only,
    "get_review_media",
    { reviewRequestId: pending.reviewRequestId },
    "AI_VIDEO_REVIEW_APPROVAL_REQUIRED",
  );
  await error(
    other,
    "get_review_media",
    { reviewRequestId: pending.reviewRequestId },
    "NOT_FOUND",
  );
  await setFor(b, true);
  await error(
    foreign,
    "get_review_media",
    { reviewRequestId: pending.reviewRequestId },
    "NOT_FOUND",
  );
  await request(`/mcp/reviews/${pending.reviewRequestId}/consent`, {
    cookie: b.cookie,
    expected: 404,
  });
  const machineApproval = await fetch(
    base + `/mcp/reviews/${pending.reviewRequestId}/decision`,
    {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: "Bearer " + onlyGrant.tokens.access_token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        approve: true,
        nonce: "x".repeat(43),
        allowRevisions: false,
      }),
    },
  );
  assert([401, 503].includes(machineApproval.status));
  const machineConsent = await fetch(
    base + `/mcp/reviews/${pending.reviewRequestId}/consent`,
    {
      headers: { Authorization: "Bearer " + onlyGrant.tokens.access_token },
      redirect: "manual",
    },
  );
  assert.equal(machineConsent.status, 401);
  report.serverSideHumanApproval = true;
  const notApproved = await call(only, "get_approved_video_reviews");
  assert(
    !notApproved.reviews.some(
      (r) => r.reviewRequestId === pending.reviewRequestId,
    ),
  );
  await decide(pending.reviewRequestId);
  const granted = await call(only, "get_review_media", {
    reviewRequestId: pending.reviewRequestId,
  });
  assert.equal(granted.evidenceType, "METADATA_ONLY");
  assert.equal(granted.authorization, "MCP_BEARER_REQUIRED");
  await error(
    only,
    "complete_video_review",
    {
      reviewRequestId: pending.reviewRequestId,
      reviewPassId: granted.reviewPassId,
      status: "REVIEWED",
      findings: [],
      finishSession: true,
      idempotencyKey: key("no-decoded-evidence"),
    },
    "AI_VIDEO_REVIEW_EVIDENCE_REQUIRED",
  );
  report.metadataCannotClaimInspection = true;
  await stream(granted.reviewUrl, null, 401);
  await stream(granted.reviewUrl, onlyGrant, 200);
  await stream(granted.reviewUrl, otherGrant, 404);
  await stream(granted.reviewUrl, foreignGrant, 404);
  await stream(granted.reviewUrl.replace(/.$/, "!"), onlyGrant, 403);
  report.noSecondLogin = true;
  report.signedProtectedMedia = true;
  report.userAndClientIsolation = true;
  await error(
    foreign,
    "request_video_review",
    {
      clipId: target.clipId,
      purpose: "Unauthorized target",
      idempotencyKey: key("foreign-request"),
    },
    "NOT_FOUND",
  );
  const approved = await call(only, "get_approved_video_reviews");
  assert(
    approved.reviews.some((r) => r.reviewRequestId === pending.reviewRequestId),
  );
  assert(!approved.reviews.some((r) => r.clipId || r.userId || r.clientId));
  const secondClip = mediaReport.create.find((r) => r.clipId !== target.clipId);
  const second = await ask(only, "different-clip", secondClip.clipId);
  await decide(second.reviewRequestId);
  const secondMedia = await call(only, "get_review_media", {
    reviewRequestId: second.reviewRequestId,
  });
  const crossTicket = new URL(granted.reviewUrl);
  crossTicket.pathname = new URL(secondMedia.reviewUrl).pathname;
  await stream(crossTicket.href, onlyGrant, 403);
  const changedUrl = new URL(granted.reviewUrl);
  changedUrl.pathname = changedUrl.pathname.replace(
    pending.reviewRequestId,
    randomUUID(),
  );
  await stream(changedUrl.href, onlyGrant, 404);
  report.clipIsolation = true;
  for (const [name, args] of [
    ["get_account", {}],
    ["get_credits", {}],
    ["list_sources", {}],
    ["list_history", {}],
    ["list_campaigns", {}],
    ["get_campaign", { campaignId: randomUUID() }],
    ["get_clip", { clipId: target.clipId }],
    [
      "set_zoom",
      {
        editProjectId: target.editProjectId,
        expectedRevision: 0,
        scale: 1.1,
        idempotencyKey: key("deny-edit"),
      },
    ],
    [
      "export_clip",
      {
        editProjectId: target.editProjectId,
        expectedRevision: 0,
        idempotencyKey: key("deny-export"),
      },
    ],
    [
      "create_clips",
      {
        sourceId: a.sourceId,
        mode: "XEEFREE",
        style: "STYLE_ZERO",
        clipCount: 1,
        idempotencyKey: key("deny-generation"),
      },
    ],
  ])
    await error(only, name, args, "INSUFFICIENT_SCOPE");
  report.reviewOnlyLeastPrivilege = true;

  await evidence(only, pending.reviewRequestId, "review-only");
  await call(only, "complete_video_review", {
    reviewRequestId: pending.reviewRequestId,
    reviewPassId: granted.reviewPassId,
    status: "REVIEWED",
    findings: [],
    finishSession: true,
    idempotencyKey: key("no-decoded-evidence"),
  });
  await error(
    only,
    "get_review_media",
    { reviewRequestId: pending.reviewRequestId },
    "AI_VIDEO_REVIEW_COMPLETE",
  );
  report.actualMedia = true;
  report.completionEndsAccess = true;
  const denied = await ask(only, "denied");
  await decide(denied.reviewRequestId, false);
  await error(
    only,
    "get_review_media",
    { reviewRequestId: denied.reviewRequestId },
    "AI_VIDEO_REVIEW_DENIED",
  );
  report.denied = true;
  const revoke = await ask(only, "revoked");
  await decide(revoke.reviewRequestId);
  const revokedMedia = await call(only, "get_review_media", {
    reviewRequestId: revoke.reviewRequestId,
  });
  await request(`/mcp/reviews/${revoke.reviewRequestId}/revoke`, {
    method: "POST",
    expected: 201,
    cookie: a.cookie,
  });
  await error(
    only,
    "get_review_media",
    { reviewRequestId: revoke.reviewRequestId },
    "AI_VIDEO_REVIEW_REVOKED",
  );
  await stream(revokedMedia.reviewUrl, onlyGrant, 403);
  report.revoked = true;
  const off = await ask(only, "off-active");
  await decide(off.reviewRequestId);
  await set(false);
  await error(only, "request_video_review", input, "AI_VIDEO_REVIEW_DISABLED");
  await error(
    only,
    "get_review_media",
    { reviewRequestId: off.reviewRequestId },
    "AI_VIDEO_REVIEW_DISABLED",
  );
  await set(true);
  await error(
    only,
    "get_review_media",
    { reviewRequestId: off.reviewRequestId },
    "AI_VIDEO_REVIEW_REVOKED",
  );
  report.offInvalidatesActiveAccess = true;
  const expired = await ask(only, "expired");
  await decide(expired.reviewRequestId);
  qaDb(
    `const r=await p.aiVideoReviewRequest.findFirst({where:{id:${JSON.stringify(expired.reviewRequestId)},userId:id}});if(!r)throw Error();await p.$transaction([p.aiVideoReviewRequest.update({where:{id:r.id},data:{expiresAt:new Date(Date.now()-1000)}}),p.aiVideoReviewGrant.update({where:{reviewRequestId:r.id},data:{expiresAt:new Date(Date.now()-1000)}})]);console.log(JSON.stringify({expired:true}));`,
  );
  await error(
    only,
    "get_review_media",
    { reviewRequestId: expired.reviewRequestId },
    "AI_VIDEO_REVIEW_EXPIRED",
  );
  report.expired = true;
  const loop = await ask(edit, "edit-review");
  await decide(loop.reviewRequestId, true, true);
  let observed = await evidence(edit, loop.reviewRequestId, "before-edit");
  await call(edit, "complete_video_review", {
    reviewRequestId: loop.reviewRequestId,
    reviewPassId: observed.reviewPassId,
    status: "NEEDS_CHANGES",
    finishSession: false,
    findings: [
      {
        type: "HEADLINE",
        severity: "INFO",
        start: 0,
        end: 1,
        message: "Update the headline to the requested QA wording.",
      },
    ],
    idempotencyKey: key("first-pass"),
  });
  let project = await call(edit, "get_edit_project", {
    editProjectId: target.editProjectId,
  });
  await call(edit, "update_headline", {
    editProjectId: target.editProjectId,
    expectedRevision: project.revision,
    text: "Review " + String(stamp).slice(-6),
    idempotencyKey: key("headline"),
  });
  project = await call(edit, "get_edit_project", {
    editProjectId: target.editProjectId,
  });
  const job = await call(edit, "export_clip", {
    editProjectId: target.editProjectId,
    expectedRevision: project.revision,
    idempotencyKey: key("render"),
  });
  let done;
  for (let i = 0; i < 120; i++) {
    done = await call(edit, "get_export", {
      editProjectId: target.editProjectId,
      exportId: job.exportId,
    });
    if (["COMPLETE", "FAILED"].includes(done.status)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  assert.equal(done.status, "COMPLETE");
  observed = await evidence(edit, loop.reviewRequestId, "after-edit");
  await call(edit, "complete_video_review", {
    reviewRequestId: loop.reviewRequestId,
    reviewPassId: observed.reviewPassId,
    status: "REVIEWED",
    finishSession: true,
    findings: [],
    idempotencyKey: key("verified"),
  });
  await error(
    edit,
    "get_review_media",
    { reviewRequestId: loop.reviewRequestId },
    "AI_VIDEO_REVIEW_COMPLETE",
  );
  report.canonicalEditExportAndRereview = true;
  assert.deepEqual(await call(full, "get_credits"), before);
  report.noReviewCreditCharge = true;
  const audit = qaDb(
    `const events=await p.aiVideoReviewAudit.findMany({where:{userId:id},select:{event:true}});console.log(JSON.stringify({events:[...new Set(events.map(r=>r.event))]}));`,
  );
  for (const e of [
    "REQUESTED",
    "APPROVED",
    "ACCESSED",
    "COMPLETED",
    "DENIED",
    "REVOKED",
    "EXPIRED",
  ])
    assert(audit.events.includes(e));
  report.audit = true;
  report.passed = true;
  delete report.error;
  fs.writeFileSync(
    path.join(dir, "video-review-acceptance.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    "PASS human approval, review-only scope, actual rendered frames/audio, isolation, denial/OFF/expiry/revocation, and canonical edit/export/re-review.",
  );
}
async function setFor(account, enabled) {
  return request("/mcp/reviews/settings", {
    method: "PATCH",
    cookie: account.cookie,
    body: { enabled },
  });
}
main()
  .catch((e) => {
    fs.writeFileSync(
      path.join(dir, "video-review-acceptance.json"),
      JSON.stringify({ ...report, passed: false, error: e.message }, null, 2),
    );
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const c of clients) await c.close();
  });
