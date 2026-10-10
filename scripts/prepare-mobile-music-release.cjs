// Build a music-only release on the verified live baseline, preserving its rollback.
// Run from the repository root. This prepares artifacts; it does not deploy anything.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.real-qa-preview', 'mobile-music-release');
const baseline = 'f9ad75c';
const image = 'xeeclip-backend-rollback:before-ci-v2-6d5a9c5';
const expectedImageId = 'sha256:bdd5dcbc97eabbe41dd6fa9538abde850baff67e3c5070bd83aa5e223bf8c437';
fs.mkdirSync(output, { recursive: true });
const archive = path.join(output, 'baseline.tar');
execFileSync('git', ['archive', '--format=tar', '-o', archive, baseline,
  'apps/frontend', 'packages/shared', 'package.json', 'package-lock.json'], { cwd: root });
execFileSync('tar', ['-xf', archive, '-C', output]);
const localShared = path.join(output, 'node_modules', '@ai-content-platform', 'shared');
fs.mkdirSync(path.dirname(localShared), { recursive: true });
fs.cpSync(path.join(output, 'packages', 'shared'), localShared, { recursive: true });
execFileSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
  '-p', path.join(localShared, 'tsconfig.json')], { stdio: 'inherit' });
const musicFiles = [
  'components/edit-mode/edit-asset-picker.tsx',
  'components/edit-mode/edit-mode-workspace.tsx',
  'components/edit-mode/edit-preview.tsx',
  'components/edit-mode/shell/edit-audio-panel.tsx',
  'components/edit-mode/shell/edit-tool-panel.tsx',
  'components/edit-mode/shell/edit-top-bar.tsx',
  'lib/edit-mode-api.ts', 'lib/edit-mode-audio.ts', 'lib/edit-mode-timeline.ts'
];
for (const file of musicFiles) {
  const relative = path.join('apps', 'frontend', 'src', file);
  fs.copyFileSync(path.join(root, relative), path.join(output, relative));
}
const service = 'apps/backend/src/modules/edit-mode/edit-mode.service.ts';
const original = execFileSync('git', ['show', `${baseline}:${service}`], { cwd: root, encoding: 'utf8' }).replace(/\r\n/g, '\n');
const current = fs.readFileSync(path.join(root, service), 'utf8').replace(/\r\n/g, '\n');
function section(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  if (first < 0 || last < 0) throw new Error(`Missing release boundary: ${start}`);
  return source.slice(first, last);
}
let patched = original;
for (const [start, end] of [
  ['const IMAGE_MIMES', '// --- Phase 7 capacity limits'],
  ['  async uploadAsset(', '  async deleteAsset('],
  ['  private probeAssetMedia(', '  private async assertAttachable('],
  ["      if (action === 'ADD_AUDIO')", '      // Step 5: every logo']
]) patched = patched.replace(section(original, start, end), section(current, start, end));
fs.writeFileSync(path.join(output, 'edit-mode.service.ts'), patched);
for (const file of ['test-edit-mode-music.cjs', 'test-edit-mode-isolation.cjs']) {
  fs.copyFileSync(path.join(root, 'apps/backend/scripts', file), path.join(output, file));
}
fs.writeFileSync(path.join(output, 'Dockerfile'), `FROM ${image} AS builder
WORKDIR /app/apps/backend
COPY edit-mode.service.ts src/modules/edit-mode/edit-mode.service.ts
COPY test-edit-mode-music.cjs test-edit-mode-isolation.cjs scripts/
COPY apps/frontend/src /app/apps/frontend/src
RUN npm run build && node scripts/test-edit-mode-music.cjs && node scripts/test-edit-mode-phase3.cjs && node scripts/test-edit-mode-color.cjs && node scripts/test-edit-mode-export.cjs
FROM ${image}
COPY --from=builder /app/apps/backend/dist/modules/edit-mode/edit-mode.service.js /app/apps/backend/dist/modules/edit-mode/edit-mode.service.js
`);
fs.writeFileSync(path.join(output, '.dockerignore'), '**\n!Dockerfile\n!edit-mode.service.ts\n!test-edit-mode-music.cjs\n!test-edit-mode-isolation.cjs\n!apps/\n!apps/frontend/\n!apps/frontend/src/\n!apps/frontend/src/**\n');
fs.writeFileSync(path.join(output, 'release-scope.json'), JSON.stringify({ baseline, image, expectedImageId,
  backend: 'Only compiled edit-mode.service.js: upload validation, playback MIME, bounded probe and music insertion time.',
  frontend: musicFiles, excludes: 'Content Intelligence v2, hook generation and ending changes.' }, null, 2));
console.log('Prepared music-only release:', output);
