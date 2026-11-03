const fs = require("fs"),
  path = require("path"),
  assert = require("assert/strict"),
  { execFileSync } = require("child_process");
const {
  request,
  connect,
  call,
  accounts,
  save,
  base,
} = require("./mcp-acceptance-client.cjs");
const dir = path.resolve(process.env.MCP_QA_DIR||path.join(__dirname,"../../../.cache/mcp")),
  file = path.join(dir, "media-acceptance.json");
const report={create:[],quick:[],editor:[],...(fs.existsSync(file)?JSON.parse(fs.readFileSync(file)): {})};
const write = () => {
  const latest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
  const section =
    process.argv.find((a) => a.startsWith("--section="))?.split("=")[1] ||
    "create";
  const keys =
    section === "editor"
      ? ["editor", "export"]
      : section === "quick"
        ? ["quick"]
        : ["create"];
  for (const k of keys) latest[k] = report[k];
  if (report.error) latest.error = report.error; else delete latest.error;
  fs.writeFileSync(file, JSON.stringify(latest, null, 2));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(client, name, args, label) {
  const end = Date.now() + 900000;
  let logged = 0;
  while (Date.now() < end) {
    const r = await call(client, name, args);
    if (["FAILED", "PARTIAL"].includes(r.status))
      throw Error(label + " " + JSON.stringify(r));
    if (r.status === "COMPLETE") return r;
    if (Date.now() - logged > 30000) {
      console.log(label + ": " + r.status);
      logged = Date.now();
    }
    await sleep(5000);
  }
  throw Error(label + " timeout");
}
async function bootstrap() {
  if (accounts[0].sourceId) return;
  const { value: p } = await request("/projects", {
    method: "POST",
    expected: 201,
    cookie: accounts[0].cookie,
    body: { name: "MCP disposable media" },
  });
  const form = new FormData();
  form.set(
    "file",
    new Blob(
      [
        fs.readFileSync(
          process.env.MCP_QA_SOURCE_PATH ||
            path.resolve(dir, "../clipper-hardening/qa/source.mp4"),
        ),
      ],
      { type: "video/mp4" },
    ),
    "MCP-disposable-source.mp4",
  );
  form.set("aiMode", "FALLBACK_ONLY");
  const { value: v } = await request("/projects/" + p.id + "/videos", {
    method: "POST",
    expected: 201,
    cookie: accounts[0].cookie,
    body: form,
  });
  accounts[0].sourceId = v.id;
  save();
  console.log("Uploaded owned disposable source through existing upload API.");
}
async function sourceReady(client) {
  for (let i = 0; i < 180; i++) {
    const r = await call(client, "get_source", {
      sourceId: accounts[0].sourceId,
    });
    if (r.status === "COMPLETED") return;
    if (r.status === "FAILED") throw Error("Source failed");
    await sleep(3000);
  }
  throw Error("Source analysis timeout");
}
async function create(client) {
  await sourceReady(client);
  for (const style of ["STYLE_ZERO", "STYLE_ONE", "STYLE_TWO"]) {
    if (report.create.some((r) => r.style === style)) continue;
    const input = {
      sourceId: accounts[0].sourceId,
      mode: "XEEFREE",
      style,
      clipCount: 1,
      idempotencyKey: "mcp-free-" + style + "-001",
    };
    const job = await call(client, "create_clips", input);
    assert.deepEqual(await call(client, "create_clips", input), job);
    write();
    const done = await poll(
      client,
      "get_job",
      { jobId: job.jobId },
      "Free " + style,
    );
    assert.equal(done.mode, "XEEFREE");
    assert.equal(done.resultIds.length, 1);
    const clip = await call(client, "get_clip", { clipId: done.resultIds[0] });
    if (!clip.editProjectId) {
      const restored = await call(client, "restore_edit_project", {
        clipId: clip.clipId,
        idempotencyKey: "restore-" + style + "-001",
      });
      clip.editProjectId = restored.editProjectId;
    }
    assert(clip.editProjectId);
    report.create.push({
      style,
      jobId: job.jobId,
      clipId: clip.clipId,
      editProjectId: clip.editProjectId,
      revision: clip.revision,
    });
    write();
    console.log("PASS real MCP Free " + style + " → owned canonical editor.");
  }
}
async function quick(client) {
  await sourceReady(client);
  for (const style of ["STYLE_ONE"]) {
    if (report.quick.some((r) => r.style === style)) continue;
    const input = {
      sourceId: accounts[0].sourceId,
      mode: "XEEFREE",
      style,
      idempotencyKey: "mcp-quick-" + style + "-001",
    };
    const job = await call(client, "quick_reframe", input);
    assert.deepEqual(await call(client, "quick_reframe", input), job);
    const done = await poll(
      client,
      "get_reframe_result",
      { reframeId: job.reframeId },
      "Reframe " + style,
    );
    assert.equal(done.mode, "XEEFREE");
    assert.equal(done.style, style);
    report.quick.push({
      style,
      reframeId: job.reframeId,
      editProjectId: done.editProjectId,
    });
    write();
    console.log(
      "PASS real MCP Quick Reframe result, saved canonical project and stable retry.",
    );
  }
}
async function editor(client) {
  const target = report.create.find((r) => r.style === "STYLE_ONE");
  assert(target);
  const id = target.editProjectId;
  let p = await call(client, "get_edit_project", { editProjectId: id });
  const actions = [
    [
      "set_crop",
      { crop: { left: 0.01, right: 0.01, top: 0.01, bottom: 0.01 } },
    ],
    ["set_zoom", { scale: 1.12 }],
    ["set_pan", { x: 0.03, y: -0.02 }],
    ["set_source_volume", { volume: 0.9 }],
    ["set_filter", { preset: "WARM", strength: 0.3 }],
    [
      "set_visual_adjustments",
      { adjustments: { brightness: 0.05, contrast: 0.1 } },
    ],
    ["update_headline", { text: "Ideas need evidence" }],
  ];
  for (const [name, args] of actions) {
    if (report.editor.includes(name)) continue;
    const input = {
      editProjectId: id,
      expectedRevision: p.revision,
      idempotencyKey: "mcp-edit-" + name + "-002",
      ...(!["update_headline"].includes(name)
        ? { elementId: p.videos[0].elementId }
        : {}),
      ...args,
    };
    const before = p.revision,
      changed = await call(client, name, input);
    assert.equal(changed.revision, before + 1);
    assert.deepEqual(await call(client, name, input), changed);
    p = await call(client, "get_edit_project", { editProjectId: id });
    assert.equal(p.revision, before + 1);
    report.editor.push(name);
    write();
    console.log("PASS canonical " + name + " and exact retry.");
  }
  if (!report.editor.includes("caption")) {
    assert(p.captions.length);
    const cue = p.captions[0];
    const r = await call(client, "update_caption", {
      editProjectId: id,
      expectedRevision: p.revision,
      captionElementId: cue.elementId,
      text: "A carefully checked idea.",
      idempotencyKey: "mcp-caption-001",
    });
    p = await call(client, "get_edit_project", { editProjectId: id });
    assert.equal(p.revision, r.revision);
    assert.equal(p.captions[0].text, "A carefully checked idea.");
    report.editor.push("caption");
    write();
  }
  if (!report.editor.includes("undo-redo")) {
    const text = p.headline.text;
    await call(client, "undo", {
      editProjectId: id,
      expectedRevision: p.revision,
      idempotencyKey: "mcp-undo-001",
    });
    p = await call(client, "get_edit_project", { editProjectId: id });
    assert.notEqual(p.captions[0].text, "A carefully checked idea.");
    await call(client, "redo", {
      editProjectId: id,
      expectedRevision: p.revision,
      idempotencyKey: "mcp-redo-001",
    });
    p = await call(client, "get_edit_project", { editProjectId: id });
    assert.equal(p.captions[0].text, "A carefully checked idea.");
    assert.equal(p.headline.text, text);
    report.editor.push("undo-redo");
    write();
  }
  if (!report.editor.includes("concurrency")) {
    const stale = p.revision;
    await request("/edit-mode/projects/" + id, {
      method: "PATCH",
      cookie: accounts[0].cookie,
      body: { revision: stale, name: "MCP website concurrency check" },
    });
    const denied = await client.callTool({
      name: "xeeclip_set_zoom",
      arguments: {
        editProjectId: id,
        expectedRevision: stale,
        scale: 1.2,
        idempotencyKey: "mcp-stale-001",
      },
    });
    assert(denied.isError);
    assert.equal(denied.structuredContent.error.code, "EDIT_CONFLICT");
    p = await call(client, "get_edit_project", { editProjectId: id });
    assert.equal(p.revision, stale + 1);
    report.editor.push("concurrency");
    write();
  }
  if (!report.export) {
    const job = await call(client, "export_clip", {
      editProjectId: id,
      expectedRevision: p.revision,
      idempotencyKey: "mcp-export-editor-001",
    });
    const done = await poll(
      client,
      "get_export",
      { editProjectId: id, exportId: job.exportId },
      "Canonical export",
    );
    assert(done.downloadUrl);
    const r = await fetch(done.downloadUrl, {
      headers: { Authorization: "Bearer " + accounts[0].tokens.access_token },
    });
    assert.equal(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    assert(buf.length > 10000);
    const f = path.join(dir, "mcp-canonical-export.mp4");
    fs.writeFileSync(f, buf);
    const probe = JSON.parse(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-show_streams", "-of", "json", f],
        { encoding: "utf8" },
      ),
    );
    assert(
      probe.streams.some((s) => s.codec_type === "video") &&
        probe.streams.some((s) => s.codec_type === "audio"),
    );
    const denied = await fetch(done.downloadUrl, {
      headers: { Authorization: "Bearer " + accounts[1].tokens.access_token },
    });
    assert.equal(denied.status, 404);
    report.export = {
      passed: true,
      editProjectId: id,
      exportId: job.exportId,
      bytes: buf.length,
      ownership: true,
    };
    write();
    console.log(
      "PASS canonical async export, real MP4, scoped bearer download and cross-user denial.",
    );
  }
}
(async () => {
  await bootstrap();
  const c = await connect(accounts[0]);
  try {
    const section =
      process.argv.find((a) => a.startsWith("--section="))?.split("=")[1] ||
      "create";
    if (section === "create") await create(c);
    if (section === "quick") await quick(c);
    if (section === "editor") await editor(c);
    delete report.error;write();
  } finally {
    await c.close();
  }
})().catch((e) => {
  report.error = e.message;
  write();
  console.error(e.stack);
  process.exitCode = 1;
});
