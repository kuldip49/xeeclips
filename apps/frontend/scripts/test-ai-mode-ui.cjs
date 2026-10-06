/**
 * Mode choice on the one-step Create form: XeeFree (built-in rules, FALLBACK_ONLY) or XeePro
 * (OpenAI, ONLINE). There is no local LLM. Every upload and YouTube import carries the chosen
 * mode, and restored settings never silently upgrade a XeeFree job to the paid AI path.
 * The pure rules are loaded from the shipped module; the markup contract is asserted against
 * source, like the other UI tests. Offline and deterministic.
 */
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = join(__dirname, '..');
require.extensions['.ts'] = (mod, filename) => {
  const js = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  mod._compile(js, filename);
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@/')) {
    const base = join(root, 'src', request.slice(2));
    for (const candidate of [`${base}.ts`, `${base}.tsx`]) if (existsSync(candidate)) return candidate;
  }
  return resolve.call(this, request, ...rest);
};

const read = (relative) => readFileSync(join(root, relative), 'utf8');
const form = read('src/components/upload-video-form.tsx');
const api = read('src/lib/api.ts');
const entry = require(join(root, 'src/lib/entry-flow.ts'));

let checks = 0;
const ok = (condition, label) => { assert(condition, label); checks += 1; };

// --- Options: exactly XeeFree then XeePro, no local/offline AI --------------------------
const free = form.indexOf("{ value: 'FALLBACK_ONLY', title: 'XeeFree'");
const pro = form.indexOf("{ value: 'ONLINE', title: 'XeePro'");
ok(free >= 0 && pro > free, 'the form offers XeeFree then XeePro');
ok(!form.includes("value: 'OFFLINE'"), 'the Offline/local AI option is gone');
ok(!/Qwen|Ollama|local LLM|Offline AI/iu.test(form), 'no local LLM copy remains');
ok(/ONLINE: 'XeePro',\s*OFFLINE: 'XeeFree',\s*FALLBACK_ONLY: 'XeeFree'/u.test(api),
  'labels: ONLINE is XeePro; FALLBACK_ONLY and the legacy OFFLINE are both XeeFree');

// --- Accessible native radios, chosen before Generate -----------------------------------
ok(form.includes("<input type='radio' className='sr-only' name={`entry-mode-${formKey}`} checked={selected}") &&
  form.includes('onChange={() => update({ aiMode: option.value })}'),
  'modes are native radios in one named group, so clicks, keys and screen readers work');
ok(form.includes('data-entry-mode={option.value}') && /data-entry-mode[\s\S]{0,200}focus-within:ring-2/u.test(form),
  'each mode card is a full-card label with a visible focus ring');
const modeLegend = form.indexOf("text-sm font-medium'>Mode</legend>");
ok(modeLegend > 0 && modeLegend < form.indexOf("type='submit'"), 'the mode is chosen before the Generate button');

// --- Defaults and restore ----------------------------------------------------------------
ok(entry.DEFAULT_ENTRY_SETTINGS.aiMode === 'ONLINE', 'new creations default to XeePro');
const restored = (aiMode) => entry.settingsFromImport({ aiMode, autoGeneration: null }).aiMode;
ok(restored('FALLBACK_ONLY') === 'FALLBACK_ONLY', 'a XeeFree import restores as XeeFree');
ok(restored('OFFLINE') === 'FALLBACK_ONLY', 'a legacy OFFLINE import restores as XeeFree, never as paid XeePro');
ok(restored('ONLINE') === 'ONLINE', 'a XeePro import restores as XeePro');

// --- Every request carries the mode --------------------------------------------------------
ok(form.includes("formData.set('aiMode', settings.aiMode);"), 'every upload sends the selected aiMode');
ok(form.includes("formData.set('processingType', 'EDITED_CLIPS');"),
  'uploads still send a processing type for older API contracts, without asking for one');
ok(form.includes("formData.set('aspectRatio', settings.aspectRatio);"), 'uploads send the selected clip shape');
ok(/importYouTubeVideo\(\{ projectId: target, url: sourceUrl\.trim\(\), aiMode: settings\.aiMode,/u.test(form),
  'YouTube imports send the selected aiMode too');
ok(!/Normal Clips|Edited Clips|Processing Type<\/legend>/u.test(form), 'the Normal/Edited product fork is gone');

console.log(`AI mode upload UI tests passed (${checks} checks).`);
