const fs = require("fs"),
  path = require("path"),
  assert = require("assert/strict"),
  { randomBytes, createHash } = require("crypto");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const root = path.resolve(__dirname, "../../.."),
  dir = path.resolve(process.env.MCP_QA_DIR || path.join(root, ".cache/mcp"));
if (!dir.startsWith(path.join(root, ".cache") + path.sep))
  throw Error("Keep private QA artifacts inside the ignored workspace cache");
fs.mkdirSync(dir, { recursive: true });
const base = process.env.MCP_QA_BASE_URL || "http://localhost:4400",
  origin = process.env.MCP_QA_ORIGIN || "http://localhost:3400";
if (
  base !== "http://localhost:4400" &&
  !(process.env.MCP_PRODUCTION_QA === "1" && base === "https://api.xeeclip.me")
)
  throw Error("Explicit disposable MCP QA target required");
const scopes = [
  "account:read",
  "credits:read",
  "sources:read",
  "sources:import",
  "clips:read",
  "clips:create",
  "clips:edit",
  "clips:export",
  "reframe:create",
  "campaigns:read",
  "campaigns:create",
  "campaigns:generate",
  "history:read",
]
  .map((s) => "xeeclip:" + s)
  .concat("offline_access");
const stateFile = path.join(dir, "accounts.private.json");
let accounts = fs.existsSync(stateFile)
  ? JSON.parse(fs.readFileSync(stateFile))
  : [];
const save = () => {
  fs.writeFileSync(stateFile, JSON.stringify(accounts, null, 2));
  if (process.env.MCP_QA_GATE_STATE) {
    const gate = path.resolve(process.env.MCP_QA_GATE_STATE);
    if (!gate.startsWith(path.join(root, ".cache") + path.sep))
      throw Error("Unexpected release gate path");
    const state = JSON.parse(fs.readFileSync(gate));
    state.qaSessionHashes = accounts.map((a) =>
      createHash("sha256")
        .update(a.cookie.slice(a.cookie.indexOf("=") + 1))
        .digest("hex"),
    );
    fs.writeFileSync(gate, JSON.stringify(state));
  }
};
async function request(
  p,
  {
    method = "GET",
    body,
    cookie,
    token,
    expected = 200,
    redirect = "follow",
  } = {},
) {
  if (!cookie && process.env.MCP_QA_GATE_STATE && !['/auth/signup','/auth/login'].includes(p)) cookie = accounts[0]?.cookie;
  const r = await fetch(base + p, {
    method,
    redirect,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body &&
      !(body instanceof URLSearchParams) &&
      !(body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body:
      body instanceof URLSearchParams || body instanceof FormData
        ? body
        : body
          ? JSON.stringify(body)
          : undefined,
  });
  const text = await r.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  assert.equal(
    r.status,
    expected,
    "HTTP " +
      p.split("?")[0].replace(/[A-Za-z0-9_-]{43}/g, "[opaque]") +
      " returned " +
      r.status +
      " instead of " +
      expected,
  );
  if (p === "/register" && r.status === 201) {
    const f = path.join(dir, "client-ids.private.json");
    const ids = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : [];
    if (!ids.includes(value.client_id)) ids.push(value.client_id);
    fs.writeFileSync(f, JSON.stringify(ids));
  }
  return { value, r };
}
async function grant(account, selected = scopes, confidential = false) {
  const { value: client } = await request("/register", {
    method: "POST",
    expected: 201,
    body: {
      client_name: "XeeClip isolated SDK acceptance",
      redirect_uris: ["http://localhost:49371/callback"],
      token_endpoint_auth_method: confidential ? "client_secret_post" : "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: selected.join(" "),
    },
  });
  const verifier = randomBytes(48).toString("base64url"),
    challenge = createHash("sha256").update(verifier).digest("base64url"),
    state = randomBytes(20).toString("hex");
  const q = new URLSearchParams({
    client_id: client.client_id,
    response_type: "code",
    redirect_uri: client.redirect_uris[0],
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: selected.join(" "),
    resource: base + "/mcp",
    state,
  });
  const { r } = await request("/authorize?" + q, {
    expected: 302,
    redirect: "manual",
  });
  const pending = new URL(r.headers.get("location")).searchParams.get(
    "request",
  );
  assert(pending);
  const [firstConsent, secondConsent] = await Promise.all([
    request("/mcp/oauth/consent/" + pending, { cookie: account.cookie }),
    request("/mcp/oauth/consent/" + pending, { cookie: account.cookie }),
  ]);
  const consent = secondConsent.value;
  assert.equal(
    consent.nonce,
    firstConsent.value.nonce,
    "parallel consent loads must share a valid nonce",
  );
  assert.deepEqual(
    consent.permissions.map((p) => p.id),
    selected,
  );
  const { value: decision } = await request("/mcp/oauth/consent/" + pending, {
    method: "POST",
    cookie: account.cookie,
    expected: 201,
    body: { nonce: consent.nonce, allow: true, scopes: selected },
  });
  const callback = new URL(decision.redirectUrl);
  assert.equal(callback.searchParams.get("state"), state);
  const code = callback.searchParams.get("code");
  assert(code);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    code_verifier: verifier,
    redirect_uri: client.redirect_uris[0],
    resource: base + "/mcp",
    ...(client.client_secret ? { client_secret: client.client_secret } : {}),
  });
  await request("/token", {
    method: "POST",
    expected: 400,
    body: new URLSearchParams({
      ...Object.fromEntries(body),
      code_verifier: "wrong".repeat(12),
    }),
  });
  const { value: tokens } = await request("/token", { method: "POST", body });
  assert.match(tokens.access_token, /^xmcp_at_/);
  await request("/token", { method: "POST", body, expected: 400 });
  return { client, tokens };
}
async function connect(account) {
  if (account.client && account.tokens?.refresh_token) {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: account.client.client_id,
      refresh_token: account.tokens.refresh_token,
      resource: base + "/mcp",
      ...(account.client.client_secret
        ? { client_secret: account.client.client_secret }
        : {}),
    });
    const { value } = await request("/token", { method: "POST", body: form });
    account.tokens = value;
    if (accounts.includes(account)) save();
  }
  const client = new Client({
    name: "XeeClip acceptance client",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    requestInit: {
      headers: {
        Authorization: "Bearer " + account.tokens.access_token,
        ...(process.env.MCP_QA_GATE_STATE ? { Cookie: account.cookie||accounts[0]?.cookie } : {}),
      },
    },
  });
  await client.connect(transport);
  return client;
}
async function call(client, name, args = {}) {
  const r = await client.callTool({ name: "xeeclip_" + name, arguments: args });
  if (r.isError)
    throw Object.assign(
      Error(JSON.stringify(r.structuredContent || r.content)),
      { result: r },
    );
  return r.structuredContent || JSON.parse(r.content[0].text);
}
async function main() {
  if (!accounts.length) {
    for (let i = 0; i < 2; i++) {
      const email = "mcp-qa-" + Date.now() + "-" + i + "@example.invalid",
        password = randomBytes(24).toString("base64url");
      const { value, r } = await request("/auth/signup", {
        method: "POST",
        expected: 201,
        body: { email, password, displayName: "Disposable MCP QA " + i },
      });
      accounts.push({
        userId: value.id,
        email,
        password,
        cookie: r.headers.get("set-cookie").split(";")[0],
      });
      save();
    }
  }
  for (const account of accounts)
    if (!account.tokens) {
      Object.assign(account, await grant(account));
      save();
    }
  const noAuth = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(process.env.MCP_QA_GATE_STATE ? { Cookie: accounts[0].cookie } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "unauth", version: "1" },
      },
    }),
  });
  assert.equal(noAuth.status, 401);
  assert.match(noAuth.headers.get("www-authenticate"), /resource_metadata/);
  for (const p of [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
  ]) {
    const { value } = await request(p);
    assert(!/xmcp_at_|xmcp_rt_|secretHash/.test(JSON.stringify(value)));
  }
  const a = await connect(accounts[0]),
    b = await connect(accounts[1]);
  try {
    const { tools } = await a.listTools();
    assert(tools.length >= 40);
    assert(
      tools.every(
        (t) =>
          t.inputSchema.additionalProperties === false &&
          t._meta.securitySchemes,
      ),
    );
    const account = await call(a, "get_account");
    assert.equal(account.displayName, "Disposable MCP QA 0");
    assert(!account.email && !account.passwordHash);
    const malformed = await a.callTool({
      name: "xeeclip_get_account",
      arguments: { userId: accounts[1].userId },
    });
    assert(malformed.isError);
    const input = {
      idempotencyKey: "campaign-retry-auth-0001",
      name: "MCP isolated acceptance",
      rules: "Professional videos for students, 15 to 40 seconds.",
      platforms: ["TikTok"],
    };
    const c1 = await call(a, "create_campaign", input),
      c2 = await call(a, "create_campaign", input);
    assert.deepEqual(c1, c2);
    accounts[0].campaignId = c1.campaignId;
    save();
    const changed = await a.callTool({
      name: "xeeclip_create_campaign",
      arguments: { ...input, name: "different" },
    });
    assert(changed.isError);
    assert.equal(changed.structuredContent.error.code, "IDEMPOTENCY_CONFLICT");
    const denied = await b.callTool({
      name: "xeeclip_get_campaign",
      arguments: { campaignId: c1.campaignId },
    });
    assert(denied.isError);
    assert.equal(denied.structuredContent.error.code, "NOT_FOUND");
    const campaign = await call(a, "get_campaign", {
      campaignId: c1.campaignId,
    });
    assert.equal(campaign.name, input.name);
    fs.writeFileSync(
      path.join(dir, "auth-acceptance.json"),
      JSON.stringify(
        {
          passed: true,
          tools: tools.length,
          oauthPkce: true,
          codeReplayDenied: true,
          officialSdk: true,
          strictSchema: true,
          ownership: true,
          idempotency: true,
          discovery: true,
        },
        null,
        2,
      ),
    );
    console.log(
      "PASS OAuth PKCE, code replay, discovery, official SDK initialize/list/call, strict schemas, ownership, retry and conflict (" +
        tools.length +
        " tools).",
    );
  } finally {
    await a.close();
    await b.close();
  }
}
module.exports = {
  request,
  grant,
  connect,
  call,
  accounts,
  save,
  scopes,
  base,
  origin,
};
if (require.main === module)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
