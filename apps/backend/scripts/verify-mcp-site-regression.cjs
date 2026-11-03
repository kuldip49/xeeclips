const artifactDir = require("path").resolve(
  process.env.MCP_QA_DIR ||
    require("path").join(__dirname, "../../../.cache/mcp"),
);
const { chromium, expect } = require("@playwright/test"),
  {
    accounts,
    base,
    request,
    connect,
    call,
    origin,
  } = require("./mcp-acceptance-client.cjs"),
  assert = require("assert/strict"),
  fs = require("fs"),
  path = require("path");
(async () => {
  const report = JSON.parse(
      fs.readFileSync(
        path.join(
          process.env.MCP_QA_DIR ||
            path.resolve(__dirname, "../../../.cache/mcp"),
          "media-acceptance.json",
        ),
      ),
    ),
    browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const ctx = await browser.newContext();
    const cookie = accounts[0].cookie,
      i = cookie.indexOf("=");
    await ctx.addCookies([
      {
        name: cookie.slice(0, i),
        value: cookie.slice(i + 1),
        url: base,
        httpOnly: true,
        secure: base.startsWith("https:"),
        sameSite: "Lax",
      },
    ]);
    if(base==='http://localhost:4400'&&process.env.MCP_QA_PROXY_API==='1')await ctx.route('https://api.xeeclip.me/**',async route=>{const target=new URL(route.request().url());const response=await route.fetch({url:base+target.pathname+target.search,headers:{...route.request().headers(),Origin:origin,Cookie:accounts[0].cookie}});await route.fulfill({response});});
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    const fits = async (label) =>
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        label + " overflow",
      );
    const target = report.create.find((c) => c.style === "STYLE_ONE");
    for (const width of [1440, 375, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of [
        "/create",
        "/quick-reframe",
        "/clippers",
        "/clippers/campaigns/" +
          accounts[0].campaignId +
          "?tab=Generated%20Clips",
        "/edit-mode/" + target.editProjectId,
        "/history",
        "/settings",
      ]) {
        await page.goto(origin + route);
        await expect(page.locator("main")).toBeVisible({ timeout: 60000 });
        await expect(
          page.getByRole("heading", { level: 1 }).first(),
        ).toBeVisible({ timeout: 60000 });
        if (route.startsWith("/edit-mode/"))
          await expect(page.getByTestId("edit-preview-canvas")).toBeVisible({
            timeout: 60000,
          });
        if (route === "/history")
          await expect(
            page.getByText("XeeFree", { exact: true }).first(),
          ).toBeVisible({ timeout: 60000 });
        await page.waitForTimeout(300);
        await fits(route + " " + width);
        await page.screenshot({
          path: path.join(
            artifactDir,
            "site-" +
              width +
              "-" +
              route.split("?")[0].replaceAll("/", "_") +
              ".png",
          ),
          fullPage: true,
        });
      }
      console.log(
        "PASS existing Create, Quick Reframe, Clippers, Campaign, editor, History and Settings " +
          width +
          "px",
      );
    }
    await page.goto(origin + "/edit-mode/" + target.editProjectId);
    await expect(page.getByTestId("edit-preview-canvas")).toBeVisible({
      timeout: 60000,
    });
    const { value: p } = await request(
      "/edit-mode/projects/" + target.editProjectId,
      { cookie: accounts[0].cookie },
    );
    assert(
      p.elements.some(
        (e) =>
          e.type === "TEXT" && e.properties.content === "Ideas need evidence",
      ),
    );
    assert(
      p.elements.some(
        (e) =>
          e.type === "SUBTITLE" &&
          e.properties.content === "A carefully checked idea.",
      ),
    );
    const c = await connect(accounts[0]);
    try {
      const before = await call(c, "get_edit_project", { editProjectId: p.id });
      const undo = page.getByRole("button", { name: /^Undo/ }).first();
      await expect(undo).toBeEnabled();
      const response = page.waitForResponse(
        (r) => r.url().endsWith("/undo") && r.request().method() === "POST",
      );
      await undo.click();
      assert([200, 201].includes((await response).status()));
      let after = await call(c, "get_edit_project", { editProjectId: p.id });
      assert.equal(after.revision, before.revision + 1);
      await call(c, "redo", {
        editProjectId: p.id,
        expectedRevision: after.revision,
        idempotencyKey: "mcp-website-redo-"+before.revision,
      });
      after = await call(c, "get_edit_project", { editProjectId: p.id });
      assert.equal(after.revision, before.revision + 2);
    } finally {
      await c.close();
    }
    fs.writeFileSync(
      path.join(artifactDir, "site-regression.json"),
      JSON.stringify(
        {
          passed: true,
          widths: [1440, 375, 390],
          routes: 7,
          canonicalEditsVisible: true,
          websiteUndoMcpRedo: true,
          noHorizontalOverflow: true,
        },
        null,
        2,
      ),
    );
    console.log(
      "PASS canonical edits visible through website and shared website Undo / MCP Redo.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
