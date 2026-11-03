const fs = require("fs"),
  path = require("path"),
  assert = require("assert/strict"),
  { request, connect, call, accounts } = require("./mcp-acceptance-client.cjs");
const file = path.join(
    process.env.MCP_QA_DIR || path.resolve(__dirname, "../../../.cache/mcp"),
    "campaign-acceptance.json",
  ),
  r = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { assets: [] };
const save = () => fs.writeFileSync(file, JSON.stringify(r, null, 2)),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(c, id) {
  for (let i = 0; i < 180; i++) {
    const j = await call(c, "get_job", { jobId: id });
    if (j.status === "COMPLETE") return j;
    if (j.status === "FAILED") throw Error(JSON.stringify(j));
    if (i % 6 === 0) console.log("Campaign: " + j.status);
    await sleep(5000);
  }
  throw Error("Campaign timeout");
}
(async () => {
  const client = await connect(accounts[0]);
  try {
    const id = accounts[0].campaignId;
    for (const [file, mime, type, use] of [
      ["logo.png", "image/png", "LOGO", "LOGO_TOP_RIGHT"],
      ["music.wav", "audio/wav", "MUSIC", "BACKGROUND_MUSIC"],
    ]) {
      if (r.assets.some((a) => a.type === type)) continue;
      const form = new FormData();
      form.set(
        "file",
        new Blob(
          [
            fs.readFileSync(
              path.resolve(
                process.env.MCP_QA_FIXTURES ||
                  path.resolve(
                    __dirname,
                    "../../../.cache/clipper-hardening/qa",
                  ),
                file,
              ),
            ),
          ],
          { type: mime },
        ),
        file,
      );
      form.set("type", type);
      const { value: a } = await request("/campaigns/" + id + "/assets", {
        method: "POST",
        expected: 201,
        cookie: accounts[0].cookie,
        body: form,
      });
      await request("/campaigns/" + id + "/assets/" + a.id, {
        method: "PATCH",
        cookie: accounts[0].cookie,
        body: { required: true, intendedUse: use },
      });
      r.assets.push({ assetId: a.id, type });
      save();
    }
    let c = await call(client, "get_campaign", { campaignId: id });
    if (!r.understood) {
      const u = await call(client, "understand_campaign", {
        campaignId: id,
        expectedBriefVersion: c.brief.version,
        rules:
          "Duration: 15–90 seconds\nRequired topics: arguments\nLogo: top-right\nCaptions: required\nAspect ratio: 9:16\nMusic: campaign track",
        mode: "XEEFREE",
        idempotencyKey: "mcp-campaign-understand-001",
      });
      r.understood = u.briefVersion;
      save();
    }
    c = await call(client, "get_campaign", { campaignId: id });
    if (!r.confirmed) {
      await call(client, "confirm_campaign", {
        campaignId: id,
        briefVersion: c.brief.version,
        userConfirmed: true,
        acknowledgeUnresolved: true,
        idempotencyKey: "mcp-campaign-confirm-001",
      });
      r.confirmed = true;
      save();
    }
    if (!r.source) {
      r.source = await call(client, "attach_campaign_source", {
        campaignId: id,
        sourceId: accounts[0].sourceId,
        rightsConfirmed: true,
        idempotencyKey: "mcp-campaign-source-001",
      });
      save();
    }
    if (!r.job) {
      const input = {
        campaignId: id,
        campaignSourceIds: [r.source.campaignSourceId],
        mode: "XEEFREE",
        style: "STYLE_ONE",
        clipCount: 1,
        idempotencyKey: "mcp-campaign-generate-001",
      };
      r.job = await call(client, "generate_campaign_clips", input);
      assert.deepEqual(
        await call(client, "generate_campaign_clips", input),
        r.job,
      );
      save();
    }
    r.result = await poll(client, r.job.jobId);
    assert.equal(r.result.mode, "XEEFREE");
    const cc = r.result.campaignClipIds[0];
    assert(cc);
    const compliance = await call(client, "get_campaign_clip_compliance", {
      campaignClipId: cc,
    });
    assert(!["FAIL", "UNKNOWN"].includes(compliance.compliance.status));
    c = await call(client, "get_campaign", { campaignId: id });
    const clip = c.clips.find((c) => c.campaignClipId === cc);
    assert(clip);
    const p = await call(client, "get_edit_project", {
      editProjectId: clip.editProjectId,
    });
    assert(p.captions.length && p.overlays.length && p.music.length);
    assert(p.assets.some((a) => a.campaignAssetId === r.assets[0].assetId));
    r.clip = {
      campaignClipId: cc,
      editProjectId: p.editProjectId,
      revision: p.revision,
    };
    r.compliance = compliance.compliance.status;
    r.passed = true;
    save();
    console.log(
      "PASS MCP campaign stored logo/music → Free understanding → explicit confirmation → source → generation → canonical assets/captions → compliance.",
    );
  } finally {
    await client.close();
  }
})().catch((e) => {
  r.error = e.message;
  save();
  console.error(e.stack);
  process.exitCode = 1;
});
