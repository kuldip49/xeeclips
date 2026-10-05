// A disposable dense EditMode project, for measuring the timeline under the
// load Workstream E's brief specifies: 400 captions, 60 overlays, several music
// clips and several video segments.
//
// It creates a real project through the ordinary HTTP API (so the source, the
// logo and the music are genuine assets in MinIO), then bulk-inserts the dense
// elements straight into Postgres, because 460 elements through the command API
// would be 460 revisions of history nobody wants to read.
//
// Everything it creates is tagged `properties->>'loadFixture' = 'true'` and the
// project itself is named with the LOAD_FIXTURE_PREFIX, so `--cleanup` can
// remove all of it - including the MinIO objects, through the ordinary delete
// endpoint - and leave nothing behind.
//
//   node scripts/seed-timeline-load-fixture.cjs --source <editAssetId>
//   node scripts/seed-timeline-load-fixture.cjs --cleanup

const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('node:crypto');

const API = process.env.EDIT_MODE_API ?? 'http://localhost:4000';
const PREFIX = 'ZZ load fixture';
// The product's own ceilings, so the fixture is the heaviest timeline EditMode
// will actually accept rather than one it refuses. EDIT_MODE_MAX_OVERLAY_ELEMENTS
// is 60 for TEXT + IMAGE + AUDIO + EFFECT COMBINED (not 60 images plus audio on
// top), and EDIT_MODE_MAX_SUBTITLE_ELEMENTS is 400. Going over either makes the
// timeline validator refuse every later command, which is how this was found.
const arg0 = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index < 0 ? NaN : Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
};
// `--light` makes a small project for BROWSER verification: the renderer goes
// unresponsive to CDP on a 400-caption timeline, so UI acceptance runs on a
// small disposable project and the dense one is kept for measurement.
const LIGHT = process.argv.includes('--light');
const CAPTIONS = arg0('captions', LIGHT ? 8 : 400);
const MUSIC_CLIPS = arg0('music', LIGHT ? 1 : 3);
const OVERLAYS = arg0('overlays', LIGHT ? 1 : 60 - MUSIC_CLIPS);
const VIDEO_SEGMENTS = arg0('segments', LIGHT ? 3 : 8);

const prisma = new PrismaClient();
const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? null : process.argv[index + 1] ?? true;
};

const post = async (path, body, form) => {
  const response = await fetch(`${API}${path}`, form
    ? { method: 'POST', body: form }
    : { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}) });
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${await response.text()}`);
  return response.json();
};

/** A 1x1 PNG, so the overlay track points at a real object without uploading art. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
/** A minimal silent WAV, so the music track has something real to point at. */
const wav = (seconds) => {
  const rate = 8000;
  const samples = rate * seconds;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples * 2, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(samples * 2, 40);
  return Buffer.concat([header, Buffer.alloc(samples * 2)]);
};

async function cleanup() {
  const projects = await prisma.editProject.findMany({
    where: { name: { startsWith: PREFIX } }, select: { id: true, name: true } });
  for (const project of projects) {
    // The ordinary delete endpoint is what removes the MinIO objects too, so
    // the fixture cannot leave storage behind.
    const response = await fetch(`${API}/edit-mode/projects/${project.id}`, { method: 'DELETE' });
    console.log(`  removed ${project.name} (${project.id}) -> ${response.status}`);
  }
  const orphans = await prisma.editElement.deleteMany({
    where: { properties: { path: ['loadFixture'], equals: 'true' } } });
  console.log(`cleanup: ${projects.length} project(s), ${orphans.count} orphaned element(s)`);
}

async function seed(sourceAssetId) {
  const file = await fetch(`${API}/edit-mode/assets/${sourceAssetId}/file`);
  if (!file.ok) throw new Error(`source asset ${sourceAssetId} -> ${file.status}`);
  const video = Buffer.from(await file.arrayBuffer());
  console.log(`source: ${(video.length / 1024 / 1024).toFixed(1)} MB`);

  const project = await post('/edit-mode/projects', { name: `${PREFIX} ${new Date().toISOString()}` });
  const upload = async (path, role, name, type, buffer, revision) => {
    const form = new FormData();
    form.set('revision', String(revision));
    if (role) form.set('role', role);
    form.set('file', new File([buffer], name, { type }));
    return post(path, null, form);
  };
  const withSource = await upload(`/edit-mode/projects/${project.id}/source/upload`, null,
    'load-fixture.mp4', 'video/mp4', video, project.revision);
  const logo = await upload(`/edit-mode/projects/${project.id}/assets/upload`, 'LOGO',
    'dot.png', 'image/png', PNG, withSource.revision);
  const music = await upload(`/edit-mode/projects/${project.id}/assets/upload`, 'AUDIO',
    'silence.wav', 'audio/wav', wav(60), logo.revision);

  const source = withSource.assets.find((asset) => asset.role === 'SOURCE');
  const duration = source.duration ?? 60;
  const existing = withSource.elements ?? [];
  const now = new Date();
  const rows = [];
  const base = { editProjectId: project.id, createdAt: now, updatedAt: now };
  const tag = { loadFixture: 'true' };

  // Video: the single imported clip becomes N sequential segments, which is
  // what a real edited timeline looks like and what the drop indicator and the
  // thumbnail strip have to cope with.
  const segment = duration / VIDEO_SEGMENTS;
  for (let index = 0; index < VIDEO_SEGMENTS; index += 1) {
    rows.push({ ...base, id: randomUUID(), assetId: source.id, type: 'VIDEO', track: 0,
      position: index, startTime: index * segment, duration: segment,
      trimStart: index * segment, trimEnd: (index + 1) * segment,
      properties: { ...tag } });
  }
  // Every overlay has to END inside the project: the timeline validator refuses
  // a whole command when any element overruns, so a fixture that spills past
  // the last frame by a few hundredths makes every later edit fail.
  const inside = (startTime, wanted) =>
    Math.max(0.05, Math.min(wanted, duration - startTime - 0.05));
  for (let index = 0; index < CAPTIONS; index += 1) {
    const startTime = (index / CAPTIONS) * duration;
    rows.push({ ...base, id: randomUUID(), assetId: null, type: 'SUBTITLE', track: 1,
      position: index, startTime, duration: inside(startTime, Math.max(0.2, duration / CAPTIONS * 0.85)),
      trimStart: 0, trimEnd: null,
      properties: { ...tag, content: `Caption line number ${index + 1}`, x: 0.1, y: 0.73,
        width: 0.8, height: 0.13, fontSize: 40, fontWeight: 700, fontFamily: 'Arial, sans-serif',
        textAlign: 'center', color: '#ffffff', backgroundColor: '#00000099', rotation: 0,
        opacity: 1, zIndex: 35, anchor: 'top-left', locked: false, hidden: false } });
  }
  for (let index = 0; index < OVERLAYS; index += 1) {
    const startTime = (index / OVERLAYS) * duration;
    rows.push({ ...base, id: randomUUID(), assetId: logo.asset.id, type: 'IMAGE', track: 2,
      position: index, startTime, duration: inside(startTime, Math.max(0.5, duration / OVERLAYS * 0.8)),
      trimStart: 0, trimEnd: null,
      properties: { ...tag, x: 0.7, y: 0.05, width: 0.2, height: 0.1, scale: 1, rotation: 0,
        opacity: 1, zIndex: 20, anchor: 'top-left', locked: false, role: 'LOGO',
        preserveAspectRatio: true } });
  }
  // An AUDIO element is a read window over its asset, so its length is capped by
  // the asset as well as by the project. Getting this wrong makes the fixture
  // itself invalid, and the next command to re-validate the timeline - a
  // template apply, say - refuses with AUDIO source range is invalid.
  const musicDuration = music.asset.duration ?? 60;
  for (let index = 0; index < MUSIC_CLIPS; index += 1) {
    const span = duration / MUSIC_CLIPS;
    const length = Math.min(inside(index * span, span * 0.9), musicDuration);
    rows.push({ ...base, id: randomUUID(), assetId: music.asset.id, type: 'AUDIO', track: 3,
      position: index, startTime: index * span, duration: length,
      trimStart: 0, trimEnd: length,
      properties: { ...tag, volume: 0.6, muted: false, fadeInSec: 0.5, fadeOutSec: 0.5,
        locked: false } });
  }

  await prisma.$transaction([
    prisma.editElement.deleteMany({ where: { id: { in: existing.map((item) => item.id) } } }),
    prisma.editElement.createMany({ data: rows }),
    prisma.editProject.update({ where: { id: project.id },
      data: { revision: { increment: 1 } } })
  ]);

  console.log(`\nload fixture ready`);
  console.log(`  project   ${project.id}`);
  console.log(`  url       http://localhost:3000/edit-mode/${project.id}`);
  console.log(`  elements  ${rows.length} (${VIDEO_SEGMENTS} video, ${CAPTIONS} captions, ` +
    `${OVERLAYS} overlays, ${MUSIC_CLIPS} music)`);
  console.log(`  duration  ${duration.toFixed(2)}s`);
  console.log(`\n  remove it with: node scripts/seed-timeline-load-fixture.cjs --cleanup`);
}

async function main() {
  if (arg('cleanup')) return cleanup();
  const sourceAssetId = arg('source');
  if (!sourceAssetId) throw new Error('--source <editAssetId> is required (or --cleanup)');
  await seed(sourceAssetId);
}

main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
