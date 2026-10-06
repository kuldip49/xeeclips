/**
 * EditMode AI editor panel (Workstream G), frontend side.
 *
 * The panel's decisions are pure functions in lib/edit-mode-chat.ts and are
 * exercised directly. The contracts that matter - the browser never sees or
 * sends commands, the selection/range/playhead travel with every message, a
 * proposal shows Current -> Proposed rather than JSON, and Change never leaves
 * a stale proposal behind - are asserted against the component source, the
 * same way the other EditMode UI tests do it.
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

const chat = require(join(root, 'src/lib/edit-mode-chat.ts'));
const read = (relative) => readFileSync(join(root, relative), 'utf8');
const panel = read('src/components/edit-mode/edit-chat-panel.tsx');
const rightPanel = read('src/components/edit-mode/shell/edit-right-panel.tsx');
const api = read('src/lib/edit-mode-api.ts');

let checks = 0;
const ok = (label, condition) => { assert(condition, label); checks += 1; console.log(`  ok  ${label}`); };
const section = (title) => console.log(`\n${title}`);

const element = (type, properties = {}) => ({ id: 'e1', type, track: 1, position: 0,
  startTime: 0, duration: 3, trimStart: 0, trimEnd: null, assetId: null, properties });

section('1. What the AI sees');
ok('a preset-role hook is named "Hook"',
  chat.selectionName(element('TEXT', { presetRole: 'HOOK', content: 'Why rates stay high' })) ===
    'Hook "Why rates stay high"');
ok('a template stamp that still carries the role is read too',
  chat.selectionName(element('TEXT', { templateRole: 'TEXT', presetRole: 'CTA' }))
    .startsWith('Call to action'));
ok('plain text, captions, logos, music and zooms get everyday names',
  chat.selectionName(element('TEXT', { content: 'Hi' })) === 'Text "Hi"' &&
  chat.selectionName(element('SUBTITLE', { content: 'Welcome back' })) === 'Caption "Welcome back"' &&
  chat.selectionName(element('IMAGE', { role: 'LOGO' })) === 'Logo' &&
  chat.selectionName(element('AUDIO')) === 'Music' &&
  chat.selectionName(element('EFFECT', { effect: 'ZOOM' })) === 'Zoom' &&
  chat.selectionName(element('VIDEO')) === 'Video segment');
ok('long wording is shortened, never dumped',
  chat.selectionName(element('TEXT', { content: 'x'.repeat(200) })).length < 45);
ok('the context line names selection, range and playhead',
  chat.contextLine({ selected: element('IMAGE', { role: 'LOGO' }),
    range: { startSec: 12, endSec: 15.5 }, playheadSec: 14.26 }) ===
    'Logo · 12.0s–15.5s selected · playhead 14.3s');
ok('with nothing selected it still states the playhead',
  chat.contextLine({ selected: null, range: null, playheadSec: 0 }) === 'playhead 0.0s');

section('2. Proposal rows');
const rows = chat.changeRows({ plannedChanges: [], changes: [
  { label: 'Hook', before: '"Why Raise Rates When Inflation Is Still High?"',
    after: '"Why Are Rates Still So High?"' },
  { label: 'Music volume', before: '20%', after: '14%' }] });
ok('wording changes render as Current / Proposed', rows[0].wording === true);
ok('value changes render as before -> after', rows[1].wording === false &&
  rows[1].before === '20%' && rows[1].after === '14%');
ok('a proposal with no structured changes falls back to its sentences',
  chat.changeRows({ plannedChanges: ['Split the video at 3.0s'] }).length === 0 &&
  panel.includes('proposal.plannedChanges.map'));

section('3. Change / Apply / Cancel');
ok('Change on a written hook asks for another version',
  chat.changeAction({ route: 'CREATIVE_DETERMINISTIC', userMessage: 'change the hook' }).kind ===
    'ANOTHER' && chat.changeAction({ route: 'CREATIVE_LLM', userMessage: 'x' }).message ===
    'try another');
ok('Change on a direct edit hands the words back to the composer',
  JSON.stringify(chat.changeAction({ route: 'DETERMINISTIC', userMessage: 'move the logo down' })) ===
    JSON.stringify({ kind: 'EDIT', draft: 'move the logo down' }));
ok('Change cancels the pending proposal first, so nothing stale can be applied',
  /const change = useCallback[\s\S]*?await cancel\(true\)/u.test(panel));
ok('the card has Apply, Change and Cancel',
  /'Apply'/u.test(panel) && /Change<\/button>/u.test(panel) && /Cancel<\/button>/u.test(panel));

section('4. Contracts');
ok('Apply sends only the proposal id - commands never leave the server',
  /applyEditChat\(projectId, proposal\.proposalId, revision\)/u.test(panel) &&
  /body: JSON\.stringify\(\{ proposalId, revision \}\)/u.test(api));
const panelCode = panel.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$|\{\/\*[\s\S]*?\*\/\}/gmu, '');
ok('no command JSON or handle is rendered',
  !/commands|payload|JSON\.stringify|handle/u.test(panelCode));
ok('selection, range and playhead travel with every plan request',
  /planEditChat\(projectId, \{ message, revision, selectedElementId,\s*selectedTimeRange, playheadSec \}\)/u
    .test(panel));
ok('the right panel mounts the AI editor agent with the selected element',
  /<EditAgentPanel[\s\S]*?selected=\{selected\}/u.test(rightPanel));

section('5. Step 7/8 agent panel');
const agentPanel = read('src/components/edit-mode/edit-agent-panel.tsx');
const agentCode = agentPanel.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$|\{\/\*[\s\S]*?\*\/\}/gmu, '');
ok('the agent receives consent, selection, range, playhead, autonomy and task rules',
  /runEditAgent\(projectId, \{ message, revision, aiConsent: true, selectedElementId,\s*selectedTimeRange, playheadSec, autonomy, constraints \}\)/u.test(agentPanel));
// aiConsent is only honest because the agent cannot mount before the user allows Ask AI.
const consentGate = rightPanel.indexOf("if (consent !== 'granted') return");
ok('Ask AI asks for consent before the agent panel exists',
  consentGate > 0 && consentGate < rightPanel.indexOf('const chat = <EditAgentPanel') &&
  /localStorage\.setItem\(ASK_AI_CONSENT_KEY, 'allowed'\)/u.test(rightPanel) &&
  /Allow Ask AI/u.test(rightPanel) && /Ask AI is off/u.test(rightPanel));
ok('the ledger shows every clause with status and verification',
  /agent-ledger/u.test(agentPanel) && /verified/u.test(agentPanel) && /Needs your OK/u.test(agentPanel));
ok('held destructive work needs an explicit "Yes, do it"', /Yes, do it/u.test(agentPanel));
ok('simple autonomy choice: ask before major changes / edit automatically',
  /Ask before major changes/u.test(agentPanel) && /Edit automatically/u.test(agentPanel));
ok('task rules are offered as toggles (crop, cuts, caption wording)',
  /Don't change crop/u.test(agentPanel) && /Keep cuts/u.test(agentPanel) &&
  /Don't touch caption wording/u.test(agentPanel));
ok('no command JSON, ids or handles are rendered by the agent panel',
  !/payload|toolCalls|handle|elementId\}/u.test(agentCode));
ok('an honest AI-unavailable note is shown when AI is down', /agent-ai-note/u.test(agentPanel));
ok('suggestions are everyday words, not command names',
  chat.CHAT_SUGGESTIONS.every((line) => !/[A-Z]{2,}_[A-Z]/u.test(line)) &&
  chat.CHAT_SUGGESTIONS.includes('Music is too loud'));

console.log(`\nEditMode AI editor panel: ${checks} checks passed`);
