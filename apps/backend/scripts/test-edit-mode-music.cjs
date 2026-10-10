// Real, synthetic music through the upload validator and canonical commands.
// No database, account data, AI calls or remote storage is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHarness, seedAnalyzedProject } = require('./test-edit-mode-isolation.cjs');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-music-'));
  try {
    const state = await seedAnalyzedProject(createHarness());
    const uploads = [];
    state.storage.uploadBuffer = async (input) => {
      uploads.push(input); return { bucket: 'test-bucket', objectKey: input.objectKey };
    };
    let project = await state.service.get(state.project.id);
    for (const [extension, reportedMime, storedMime] of [
      ['mp3', 'application/octet-stream', 'audio/mpeg'],
      ['wav', 'audio/vnd.wave', 'audio/wav'],
      ['m4a', 'video/mp4', 'audio/mp4'],
      ['aac', '', 'audio/aac'],
      ['ogg', 'application/ogg', 'audio/ogg'],
      ['opus', 'audio/opus', 'audio/ogg'],
      ['flac', 'audio/x-flac', 'audio/flac'],
      ['webm', 'video/webm', 'audio/webm']
    ]) {
      const media = path.join(dir, `tone.${extension}`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
        'sine=frequency=880:duration=2', media]);
      const buffer = fs.readFileSync(media);
      const result = await state.service.uploadAsset(project.id,
        { originalname: `tone.${extension}`, mimetype: reportedMime, size: buffer.length, buffer },
        'AUDIO', project.revision);
      assert.equal(result.asset.mimeType, storedMime);
      assert.equal(uploads.at(-1).mimeType, storedMime);
      assert(result.asset.duration >= 1.9);
      project = await state.service.phase3Command(project.id, 'add-audio',
        { revision: result.revision, assetId: result.asset.id, startTime: 11 });
      const music = project.elements.find((item) => item.assetId === result.asset.id);
      assert.equal(music.startTime, 11);
      assert.equal(music.duration, 1.5, 'music is capped at the video end');
      assert.equal(music.trimEnd, 1.5);
      project = await state.service.undo(project.id, project.revision);
      assert(!project.elements.some((item) => item.id === music.id));
      project = await state.service.redo(project.id, project.revision);
      assert(project.elements.some((item) => item.id === music.id));
    }
    // Reproduce MP3s returned by Android Downloads / document providers.
    const mp3 = fs.readFileSync(path.join(dir, 'tone.mp3'));
    for (const [name, mimetype] of [
      ['phone.MP3', 'audio/mpeg3'], ['phone.mp3', 'audio/x-mpeg-3'],
      ['phone.mp3', 'application/mp3'], ['phone.mp3', 'audio/mpeg; charset=binary'],
      ['phone.mp3', 'application/octet-stream'], ['phone.mp3', 'text/plain'],
      ['phone.mp3', ''], ['phone', 'application/octet-stream'], ['phone.MP3 ', 'audio/mp3'],
      ['phone.wav', 'audio/wav']
    ]) {
      const result = await state.service.uploadAsset(project.id,
        { originalname: name, mimetype, size: mp3.length, buffer: mp3 }, 'AUDIO', project.revision);
      assert.equal(result.asset.mimeType, 'audio/mpeg', 'actual audio controls playback, not phone metadata');
      project = { ...project, revision: result.revision };
    }
    const beforeBad = uploads.length;
    const bad = Buffer.from('This is not an audio file');
    await assert.rejects(state.service.uploadAsset(project.id,
      { originalname: 'broken.mp3', mimetype: 'audio/mpeg', size: bad.length, buffer: bad },
      'AUDIO', project.revision), (error) => error.getStatus?.() === 400);
    assert.equal(uploads.length, beforeBad, 'unreadable audio never reaches storage');
    const music = project.elements.find((item) => item.type === 'AUDIO');
    await assert.rejects(state.service.phase3Command(project.id, 'add-audio',
      { revision: project.revision, assetId: music.assetId, startTime: 13 }),
    (error) => error.getStatus?.() === 400);
    const run = async (action, payload) => {
      project = await state.service.phase3Command(project.id, action,
        { revision: project.revision, ...payload });
      return project.elements.find((item) => item.id === music.id);
    };
    assert.equal((await run('set-audio-volume', { elementId: music.id, volume: 0.7 })).properties.volume, 0.7);
    assert.equal((await run('set-audio-muted', { elementId: music.id, muted: true })).properties.muted, true);
    assert.equal((await run('set-audio-fade', { elementId: music.id, fadeInSec: 0.3, fadeOutSec: 0.4 })).properties.fadeOutSec, 0.4);
    assert.equal((await run('set-audio-trim', { elementId: music.id, trimStart: 0.5, trimEnd: 1.5 })).duration, 1);
    await run('remove-element', { elementId: music.id });
    assert(!project.elements.some((item) => item.id === music.id));
    await state.service.deleteAsset(project.id, music.assetId, project.revision);
    assert(!state.rows.editAssets.has(music.assetId));
    console.log('PASS: eight audio formats, ten mobile MIME/name variants, actual-format playback MIME, corrupt file rejection and canonical editing lifecycle');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
