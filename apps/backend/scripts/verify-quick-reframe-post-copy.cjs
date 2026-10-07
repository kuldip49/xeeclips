/** Live media + copy verification. Requires a fresh isolated reframe_post_copy_test database (never production). */
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { socialSource, socialPostContext } = require('../dist/modules/quick-reframe/social-source');
const base = 'http://127.0.0.1:4000', origin = process.env.FRONTEND_ORIGIN.split(',')[0];
let cookie = '', otherCookie = '', userId, db, created = [];
async function api(path, method = 'GET', body, ownCookie = cookie, expected = 200) {
  const r = await fetch(base + path, { method, headers: { Origin: origin, ...(ownCookie ? { Cookie: ownCookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({})); assert.equal(r.status, expected, `${method} ${path}: ${JSON.stringify(data)}`); return { data, cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
const qr = async (id, suffix = '', method = 'GET', body, expected = 200) => (await api(`/quick-reframe/${id}${suffix}`, method, body, cookie, expected)).data;
const active = ['PLAYBACK', 'ANALYZE', 'PREPARE', 'PREVIEW', 'EXPORT', 'IMPORT'];
async function wait(id) {
  const start = Date.now(); for (;;) { const s = await qr(id); if (s.status === 'FAILED') throw new Error(s.error); if (!active.includes(s.status)) return s;
    if (Date.now() - start > 600000) throw new Error('Verification timed out'); await new Promise(r => setTimeout(r, 1000)); }
}
async function upload(path) {
  const file = readFileSync(path), s = (await api('/quick-reframe', 'POST', {}, cookie, 201)).data; created.push(s.id);
  const u = await qr(s.id, '/upload', 'POST', { name: path.split('/').at(-1), mimeType: 'video/mp4', size: file.length }, 201);
  for (let i = 0; i < u.chunks; i++) { const r = await fetch(`${base}/quick-reframe/uploads/${u.id}/chunks/${i}`, { method: 'PUT', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: file.subarray(i * u.chunkBytes, (i + 1) * u.chunkBytes) }); assert.equal(r.status, 200); }
  await api(`/quick-reframe/uploads/${u.id}/complete`, 'POST', {}, cookie, 201); return s;
}
async function removeDisposableAccounts() {
  const disposable = await db.user.findMany({ where: { email: { in: ['copy-user@example.com', 'copy-other@example.com'] } }, select: { id: true } });
  const ids = disposable.map(u => u.id);
  await db.creditReservation.deleteMany({ where: { userId: { in: ids } } });
  await db.creditTransaction.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}
async function main() {
  if (!new URL(process.env.DATABASE_URL).pathname.includes('reframe_post_copy_test_')) throw new Error('Only a disposable reframe_post_copy_test_ database is allowed.');
  db = new PrismaClient();
  await removeDisposableAccounts();
  const password = randomBytes(24).toString('base64url');
  const signup = await api('/auth/signup', 'POST', { email: 'copy-user@example.com', password, displayName: 'Disposable Copy QA' }, '', 201);
  cookie = signup.cookie; userId = signup.data.id;
  otherCookie = (await api('/auth/signup', 'POST', { email: 'copy-other@example.com', password }, '', 201)).cookie;
  await api('/auth/preferences', 'PATCH', { aiProcessingConsent: true });
  for (const burned of [false, true]) {
    const path = `/tmp/copy-${burned ? 'subtitles' : 'headline'}.mp4`;
    const font = '/usr/share/fonts/noto/NotoSans-Regular.ttf';
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x203020:s=480x640:r=24:d=6', '-vf',
      `drawtext=fontfile=${font}:text='Healthy soil helps plants grow':fontcolor=white:fontsize=22:x=(w-tw)/2:y=h*${burned ? '.76' : '.12'}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path]);
    let s = await upload(path);
    assert.equal(s.analysis, null);
    const make = () => ({ revision: s.revision, version: s.postCopy.version, externalAiAuthorized: false });
    await qr(s.id, '/post-copy', 'POST', make(), 400);
    await qr(s.id, '/playback', 'POST', {}, 201); s = await wait(s.id);
    assert.equal(s.analysis, null, 'playback/crop does not analyze');
    await qr(s.id, '/confirm-crop', 'POST', { revision: s.revision }, 201); s = await wait(s.id);
    assert.equal(s.analysis, null, 'Done Cropping alone does not analyze');
    await qr(s.id, '/post-copy', 'POST', make(), 400);
    // Import adapter fixture uses public/disposable post text. No platform credentials/protection bypass.
    if (!burned) await db.quickReframe.update({ where: { id: s.id }, data: { sourceContext: socialPostContext({ description: 'Gardening tips for healthy soil. #Soil #Gardening', uploader: 'Disposable fixture', title: 'Healthy garden', url: 'DO_NOT_EXPOSE' }, socialSource('https://x.com/disposable/status/123')) } });
    await qr(s.id, burned ? '/path' : '/styleone', 'POST', burned ? { revision: s.revision, path: 'MANUAL' } : { revision: s.revision }, 201); s = await wait(s.id);
    assert.ok(s.analysis, 'analysis only after mode');
    assert.equal(s.analysis.subtitleState, burned ? 'EXISTING_READABLE' : 'MISSING');
    assert.equal(s.captionCount, 0, 'burned-in subtitles are never duplicated');
    const before = (await api(`/edit-mode/projects/${s.editProjectId}`)).data;
    const generated = await qr(s.id, '/post-copy', 'POST', make(), 201); s = generated.session;
    assert.equal(s.postCopy.generatedCaptions.length, 5, JSON.stringify(generated));
    assert.ok(s.postCopy.generatedCaptions.every(c => /soil|plants/u.test(c.text)));
    assert.equal(s.postCopy.generatedHashtagSets.length, 3);
    assert.ok(!JSON.stringify(s).includes('DO_NOT_EXPOSE'));
    const edited = 'Healthy soil, stronger roots. My final post copy.';
    s = await qr(s.id, '/post-copy', 'PUT', { ...make(), selectedCaption: edited, selectedHashtags: ['#Soil', '#Plants'] });
    const restored = await qr(s.id); assert.equal(restored.postCopy.selectedCaption, edited);
    const after = (await api(`/edit-mode/projects/${s.editProjectId}`)).data;
    assert.equal(after.revision, before.revision); assert.deepEqual(after.elements, before.elements, 'social copy never becomes video text/subtitles');
    await qr(s.id, '/post-copy', 'PUT', { revision: s.revision, version: 0, selectedCaption: 'stale', selectedHashtags: [] }, 409);
    await api(`/quick-reframe/${s.id}/post-copy`, 'PUT', { ...make(), selectedCaption: 'other account', selectedHashtags: [] }, otherCookie, 404);
    await api(`/quick-reframe/${s.id}/post-copy`, 'POST', { ...make(), externalAiAuthorized: true }, otherCookie, 403);
    if (!burned) { s = (await qr(s.id, '/post-copy', 'POST', { ...make(), rewrite: 'Cleaner CTA' }, 201)).session; assert.equal(s.postCopy.selectedCaption, edited); }
    await qr(s.id, '/export', 'POST', { revision: s.revision, resolution: 720 }, 201); s = await wait(s.id);
    assert.ok(s.exports[0]?.current);
    const download = await fetch(base + s.exports[0].url, { headers: { Cookie: cookie } }); assert.equal(download.status, 200);
    const out = `/tmp/copy-${burned}.export.mp4`; writeFileSync(out, Buffer.from(await download.arrayBuffer()));
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', out], { encoding: 'utf8' }));
    assert.equal(probe.streams[0].codec_name, 'h264'); assert.ok(Math.abs(Number(probe.format.duration) - 6) < .2);
    const history = (await api('/quick-reframe/history')).data; const saved = history.find(v => v.id === s.id); assert.equal(saved.postCopy.selectedCaption, edited); assert.deepEqual(saved.postCopy.selectedHashtags, ['#Soil', '#Plants']);
    console.log(`PASS ${burned ? 'Manual + existing readable subtitles' : 'StyleOne + missing subtitles + imported X context'}: actual OCR, 5 captions, hashtags, editing, History, ownership, unchanged composition and H.264 export`);
    await qr(s.id, '', 'DELETE'); created = created.filter(id => id !== s.id);
  }
  assert.equal((await api('/auth/session')).data.creditBalance, 3, 'copy generation is free; exactly two video exports consume credits');
  console.log('Live Quick Reframe post copy verification passed. All disposable media sessions removed.');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  for (const id of created) await qr(id, '', 'DELETE').catch(() => {});
  if (db) {
    await removeDisposableAccounts(); await db.$disconnect();
  }
});
