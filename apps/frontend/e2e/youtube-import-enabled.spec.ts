import { expect, test } from '@playwright/test';

test('the one-step form takes a YouTube link, template and count with one Generate button',
  async ({ page, request }) => {
    const capabilities = await request.get('http://localhost:4000/videos/import-capabilities');
    expect(capabilities.ok()).toBeTruthy();
    test.skip(!(await capabilities.json() as { youtubeEnabled: boolean }).youtubeEnabled,
      'This deployment has YouTube importing disabled.');
    const response = await request.get('http://localhost:4000/projects');
    expect(response.ok()).toBeTruthy();
    const projects = await response.json() as Array<{ id: string }>;
    expect(projects.length).toBeGreaterThan(0);

    await page.goto(`/projects/${projects[0].id}`);
    const form = page.getByRole('form', { name: 'Generate clips' });
    if (!await form.isVisible()) await page.getByRole('button', { name: /Generate clips/ }).first().click();
    // No deployment-level wording reaches the user.
    await expect(page.getByText(/deployment|retriever|yt-dlp/i)).toHaveCount(0);
    await page.getByRole('tab', { name: 'YouTube link' }).click();
    await page.getByLabel('Paste a public YouTube link').fill('https://youtu.be/AAAAAAAAAAA');
    await expect(page.getByText(/YouTube video detected/)).toBeVisible();
    await form.locator('[data-entry-template="AUTOMATIC_2"]').click();
    await form.getByRole('button', { name: 'More clips' }).click();
    await expect(form.getByTestId('entry-clip-count')).toHaveText('4');
    const generate = form.getByRole('button', { name: 'Generate 4 Clips' });
    await expect(generate).toBeDisabled();
    await page.getByRole('checkbox', { name: /I have the right to process this video/ }).check();
    await expect(generate).toBeEnabled();
    // Upload stays on the same screen and keeps the chosen settings.
    await page.getByRole('tab', { name: 'Upload file' }).click();
    await expect(page.getByRole('button', { name: 'Browse files' })).toBeVisible();
    await expect(form.getByTestId('entry-clip-count')).toHaveText('4');
  });
