import { expect, test, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
const SOURCE = process.env.E2E_SOURCE ?? '';
const DOCKER = process.env.E2E_DOCKER_BINARY ?? 'docker';

type Result = Record<string, any>;
async function json(request: APIRequestContext, path: string): Promise<Result> {
  const response = await request.get(`${API}${path}`);
  expect(response.ok(), `${path}: ${response.status()}`).toBeTruthy();
  return response.json();
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, minutes: number) {
  const deadline = Date.now() + minutes * 60_000;
  let value = await read();
  while (!done(value)) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value).slice(0, 500)}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    value = await read();
  }
  return value;
}

test('public Automatic 2, editor, Ask AI, export and playback', async ({ page, request }) => {
  test.skip(!SOURCE, 'Set E2E_SOURCE to a short video');
  const created = await request.post(`${API}/projects`, {
    data: { name: `e2e-deploy-${Date.now()} (disposable)` }
  });
  expect(created.status()).toBe(201);
  const project = await created.json() as Result;
  let videoId: string | null = null;
  const editIds = new Set<string>();
  try {
    await page.goto(`/projects/${project.id}`);
    await page.locator('label[data-entry-template="AUTOMATIC_2"]').click();
    await page.getByRole('button', { name: 'Fewer clips' }).click();
    await expect(page.getByTestId('entry-clip-count')).toHaveText('2');
    await page.locator('input#file').setInputFiles(SOURCE);
    await page.getByText('More options').click();
    await page.locator('select:has(option[value="FALLBACK_ONLY"])').selectOption('FALLBACK_ONLY');
    await page.getByRole('button', { name: 'Generate 2 Clips' }).click();
    await expect(page.getByTestId('source-preview')).toBeVisible({ timeout: 120_000 });
    const videos = await json(request, `/videos?projectId=${project.id}`) as Result[];
    expect(videos).toHaveLength(1);
    videoId = videos[0].id;
    await expect.poll(async () => {
      const list = await json(request, `/videos?projectId=${project.id}`) as Result[];
      return list[0]?.processingJobs?.[0]?.status;
    }, { timeout: 20 * 60_000 }).toBe('COMPLETED');
    const results = await until(() => json(request, `/videos/${videoId}/clip-results`),
      (value) => ['COMPLETE', 'PARTIAL', 'FAILED'].includes(value.deliveryStatus), 25);
    expect(results.deliveryStatus, results.error).toBe('COMPLETE');
    expect(results.requestedClipCount).toBe(2);
    expect(results.deliveredClipCount).toBe(2);
    expect(results.clips).toHaveLength(2);
    expect(results.clips.every((clip: Result) => clip.templateId === 'AUTOMATIC_2')).toBeTruthy();

    const sourceRange = await request.get(`${API}/videos/${videoId}/file`, {
      headers: { Range: 'bytes=0-1023' }
    });
    expect(sourceRange.status()).toBe(206);
    expect(sourceRange.headers()['content-range']).toMatch(/^bytes 0-1023\//);
    const clipRange = await request.get(`${API}${results.clips[0].playbackUrl}`, {
      headers: { Range: 'bytes=0-1023' }
    });
    expect(clipRange.status()).toBe(206);
    expect(clipRange.headers()['content-type']).toContain('video/');

    await page.reload();
    await expect(page.getByTestId('clip-result')).toHaveCount(2, { timeout: 120_000 });
    await page.getByTestId('clip-result').first().getByRole('button', { name: 'Ask AI' }).click();
    await page.waitForURL(/\/edit-mode\/[0-9a-f-]+\?panel=ai/, { timeout: 120_000 });
    const editId = new URL(page.url()).pathname.split('/').pop()!;
    editIds.add(editId);
    const agent = page.getByTestId('agent-panel');
    await expect(agent).toBeVisible({ timeout: 60_000 });
    await agent.getByLabel('Tell the AI editor what to change').fill('add a zoom here');
    await agent.getByRole('button', { name: 'Edit with AI' }).click();
    await expect(agent.getByTestId('agent-ledger')).toBeVisible({ timeout: 120_000 });
    await expect(agent.getByTestId('agent-ledger')).not.toContainText('Failed');

    await page.reload();
    await expect(agent).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: 'Export video' }).click();
    const exports = await until(() => json(request, `/edit-mode/projects/${editId}/exports`),
      (value) => Array.isArray(value) && value.some((item: Result) => item.current), 20) as Result[];
    const current = exports.find((item) => item.current)!;
    const exportRange = await request.get(`${API}/edit-mode/assets/${current.id}/file`, {
      headers: { Range: 'bytes=0-1023' }
    });
    expect(exportRange.status()).toBe(206);
    expect(exportRange.headers()['content-type']).toContain('video/');
  } finally {
    for (const id of editIds) await request.delete(`${API}/edit-mode/projects/${id}`).catch(() => undefined);
    if (videoId) await request.delete(`${API}/videos/${videoId}`).catch(() => undefined);
    const safeId = String(project.id).replace(/[^0-9a-f-]/giu, '');
    if (safeId === project.id) {
      const sql = `DELETE FROM "Project" WHERE id = '${safeId}' AND name LIKE 'e2e-deploy-% (disposable)'`;
      try { execFileSync(DOCKER, ['exec', 'ai-content-postgres', 'psql', '-U', 'postgres',
        '-d', 'ai_content_platform', '-c', sql]); } catch { /* best effort */ }
    }
  }
});
