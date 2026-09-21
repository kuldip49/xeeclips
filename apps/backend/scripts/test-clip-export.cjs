const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { copyFileSync, mkdtempSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { exportClipFile, ClipExportService } = require('../dist/modules/videos/clip-export.service');

/** Normal and AI Edited variants coexist; an existing valid variant is never rendered again. */
async function testOutputVariants(source, directory) {
  const rows = new Map();
  let nextId = 0;
  const keyOf = ({ videoId, rangeKey, variantKey }) => `${videoId}|${rangeKey}|${variantKey}`;
  const removed = [];
  let downloads = 0;
  const prisma = {
    generatedClip: {
      findUnique: async ({ where }) => rows.get(keyOf(where.videoId_rangeKey_variantKey)) ?? null,
      delete: async ({ where }) => {
        for (const [key, row] of rows) if (row.id === where.id) rows.delete(key);
      },
      upsert: async ({ where, create }) => {
        const key = keyOf(where.videoId_rangeKey_variantKey);
        if (!rows.has(key)) rows.set(key, { id: `row-${++nextId}`, ...create });
        return rows.get(key);
      }
    },
    processingJob: { findFirst: async () => ({ id: 'job', aiMode: 'ONLINE', telemetry: {} }) }
  };
  const storage = {
    downloadToFile: async (_bucket, _key, path) => { downloads++; copyFileSync(source, path); },
    uploadFile: async ({ filePath, objectKey }) => {
      assert.ok(statSync(filePath).size > 0);
      return { bucket: 'clips', objectKey };
    },
    removeObject: async (bucket, objectKey) => { removed.push(objectKey); }
  };
  const exporter = new ClipExportService(prisma, storage);
  const video = { id: 'vid', projectId: 'proj', bucket: 'videos', objectKey: 'source.mp4',
    duration: 20, targetPlatform: 'TIKTOK' };
  const candidate = { id: 'cand', rangeKey: '2.000:17.000', startTime: 2, endTime: 17 };
  const edited = { id: 'edited-row', videoId: 'vid', candidateId: 'cand', rangeKey: candidate.rangeKey,
    variantKey: 'EDITED_CLIPS:TIKTOK', processingType: 'EDITED_CLIPS', aspectRatio: '9:16',
    width: 1080, height: 1920, bucket: 'clips', objectKey: 'x-edited-tiktok.mp4' };
  rows.set(keyOf(edited), edited);

  const normalOptions = { processingType: 'NORMAL_CLIPS', targetPlatform: 'TIKTOK', aspectRatio: '9:16' };
  const normal = await exporter.export(video, candidate, normalOptions);
  assert.equal(downloads, 1);
  assert.equal(rows.size, 2, 'the AI Edited render is kept');
  assert.equal(rows.get(keyOf(edited)), edited);
  assert.deepEqual(removed, []);
  assert.equal(normal.variantKey, 'NORMAL_CLIPS:TIKTOK');
  assert.equal(normal.targetPlatform, 'TIKTOK');
  assert.notEqual(normal.objectKey, edited.objectKey);
  // Normal clips: always the 9:16 canvas, full source frame over a blurred background.
  assert.equal(normal.aspectRatio, '9:16');
  assert.deepEqual([normal.width, normal.height], [1080, 1920]);
  assert.equal(normal.editPlan, undefined, 'no editing plan for Normal clips');

  // Identical variants are reused without downloading or rendering.
  assert.equal(await exporter.export(video, candidate, normalOptions), normal);
  assert.equal(await exporter.export(video, candidate,
    { processingType: 'EDITED_CLIPS', targetPlatform: 'TIKTOK', aspectRatio: '9:16' }), edited);
  assert.equal(downloads, 1, 'no duplicate render');

  // A Normal render from before the fixed 9:16 canvas is the same variant but is re-rendered.
  const legacyKey = { videoId: 'vid', rangeKey: '3.000:18.000', variantKey: 'NORMAL_CLIPS:TIKTOK' };
  rows.set(keyOf(legacyKey), { id: 'legacy', ...legacyKey, processingType: 'NORMAL_CLIPS',
    aspectRatio: 'SOURCE', width: 160, height: 90, bucket: 'clips', objectKey: 'legacy.mp4' });
  const upgraded = await exporter.export(video, { ...candidate, rangeKey: legacyKey.rangeKey,
    startTime: 3, endTime: 18 }, normalOptions);
  assert.deepEqual(removed, ['legacy.mp4']);
  assert.deepEqual([upgraded.width, upgraded.height], [1080, 1920]);
  assert.equal(downloads, 2);
}

async function main() {
  const available = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (available.error?.code === 'ENOENT') {
    console.log('SKIP FFmpeg export test: ffmpeg is not installed on this host (it is installed in the backend Docker image).');
    return;
  }
  assert.equal(available.status, 0, 'ffmpeg must be executable');
  const directory = mkdtempSync(join(tmpdir(), 'clip-export-test-'));
  try {
    const source = join(directory, 'source.mp4');
    const output = join(directory, 'clip.mp4');
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100', '-t', '20',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source
    ]);
    const metadata = await exportClipFile(source, output, 2, 17);
    assert.ok(Math.abs(metadata.duration - 15) <= 1.5);
    assert.equal(metadata.width, 160);
    assert.equal(metadata.height, 90);
    assert.ok(metadata.sizeBytes > 0);
    await assert.rejects(() => exportClipFile(source, output, 0, 14), /between 15 and 120/);
    await assert.rejects(() => exportClipFile(source, output, 0, 120.5), /between 15 and 120/);
    // Platform uploads: basic fit-to-canvas conversion, no editing effects.
    const vertical = await exportClipFile(source, join(directory, 'vertical.mp4'), 2, 17, 'VERTICAL_9_16');
    assert.equal(vertical.width, 1080);
    assert.equal(vertical.height, 1920);
    assert.ok(Math.abs(vertical.duration - 15) <= 1.5);
    // Above the fitted 16:9 frame is the blurred source, not a black bar.
    const band = execFileSync('ffmpeg', ['-v', 'error', '-ss', '5', '-i', join(directory, 'vertical.mp4'),
      '-vf', 'crop=1080:400:0:0,scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    assert.ok(band[0] + band[1] + band[2] > 60, `background must not be black: ${[...band]}`);
    await testOutputVariants(source, directory);
    console.log(JSON.stringify({ ffmpegExport: true, ffprobeValidation: true, outputVariants: true,
      metadata }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
