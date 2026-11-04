const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { chromium, expect } = require("@playwright/test");
const {
  request,
  connect,
  call,
  accounts,
  base,
  origin,
} = require("./mcp-acceptance-client.cjs");
const dir = path.resolve(
    process.env.MCP_QA_DIR || path.join(__dirname, "../../../.cache/mcp"),
  ),
  target = JSON.parse(
    fs.readFileSync(path.join(dir, "media-acceptance.json")),
  ).create.find((c) => c.style === "STYLE_ONE");
(async () => {
  const c = await connect(accounts[0]),
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
    if (process.env.MCP_QA_PROXY_API === "1")
      await ctx.route("https://api.xeeclip.me/**", async (route) => {
        const u = new URL(route.request().url());
        const response = await route.fetch({
          url: base + u.pathname + u.search,
          headers: {
            ...route.request().headers(),
            Origin: origin,
            Cookie: cookie,
          },
        });
        await route.fulfill({ response });
      });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    await request("/mcp/reviews/settings", {
      method: "PATCH",
      cookie,
      body: { enabled: false },
    });
    for (const width of [1440, 375, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(origin + "/settings");
      const toggle = page.getByRole("switch", {
        name: "AI Video Review",
        exact: true,
      });
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await page.reload();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      const purpose = "Browser review approval " + width + " " + Date.now(),
        review = await call(c, "request_video_review", {
          clipId: target.clipId,
          purpose,
          idempotencyKey: "review-browser-" + width + "-" + Date.now(),
        });
      await page.goto(origin + "/settings?review=" + review.reviewRequestId);
      const dialog = page.getByRole("dialog", {
        name: "Allow AI to review this video?",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText(
          /An assistant can understand anything visible or audible/,
        ),
      ).toBeVisible();
      await expect.poll(()=>dialog.locator("video").evaluate(v=>v.readyState)).toBeGreaterThanOrEqual(1);
      const revisions = dialog.getByRole("checkbox");
      await expect(revisions).not.toBeChecked();
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "review dialog overflow " + width,
      );
      const allow = dialog.getByRole("button", {
        name: "Allow Once",
        exact: true,
      });
      await allow.scrollIntoViewIfNeeded();
      await expect(allow).toBeVisible();
      await page.screenshot({
        path: path.join(dir, "review-approval-" + width + ".png"),
        fullPage: false,
      });
      if (width === 1440) {
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        const denied = await c.callTool({
          name: "xeeclip_get_review_media",
          arguments: { reviewRequestId: review.reviewRequestId },
        });
        assert(denied.isError);
        assert.equal(
          denied.structuredContent.error.code,
          "AI_VIDEO_REVIEW_DENIED",
        );
      } else {
        if (width === 390) {
          await revisions.check();
          await dialog
            .getByRole("button", {
              name: "Allow this edit session",
              exact: true,
            })
            .click();
        } else await allow.click();
        await expect(dialog).toHaveCount(0);
        const media = await call(c, "get_review_media", {
          reviewRequestId: review.reviewRequestId,
        });
        assert(media.reviewUrl);
        if (width === 390) {
          const settings = (await request("/mcp/reviews", { cookie })).value;
          assert.equal(
            settings.requests.find(
              (r) => r.reviewRequestId === review.reviewRequestId,
            ).allowRevisions,
            true,
          );
        }
        const card = page.locator("article").filter({ hasText: purpose });
        await expect(card).toBeVisible();
        await card.getByRole("button", { name: "Revoke", exact: true }).click();
        const revoked = await c.callTool({
          name: "xeeclip_get_review_media",
          arguments: { reviewRequestId: review.reviewRequestId },
        });
        assert(revoked.isError);
        assert.equal(
          revoked.structuredContent.error.code,
          "AI_VIDEO_REVIEW_REVOKED",
        );
      }
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await page.reload();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
    }
    await page.goto(origin + "/history");
    const check = page
      .getByRole("button", { name: "Check with AI", exact: true })
      .first();
    await check.scrollIntoViewIfNeeded();
    await check.click();
    const dialog = page.getByRole("dialog", {
      name: "Check with AI",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Continue to approval", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByText("AI Video Review is off.", { exact: true }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    fs.writeFileSync(
      path.join(dir, "video-review-browser.json"),
      JSON.stringify(
        {
          passed: true,
          widths: [1440, 375, 390],
          humanConsent: true,
          defaultSingleRender: true,
          privacyExplanation: true,
          noHorizontalOverflow: true,
          togglePersists: true,
          cancelDenies: true,
          allowOnceGrants: true,
          revokeDenies: true,
          resultButtonNeverSilentlyShares: true,
        },
        null,
        2,
      ),
    );
    console.log(
      "PASS desktop/375/390 human approval, explicit OFF/ON, default single render, Cancel/Allow Once/Revoke, and result-button privacy.",
    );
  } finally {
    await c.close();
    await browser.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
