/**
 * EditMode template browser (Workstream F), frontend side.
 *
 * The card hints are pure functions, so they are exercised directly. The panel
 * contracts that matter - preview before apply, cancel writes nothing, the diff
 * is formatted text rather than JSON, saving is portable by default - are
 * asserted against the component source, the same way the other EditMode UI
 * tests do it.
 *
 * Offline, deterministic, and it leaves nothing behind.
 */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

const root = join(__dirname, '..');
require.extensions['.ts'] = (mod, filename) => {
  const js = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  mod._compile(js, filename);
};

const templates = require(join(root, 'src/lib/edit-mode-templates.ts'));
const read = (relative) => readFileSync(join(root, relative), 'utf8');
const panel = read('src/components/edit-mode/shell/edit-templates-panel.tsx');
const lib = read('src/lib/edit-mode-templates.ts');
const rail = read('src/lib/edit-mode-tools.ts');
const toolPanel = read('src/components/edit-mode/shell/edit-tool-panel.tsx');
const workspace = read('src/components/edit-mode/edit-mode-workspace.tsx');
const timelineLib = read('src/lib/edit-mode-timeline.ts');

let checks = 0;
const ok = (label, condition) => { assert(condition, label); checks += 1; };
const section = (title) => console.log(`\n${title}`);

const template = (over = {}) => ({
  version: 1, id: 'T', name: 'T', description: '', source: 'BUILTIN',
  project: { aspectRatio: '9:16', pacing: 'MODERATE' },
  text: { defaultStyleId: 'BASIC', hookStyleId: 'HOOK', ctaStyleId: 'CTA' },
  captions: { styleId: 'CLEAN', placement: 'LOWER', activeWord: false, uppercase: false },
  logo: { placement: 'TOP_RIGHT', scale: 0.16 },
  color: { filterId: 'CLEAN', strength: 1 },
  audio: { musicVolume: 0.22, duckEnabled: true, duckStrength: 'MEDIUM', fadeInSec: 0.5,
    fadeOutSec: 0.5 },
  zoom: 'SUBTLE', reframe: 'AUTO', informationRegion: 'RESPECT',
  assets: { logoAssetId: null, musicAssetId: null }, ...over });

// --- A. Card hints -----------------------------------------------------------

section('A. Card hints');
ok('a vertical template shows its aspect ratio',
  templates.aspectHint(template()) === '9:16');
ok('a source-shaped template says so in words, not as an enum',
  templates.aspectHint(template({ project: { aspectRatio: 'SOURCE', pacing: 'SOURCE' } })) ===
    'Keeps source shape');
ok('the caption hint names the style and where it sits',
  templates.captionHint(template()) === 'Clean captions · Lower');
ok('a PRESET placement leaves the position out rather than inventing one',
  templates.captionHint(template({ captions: { styleId: 'PODCAST', placement: 'PRESET',
    activeWord: null, uppercase: null } })) === 'Podcast captions');
ok('the colour hint is plain words',
  templates.colorHint(template()) === 'Clean' &&
  templates.colorHint(template({ color: { filterId: 'ORIGINAL', strength: 1 } })) ===
    'No colour change');
ok('a part-strength look says how strong it is',
  templates.colorHint(template({ color: { filterId: 'WARM', strength: 0.5 } })) === 'Warm 50%');
ok('the motion hint reads as English, not as a policy enum',
  templates.motionHint(template()) === 'Subtle zoom' &&
  templates.motionHint(template({ zoom: 'OFF' })) === 'No zoom');
ok('no hint contains an underscore or a raw enum',
  [templates.aspectHint, templates.captionHint, templates.colorHint, templates.motionHint]
    .every((hint) => !hint(template({ color: { filterId: 'BLACK_AND_WHITE', strength: 1 } }))
      .includes('_')));
ok('the swatch is two local colours, never a fetched image',
  (() => {
    const swatch = templates.templateSwatch(template());
    return swatch.length === 2 && swatch.every((value) => /^#[0-9a-f]{6}$/iu.test(value));
  })());
ok('an unknown filter still produces a swatch rather than crashing',
  templates.templateSwatch(template({ color: { filterId: 'NOT_A_FILTER', strength: 1 } }))
    .length === 2);

// --- B. The panel contract ---------------------------------------------------

section('B. Preview before apply');
ok('a card click previews rather than applying',
  /const choose = \(template[\s\S]{0,200}previewTemplate\(/u.test(panel));
ok('apply is a separate, explicit action',
  panel.includes("data-testid='template-apply'") && /const confirm = \(\)[\s\S]{0,200}applyTemplate\(/u.test(panel));
ok('cancel only drops the local proposal - it calls no API at all',
  (() => {
    const cancel = panel.slice(panel.indexOf("data-testid='template-cancel'"));
    const body = cancel.slice(0, cancel.indexOf('</button>'));
    return body.includes('setProposal(null)') && !body.includes('Template(') &&
      !body.includes('request(');
  })());
ok('the proposal shows both halves: what changes and what is preserved',
  panel.includes('Will change') && panel.includes('Will preserve') &&
  panel.includes("data-testid='template-changes'") &&
  panel.includes("data-testid='template-preserved'"));
ok('every preserved line explains itself with the server\'s reason',
  panel.includes('{item.reason}'));
ok('a diff line is rendered as from -> to text, never as JSON',
  panel.includes('{change.from}') && panel.includes('{change.to}') &&
  !panel.includes('JSON.stringify'));
ok('warnings from the server are surfaced, not swallowed',
  panel.includes('proposal.warnings.map'));
ok('the panel says applying is undoable and non-final',
  /one step in history/iu.test(panel) && /starting point, not a mode/iu.test(panel));
ok('a project with no source is told why templates are unavailable',
  /Add a source video first/u.test(panel));

section('C. Saving is portable by default');
ok('asset binding is opt-in through two explicit checkboxes',
  panel.includes('Include current logo') && panel.includes('Include current music'));
ok('both checkboxes default to off',
  panel.includes('useState(false)') &&
  /const \[includeLogo, setIncludeLogo\] = useState\(false\)/u.test(panel) &&
  /const \[includeMusic, setIncludeMusic\] = useState\(false\)/u.test(panel));
ok('a checkbox is disabled when the project has no such asset',
  panel.includes('disabled={!hasLogo}') && panel.includes('disabled={!hasMusic}'));
ok('the panel states what a portable template does and does not carry',
  /saves your styling, not your files/iu.test(panel));
ok('the name field is bounded by the server\'s own limit',
  panel.includes('maxLength={library.limits.maxNameLength}'));
ok('the honest scope note from the server is displayed',
  panel.includes('{library.scopeNote}'));
ok('the saved-template count is shown against the server\'s limit',
  panel.includes('{library.limits.maxUserTemplates}'));

section('D. CRUD is wired');
for (const action of ['renameTemplate', 'duplicateTemplate', 'deleteTemplate',
  'saveTemplateFromProject', 'previewTemplate', 'applyTemplate', 'getTemplateLibrary']) {
  ok(`${action} is used by the panel`, panel.includes(action));
}
ok('a built-in offers duplicate but not rename or delete',
  (() => {
    const builtin = panel.slice(panel.indexOf('library.builtin.map'));
    const card = builtin.slice(0, builtin.indexOf('</div>'));
    return card.includes('onDuplicate=') && !card.includes('onRename=') &&
      !card.includes('onDelete=');
  })());
ok('a user template offers all four actions',
  (() => {
    const user = panel.slice(panel.indexOf('library.user.map'));
    const card = user.slice(0, user.indexOf('</div>'));
    return card.includes('onChoose=') && card.includes('onRename=') &&
      card.includes('onDuplicate=') && card.includes('onDelete=');
  })());
ok('the library is refreshed after every mutation',
  (panel.match(/await refresh\(\)/gu) ?? []).length >= 4);

section('E. Wiring');
ok('Templates is a live rail category, not a pending one',
  /\{ id: 'TEMPLATES', label: 'Templates' \}/u.test(rail) &&
  !/id: 'TEMPLATES'[^}]*pending/u.test(rail));
ok('the tool panel renders the templates panel',
  toolPanel.includes("tool === 'TEMPLATES'") && toolPanel.includes('EditTemplatesPanel'));
ok('an applied template is accepted exactly like a preset application',
  workspace.includes('const templateApplied') &&
  workspace.includes('acceptServerProject(result.project)'));
ok('APPLY_TEMPLATE counts as an undoable step in the history reader',
  timelineLib.includes("'APPLY_TEMPLATE'"));
ok('SET_TEXT_CASE counts as an undoable step too',
  timelineLib.includes("'SET_TEXT_CASE'"));

section('F. The client never writes canonical state itself');
ok('the template client only ever calls template endpoints',
  (lib.match(/request<[^>]*>\(`?\/edit-mode\/[^`']*/gu) ?? [])
    .every((call) => call.includes('/templates') || call.includes('/template/')));
ok('preview and apply both carry the revision, so a stale tab is refused',
  lib.includes('body: JSON.stringify({ revision, templateId })'));
ok('the panel builds no element and no command of its own',
  !panel.includes('EditElement') && !panel.includes('ManualEditCommand') &&
  !panel.includes('properties:'));

console.log(`\ntemplate UI: ${checks} assertions passed`);
