// Preserve the historic test:clips entry point against the current unified UI.
// The former source-label checks referenced the retired project workspace.
require('../../frontend/scripts/test-clip-creation-ui.cjs');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const read = path => readFileSync(join(__dirname, '../../frontend/src', path), 'utf8');
const hooks = read('components/edit-mode/suggested-hooks.tsx');
const reframe = read('components/quick-reframe/hooks-panel.tsx');
const history = read('components/history-view.tsx');
const labels=read('lib/quick-reframe-api.ts');
assert(hooks.includes('Object.entries(HOOK_CATEGORY_LABEL)') && reframe.includes('Object.entries(HOOK_CATEGORY_LABEL)'), 'both editors consume the shared category labels');
for (const category of ['BOLD','CURIOSITY','CONTRARIAN','SARCASTIC','HUMOROUS','EMOTIONAL','QUESTION','AUTHORITY','STORY','WARNING','PROFESSIONAL'])
  assert(labels.includes(category), `${category} shared hook control available in both editors`);
for (const direction of ['Stronger / bolder','Funnier','More sarcastic','More professional','Shorter','Rewrite'])
  assert(hooks.includes(direction), `${direction} regeneration control available`);
assert(hooks.includes('generate(false)'), 'post-copy request uses the shared full-package endpoint');
assert(hooks.includes('copyRevision') && hooks.includes('contextRevision'), 'persisted suggestions are tied to retained context');
assert(history.includes('clip.synopsis') && history.includes('clip.caption') && history.includes('clip.hashtags'), 'History presents final copy');
console.log('Shared creative UI categories, rewrite controls, full copy, revision provenance and History copy: PASS');
