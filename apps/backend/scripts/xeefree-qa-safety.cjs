const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const docker = args => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
function validateQaStack(containers) {
  for (const [name, service] of [['xeeqa-backend', 'backend'], ['xeeqa-postgres', 'postgres']]) {
    const c = containers.find(value => value.Name === '/' + name);
    assert(c && c.State.Running, `${name} must be running`);
    assert.equal(c.Config.Labels['com.docker.compose.project'], 'xeeqa');
    assert.equal(c.Config.Labels['com.docker.compose.service'], service);
    assert.deepEqual(Object.keys(c.NetworkSettings.Networks), ['xeeqa_default']);
    assert(c.Mounts.filter(m => m.Type === 'volume').every(m => m.Name.startsWith('xeeqa_')),
      'QA data volumes must not belong to production');
  }
  const backend = containers.find(c => c.Name === '/xeeqa-backend');
  assert.deepEqual(backend.HostConfig.PortBindings['4000/tcp'], [{ HostIp: '127.0.0.1', HostPort: '4100' }]);
  const database = containers.find(c => c.Name === '/xeeqa-postgres');
  assert(!Object.values(database.HostConfig.PortBindings || {}).some(Boolean), 'QA database must not publish a host port');
  assert(database.Mounts.some(m => m.Type === 'volume' && m.Name === 'xeeqa_postgres_data' && m.Destination === '/var/lib/postgresql/data'));
  const env = Object.fromEntries(backend.Config.Env.map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  const url = new URL(env.DATABASE_URL);
  assert.equal(url.hostname, 'postgres'); assert.equal(url.port, '5432'); assert.equal(url.pathname, '/ai_content_platform');
  assert(database.NetworkSettings.Networks.xeeqa_default.Aliases.includes('postgres'));
  return true;
}
function assertQaStack() {
  const containers = JSON.parse(docker(['inspect', 'xeeqa-backend', 'xeeqa-postgres']));
  validateQaStack(containers); return containers;
}
function topUpQaUser(user) {
  assertQaStack();
  assert.match(user.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.match(user.email, /^xeefree-qa-\d+@example\.invalid$/);
  // Exact user created by this run, never a wildcard or a production container.
  const sql = `UPDATE "User" SET "creditBalance" = 500 WHERE id = '${user.id}' AND email = '${user.email}' AND role = 'USER' RETURNING "creditBalance";`;
  const result = docker(['exec', 'xeeqa-postgres', 'psql', '-U', 'postgres', '-d', 'ai_content_platform', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  assert.match(result, /^500\r?\nUPDATE 1\s*$/);
  return { isolated: true, exactUser: true, credits: 500 };
}
module.exports = { validateQaStack, assertQaStack, topUpQaUser };
