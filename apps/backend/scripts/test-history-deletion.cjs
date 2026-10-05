/** Live API contract test with two disposable clip records and real object storage. */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { Client } = require('minio');

if (process.env.TEST_LOCAL === '1') {
  const url = new URL(process.env.DATABASE_URL);
  url.hostname = '127.0.0.1';
  process.env.DATABASE_URL = url.toString();
}
const prisma = new PrismaClient();
const storage = new Client({ endPoint: process.env.TEST_LOCAL === '1' ? '127.0.0.1' :
  process.env.MINIO_ENDPOINT ?? 'localhost', port: Number(process.env.MINIO_PORT ?? 9000),
  useSSL: process.env.MINIO_USE_SSL === 'true', accessKey: process.env.MINIO_ROOT_USER,
  secretKey: process.env.MINIO_ROOT_PASSWORD });
const bucket = process.env.MINIO_BUCKET ?? 'ai-content-platform';
const api = process.env.TEST_API ?? 'http://127.0.0.1:4000';

async function main() {
  const project = await prisma.project.create({ data: { name: `history-delete-test-${randomUUID()} (disposable)` } });
  const prefix = `projects/${project.id}/history-test/`;
  const source = `${prefix}source.mp4`;
  const keys = [source, `${prefix}first.mp4`, `${prefix}second.mp4`];
  try {
    for (const key of keys) await storage.putObject(bucket, key, Buffer.from('fixture'));
    const video = await prisma.video.create({ data: { projectId: project.id, originalName: 'fixture.mp4',
      bucket, objectKey: source, mimeType: 'video/mp4', sizeBytes: 7n } });
    const first = await prisma.generatedClip.create({ data: { videoId: video.id, rangeKey: 'first',
      variantKey: 'first', startTime: 0, endTime: 20, duration: 20, bucket, objectKey: keys[1],
      mimeType: 'video/mp4', sizeBytes: 7n, width: 1080, height: 1920, codec: 'h264',
      createdAt: new Date(Date.now() - 60_000) } });
    const second = await prisma.generatedClip.create({ data: { videoId: video.id, rangeKey: 'second',
      variantKey: 'second', startTime: 30, endTime: 50, duration: 20, bucket, objectKey: keys[2],
      mimeType: 'video/mp4', sizeBytes: 7n, width: 1080, height: 1920, codec: 'h264' } });
    const read = async () => {
      const response = await fetch(`${api}/history/clips`);
      assert.equal(response.status, 200);
      return response.json();
    };
    const listed = await read();
    assert.ok(listed.find((item) => item.id === first.id));
    assert.ok(listed.find((item) => item.id === second.id));
    assert.ok(listed.findIndex((item) => item.id === second.id) <
      listed.findIndex((item) => item.id === first.id), 'newest first');
    const download = await fetch(`${api}/generated-clips/${first.id}/file?download=1`,
      { headers: { Range: 'bytes=0-2' } });
    assert.equal(download.status, 206);
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment; filename="xeeclip-/u);
    await download.body?.cancel();
    const response = await fetch(`${api}/generated-clips/${first.id}`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.equal((await prisma.generatedClip.count({ where: { id: first.id } })), 0);
    await assert.rejects(storage.statObject(bucket, keys[1]));
    await storage.statObject(bucket, source);
    await storage.statObject(bucket, keys[2]);
    assert.ok(!(await read()).some((item) => item.id === first.id), 'deleted clip stays absent');
    assert.equal((await fetch(`${api}/generated-clips/${second.id}`, { method: 'DELETE' })).status, 200);
    assert.ok(!(await read()).some((item) => item.id === second.id));
    await storage.statObject(bucket, source);
    console.log('History sorting, download, persisted deletion, clip storage cleanup, and shared source preservation passed.');
  } finally {
    await prisma.project.delete({ where: { id: project.id } }).catch(() => undefined);
    for (const key of keys) await storage.removeObject(bucket, key).catch(() => undefined);
    await prisma.$disconnect();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
