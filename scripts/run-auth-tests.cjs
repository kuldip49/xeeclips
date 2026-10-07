// Create and remove a disposable PostgreSQL database; never migrate the production DB.
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { join } = require('node:path');
const root = join(__dirname, '..');
const docker = process.env.DOCKER_EXE || 'C:\\Users\\kuldi\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin\\docker.exe';
const config = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/).filter(v => /^[A-Z_]+=/.test(v)).map(v => { const i = v.indexOf('='); return [v.slice(0, i), v.slice(i + 1).replace(/^(['"])(.*)\1$/, '$2')]; }));
const name = 'xeeclip_auth_test_' + randomBytes(6).toString('hex');
const dbUser = config.POSTGRES_USER || 'postgres';
function run(command, args, options = {}) {
  const r = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'], ...options });
  if (r.status !== 0) { if (r.stdout) process.stdout.write(r.stdout); if (r.stderr) process.stderr.write(r.stderr); throw new Error('Test command failed: ' + command); }
  if (r.stdout) process.stdout.write(r.stdout);
}
let created = false;
async function main() {
  const Redis = require('ioredis'); const redis = new Redis('redis://localhost:6379/15');
  if (await redis.dbsize() !== 0) { await redis.quit(); throw new Error('Redis test database 15 is not empty. Choose a new isolated database.'); }
  try {
    run(docker, ['compose', 'exec', '-T', 'postgres', 'psql', '-U', dbUser, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: `CREATE DATABASE "${name}";` }); created = true;
    const url = new URL(config.DATABASE_URL); url.hostname = 'localhost'; url.pathname = '/' + name;
    const env = { ...process.env, ...config, DATABASE_URL: url.href, REDIS_URL: 'redis://localhost:6379/15', MINIO_ENDPOINT: 'localhost', MINIO_BUCKET: name.replaceAll('_', '-'),
      NODE_ENV: 'test', AUTH_COOKIE_SECURE: 'false', TRUST_CLOUDFLARE_IP: 'false', FRONTEND_ORIGIN: 'http://localhost:3000', ADMIN_EMAIL: 'owner@example.com', ADMIN_INITIAL_PASSWORD: randomBytes(24).toString('base64url'), UPLOAD_STAGING_DIR: join(root, 'storage', 'auth-test-staging'), DEFAULT_USER_CREDITS: '5' };
    run(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', join(root, 'apps/backend/prisma/schema.prisma')], { env });
    run(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'diff', '--from-schema-datasource', join(root, 'apps/backend/prisma/schema.prisma'), '--to-schema-datamodel', join(root, 'apps/backend/prisma/schema.prisma'), '--script', '--output', join(root, 'storage/security-backups/legacy-schema-gap.sql')], { env });
    run(process.execPath, [join(root, 'apps/backend/scripts/test-auth-security.cjs')], { env });
  } finally {
    if (created && /^xeeclip_auth_test_[0-9a-f]{12}$/.test(name)) run(docker, ['compose', 'exec', '-T', 'postgres', 'dropdb', '-U', dbUser, '--force', name]);
    await redis.flushdb(); await redis.quit(); console.log('Disposable database, accounts and Redis test keys cleaned up.');
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
