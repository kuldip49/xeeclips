const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { readFile, mkdtemp, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHarness, seedAnalyzedProject } = require('./test-edit-mode-isolation.cjs');

async function rejectsStatus(task, status) {
  await assert.rejects(task, (error) => error?.getStatus?.() === status,
    `expected an HTTP ${status} Nest exception`);
}

async function main() {
  const result = await seedAnalyzedProject();
  const listed = await result.service.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, result.project.id);
  const fetched = await result.service.get(result.project.id);
  assert.equal(fetched.assets.length, 1);
  assert.equal(fetched.assets[0].duration, 12.5);
  assert.equal(fetched.assets[0].width, 1920);
  assert.equal(fetched.assets[0].height, 1080);
  assert.equal(fetched.assets[0].fps, 30);
  assert.equal(fetched.assets[0].transcript.text, 'exact source transcript');
  assert.equal(fetched.assets[0].analysis.source, 'DENSE');
  assert.equal(fetched.elements.length, 1);
  assert.equal(fetched.elements[0].assetId, fetched.assets[0].id);
  const history = await result.service.history(result.project.id);
  assert.deepEqual(history.map((item) => item.revision), [2, 1, 0]);
  await rejectsStatus(() => result.service.get('missing-project'), 404);
  const empty = createHarness();
  const emptyProject = await empty.service.create({ name: 'No source' });
  await rejectsStatus(() => empty.service.analyze(emptyProject.id, emptyProject.revision), 400);
  await rejectsStatus(() => empty.service.attachFromVideo(emptyProject.id,
    'missing-video', emptyProject.revision), 404);
  await rejectsStatus(() => empty.service.assetFile('missing-asset'), 404);
  await rejectsStatus(() => result.service.update(result.project.id,
    { revision: 0, name: 'Stale write' }), 409);

  const controller = readFileSync(join(__dirname,
    '../src/modules/edit-mode/edit-mode.controller.ts'), 'utf8');
  for (const route of ["@Post('projects')", "@Get('projects')", "@Get('projects/:id')",
    "@Patch('projects/:id')", "@Delete('projects/:id')", "@Post('projects/:id/assets')",
    "@Post('projects/:id/source/from-video')", "@Post('projects/:id/source/upload')",
    "@Post('projects/:id/analyze')", "@Get('projects/:id/history')",
    "@Get('assets/:assetId/file')"]) assert(controller.includes(route), `missing route ${route}`);
  console.log('EditMode API tests passed: CRUD surface, metadata, timeline, analysis, history, and error handling.');
  if (process.env.EDIT_MODE_LIVE_TEST === 'true') await liveApiTest();
}

async function liveApiTest() {
  const { Test } = require('@nestjs/testing');
  const { PrismaClient } = require('@prisma/client');
  const { DatabaseModule } = require('../dist/modules/database/database.module.js');
  const { EditModeModule } = require('../dist/modules/edit-mode/edit-mode.module.js');
  const testingModule = await Test.createTestingModule({
    imports: [DatabaseModule, EditModeModule]
  }).compile();
  const app = testingModule.createNestApplication();
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const prisma = new PrismaClient();
  const directory = await mkdtemp(join(tmpdir(), 'edit-mode-live-'));
  const videoPath = join(directory, 'source.mp4');
  const counts = () => Promise.all([
    prisma.editProject.count(), prisma.editAsset.count(), prisma.editElement.count(),
    prisma.editHistory.count(), prisma.processingJob.count(), prisma.clipCandidate.count(),
    prisma.generatedClip.count()
  ]);
  const request = async (path, init, expected = 200) => {
    const response = await fetch(`${baseUrl}${path}`, init);
    if (response.status !== expected) {
      assert.fail(`${path}: expected ${expected}, received ${response.status}: ${await response.text()}`);
    }
    return response.json();
  };
  let project;
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i',
      'sine=frequency=440:sample_rate=16000', '-t', '2', '-c:v', 'libx264',
      '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoPath]);
    const before = await counts();
    project = await request('/edit-mode/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Live EditMode ${Date.now()}` })
    }, 201);
    const form = new FormData();
    form.set('revision', String(project.revision));
    form.set('file', new Blob([await readFile(videoPath)], { type: 'video/mp4' }), 'source.mp4');
    project = await request(`/edit-mode/projects/${project.id}/source/upload`, {
      method: 'POST', body: form
    }, 201);
    assert.equal(project.assets.length, 1);
    assert(project.assets[0].objectKey.startsWith(`edit-mode/${project.id}/`));
    assert(project.assets[0].duration > 1.5);
    assert.equal(project.elements[0].type, 'VIDEO');
    project = await request(`/edit-mode/projects/${project.id}/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: project.revision })
    }, 201);
    assert(project.assets[0].transcript);
    assert(project.assets[0].analysis);
    const history = await request(`/edit-mode/projects/${project.id}/history`);
    assert.deepEqual(history.map((item) => item.action),
      ['SOURCE_ANALYZED', 'SOURCE_ATTACHED', 'PROJECT_CREATED']);
    await request('/edit-mode/projects/missing-project', undefined, 404);
    const after = await counts();
    assert.deepEqual(after.slice(0, 4).map((value, index) => value - before[index]), [1, 1, 1, 3]);
    assert.deepEqual(after.slice(4), before.slice(4),
      'EditMode must not create ProcessingJob, ClipCandidate, or GeneratedClip records');
    console.log('EditMode live API test passed: PostgreSQL, MinIO, ffprobe, transcription, edit-analysis, and isolation.');
  } finally {
    if (project?.id) await fetch(`${baseUrl}/edit-mode/projects/${project.id}`, { method: 'DELETE' })
      .catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    await prisma.$disconnect();
    await app.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
