const assert = require('node:assert/strict');
const { EditModeService } = require('../dist/modules/edit-mode/edit-mode.service.js');

function createHarness() {
  const rows = {
    editProjects: new Map(), editAssets: new Map(), editElements: new Map(), editHistory: new Map(),
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
      delete: async ({ where }) => { const row = rows.editProjects.get(where.id); rows.editProjects.delete(where.id); return row; }
    },
    editAsset: {
      create: async ({ data }) => { const now = new Date(); const row = { ...data,
        transcript: null, analysis: null, createdAt: now, updatedAt: now };
        rows.editAssets.set(row.id, row); return { ...row }; },
      findUnique: async ({ where }) => rows.editAssets.get(where.id) ?? null,
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
    getPartialObject: async () => null
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
