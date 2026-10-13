// Offline test scripts only; no verify/diagnose/live scripts or production calls.
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), backend = path.join(root, 'apps/backend');
const out = path.join(root, '.real-qa-preview/xeefree/regressions'); fs.mkdirSync(out, { recursive: true });
const scripts = [...new Set(Object.values(JSON.parse(fs.readFileSync(path.join(backend, 'package.json'))).scripts)
  .flatMap(command => [...command.matchAll(/node scripts\/(test-[\w-]+\.cjs)/g)].map(m => m[1])))];
scripts.push('test-xeefree-qa-safety.cjs');
const report = [];
for (const file of scripts) {
  const start = Date.now();
  const result = spawnSync(process.execPath, ['scripts/' + file], { cwd: backend, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  fs.writeFileSync(path.join(out, file + '.log'), (result.stdout || '') + (result.stderr || ''));
  const entry = { file, passed: result.status === 0, status: result.status, error: result.error?.message, ms: Date.now() - start };
  report.push(entry); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`${entry.passed ? 'PASS' : 'FAIL'} ${file} (${entry.ms} ms)`);
}
console.log(JSON.stringify({ suites: report.length, passed: report.filter(r => r.passed).length, failed: report.filter(r => !r.passed).map(r => r.file) }));
if (report.some(r => !r.passed)) process.exitCode = 1;
