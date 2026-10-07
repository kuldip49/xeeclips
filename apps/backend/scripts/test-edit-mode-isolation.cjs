const assert = require('node:assert/strict');
const { EditModeService } = require('../dist/modules/edit-mode/edit-mode.service.js');
// The real error class, so the service's `instanceof` unique-name guard fires
// against the harness exactly as it does against Postgres.
const prismaKnownRequestError =
  require('@prisma/client').Prisma.PrismaClientKnownRequestError.prototype;

function createHarness() {
  const rows = {
    editProjects: new Map(), editAssets: new Map(), editElements: new Map(), editHistory: new Map(),
    editTemplates: new Map(),
    processingJobs: new Map([['existing-job', {}]]),
    clipCandidates: new Map([['existing-candidate', {}]]),
    generatedClips: new Map([['existing-clip', {}]])
  };
  let sequence = 0;
  const id = (prefix) => `${prefix}-${++sequence}`;
  const decorateProject = (project, includeCounts = false) => {
    if (!project) return null;
    const result = { ...project,
      assets: [...rows.editAssets.values()].filter((item) => item.editProjectId === project.id),
      elements: [...rows.editElements.values()].filter((item) => item.editProjectId === project.id)
        .sort((a, b) => a.track - b.track || a.position - b.position) };
    if (includeCounts) result._count = { elements: result.elements.length,
      history: [...rows.editHistory.values()].filter((item) => item.editProjectId === project.id).length };
    return result;
  };
  const prisma = {
    quickReframe: { findUnique: async () => null, updateMany: async () => ({ count: 0 }) },
    creditReservation: { findUnique: async () => null },
    $transaction: async (callback) => callback(prisma),
    editProject: {
      create: async ({ data }) => {
        const now = new Date();
        const row = { id: id('project'), name: data.name, sourceProjectId: data.sourceProjectId ?? null,
          status: 'DRAFT', settings: data.settings ?? {}, revision: 0, createdAt: now, updatedAt: now };
        rows.editProjects.set(row.id, row); return { ...row };
      },
      findUnique: async ({ where, include, select }) => {
        const row = rows.editProjects.get(where.id);
        if (!row) return null;
        if (select) return Object.fromEntries(Object.keys(select).filter((key) => select[key])
          .map((key) => [key, key === 'assets' ? decorateProject(row).assets : row[key]]));
        return include ? decorateProject(row) : { ...row };
      },
      findUniqueOrThrow: async ({ where }) => {
        const row = rows.editProjects.get(where.id);
        if (!row) throw new Error('not found');
        return decorateProject(row);
      },
      findMany: async () => [...rows.editProjects.values()].map((row) => decorateProject(row, true)),
      update: async ({ where, data }) => {
        const row = rows.editProjects.get(where.id);
        if (!row) throw new Error('not found');
        const updated = { ...row, ...data, updatedAt: new Date() };
        rows.editProjects.set(where.id, updated); return { ...updated };
      },
      updateMany: async ({ where, data }) => {
        const row = rows.editProjects.get(where.id);
        if (!row || (where.revision !== undefined && row.revision !== where.revision)) return { count: 0 };
        rows.editProjects.set(where.id, { ...row, ...data, updatedAt: new Date() });
        return { count: 1 };
      },
      delete: async ({ where }) => { const row = rows.editProjects.get(where.id); rows.editProjects.delete(where.id); return row; }
    },
    editAsset: {
      create: async ({ data }) => { const now = new Date(); const row = { ...data,
        transcript: null, analysis: null, createdAt: now, updatedAt: now };
        rows.editAssets.set(row.id, row); return { ...row }; },
      findUnique: async ({ where, include }) => { const row = rows.editAssets.get(where.id);
        if (!row) return null;
        return include ? { ...row, _count: { elements: [...rows.editElements.values()]
          .filter((item) => item.assetId === row.id).length } } : { ...row }; },
      delete: async ({ where }) => { const row = rows.editAssets.get(where.id);
        rows.editAssets.delete(where.id); return row; },
      update: async ({ where, data }) => { const row = { ...rows.editAssets.get(where.id), ...data,
        updatedAt: new Date() }; rows.editAssets.set(where.id, row); return row; }
    },
    video: { findUnique: async () => null },
    editElement: {
      create: async ({ data }) => { const now = new Date(); const row = { id: id('element'), ...data,
        createdAt: now, updatedAt: now }; rows.editElements.set(row.id, row); return row; },
      deleteMany: async ({ where }) => { for (const [key, value] of rows.editElements)
        if (value.editProjectId === where.editProjectId) rows.editElements.delete(key); },
      createMany: async ({ data }) => { for (const value of data) rows.editElements.set(value.id, { ...value }); }
    },
    // Workstream F: user-saved style templates. Deliberately unrelated to
    // EditProject - a template is portable and outlives any one project.
    editTemplate: {
      create: async ({ data }) => {
        for (const row of rows.editTemplates.values()) {
          if (row.ownerScope === (data.ownerScope ?? 'LOCAL') && row.name === data.name) {
            const error = new Error('Unique constraint failed');
            error.code = 'P2002';
            error.clientVersion = 'test';
            Object.setPrototypeOf(error, prismaKnownRequestError);
            throw error;
          }
        }
        const now = new Date();
        const row = { id: id('template'), description: '', ownerScope: 'LOCAL', version: 1,
          ...data, createdAt: now, updatedAt: now };
        rows.editTemplates.set(row.id, row);
        return { ...row };
      },
      findUnique: async ({ where }) => {
        const row = rows.editTemplates.get(where.id);
        return row ? { ...row } : null;
      },
      findFirst: async ({ where }) => {
        for (const row of rows.editTemplates.values()) {
          if (row.ownerScope === where.ownerScope && row.name === where.name) return { ...row };
        }
        return null;
      },
      findMany: async ({ where }) => [...rows.editTemplates.values()]
        .filter((row) => !where?.ownerScope || row.ownerScope === where.ownerScope)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((row) => ({ ...row })),
      count: async ({ where }) => [...rows.editTemplates.values()]
        .filter((row) => !where?.ownerScope || row.ownerScope === where.ownerScope).length,
      update: async ({ where, data }) => {
        const current = rows.editTemplates.get(where.id);
        if (!current) throw new Error('not found');
        for (const row of rows.editTemplates.values()) {
          if (row.id !== where.id && row.ownerScope === current.ownerScope &&
            row.name === data.name) {
            const error = new Error('Unique constraint failed');
            error.code = 'P2002';
            error.clientVersion = 'test';
            Object.setPrototypeOf(error, prismaKnownRequestError);
            throw error;
          }
        }
        const row = { ...current, ...data, updatedAt: new Date() };
        rows.editTemplates.set(where.id, row);
        return { ...row };
      },
      delete: async ({ where }) => {
        const row = rows.editTemplates.get(where.id);
        rows.editTemplates.delete(where.id);
        return row;
      }
    },
    editHistory: {
      create: async ({ data }) => { const key = `${data.editProjectId}:${data.revision}`;
        assert(!rows.editHistory.has(key), 'history revisions must be unique');
        const row = { id: id('history'), ...data, createdAt: new Date() };
        rows.editHistory.set(key, row); return row; },
      findMany: async ({ where, orderBy }) => [...rows.editHistory.values()]
        .filter((item) => item.editProjectId === where.editProjectId)
        .sort((a, b) => orderBy?.revision === 'asc' ? a.revision - b.revision : b.revision - a.revision)
    }
  };
  const storage = {
    removed: [],
    removeObject: async (bucket, objectKey) => storage.removed.push({ bucket, objectKey }),
    statObject: async () => ({ size: 2048 }),
    getObject: async () => null,
    getPartialObject: async () => null,
    uploadBuffer: async ({ objectKey }) => ({ bucket: 'test-bucket', objectKey })
  };
  const analysis = { calls: 0, analyze: async () => { analysis.calls++;
    return { transcript: { text: 'exact source transcript', segments: [] }, analysis: {
      source: 'DENSE', summary: { sampledFrameCount: 2, faceDetections: 1,
        mouthActivitySamples: 1, shotCount: 1, ocrRegionCount: 0 } } }; } };
  return { rows, prisma, storage, analysis,
    service: new EditModeService(prisma, storage, analysis) };
}

async function seedAnalyzedProject(harness = createHarness()) {
  const project = await harness.service.create({ name: 'Isolated edit' });
  const source = {
    id: 'asset-source', originalName: 'source.mp4', bucket: 'test-bucket',
    objectKey: `edit-mode/${project.id}/asset-source/source.mp4`, mimeType: 'video/mp4',
    sizeBytes: 2048n, duration: 12.5, width: 1920, height: 1080, fps: 30,
    metadata: { hasVideo: true, hasAudio: true, videoCodec: 'h264' }
  };
  const attached = await harness.service.persistSource(project.id, project.revision, source);
  const analyzed = await harness.service.analyze(project.id, attached.revision);
  return { ...harness, project, attached, analyzed };
}

async function main() {
  const harness = createHarness();
  const before = { processingJobs: harness.rows.processingJobs.size,
    clipCandidates: harness.rows.clipCandidates.size, generatedClips: harness.rows.generatedClips.size };
  const result = await seedAnalyzedProject(harness);
  const updated = await result.service.updateElements(result.project.id, {
    revision: result.analyzed.revision,
    elements: result.analyzed.elements.map((element) => ({
      assetId: element.assetId, type: element.type, track: element.track,
      position: element.position, startTime: element.startTime, duration: element.duration,
      trimStart: element.trimStart, trimEnd: element.trimEnd, properties: element.properties
    }))
  });
  assert(result.rows.editProjects.size > 0);
  assert(result.rows.editAssets.size > 0);
  assert(result.rows.editElements.size > 0);
  assert(result.rows.editHistory.size > 0);
  assert.equal(result.rows.processingJobs.size, before.processingJobs);
  assert.equal(result.rows.clipCandidates.size, before.clipCandidates);
  assert.equal(result.rows.generatedClips.size, before.generatedClips);
  assert.equal(result.analysis.calls, 1);
  assert(result.analyzed.assets[0].objectKey.startsWith(`edit-mode/${result.project.id}/`));
  assert.equal(updated.elements[0].type, 'VIDEO');
  assert.equal(updated.elements[0].duration, 12.5);
  assert.deepEqual([...result.rows.editHistory.values()].map((item) => item.action),
    ['PROJECT_CREATED', 'SOURCE_ATTACHED', 'SOURCE_ANALYZED', 'ELEMENTS_UPDATED']);
  const serviceSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../src/modules/edit-mode/edit-mode.service.ts'), 'utf8');
  assert(!serviceSource.includes('ProcessingQueueService'));
  assert(!serviceSource.includes('ClipRenderQueueService'));
  assert(!serviceSource.includes('VideoProcessorService'));
  console.log('EditMode isolation tests passed: records, namespace, timeline, history, and frozen-count invariants.');
}

module.exports = { createHarness, seedAnalyzedProject };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
