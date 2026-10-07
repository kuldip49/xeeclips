import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Live preview/export parity for manual edits on a StyleOne hook (E2E_REFRAME_SOURCE = owned video).
 * Hook text colour and per-word colours are changed through the real inspector; size, background and
 * position through canonical commands. The editor preview is then compared with a frame of the rendered
 * MP4: the hook's position, size and colours must match. The session is deleted afterwards.
 */
const source = process.env.E2E_REFRAME_SOURCE;
const api = process.env.E2E_API_URL ?? 'http://localhost:4000';
const out = process.env.PARITY_DIR ?? mkdtempSync(join(tmpdir(), 'qr-parity-'));
const created: string[] = [];
test.describe.configure({ timeout: 20 * 60 * 1000 });
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
async function styleOneSession(request: APIRequestContext) {
  const s = await croppedSession(request, '1:1', (w, h) => ({ x: .05, y: .3, w: .9, h: .9 * w / h }));
  await request.post(`${api}/quick-reframe/${s.id}/styleone`, { data: { revision: s.revision } }); return wait(request, s.id);
}
async function croppedSession(request: APIRequestContext, aspect: string, box: (w: number, h: number) => object) {
  let s = await (await request.post(`${api}/quick-reframe`)).json(); created.push(s.id);
  const file = readFileSync(source!);
  const u = await (await request.post(`${api}/quick-reframe/${s.id}/upload`, { data: { name: 'parity.mp4', size: file.length, mimeType: 'video/mp4' } })).json();
  for (let i = 0; i < u.chunks; i++) await request.put(`${api}/quick-reframe/uploads/${u.id}/chunks/${i}`, { headers: { 'content-type': 'application/octet-stream' }, data: file.subarray(i * u.chunkBytes, (i + 1) * u.chunkBytes) });
  await request.post(`${api}/quick-reframe/uploads/${u.id}/complete`);
  await request.post(`${api}/quick-reframe/${s.id}/playback`); s = await wait(request, s.id);
  s = await (await request.put(`${api}/quick-reframe/${s.id}/plan`, { data: { revision: s.revision, plan: { ...s.plan, aspect, crop: box(s.width, s.height) } } })).json();
  await request.post(`${api}/quick-reframe/${s.id}/confirm-crop`, { data: { revision: s.revision } }); return wait(request, s.id);
}
const project = async (request: APIRequestContext, s: { editProjectId: string }) => (await request.get(`${api}/edit-mode/projects/${s.editProjectId}`)).json();
const command = async (request: APIRequestContext, p: { id: string; revision: number }, action: string, body: object) => {
  const r = await request.post(`${api}/edit-mode/projects/${p.id}/commands/${action}`, { data: { revision: p.revision, ...body } });
  expect(r.ok(), await r.text()).toBeTruthy(); return r.json();
};
/** Raw RGB of an image or video frame at a given size (ffmpeg does the decoding and scaling). */
const rgb = (file: string, w: number, h: number, t?: number) => execFileSync('ffmpeg', ['-v', 'error', ...(t === undefined ? [] : ['-ss', String(t)]), '-i', file,
  '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=area,format=rgb24`, '-f', 'rawvideo', '-'], { maxBuffer: 64 << 20 });
type Hit = (px: Buffer, i: number) => boolean;
const near = (c: number[], tol: number): Hit => (px, i) => Math.abs(px[i] - c[0]) + Math.abs(px[i + 1] - c[1]) + Math.abs(px[i + 2] - c[2]) < tol;
const cyan: Hit = (px, i) => px[i] < 110 && px[i + 1] > 160 && px[i + 2] > 190;
/**
 * Editor screenshot vs export frame at the export's own size: the bounding box of what each colour covers
 * must agree within 2.5% of the frame width (one editor-screenshot pixel is ~4 export pixels here).
 */
function compare(editorPng: string, mp4: string, EW: number, EH: number, t: number, checks: Array<[string, Hit]>) {
  const editor = rgb(editorPng, EW, EH), exported = rgb(mp4, EW, EH, t);
  const bounds = (px: Buffer, hit: Hit) => {
    let x0 = EW, x1 = -1, y0 = EH, y1 = -1, n = 0;
    for (let y = 0; y < EH; y += 2) for (let x = 0; x < EW; x += 2) if (hit(px, (y * EW + x) * 3)) { n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { x0, x1, y0, y1, n };
  };
  const report: Record<string, unknown> = {}; const tol = Math.round(EW * 0.025); const problems: string[] = [];
  for (const [name, hit] of checks) {
    const a = bounds(editor, hit), b = bounds(exported, hit); report[name] = { editor: a, export: b };
    if (a.n <= 10 || b.n <= 10) { problems.push(`${name} missing (editor ${a.n}, export ${b.n})`); continue; }
    for (const k of ['x0', 'x1', 'y0', 'y1'] as const) if (Math.abs(a[k] - b[k]) > tol) problems.push(`${name} ${k}: editor ${a[k]} vs export ${b[k]}`);
    // Glyph size, not only placement: the drawn height must agree within 10%.
    const ha = a.y1 - a.y0, hb = b.y1 - b.y0;
    if (Math.abs(ha / Math.max(1, hb) - 1) > 0.1) problems.push(`${name} height: editor ${ha} vs export ${hb}`);
  }
  console.log('PARITY-REPORT', JSON.stringify(report));
  expect(problems, JSON.stringify(report)).toEqual([]);
  return report;
}
async function editorShot(page: Page, s: { editProjectId: string }, name: string, hookId: string) {
  await page.goto(`/edit-mode/${s.editProjectId}`);
  const canvas = page.getByTestId('edit-preview-canvas'); await expect(canvas).toBeVisible({ timeout: 60000 });
  await page.waitForLoadState('networkidle'); await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
  await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(1500);
  // Focus view must still show every exported element: the moved hook stays inside the visible stage.
  const stage = (await page.getByTestId('edit-preview-stage').boundingBox())!;
  await expect(page.locator(`[data-testid="preview-element"][data-element-id="${hookId}"]`)).toBeVisible();
  const hookBox = (await page.locator(`[data-testid="preview-element"][data-element-id="${hookId}"]`).boundingBox())!;
  expect(hookBox.y, 'hook visible in Focus view').toBeGreaterThanOrEqual(stage.y - 1);
  expect(hookBox.y + hookBox.height, 'hook visible in Focus view').toBeLessThanOrEqual(stage.y + stage.height + 1);
  await page.screenshot({ path: join(out, `${name}-editor-focus.png`) });
  // Compare the whole export frame.
  const fit = page.getByTitle('Show the whole export frame');
  if (await fit.count()) { await fit.click(); await page.waitForTimeout(800); }
  const path = join(out, `${name}-editor.png`); await canvas.screenshot({ path }); return { path, box: (await canvas.boundingBox())! };
}

test('StyleOne hook: text colour and word colours change, and the export matches the editor', async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 1800 });
  let s = await styleOneSession(request);
  let p = await project(request, s);
  const hook = p.elements.find((e: { type: string; properties: { presetRole?: string } }) => e.type === 'TEXT' && e.properties.presetRole === 'HOOK');
  expect(hook, 'StyleOne hook').toBeTruthy();
  expect(hook.properties.textRuns?.length, 'StyleOne hook has emphasis runs').toBeGreaterThan(1);
  const emphasis = hook.properties.textRuns.find((r: { color: string }) => r.color.toLowerCase() !== '#ffffff').color.toLowerCase();

  // Text colour through the real inspector: select the hook in the preview, open Style, pick a colour.
  await page.goto(`/edit-mode/${s.editProjectId}`);
  await page.waitForLoadState('networkidle'); await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
  await page.locator(`[data-testid="preview-element"][data-element-id="${hook.id}"]`).click();
  const colour = page.getByLabel('Text colour', { exact: true }); await expect(colour).toBeVisible({ timeout: 30000 });
  await colour.fill('#00e5ff'); await colour.blur();
  await expect.poll(async () => (await project(request, s)).elements.find((e: { id: string }) => e.id === hook.id).properties.color, { timeout: 20000 }).toBe('#00e5ff');
  p = await project(request, s); let h = p.elements.find((e: { id: string }) => e.id === hook.id);
  expect(h.properties.textRuns.some((r: { color: string }) => r.color === '#00e5ff'), 'base words follow the new colour').toBeTruthy();
  expect(h.properties.textRuns.some((r: { color: string }) => r.color.toLowerCase() === emphasis), 'emphasised word keeps its colour').toBeTruthy();
  // Word colours: pick the first word, colour it yellow.
  await page.getByRole('group', { name: 'Words' }).getByRole('button').first().click();
  const wordColour = page.getByLabel('Colour for selected words', { exact: true }); await wordColour.fill('#ffd400');
  await page.getByRole('button', { name: 'Colour selected' }).click();
  await expect.poll(async () => (await project(request, s)).elements.find((e: { id: string }) => e.id === hook.id).properties.textRuns[0].color, { timeout: 20000 }).toBe('#ffd400');
  // Size, background plate and position by canonical commands.
  p = await project(request, s);
  p = await command(request, p, 'set-text-size', { elementId: hook.id, fontSize: 44 });
  p = await command(request, p, 'move-element', { elementId: hook.id, x: hook.properties.x, y: 0.12 });
  p = await command(request, p, 'set-text-background', { elementId: hook.id, backgroundEnabled: true, backgroundColor: '#7a00ff', backgroundOpacity: 1, backgroundPadding: 10, backgroundRadius: 0 });
  h = p.elements.find((e: { id: string }) => e.id === hook.id);
  writeFileSync(join(out, 'hook.json'), JSON.stringify(h.properties, null, 2));

  // Editor preview vs the rendered MP4 at the same size.
  const shot = await editorShot(page, s, 'styleone', hook.id);
  const W = Math.round(shot.box.width), H = Math.round(shot.box.height);
  s = await (await request.get(`${api}/quick-reframe/${s.id}`)).json();
  await request.post(`${api}/quick-reframe/${s.id}/export`, { data: { revision: p.revision, resolution: 1080 } }); s = await wait(request, s.id);
  const mp4 = join(out, 'styleone-export.mp4'); writeFileSync(mp4, Buffer.from(await (await request.get(`${api}${s.exports[0].url}`)).body()));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '0.5', '-i', mp4, '-frames:v', '1', '-vf', `scale=${W}:${H}:flags=area`, join(out, 'styleone-export.png')]);
  const report = compare(shot.path, mp4, 1080, 1920, 0.5, [['purple plate', near([122, 0, 255], 90)], ['cyan text', cyan],
    // The yellow word is looked for above StyleOne's media window only (the video has a moving orange box).
    ['yellow word', (px, i) => i < 600 * 1080 * 3 && px[i] > 200 && px[i + 1] > 170 && px[i + 2] < 90 && px[i + 1] < 235], ['video window', near([31, 59, 92], 40)]]);
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log('PARITY', out, JSON.stringify(report));
});

test('Manual: hook colour through the inspector, plate and captions export exactly where the editor shows them', async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 1800 });
  let s = await croppedSession(request, '4:5', (w, h) => ({ x: .2, y: .25, w: .5, h: .5 * w * 5 / 4 / h }));
  await request.post(`${api}/quick-reframe/${s.id}/path`, { data: { revision: s.revision, path: 'MANUAL' } }); s = await wait(request, s.id);
  let p = await project(request, s);
  p = await command(request, p, 'add-text', { textStyleId: 'HOOK', content: 'Cut the subscriptions you forgot', origin: 'USER', presetRole: 'HOOK', fontSize: 52, height: 0.2 });
  const hook = p.elements.find((e: { type: string }) => e.type === 'TEXT');
  p = await command(request, p, 'move-element', { elementId: hook.id, x: hook.properties.x, y: 0.04 });
  p = await command(request, p, 'generate-captions', {});
  p = await command(request, p, 'set-text-background', { elementId: hook.id, backgroundEnabled: true, backgroundColor: '#7a00ff', backgroundOpacity: 1, backgroundPadding: 10, backgroundRadius: 0 });
  // Text colour through the real inspector.
  await page.goto(`/edit-mode/${s.editProjectId}`);
  await page.waitForLoadState('networkidle'); await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
  await page.locator(`[data-testid="preview-element"][data-element-id="${hook.id}"]`).click();
  const colour = page.getByLabel('Text colour', { exact: true }); await expect(colour).toBeVisible({ timeout: 30000 });
  await colour.fill('#00e5ff'); await colour.blur();
  await expect.poll(async () => (await project(request, s)).elements.find((e: { id: string }) => e.id === hook.id).properties.color, { timeout: 20000 }).toBe('#00e5ff');
  p = await project(request, s);
  const shot = await editorShot(page, s, 'manual', hook.id);
  s = await (await request.get(`${api}/quick-reframe/${s.id}`)).json();
  await request.post(`${api}/quick-reframe/${s.id}/export`, { data: { revision: p.revision, resolution: 1080 } }); s = await wait(request, s.id);
  const mp4 = join(out, 'manual-export.mp4'); writeFileSync(mp4, Buffer.from(await (await request.get(`${api}${s.exports[0].url}`)).body()));
  const width = s.exports[0].width, height = s.exports[0].height;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '0.5', '-i', mp4, '-frames:v', '1', join(out, 'manual-export.png')]);
  // Captions: white glyphs in the lower half (the creator handle is outside this crop).
  const white: Hit = (px, i) => i > Math.floor(height * 0.5) * width * 3 && px[i] > 235 && px[i + 1] > 235 && px[i + 2] > 235;
  const report = compare(shot.path, mp4, width, height, 0.5, [['purple plate', near([122, 0, 255], 90)], ['cyan text', cyan], ['caption text', white]]);
  writeFileSync(join(out, 'manual-report.json'), JSON.stringify(report, null, 2));
  console.log('PARITY-MANUAL', JSON.stringify(report));
});
