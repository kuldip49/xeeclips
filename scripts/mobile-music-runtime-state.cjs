// Executed inside the API container: only aggregate state and hashes leave it.
const { PrismaClient } = require('@prisma/client');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const { createHash } = require('node:crypto');
const prisma = new PrismaClient();
const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
async function main() {
  const queues = {};
  for (const name of ['video-processing', 'clip-rendering', 'video-import', 'quick-reframe']) {
    const queue = new Queue(name, { connection });
    queues[name] = await queue.getJobCounts('active', 'wait', 'delayed', 'prioritized', 'waiting-children');
    await queue.close();
  }
  const pending = {
    processing: await prisma.processingJob.count({ where: { status: { in: ['PENDING', 'PROCESSING'] } } }),
    rendering: await prisma.processingJob.count({ where: { clipRenderStatus: { in: ['QUEUED', 'RENDERING'] } } }),
    exports: await prisma.editProject.count({ where: { status: 'EXPORTING' } }),
    reframe: await prisma.quickReframe.count({ where: { OR: [
      { status: { in: ['PLAYBACK', 'ANALYZE', 'PREPARE', 'PREVIEW', 'EXPORT', 'IMPORT'] } }, { operationId: { not: null } }
    ] } }),
    credits: await prisma.creditReservation.count({ where: { status: 'RESERVED' } }),
    imports: (await prisma.videoImport.findMany()).filter(row => !['READY', 'FAILED', 'IMPORT_FAILED', 'CANCELED', 'CANCELLED'].includes(row.status)).length,
    styling: await prisma.editProject.count({ where: { OR: ['STYLE_APPLYING', 'STYLE_READY', 'STYLING', 'RENDERING'].map(status => ({ settings: { path: ['generationStyle', 'status'], equals: status } })) } })
  };
  const fingerprints = {};
  for (const model of ['user', 'project', 'video', 'generatedClip', 'editProject', 'editAsset', 'editElement', 'quickReframe', 'creditReservation', 'creditTransaction', 'session']) {
    const rows = await prisma[model].findMany({ orderBy: { id: 'asc' } });
    fingerprints[model] = { count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows,
      (_, value) => typeof value === 'bigint' ? value.toString() : value)).digest('hex') };
  }
  console.log(JSON.stringify({ idle: Object.values(pending).every(v => v === 0) &&
    Object.values(queues).every(counts => Object.values(counts).every(v => v === 0)), pending, queues, fingerprints }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); await connection.quit(); });
