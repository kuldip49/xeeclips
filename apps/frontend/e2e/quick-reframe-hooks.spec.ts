import { expect, test, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
/**
 * Live: the user's own hook replaces the suggested one, and Regenerate never repeats what was shown,
 * in StyleOne ("Change hook") and in the Manual editor's Hooks tool (E2E_REFRAME_SOURCE = owned video).
 */
const source = process.env.E2E_REFRAME_SOURCE;
const api = process.env.E2E_API_URL ?? 'http://localhost:4000';
const created: string[] = [];
test.describe.configure({ mode: 'serial', timeout: 20 * 60 * 1000 });
test.skip(!source, 'Set E2E_REFRAME_SOURCE to an owned test video.');
test.afterAll(async ({ request }) => { if (process.env.KEEP !== '1') for (const id of created) await request.delete(`${api}/quick-reframe/${id}`); });

async function wait(request: APIRequestContext, id: string) {
  for (;;) {
    const s = await (await request.get(`${api}/quick-reframe/${id}`)).json();
    if (s.status === 'FAILED') throw new Error(s.error);
    if (!['PLAYBACK', 'ANALYZE', 'PREPARE', 'PREVIEW', 'EXPORT', 'IMPORT'].includes(s.status)) return s;
    await new Promise((r) => setTimeout(r, 1500));
  }
}
async function croppedSession(request: APIRequestContext) {
  let s = await (await request.post(`${api}/quick-reframe`)).json(); created.push(s.id);
  const file = readFileSync(source!);
  const u = await (await request.post(`${api}/quick-reframe/${s.id}/upload`, { data: { name: 'hooks.mp4', size: file.length, mimeType: 'video/mp4' } })).json();
  for (let i = 0; i < u.chunks; i++) await request.put(`${api}/quick-reframe/uploads/${u.id}/chunks/${i}`, { headers: { 'content-type': 'application/octet-stream' }, data: file.subarray(i * u.chunkBytes, (i + 1) * u.chunkBytes) });
  await request.post(`${api}/quick-reframe/uploads/${u.id}/complete`);
  await request.post(`${api}/quick-reframe/${s.id}/playback`); s = await wait(request, s.id);
  await request.post(`${api}/quick-reframe/${s.id}/confirm-crop`, { data: { revision: s.revision } }); return wait(request, s.id);
}
const hookText = async (request: APIRequestContext, s: { editProjectId: string }) =>
  ((await (await request.get(`${api}/edit-mode/projects/${s.editProjectId}`)).json()).elements as Array<{ type: string; properties: { content?: string; presetRole?: string } }>)
    .find((e) => e.type === 'TEXT' && e.properties.presetRole === 'HOOK')?.properties.content;

test('StyleOne: Change hook -> my own hook replaces it; Regenerate shows new suggestions', async ({ page, request }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  let s = await croppedSession(request);
  await request.post(`${api}/quick-reframe/${s.id}/styleone`, { data: { revision: s.revision } }); s = await wait(request, s.id);
  const generated = await hookText(request, s); expect(generated).toBeTruthy();
  await page.goto(`/quick-reframe?video=${s.id}&step=edit`);
  await page.getByRole('button', { name: 'Change Hook' }).click();
  const sheet = page.getByRole('dialog', { name: 'Change hook' });
  // Regenerate: the new list shares no line with the one shown before (or explains why nothing is new).
  const before = await sheet.getByTestId('hook-card').locator('p').allTextContents();
  await sheet.getByTestId('regenerate-hooks').click();
  await expect.poll(async () => { const now = await sheet.getByTestId('hook-card').locator('p').allTextContents();
    return now.join('|') !== before.join('|') || await sheet.getByText(/new suggestion|already shown/).count() > 0; }, { timeout: 60000 }).toBeTruthy();
  const after = await sheet.getByTestId('hook-card').locator('p').allTextContents();
  if (after.join('|') !== before.join('|')) expect(after.filter((line) => before.includes(line))).toEqual([]);
  // My own hook.
  await sheet.getByLabel('Write your own hook').fill('My own StyleOne hook line');
  await sheet.getByRole('button', { name: 'Use my hook' }).click();
  await expect.poll(() => hookText(request, s), { timeout: 60000 }).toBe('My own StyleOne hook line');
  await expect(page.getByText('My own StyleOne hook line').first()).toBeVisible({ timeout: 60000 });
  await expect(page.getByLabel('StyleOne preview')).toBeVisible({ timeout: 10 * 60 * 1000 });
});

test('Manual: Hooks tool -> my own hook replaces the applied one; Regenerate shows new suggestions', async ({ page, request }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  let s = await croppedSession(request);
  await request.post(`${api}/quick-reframe/${s.id}/path`, { data: { revision: s.revision, path: 'MANUAL' } }); s = await wait(request, s.id);
  await page.goto(`/edit-mode/${s.editProjectId}?tool=hooks`);
  await page.waitForLoadState('networkidle'); await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
  const hooks = page.getByRole('region', { name: 'Suggested Hooks' });
  await hooks.getByTestId('generate-hooks').click();
  const first = hooks.getByTestId('hook-card').first(); await expect(first).toBeVisible({ timeout: 120000 });
  await first.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(() => hookText(request, s), { timeout: 30000 }).toBeTruthy();
  const before = await hooks.getByTestId('hook-card').locator('p').allTextContents();
  await hooks.getByTestId('regenerate-hooks').click();
  await expect.poll(async () => { const now = await hooks.getByTestId('hook-card').locator('p').allTextContents();
    return now.join('|') !== before.join('|') || await hooks.getByText(/new suggestion|already shown/).count() > 0; }, { timeout: 60000 }).toBeTruthy();
  await hooks.getByLabel('Write your own hook').fill('My own manual hook line');
  await hooks.getByRole('button', { name: 'Use my hook' }).click();
  await expect.poll(() => hookText(request, s), { timeout: 30000 }).toBe('My own manual hook line');
  await expect(page.getByTestId('edit-preview-canvas').getByText(/My own manual hook line/i)).toBeVisible();
  // Editing it again updates the same hook (no second hook element).
  await hooks.getByLabel('Write your own hook').fill('Second version of my hook');
  await hooks.getByRole('button', { name: 'Use my hook' }).click();
  await expect.poll(() => hookText(request, s), { timeout: 30000 }).toBe('Second version of my hook');
  const texts = ((await (await request.get(`${api}/edit-mode/projects/${s.editProjectId}`)).json()).elements as Array<{ type: string }>).filter((e) => e.type === 'TEXT');
  expect(texts).toHaveLength(1);
});
