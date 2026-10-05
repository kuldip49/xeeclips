const assert = require('node:assert/strict');
const { basename } = require('node:path');
const { chromium, request } = require('@playwright/test');

async function main() {
  const filePath = process.env.VIDEO_FILE;
  assert(filePath, 'Set VIDEO_FILE to a local video owned by the tester.');
  const api = await request.newContext({ baseURL: 'http://localhost:4000' });
  const created = await api.post('/projects', { data: {
    name: `URL ingestion upload regression ${new Date().toISOString()}`
  } });
  assert.equal(created.status(), 201);
  const project = await created.json();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:3000/projects/${project.id}`);
    await page.locator('input[type="file"][name="file"]').setInputFiles(filePath);
    await page.getByRole('button', { name: /^Generate \d+ Clips?$/ }).click();
    await page.getByRole('heading', { name: basename(filePath) }).waitFor({
      timeout: 120_000
    });
    const response = await api.get(`/videos?projectId=${encodeURIComponent(project.id)}`);
    assert(response.ok());
    const [video] = await response.json();
    assert(video && video.sizeBytes > 0 && video.sourceType === 'UPLOAD');
    assert(video.processingJobs?.[0], 'Expected processing job to start automatically');
    console.log(JSON.stringify({ projectId: project.id, videoId: video.id,
      sourceType: video.sourceType, sizeBytes: video.sizeBytes,
      processingStatus: video.processingJobs[0].status }));
  } finally {
    await browser.close();
    await api.dispose();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
