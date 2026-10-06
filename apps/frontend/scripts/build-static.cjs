// Builds the static site for Cloudflare (`out/`). Cross-platform way to set the export flag.
const { spawnSync } = require('node:child_process');

const result = spawnSync('npx', ['next', 'build'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, XEECLIP_STATIC_EXPORT: '1' }
});
process.exit(result.status ?? 1);
