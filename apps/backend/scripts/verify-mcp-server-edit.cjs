// Disposable end-to-end editor acceptance. All MCP reads/mutations/exports use Bearer ONLY.
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { createHash, randomUUID } = require("node:crypto"),
  { execFileSync } = require("node:child_process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js"),
  {
    StreamableHTTPClientTransport,
  } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const h = require("./mcp-acceptance-client.cjs"),
  dir = process.env.MCP_QA_DIR;
assert(h.accounts.length === 2);
const report = {},
  clients = [],
  stamp = Date.now();
let calls = 0;
const save = () =>
  fs.writeFileSync(
    path.join(dir, "server-edit-acceptance.json"),
    JSON.stringify(report, null, 2),
  );
const key = (s) => "server-edit-" + stamp + "-" + s;
function allow(g) {
  if (!process.env.MCP_QA_GATE_STATE) return;
  const file = process.env.MCP_QA_GATE_STATE,
    s = JSON.parse(fs.readFileSync(file));
  s.qaBearerHashes = [
    ...new Set([
      ...(s.qaBearerHashes || []),
      createHash("sha256").update(g.tokens.access_token).digest("hex"),
    ]),
  ];
  fs.writeFileSync(file, JSON.stringify(s));
}
async function plain(g, name) {
  allow(g);
  const c = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(h.base + "/mcp"),
    {
      requestInit: {
        headers: { Authorization: "Bearer " + g.tokens.access_token },
      },
      fetch: async (url, init) => {
        assert(
          !new Headers(init?.headers).has("cookie"),
          "MCP must not send browser cookies",
        );
        assert(
          new URL(url).origin === new URL(h.base).origin,
          "MCP must not open frontend",
        );
        calls++;
        return fetch(url, init);
      },
    },
  );
  await c.connect(transport);
  clients.push(c);
  return c;
}
const fail = async (c, name, args, code) => {
  const r = await c.callTool({ name: "xeeclip_" + name, arguments: args });
  assert(r.isError, name);
  assert.equal(r.structuredContent.error.code, code, name);
};
async function ownedDb(a, code) {
  assert.match(a.email, /^mcp-qa-\d+-[01]@example\.invalid$/);
  const body = `const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();(async()=>{const id=${JSON.stringify(a.userId)};const u=await p.user.findUnique({where:{id}});if(u?.email!==${JSON.stringify(a.email)}||u.role!=='USER')throw Error('QA identity required');${code}})().catch(()=>{console.error('Disposable fault injection failed');process.exitCode=1}).finally(()=>p.$disconnect());`;
  return JSON.parse(
    execFileSync(
      "docker",
      [
        "exec",
        "-i",
        h.base.startsWith("http:")
          ? "xeeclip-mcp-qa-backend-1"
          : "ai-content-backend",
        "node",
        "-",
      ],
      { input: body, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ),
  );
}
async function createFixture(a) {
  let { value: p } = await h.request("/edit-mode/projects", {
    method: "POST",
    expected: 201,
    cookie: a.cookie,
    body: { name: "Disposable MCP server-side edit " + stamp },
  });
  const form = new FormData();
  form.set("revision", String(p.revision));
  form.set(
    "file",
    new Blob([fs.readFileSync(process.env.MCP_EDIT_FIXTURE)], {
      type: "video/mp4",
    }),
    "disposable-white-bar.mp4",
  );
  ({ value: p } = await h.request(
    "/edit-mode/projects/" + p.id + "/source/upload",
    { method: "POST", expected: 201, cookie: a.cookie, body: form },
  ));
  const command = async (action, input) => {
    if (action === "ADD_SUBTITLE") {
      const cue = {
        assetId: null,
        type: "SUBTITLE",
        track: 1,
        position: p.elements.length,
        startTime: input.startTime,
        duration: input.duration,
        trimStart: 0,
        trimEnd: null,
        properties: {
          content: input.content,
          x: input.x,
          y: input.y,
          width: input.width,
          height: input.height,
          fontSize: 24,
          fontFamily: "Arial, sans-serif",
          color: "#ffffff",
          backgroundColor: "#00000099",
          textAlign: "center",
          opacity: 1,
          zIndex: 35,
          hidden: false,
        },
      };
      const elements = [
        ...p.elements.map((e) =>
          Object.fromEntries(
            [
              "assetId",
              "type",
              "track",
              "position",
              "startTime",
              "duration",
              "trimStart",
              "trimEnd",
              "properties",
            ].map((k) => [k, e[k]]),
          ),
        ),
        cue,
      ];
      ({ value: p } = await h.request(
        "/edit-mode/projects/" + p.id + "/elements",
        {
          method: "PATCH",
          cookie: a.cookie,
          body: { revision: p.revision, elements },
        },
      ));
    } else {
      ({ value: p } = await h.request(
        "/edit-mode/projects/" + p.id + "/commands/" + action,
        {
          method: "POST",
          expected: 201,
          cookie: a.cookie,
          body: { revision: p.revision, ...input },
        },
      ));
    }
  };
  await command("ADD_TEXT", { content: "Wrong headline" });
  const title = p.elements.find((e) => e.type === "TEXT").id;
  await command("MOVE_ELEMENT", { elementId: title, x: 0.1, y: 0.05 });
  await command("ADD_TEXT", { content: "EXTRA TOP TITLE" });
  const extra = p.elements.find((e) => e.type === "TEXT" && e.id !== title).id;
  await command("MOVE_ELEMENT", { elementId: extra, x: 0.1, y: 0.01 });
  await command("ADD_SUBTITLE", {
    content: "Original speaker caption",
    startTime: 0,
    duration: 8,
    x: 0.1,
    y: 0.56,
    width: 0.8,
    height: 0.08,
  });
  const keep = p.elements.find((e) => e.type === "SUBTITLE").id;
  await command("ADD_SUBTITLE", {
    content: "Duplicate bottom caption",
    startTime: 0,
    duration: 4,
    x: 0.1,
    y: 0.86,
    width: 0.8,
    height: 0.08,
  });
  await command("ADD_SUBTITLE", {
    content: "Duplicate bottom caption",
    startTime: 4,
    duration: 4,
    x: 0.1,
    y: 0.86,
    width: 0.8,
    height: 0.08,
  });
  return {
    projectId: p.id,
    title: p.elements.find(
      (e) => e.type === "TEXT" && e.properties.content === "Wrong headline",
    ).id,
    extra: p.elements.find(
      (e) => e.type === "TEXT" && e.properties.content === "EXTRA TOP TITLE",
    ).id,
    keep: p.elements.find(
      (e) =>
        e.type === "SUBTITLE" &&
        e.properties.content === "Original speaker caption",
    ).id,
    duplicates: p.elements
      .filter(
        (e) =>
          e.type === "SUBTITLE" &&
          e.properties.content === "Duplicate bottom caption",
      )
      .map((e) => e.id),
  };
}
async function exportVideo(c, p, label) {
  const input = {
      editProjectId: p.editProjectId,
      expectedRevision: p.revision,
      idempotencyKey: key(label),
    },
    j = await h.call(c, "export_clip", input);
  assert.deepEqual(await h.call(c, "export_clip", input), j);
  for (let i = 0; i < 100; i++) {
    const e = await h.call(c, "get_export", {
      editProjectId: p.editProjectId,
      exportId: j.exportId,
    });
    if (e.status === "FAILED") throw Error("Canonical export failed");
    if (e.status === "COMPLETE") return e;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw Error("Bounded export timeout");
}
(async () => {
  const a = h.accounts[0],
    b = h.accounts[1],
    fixture = await createFixture(a);
  report.fixture = fixture;
  save();
  const editScopes = [
    "xeeclip:clips:read",
    "xeeclip:clips:edit",
    "xeeclip:clips:export",
    "xeeclip:media:review",
  ];
  const editable = await h.grant(a, editScopes),
    foreign = await h.grant(b, editScopes),
    readonly = await h.grant(a, ["xeeclip:media:review"]);
  const c = await plain(editable, "OpenAI MCP editor acceptance"),
    other = await plain(foreign, "Claude-compatible ownership client"),
    reviewOnly = await plain(readonly, "Review-only least privilege");
  let p = await h.call(c, "get_edit_project", {
    editProjectId: fixture.projectId,
  });
  assert.equal(p.textLayers.length, 2);
  assert.equal(p.captions.length, 3);
  assert.equal(
    p.captions.find((x) => x.elementId === fixture.keep).box.y,
    0.56,
  );
  const source = p.videos[0],
    credits = (await h.request("/auth/session", { cookie: a.cookie })).value
      .creditBalance;
  const initial = await exportVideo(c, p, "initial-export");
  await h.request("/mcp/reviews/settings", {
    method: "PATCH",
    cookie: a.cookie,
    body: { enabled: true },
  });
  const review = await h.call(c, "request_video_review", {
    clipId: fixture.projectId,
    purpose:
      "Review and fix this disposable white-bar headline and duplicate-caption fixture.",
    idempotencyKey: key("review"),
  });
  const { value: consent } = await h.request(
    "/mcp/reviews/" + review.reviewRequestId + "/consent",
    { cookie: a.cookie },
  );
  await h.request("/mcp/reviews/" + review.reviewRequestId + "/decision", {
    method: "POST",
    expected: 201,
    cookie: a.cookie,
    body: { nonce: consent.nonce, approve: true, allowRevisions: true },
  });
  const before = await c.callTool({
    name: "xeeclip_review_video",
    arguments: {
      reviewRequestId: review.reviewRequestId,
      startSeconds: 0,
      durationSeconds: 1,
    },
  });
  assert(!before.isError);
  fs.writeFileSync(
    path.join(dir, "edit-before.jpg"),
    Buffer.from(before.content.find((x) => x.type === "image").data, "base64"),
  );
  await h.call(c, "complete_video_review", {
    reviewRequestId: review.reviewRequestId,
    reviewPassId: before.structuredContent.reviewPassId,
    status: "NEEDS_CHANGES",
    finishSession: false,
    findings: [
      {
        type: "HEADLINE",
        severity: "WARN",
        start: 0,
        end: 1,
        message:
          "Put the requested headline in the white bar and remove only the extra title and duplicate bottom caption layers.",
      },
    ],
    idempotencyKey: key("findings"),
  });
  report.actualReview = true;
  const input = {
    editProjectId: p.editProjectId,
    expectedRevision: p.revision,
    elementId: fixture.title,
    text: "Before You Trade, Mark This",
    box: { x: 0.1, y: 0.22, width: 0.8, height: 0.1 },
    fontSize: 32,
    stroke: { enabled: false, color: "#000000", width: 0 },
    shadow: {
      enabled: false,
      color: "#000000",
      opacity: 0,
      blur: 0,
      offsetX: 0,
      offsetY: 0,
    },
    color: "#000000",
    textAlign: "center",
    background: {
      enabled: false,
      color: "#ffffff",
      opacity: 0,
      padding: 0,
      radius: 0,
    },
    idempotencyKey: key("headline"),
  };
  await fail(reviewOnly, "update_headline", input, "INSUFFICIENT_SCOPE");
  await fail(other, "update_headline", input, "NOT_FOUND");
  const done = await h.call(c, "update_headline", input);
  assert.deepEqual(await h.call(c, "update_headline", input), done);
  await fail(
    c,
    "update_headline",
    { ...input, idempotencyKey: key("stale") },
    "EDIT_CONFLICT",
  );
  p = await h.call(c, "get_edit_project", { editProjectId: p.editProjectId });
  assert.equal(p.revision, done.revision);
  assert.equal(p.headline.text, input.text);
  assert.equal(p.headline.box.y, 0.22);
  assert.equal(p.headline.style.color, "#000000");
  assert.equal(p.headline.style.background.enabled, false);
  assert.equal(p.headline.style.stroke.enabled,false);
  assert.equal(p.headline.style.shadow.enabled,false);
  report.headline = true;
  let rev = p.revision;
  await h.call(c, "remove_overlay", {
    editProjectId: p.editProjectId,
    expectedRevision: rev,
    elementIds: [fixture.extra, ...fixture.duplicates],
    idempotencyKey: key("remove-duplicates"),
  });
  p = await h.call(c, "get_edit_project", { editProjectId: p.editProjectId });
  assert.equal(p.revision, rev + 1);
  assert.equal(p.textLayers.length, 1);
  assert.equal(p.captions.length, 1);
  assert.equal(p.captions[0].elementId, fixture.keep);
  await h.call(c, "undo", {
    editProjectId: p.editProjectId,
    expectedRevision: p.revision,
    idempotencyKey: key("undo"),
  });
  p = await h.call(c, "get_edit_project", { editProjectId: p.editProjectId });
  assert.equal(p.captions.length, 3);
  await h.call(c, "redo", {
    editProjectId: p.editProjectId,
    expectedRevision: p.revision,
    idempotencyKey: key("redo"),
  });
  p = await h.call(c, "get_edit_project", { editProjectId: p.editProjectId });
  assert.equal(p.captions.length, 1);
  await h.call(c, "update_caption", {
    editProjectId: p.editProjectId,
    expectedRevision: p.revision,
    captionElementId: fixture.keep,
    text: "Original speaker caption",
    idempotencyKey: key("caption"),
  });
  p = await h.call(c, "get_edit_project", { editProjectId: p.editProjectId });
  assert.deepEqual(
    p.videos[0],
    source,
    "Source video state/pixels/audio must remain untouched",
  );
  report.captionSelection = true;
  report.undoRedo = true;
  const saved = await h.call(c, "save_edit", {
    editProjectId: p.editProjectId,
    expectedRevision: p.revision,
    idempotencyKey: key("save"),
  });
  assert.equal(saved.revision, p.revision);
  const website = (
    await h.request("/edit-mode/projects/" + p.editProjectId, {
      cookie: a.cookie,
    })
  ).value;
  assert.equal(website.revision, p.revision);
  assert.equal(website.elements.filter((e) => e.type === "SUBTITLE").length, 1);
  report.websitePersistence = true;
  const exported = await exportVideo(c, p, "final-export");
  for (const [g, status] of [
    [editable, 206],
    [foreign, 404],
  ]) {
    const r = await fetch(exported.downloadUrl, {
      headers: {
        Authorization: "Bearer " + g.tokens.access_token,
        Range: "bytes=0-1023",
      },
      redirect: "manual",
    });
    assert.equal(r.status, status);
    if (r.ok) assert.equal((await r.arrayBuffer()).byteLength, 1024);
    else await r.arrayBuffer();
  }
  const after = await c.callTool({
    name: "xeeclip_review_video",
    arguments: {
      reviewRequestId: review.reviewRequestId,
      startSeconds: 0,
      durationSeconds: 1,
    },
  });
  assert(!after.isError);
  assert.notEqual(
    after.structuredContent.reviewPassId,
    before.structuredContent.reviewPassId,
  );
  fs.writeFileSync(
    path.join(dir, "edit-after.jpg"),
    Buffer.from(after.content.find((x) => x.type === "image").data, "base64"),
  );
  await h.call(c, "complete_video_review", {
    reviewRequestId: review.reviewRequestId,
    reviewPassId: after.structuredContent.reviewPassId,
    status: "REVIEWED",
    finishSession: true,
    findings: [],
    idempotencyKey: key("complete"),
  });
  report.exportAndRereview = true;
  report.exportId = exported.exportId;
  const exp = await h.grant(a, ["xeeclip:clips:read"]),
    revoked = await h.grant(a, ["xeeclip:clips:read"]);
  allow(exp);
  allow(revoked);
  await ownedDb(
    a,
    `const expired=await p.mcpGrant.findFirst({where:{userId:id,clientId:${JSON.stringify(exp.client.client_id)}}});const revoked=await p.mcpGrant.findFirst({where:{userId:id,clientId:${JSON.stringify(revoked.client.client_id)}}});if(!expired||!revoked)throw Error('QA grants missing');await p.mcpToken.updateMany({where:{grantId:expired.id,kind:'ACCESS'},data:{expiresAt:new Date(Date.now()-1000)}});await p.mcpGrant.update({where:{id:revoked.id},data:{revokedAt:new Date()}});console.log(JSON.stringify({injected:true}));`,
  );
  for (const [g, code] of [
    [exp, "AUTH_EXPIRED"],
    [revoked, "TOKEN_REVOKED"],
  ]) {
    const r = await fetch(h.base + "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + g.tokens.access_token,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "expiry-test", version: "1" },
        },
      }),
      redirect: "manual",
    });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, code);
  }
  report.authMatrix = {
    ownEdit: true,
    noEditScope: true,
    foreignProject: true,
    expiredToken: true,
    revokedToken: true,
    staleRevision: true,
    bearerExport: true,
  };
  const current = (await h.request("/auth/session", { cookie: a.cookie })).value
    .creditBalance;
  assert.equal(current, credits);
  report.noCreditChange = true;
  report.noCookieMcpRequests = calls;
  report.noBrowserLogin = true;
  report.passed = true;
  save();
  console.log(
    "PASS OAuth Bearer-only review → exact white-bar headline → selective title/caption removal → canonical save/undo/redo/export/re-review; A–G auth/ownership matrix; no browser or credits required.",
  );
})()
  .catch((e) => {
    report.error = e.message;
    save();
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const c of clients) await c.close();
  });
