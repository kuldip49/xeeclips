// Security integration in a NEW database on the positively identified disposable QA stack.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { assertQaStack } = require('./xeefree-qa-safety.cjs');
const root = path.resolve(__dirname, '../../..');
const out = path.join(root, '.real-qa-preview/xeefree');
fs.mkdirSync(out, { recursive: true });
const backend = assertQaStack().find(c => c.Name === '/xeeqa-backend');
const nonce = Date.now();
const database = `auth_test_xeefree_${nonce}`;
assert.match(database, /^auth_test_xeefree_\d+$/);
const envFile = path.join(out, 'auth-final.private.env');
const redisName = `xeeqa-auth-redis-${nonce}`;
const env = Object.fromEntries(backend.Config.Env.map(v => { const i = v.indexOf('='); return [v.slice(0, i), v.slice(i + 1)]; }));
const url = new URL(env.DATABASE_URL); url.pathname = '/' + database;
Object.assign(env, { DATABASE_URL: url.toString(), REDIS_URL: `redis://${redisName}:6379`,
  MINIO_BUCKET: `xeeclip-auth-test-${nonce}`, TEST_MINIO_ORIGIN: 'http://minio:9000',
  FRONTEND_ORIGIN: 'http://localhost:3000', ADMIN_EMAIL: 'auth-owner@example.invalid',
  ADMIN_INITIAL_PASSWORD: randomBytes(24).toString('base64url'),
  NODE_OPTIONS: '--require=/app/apps/backend/scripts/xeefree-provider-trap.cjs' });
const psql = sql => execFileSync('docker', ['exec', 'xeeqa-postgres', 'psql', '-U', 'postgres',
  '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'ignore' });
psql('CREATE DATABASE ' + database);
try {
  execFileSync('docker', ['run', '-d', '--name', redisName, '--label', 'com.docker.compose.project=xeeqa',
    '--network', 'xeeqa_default', 'redis:7-alpine'], { stdio: 'ignore' });
  fs.writeFileSync(envFile, Object.entries(env).map(([k, v]) => k + '=' + v).join('\n'));
  const result = spawnSync('docker', ['run', '--rm', '--name', `xeeqa-auth-${nonce}`,
    '--label', 'com.docker.compose.project=xeeqa', '--network', 'xeeqa_default', '--env-file', envFile,
    '--mount', `type=bind,source=${path.join(__dirname, 'test-auth-security.cjs')},target=/app/apps/backend/scripts/test-auth-security.cjs,readonly`,
    'xeefree-qa-backend:continuation', 'sh', '-c', 'npm run db:migrate && node scripts/test-auth-security.cjs'],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 300000 });
  const log = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(path.join(out, 'auth-final.log'), log);
  assert.equal(result.status, 0, 'Isolated auth checks failed; see auth-final.log');
  assert(!log.includes('"event":"xeefree_provider_trap"'), 'No cloud entry is allowed in these local security tests');
  console.log(log.match(/\{"result":"PASS"[^\n]+/)?.[0]);
} finally {
  fs.rmSync(envFile, { force: true });
  assertQaStack();
  psql('DROP DATABASE ' + database + ' WITH (FORCE)');
  execFileSync('docker', ['rm', '-f', redisName], { stdio: 'ignore' });
}
