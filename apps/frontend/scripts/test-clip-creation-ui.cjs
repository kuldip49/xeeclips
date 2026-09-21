/**
 * Output-style selection and Create Clips enablement. The pure rules live in
 * src/lib/clip-creation-state.ts so they can be exercised directly; the markup contract
 * (full-card labels, native radios, one authoritative selection) is asserted against source.
 */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const panel = readFileSync(join(root, 'src/components/clip-creation-panel.tsx'), 'utf8');

// --- Pure selection rules, loaded from the shipped module with its types stripped. ---
const stateSource = readFileSync(join(root, 'src/lib/clip-creation-state.ts'), 'utf8');
const js = stateSource
  .replace(/^import type .*$/mu, '')
  .replace(/: ClipAnalysis\['clipRequest'\]/gu, '')
  .replace(/state: \{[\s\S]*?\n\}\)/u, 'state)')
  .replace(/: OutputStyle \| null/gu, '')
  .replace(/: OutputStyle/gu, '')
  .replace(/: ClipAnalysis/gu, '')
  .replace(/: number/gu, '')
  .replace(/^export /gmu, '');
const state = new Function(js + '\nreturn { DEFAULT_OUTPUT_STYLE, restoreOutputStyle, clampClipCount,'
  + ' restoreClipCount, canCreateClips };')();

const base = {
  analysisReady: true, outputStyle: 'NORMAL', requestedClipCount: 5,
  maxClipCount: 8, submitting: false, rendering: false
};
const can = (overrides) => state.canCreateClips({ ...base, ...overrides });

// A. analysis complete with no previous request -> NORMAL is the default, button enabled.
assert.equal(state.DEFAULT_OUTPUT_STYLE, 'NORMAL');
assert.equal(state.restoreOutputStyle(null), 'NORMAL', 'no previous request must default to NORMAL');
assert.equal(state.restoreOutputStyle(undefined), 'NORMAL');
assert.equal(can({ outputStyle: state.restoreOutputStyle(null) }), true,
  'defaulting to NORMAL must leave the button enabled');

// B/C. Switching styles keeps the button enabled; both values are accepted.
assert.equal(can({ outputStyle: 'AI_EDITED' }), true);
assert.equal(can({ outputStyle: 'NORMAL' }), true);
assert.equal(can({ outputStyle: null }), false, 'no style means no submit');

// D. requestedClipCount 5 of max 8 is valid.
assert.equal(can({ requestedClipCount: 5, maxClipCount: 8 }), true);
assert.equal(can({ requestedClipCount: 8, maxClipCount: 8 }), true, 'exactly max is valid');
assert.equal(can({ requestedClipCount: 1, maxClipCount: 8 }), true, 'exactly one is valid');

// E/F. Out-of-range counts are the only count-based blockers.
assert.equal(can({ requestedClipCount: 9, maxClipCount: 8 }), false);
assert.equal(can({ requestedClipCount: 0 }), false);
assert.equal(can({ requestedClipCount: -1 }), false);
assert.equal(can({ maxClipCount: 0, requestedClipCount: 1 }), false,
  'a video with no clips cannot submit');

// G. A request in flight disables submitting again.
assert.equal(can({ submitting: true }), false);
assert.equal(can({ rendering: true }), false);
assert.equal(can({ analysisReady: false }), false);

// H. An old low recommendation must never block a larger, in-range request.
assert.equal(can({ requestedClipCount: 5, maxClipCount: 8 }), true,
  'recommendedClipCount=2 is irrelevant: 5 of 8 must stay enabled');
// Comments may name these; the code must never read them.
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
const [stateCode, panelCode] = [stripComments(stateSource), stripComments(panel)];
for (const forbidden of ['recommendedClipCount', 'recommendedCount', 'PRIMARY', 'SECONDARY',
  'processingType']) {
  assert(!stateCode.includes(forbidden) && !panelCode.includes(forbidden),
    'enablement must not depend on ' + forbidden);
}

// Count restoration clamps into range and prefers a previous request.
assert.equal(state.restoreClipCount({ maxClipCount: 8, defaultClipCount: 4, clipRequest: null }), 4);
assert.equal(state.restoreClipCount({ maxClipCount: 8, defaultClipCount: 4,
  clipRequest: { requestedClipCount: 5 } }), 5, 'a previous count must be restored');
assert.equal(state.restoreClipCount({ maxClipCount: 6, defaultClipCount: 3,
  clipRequest: { requestedClipCount: 20 } }), 6, 'a stale count must clamp to max');
assert.equal(state.clampClipCount(0, 8), 1);
assert.equal(state.clampClipCount(99, 8), 8);
assert.equal(state.clampClipCount(3, 0), 0);

// --- Panel markup contract. ---
assert(panel.includes('restoreOutputStyle(loaded.clipRequest)'),
  'the panel must restore the style through restoreOutputStyle, never leave it null');
assert(panel.includes('setCount(restoreClipCount(loaded))'),
  'the panel must restore the count through restoreClipCount');
assert.equal(panel.match(/useState<OutputStyle \| null>/gu).length, 1,
  'exactly one authoritative outputStyle state may exist');
assert(panel.includes('disabled={!canCreate}'),
  'the Create Clips button must be driven by canCreateClips');
assert(panel.includes('canCreateClips({ analysisReady:'),
  'enablement must come from the shared rule, not an inline expression');

// Whole card clickable, native radio semantics, no pointer-blocking overlay.
assert(panel.includes('<label key={option.value}'), 'each output style card must be a label');
assert(panel.includes("type='radio'"), 'cards must wrap a native radio input');
assert(panel.includes('name={`output-style-${video.id}`}'),
  'radios must share a per-video name so only one can be selected');
assert(panel.includes('checked={selected}')
  && panel.includes('onChange={() => setOutputStyle(option.value)}'),
  'the radio must reflect and drive the single outputStyle state');
assert(panel.includes('cursor-pointer'), 'selectable cards must show a pointer cursor');
assert(panel.includes('focus-within:ring-2'), 'keyboard focus must be visible on the card');
assert(panel.includes("className='sr-only'"),
  'the radio is visually hidden but must stay in the accessibility tree and focusable');
assert(!panel.includes("role='radio'"), 'native radios replace the ARIA radio buttons');

// A queued or rendering request must not freeze the style choice.
assert(panel.includes("<fieldset className='grid gap-3' disabled={submitting}>"),
  'only a live submit may disable the output style fieldset');
assert(!panel.includes("<fieldset className='grid gap-3' disabled={busy}>"),
  'a queued render must never make the output style cards unclickable');

// Selected state is derived from the one source of truth.
assert(panel.includes('const selected = outputStyle === option.value;'),
  'the visual selected state must derive from outputStyle');
assert(panel.includes("selected ? 'border-violet-400 bg-violet-500/10'"),
  'the selected card must show a distinct border and background');
assert(panel.includes('const Indicator = selected ? CheckCircle2 : Circle;'),
  'the radio indicator must reflect the same outputStyle state');

// Backend enum values, exactly.
const api = readFileSync(join(root, 'src/lib/api.ts'), 'utf8');
assert(api.includes("export type OutputStyle = 'NORMAL' | 'AI_EDITED';"),
  'frontend must use the backend OutputStyle enum values');
assert(api.includes("'/videos/' + encodeURIComponent(videoId) + '/clip-selection'"),
  'clip creation must POST to /videos/:id/clip-selection');
assert(panel.includes('createClips(video.id, { requestedClipCount: count, outputStyle })'),
  'the request payload must be { requestedClipCount, outputStyle }');
for (const value of ["value: 'NORMAL'", "value: 'AI_EDITED'"]) {
  assert(panel.includes(value), 'output style options must include ' + value);
}

const prisma = readFileSync(join(root, '../backend/prisma/schema.prisma'), 'utf8');
const enumBlock = prisma.slice(prisma.indexOf('enum OutputStyle'));
assert(/enum OutputStyle \{\s*NORMAL\s*AI_EDITED\s*\}/u.test(enumBlock),
  'backend OutputStyle enum must still be NORMAL | AI_EDITED');

console.log('Clip creation output-style UI tests passed.');
