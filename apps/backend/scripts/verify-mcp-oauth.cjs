const artifactDir = require("path").resolve(
  process.env.MCP_QA_DIR ||
    require("path").join(__dirname, "../../../.cache/mcp"),
);

const fs = require("fs"),
  path = require("path"),
  assert = require("assert/strict"),
  {
    request,
    grant,
    connect,
    call,
    accounts,
    base,
  } = require("./mcp-acceptance-client.cjs");
(async () => {
  const { value: probe } = await request("/projects", {
    method: "POST",
    expected: 201,
    cookie: accounts[0].cookie,
    body: { name: "MCP JSON parser acceptance" },
  });
  assert.equal(probe.name, "MCP JSON parser acceptance");
  const read = await grant(accounts[0], ["xeeclip:account:read"]);
  assert.equal(
    read.tokens.refresh_token,
    undefined,
    "declined offline access must not issue refresh credentials",
  );
  const c = await connect(read);
  try {
    const r = await c.callTool({
      name: "xeeclip_create_campaign",
      arguments: {
        name: "Scope denied",
        idempotencyKey: "scope-denied-final-001",
      },
    });
    assert(r.isError);
    assert.equal(r.structuredContent.error.code, "INSUFFICIENT_SCOPE");
  } finally {
    await c.close();
  }
  const g = await grant(
    accounts[0],
    ["xeeclip:account:read", "offline_access"],
    true,
  );
  assert(g.tokens.refresh_token);
  const refresh = (token, secret = g.client.client_secret) =>
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: g.client.client_id,
      client_secret: secret,
      refresh_token: token,
      resource: base + "/mcp",
    });
  await request("/token", {
    method: "POST",
    body: refresh(g.tokens.refresh_token, "invalid-client-credential"),
    expected: 400,
  });
  const { value: rotated } = await request("/token", {
    method: "POST",
    body: refresh(g.tokens.refresh_token),
  });
  assert(
    rotated.refresh_token && rotated.refresh_token !== g.tokens.refresh_token,
  );
  await request("/token", {
    method: "POST",
    body: refresh(g.tokens.refresh_token),
    expected: 400,
  });
  const r = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + rotated.access_token,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(process.env.MCP_QA_GATE_STATE ? { Cookie: accounts[0].cookie } : {}),
    },
    body: "{}",
  });
  assert.equal(r.status, 401);
  const { value: connections } = await request("/mcp/connections", {
    cookie: accounts[0].cookie,
  });
  const own = connections.connections.find(
    (c) =>
      c.name === "XeeClip isolated SDK acceptance" &&
      c.permissions.length === 1 &&
      !c.revokedAt,
  );
  assert(own);
  await request("/mcp/connections/" + own.id + "/revoke", {
    method: "POST",
    cookie: accounts[1].cookie,
    expected: 404,
  });
  await request("/mcp/connections/" + own.id + "/revoke", {
    method: "POST",
    cookie: accounts[0].cookie,
    expected: 201,
  });
  await request("/auth/session", { cookie: accounts[0].cookie });
  for (const body of ["{broken", "[]"]) {
    const r = await fetch(base + "/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.MCP_QA_GATE_STATE
          ? { Cookie: accounts[0].cookie }
          : {}),
      },
      body,
    });
    assert.equal(r.status, 400);
    const text = await r.text();
    assert(!/stack|SyntaxError|node_modules|Prisma/i.test(text));
  }
  const dir = path.resolve(process.env.MCP_QA_DIR || artifactDir);
  fs.writeFileSync(
    path.join(dir, "oauth-final.json"),
    JSON.stringify(
      {
        passed: true,
        offlineConsent: true,
        confidentialHashAuth: true,
        refreshRotation: true,
        replayRevokesFamily: true,
        scopeDenied: true,
        revokeOwnership: true,
        websiteSessionPreserved: true,
        safeMalformedRequests: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS final OAuth offline consent, confidential auth, refresh rotation/replay, scopes, revocation and safe malformed requests.",
  );
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
