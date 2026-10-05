const assert = require('node:assert/strict');
const { ClipExportService, ClipInfrastructureError, renderedClipObjectKey } =
  require('../dist/modules/videos/clip-export.service');

const video = { id: 'video', projectId: 'project', objectKey: 'source.mp4',
  bucket: 'source', duration: 100 };
const candidate = { id: 'candidate', rangeKey: '10:40', startTime: 10, endTime: 40 };
const variant = 'EDITED_CLIPS:DEFAULT:AUTOMATIC_2:REQUEST:job:2026-09-30T00:00:00.000Z';
const key = renderedClipObjectKey(video.projectId, video.id, candidate.rangeKey, variant);
assert.equal(key, renderedClipObjectKey(video.projectId, video.id, candidate.rangeKey, variant));
for (const other of [
  'EDITED_CLIPS:DEFAULT:AUTOMATIC_1:REQUEST:job:2026-09-30T00:00:00.000Z',
  'EDITED_CLIPS:DEFAULT:AUTOMATIC_2:REQUEST:job:2026-09-30T01:00:00.000Z',
  'NORMAL_CLIPS:DEFAULT:AUTOMATIC_2:REQUEST:job:2026-09-30T00:00:00.000Z'
]) assert.notEqual(key, renderedClipObjectKey(video.projectId, video.id, candidate.rangeKey, other));
assert.notEqual(key, renderedClipObjectKey(video.projectId, video.id, '11:41', variant));

let downloads = 0;
const prisma = { generatedClip: { findUnique: async ({ where }) =>
  where.objectKey ? { videoId: video.id, rangeKey: candidate.rangeKey,
    variantKey: 'OTHER_VARIANT' } : null } };
const storage = { downloadToFile: async () => { downloads++; } };
const exporter = new ClipExportService(prisma, storage);
exporter.export(video, candidate, { processingType: 'EDITED_CLIPS', templateId: 'AUTOMATIC_2',
  generationRequestKey: 'job:2026-09-30T00:00:00.000Z' }).then(() => {
  throw new Error('Expected a pre-render collision');
}).catch((error) => {
  assert.ok(error instanceof ClipInfrastructureError);
  assert.equal(error.failureType, 'PERSISTENCE_FAILED');
  assert.equal(downloads, 0, 'collision is detected before download, planning or render');
  console.log('Clip identity and pre-render collision checks passed.');
});
