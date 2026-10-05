import { expect, test } from '@playwright/test';

const widths = [320, 360, 375, 390, 412, 430, 768, 1024, 1440];

test.beforeEach(async ({ page }) => {
  await page.route('http://localhost:4000/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path === '/history/clips' ? '[]' : path === '/videos/import-capabilities'
      ? JSON.stringify({ youtubeEnabled: true }) : path === '/edit-mode/creative/catalog'
        ? JSON.stringify({ templates: [], categories: [], components: {} }) : '{}';
    await route.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': 'http://localhost:3001',
        'Access-Control-Allow-Credentials': 'true' }, body });
  });
});

test('Create is home, with only Create, History and Settings navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Create clips' })).toBeVisible();
  const nav = page.getByTestId('mobile-nav');
  await expect(nav.getByRole('link', { name: 'Create' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'History' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(nav.getByRole('link')).toHaveCount(3);
  await expect(page.getByText('StyleZero')).toBeVisible();
  await expect(page.getByText('StyleOne')).toBeVisible();
  await expect(page.getByText('No Edit')).toBeVisible();
  await expect(page.getByText('XeeFree')).toBeVisible();
  await expect(page.getByText('XeePro')).toBeVisible();
  await nav.getByRole('link', { name: 'History' }).click();
  await expect(page.getByText('No clips yet.')).toBeVisible();
  await nav.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.goto('/dashboard');
  await expect(page).toHaveURL('/');
  await page.goto('/projects');
  await expect(page).toHaveURL('/history');
});

test('main routes have no page-level horizontal overflow at requested widths', async ({ page }) => {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/', '/history', '/settings']) {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth,
        viewport: window.innerWidth }));
      expect(size.scroll, `${path} at ${width}px`).toBeLessThanOrEqual(size.viewport);
    }
  }
});
