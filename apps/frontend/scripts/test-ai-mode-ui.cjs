const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const source = readFileSync(join(__dirname, '../src/components/upload-video-form.tsx'), 'utf8');

// Step 6 production model policy: OpenAI (default) or built-in rules. No local LLM.
const online = source.indexOf("value: 'ONLINE'");
const fallback = source.indexOf("value: 'FALLBACK_ONLY'");
assert(online >= 0 && fallback > online, 'selector must render AI (OpenAI) then Rules only');
assert(!source.includes("value: 'OFFLINE'"), 'the Offline/local AI option must be gone');
assert(!/Qwen|Ollama|local LLM|Offline AI/iu.test(source), 'no local LLM copy may remain');
assert(source.includes("useState<AiProcessingMode>('ONLINE')"),
  'new uploads default to OpenAI (which falls back to rules automatically)');
assert(source.includes("formData.append('aiMode', aiMode)"),
  'every upload must append the selected aiMode');
assert(source.includes("<input type='hidden' name='aiMode' value={aiMode} />"),
  'the live form payload must always contain the selected aiMode');
// Step 15: one product. The Normal/Edited fork is no longer asked at upload - the look is
// chosen after analysis. The job still records EDITED_CLIPS so the clip shape persists.
assert(source.includes("const processingType: ProcessingType = 'EDITED_CLIPS';"),
  'upload must not ask for a processing type');
assert(!/Normal Clips|Edited Clips|Processing Type<\/legend>/u.test(source),
  'the Normal/Edited product fork must be gone from the upload form');
assert(source.includes("formData.set('processingType', processingType)"),
  'upload must still send a processing type for older API contracts');
assert(source.includes("formData.set('aspectRatio', aspectRatio)"),
  'upload must send the selected aspect ratio');
assert(source.includes('Clip shape') && source.indexOf('Clip shape') <
  source.indexOf("<legend className='text-sm font-medium'>AI Processing Mode</legend>"),
  'the clip shape is chosen before AI mode and upload, for every upload');
assert(source.indexOf("<legend className='text-sm font-medium'>AI Processing Mode</legend>") <
  source.indexOf("<Label htmlFor='file'>Source video</Label>"),
  'mode cards must appear above the file input');
for (const value of ['role=\'radiogroup\'', "role='radio'", 'aria-checked={selected}',
  "event.key === 'Enter'", "event.key === ' '", 'sm:grid-cols-2', 'xl:grid-cols-3']) {
  assert(source.includes(value), `selector must include ${value}`);
}
for (const copy of [
  'Understands your video with OpenAI. Falls back to built-in rules automatically if AI is unavailable.',
  'Transcript, visual/audio analysis and deterministic editing. No AI model is used.'
]) assert(source.includes(copy), `selector must include exact copy: ${copy}`);

console.log('AI mode upload UI tests passed.');
