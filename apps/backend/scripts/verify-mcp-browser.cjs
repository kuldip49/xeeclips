const artifactDir = require("path").resolve(
  process.env.MCP_QA_DIR ||
    require("path").join(__dirname, "../../../.cache/mcp"),
);
const { chromium, expect } = require("@playwright/test"),
  {
    request,
    accounts,
    base,
    scopes,
    origin,
  } = require("./mcp-acceptance-client.cjs"),
  { randomBytes, createHash } = require("crypto"),
  fs = require("fs"),
  assert = require("assert/strict"),
  path = require("path");
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
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
    for (const width of [1440, 375, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(origin + "/settings");
      await expect(
        page.getByRole("heading", { name: "AI Assistants", exact: true }),
      ).toBeVisible({ timeout: 60000 });
      await expect(
        page.getByText(base + "/mcp", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Revoke", exact: true })
        .first()
        .scrollIntoViewIfNeeded();
      await fits("Settings " + width);
      await page.screenshot({
        path: path.join(
          process.env.MCP_QA_DIR ||
            path.resolve(__dirname, "../../../.cache/mcp"),
          "settings-" + width + ".png",
        ),
        fullPage: true,
      });
    }
    const { value: client } = await request("/register", {
      method: "POST",
      expected: 201,
      body: {
        client_name: "Browser acceptance assistant",
        redirect_uris: ["http://localhost:49371/callback"],
        token_endpoint_auth_method: "none",
        scope: scopes.join(" "),
      },
    });
    const verifier = randomBytes(48).toString("base64url");
    const q = new URLSearchParams({
      client_id: client.client_id,
      response_type: "code",
      redirect_uri: client.redirect_uris[0],
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      scope: scopes.join(" "),
      resource: base + "/mcp",
      state: "browser-acceptance",
    });
    const { r } = await request("/authorize?" + q, {
      expected: 302,
      redirect: "manual",
    });
    const location = r.headers.get("location");
    for (const width of [1440, 375, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(location);
      await expect(
        page.getByRole("heading", {
          name: "Connect an AI assistant",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByText("Browser acceptance assistant", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Create clips using your credits", { exact: true }),
      ).toBeVisible();
      assert(!(await page.locator("body").innerText()).includes("xeeclip:"));
      await page
        .getByRole("button", { name: "Allow", exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        page.getByRole("button", { name: "Allow", exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeVisible();
      await fits("Consent " + width);
      await page.screenshot({
        path: path.join(artifactDir, "consent-" + width + ".png"),
        fullPage: true,
      });
    }
    await page.route("http://localhost:49371/callback**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<h1>Connected</h1>",
      }),
    );
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Connected", exact: true }),
    ).toBeVisible();
    assert.equal(
      new URL(page.url()).searchParams.get("state"),
      "browser-acceptance",
    );
    await request("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code: new URL(page.url()).searchParams.get("code"),
        code_verifier: verifier,
        redirect_uri: client.redirect_uris[0],
        resource: base + "/mcp",
      }),
    });
    await page.goto(origin + "/settings");
    const card = page.locator("article").filter({
      has: page.getByRole("heading", {
        name: "Browser acceptance assistant",
        exact: true,
      }),
    });
    await expect(card).toBeVisible({ timeout: 30000 });
    await card.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(card).toHaveCount(0);
    await request("/auth/session", { cookie: accounts[0].cookie });
    fs.writeFileSync(
      path.join(artifactDir, "browser-acceptance.json"),
      JSON.stringify(
        {
          passed: true,
          widths: [1440, 375, 390],
          settings: true,
          consent: true,
          grant: true,
          revoke: true,
          friendlyLabels: true,
          noHorizontalOverflow: true,
        },
        null,
        2,
      ),
    );
    console.log(
      "PASS desktop/375/390 Settings and consent, actual Allow callback, revoke and preserved login.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
