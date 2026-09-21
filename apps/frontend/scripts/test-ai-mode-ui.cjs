const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const source = readFileSync(join(__dirname, '../src/components/upload-video-form.tsx'), 'utf8');

const fallback = source.indexOf("value: 'FALLBACK_ONLY'");
const offline = source.indexOf("value: 'OFFLINE'");
const online = source.indexOf("value: 'ONLINE'");
assert(fallback >= 0 && fallback < offline && offline < online,
  'selector must render Fallback Only, Offline AI, then Online AI');
assert(source.includes("useState<AiProcessingMode>('FALLBACK_ONLY')"),
  'frontend default must be FALLBACK_ONLY');
assert(source.includes("formData.append('aiMode', aiMode)"),
  'every upload must append the selected aiMode');
assert(source.includes("<input type='hidden' name='aiMode' value={aiMode} />"),
  'the live form payload must always contain the selected aiMode');
assert(source.includes("useState<ProcessingType>('NORMAL_CLIPS')"),
  'processing type must default to normal clips');
assert(source.includes("formData.set('processingType', processingType)"),
  'upload must send the selected processing type');
assert(source.includes("formData.set('aspectRatio', aspectRatio)"),
  'upload must send the selected aspect ratio');
assert(source.indexOf("<legend className='text-sm font-medium'>Processing Type</legend>") <
  source.indexOf("<legend className='text-sm font-medium'>AI Processing Mode</legend>"),
  'processing type must be chosen before AI mode and upload');
for (const copy of ['Normal Clips', 'Edited Clips',
  'Find and generate the best clips without automatic video editing.',
  'Find the best clips and automatically enhance them with smart editing.']) {
  assert(source.includes(copy), `processing type selector must include ${copy}`);
}
assert(source.indexOf("<legend className='text-sm font-medium'>AI Processing Mode</legend>") <
  source.indexOf("<Label htmlFor='file'>Source video</Label>"),
  'mode cards must appear above the file input');
for (const value of ['role=\'radiogroup\'', "role='radio'", 'aria-checked={selected}',
  "event.key === 'Enter'", "event.key === ' '", 'sm:grid-cols-2', 'xl:grid-cols-3']) {
  assert(source.includes(value), `selector must include ${value}`);
}
for (const copy of [
  'Uses transcript, visual/audio analysis, and deterministic processing. No LLM is used.',
  'Uses local Qwen3 4B through Ollama. No cloud AI is used.',
  'Uses OpenAI GPT-5.6 Luna.'
]) assert(source.includes(copy), `selector must include exact copy: ${copy}`);

console.log('AI mode upload UI tests passed.');
