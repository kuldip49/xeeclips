import { expect, test, type Page } from '@playwright/test';

/**
 * Responsive regression for the phone/tablet layouts. Read-only against the local stack:
 * nothing here uploads, generates, saves an edit or exports, so it leaves no data behind.
 *
 * Fixtures default to projects on the dev stack; override with
 * E2E_MOBILE_PROJECT_ID (a project whose first video has generated clips) and
 * E2E_MOBILE_EDIT_PROJECT_ID (an edit project with a source).
 */
const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
const PROJECT_ID = process.env.E2E_MOBILE_PROJECT_ID ?? '42369fc8-4238-4773-a1ec-874746774a20';
const EDIT_PROJECT_ID = process.env.E2E_MOBILE_EDIT_PROJECT_ID ?? '5912ed71-ee50-4998-8b86-848de6f7f3b0';
const PHONE_WIDTHS = [320, 360, 375, 390, 412, 430];

const phone = (width: number) => ({ viewport: { width, height: width <= 360 ? 640 : 844 },
  isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

/** The Next.js dev badge sits over the bottom-left corner in `next dev`; production has none. */
async function hideDevOverlay(page: Page) {
  await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' }).catch(() => undefined);
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const { scrollWidth, width } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scrollWidth, `${label}: page scrolls horizontally (${scrollWidth} > ${width})`).toBeLessThanOrEqual(width);
}

/** Ask AI asks before any clip content is sent; a fresh browser context has not agreed yet. */
async function allowAskAi(page: Page) {
  const consent = page.getByTestId('ask-ai-consent');
  await expect(consent).toBeVisible({ timeout: 60_000 });
  await expect(consent.getByRole('button', { name: 'Cancel' })).toBeVisible();
  const allow = consent.getByRole('button', { name: 'Allow Ask AI' });
  await expectTouchSize(page, allow, 'Allow Ask AI');
  await allow.click();
  await expect(consent).toBeHidden();
}

async function expectTouchSize(page: Page, locator: ReturnType<Page['locator']>, label: string) {
  const box = await locator.boundingBox();
  expect(box, `${label} is not rendered`).not.toBeNull();
  expect(box!.height, `${label} is shorter than a finger`).toBeGreaterThanOrEqual(40);
}

test.describe('A. 375px shell', () => {
  test.use(phone(375));

  test('home loads, fits, and the tab bar navigates', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Create clips', level: 1 })).toBeVisible();
    await hideDevOverlay(page);
    await expectNoHorizontalOverflow(page, 'create');

    const nav = page.getByTestId('mobile-nav');
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link')).toHaveCount(4);
    for (const [name, url, heading] of [['History', /\/history$/, 'History'], ['Edit', /\/edit$/, 'Edit clips'],
      ['Settings', /\/settings$/, 'Settings'], ['Create', /\/$/, 'Create clips']] as const) {
      const link = nav.getByRole('link', { name, exact: true });
      await expectTouchSize(page, link, `tab ${name}`);
      await link.click();
      await page.waitForURL(url);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await expect(nav.getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page');
      await expectNoHorizontalOverflow(page, name);
    }

    // The app header stays pinned while the page scrolls (an overflow-x:hidden shell once broke
    // every sticky element: the header scrolled away and the sticky Generate never stuck).
    await page.evaluate(() => window.scrollTo(0, 400));
    await expect.poll(() => page.evaluate(() => Math.round(document.querySelector('header')!.getBoundingClientRect().top)))
      .toBe(0);
  });

  test('no page-level horizontal overflow at any phone width', async ({ page }) => {
    for (const width of PHONE_WIDTHS) {
      await page.setViewportSize({ width, height: width <= 360 ? 640 : 844 });
      for (const route of ['/', '/history', '/edit', '/settings', '/create', `/projects/${PROJECT_ID}`]) {
        await page.goto(route);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await expectNoHorizontalOverflow(page, `${route} @ ${width}px`);
      }
    }
  });
});

test.describe('B. 390px create flow', () => {
  test.use(phone(390));

  test('URL input, template, count and Generate are usable one-handed', async ({ page, request }) => {
    const capabilities = await (await request.get(`${API}/videos/import-capabilities`)).json() as { youtubeEnabled: boolean };
    await page.goto('/create');
    await hideDevOverlay(page);
    const form = page.getByRole('form', { name: 'Generate clips' });
    await expect(form).toBeVisible();
    const generate = form.getByRole('button', { name: /^Generate \d+ Clips?$/ });
    await expect(generate).toBeInViewport();
    await expectTouchSize(page, generate, 'Generate');

    if (capabilities.youtubeEnabled) {
      await form.getByRole('tab', { name: 'YouTube link' }).click();
      const url = form.getByLabel('Paste a public YouTube link');
      await expectTouchSize(page, url, 'URL input');
      const fontSize = await url.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
      expect(fontSize, 'inputs under 16px make iOS zoom the page').toBeGreaterThanOrEqual(16);
      await url.fill('https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=a-very-long-playlist-parameter-that-must-not-overflow');
      await expect(form.getByText('YouTube video detected.')).toBeVisible();
      await expectNoHorizontalOverflow(page, 'long URL');
      await form.getByRole('button', { name: 'Clear link' }).click();
      await expect(url).toHaveValue('');
      await form.getByRole('tab', { name: 'Upload file' }).click();
    }

    await expect(form.getByRole('button', { name: 'Choose video' })).toBeVisible();
    await form.locator('label[data-entry-template="AUTOMATIC_2"]').click();
    await expect(form.locator('input[value="AUTOMATIC_2"]')).toBeChecked();
    const more = form.getByRole('button', { name: 'More clips' });
    await expectTouchSize(page, more, 'More clips');
    await more.click();
    await expect(form.getByTestId('entry-clip-count')).toHaveText('4');
    await form.getByRole('button', { name: 'Fewer clips' }).click();
    await expect(form.getByTestId('entry-clip-count')).toHaveText('3');
    await form.getByText('More options').click();
    await expect(form.getByTestId('entry-brief')).toBeVisible();

    // A chosen file enables Generate; the test stops there (no upload is sent).
    await form.locator('input#file').setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(2048) });
    await expect(form.getByText('clip.mp4')).toBeVisible();
    await expect(generate).toBeEnabled();
    await expect(generate).toBeInViewport();
    await expectNoHorizontalOverflow(page, 'create with file');
  });
});

test.describe('C. phone result cards', () => {
  test.use(phone(390));

  test('cards fit and Edit / Ask AI / Export / full-screen preview are reachable', async ({ page, request }) => {
    const project = await (await request.get(`${API}/projects/${PROJECT_ID}`)).json() as { videos: Array<{ id: string }> };
    const videoId = project.videos?.[0]?.id;
    const results = videoId ? await (await request.get(`${API}/videos/${videoId}/clip-results`)).json() as { clips: unknown[] } : { clips: [] };
    test.skip(!results.clips?.length, 'Set E2E_MOBILE_PROJECT_ID to a project with generated clips');

    await page.goto(`/projects/${PROJECT_ID}`);
    await hideDevOverlay(page);
    const cards = page.getByTestId('clip-result');
    await expect(cards.first()).toBeVisible({ timeout: 60_000 });
    const width = page.viewportSize()!.width;
    const count = await cards.count();
    for (let index = 0; index < count; index++) {
      const box = await cards.nth(index).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    const card = cards.first();
    await card.scrollIntoViewIfNeeded();
    for (const [label, locator] of [['Edit', card.getByRole('button', { name: 'Edit', exact: true })],
      ['Ask AI', card.getByRole('button', { name: 'Ask AI' })],
      ['Export', card.getByRole('link', { name: /Export clip/ })]] as const) {
      await expect(locator).toBeVisible();
      await expectTouchSize(page, locator, label);
    }
    // One card per row on a phone, and the preview is large enough to judge the clip.
    const media = card.locator('video, button[aria-label^="Preview clip"], [data-testid="automatic-2-pending"]').first();
    const mediaBox = await media.boundingBox();
    expect(mediaBox!.width).toBeGreaterThan(width * 0.6);

    const fullScreen = card.getByRole('button', { name: /full screen/ });
    if (await fullScreen.isEnabled()) {
      await fullScreen.click();
      const player = page.getByRole('dialog');
      await expect(player.locator('video')).toBeVisible();
      const playerBox = await player.boundingBox();
      expect(playerBox!.height).toBeGreaterThan(page.viewportSize()!.height * 0.9);
      await player.getByRole('button', { name: 'Close' }).click();
      await expect(player).toBeHidden();
    }
    await expectNoHorizontalOverflow(page, 'results');
  });
});

test.describe('D. phone editor', () => {
  test.use(phone(390));

  test('preview, tool bar, AI drawer, crop and export are usable without overflow', async ({ page }) => {
    await page.goto(`/edit-mode/${EDIT_PROJECT_ID}`);
    await hideDevOverlay(page);
    const canvas = page.getByTestId('edit-preview-canvas');
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    const toolbar = page.getByTestId('mobile-editor-toolbar');
    await expect(toolbar).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Inspector and AI editor' })).toHaveCount(0);
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox!.height).toBeGreaterThan(200);
    await expectNoHorizontalOverflow(page, 'editor');

    // Ask AI: drawer docked under the preview, composer and send button on screen.
    await toolbar.getByRole('button', { name: 'Ask AI' }).click();
    await allowAskAi(page);
    const agent = page.getByTestId('agent-panel');
    await expect(agent).toBeVisible();
    const input = agent.getByLabel('Tell the AI editor what to change');
    await expect(input).toBeInViewport();
    await expect(agent.getByRole('button', { name: 'Edit with AI' })).toBeInViewport();
    await expect(canvas).toBeVisible();
    await input.fill('make captions white');
    await expect(agent.getByRole('button', { name: 'Edit with AI' })).toBeEnabled();
    await input.fill('');
    await page.getByRole('button', { name: 'Close AI editor' }).click();
    await expect(agent).toBeHidden();

    // Crop: selects the segment under the playhead and gives the preview to the crop frame.
    await toolbar.getByRole('button', { name: 'Crop', exact: true }).click();
    await expect(page.getByTestId('crop-rectangle')).toBeVisible();
    const handle = page.getByTestId('crop-handle-se');
    await expect(handle).toBeVisible();
    await expectTouchSize(page, page.getByRole('button', { name: 'Done' }), 'Crop Done');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('crop-rectangle')).toBeHidden();

    // Export is reachable from the top bar.
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Export video' })).toBeVisible();
    await expectNoHorizontalOverflow(page, 'editor export drawer');
  });

  test('Ask AI from a result card opens the editor with the AI drawer', async ({ page }) => {
    await page.goto(`/edit-mode/${EDIT_PROJECT_ID}?panel=ai`);
    await allowAskAi(page);
    await expect(page.getByTestId('agent-panel')).toBeVisible({ timeout: 60_000 });
  });
});

test.describe('E. backend offline', () => {
  test.use(phone(375));

  test('the frontend renders and explains the offline server plainly', async ({ page }) => {
    // Every browser call to the processing API fails, as when the laptop/tunnel is down.
    await page.route(`${API}/**`, (route) => route.abort('connectionrefused'));
    await page.goto('/create');
    const notice = page.getByTestId('offline-notice');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText('Processing server is currently offline.');
    await expect(page.getByRole('button', { name: /^Generate \d+ Clips?$/ })).toBeDisabled();
    await expect(page.getByText(/TypeError|Failed to fetch|ECONNREFUSED|API request failed/)).toHaveCount(0);
    await expectNoHorizontalOverflow(page, 'offline create');

    for (const route of ['/history', '/edit']) {
      await page.goto(route);
      await expect(page.getByTestId('offline-notice')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/TypeError|Failed to fetch|ECONNREFUSED|API request failed/)).toHaveCount(0);
      await expectNoHorizontalOverflow(page, `offline ${route}`);
    }
  });
});
