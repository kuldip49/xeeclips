/**
 * Timeline virtualization (Workstream B.5).
 *
 * The windowing rules live in src/lib/edit-mode-viewport.ts as pure functions so
 * they can be exercised without a DOM. This script transpiles that module with
 * the workspace's own TypeScript and asserts the visible-window maths, the
 * half-open intersection rule, overscan, a 400-caption dataset, offscreen
 * selection, speed-altered timing and reordered video timelines. The markup
 * contract that keeps the mounted set bounded is asserted against the component
 * source, the same way test-clip-creation-ui.cjs does it.
 */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = join(__dirname, '..');
const load = (relative) => {
  const source = readFileSync(join(root, relative), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const mod = new Module(relative, null);
  mod.filename = join(root, relative);
  mod.paths = Module._nodeModulePaths(root);
  mod._compile(js, mod.filename);
  return mod.exports;
};

const viewport = load('src/lib/edit-mode-viewport.ts');
const timeline = load('src/lib/edit-mode-timeline.ts');
const {
  createViewport, intersectsRange, windowElements, fitPxPerSecond, clampPxPerSecond,
  scrollForZoom, scrollToReveal, rulerTicks, tickStepSec, DEFAULT_OVERSCAN_SEC,
  MIN_PX_PER_SEC, MAX_PX_PER_SEC
} = viewport;

const element = (id, startTime, duration, type = 'SUBTITLE', extra = {}) => ({
  id, editProjectId: 'p', type, track: type === 'VIDEO' ? 0 : 1,
  position: 0, startTime, duration, trimStart: 0, trimEnd: null, properties: {}, ...extra
});
const ids = (list) => list.map((item) => item.id);

// --- A. Visible-window calculation ------------------------------------------
// The brief's worked example: 300s project, viewport showing 30–55s, overscan 5
// => the mounted window is exactly 25–60s.
const at30 = createViewport({ pxPerSecond: 20, scrollLeft: 30 * 20, viewportWidth: 25 * 20,
  duration: 300, overscanSec: 5 });
assert.equal(at30.visibleStartSec, 30, 'scroll offset must map to the visible start second');
assert.equal(at30.visibleEndSec, 55, 'viewport width must map to the visible end second');
assert.equal(at30.windowStartSec, 25, 'window must extend one overscan before the visible start');
assert.equal(at30.windowEndSec, 60, 'window must extend one overscan past the visible end');
assert.equal(at30.contentWidthPx, 6000);
assert.equal(at30.maxScrollLeft, 6000 - 500);

// The window never runs negative at the head of the timeline.
const atHead = createViewport({ pxPerSecond: 20, scrollLeft: 0, viewportWidth: 500, duration: 300 });
assert.equal(atHead.windowStartSec, 0, 'window start must clamp at zero');
assert.ok(atHead.windowEndSec >= 25 + DEFAULT_OVERSCAN_SEC);

// Scroll is clamped to the scrollable range rather than trusted blindly.
const overScrolled = createViewport({ pxPerSecond: 20, scrollLeft: 99999, viewportWidth: 500, duration: 300 });
assert.equal(overScrolled.scrollLeft, overScrolled.maxScrollLeft);
assert.equal(overScrolled.visibleEndSec, 300, 'clamped scroll must land on the timeline end');

// Zoom is bounded, and degenerate input falls back rather than producing NaN.
assert.equal(clampPxPerSecond(0), viewport.DEFAULT_PX_PER_SEC);
assert.equal(clampPxPerSecond(Number.NaN), viewport.DEFAULT_PX_PER_SEC);
assert.equal(clampPxPerSecond(1e9), MAX_PX_PER_SEC);
assert.equal(clampPxPerSecond(0.0001), MIN_PX_PER_SEC);
assert.ok(Number.isFinite(createViewport({ pxPerSecond: Number.NaN, scrollLeft: Number.NaN,
  viewportWidth: Number.NaN, duration: Number.NaN }).windowEndSec));

// --- B. Overlap / intersection logic ----------------------------------------
// Spans are half-open: [start, start + duration).
assert.equal(intersectsRange(10, 5, 15, 20), false, 'an element ending exactly at the window start is out');
assert.equal(intersectsRange(10, 5, 14.9, 20), true);
assert.equal(intersectsRange(20, 5, 10, 20), false, 'an element starting exactly at the window end is out');
assert.equal(intersectsRange(19.9, 5, 10, 20), true);
assert.equal(intersectsRange(12, 1, 10, 20), true, 'fully contained is in');
assert.equal(intersectsRange(0, 1000, 400, 410), true, 'a span straddling the window is in');
// A zero-length element has no interior, so containment is inclusive on both ends.
assert.equal(intersectsRange(20, 0, 10, 20), true);
assert.equal(intersectsRange(20.1, 0, 10, 20), false);
// Nonsense durations must not mount everything.
assert.equal(intersectsRange(100, -5, 0, 10), false);

// --- C. Overscan -------------------------------------------------------------
const overscanView = createViewport({ pxPerSecond: 10, scrollLeft: 1000, viewportWidth: 500,
  duration: 600, overscanSec: 5 });
assert.equal(overscanView.visibleStartSec, 100);
assert.equal(overscanView.visibleEndSec, 150);
assert.ok(overscanView.windowStartSec <= 95 && overscanView.windowEndSec >= 155,
  'the quantized window must always contain the raw overscan window');
// Quantization onto the overscan grid means small scrolls do not change the
// mounted set: both of these sit inside the same grid cell.
const nudgeA = createViewport({ pxPerSecond: 10, scrollLeft: 1003, viewportWidth: 500,
  duration: 600, overscanSec: 5 });
const nudgeB = createViewport({ pxPerSecond: 10, scrollLeft: 1009, viewportWidth: 500,
  duration: 600, overscanSec: 5 });
assert.notEqual(nudgeA.visibleStartSec, nudgeB.visibleStartSec, 'the fixtures must differ');
assert.equal(nudgeA.windowStartSec, nudgeB.windowStartSec,
  'a sub-grid scroll must reuse the same window so the mounted set is stable');
assert.equal(nudgeA.windowEndSec, nudgeB.windowEndSec);
const travelled = createViewport({ pxPerSecond: 10, scrollLeft: 1000 + 200, viewportWidth: 500,
  duration: 600, overscanSec: 5 });
assert.ok(travelled.windowStartSec > overscanView.windowStartSec,
  'travelling a full grid cell must move the window');

// --- D. The 400-caption dataset ---------------------------------------------
// 300s of video carrying 400 captions plus 60 overlays and a music bed: the
// shape that made the old timeline unusable.
const captions = Array.from({ length: 400 }, (unused, index) =>
  element(`caption-${index}`, index * 0.75, 0.7));
const overlays = Array.from({ length: 60 }, (unused, index) =>
  element(`overlay-${index}`, index * 5, 3, 'IMAGE'));
const music = [element('music-0', 0, 300, 'AUDIO')];
const videos = [
  element('video-0', 0, 100, 'VIDEO', { track: 0, position: 0 }),
  element('video-1', 100, 100, 'VIDEO', { track: 0, position: 1 }),
  element('video-2', 200, 100, 'VIDEO', { track: 0, position: 2 })
];
const project = [...videos, ...captions, ...overlays, ...music];
assert.equal(timeline.timelineDuration(project), 300, 'the dataset must be a 300s timeline');

const band = createViewport({ pxPerSecond: 24, scrollLeft: 120 * 24, viewportWidth: 960,
  duration: 300, overscanSec: 5 });
const mountedCaptions = windowElements(captions, band, []);
assert.ok(mountedCaptions.length > 0, 'the visible band must mount captions');
assert.ok(mountedCaptions.length <= 80,
  `mounted captions must be bounded by the viewport, got ${mountedCaptions.length}`);
assert.ok(mountedCaptions.length < captions.length / 5,
  'mounted captions must be a small fraction of the 400 canonical captions');
// Every mounted caption really does intersect the window, and every unmounted
// one really does not: windowing drops nothing that should be on screen.
const inWindow = captions.filter((item) =>
  intersectsRange(item.startTime, item.duration, band.windowStartSec, band.windowEndSec));
assert.deepEqual(ids(mountedCaptions), ids(inWindow));
assert.ok(mountedCaptions.every((item) =>
  item.startTime < band.windowEndSec && item.startTime + item.duration > band.windowStartSec));
// Canonical state is untouched — windowing is a read, not an edit.
assert.equal(captions.length, 400);
assert.equal(project.length, 400 + 60 + 3 + 1);
// The other tracks window off the same viewport.
assert.ok(windowElements(overlays, band, []).length < overlays.length);
assert.equal(windowElements(music, band, []).length, 1, 'a bed spanning the window stays mounted');
assert.equal(windowElements(videos, band, []).length, 1,
  'only the video segment under the viewport mounts');

// Scrolling to the far end mounts the tail, not the head.
const tail = createViewport({ pxPerSecond: 24, scrollLeft: 1e9, viewportWidth: 960, duration: 300 });
const tailCaptions = windowElements(captions, tail, []);
assert.ok(tailCaptions.length > 0 && tailCaptions.length <= 80);
assert.equal(tailCaptions.some((item) => item.id === 'caption-0'), false);
assert.equal(tailCaptions.at(-1).id, 'caption-399');

// --- E. A selected element that is off screen -------------------------------
const selectedId = 'caption-399';
assert.equal(windowElements(captions, band, []).some((item) => item.id === selectedId), false,
  'the fixture must really be off screen for this to mean anything');
const withSelection = windowElements(captions, band, [selectedId]);
assert.equal(withSelection.some((item) => item.id === selectedId), true,
  'a selected element must stay mounted after it scrolls out of the window');
assert.equal(withSelection.length, mountedCaptions.length + 1,
  'keeping the selection must not mount anything else');
// Null/undefined/absent ids are ignored rather than mounting anything extra.
assert.equal(windowElements(captions, band, [null, undefined, '']).length, mountedCaptions.length);
assert.equal(windowElements(captions, band, ['does-not-exist']).length, mountedCaptions.length);
// Order is preserved, so a re-selected element does not jump in the DOM.
assert.deepEqual(ids(withSelection), ids(captions.filter((item) =>
  item.id === selectedId || intersectsRange(item.startTime, item.duration,
    band.windowStartSec, band.windowEndSec))));

// --- F. Range selection ------------------------------------------------------
// A dragged range is a time span, so the same intersection rule answers "which
// elements does this range cover" — independently of what is mounted.
const range = { startSec: 30, endSec: 45 };
const covered = captions.filter((item) =>
  intersectsRange(item.startTime, item.duration, range.startSec, range.endSec));
assert.ok(covered.length >= 19 && covered.length <= 21, `expected ~20 captions in 30–45s, got ${covered.length}`);
assert.ok(covered.every((item) => item.startTime + item.duration > 30 && item.startTime < 45));
// The range stays meaningful when it is entirely outside the mounted window.
const farRange = { startSec: 280, endSec: 290 };
assert.ok(captions.filter((item) =>
  intersectsRange(item.startTime, item.duration, farRange.startSec, farRange.endSec)).length > 0,
  'a range outside the viewport must still resolve against canonical state');

// --- G. Timeline zoom --------------------------------------------------------
assert.equal(fitPxPerSecond(960, 300), clampPxPerSecond(3.2));
// The editor opens on a bounded working span, not on "fit": opening a dense
// 300s project at fit is what mounted all 400 captions on first paint.
assert.equal(viewport.initialPxPerSecond(960, 300), clampPxPerSecond(960 / viewport.INITIAL_VISIBLE_SEC));
assert.ok(viewport.initialPxPerSecond(960, 300) > fitPxPerSecond(960, 300),
  'a long project must open zoomed in, not fitted');
assert.equal(viewport.initialPxPerSecond(960, 10), fitPxPerSecond(960, 10),
  'a project shorter than the working span opens fitted');
assert.equal(viewport.initialPxPerSecond(0, 300), viewport.DEFAULT_PX_PER_SEC);
// A generated short (58s) opens with the whole clip in view, not half of it.
assert.equal(viewport.initialPxPerSecond(1400, 58), fitPxPerSecond(1400, 58),
  'a short clip opens fitted');
const opened = createViewport({ pxPerSecond: viewport.initialPxPerSecond(960, 300), scrollLeft: 0,
  viewportWidth: 960, duration: 300 });
assert.ok(windowElements(captions, opened, []).length <= 60,
  `the opening view must mount a bounded set, got ${windowElements(captions, opened, []).length}`);
assert.equal(fitPxPerSecond(960, 0), viewport.DEFAULT_PX_PER_SEC);
assert.equal(fitPxPerSecond(0, 300), viewport.DEFAULT_PX_PER_SEC);
// Zooming in mounts fewer elements, zooming out mounts more, and neither
// touches canonical state.
const zoomedIn = createViewport({ pxPerSecond: 96, scrollLeft: 120 * 96, viewportWidth: 960, duration: 300 });
const zoomedOut = createViewport({ pxPerSecond: 6, scrollLeft: 120 * 6, viewportWidth: 960, duration: 300 });
assert.ok(windowElements(captions, zoomedIn, []).length < mountedCaptions.length);
assert.ok(windowElements(captions, zoomedOut, []).length > mountedCaptions.length);
assert.equal(captions.length, 400);
// Fit mounts everything by definition — that is the one zoom where the whole
// project is genuinely on screen, and it is bounded by zooming back in.
const fitted = createViewport({ pxPerSecond: fitPxPerSecond(960, 300), scrollLeft: 0,
  viewportWidth: 960, duration: 300 });
assert.equal(windowElements(captions, fitted, []).length, 400);
// Zooming holds the time under the anchor still.
const anchored = scrollForZoom(band, band.pxPerSecond * 1.5, 400);
const afterZoom = createViewport({ pxPerSecond: band.pxPerSecond * 1.5, scrollLeft: anchored,
  viewportWidth: 960, duration: 300 });
const before = (band.scrollLeft + 400) / band.pxPerSecond;
const after = (afterZoom.scrollLeft + 400) / afterZoom.pxPerSecond;
assert.ok(Math.abs(before - after) < 0.01, `zoom must hold the anchor second, drifted ${Math.abs(before - after)}`);
assert.ok(scrollForZoom(band, 1e9, 400) <= 300 * MAX_PX_PER_SEC, 'zoom scroll stays inside the content');
assert.ok(scrollForZoom(band, 0.00001, 400) >= 0);

// Reveal only scrolls when the target is actually outside the visible range.
assert.equal(scrollToReveal(band, band.visibleStartSec + 10), null, 'an on-screen second must not scroll');
assert.ok(scrollToReveal(band, 5) != null, 'an off-screen second must scroll');
assert.equal(scrollToReveal(band, 5) >= 0, true);
assert.ok(scrollToReveal(band, 1e6) <= band.maxScrollLeft);

// Ruler ticks are windowed and spaced, not one per second of a long project.
assert.ok(tickStepSec(2) > tickStepSec(200), 'a coarser zoom must use a coarser tick step');
assert.ok(rulerTicks(band).length <= 30, `ruler ticks must stay bounded, got ${rulerTicks(band).length}`);
assert.ok(rulerTicks(band).every((tick) => tick >= band.windowStartSec - 1 && tick <= band.windowEndSec));
assert.ok(rulerTicks(fitted).every((tick) => tick <= 300), 'ticks must not run past the timeline end');

// --- H. Speed-altered timing -------------------------------------------------
// A 2x segment occupies half the timeline seconds. Windowing reads the stored
// startTime/duration, so sped-up segments window exactly like any other — and
// the preview mapping still agrees with the geometry the timeline drew.
const sped = [
  element('sped-0', 0, 50, 'VIDEO', { track: 0, position: 0, trimEnd: 100,
    properties: { speed: 2 } }),
  element('sped-1', 50, 25, 'VIDEO', { track: 0, position: 1, trimStart: 100, trimEnd: 125,
    properties: { speed: 1 } })
];
assert.equal(timeline.timelineDuration(sped), 75);
const spedView = createViewport({ pxPerSecond: 24, scrollLeft: 55 * 24, viewportWidth: 240, duration: 75 });
assert.deepEqual(ids(windowElements(sped, spedView, [])), ['sped-1'],
  'the window must follow timeline seconds, not source seconds');
const mapped = timeline.resolvePreviewPosition(sped, 25);
assert.equal(mapped.element.id, 'sped-0');
assert.equal(mapped.sourceTime, 50, 'a 2x segment must cover two source seconds per timeline second');
assert.equal(mapped.element.startTime * spedView.pxPerSecond, 0,
  'geometry is drawn from the same timeline seconds the window uses');

// --- I. A reordered video timeline ------------------------------------------
// After a move, normalizeVideoTrack restacks startTimes; the window must follow
// the new layout rather than the old one.
const reordered = timeline.normalizeVideoTrack([
  { ...videos[2], position: 0 }, { ...videos[0], position: 1 }, { ...videos[1], position: 2 }
]);
assert.deepEqual(reordered.map((item) => [item.id, item.startTime]),
  [['video-2', 0], ['video-0', 100], ['video-1', 200]]);
const headView = createViewport({ pxPerSecond: 24, scrollLeft: 0, viewportWidth: 960, duration: 300 });
assert.deepEqual(ids(windowElements(reordered, headView, [])), ['video-2'],
  'the head of a reordered timeline must mount the segment now sitting at 0s');

// --- J. The component keeps the mounted set bounded --------------------------
const component = readFileSync(join(root, 'src/components/edit-mode/edit-timeline.tsx'), 'utf8');
assert.ok(component.includes('windowElements('),
  'the timeline must window its tracks rather than mapping every element');
assert.ok(/windowElements\([^)]*\[selectedElementId, \.\.\.selectionSet\]\)/u.test(component),
  'the selected element (and any multi-selection) must be force-mounted so selection survives scrolling');
assert.ok(!/elements\.filter\([^)]*\)\.map\(/u.test(component),
  'no track may map straight over a full element list');
assert.ok(component.includes('memo(function TimelineBlock'),
  'blocks must be memoized so a playhead tick does not re-render every caption');
assert.ok(component.includes('memo(function Playhead'),
  'the playhead must be isolated from the static track geometry');
// The track tree is memoized on geometry only; currentPlayheadSec must not be a
// dependency or every frame would rebuild all mounted blocks.
// Workstream E renamed trackNodes -> laneNodes when the tracks grew headers and
// media layers, but the rule it exists to enforce is unchanged.
const trackMemo = component.slice(component.indexOf('const laneNodes = useMemo'));
const depsStart = trackMemo.indexOf('}), [');
const deps = trackMemo.slice(depsStart, trackMemo.indexOf(']);', depsStart) + 3);
assert.ok(!deps.includes('currentPlayheadSec'),
  'the track tree must not depend on the playhead');
assert.ok(deps.includes('viewport') && deps.includes('elements') && deps.includes('selectedElementId'));
// Every preserved interaction is still wired. Workstream E replaced onSplit and
// onMove with onSplitAt and onMoveTo, which carry WHERE the action lands so the
// razor tool and a clip drag can use the same canonical path.
for (const contract of ['onSplitAt', 'onDelete', 'onDuplicate', 'onMoveTo', 'onUndo', 'onRedo',
  'onSelectRange', 'onCommitTrim', 'onCommitTiming', 'onPreviewElements', 'normalizeVideoTrack']) {
  assert.ok(component.includes(contract), `${contract} must still be wired`);
}
for (const label of ['Change start', 'Change end']) {
  assert.ok(component.includes(label), `the "${label}" control must exist`);
}
// The zoom, split, delete and fit controls moved into the timeline's own
// toolbar in Workstream E; they are still required to exist, just next door.
const toolbarSource = readFileSync(
  join(root, 'src/components/edit-mode/edit-timeline-toolbar.tsx'), 'utf8');
for (const label of ['Split', 'Delete', 'Zoom in', 'Zoom out', 'Fit']) {
  assert.ok(toolbarSource.includes(`label='${label}'`), `the "${label}" control must exist`);
}
assert.ok(component.includes("data-testid='timeline-block'"),
  'blocks need a stable hook so browser verification can count what is mounted');
assert.ok(component.includes('data-mounted={mounted.length}') && component.includes('data-total={items.length}'),
  'each track must report mounted vs canonical counts for verification');

// --- K. Workstream C: the caption side panel is windowed too ----------------
// The timeline is not the only place 400 captions could be mounted at once. The
// Captions panel lists them, so it gets the same bound.
const captionList = load('src/lib/edit-mode-caption-list.ts');
const { captionRows, MAX_CAPTION_ROWS } = captionList;
const captionEls = Array.from({ length: 400 }, (_, index) =>
  element(`cap-${index}`, index * 0.75, 0.7, 'SUBTITLE'));
captionEls.forEach((item, index) => { item.properties = { content: `line ${index}` }; });

const dense = captionRows(captionEls, 150, '');
assert.equal(dense.mode, 'WINDOW');
assert.equal(dense.total, 400, 'the panel must still report the real caption count');
assert.equal(dense.rows.length, MAX_CAPTION_ROWS,
  'a dense caption track must mount a bounded number of rows');
assert.ok(dense.rows.some((row) => row.startTime <= 150 && row.startTime + row.duration >= 150) ||
  dense.rows[0].startTime <= 150,
'the window must be centred on the playhead');

const atHeadRows = captionRows(captionEls, 0, '');
assert.equal(atHeadRows.rows[0].id, 'cap-0', 'the head of the list must be reachable');
const atTailRows = captionRows(captionEls, 10_000, '');
assert.equal(atTailRows.rows.at(-1).id, 'cap-399', 'the tail of the list must be reachable');

const searched = captionRows(captionEls, 0, 'line 12');
assert.ok(searched.mode === 'SEARCH' && searched.rows.length <= MAX_CAPTION_ROWS &&
  searched.rows.every((row) => row.properties.content.includes('line 12')),
'search must filter and stay bounded');
assert.equal(captionRows(captionEls.slice(0, 10), 0, '').mode, 'ALL',
  'a small caption track is listed in full');

const captionPanel = readFileSync(
  join(root, 'src/components/edit-mode/shell/edit-captions-panel.tsx'), 'utf8');
assert.ok(captionPanel.includes('captionRows('),
  'the captions panel must window its list rather than mapping every caption');
assert.ok(!/captions\.map\(/u.test(captionPanel),
  'the captions panel must never map straight over the full caption list');
assert.ok(captionPanel.includes("data-testid='caption-rows'") &&
  captionPanel.includes('data-mounted={rows.length}'),
'the caption list must report mounted vs canonical counts for verification');

// --- L. Workstream C: direct-manipulation snapping ---------------------------
const snap = load('src/lib/edit-mode-snap.ts');
const { snapBox, snapRotation, clampBox, resizeBox, SNAP_THRESHOLD } = snap;

const centred = snapBox({ x: 0.198, y: 0.4, width: 0.6, height: 0.2 });
assert.ok(Math.abs(centred.x + 0.3 - 0.5) < 1e-9,
  'a box near the centre must snap its centre exactly onto it');
assert.ok(centred.guides.some((guide) => guide.axis === 'x' && guide.at === 0.5),
  'a snap must report the guide it snapped to');
const free = snapBox({ x: 0.05, y: 0.05, width: 0.2, height: 0.2 });
assert.deepEqual(free.guides, [], 'a box far from every target must not snap');
assert.ok(snapBox({ x: 0.004, y: 0.6, width: 0.3, height: 0.1 }).x === 0,
  'a leading edge near the canvas edge snaps flush');
assert.ok(SNAP_THRESHOLD > 0 && SNAP_THRESHOLD < 0.05, 'the snap threshold stays subtle');

assert.equal(snapRotation(2), 0, 'rotation snaps to the cardinal angles');
assert.equal(snapRotation(43), 45);
assert.equal(snapRotation(30), 30, 'a deliberate angle is left alone');
assert.equal(snapRotation(400), 180, 'rotation is clamped into the stored range');

const clamped = clampBox({ x: -0.5, y: 1.4, width: 0.4, height: 0.2 });
assert.ok(clamped.x === 0 && clamped.y <= 0.8, 'a dragged box is held inside the canvas');

const resized = resizeBox({ x: 0.2, y: 0.2, width: 0.4, height: 0.2 }, 'nw', -0.1, -0.1);
assert.ok(Math.abs(resized.x - 0.1) < 1e-9 && Math.abs(resized.width - 0.5) < 1e-9,
  'dragging the top-left corner must grow the box and hold the opposite corner');
const resizedSe = resizeBox({ x: 0.2, y: 0.2, width: 0.4, height: 0.2 }, 'se', 0.1, 0.1);
assert.ok(Math.abs(resizedSe.x - 0.2) < 1e-9 && Math.abs(resizedSe.width - 0.5) < 1e-9,
  'dragging the bottom-right corner must hold the top-left one');
assert.ok(resizeBox({ x: 0.2, y: 0.2, width: 0.4, height: 0.2 }, 'se', -1, -1).width >= 0.02,
  'a resize can never collapse a box below the minimum the backend accepts');

// --- M. Workstream C: the preview draws text the way the export will ---------
const preview = readFileSync(join(root, 'src/components/edit-mode/edit-preview.tsx'), 'utf8');
// The canvas is measured and written in explicit pixels. Sizing it by CSS
// aspect-ratio alone collapsed it to 0x0 - nothing in the preview was drawn at
// all - and the measured width is also what lets the text layer size type with
// the renderer's own formula.
const { fitCanvas } = snap;
assert.deepEqual(fitCanvas({ width: 800, height: 600 }, 9 / 16), { width: 337, height: 600 },
  'a tall canvas must fit by height');
assert.deepEqual(fitCanvas({ width: 300, height: 600 }, 16 / 9), { width: 300, height: 168 },
  'a wide canvas must fit by width');
assert.deepEqual(fitCanvas({ width: 0, height: 0 }, 1), { width: 0, height: 0 },
  'an unmeasured frame yields no canvas rather than a guess');
assert.ok(preview.includes('data-canvas-width={canvasSize.width}'),
  'the canvas must publish its measured width for verification');
assert.ok(preview.includes('canvasWidth={canvasSize.width}'),
  'the text layer must be sized from the measured canvas width');
assert.ok(preview.includes('snapBox(') && preview.includes('snapRotation('),
  'direct manipulation must go through the shared snapping rules');
assert.ok(preview.includes("onCommitTransform(kind, latest, before)"),
  'a gesture must persist exactly once, on pointer release');
// Exactly one commit, and it lives in the pointer-release handler rather than
// the move handler: that is what makes a drag one history revision, not a hundred.
assert.equal((preview.match(/onCommitTransform\(/gu) ?? []).length, 1,
  'onCommitTransform must be called exactly once in the whole gesture');
const upHandler = preview.slice(preview.indexOf('const up = () => {'));
assert.ok(upHandler.slice(0, upHandler.indexOf('};')).includes('onCommitTransform('),
  'the single commit must happen on pointer release');
const moveHandler = preview.slice(preview.indexOf('const move = (pointer: PointerEvent) => {'),
  preview.indexOf('const up = () => {'));
assert.ok(!moveHandler.includes('onCommitTransform('),
  'no command may be issued per pointer move');
assert.ok(moveHandler.includes('apply(') && preview.includes('onPreviewElements('),
  'a drag must update local state in realtime');
for (const control of ['Resize', 'Rotate', 'snap-guide']) {
  assert.ok(preview.includes(control), `the "${control}" affordance must exist in the preview`);
}
const previewText = readFileSync(
  join(root, 'src/components/edit-mode/edit-preview-text.tsx'), 'utf8');
assert.ok(previewText.includes('canHighlightWords('),
  'the preview must only highlight a word when the stored timings support it');
assert.ok(previewText.includes("boxDecorationBreak: 'clone'"),
  'the caption plate must hug each line, as libass BorderStyle 3 does');

console.log('timeline virtualization: all assertions passed');
console.log(`  400 captions / 300s @ 24px per second, 960px viewport -> ${mountedCaptions.length} mounted`);
console.log(`  zoomed in (96 px/s) -> ${windowElements(captions, zoomedIn, []).length} mounted`);
console.log(`  zoomed out (6 px/s) -> ${windowElements(captions, zoomedOut, []).length} mounted`);
console.log(`  ruler ticks in view -> ${rulerTicks(band).length}`);
console.log(`  400 captions in the side panel -> ${dense.rows.length} rows mounted`);
