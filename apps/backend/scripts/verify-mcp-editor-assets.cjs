const artifactDir = require("path").resolve(
  process.env.MCP_QA_DIR ||
    require("path").join(__dirname, "../../../.cache/mcp"),
);
const fs = require("fs"),
  path = require("path"),
  assert = require("assert/strict"),
  { request, connect, call, accounts } = require("./mcp-acceptance-client.cjs");
const file = path.join(
    process.env.MCP_QA_DIR || path.resolve(__dirname, "../../../.cache/mcp"),
    "editor-assets-acceptance.json",
  ),
  r = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { steps: [] },
  save = () => fs.writeFileSync(file, JSON.stringify(r, null, 2)),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const media = JSON.parse(
      fs.readFileSync(path.join(artifactDir, "media-acceptance.json")),
    ),
    campaign = JSON.parse(
      fs.readFileSync(path.join(artifactDir, "campaign-acceptance.json")),
    ),
    id = media.create[1].editProjectId,
    c = await connect(accounts[0]);
  try {
    let p = await call(c, "get_edit_project", { editProjectId: id });
    const asset = (type) => ({
      kind: "CAMPAIGN_ASSET",
      campaignId: accounts[0].campaignId,
      assetId: campaign.assets.find((a) => a.type === type).assetId,
    });
    const { tools } = await c.listTools();
    const preset = tools.find((t) => t.name === "xeeclip_set_caption_style")
      .inputSchema.properties.preset.enum[0];
    const commands = [
      ["set_music", { asset: asset("MUSIC"), volume: 0.2 }],
      ["set_music_volume", { volume: 1 }],
      ["set_caption_style", { preset }],
      ["add_logo", { asset: asset("LOGO") }],
      ["add_image_overlay", { asset: asset("LOGO") }],
    ];
    for (const [name, args] of commands) {
      if (r.steps.includes(name)) continue;
      const input = {
        editProjectId: id,
        expectedRevision: p.revision,
        idempotencyKey: "assets-" + name + "-001",
        ...args,
      };
      const done = await call(c, name, input);
      assert.deepEqual(await call(c, name, input), done);
      p = await call(c, "get_edit_project", { editProjectId: id });
      assert.equal(p.revision, done.revision);
      if (name === "set_music_volume")
        assert(p.music.every((m) => m.volume === 1));
      r.steps.push(name);
      save();
      console.log(
        "PASS " +
          name +
          " uses stored authorized assets and one stable receipt.",
      );
    }
    if (!r.steps.includes("overlay")) {
      const overlay = p.overlays.at(-1);
      assert(overlay);
      await call(c, "update_overlay", {
        editProjectId: id,
        elementId: overlay.elementId,
        expectedRevision: p.revision,
        x: 0.1,
        y: 0.1,
        width: 0.2,
        height: 0.15,
        opacity: 0.8,
        idempotencyKey: "assets-overlay-001",
      });
      p = await call(c, "get_edit_project", { editProjectId: id });
      await call(c, "remove_overlay", {
        editProjectId: id,
        elementId: overlay.elementId,
        expectedRevision: p.revision,
        idempotencyKey: "assets-remove-overlay-001",
      });
      p = await call(c, "get_edit_project", { editProjectId: id });
      assert(!p.overlays.some((o) => o.elementId === overlay.elementId));
      r.steps.push("overlay");
      save();
    }
    if (!r.steps.includes("trim")) {
      const v = p.videos[0];
      await call(c, "trim_video", {
        editProjectId: id,
        elementId: v.elementId,
        expectedRevision: p.revision,
        start: v.sourceStart + 0.05,
        end: v.sourceEnd - 0.05,
        idempotencyKey: "assets-trim-001",
      });
      p = await call(c, "get_edit_project", { editProjectId: id });
      assert(Math.abs(p.videos[0].sourceStart - v.sourceStart - 0.05) < 0.001);
      r.steps.push("trim");
      save();
    }
    if (!r.steps.includes("save")) {
      const before = p.revision;
      const saved = await call(c, "save_edit", {
        editProjectId: id,
        expectedRevision: p.revision,
        idempotencyKey: "assets-save-001",
      });
      assert.equal(saved.revision, before);
      r.steps.push("save");
      save();
    }
    if (!r.quickExport) {
      const q = media.quick[0];
      p = await call(c, "get_edit_project", { editProjectId: q.editProjectId });
      const before = await call(c, "get_credits"),
        input = {
          editProjectId: p.editProjectId,
          expectedRevision: p.revision,
          idempotencyKey: "mcp-quick-export-001",
        };
      const job = await call(c, "export_clip", input);
      assert.deepEqual(await call(c, "export_clip", input), job);
      let done;
      for (let i = 0; i < 180; i++) {
        done = await call(c, "get_export", {
          editProjectId: p.editProjectId,
          exportId: job.exportId,
        });
        if (done.status === "COMPLETE") break;
        if (done.status === "FAILED") throw Error(JSON.stringify(done));
        await sleep(5000);
      }
      assert.equal(done.status, "COMPLETE");
      assert.equal((await call(c, "get_credits")).credits, before.credits - 1);
      const resp = await fetch(done.downloadUrl, {
        headers: {
          Authorization: "Bearer " + accounts[0].tokens.access_token,
          Range: "bytes=0-1023",
        },
      });
      assert.equal(resp.status, 206);
      assert.equal((await resp.arrayBuffer()).byteLength, 1024);
      r.quickExport = {
        passed: true,
        exportId: job.exportId,
        chargedExactlyOnce: true,
        rangeDownload: true,
      };
      save();
      console.log(
        "PASS Quick Reframe canonical export, exact one credit, stable retry and authenticated range download.",
      );
    }
    r.passed = true;
    save();
  } finally {
    await c.close();
  }
})().catch((e) => {
  r.error = e.message;
  save();
  console.error(e.stack);
  process.exitCode = 1;
});
