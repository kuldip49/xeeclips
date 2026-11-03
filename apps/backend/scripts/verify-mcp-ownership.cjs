const artifactDir = require("path").resolve(
  process.env.MCP_QA_DIR ||
    require("path").join(__dirname, "../../../.cache/mcp"),
);
const fs = require("fs"),
  path = require("path"),
  assert = require("assert/strict"),
  { request, connect, call, accounts } = require("./mcp-acceptance-client.cjs");
(async () => {
  const media = JSON.parse(
      fs.readFileSync(
        path.join(
          process.env.MCP_QA_DIR ||
            path.resolve(__dirname, "../../../.cache/mcp"),
          "media-acceptance.json",
        ),
      ),
    ),
    campaign = JSON.parse(
      fs.readFileSync(path.join(artifactDir, "campaign-acceptance.json")),
    ),
    b = await connect(accounts[1]);
  try {
    const probes = [
      ["get_source", { sourceId: accounts[0].sourceId }],
      ["get_clip", { clipId: media.create[0].clipId }],
      ["get_job", { jobId: media.create[0].jobId }],
      ["get_edit_project", { editProjectId: media.create[1].editProjectId }],
      ["get_campaign", { campaignId: accounts[0].campaignId }],
      [
        "get_campaign_clip_compliance",
        { campaignClipId: campaign.clip.campaignClipId },
      ],
      ["get_reframe_result", { reframeId: media.quick[0].reframeId }],
      [
        "get_export",
        {
          editProjectId: media.export.editProjectId,
          exportId: media.export.exportId,
        },
      ],
      [
        "set_zoom",
        {
          editProjectId: media.create[1].editProjectId,
          expectedRevision: 0,
          scale: 1.2,
          idempotencyKey: "foreign-project-001",
        },
      ],
      [
        "attach_campaign_source",
        {
          campaignId: accounts[0].campaignId,
          sourceId: accounts[0].sourceId,
          rightsConfirmed: true,
          idempotencyKey: "foreign-source-001",
        },
      ],
    ];
    for (const [name, args] of probes) {
      const r = await b.callTool({ name: "xeeclip_" + name, arguments: args });
      assert(r.isError, name);
      assert.equal(r.structuredContent.error.code, "NOT_FOUND", name);
    }
    const { value: p } = await request("/edit-mode/projects", {
      method: "POST",
      expected: 201,
      cookie: accounts[1].cookie,
      body: { name: "MCP asset ownership target" },
    });
    const attack = {
      editProjectId: p.id,
      expectedRevision: p.revision,
      asset: {
        kind: "CAMPAIGN_ASSET",
        campaignId: accounts[0].campaignId,
        assetId: campaign.assets.find((a) => a.type === "LOGO").assetId,
      },
      idempotencyKey: "foreign-campaign-asset-" + p.id,
    };
    const a = await b.callTool({ name: "xeeclip_add_logo", arguments: attack });
    assert(a.isError);
    assert.equal(a.structuredContent.error.code, "NOT_FOUND");
    const { value: after } = await request("/edit-mode/projects/" + p.id, {
      cookie: accounts[1].cookie,
    });
    assert.equal(after.revision, p.revision);
    assert.equal(after.assets.length, 0);
    for (const [name, args] of [
      [
        "add_logo",
        {
          ...attack,
          idempotencyKey: "ssrf-001",
          asset: {
            kind: "EDITOR_ASSET",
            assetId: campaign.assets[0].assetId,
            url: "http://169.254.169.254/latest",
          },
        },
      ],
      [
        "create_clips",
        {
          sourceId: accounts[0].sourceId,
          mode: "XEEFREE",
          style: "STYLE_ZERO",
          clipCount: 1,
          idempotencyKey: "ssrf-002",
          filePath: "/etc/passwd",
        },
      ],
    ]) {
      const r = await b.callTool({ name: "xeeclip_" + name, arguments: args });
      assert(r.isError);
    }
    await request("/admin/stats", {
      cookie: accounts[1].cookie,
      expected: 403,
    });
    await request("/admin/users/" + accounts[1].userId + "/credits", {
      method: "POST",
      cookie: accounts[1].cookie,
      expected: 403,
      body: { mode: "ADD", amount: 999, reason: "unauthorized" },
    });
    const listed = await call(b, "list_sources", {});
    assert.equal(listed.items.length, 0);
    const clips = await call(b, "list_clips", {});
    assert.equal(clips.items.length, 0);
    fs.writeFileSync(
      path.join(artifactDir, "ownership-acceptance.json"),
      JSON.stringify(
        {
          passed: true,
          resourceIdorProbes: probes.length,
          campaignAssetIdor: true,
          noPartialAssetImport: true,
          noUrlOrPathSurface: true,
          adminDenied: true,
          creditMutationDenied: true,
          listsScoped: true,
        },
        null,
        2,
      ),
    );
    console.log(
      "PASS cross-user source, clip, job, project, campaign, asset, compliance, Reframe and export denial; admin/credit denial; no SSRF/path input surface.",
    );
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
