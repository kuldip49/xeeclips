const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (path) => readFileSync(join(__dirname, '../../frontend/src', path), 'utf8');
const panel = read('components/clip-creation-panel.tsx');
const upload = read('components/upload-video-form.tsx');

// Upload page: platform + video only (plus AI mode); no output type, ratio, or duration controls.
for (const label of ['Create Short Clips', 'Target platform', 'Upload Video',
  'Maximum video length: 2 hours']) assert(upload.includes(label), `upload UI must include ${label}`);
for (const platform of ['INSTAGRAM_REELS', 'YOUTUBE_SHORTS', 'TIKTOK'])
  assert(upload.includes(platform), `upload UI must offer ${platform}`);
for (const removed of ['processingType', 'aspectRatio', 'Processing Type', 'minDuration'])
  assert(!upload.includes(removed), `upload UI must not include ${removed}`);

// Post-analysis: output style + clip counter only.
for (const label of ['Analysis complete', 'Your video is ready.', 'Output style', 'Normal Clips',
  'AI Edited Clips', 'Maximum clips for this video:', 'Number of clips', 'Create ${count} Clip',
  'created from this video.'])
  assert(panel.includes(label), `clip panel must include ${label}`);

// Result cards: Hook, Synopsis, Caption, Hashtags in order, then the AI mode line.
let previous = -1;
for (const section of ["title='Hook'", "title='Synopsis'", "title='Caption'", "title='Hashtags'",
  'AI mode used: {clip.aiModeUsed}']) {
  const index = panel.indexOf(section);
  assert(index > previous, `${section} must appear in the clip-card order`);
  previous = index;
}

// No scoring, tiers, recommendations, providers, or duration controls in the user flow.
for (const source of [panel, upload]) {
  for (const banned of [/recommend/iu, /potential/iu, /PRIMARY/u, /SECONDARY/u, /score/iu,
    /confidence/iu, /Minimum seconds/iu, /Maximum seconds/iu, /GPT/u, /Ollama/iu, /OpenAI/iu,
    /Qwen/iu, /Luna/u, /1–12/u])
    assert(!banned.test(source), `user flow must not contain ${banned}`);
}

// Normal workspace: no Source details, stage/chunk/understanding panels, scores or telemetry.
const workspace = read('components/project-workspace.tsx');
const projectPage = read('app/projects/[id]/page.tsx');
for (const banned of [/Source details/u, /ChunksPanel/u, /VideoUnderstandingPanel/u,
  /TranscriptPanel/u, /ProcessingPipeline/u, /Processing details/u, /Media details/u,
  /score/iu, /confidence/iu, /telemetry/iu, /provider/iu, /importance/iu, /tier/iu])
  assert(!banned.test(workspace), `workspace must not contain ${banned}`);
// Developer diagnostics exist only behind an explicit server flag that defaults off.
assert.match(workspace, /developerDiagnostics = false/u);
assert.match(workspace, /\{developerDiagnostics \? \(\s*<DeveloperDiagnostics/u);
assert.match(projectPage, /developerDiagnostics=\{process\.env\.SHOW_DEVELOPER_DIAGNOSTICS\?\.toLowerCase\(\) === 'true'\}/u);
assert(!/NEXT_PUBLIC_SHOW/u.test(projectPage), 'the flag is server-side, not baked into the bundle');

// Backend request state drives progress; QUEUED counts as in progress.
assert(panel.includes("requestStatus === 'QUEUED' || requestStatus === 'RENDERING'"));
assert(panel.includes('request?.returnedClipCount'), 'progress count comes from the backend');
assert(!/setResults\(null\)/u.test(panel), 'results are refreshed from the backend, not cleared locally');

console.log(JSON.stringify({ platformFirstUpload: true, outputStyleAfterAnalysis: true,
  clipCounterOnly: true, cleanClipCards: true, noDiagnosticsInWorkspace: true,
  backendRenderState: true }));
