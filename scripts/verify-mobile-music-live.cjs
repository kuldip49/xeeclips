// Real HTTPS/browser acceptance using only generated tones, a test pattern and
// exactly two disposable accounts. No user clips, credentials or AI service.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'storage', 'mobile-music-release');
const privatePath = path.join(folder, 'qa-private.json');
const api = 'https://api.xeeclip.me', origin = 'https://xeeclip.me';
const save = (file, value) => fs.writeFileSync(path.join(folder, file), JSON.stringify(value, null, 2));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, state;
async function call(context, url, method = 'GET', data, multipart) {
  const response = await context.request.fetch(api + url, { method, headers: { Origin: origin },
    ...(data ? { data } : {}), ...(multipart ? { multipart } : {}), timeout: 60_000 });
  return { status: response.status(), body: await response.json().catch(() => null), response };
}
async function good(...args) {
  const result = await call(...args);
  assert(result.status < 400, `${args[1]}: HTTP ${result.status} ${result.body?.message ?? ''}`);
  return result.body;
}
async function main() {
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  if (process.argv.includes('--baseline')) {
    assert(!fs.existsSync(privatePath), 'Clean up the previous exact QA accounts first');
    state = { prefix: `security-${Date.now()}`, contexts: {} };
    for (const key of ['a', 'b']) {
      const context = await browser.newContext();
      const email = `${state.prefix}-${key}@example.com`;
      const user = await good(context, '/auth/signup', 'POST', { email,
        password: randomBytes(24).toString('base64url'), displayName: 'Disposable music QA' });
      state[`${key}Id`] = user.id; state[`${key}Email`] = email;
      state.contexts[key] = await context.storageState(); save('qa-private.json', state);
      if (key === 'a') {
        let project = await good(context, '/edit-mode/projects', 'POST', { name: 'Disposable phone music regression' });
        state.projectId = project.id; save('qa-private.json', state);
        const music = path.join(folder, 'tone.mp3'), video = path.join(folder, 'source.mp4');
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=8', '-q:a', '2', music]);
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=240x426:rate=30:duration=10', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video]);
        project = await good(context, `/edit-mode/projects/${project.id}/source/upload`, 'POST', undefined,
          { revision: String(project.revision), file: { name: 'synthetic-source.mp4', mimeType: 'video/mp4', buffer: fs.readFileSync(video) } });
        const broken = await call(context, `/edit-mode/projects/${project.id}/assets/upload`, 'POST', undefined,
          { revision: String(project.revision), role: 'AUDIO', file: { name: 'phone.mp3', mimeType: 'application/octet-stream', buffer: fs.readFileSync(music) } });
        assert.equal(broken.status, 400); assert.match(broken.body.message, /Unsupported audio MIME type or extension/);
        save('baseline-reproduction.json', { status: broken.status, error: broken.body.message });
      }
      await context.close();
    }
    console.log('PASS: exact mobile MP3 rejection reproduced over the live HTTPS API.');
  } else {
    state = JSON.parse(fs.readFileSync(privatePath, 'utf8'));
    const a = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: state.contexts.a });
    const b = await browser.newContext({ storageState: state.contexts.b });
    if (process.argv.includes('--cleanup')) {
      for (const key of ['a', 'b']) {
        const context = key === 'a' ? a : b;
        const user = await good(context, '/auth/session');
        assert.equal(user.id, state[`${key}Id`]); assert.equal(user.email, state[`${key}Email`]); assert.equal(user.role, 'USER');
        for (const project of await good(context, '/edit-mode/projects')) await good(context, `/edit-mode/projects/${project.id}`, 'DELETE');
        await good(context, '/auth/logout', 'POST', {});
      }
      const manifest = Object.fromEntries(['prefix', 'aId', 'bId', 'aEmail', 'bEmail'].map(key => [key, state[key]]));
      execFileSync('docker', ['exec', '-i', 'ai-content-backend', 'node', 'scripts/cleanup-auth-acceptance.cjs', '--apply'],
        { cwd: root, input: JSON.stringify(manifest), encoding: 'utf8' });
      const code = fs.readFileSync(path.join(__dirname, 'mobile-music-runtime-state.cjs'), 'utf8');
      const after = JSON.parse(execFileSync('docker', ['exec', 'ai-content-backend', 'node', '-e', code], { encoding: 'utf8' }));
      const before = JSON.parse(fs.readFileSync(path.join(folder, 'before.json'), 'utf8'));
      assert.deepEqual(after.fingerprints, before.fingerprints); assert(after.idle);
      save('cleanup.json', { accountsRemoved: 2, assetsRemoved: true, originalRecordsPreserved: true });
      fs.unlinkSync(privatePath);
      console.log('PASS: disposable content/accounts removed; every original data fingerprint preserved.');
    } else if (process.argv.includes('--verify')) {
      const existing = await good(a, `/edit-mode/projects/${state.projectId}`);
      if (existing.assets.some(asset => asset.role === 'AUDIO')) {
        assert.equal(existing.name, 'Disposable phone music regression');
        await good(a, `/edit-mode/projects/${state.projectId}`, 'DELETE');
        let fresh = await good(a, '/edit-mode/projects', 'POST', { name: 'Disposable phone music regression' });
        state.projectId = fresh.id; save('qa-private.json', state);
        fresh = await good(a, `/edit-mode/projects/${fresh.id}/source/upload`, 'POST', undefined,
          { revision: String(fresh.revision), file: { name: 'synthetic-source.mp4', mimeType: 'video/mp4', buffer: fs.readFileSync(path.join(folder, 'source.mp4')) } });
      }
      assert.equal((await call(b, `/edit-mode/projects/${state.projectId}`)).status, 404);
      const page = await a.newPage(); const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/edit-mode/${state.projectId}`);
      await expect.poll(() => page.getByTestId('edit-preview-video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
      await page.getByLabel('Seek edited timeline').fill('0');
      await page.getByRole('button', { name: 'Media', exact: true }).click();
      const started = Date.now();
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: '+ Music', exact: true }).click();
      await (await chooser).setFiles({ name: 'phone-music.MP3', mimeType: 'application/octet-stream', buffer: fs.readFileSync(path.join(folder, 'tone.mp3')) });
      const audio = page.getByTestId('edit-preview-audio');
      await expect(audio).toHaveCount(1); await expect(page.getByRole('button', { name: '+ Music', exact: true })).toBeEnabled();
      const uploadMs = Date.now() - started;
      await expect(page.getByRole('alert').filter({ hasText: /Unsupported|failed/i })).toHaveCount(0);
      await page.getByRole('button', { name: 'Close Media', exact: true }).click();
      await page.getByRole('button', { name: 'Play preview' }).click();
      await expect.poll(() => audio.evaluate(node => !node.paused && node.currentTime > 0.1)).toBe(true);
      await page.getByRole('button', { name: 'Pause preview' }).click();
      await page.getByRole('button', { name: 'Audio', exact: true }).click();
      await page.getByRole('button', { name: 'Mute', exact: true }).click();
      await expect.poll(() => audio.evaluate(node => node.muted)).toBe(true);
      await page.getByRole('button', { name: 'Muted', exact: true }).click();
      await expect.poll(() => audio.evaluate(node => node.muted)).toBe(false);
      await page.reload(); await expect(audio).toHaveCount(1);
      let project = await good(a, `/edit-mode/projects/${state.projectId}`);
      const asset = project.assets.find(item => item.role === 'AUDIO'); assert.equal(asset.mimeType, 'audio/mpeg');
      const range = await a.request.get(`${api}/edit-mode/assets/${asset.id}/file`, { headers: { Origin: origin, Range: 'bytes=0-99' } });
      assert.equal(range.status(), 206); assert.match(range.headers()['content-type'], /audio\/mpeg/);
      const corrupt = await call(a, `/edit-mode/projects/${project.id}/assets/upload`, 'POST', undefined,
        { revision: String(project.revision), role: 'AUDIO', file: { name: 'corrupt.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('not music') } });
      assert.equal(corrupt.status, 400);
      const exported = await good(a, `/edit-mode/projects/${project.id}/export`, 'POST', { revision: project.revision, resolution: 720 });
      let progress;
      for (let i = 0; i < 90; i++) {
        progress = await good(a, `/edit-mode/projects/${project.id}/export/progress`);
        if (['COMPLETED', 'FAILED', 'COMPLETE'].includes(progress?.phase)) break;
        await pause(1000);
      }
      assert.notEqual(progress?.phase, 'FAILED');
      const exports = await good(a, `/edit-mode/projects/${project.id}/exports`);
      assert(exports.length > 0, 'Live music export completed'); assert.deepEqual(errors, []);
      const output = await a.request.get(`${api}/edit-mode/assets/${exports[0].id}/file`, { headers: { Origin: origin } });
      assert.equal(output.status(), 200);
      const exportFile = path.join(folder, 'synthetic-music-export.mp4');
      fs.writeFileSync(exportFile, await output.body());
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', exportFile], { encoding: 'utf8' }));
      assert(probe.streams.some(stream => stream.codec_type === 'audio'), 'Export contains music');
      execFileSync('ffmpeg', ['-v', 'error', '-i', exportFile, '-t', '3', '-vn', '-f', 'f32le', path.join(folder, 'export-audio.f32'), '-y']);
      const samples = fs.readFileSync(path.join(folder, 'export-audio.f32'));
      let energy = 0;
      for (let i = 0; i + 4 <= samples.length; i += 4) energy += samples.readFloatLE(i) ** 2;
      assert(Math.sqrt(energy / (samples.length / 4)) > 0.001, 'Export music has audible signal');
      await page.screenshot({ path: path.join(folder, 'phone-music.png') });
      save('acceptance.json', { passed: true, uploadMs, bytes: fs.statSync(path.join(folder, 'tone.mp3')).size,
        playback: true, reload: true, controls: true, correctMime: true, ranges: 206, corruptRejected: 400,
        crossAccountDenied: 404, export: true, exportResponse: exported?.status ?? null });
      console.log(`PASS: real phone HTTPS upload (${uploadMs} ms), playback, controls, reload, range streaming, invalid-file rejection, ownership and export.`);
    } else throw Error('Choose --baseline, --verify or --cleanup');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
