/**
 * Professional timeline UX (Workstream E).
 *
 * Everything the timeline decides is in pure modules — the track model, the
 * magnet, the trim/move geometry, the waveform reduction and the thumbnail
 * layout — so all of it can be exercised here without a browser. The markup
 * contracts that keep the B.5 virtualization intact (a playhead tick must not
 * touch the mounted blocks, a pointer move must not issue a command) are
 * asserted against the component sources, the same way
 * test-timeline-virtualization.cjs does it.
 *
 * Offline, deterministic, and it leaves nothing behind.
 */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

const root = join(__dirname, '..');

// One require hook rather than a bespoke loader, so a module that imports
// another module (gestures -> timeline) resolves it the ordinary way.
require.extensions['.ts'] = (mod, filename) => {
  const js = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  mod._compile(js, filename);
};
const lib = (name) => require(join(root, 'src/lib', name));

const tracks = lib('edit-mode-tracks.ts');
const snap = lib('edit-mode-timeline-snap.ts');
const gestures = lib('edit-mode-timeline-gestures.ts');
const waveform = lib('edit-mode-waveform.ts');
const thumbs = lib('edit-mode-thumbnails.ts');
const viewport = lib('edit-mode-viewport.ts');

let checks = 0;
const ok = (label, condition) => { assert(condition, label); checks += 1; };
const section = (title) => console.log(`\n${title}`);

const element = (id, startTime, duration, type = 'SUBTITLE', properties = {}, over = {}) => ({
  id, editProjectId: 'p', type,
  track: type === 'VIDEO' ? 0 : type === 'SUBTITLE' ? 1 : 2,
  position: 0, startTime, duration, trimStart: 0, trimEnd: null, properties, ...over
});

// --- A. The track model ------------------------------------------------------

section('A. Track model');
ok('there is one row per editable layer: video, text, captions, images, music',
  tracks.TIMELINE_TRACKS.map((track) => track.id).join(',') ===
    'VIDEO,TEXT,SUBTITLE,IMAGE,AUDIO');
ok('every track name is a plain editing word, not a data-model word',
  tracks.TIMELINE_TRACKS.every((track) => /^[A-Z][a-z]+$/u.test(track.label)));
ok('footage is not hideable - hiding it would restack a sequential track',
  tracks.trackById('VIDEO').canHide === false);
ok('...and it is not freely draggable either',
  tracks.trackById('VIDEO').canDragFreely === false);
ok('text, captions and images hide but do not mute',
  ['TEXT', 'SUBTITLE', 'IMAGE'].every((id) =>
    tracks.trackById(id).canHide && !tracks.trackById(id).canMute));
ok('music mutes but does not hide',
  tracks.trackById('AUDIO').canMute && !tracks.trackById('AUDIO').canHide);
ok('only the two tracks with real media carry a media decoration',
  tracks.TIMELINE_TRACKS.filter((track) => track.media).map((track) => track.media).join(',') ===
    'THUMBNAILS,WAVEFORM');

const mixed = [element('a', 0, 1, 'TEXT', { hidden: true }), element('b', 2, 1, 'TEXT')];
ok('a half-hidden track reports MIXED', tracks.trackHidden(mixed) === 'MIXED');
ok('a fully hidden track reports ALL',
  tracks.trackHidden(mixed.map((item) => ({ ...item, properties: { hidden: true } }))) === 'ALL');
ok('an untouched track reports NONE',
  tracks.trackHidden(mixed.map((item) => ({ ...item, properties: {} }))) === 'NONE');
ok('an empty track reports EMPTY, so its toggles can be disabled rather than lying',
  tracks.trackHidden([]) === 'EMPTY');
ok('MIXED resolves to "on" in one click rather than guessing',
  tracks.nextToggle('MIXED') === true && tracks.nextToggle('ALL') === false &&
  tracks.nextToggle('NONE') === true);
ok('an element with no stored flags reads visible and unlocked',
  !tracks.isHidden(element('x', 0, 1)) && !tracks.isLocked(element('x', 0, 1)));
ok('a locked element refuses timeline editing',
  !tracks.canEdit(element('x', 0, 1, 'TEXT', { locked: true })) &&
  tracks.canEdit(element('x', 0, 1, 'TEXT')));
ok('a VIDEO parked off track 0 belongs to no row rather than being mislaid',
  tracks.trackForElement(element('v', 0, 1, 'VIDEO', {}, { track: 3 })) === null);
ok('the video track is ordered by position, not by array order',
  tracks.trackElements([
    element('v2', 5, 5, 'VIDEO', {}, { position: 1 }),
    element('v1', 0, 5, 'VIDEO', {}, { position: 0 })
  ], tracks.trackById('VIDEO')).map((item) => item.id).join(',') === 'v1,v2');

// --- B. Snapping -------------------------------------------------------------

section('B. Snap / magnet');
const scene = [
  element('v1', 0, 10, 'VIDEO'),
  element('t1', 4, 2, 'TEXT'),
  element('c1', 4, 1, 'SUBTITLE'),
  element('a1', 7, 3, 'AUDIO')
];
const candidates = snap.snapCandidates(scene, { playheadSec: 6, durationSec: 10 });
ok('candidates come back sorted by time',
  candidates.every((item, index) => index === 0 || item.atSec >= candidates[index - 1].atSec));
ok('two elements sharing a second produce ONE candidate, not two',
  candidates.filter((item) => item.atSec === 4).length === 1);
ok('the playhead is a candidate', candidates.some((item) => item.kind === 'PLAYHEAD'));
ok('both project ends are candidates',
  candidates.filter((item) => item.kind === 'PROJECT').length === 2);
ok('every element kind that is not shadowed by a project edge is represented',
  ['TEXT', 'CAPTION', 'AUDIO'].every((kind) => candidates.some((item) => item.kind === kind)));
ok('a clip boundary in the middle of the timeline is a CLIP candidate',
  snap.snapCandidates([element('v1', 0, 10, 'VIDEO'), element('v2', 10, 10, 'VIDEO')],
    { playheadSec: 3, durationSec: 20 }).some((item) => item.kind === 'CLIP' && item.atSec === 10));
ok('a clip edge that coincides with the project start is reported as the project edge',
  candidates.find((item) => item.atSec === 0).kind === 'PROJECT');
ok('the dragged element is excluded, so a clip cannot snap to itself',
  !snap.snapCandidates(scene, { playheadSec: 6, durationSec: 10, excludeIds: ['a1'] })
    .some((item) => item.kind === 'AUDIO'));

// The load-bearing claim: the threshold is PIXELS, so it narrows in seconds as
// the timeline zooms in. A fixed time threshold would be useless at high zoom.
const far = snap.snapSeconds(4.2, candidates, 10);
const near = snap.snapSeconds(4.2, candidates, 100);
ok('at 10 px/s a 0.2s gap is inside the 8px threshold and snaps',
  far.seconds === 4 && far.guide.atSec === 4);
ok('at 100 px/s the same 0.2s gap is 20px away and does NOT snap',
  near.seconds === 4.2 && near.guide === null);
ok('a snap reports the candidate it hit, so a guide can be drawn for it',
  far.guide.kind === 'CAPTION' || far.guide.kind === 'TEXT');
ok('turning snap off returns the raw value with no guide',
  snap.snapSeconds(4.02, candidates, 100, { enabled: false }).seconds === 4.02 &&
  snap.snapSeconds(4.02, candidates, 100, { enabled: false }).guide === null);
ok('the playhead wins a tie against an element edge at the same distance',
  snap.snapSeconds(6, snap.snapCandidates([element('t', 6, 1, 'TEXT')],
    { playheadSec: 6, durationSec: 10 }), 50).guide.kind === 'PLAYHEAD');
ok('nothing within reach means no snap and no guide',
  snap.snapSeconds(5.5, candidates, 400).guide === null);

// A dense project must not make snapping slow: the candidate list is built once
// per gesture and searched, not rescanned.
const dense = Array.from({ length: 400 }, (_, index) =>
  element(`cap-${index}`, index * 0.75, 0.7, 'SUBTITLE'));
const denseCandidates = snap.snapCandidates(dense, { playheadSec: 12, durationSec: 300 });
const started = Date.now();
for (let index = 0; index < 5000; index += 1) {
  snap.snapSeconds(index % 300, denseCandidates, 40);
}
const elapsed = Date.now() - started;
ok(`5000 snap lookups over 400 captions stay well under a frame budget (${elapsed}ms)`,
  elapsed < 250);

// --- C. Trim, move and split geometry ---------------------------------------

section('C. Trim / move / split');
const clip = element('v', 4, 6, 'VIDEO', {}, { trimStart: 2, trimEnd: 8 });
ok('dragging a clip\'s right edge later extends the source window',
  gestures.trimVideo(clip, 'right', 11, 30).trimEnd === 9);
ok('...and is capped by the source\'s real length',
  gestures.trimVideo(clip, 'right', 400, 12).trimEnd === 12);
ok('dragging a clip\'s left edge later moves trimStart, not startTime',
  gestures.trimVideo(clip, 'left', 5, 30).trimStart === 3);
ok('...and never past the tail, leaving at least the minimum duration',
  gestures.trimVideo(clip, 'left', 99, 30).duration >= 0.05 - 1e-9);
ok('a clip can never be trimmed to a negative source position',
  gestures.trimVideo(clip, 'left', -50, 30).trimStart === 0);
const fast = element('v', 0, 3, 'VIDEO', { speed: 2 }, { trimStart: 0, trimEnd: 6 });
ok('a 2x clip consumes two source seconds per timeline second when trimmed',
  gestures.trimVideo(fast, 'right', 4, 30).trimEnd === 8);
ok('...and its timeline duration follows the rate, not the raw source window',
  gestures.trimVideo(fast, 'right', 4, 30).duration === 4);

const music = element('a', 5, 4, 'AUDIO', {}, { trimStart: 10, trimEnd: 14 });
const shortened = gestures.trimSpan(music, 'left', 6, 20);
ok('shortening a music clip from the left advances its read window',
  shortened.startTime === 6 && shortened.trimStart === 11);
ok('...so the music does not restart from a different place', shortened.duration === 3);
ok('shortening it from the right shortens the read window instead',
  gestures.trimSpan(music, 'right', 7, 20).trimEnd === 12);
const caption = element('c', 5, 2, 'SUBTITLE');
ok('a caption has no source, so a trim leaves its trim fields alone',
  gestures.trimSpan(caption, 'left', 6, 20).trimStart === 0);
ok('an element cannot be trimmed below the minimum span',
  Math.abs(gestures.trimSpan(caption, 'right', 5, 20).duration - gestures.MIN_SPAN_SEC) < 1e-9);
ok('a trim cannot push an element past the end of the project',
  gestures.trimSpan(caption, 'right', 999, 20).startTime +
    gestures.trimSpan(caption, 'right', 999, 20).duration === 20);

ok('a move keeps the element\'s length', gestures.moveSpan(caption, 12, 20).duration === 2);
ok('a move clamps at the head of the timeline',
  gestures.moveSpan(caption, -5, 20).startTime === 0);
ok('a move clamps so the tail stays inside the project',
  gestures.moveSpan(caption, 19.5, 20).startTime === 18);

ok('Split explains itself when nothing is selected',
  gestures.splitAvailability(null, 3).reason.includes('Select'));
ok('Split refuses a locked element and says why',
  gestures.splitAvailability(element('c', 0, 4, 'SUBTITLE', { locked: true }), 2)
    .reason.includes('locked'));
ok('Split refuses an image, which has no cut to make',
  !gestures.splitAvailability(element('i', 0, 4, 'IMAGE'), 2).canSplit);
ok('Split refuses a playhead outside the element',
  !gestures.splitAvailability(clip, 100).canSplit);
ok('Split refuses a playhead right on the edge, as the server would',
  !gestures.splitAvailability(clip, 4).canSplit);
ok('Split is offered inside a clip', gestures.splitAvailability(clip, 7).canSplit);
ok('Split refuses a one-word caption, as the server would',
  !gestures.splitAvailability(element('c', 0, 4, 'SUBTITLE', { content: 'Hello' }), 2).canSplit);
ok('Split is offered inside a multi-word caption',
  gestures.splitAvailability(element('c', 0, 4, 'SUBTITLE', { content: 'Hello there' }), 2)
    .canSplit);

// --- D. Waveforms ------------------------------------------------------------

section('D. Waveforms');
const samples = new Float32Array(1000);
for (let index = 0; index < samples.length; index += 1) samples[index] = index < 500 ? 0.1 : 0;
samples[250] = 0.9;
const peaks = waveform.peaksFromSamples(samples, 10);
ok('a whole asset reduces to a fixed number of buckets, whatever its length',
  peaks.length === 10 && waveform.peaksFromSamples(new Float32Array(10 ** 6)).length ===
    waveform.WAVEFORM_BUCKETS);
ok('a bucket keeps its PEAK, so a transient stays visible at any zoom',
  peaks[2] === Math.fround(0.9));
ok('silence reduces to zero', peaks[9] === 0);
ok('a peak is never above full scale',
  waveform.peaksFromSamples(new Float32Array([4, -9]), 1)[0] === 1);

const stored = { peaks: waveform.peaksFromSamples(samples, 100), durationSec: 10 };
ok('a window asks for at most the columns it was given',
  waveform.peakWindow(stored, { fromSec: 0, toSec: 10, columns: 40 }).length === 40);
ok('the column count is capped however wide the caller asks for',
  waveform.peakWindow(stored, { fromSec: 0, toSec: 10, columns: 99999 }).length ===
    waveform.MAX_WAVEFORM_COLUMNS);
ok('the loud half of the asset reads loud',
  waveform.peakWindow(stored, { fromSec: 0, toSec: 5, columns: 10 }).every((value) => value > 0));
ok('the silent half reads silent',
  waveform.peakWindow(stored, { fromSec: 5, toSec: 10, columns: 10 })
    .every((value) => value === 0));
ok('a window past the end of the asset is zero rather than an error',
  waveform.peakWindow(stored, { fromSec: 50, toSec: 60, columns: 4 })
    .every((value) => value === 0));
ok('the size gate is documented as a real number, not a vague "too big"',
  waveform.WAVEFORM_MAX_BYTES === 48 * 1024 * 1024);

// --- E. Thumbnails -----------------------------------------------------------

section('E. Thumbnail strip');
const blocks = [
  { id: 'v1', assetId: 'src', startTime: 0, duration: 60, trimStart: 5, speed: 1 },
  { id: 'v2', assetId: 'src', startTime: 60, duration: 60, trimStart: 100, speed: 1 }
];
const view = viewport.createViewport({ pxPerSecond: 24, scrollLeft: 0, viewportWidth: 960,
  duration: 120, overscanSec: 5 });
const slots = thumbs.thumbnailSlots(blocks, view);
ok('only the visible range is laid out, not the whole project',
  slots.length > 0 && slots.every((slot) => slot.leftPx / 24 <= view.windowEndSec + 1e-6));
ok('the number of frames is bounded for one paint', slots.length <= thumbs.MAX_SLOTS);
ok('a frame maps through the segment\'s own trim, not raw timeline time',
  slots[0].sourceSec === 5);
const doubled = thumbs.thumbnailSlots(
  [{ id: 'v', assetId: 'src', startTime: 0, duration: 60, trimStart: 0, speed: 2 }], view);
ok('a 2x segment advances through the source twice as fast',
  doubled[1].sourceSec === thumbs.THUMBNAIL_QUANTUM_SEC *
    Math.round((thumbs.THUMBNAIL_WIDTH_PX / 24) * 2 / thumbs.THUMBNAIL_QUANTUM_SEC));
ok('frame times are quantized, so a small scroll reuses cached frames',
  slots.every((slot) => Math.abs(slot.sourceSec / thumbs.THUMBNAIL_QUANTUM_SEC -
    Math.round(slot.sourceSec / thumbs.THUMBNAIL_QUANTUM_SEC)) < 1e-9));

// Scrolling by less than one frame width must not reshuffle the strip: slots
// are aligned to the block's own grid rather than to the viewport's left edge.
const scrolled = viewport.createViewport({ pxPerSecond: 24, scrollLeft: 30, viewportWidth: 960,
  duration: 120, overscanSec: 5 });
const scrolledSlots = thumbs.thumbnailSlots(blocks, scrolled);
const sharedKeys = new Set(slots.map((slot) => slot.key));
ok('a small scroll reuses the frames already laid out',
  scrolledSlots.filter((slot) => sharedKeys.has(slot.key)).length > scrolledSlots.length / 2);
ok('a block with no asset contributes nothing rather than a broken frame',
  thumbs.thumbnailSlots([{ id: 'x', assetId: null, startTime: 0, duration: 10, trimStart: 0 }],
    view).length === 0);
ok('a bounded fallback: asking for more than the cap simply stops',
  thumbs.thumbnailSlots(blocks, viewport.createViewport({ pxPerSecond: 400, scrollLeft: 0,
    viewportWidth: 1920, duration: 120, overscanSec: 5 })).length <= thumbs.MAX_SLOTS);
ok('the frame cache is bounded and disposable', thumbs.CACHE_LIMIT > 0 &&
  typeof thumbs.clearThumbnailCache === 'function' &&
  typeof waveform.clearWaveformCache === 'function');
// A browser will not load media in a background tab. Treating that as a hard
// failure would blank the strip for the whole session; it has to be retryable.
const thumbSource = readFileSync(join(root, 'src/lib/edit-mode-thumbnails.ts'), 'utf8');
ok('a timed-out decode is retryable while an errored one is not',
  thumbSource.includes('{ retry: true }') && thumbSource.includes('{ failed: true }'));
ok('a hidden tab stops the queue and resumes when the tab is looked at',
  thumbSource.includes('resumeWhenVisible()') && thumbSource.includes("document.hidden"));

// --- F. Component contracts --------------------------------------------------

section('F. Component contracts');
const read = (relative) => readFileSync(join(root, relative), 'utf8');
const timeline = read('src/components/edit-mode/edit-timeline.tsx');
const toolbar = read('src/components/edit-mode/edit-timeline-toolbar.tsx');
const header = read('src/components/edit-mode/edit-timeline-track-header.tsx');
const media = read('src/components/edit-mode/edit-timeline-media.tsx');
const workspace = read('src/components/edit-mode/edit-mode-workspace.tsx');

// B.5 must survive: the mounted lane tree may not depend on the playhead.
const laneDeps = timeline.slice(timeline.indexOf('const laneNodes = useMemo('));
const laneDepArray = laneDeps.slice(laneDeps.indexOf('}), ['), laneDeps.indexOf(']);') + 3);
ok('the mounted lanes are still a useMemo', laneDeps.startsWith('const laneNodes = useMemo('));
ok('a playhead tick cannot re-render the mounted blocks',
  !laneDepArray.includes('currentPlayheadSec'));
ok('the lanes still window every track through windowElements',
  timeline.includes('windowElements(items, viewport'));
ok('a selected or multi-selected element stays mounted when it scrolls away',
  timeline.includes('[selectedElementId, ...selectionSet]'));
ok('tracks still publish mounted-vs-total counts for DOM measurement',
  timeline.includes('data-mounted={mounted.length}') && timeline.includes('data-total={items.length}'));
ok('the playhead is still its own memoized component',
  /const Playhead = memo\(/u.test(timeline));
ok('the ruler is memoized too, so a tick does not rebuild the ticks',
  /const Ruler = memo\(/u.test(timeline));
ok('blocks are still memoized', /const TimelineBlock = memo\(/u.test(timeline));
ok('a block is NOT given the viewport, so scrolling cannot re-render 400 captions',
  !/TimelineBlock = memo\(function TimelineBlock\(\{[^}]*viewport/su.test(timeline));

// One gesture, one command.
for (const [name, handler] of [['trim', 'const beginEdge'], ['drag', 'const pressBlock']]) {
  const body = timeline.slice(timeline.indexOf(handler));
  const moveBody = body.slice(body.indexOf('const move = (pointer: PointerEvent) => {'),
    body.indexOf('const up = () => {'));
  ok(`a ${name} issues no canonical command per pointer move`,
    !moveBody.includes('onCommitTrim(') && !moveBody.includes('onCommitTiming(') &&
    !moveBody.includes('onMoveTo('));
  ok(`a ${name} previews locally while the pointer is down`,
    moveBody.includes('onPreviewElements(') || moveBody.includes('pushOverlay('));
}
const upBody = timeline.slice(timeline.indexOf('const beginEdge'));
ok('a completed trim commits exactly once, on release',
  upBody.slice(upBody.indexOf('const up = () => {')).includes('onCommitTrim('));

// Snapping, locking and the tools are wired, not decorative.
ok('the timeline snaps through the pixel-threshold helper',
  timeline.includes('snapSeconds(seconds, candidates, live.current.viewport.pxPerSecond'));
ok('a visible snap guide is drawn when, and only when, a candidate won',
  timeline.includes("data-testid='timeline-snap-guide'") && timeline.includes('overlay.guide &&'));
ok('snap can be turned off', timeline.includes('snapEnabled') && toolbar.includes('onToggleSnap'));
ok('holding Shift escapes the magnet for one gesture',
  timeline.includes('pointer.shiftKey'));
ok('a locked element refuses trim', /const beginEdge[\s\S]{0,400}canEdit\(element\)/u.test(timeline));
ok('a locked element refuses drag and split',
  /const pressBlock[\s\S]{0,900}canEdit\(element\)/u.test(timeline));
ok('the split tool cuts where it was clicked, through the canonical dispatcher',
  timeline.includes("live.current.tool === 'SPLIT'") && timeline.includes('onSplitAt(element.id, at)'));
ok('Ctrl/Cmd-click builds a multi-selection, and never on the sequential video track',
  timeline.includes("additive && element.type !== 'VIDEO'"));
ok('the first Ctrl-click carries the already-selected element into the selection',
  timeline.includes('item.id === live.current.selectedElementId') &&
  timeline.includes("anchor.type !== 'VIDEO'"));
ok('dragging footage reorders it rather than sliding it into an overlap',
  timeline.includes('onMoveTo(element.id, dropPosition)'));
ok('...and shows where it will land', timeline.includes("data-testid='timeline-drop-indicator'"));
ok('the ruler seeks and scrubs', timeline.includes('const beginScrub') &&
  timeline.includes("data-testid='timeline-ruler'"));
ok('range selection on empty lane space is preserved',
  timeline.includes('const beginRange') && timeline.includes('onSelectRange({ startSec'));

// Track headers offer only what they can honour.
ok('a header renders hide only for a track that can hide',
  header.includes('{track.canHide &&') && header.includes('{track.canMute &&'));
ok('every track can be locked, so lock is unconditional',
  header.split('canHide').length === 2 && /Toggle label=\{`Lock/u.test(header));
ok('a mixed track is shown as mixed rather than as a lie',
  header.includes("mixed={hidden === 'MIXED'}"));
ok('an EMPTY track lights no toggle - it is not hidden, muted or locked',
  header.includes("state === 'ALL' || state === 'MIXED'") &&
  header.includes('on={active(hidden)}') && header.includes('on={active(locked)}') &&
  header.includes('on={active(muted)}'));
ok('a track toggle resolves to ONE command covering the whole track',
  timeline.includes("elementType: track.elementType, visible: !on") &&
  timeline.includes("elementType: track.elementType, locked: on"));
ok('captions reuse their own existing bulk visibility command',
  timeline.includes("action: 'set-captions-visible'"));
ok('the video track mutes the source audio, it does not hide the footage',
  timeline.includes("action: 'set-source-audio-muted'"));

// The toolbar uses ordinary words.
for (const label of ['Split', 'Delete', 'Duplicate', 'Snap', 'Zoom in', 'Zoom out', 'Fit',
  'Select', 'Undo', 'Redo']) {
  ok(`the toolbar offers "${label}"`, toolbar.includes(`label='${label}'`));
}
ok('no editor jargon leaks into a label',
  !/label='[^']*(mutation|normaliz|element id|canonical)/iu.test(toolbar));
ok('Split explains itself when it is unavailable instead of going silent',
  toolbar.includes('hint={splitHint}') && timeline.includes('splitAvailability(selected'));
ok('the toolbar shows the zoom level and the current time',
  toolbar.includes("data-testid='timeline-zoom'") && toolbar.includes("data-testid='timeline-clock'"));
ok('a multi-selection is reported', toolbar.includes("data-testid='timeline-selection-count'"));

// Scrolling, zooming and fit.
ok('Ctrl/Cmd + wheel still zooms around the cursor',
  timeline.includes('scrollForZoom(current, next, anchorOffsetPx'));
ok('Fit still uses the shared fit calculation', timeline.includes('fitPxPerSecond('));
ok('+ and - zoom, and Escape clears the selection, without fighting text inputs',
  timeline.includes("input, textarea, select, [contenteditable=\"true\"]") &&
  timeline.includes("event.key === '+'") && timeline.includes("event.key === 'Escape'"));
ok('vertical track scrolling is written to the DOM, not to React state',
  timeline.includes('headerRef.current.style.transform'));
ok('the header column is a real column beside the lanes, not a label over them',
  timeline.includes('HEADER_COLUMN_PX'));

// Media decorations stay off the critical path and out of the DOM.
ok('thumbnails are requested after the render that laid them out, never during it',
  media.includes('setTimeout(() => requestThumbnails('));
ok('a waveform is drawn on a canvas, not as hundreds of DOM nodes',
  media.includes('<canvas') && media.includes('peakWindow('));
ok('a waveform covers only the visible slice of its block',
  media.includes('viewport.visibleStartSec') && media.includes('MAX_WAVEFORM_COLUMNS'));
ok('an undecodable or oversized asset degrades to a plain band and says why',
  media.includes("state.status === 'UNAVAILABLE'") && media.includes('title={state.reason}'));
ok('neither decoration writes canonical state',
  !media.includes('onCommand') && !media.includes('applyCommand'));

// Workspace wiring.
ok('the workspace dispatches a split to the right canonical command per type',
  workspace.includes("action: 'split-caption'") && workspace.includes("action: 'split'"));
ok('group actions run as a sequence of ordinary commands, with no new mutation path',
  workspace.includes('const applySequence'));
ok('a locked element is dropped from a toolbar or keyboard action',
  workspace.includes("element.properties.locked !== true"));
ok('the multi-selection is pruned when elements disappear',
  workspace.includes('const alive = current.filter'));
ok('Ctrl/Cmd+D duplicates, and other browser chords are left alone',
  workspace.includes("event.key.toLowerCase() === 'd'") &&
  workspace.includes('// Every other Ctrl/Cmd chord belongs to the browser.'));
ok('the timeline band keeps its share of the editor and can be collapsed',
  workspace.includes('timelineCollapsed') && workspace.includes("h-[38vh] min-h-[248px]"));

// The band has to fit the shortest screen the editor targets.
// 34vh of 1080 is 367px of band; the toolbar takes ~36px and the surface's own
// border ~2px, so the five rows have to fit in roughly 325px there. At 768 the
// same sum is ~225px, which the rows exceed on purpose - that is what the
// surface's vertical scroll and the collapse toggle are for.
// Measured in the browser, not guessed: at a 794px viewport the 38vh band is
// 302px and the scrolling surface inside it is 233px, so the toolbar, padding,
// gap and borders cost 69px. The five rows plus the 24px ruler need 236px.
const BAND_CHROME_PX = 69;
const RULER_PX = 24;
const surfaceAt = (viewportHeight) =>
  Math.max(248, Math.round(viewportHeight * 0.38)) - BAND_CHROME_PX;
const needed = tracks.tracksHeightPx() + RULER_PX;
ok(`every track row is reachable without scrolling on a tall screen ` +
  `(${needed}px of rows in ${surfaceAt(1024)}px of surface)`, needed <= surfaceAt(1024));
// At 1366x768 the rows genuinely exceed the surface by a little. That is not a
// layout failure: it is why the surface is a scroller and why the band can be
// collapsed. Asserting it here stops the shortfall growing unnoticed.
const shortfall = needed - surfaceAt(768);
ok(`on a 1366x768 screen the surface is short by a small, scrollable margin ` +
  `(${shortfall}px)`, shortfall > 0 && shortfall <= 24);
ok('...so the surface scrolls vertically and the band can be collapsed',
  timeline.includes("className='relative min-h-0 flex-1 overflow-auto'") &&
  timeline.includes('onToggleCollapsed'));
ok('the band stays inside the 30-40% editor-workspace proportion',
  workspace.includes('h-[38vh]'));
ok('the band can be dragged taller or shorter, and remembers the size per browser',
  workspace.includes("aria-label='Resize timeline'") && workspace.includes('TIMELINE_HEIGHT_KEY'));
ok('the editor opens on a captioned frame of the clip, not frame 0',
  workspace.includes('openingFrameSet') && workspace.includes("element.type === 'SUBTITLE'"));
ok('the timeline is a sibling of the preview, never an overlay on it',
  workspace.includes('shrink-0 overflow-hidden border-t'));

console.log(`\ntimeline UX: ${checks} assertions passed`);
console.log(`  track rows: ${tracks.TIMELINE_TRACKS.map((track) =>
  `${track.label} ${track.heightPx}px`).join(', ')} = ${tracks.tracksHeightPx()}px`);
console.log(`  snap candidates for a 400-caption project: ${denseCandidates.length}`);
console.log(`  thumbnail slots for a 120s project at 24px/s in a 960px band: ${slots.length}`);
