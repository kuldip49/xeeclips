require("reflect-metadata");
const assert = require("node:assert/strict");
const { Logger } = require("@nestjs/common");
Logger.overrideLogger(false);
const redisPath = require.resolve("ioredis");
class FakeRedis {
  async eval() {
    return 1;
  }
  async ping() {
    return "PONG";
  }
  async quit() {}
}
FakeRedis.default = FakeRedis;
require.cache[redisPath] = {
  id: redisPath,
  filename: redisPath,
  loaded: true,
  exports: FakeRedis,
};
const {
  McpOperationsService,
  McpToolError,
  safeMcpError,
} = require("../dist/modules/mcp/mcp-operations.service");
const { MCP_TOOLS } = require("../dist/modules/mcp/mcp-tools");
const { validateRedirect } = require("../dist/modules/mcp/mcp-oauth.service");
const { requestIdentity } = require("../dist/modules/auth/request-context");
const {
  EditModeRenderService,
} = require("../dist/modules/edit-mode/render/edit-mode-render.service");
const {
  parseClipCreationRequest,
} = require("../dist/modules/videos/clip-selection.service");
const { mcpConfig } = require("../dist/modules/mcp/mcp-config");
const auth = {
  token: "never-store-this",
  clientId: "client-a",
  scopes: ["xeeclip:clips:edit", "xeeclip:account:read"],
  extra: { userId: "user-a", connectionId: "grant-a" },
};
function database() {
  const rows = new Map();
  let next = 0;
  const find = (w) =>
    [...rows.values()].find((r) =>
      w.id
        ? r.id === w.id
        : Object.entries(w.userId_clientId_tool_key).every(
            ([k, v]) => r[k] === v,
          ),
    );
  return {
    rows,
    mcpAction: {
      async create({ data }) {
        if (
          [...rows.values()].some((r) =>
            ["userId", "clientId", "tool", "key"].every(
              (k) => r[k] === data[k],
            ),
          )
        )
          throw { code: "P2002" };
        const r = {
          ...data,
          id: "action-" + ++next,
          status: "PENDING",
          createdAt: new Date(),
        };
        rows.set(r.id, r);
        return r;
      },
      async findUnique({ where }) {
        return find(where) || null;
      },
      async findUniqueOrThrow({ where }) {
        const r = find(where);
        assert(r);
        return r;
      },
      async updateMany({ where, data }) {
        const r = find(where);
        if (!r || (where.status && r.status !== where.status))
          return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
    },
    mcpAudit: {
      async create() {},
      async findMany() {
        return [];
      },
      async deleteMany() {},
    },
    mcpAuthorization: {
      async findMany() {
        return [];
      },
    },
    mcpToken: {
      async findMany() {
        return [];
      },
    },
  };
}
const write = {
  name: "xeeclip_set_zoom",
  scopes: ["xeeclip:clips:edit"],
  category: "EDITOR_WRITE",
};
(async () => {
  assert(MCP_TOOLS.length >= 40);
  for (const t of MCP_TOOLS)
    assert(
      !t.schema.safeParse({ untrustedExtra: "secret" }).success,
      t.name + " must reject extra fields",
    );
  for (const uri of [
    "file:///etc/passwd",
    "http://evil.example/cb",
    "https://127.0.0.1/cb",
    "https://169.254.169.254/cb",
    "https://a.internal/cb",
  ])
    assert.throws(() => validateRedirect(uri));
  assert.equal(
    validateRedirect("https://claude.ai/api/mcp/auth_callback"),
    "https://claude.ai/api/mcp/auth_callback",
  );
  const originalEnv = { ...process.env };
  process.env.NODE_ENV = "production";
  process.env.FRONTEND_ORIGIN = "https://xeeclip.me";
  process.env.MCP_PUBLIC_URL = "http://localhost:4400/mcp";
  assert.throws(() => mcpConfig());
  process.env = originalEnv;
  assert.equal(
    parseClipCreationRequest({
      requestedClipCount: 1,
      generationMode: "ONLINE",
    }).generationMode,
    undefined,
  );
  assert(
    !JSON.stringify(
      safeMcpError(Error("Prisma secret-key ffmpeg provider JSON stack")),
    ).match(/Prisma|secret-key|ffmpeg|provider JSON|stack/),
  );
  const db = database(),
    ops = new McpOperationsService(db);
  let calls = 0;
  const args = { idempotencyKey: "retry-key-001", expectedRevision: 2 };
  const result = await ops.invoke(auth, write, args, async () => {
    calls++;
    const id = requestIdentity.getStore();
    assert.equal(id.userId, "user-a");
    assert.equal(id.admin, false);
    assert.equal(id.adminView, false);
    return { revision: 3 };
  });
  assert.deepEqual(
    await ops.invoke(auth, write, args, async () => {
      calls++;
    }),
    result,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    () =>
      ops.invoke(auth, write, { ...args, expectedRevision: 3 }, async () => {}),
    (e) => e.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(calls, 1);
  await assert.rejects(
    () =>
      ops.invoke(
        { ...auth, scopes: [] },
        write,
        { idempotencyKey: "scope-key-001" },
        async () => {
          calls++;
        },
      ),
    (e) => e.code === "INSUFFICIENT_SCOPE",
  );
  assert.equal(calls, 1);
  let unblock;
  const barrier = new Promise((r) => (unblock = r)),
    parallel = { idempotencyKey: "parallel-001" };
  const first = ops.invoke(auth, write, parallel, async () => {
    calls++;
    await barrier;
    return { revision: 4 };
  });
  await new Promise((r) => setImmediate(r));
  const duplicate = await ops.invoke(auth, write, parallel, async () => {
    calls++;
  });
  assert.equal(duplicate.requestInProgress, true);
  unblock();
  await first;
  assert.equal(calls, 2);
  const crash = { idempotencyKey: "crash-key-001" };
  const receipt = { revision: 5 };
  assert.deepEqual(
    await ops.invoke(auth, write, crash, async () => {
      const id = requestIdentity.getStore().operationId;
      Object.assign(db.rows.get(id), { status: "COMPLETE", result: receipt });
      throw Error("lost dispatch response");
    }),
    receipt,
  );
  const pending = await db.mcpAction.create({
    data: {
      userId: auth.extra.userId,
      clientId: auth.clientId,
      tool: write.name,
      key: "interrupted-001",
      inputHash: require("crypto")
        .createHash("sha256")
        .update(JSON.stringify({ idempotencyKey: "interrupted-001" }))
        .digest("hex"),
    },
  });
  pending.createdAt = new Date(Date.now() - 180000);
  await assert.rejects(
    () =>
      ops.invoke(
        auth,
        write,
        { idempotencyKey: "interrupted-001" },
        async () => {},
      ),
    (e) => e.code === "OPERATION_INTERRUPTED",
  );
  assert.equal(
    pending.status,
    "PENDING",
    "a retry must not mark the original running action failed",
  );
  const render = new EditModeRenderService(
    {
      editProject: {
        async findUnique() {
          return null;
        },
      },
    },
    {},
  );
  render.running.set("foreign", {
    phase: "ENCODING",
    exportId: "private-export",
  });
  await assert.rejects(
    () => render.progress("foreign"),
    (e) => e.getStatus() === 404,
    "shared progress cache must never bypass ownership",
  );
  // Boot the real Nest/Express parser registration order used by main.ts.
  // A bare route-specific jsonParser used to disable JSON bodies for every controller.
  const { Controller, Post, Body, Module } = require("@nestjs/common");
  const { NestFactory } = require("@nestjs/core");
  const { McpHttpService } = require("../dist/modules/mcp/mcp-http.service");
  class BodyProbe {
    echo(body) {
      return body;
    }
  }
  Controller("body-probe")(BodyProbe);
  Post()(
    BodyProbe.prototype,
    "echo",
    Object.getOwnPropertyDescriptor(BodyProbe.prototype, "echo"),
  );
  Body()(BodyProbe.prototype, "echo", 0);
  class ProbeModule {}
  Module({ controllers: [BodyProbe] })(ProbeModule);
  const app = await NestFactory.create(ProbeModule, { logger: false });
  new McpHttpService(
    { clientsStore: { getClient: async () => undefined } },
    {},
    {},
  ).mount(app.getHttpAdapter().getInstance());
  try {
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    const payload = { nonce: "body-parser-probe", nested: { value: 42 } };
    const response = await fetch(
      "http://127.0.0.1:" + address.port + "/body-probe",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), payload);
  } finally {
    await app.close();
  }
  await ops.onModuleDestroy();
  console.log(
    "PASS MCP strict schemas, redirect policy, safe errors, trusted mode parsing, scopes, ALS isolation, exact/parallel retries, conflicting keys, crash receipts, interrupted actions and cached export ownership.",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
