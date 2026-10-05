// Step 20: the unified product in a real browser, against the live stack.
//
//   upload -> source preview -> template -> caption override -> brief -> count ->
//   generate -> delivery -> preview -> direct export -> open a clip -> Ask AI
//   multi-property edit -> manual edit (undo/redo) -> reload persistence ->
//   editor export -> ffprobe the media.
//
// The browser performs every user action. The backend API is only read to
// verify persisted state, and to remove everything this test created.
//   E2E_SOURCE=<talk.mp4> npx playwright test   (from apps/frontend)
import { expect, test, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
const SOURCE = process.env.E2E_SOURCE ?? '';
const MODE = process.env.E2E_AI_MODE ?? 'FALLBACK_ONLY';

type Json = Record<string, any>;
const getJson = async (request: APIRequestContext, path: string): Promise<Json> => {
  const response = await request.get(`${API}${path}`);
  expect(response.ok(), `${path} -> ${response.status()}`).toBeTruthy();
  return response.json();
};

function probe(bytes: Buffer, dir: string, name: string) {
  const file = join(dir, name);
  writeFileSync(file, bytes);
  const args = ['-v', 'error', '-show_entries',
    'stream=codec_type,width,height:format=duration', '-of', 'json'];
  let output: string;
  try {
    output = execFileSync('ffprobe', [...args, file], { encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const docker = process.env.E2E_DOCKER_BINARY ?? 'docker';
    const remote = `/tmp/e2e-probe-${randomUUID()}.mp4`;
    execFileSync(docker, ['cp', file, `ai-content-backend:${remote}`]);
    try {
      output = execFileSync(docker, ['exec', 'ai-content-backend', 'ffprobe',
        ...args, remote], { encoding: 'utf8' });
    } finally {
      execFileSync(docker, ['exec', 'ai-content-backend', 'rm', '-f', remote]);
    }
  }
  const data = JSON.parse(output);
  const video = data.streams.find((stream: Json) => stream.codec_type === 'video');
  return { width: video?.width as number, height: video?.height as number,
    duration: Number(data.format.duration), audio: data.streams.some((stream: Json) => stream.codec_type === 'audio') };
}

async function waitUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number, everyMs = 4000) {
  const started = Date.now();
  let value = await read();
  while (!done(value)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${JSON.stringify(value).slice(0, 300)}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
    value = await read();
  }
  return value;
}

const subtitleState = (project: Json) => project.elements.filter((element: Json) => element.type === 'SUBTITLE')
  .map((element: Json) => ({ id: element.id, content: element.properties.content, fontSize: element.properties.fontSize,
    y: element.properties.y }));

test.describe.configure({ mode: 'serial' });

test('upload -> generate -> refine -> export, as one product', async ({ page, request }) => {
  test.skip(!SOURCE, 'Set E2E_SOURCE to a short talking-head video');
  const work = mkdtempSync(join(tmpdir(), 'e2e-unified-'));
  const project = await (await request.post(`${API}/projects`, { data: { name: `e2e-unified-${Date.now()} (disposable)` } })).json();
  let videoId: string | null = null;
  try {
    // 1-2. Upload in the browser; the source is visible straight away.
    await page.goto(`/projects/${project.id}`);
    await page.locator("input#file").setInputFiles(SOURCE);
    if (MODE === 'FALLBACK_ONLY') {
      await page.getByText('More options').click();
      await page.locator('select:has(option[value="FALLBACK_ONLY"])').selectOption('FALLBACK_ONLY');
    }
    await page.getByRole('button', { name: /^Generate \d+ Clips?$/ }).click();
    const preview = page.getByTestId('source-preview');
    await expect(preview).toBeVisible({ timeout: 120_000 });
    const videos = await getJson(request, `/videos?projectId=${project.id}`);
    videoId = videos[0].id as string;
    const poster = await request.get(`${API}/videos/${videoId}/poster`);
    expect(poster.headers()['content-type']).toBe('image/jpeg');
    // The <video> the user sees must point at a browser-reachable host (not SSR's internal one).
    for (const attribute of ['src', 'poster']) {
      const url = await preview.getAttribute(attribute);
      expect(url?.startsWith(API)).toBeTruthy();
      expect((await request.get(url!, { headers: { Range: 'bytes=0-1023' } })).ok()).toBeTruthy();
    }

    // Wait for analysis in the UI.
    await expect(page.getByRole('heading', { name: 'Create clips' })).toBeVisible({ timeout: 30 * 60 * 1000 });

    // 3-8. Template, caption override, brief, count; the live preview follows.
    await page.locator("label[data-look='PODCAST_PRO']").click();
    await page.getByText('Mix individual styles').click();
    await page.locator("select[data-component='CAPTIONS']").selectOption('CAP_YELLOW_ACTIVE');
    await page.getByTestId('creative-brief').fill('find the most educational explanations, captions lower');
    await expect(page.getByTestId('brief-intent')).toContainText(/educational/i);
    await expect(page.getByTestId('style-preview-captions')).toBeVisible();
    await expect(page.getByTestId('style-preview-hook')).toBeVisible();
    await expect(page.getByText('Style preview — final framing/timing may adapt to each clip.')).toBeVisible();
    await page.getByRole('button', { name: 'More clips' }).click();
    const createButton = page.getByRole('button', { name: /^Create \d+ Clips?$/ });
    const requested = Number((await createButton.textContent())?.match(/\d+/)?.[0]);
    expect(requested).toBeGreaterThanOrEqual(2);
    await createButton.click();

    // 9. Requested delivery (or an honest stop reason), then canonical styling.
    const cards = page.getByTestId('clip-result');
    await expect(cards.first()).toBeVisible({ timeout: 30 * 60 * 1000 });
    const results = await waitUntil(() => getJson(request, `/videos/${videoId}/clip-results`),
      (value) => value.status === 'COMPLETED' && value.clips.every((clip: Json) =>
        clip.style && ['READY', 'FAILED', 'SKIPPED'].includes(clip.style.status)), 30 * 60 * 1000, 8000);
    const job = (await getJson(request, `/videos/${videoId}/clip-analysis`)).clipRequest;
    expect(results.clips.length === requested || (results.clips.length > 0 && !!job.error)).toBeTruthy();
    expect(results.clips.every((clip: Json) => clip.style.status === 'READY')).toBeTruthy();
    await page.reload();
    await expect(cards).toHaveCount(results.clips.length, { timeout: 60_000 });

    // 10-11. Preview plays the styled render; export it directly (no editor).
    const exportLink = cards.first().getByRole('link', { name: /Export clip/ });
    const href = await exportLink.getAttribute('href');
    expect(href).toContain('/edit-mode/assets/');
    const direct = await request.get(href!);
    const directMedia = probe(Buffer.from(await direct.body()), work, 'direct.mp4');
    expect(directMedia).toMatchObject({ width: 1080, height: 1920, audio: true });

    // 12. Open another clip with Ask AI: the SAME canonical project, AI panel open.
    const target = results.clips[results.clips.length - 1];
    await cards.last().getByRole('button', { name: 'Ask AI' }).click();
    await page.waitForURL(new RegExp(`/edit-mode/${target.editProjectId}\\?panel=ai`), { timeout: 120_000 });
    const agent = page.getByTestId('agent-panel');
    await expect(agent).toBeVisible({ timeout: 60_000 });
    let canonical = await getJson(request, `/edit-mode/projects/${target.editProjectId}`);
    const wordingBefore = subtitleState(canonical).map((item: Json) => item.content);

    // 14-18. A multi-property AI edit; every clause is accounted for and verified.
    await agent.getByLabel('Tell the AI editor what to change').fill('make captions smaller, move them lower and make the whole video warmer');
    await agent.getByRole('button', { name: 'Edit with AI' }).click();
    const ledger = page.getByTestId('agent-ledger');
    await expect(ledger).toBeVisible({ timeout: 120_000 });
    await expect(ledger.locator('ol > li')).toHaveCount(3);
    await expect(ledger).not.toContainText(/Failed|not verified/);
    canonical = await getJson(request, `/edit-mode/projects/${target.editProjectId}`);
    const afterAi = subtitleState(canonical);
    expect(afterAi.map((item: Json) => item.content)).toEqual(wordingBefore);
    const load = () => getJson(request, `/edit-mode/projects/${target.editProjectId}`);
    const captions = (project: Json) => project.elements.filter((element: Json) => element.type === 'SUBTITLE');
    const segments = (project: Json) => project.elements.filter((element: Json) => element.type === 'VIDEO');
    const askAi = async (message: string) => {
      await page.getByRole('tab', { name: 'AI Editor' }).click();
      await agent.getByLabel('Tell the AI editor what to change').fill(message);
      await agent.getByRole('button', { name: 'Edit with AI' }).click();
      await expect(ledger).toContainText(message.split(',')[0], { timeout: 120_000 });
      await expect(agent.getByRole('button', { name: 'Edit with AI' })).toBeVisible({ timeout: 120_000 });
    };

    // 16. Manual caption correction in the Inspector (the user's own wording).
    await page.getByRole('tab', { name: 'Inspector' }).click();
    await page.getByLabel('Editing tools').getByRole('button', { name: /Captions/ }).click();
    await page.getByTestId('caption-rows').getByRole('button').nth(1).click();
    const manualText = 'Manually corrected OpenAI wording';
    await page.getByLabel('Text content').fill(manualText);
    await expect.poll(async () => captions(await load()).find((item: Json) => item.properties.content === manualText)
      ?.properties.manualEdited ?? false, { timeout: 30_000 }).toBe(true);
    const manualId = captions(await load()).find((item: Json) => item.properties.content === manualText).id as string;

    // 19. Selected-caption override: only this caption becomes 52.
    await page.getByLabel('Caption style scope').selectOption('SELECTED_ELEMENT');
    await page.getByLabel('Font size').fill('52');
    await page.getByLabel('Font size').press('Tab');
    await expect.poll(async () => captions(await load()).find((item: Json) => item.id === manualId).properties.fontSize,
      { timeout: 30_000 }).toBe(52);
    expect(captions(await load()).filter((item: Json) => item.id !== manualId)
      .every((item: Json) => item.properties.fontSize !== 52)).toBeTruthy();

    // 17-18. AI global colour: all captions change; the manual wording AND the selected size survive.
    await askAi('make all captions yellow');
    canonical = await load();
    expect(captions(canonical).every((item: Json) => /^#ffd/iu.test(String(item.properties.color)))).toBeTruthy();
    const manual = captions(canonical).find((item: Json) => item.id === manualId);
    expect(manual.properties.content).toBe(manualText);
    expect(manual.properties.fontSize).toBe(52);

    // 20. Global caption size from the Inspector: a global write of the same property wins.
    await page.getByRole('tab', { name: 'Inspector' }).click();
    await page.getByLabel('Caption style scope').selectOption('TRACK');
    await page.getByLabel('Font size').fill('36');
    await page.getByLabel('Font size').press('Tab');
    await expect.poll(async () => captions(await load()).every((item: Json) => item.properties.fontSize === 36),
      { timeout: 30_000 }).toBe(true);
    expect(captions(await load()).find((item: Json) => item.id === manualId).properties.content).toBe(manualText);

    // 21. Whole-clip crop tool: preview first, then one atomic Apply across every cut.
    const trimsBefore = JSON.stringify(segments(await load()).map((item: Json) => [item.trimStart, item.trimEnd]));
    await page.getByTestId('timeline-track-VIDEO').getByTestId('timeline-block').first().click();
    await page.getByRole('button', { name: 'Crop', exact: true }).click();
    await page.getByRole('group', { name: 'Crop aspect ratio' }).getByRole('button', { name: '9:16' }).click();
    await page.getByRole('group', { name: 'Crop fit mode' }).getByRole('button', { name: 'Fill' }).click();
    await page.getByLabel('Entire clip').check();
    const revisionBeforeCrop = (await load()).revision;
    await page.getByRole('button', { name: 'Apply crop' }).click();
    await expect.poll(async () => segments(await load()).every((item: Json) => item.properties.frameLayout === 'FILL'),
      { timeout: 30_000 }).toBe(true);
    expect((await load()).revision).toBe(revisionBeforeCrop + 1);
    expect(JSON.stringify(segments(await load()).map((item: Json) => [item.trimStart, item.trimEnd]))).toBe(trimsBefore);

    // 22. Zoom at the playhead, via the AI editor (rules path).
    const zoomsBefore = (await load()).elements.filter((item: Json) => item.type === 'EFFECT').length;
    await askAi('add a zoom here');
    expect((await load()).elements.filter((item: Json) => item.type === 'EFFECT').length).toBe(zoomsBefore + 1);

    // 23. Source audio (this clip has no music track, so the video's own audio).
    await askAi('lower the video audio to 80%');
    expect(segments(await load()).every((item: Json) => Math.abs(Number(item.properties.sourceVolume) - 0.8) < 0.01)).toBeTruthy();

    // 24. Semantic boundary: extend the end to the end of the next sentence (keeps internal cuts).
    const endBefore = Math.max(...segments(await load()).map((item: Json) => Number(item.trimEnd)));
    await askAi('end after the next sentence');
    await expect(ledger).not.toContainText(/Failed|not verified/);
    expect(Math.max(...segments(await load()).map((item: Json) => Number(item.trimEnd)))).toBeGreaterThan(endBefore);
    expect(captions(await load()).find((item: Json) => item.id === manualId)?.properties.content).toBe(manualText);

    // 25-26. Undo / redo from the editor's own controls.
    const fingerprint = (project: Json) => JSON.stringify(project.elements.map((item: Json) =>
      [item.id, item.trimStart, item.trimEnd, item.duration]).sort());
    const beforeUndo = await load();
    await page.getByRole('banner').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => fingerprint(await load()), { timeout: 30_000 }).not.toBe(fingerprint(beforeUndo));
    await page.getByRole('banner').getByRole('button', { name: 'Redo' }).click();
    await expect.poll(async () => fingerprint(await load()), { timeout: 30_000 }).toBe(fingerprint(beforeUndo));
    const beforeReload = await load();

    // 27-28. Reload: the canonical state persisted.
    await page.reload();
    await expect(page.getByRole('banner').getByRole('button', { name: 'Undo' })).toBeVisible({ timeout: 60_000 });
    canonical = await load();
    expect(fingerprint(canonical)).toBe(fingerprint(beforeReload));
    expect(JSON.stringify(subtitleState(canonical))).toBe(JSON.stringify(subtitleState(beforeReload)));
    expect(afterAi.length).toBeGreaterThan(0);

    // 26-27. Export the edited project from the editor and inspect the media.
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: 'Export video' }).click();
    const exported = await waitUntil(() => getJson(request, `/edit-mode/projects/${target.editProjectId}/exports`),
      (list) => Array.isArray(list) && list.some((item: Json) => item.current), 20 * 60 * 1000, 5000) as unknown as Json[];
    const current = exported.find((item) => item.current)!;
    expect(current.sourceRevision).toBe(canonical.revision);
    const bytes = Buffer.from(await (await request.get(`${API}/edit-mode/assets/${current.id}/file`)).body());
    const media = probe(bytes, work, 'edited.mp4');
    expect(media.width).toBe(1080);
    expect(media.height).toBe(1920);
    expect(media.audio).toBeTruthy();
    expect(media.duration).toBeGreaterThan(3);
    const timelineSec = Math.max(...segments(canonical).map((item: Json) => item.startTime + item.duration));
    expect(Math.abs(media.duration - timelineSec)).toBeLessThan(0.5);

    // 30. The generated clip itself is untouched by editing.
    const generatedAfter = await request.get(`${API}${target.playbackUrl}`);
    expect(generatedAfter.ok()).toBeTruthy();
    expect(probe(Buffer.from(await generatedAfter.body()), work, 'generated.mp4').duration).toBeCloseTo(target.durationSec, 0);

    // 31-32. Back to the results; Edit on the same card reopens the SAME canonical project.
    await page.goto(`/projects/${project.id}`);
    await expect(cards).toHaveCount(results.clips.length, { timeout: 60_000 });
    await cards.last().getByRole('button', { name: 'Edit' }).click();
    await page.waitForURL(new RegExp(`/edit-mode/${target.editProjectId}$`), { timeout: 120_000 });
  } finally {
    if (videoId) {
      const linked = await getJson(request, `/videos/${videoId}/clip-results`).catch(() => ({ clips: [] }));
      for (const clip of linked.clips ?? []) {
        if (clip.editProjectId) await request.delete(`${API}/edit-mode/projects/${clip.editProjectId}`).catch(() => undefined);
      }
      await request.delete(`${API}/videos/${videoId}`).catch(() => undefined);
    }
    // There is no project DELETE endpoint; remove the (now empty) disposable row directly.
    try {
      execFileSync('docker', ['exec', 'ai-content-postgres', 'psql', '-U', 'postgres', '-d', 'ai_content_platform',
        '-c', `DELETE FROM "Project" WHERE id = '${String(project.id).replace(/[^0-9a-f-]/giu, '')}'`]);
    } catch { /* best effort */ }
    rmSync(work, { recursive: true, force: true });
  }
});
