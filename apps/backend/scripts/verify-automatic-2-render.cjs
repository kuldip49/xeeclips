// Real-media acceptance for Automatic 2 without PostgreSQL/Redis/MinIO.
// Uses the canonical in-memory EditProject harness, the same style compiler,
// render planner, ASS builder and FFmpeg filtergraph as production.
process.env.EDIT_MODE_CHAT_PROPOSAL_REDIS = 'false';
process.env.EDIT_MODE_CHAT_AI_MODE = 'FALLBACK_ONLY';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { seedRichProject } = require('./lib-edit-mode-ai-fixture.cjs');
const { resolveCreativeStyle } = require('../dist/modules/edit-mode/styles/creative-style-resolver.js');
const { compileCreativeStyle } = require('../dist/modules/edit-mode/styles/creative-style-commands.js');
const { buildRenderPlan } = require('../dist/modules/edit-mode/render/edit-mode-render-plan.js');
const { buildEditModeAss } = require('../dist/modules/edit-mode/render/edit-mode-ass.js');
const { buildFfmpegArgs } = require('../dist/modules/edit-mode/render/edit-mode-filtergraph.js');

const root = path.resolve(__dirname, '../../..');
const bin = path.join(root, '.cache/ffmpeg-benchmark/ffmpeg-9.0.2-essentials_build/bin');
const ffmpeg = process.env.A2_FFMPEG || path.join(bin, 'ffmpeg.exe');
const ffprobe = process.env.A2_FFPROBE || path.join(bin, 'ffprobe.exe');
const source = process.argv[2] || path.join(root,
  '.real-qa-preview/final-camera-cleanup/real-talking-head-40s.mp4');
const outputDir = path.join(root, process.env.A2_OUT || '.real-qa-preview/automatic-2');
fs.mkdirSync(outputDir, { recursive: true });
if (!process.env.A2_FFMPEG) {
  fs.cpSync(path.join(root, '.real-qa-preview/fonts'), path.join(outputDir, 'fonts'), { recursive: true });
}

const json = (value) => JSON.parse(JSON.stringify(value));
const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format',
  '-of', 'json', source], { encoding: 'utf8' }));
const video = probe.streams.find((stream) => stream.codec_type === 'video');
const hasAudio = probe.streams.some((stream) => stream.codec_type === 'audio');

function slicedElements(elements, start, end) {
  const duration = end - start;
  return elements.flatMap((element) => {
    if (element.type === 'IMAGE' || element.type === 'AUDIO') return [];
    if (element.type === 'EFFECT') {
      const elementEnd = element.startTime + element.duration;
      if (element.startTime < start || elementEnd > end) return [];
      return [{ ...element, startTime: element.startTime - start }];
    }
    if (element.type === 'VIDEO') return [{ ...element, startTime: 0, duration,
      trimStart: start, trimEnd: end, position: 0 }];
    const role = String(element.properties.presetRole ?? element.properties.templateRole ?? '');
    if (element.type === 'TEXT') {
      if (role !== 'HOOK' && role !== 'KEY_POINT') return [];
      return [{ ...element, startTime: 0,
        duration }];
    }
    if (element.type === 'SUBTITLE') {
      const elementEnd = element.startTime + element.duration;
      if (element.startTime < start || elementEnd > end) return [];
      return [{ ...element, startTime: element.startTime - start }];
    }
    return [];
  });
}

async function main() {
  assert(process.env.A2_FFMPEG || (fs.existsSync(ffmpeg) && fs.existsSync(ffprobe)), 'FFmpeg tools are required');
  assert(fs.existsSync(source), `source not found: ${source}`);
  const fixture = await seedRichProject({ split: false });
  // Generated short-form clips enter the style phase with the requested output aspect already set.
  const seeded = await fixture.refresh();
  await fixture.service.applyAssistantBundle(fixture.id, seeded.revision, {
    proposalId: 'automatic-1-portrait-baseline', summary: 'Set requested output aspect',
    userMessage: 'portrait output', actor: 'SYSTEM_ACTION', onInvalid: 'FAIL',
    commands: [{ kind: 'SETTINGS', payload: { aspectRatio: '9:16' } }]
  });
  if (process.env.A2_HOOK) {
    const cur = await fixture.refresh();
    const hookEl = cur.elements.find((e) => e.type === 'TEXT' &&
      String(e.properties.presetRole ?? e.properties.templateRole ?? '') === 'HOOK');
    if (hookEl) {
      await fixture.service.applyAssistantBundle(fixture.id, cur.revision, {
        proposalId: 'a2-hook-override', summary: 'hook override', userMessage: 'hook',
        actor: 'SYSTEM_ACTION', onInvalid: 'FAIL',
        commands: [{ kind: 'ELEMENT', action: 'SET_TEXT_CONTENT',
          payload: { elementId: hookEl.id, content: process.env.A2_HOOK } }] });
    }
  }
  const before = await fixture.refresh();
  const baseline = {
    settings: json(before.settings),
    video: json(before.elements.filter((element) => element.type === 'VIDEO')),
    effects: json(before.elements.filter((element) => element.type === 'EFFECT')),
    audio: json(before.elements.filter((element) => element.type === 'AUDIO'))
  };
  const { context } = await fixture.chat.loadContext(fixture.id, 'apply Automatic 2', {});
  const resolved = resolveCreativeStyle({ templateId: 'AUTOMATIC_2' });
  const hooks = [
    { text: 'Why Are Interest Rates Still So High?', style: 'question' },
    { text: 'The Hidden Cost Mortgage Holders Pay Every Month', style: 'strong claim' },
    { text: 'Savings Accounts Quietly Pay More Now', style: 'value' }
  ];
  const compiled = compileCreativeStyle(resolved, context, { hookOptions: hooks,
    hasWordTimings: true });
  const applied = await fixture.service.applyAssistantBundle(fixture.id, before.revision, {
    proposalId: 'automatic-2-real-media', summary: 'Apply Automatic 2',
    userMessage: 'Automatic 2', commands: compiled.commands,
    actor: 'TEMPLATE_ACTION', onInvalid: 'FAIL'
  });
  const after = applied.project;
  const policyParity = Object.fromEntries(
    ['aspectRatio', 'gradingPolicy', 'pacing', 'subtitlePolicy', 'musicPolicy'].map((key) => [key,
      JSON.stringify(baseline.settings[key]) === JSON.stringify(after.settings[key])])
  );
  const videoBase = (elements) => elements.filter((element) => element.type === 'VIDEO')
    .map((element) => ({ id: element.id, track: element.track, position: element.position,
      startTime: element.startTime, duration: element.duration, trimStart: element.trimStart,
      trimEnd: element.trimEnd, speed: element.properties.speed,
      crop: element.properties.crop, color: element.properties.color,
      sourceVolume: element.properties.sourceVolume,
      sourceMuted: element.properties.sourceMuted }));
  const unchanged = {
    videoTimelineAndLook: JSON.stringify(videoBase(baseline.video)) ===
      JSON.stringify(videoBase(after.elements)),
    audio: JSON.stringify(baseline.audio) === JSON.stringify(after.elements.filter((e) => e.type === 'AUDIO')),
    automatic1BasePolicies: Object.values(policyParity).every(Boolean)
  };
  assert(Object.values(unchanged).every(Boolean),
    `Automatic 2 changed shared edit behaviour: ${Object.entries(unchanged)
      .filter(([, value]) => !value).map(([key]) => key).join(', ')} ${JSON.stringify(policyParity)}`);
  const sourceAsset = after.assets.find((asset) => asset.role === 'SOURCE');
  const previewCameraPath = after.settings.resolvedVisualLayout?.cameraPath ?? [];
  assert(previewCameraPath.length > 1,
    'Automatic 2 did not persist the canonical camera path used by preview');
  Object.assign(sourceAsset, { width: video.width, height: video.height,
    fps: Number(video.r_frame_rate.split('/')[0]) / Number(video.r_frame_rate.split('/')[1]),
    duration: Number(probe.format.duration), metadata: { hasAudio } });
  const ranges = [[0, 12], [12, 24], [24, 36]];
  const outputs = [];
  for (const [index, [start, end]] of ranges.entries()) {
    const built = buildRenderPlan({ project: after, assets: [sourceAsset],
      elements: slicedElements(after.elements, start, end), hasSourceAudio: hasAudio,
      fps: 30 });
    assert.equal(built.plan.canvas.width, 1080);
    assert.equal(built.plan.canvas.height, 1920);
    assert.equal(built.plan.canvas.visualLayout.videoFrame.mode, 'CARD');
    assert.equal(built.evidence.faceSafetyViolations, 0,
      `automatic-2-${index + 1} has a face-safety violation`);
    const street3 = require('../dist/modules/edit-mode/styles/automatic-2-street3-layout.js')
      .AUTOMATIC_2_STREET3_LAYOUT;
    const cardH = Math.round(street3.mediaBox.height * 1920 / 2) * 2;
    assert(built.evidence.cameraFilter.includes(`scale=1080:${cardH}`),
      `Automatic 2 camera was not solved at the street3 media-window aspect (1080:${cardH})`);
    const frameGeom = built.plan.canvas.visualLayout.videoFrame;
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.equal(frameGeom[key], street3.mediaBox[key], `media window ${key} drifted from street3`);
    }
    assert.equal(built.plan.canvas.visualLayout.background.color, '#000000');
    assert(built.plan.zoomEvents.length <= 1, 'a 12-second Automatic 2 clip exceeded its zoom budget');
    assert(built.plan.zoomEvents.every((event) => event.endSec - event.startSec >= 2.5 - 1e-6 &&
      event.peakScale >= 1.06 && event.peakScale <= 1.15),
    'Automatic 2 emitted a short or excessive zoom');
    const previewCrop = previewCameraPath.reduce((closest, keyframe) =>
      Math.abs(keyframe.t - (start + 6)) < Math.abs(closest.t - (start + 6))
        ? keyframe : closest, previewCameraPath[0]);
    const exportCrop = built.evidence.cropAt(6);
    for (const axis of ['x', 'y', 'w', 'h']) {
      assert(Math.abs(previewCrop[axis] - exportCrop[axis]) < .002,
        `preview/export camera mismatch on ${axis} for automatic-2-${index + 1}`);
    }
    assert(built.plan.zoomEvents.every((event) => Number.isFinite(event.focusX) &&
      Number.isFinite(event.focusY)), 'Automatic 2 zoom did not persist its preview focal point');
    const ass = buildEditModeAss(built.plan.canvas,
      [...built.plan.textOverlays, ...built.plan.subtitles]);
    assert(ass.content.includes('EB Garamond'), 'EB Garamond did not reach ASS');
    assert(ass.content.includes('&H00F0B7&'),
      'lime active-caption colour did not reach ASS');
    const stem = `automatic-2-${index + 1}`;
    const assPath = path.join(outputDir, `${stem}.ass`);
    const output = path.join(outputDir, `${stem}.mp4`);
    fs.writeFileSync(assPath, ass.content);
    const args = buildFfmpegArgs({ plan: built.plan, sourcePath: source,
      overlayPaths: {}, audioPaths: {}, assFileName: path.basename(assPath), outputPath: output, ...(process.env.A2_FFMPEG ? {} : { fontsDir: 'fonts' }),
      informationCrop: built.evidence.informationCrop, fitExpression: built.evidence.fitExpression,
      informationFitExpression: built.evidence.informationFitExpression,
      cameraFilter: built.evidence.cameraFilter });
    execFileSync(ffmpeg, args, { cwd: outputDir, stdio: 'inherit' });
    const frames = [];
    const sampleTimes = new Map([['start', .5], ['middle', 6], ['end', 11]]);
    built.plan.zoomEvents.forEach((event, zoomIndex) => {
      sampleTimes.set(`zoom-${zoomIndex + 1}-before`, Math.max(.05, event.startSec - .1));
      sampleTimes.set(`zoom-${zoomIndex + 1}-during`, (event.peakStartSec + event.peakEndSec) / 2);
      sampleTimes.set(`zoom-${zoomIndex + 1}-after`, Math.min(11.95, event.endSec + .1));
    });
    built.evidence.speakerSegments.slice(1).forEach((segment, switchIndex) =>
      sampleTimes.set(`switch-${switchIndex + 1}`, Math.min(11.95, segment.startSec + .05)));
    for (const [label, at] of sampleTimes) {
      const frame = path.join(outputDir, `${stem}-${label}.png`);
      execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', String(at), '-i', output,
        '-frames:v', '1', frame]);
      assert(fs.statSync(frame).size > 10000, `${frame} is blank or missing`);
      frames.push(frame);
    }
    const { cameraPath: _cameraPath, ...visualLayoutSummary } = built.plan.canvas.visualLayout;
    outputs.push({ output, frames, durationSec: built.plan.durationSec,
      videoSegments: built.plan.videoSegments, zoomEvents: built.plan.zoomEvents,
      grading: built.plan.grading, sourceAudio: built.plan.audioTracks.find((track) => track.kind === 'SOURCE'),
      visualLayout: { ...visualLayoutSummary, cameraPathKeyframes: previewCameraPath.length },
      previewExportParity: true, assEvents: ass.eventCount,
      faceSafetyViolations: built.evidence.faceSafetyViolations,
      cameraMoves: built.evidence.cameraMoves,
      zoomLog: built.plan.zoomEvents.map((event) => ({ start: event.startSec, end: event.endSec,
        duration: Number((event.endSec - event.startSec).toFixed(3)), scale: event.peakScale,
        reason: event.reason, focusTrackId: event.focusTrackId })),
      speakerSwitchLog: built.evidence.speakerSegments?.map((segment) => ({
        start: segment.startSec, end: segment.endSec, trackId: segment.trackId,
        confidence: segment.confidence })) ?? [],
      overflowed: ass.overflowed, parityNotes: ass.parityNotes });
    assert.equal(ass.overflowed.length, 0,
      `${stem} has clipped text: ${ass.overflowed.map((id) => {
        const overlay = built.plan.textOverlays.find((item) => item.elementId === id)
          ?? built.plan.subtitles.find((item) => item.elementId === id);
        return `${id} (${overlay?.content ?? 'unknown'})`;
      }).join(', ')}`);
  }
  const report = { source, reference: { width: 1080, height: 1920, durationSec: 21.478 },
    templateId: resolved.templateId, compiledActions: compiled.commands.map((command) => command.action),
    unchanged, automatic2Policy: { reframePolicy: after.settings.reframePolicy,
      zoomPolicy: after.settings.zoomPolicy,
      zoomElementCount: after.elements.filter((element) => element.type === 'EFFECT').length }, outputs };
  fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
