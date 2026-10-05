/** Narrow, audited cleanup of two known QA records. Run without --execute to print the plan. */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });
const { PrismaClient } = require('@prisma/client');
const { Client } = require('minio');

const approved = new Map([
  ['093b6ce9-eab4-4e59-9b35-1ebb5e9707d7', 'one-step-entry-qa (disposable)'],
  ['53999d16-82f5-4e0a-864e-c2009cd6c265',
    'URL ingestion upload regression 2026-10-03T19:31:23.693Z']
]);
const args = process.argv.slice(2);
const execute = args.includes('--execute');
const ids = args.filter((arg) => !arg.startsWith('--'));
if (!ids.length || ids.some((id) => !approved.has(id))) {
  console.error('Pass one or both approved project IDs. Add --execute only after reviewing the dry run.');
  process.exit(2);
}
if (process.env.DATABASE_URL) {
  const url = new URL(process.env.DATABASE_URL);
  if (process.env.CLEANUP_LOCAL === '1') url.hostname = '127.0.0.1';
  process.env.DATABASE_URL = url.toString();
}
const prisma = new PrismaClient();
const minio = new Client({ endPoint: process.env.CLEANUP_LOCAL === '1' ? '127.0.0.1' :
  process.env.MINIO_ENDPOINT ?? 'localhost', port: Number(process.env.MINIO_PORT ?? 9000),
  useSSL: process.env.MINIO_USE_SSL === 'true', accessKey: process.env.MINIO_ROOT_USER,
  secretKey: process.env.MINIO_ROOT_PASSWORD });
const bucket = process.env.MINIO_BUCKET ?? 'ai-content-platform';

const listObjects = (prefix) => new Promise((resolve, reject) => {
  const keys = [];
  const stream = minio.listObjectsV2(bucket, prefix, true);
  stream.on('data', (item) => keys.push(item.name));
  stream.on('end', () => resolve(keys));
  stream.on('error', reject);
});

async function plan(id) {
  const project = await prisma.project.findUnique({ where: { id },
    include: { videos: { include: { processingJobs: true, generatedClips: true,
      referenceAssets: true, editProjects: { include: { assets: true } } } }, videoImports: true } });
  if (!project || project.name !== approved.get(id)) throw new Error(`Identity check failed for ${id}`);
  const extraEdits = await prisma.editProject.findMany({ where: { sourceProjectId: id },
    include: { assets: true } });
  const edits = new Map([...project.videos.flatMap((video) => video.editProjects), ...extraEdits]
    .map((edit) => [edit.id, edit]));
  const linkedElsewhere = await prisma.editAsset.count({ where: {
    sourceVideoId: { in: project.videos.map((video) => video.id) },
    editProjectId: { notIn: [...edits.keys()] }
  } });
  if (linkedElsewhere) throw new Error(`Source media is used by ${linkedElsewhere} other edits`);
  if (project.videos.some((video) => video.processingJobs.some((job) =>
    job.status === 'PROCESSING' || ['QUEUED', 'RENDERING'].includes(job.clipRenderStatus)))) {
    throw new Error(`Active generation found in ${id}`);
  }
  const prefixObjects = await listObjects(`projects/${id}/`);
  const assets = [...edits.values()].flatMap((edit) => edit.assets)
    .filter((asset) => asset.storageOwnership === 'OWNED')
    .map((asset) => ({ bucket: asset.bucket, key: asset.storageObjectKey || asset.objectKey }));
  const external = assets.filter((asset) => !asset.key.startsWith(`projects/${id}/`));
  const objects = [...new Map([...prefixObjects.map((key) => ({ bucket, key })), ...external]
    .map((object) => [`${object.bucket}/${object.key}`, object])).values()]
    .sort((a, b) => a.key.localeCompare(b.key));
  return { project, edits: [...edits.values()], objects };
}

async function main() {
  for (const id of ids) {
    const item = await plan(id);
    console.log(JSON.stringify({ project: { id, name: item.project.name },
      videos: item.project.videos.map((video) => ({ id: video.id, name: video.originalName,
        clipIds: video.generatedClips.map((clip) => clip.id) })),
      importIds: item.project.videoImports.map((entry) => entry.id),
      editIds: item.edits.map((edit) => edit.id),
      objects: item.objects }, null, 2));
    if (!execute) continue;
    for (const object of item.objects) await minio.removeObject(object.bucket, object.key);
    await prisma.$transaction(async (tx) => {
      for (const edit of item.edits) await tx.editProject.delete({ where: { id: edit.id } });
      await tx.project.delete({ where: { id } });
    });
    console.log(`Deleted approved disposable project ${id}`);
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
