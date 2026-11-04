require("reflect-metadata");
const assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto");
const {
    McpAdapterService,
  } = require("../dist/modules/mcp/mcp-adapter.service"),
  { MCP_TOOLS } = require("../dist/modules/mcp/mcp-tools");
const ids = Array.from({ length: 5 }, () => randomUUID());
const p = {
  id: randomUUID(),
  revision: 9,
  settings: { aspectRatio: "9:16" },
  assets: [],
  elements: [
    {
      id: ids[0],
      type: "TEXT",
      track: 2,
      startTime: 0,
      duration: 8,
      properties: {
        content: "Existing headline",
        x: 0.1,
        y: 0.05,
        width: 0.8,
        height: 0.1,
        presetRole: "HOOK",
      },
    },
    {
      id: ids[1],
      type: "TEXT",
      track: 3,
      startTime: 0,
      duration: 8,
      properties: {
        content: "Extra title",
        x: 0.1,
        y: 0,
        width: 0.8,
        height: 0.1,
      },
    },
    {
      id: ids[2],
      type: "SUBTITLE",
      track: 1,
      startTime: 0,
      duration: 8,
      properties: {
        content: "Keep original",
        x: 0.1,
        y: 0.6,
        width: 0.8,
        height: 0.1,
      },
    },
    {
      id: ids[3],
      type: "SUBTITLE",
      track: 4,
      startTime: 0,
      duration: 8,
      properties: {
        content: "Duplicate",
        x: 0.1,
        y: 0.85,
        width: 0.8,
        height: 0.1,
      },
    },
    {
      id: ids[4],
      type: "VIDEO",
      track: 0,
      startTime: 0,
      duration: 8,
      properties: {},
    },
  ],
};
let bundles = [];
const edit = {
  get: async () => p,
  applyAssistantBundle: async (id, revision, bundle) => {
    assert.equal(id, p.id);
    assert.equal(revision, 9);
    assert.equal(bundle.onInvalid, "ABORT");
    bundles.push(bundle);
    return { revision: 10 };
  },
};
const a = new McpAdapterService(null, null, null, null, {refreshForEditor:async()=>{}}, edit, null, null),
  auth = { scopes:["xeeclip:clips:edit"], extra: { userId: "owner" } };
(async () => {
  const summary = await a.execute(
    "xeeclip_get_edit_project",
    { editProjectId: p.id },
    auth,
  );
  assert.equal(summary.textLayers.length, 2);
  assert.equal(summary.captions[1].track, 4);
  assert.equal(summary.captions[1].box.y, 0.85);
  assert.equal(summary.editorAuthentication, "MCP_OAUTH_BEARER");
  assert(!JSON.stringify(summary).includes("objectKey"));
  assert(
    MCP_TOOLS.find((t) => t.name === "xeeclip_remove_overlay").schema.safeParse(
      {
        editProjectId: p.id,
        expectedRevision: 9,
        idempotencyKey: "batch-schema-test",
        elementIds: [ids[1], ids[3]],
      },
    ).success,
  );
  const args = {
    editProjectId: p.id,
    expectedRevision: 9,
    idempotencyKey: "unit-specific-case",
    elementId: ids[0],
    text: "Before You Trade, Mark This",
    box: { x: 0.1, y: 0.22, width: 0.8, height: 0.1 },
    color: "#000000",
    fontSize: 25,
    background: {
      enabled: false,
      color: "#ffffff",
      opacity: 0,
      padding: 0,
      radius: 0,
    },
  };
  assert(
    MCP_TOOLS.find(
      (t) => t.name === "xeeclip_update_headline",
    ).schema.safeParse(args).success,
  );
  await a.execute("xeeclip_update_headline", args, auth);
  assert.deepEqual(
    bundles[0].commands.map((c) => c.action),
    [
      "MOVE_ELEMENT",
      "RESIZE_ELEMENT",
      "SET_TEXT_COLOR",
      "SET_TEXT_SIZE",
      "SET_TEXT_BACKGROUND",
      "SET_TEXT_CONTENT",
    ],
  );
  await a.execute(
    "xeeclip_remove_overlay",
    { editProjectId: p.id, expectedRevision: 9, elementIds: [ids[1], ids[3]] },
    auth,
  );
  assert.deepEqual(
    bundles[1].commands.map((c) => c.payload.elementId),
    [ids[1], ids[3]],
  );
  assert(
    !bundles[1].commands.some(
      (c) => c.payload.elementId === ids[2] || c.payload.elementId === ids[4],
    ),
  );
  await assert.rejects(
    () =>
      a.execute(
        "xeeclip_remove_overlay",
        {
          editProjectId: p.id,
          expectedRevision: 9,
          elementIds: [ids[1], randomUUID()],
        },
        auth,
      ),
    (e) => e.code === "NOT_FOUND",
  );
  assert.equal(bundles.length, 2, "bad batch cannot partially mutate");
  await assert.rejects(
    () =>
      a.execute(
        "xeeclip_remove_overlay",
        { editProjectId: p.id, expectedRevision: 9, elementId: ids[4] },
        auth,
      ),
    (e) => e.code === "UNSUPPORTED_OPERATION",
  );
  await assert.rejects(
    () =>
      a.execute(
        "xeeclip_remove_overlay",
        {
          editProjectId: p.id,
          expectedRevision: 9,
          elementId: ids[1],
          elementIds: [ids[3]],
        },
        auth,
      ),
    (e) => e.code === "INVALID_INPUT",
  );
  await assert.rejects(
    () =>
      a.execute(
        "xeeclip_update_headline",
        { ...args, expectedRevision: 8 },
        auth,
      ),
    (e) => e.code === "EDIT_CONFLICT",
  );
  await a.execute(
    "xeeclip_update_overlay",
    {
      editProjectId: p.id,
      expectedRevision: 9,
      elementId: ids[0],
      x: 0.1,
      y: 0.22,
      width: 0.8,
      height: 0.1,
    },
    auth,
  );
  assert.equal(bundles.at(-1).commands[0].action, "MOVE_ELEMENT");
  const saved = await a.execute(
    "xeeclip_save_edit",
    { editProjectId: p.id, expectedRevision: 9 },
    auth,
  );
  assert.equal(saved.revision, 9);
  assert(
    MCP_TOOLS.filter(
      (t) =>
        t.scopes.includes("xeeclip:clips:edit") ||
        t.scopes.includes("xeeclip:clips:export") ||
        t.name === "xeeclip_get_edit_project",
    ).every((t) => /No browser tab/.test(t.description)),
  );
  console.log(
    "PASS direct canonical text/caption summaries, exact headline/bar commands, selected layer removal, preserved source/original captions, atomic rejection, stale revision and browser-free tool guidance.",
  );
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
