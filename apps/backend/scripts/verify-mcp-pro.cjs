const artifactDir = require("path").resolve(
  process.env.MCP_QA_DIR ||
    require("path").join(__dirname, "../../../.cache/mcp"),
);
const fs = require("fs"),
  path = require("path"),
  assert = require("assert/strict"),
  {
    request,
    connect,
    call,
    accounts,
    base,
  } = require("./mcp-acceptance-client.cjs");
if (base !== "http://localhost:4400")
  throw Error("Mocked provider acceptance is local-only");
const file = path.join(
    process.env.MCP_QA_DIR || path.resolve(__dirname, "../../../.cache/mcp"),
    "pro-acceptance.json",
  ),
  r = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {},
  save = () => fs.writeFileSync(file, JSON.stringify(r, null, 2));
const provider = (change) => {
  const f = path.join(artifactDir, "provider-state.json");
  fs.writeFileSync(
    f,
    JSON.stringify({ ...JSON.parse(fs.readFileSync(f)), ...change }),
  );
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await request("/auth/preferences", {
    method: "PATCH",
    cookie: accounts[0].cookie,
    body: { aiProcessingConsent: true },
  });
  const c = await connect(accounts[0]);
  try {
    for (const busy of [false, true]) {
      const label = busy ? "busy" : "success";
      if (r[label]?.passed) continue;
      provider({ busy, busyAfterAdmission: false });
      const before = await call(c, "get_credits");
      const input = {
        sourceId: accounts[0].sourceId,
        mode: "XEEPRO",
        style: busy ? "STYLE_ONE" : "STYLE_ZERO",
        clipCount: 1,
        idempotencyKey: "mcp-pro-" + label + "-001",
      };
      const job = await call(c, "create_clips", input);
      assert.deepEqual(await call(c, "create_clips", input), job);
      let done;
      for (let i = 0; i < 180; i++) {
        done = await call(c, "get_job", { jobId: job.jobId });
        if (["COMPLETE", "FAILED"].includes(done.status)) break;
        if (i % 6 === 0) console.log("Pro " + label + ": " + done.status);
        await sleep(5000);
      }
      assert.equal(done.mode, "XEEPRO");
      await sleep(1000);
      const after = await call(c, "get_credits");
      if (busy) {
        assert.equal(done.status, "FAILED");
        assert.equal(done.errorCode, "XEEPRO_BUSY");
        assert.equal(after.credits, before.credits);
      } else {
        assert.equal(done.status, "COMPLETE");
        assert.equal(after.credits, before.credits - 1);
        assert(done.resultIds.length);
        const clip = await call(c, "get_clip", { clipId: done.resultIds[0] });
        if (!clip.editProjectId) {
          const p = await call(c, "restore_edit_project", {
            clipId: clip.clipId,
            idempotencyKey: "mcp-pro-success-restore-001",
          });
          clip.editProjectId = p.editProjectId;
        }
        const { value: p } = await request(
          "/edit-mode/projects/" + clip.editProjectId,
          { cookie: accounts[0].cookie },
        );
        assert.equal(p.settings.origin.aiMode, "ONLINE");
      }
      r[label] = {
        passed: true,
        jobId: job.jobId,
        status: done.status,
        errorCode: done.errorCode,
        creditDelta: after.credits - before.credits,
      };
      save();
      console.log(
        "PASS MCP mocked Pro " +
          label +
          " with canonical mode provenance and exact credit accounting.",
      );
    }
    const telemetry = JSON.parse(
      fs.readFileSync(path.join(artifactDir, "provider-state.json")),
    );
    assert.equal(telemetry.freeAttempts, 0);
    assert.equal(telemetry.transportAttempts, 0);
    assert(Object.values(telemetry.freeTelemetry).every((v) => v === 0));
    assert(telemetry.proCalls > 0);
    r.zeroCloudFree = true;
    save();
  } finally {
    provider({ busy: false, busyAfterAdmission: false });
    await c.close();
  }
})().catch((e) => {
  r.error = e.message;
  save();
  console.error(e.stack);
  process.exitCode = 1;
});
