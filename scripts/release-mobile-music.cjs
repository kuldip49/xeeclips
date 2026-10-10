// --preflight creates/restores a backup; --deploy replaces only the API image.
// All runtime credentials stay in ignored local artifacts and are never printed.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'storage', 'mobile-music-release');
fs.mkdirSync(folder, { recursive: true });
const run = args => execFileSync('docker', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const save = (name, data) => fs.writeFileSync(path.join(folder, name), JSON.stringify(data, null, 2));
const stateCode = fs.readFileSync(path.join(__dirname, 'mobile-music-runtime-state.cjs'), 'utf8');
const state = () => JSON.parse(run(['exec', 'ai-content-backend', 'node', '-e', stateCode]));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const baselineId = 'sha256:bdd5dcbc97eabbe41dd6fa9538abde850baff67e3c5070bd83aa5e223bf8c437';
const image = 'xeeclip-backend:mobile-music-20261011';
async function health() {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch('http://127.0.0.1:4000/health')).ok) {
      assert.equal((await fetch('https://api.xeeclip.me/health')).status, 200); return;
    } } catch {}
    await pause(1000);
  }
  throw Error('API health did not recover');
}
async function main() {
  if (process.argv.includes('--preflight')) {
    const old = JSON.parse(run(['inspect', 'ai-content-backend']))[0];
    assert.equal(old.Image, baselineId, 'Live baseline changed');
    const before = state(); assert.equal(before.idle, true, 'Wait for existing work before deployment');
    save('before.json', before);
    run(['image', 'tag', baselineId, 'xeeclip-backend-rollback:before-mobile-music']);
    const dump = '/tmp/before-mobile-music.dump';
    run(['exec', 'ai-content-postgres', 'sh', '-c', `pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f ${dump}`]);
    const backup = path.join(folder, 'before-mobile-music.dump');
    run(['cp', `ai-content-postgres:${dump}`, backup]);
    const name = 'xeeclip-mobile-music-backup-check';
    run(['run', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-alpine']);
    try {
      let ready = false;
      for (let i = 0; i < 30; i++) { try { run(['exec', name, 'pg_isready', '-U', 'postgres']); ready = true; break; } catch {} await pause(1000); }
      assert(ready, 'Isolated restore database ready');
      run(['cp', backup, `${name}:/tmp/backup.dump`]);
      run(['exec', name, 'createdb', '-U', 'postgres', 'restorecheck']);
      run(['exec', name, 'pg_restore', '-U', 'postgres', '-d', 'restorecheck', '--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', '/tmp/backup.dump']);
      const sql = 'SELECT count(*) FROM "User"; SELECT count(*) FROM "GeneratedClip"; SELECT count(*) FROM "EditProject"; SELECT count(*) FROM "EditAsset"; SELECT count(*) FROM "QuickReframe"; SELECT sum("creditBalance") FROM "User";';
      const expected = run(['exec', 'ai-content-postgres', 'sh', '-c', 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$1"', 'sh', sql]);
      const restored = run(['exec', name, 'psql', '-U', 'postgres', '-d', 'restorecheck', '-At', '-c', sql]);
      assert.equal(restored, expected);
      save('backup.json', { verified: true, bytes: fs.statSync(backup).size, sha256: createHash('sha256').update(fs.readFileSync(backup)).digest('hex'), timestamp: new Date().toISOString() });
    } finally { run(['stop', name]); run(['rm', name]); }
    console.log('PASS: idle API, rollback retained, fresh database backup restored in isolation.');
  } else if (process.argv.includes('--deploy')) {
    const backup = JSON.parse(fs.readFileSync(path.join(folder, 'backup.json'), 'utf8'));
    assert(backup.verified && Date.now() - Date.parse(backup.timestamp) < 60 * 60 * 1000, 'Fresh verified backup required');
    const old = JSON.parse(run(['inspect', 'ai-content-backend']))[0];
    assert.equal(old.Image, baselineId, 'Live baseline changed');
    const one = state(); assert(one.idle, 'Existing work prevents API replacement');
    await pause(1500); const two = state(); assert(two.idle); assert.deepEqual(two.fingerprints, one.fingerprints);
    const environment = Object.fromEntries(old.Config.Env.map(item => { const i = item.indexOf('='); return [item.slice(0, i), item.slice(i + 1)]; }));
    const release = path.join(folder, 'release-compose.json'), rollback = path.join(folder, 'rollback-compose.json');
    save('release-compose.json', { services: { backend: { image, environment } } });
    save('rollback-compose.json', { services: { backend: { image: 'xeeclip-backend-rollback:before-mobile-music', environment } } });
    const replace = file => run(['compose', '-f', 'docker-compose.yml', '-f', file, 'up', '-d', '--no-deps', '--no-build', 'backend']);
    try {
      replace(release); await health();
      const current = JSON.parse(run(['inspect', 'ai-content-backend']))[0];
      assert.equal(current.Image, run(['image', 'inspect', image, '--format', '{{.Id}}']).trim());
      assert.deepEqual(current.Config.Env.sort(), old.Config.Env.sort());
      const mounts = value => value.Mounts.map(item => ({ type: item.Type, source: item.Source, destination: item.Destination })).sort((a, b) => a.destination.localeCompare(b.destination));
      assert.deepEqual(mounts(current), mounts(old));
      const after = state(); assert(after.idle); assert.deepEqual(after.fingerprints, two.fingerprints);
      save('deployed.json', { image: current.Image, health: 200, configurationPreserved: true, recordsPreserved: true, after });
      console.log('PASS: music-only API deployed; public health, configuration, mounts and all record fingerprints verified.');
    } catch (error) { replace(rollback); await health(); throw error; }
  } else throw Error('Choose --preflight or --deploy');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
