import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real browser metadata checks; API side effects are intercepted and counted.
// Keep this origin equal to NEXT_PUBLIC_API_URL used to build the local frontend.
const api = process.env.E2E_API_URL ?? 'http://localhost:4000';
let root: string;
test.setTimeout(60000);
test.use({ actionTimeout: 15000 });
test.beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'browser-duration-test-'));
  for (const duration of [7201, 10800, 10801]) {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1',
      '-t', String(duration), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', join(root, `${duration}.mp4`)], { timeout: 60000 });
  }
});
test.afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

for (const width of [1440, 375, 390]) for (const duration of [7201, 10800, 10801]) {
  test(`source ${duration}s at ${width}px respects the inclusive three-hour limit`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const calls = { projects: 0, uploads: 0 };
    const now = new Date().toISOString();
    await page.route(`${api}/**`, async route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      let data: unknown = {};
      if (path === '/auth/session') data = { id: 'duration-owner', email: 'owner@example.invalid',
        role: 'USER', creditBalance: 10, aiProcessingConsentAt: now };
      else if (path === '/videos/import-capabilities') data = { youtubeEnabled: false, xeeFree: true, xeePro: false };
      else if (path === '/projects' && req.method() === 'POST') { calls.projects++; data = { id: 'duration-project' }; }
      else if (path === '/projects/duration-project/videos' && req.method() === 'POST') {
        calls.uploads++;
        data = { id: 'duration-video', projectId: 'duration-project' };
      } else if (path === '/projects/duration-project') data = { id: 'duration-project', name: 'Duration fixture', videos: [] };
      else if (path === '/videos' || path === '/history/clips') data = [];
      await route.fulfill({ status: req.method() === 'POST' ? 201 : 200, json: data });
    });
    await page.goto('/create');
    await expect(page.getByText('Gallery or Files · Maximum video length: 3 hours')).toBeVisible();
    await page.getByLabel('Video file', { exact: true }).setInputFiles(join(root, `${duration}.mp4`));
    await expect(page.getByText(/30 up to 3 hours/)).toBeVisible();
    const generate = page.getByRole('button', { name: /^Generate 3 Clips$/ });
    await expect(generate).toBeEnabled();
    await generate.click();
    if (duration <= 10800) {
      await expect.poll(() => calls.uploads).toBe(1);
      expect(calls.projects).toBe(1);
      await expect(page).toHaveURL(/session=duration-project/);
    } else {
      await expect(page.getByRole('form', { name: 'Generate clips' }).getByRole('alert')).toContainText('This video is longer than the 3-hour limit. Please upload a video up to 3 hours.');
      expect(calls).toEqual({ projects: 0, uploads: 0 });
      await expect(generate).toBeEnabled();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  });
}
