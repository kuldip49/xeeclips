import { expect, test } from '@playwright/test';

test('without YouTube importing the one-step form is upload-only and never asks about deployment',
  async ({ page, request }) => {
    const capabilities = await request.get('http://localhost:4000/videos/import-capabilities');
    expect(capabilities.ok()).toBeTruthy();
    test.skip((await capabilities.json() as { youtubeEnabled: boolean }).youtubeEnabled,
      'This deployment has YouTube importing enabled.');
    const response = await request.get('http://localhost:4000/projects');
    expect(response.ok()).toBeTruthy();
    const projects = await response.json() as Array<{ id: string }>;
    expect(projects.length).toBeGreaterThan(0);

    await page.goto(`/projects/${projects[0].id}`);
    const form = page.getByRole('form', { name: 'Generate clips' });
    if (!await form.isVisible()) await page.getByRole('button', { name: /Generate clips/ }).first().click();
    await expect(page.getByRole('tab', { name: 'YouTube link' })).toHaveCount(0);
    await expect(page.getByText(/deployment|retriever|yt-dlp/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Browse files' })).toBeVisible();
    await expect(form.getByRole('button', { name: /Generate \d+ Clips?/ })).toBeDisabled();

    // The backend still refuses the import on its own.
    const refused = await request.post('http://localhost:4000/videos/import-url', { data: {
      projectId: projects[0].id, url: 'https://youtu.be/AAAAAAAAAAA', rightsConfirmed: true } });
    expect(refused.status()).toBe(400);
    expect((await refused.json() as { code: string }).code).toBe('IMPORT_UNAVAILABLE');
  });
