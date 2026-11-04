// Disposable API/MCP acceptance: consent changes must unblock the same request.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const { request, grant, connect, call, accounts, save } = require("./mcp-acceptance-client.cjs");
const dir = path.resolve(process.env.MCP_QA_DIR || path.join(__dirname, "../../../.cache/mcp"));
async function main() {
  if (!accounts.length) {
    for (let i = 0; i < 2; i++) {
      const email = `mcp-qa-${Date.now()}-${i}@example.invalid`, password = randomBytes(24).toString("base64url");
      const { value, r } = await request("/auth/signup", { method: "POST", expected: 201,
        body: { email, password, displayName: "Disposable consent QA " + i } });
      accounts.push({ userId: value.id, email, password, cookie: r.headers.get("set-cookie").split(";")[0] });
      save();
    }
  }
  assert.equal(accounts.length, 2);
  for (const a of accounts) {
    assert.match(a.email, /^mcp-qa-\d+-[01]@example\.invalid$/);
    if (!a.tokens) { Object.assign(a, await grant(a)); save(); }
  }
  const a = accounts[0], c = await connect(a);
  const preference = async enabled => {
    const { value } = await request("/auth/preferences", { method: "PATCH", cookie: a.cookie, body: { aiProcessingConsent: enabled } });
    assert.equal(!!value.aiProcessingConsentAt, enabled);
    const { value: reloaded } = await request("/auth/session", { cookie: a.cookie });
    assert.equal(!!reloaded.aiProcessingConsentAt, enabled);
    assert.equal((await call(c, "get_account")).aiProcessingConsent, enabled);
  };
  try {
    const before = await call(c, "get_credits");
    const catalog = await c.listTools();
    assert.equal(catalog.tools.length, 45);
    await preference(false);
    // A nonexistent source guarantees the test cannot start generation or spend credits.
    // OFF fails on consent; the SAME key after ON must reach the source lookup.
    const input = { sourceId: randomUUID(), mode: "XEEPRO", style: "STYLE_ZERO", clipCount: 3,
      idempotencyKey: "consent-state-retry-" + Date.now() };
    const errorCode = async args => {
      const r = await c.callTool({ name: "xeeclip_create_clips", arguments: args });
      assert(r.isError); return r.structuredContent.error.code;
    };
    assert.equal(await errorCode(input), "AI_CONSENT_REQUIRED");
    assert.equal(await errorCode(input), "AI_CONSENT_REQUIRED");
    await preference(true);
    assert.equal(await errorCode(input), "NOT_FOUND", "saved consent must unblock the original idempotency key");
    const { value: other } = await request("/auth/session", { cookie: accounts[1].cookie });
    assert.equal(other.aiProcessingConsentAt, null);
    await preference(false);
    assert.equal(await errorCode({ ...input, idempotencyKey: input.idempotencyKey + "-off" }), "AI_CONSENT_REQUIRED");
    assert.deepEqual(await call(c, "get_credits"), before);
    const report = { passed: true, at: new Date().toISOString(), tools: 45, preferencePersists: true,
      sameKeyRetryAfterConsent: true, revocationBlocksNewWork: true, accountIsolation: true, noCreditChange: true, noGenerationStarted: true };
    fs.writeFileSync(path.join(dir, "consent-acceptance.json"), JSON.stringify(report, null, 2));
    console.log("PASS saved consent reaches MCP; the same blocked request resumes after ON; OFF blocks new work; credits and other accounts are unchanged.");
  } finally { await c.close(); }
}
main().catch(e => { console.error(e.cause?.code || e.message); process.exitCode = 1; });
