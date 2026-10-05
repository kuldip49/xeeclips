// Backward-compatibility coverage for resolveGenerationStyleReadiness(): historical
// generationStyle records that predate per-record templateId must never read as a styling
// failure on missing metadata alone - only a recorded failure, or a genuine, provable template
// identity mismatch, may produce STYLE_FAILED. See the P0 fix in clip-selection.service.ts.
const assert = require('node:assert/strict');
const { resolveGenerationStyleReadiness, toClipCard } =
  require('../dist/modules/videos/clip-selection.service');

let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log(`  ok - ${label}`); };

const baseClip = (overrides = {}) => ({
  id: 'clip-1', startTime: 0, endTime: 10, duration: 10, sizeBytes: 1000n,
  processingType: 'EDITED_CLIPS', aspectRatio: '9:16', width: 1080, height: 1920,
  editTelemetry: null, candidate: null,
  templateId: 'AUTOMATIC_2', requestedTemplate: 'AUTOMATIC_2', effectiveTemplate: 'AUTOMATIC_2',
  editProject: { id: 'project-1', settings: { generationStyle: {} } },
  ...overrides
});

const withStyle = (style, clipOverrides = {}) => baseClip({
  editProject: { id: 'project-1', settings: { generationStyle: style } }, ...clipOverrides
});

// 1. New Automatic 2 clip whose generationStyle record carries its own templateId: ready,
//    modern (non-legacy) path.
check('new clip with matching templateId -> ready, not legacy', () => {
  const resolved = resolveGenerationStyleReadiness(withStyle({
    status: 'EXPORT_READY', templateId: 'AUTOMATIC_2', exportAssetId: 'asset-1'
  }));
  assert.equal(resolved.status, 'EXPORT_READY');
  assert.equal(resolved.legacy, false);
  assert.equal(resolved.playbackUrl, '/edit-mode/assets/asset-1/file');
});

// 2. Historical style record with NO templateId, but the GeneratedClip row's own
//    requestedTemplate/templateId prove which template produced it: still reads as ready.
check('historical record missing templateId, GeneratedClip.templateId present -> ready, legacy', () => {
  const resolved = resolveGenerationStyleReadiness(withStyle({
    status: 'EXPORT_READY', exportAssetId: 'asset-2'
    // no templateId on the style record itself
  }));
  assert.equal(resolved.status, 'EXPORT_READY');
  assert.equal(resolved.legacy, true);
  assert.equal(resolved.playbackUrl, '/edit-mode/assets/asset-2/file');
});

// 3. Fully legacy clip: neither the style record nor the GeneratedClip row carries any template
//    identity, but a real export asset exists -> distinguishable LEGACY_STYLE_READY, still playable.
check('no template identity anywhere but a real export exists -> LEGACY_STYLE_READY', () => {
  const resolved = resolveGenerationStyleReadiness(withStyle(
    { status: 'READY', exportAssetId: 'asset-3' },
    { templateId: null, requestedTemplate: null, effectiveTemplate: null }
  ));
  assert.equal(resolved.status, 'LEGACY_STYLE_READY');
  assert.equal(resolved.legacy, true);
  assert.equal(resolved.playbackUrl, '/edit-mode/assets/asset-3/file');
});

// 4. A real, recorded styling failure must still read as STYLE_FAILED.
check('recorded STYLE_FAILED stays STYLE_FAILED', () => {
  const resolved = resolveGenerationStyleReadiness(withStyle({
    status: 'STYLE_FAILED', error: 'ffmpeg exited 1'
  }));
  assert.equal(resolved.status, 'STYLE_FAILED');
  assert.equal(resolved.playbackUrl, null);
  assert.equal(resolved.error, 'ffmpeg exited 1');
});

// 4b. A genuine, PROVABLE template mismatch (modern record whose templateId disagrees with the
//     clip's own requested template) must also still fail - missing metadata is forgiven, wrong
//     metadata is not.
check('modern record with a real template mismatch still fails', () => {
  const resolved = resolveGenerationStyleReadiness(withStyle({
    status: 'EXPORT_READY', templateId: 'AUTOMATIC_1', exportAssetId: 'asset-4'
  }));
  assert.equal(resolved.status, 'STYLE_FAILED');
  assert.equal(resolved.playbackUrl, null);
});

// 5. Insufficient/unrecognized evidence must read as a neutral unknown, never a failure.
check('unrecognized status -> neutral STYLE_UNKNOWN, not failed', () => {
  const resolved = resolveGenerationStyleReadiness(withStyle({ status: 'SOMETHING_FUTURE' }));
  assert.equal(resolved.status, 'STYLE_UNKNOWN');
  assert.notEqual(resolved.status, 'STYLE_FAILED');
  assert.equal(resolved.playbackUrl, null);
});

// No generationStyle recorded at all (styling never requested/run) stays untouched: null, exactly
// as before this change - callers treat that as "not applicable", not as unknown or failed.
check('no generationStyle at all -> null (unchanged pre-existing behavior)', () => {
  const resolved = resolveGenerationStyleReadiness(baseClip({
    editProject: { id: 'project-1', settings: {} }
  }));
  assert.equal(resolved, null);
});

// 6. The result card's preview stays playable for every ready variant, current and legacy.
check('toClipCard exposes a playable preview for modern and legacy ready clips', () => {
  const modern = toClipCard(withStyle({ status: 'READY', templateId: 'AUTOMATIC_2', exportAssetId: 'a' }), 'ONLINE', 1);
  const legacy = toClipCard(withStyle({ status: 'READY', exportAssetId: 'b' },
    { templateId: null, requestedTemplate: null, effectiveTemplate: null }), 'ONLINE', 1);
  assert.equal(modern.style.playbackUrl, '/edit-mode/assets/a/file');
  assert.equal(legacy.style.playbackUrl, '/edit-mode/assets/b/file');
});

// 7. The Edit button's availability is governed by generatedClipEditLink() alone (editProject
//    presence), never by style readiness - a STYLE_FAILED or STYLE_UNKNOWN clip is still editable.
check('Edit stays available regardless of style outcome', () => {
  const failed = toClipCard(withStyle({ status: 'STYLE_FAILED' }), 'ONLINE', 1);
  const unknown = toClipCard(withStyle({ status: 'WEIRD' }), 'ONLINE', 1);
  for (const card of [failed, unknown]) {
    assert.equal(card.isEditable, true);
    assert.equal(card.editProjectId, 'project-1');
    assert.equal(card.editUrl, '/edit-mode/project-1');
  }
});

console.log(`Style readiness backward-compatibility: ${passed} checks passed.`);
