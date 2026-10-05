// Step 7.3: the AI-safe tool registry.
//
// Every tool the agent may use is listed here, with:
//   * a small typed parameter list (what the OpenAI planner is shown),
//   * whether it is DESTRUCTIVE (asks first unless autonomy was granted),
//   * `build`: the canonical EditMode commands it becomes - the SAME typed,
//     validated, history-backed commands the manual editor sends,
//   * `verify`: how to prove, from RELOADED canonical state, that it worked.
//
// There is deliberately no tool that runs a shell, writes FFmpeg, touches the
// database, creates hidden timeline JSON or clicks the UI. A few tools act
// through dedicated service methods instead of the element bundle (template
// apply, source boundary, export, review); those are marked `via`.

import type { AssistantBundleCommand } from '../edit-mode.service';
import type { ChatContext, ChatElementView } from '../chat/edit-chat-context';
import { MAX_ZOOM_SCALE, MIN_ZOOM_SCALE } from '../edit-mode-zoom-events';
import { BOUNDARY_ANCHORS, resolveSemanticBoundary, type BoundaryAnchor } from './edit-agent-boundary';

/** Automatic 2 zooms only on clearly emphasised moments (semantic+energy score). */
const AUTOMATIC_2_ZOOM_MIN_SCORE = 0.68;

export type ToolCategory = 'VIDEO' | 'TEXT' | 'HOOK' | 'CAPTIONS' | 'COLOR' | 'AUDIO' | 'ZOOM' |
  'OVERLAYS' | 'TEMPLATES' | 'REVIEW' | 'EXPORT';

export type ToolParam = { name: string; type: 'number' | 'text' | 'flag';
  description: string; required?: boolean; enum?: readonly string[] };

export type ToolElement = { id: string; type: string; startTime: number; duration: number;
  trimStart: number | null; trimEnd: number | null; properties: Record<string, unknown> };
export type ToolProject = { revision: number; settings: Record<string, unknown>;
  elements: ToolElement[] };

export type BuildResult =
  | { commands: AssistantBundleCommand[]; lines: string[] }
  | { via: 'TEMPLATE'; templateId: string; lines: string[] }
  | { via: 'SOURCE_BOUNDARY'; payload: Record<string, number>; lines: string[];
      /** Canonical segment trims used when the project has no original-source lineage. */
      fallback?: AssistantBundleCommand[] }
  | { via: 'EXPORT'; lines: string[] }
  | { via: 'REVIEW'; lines: string[] }
  | { question: string }
  | { unsupported: string };

export type VerifyResult = { ok: boolean; evidence: string[] };

export type AgentTool = {
  name: string;
  category: ToolCategory;
  description: string;
  params: ToolParam[];
  destructive: boolean | ((args: Record<string, unknown>, ctx: ChatContext) => boolean);
  build(args: Record<string, unknown>, ctx: ChatContext): BuildResult;
  verify?(args: Record<string, unknown>, after: ToolProject, before: ToolProject,
    ctx: ChatContext): VerifyResult;
};

// --- helpers -------------------------------------------------------------------

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const flag = (value: unknown) => typeof value === 'boolean' ? value
  : value === 'true' ? true : value === 'false' ? false : undefined;
const round = (value: number, digits = 3) => Number(value.toFixed(digits));
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const el = (kind: 'ELEMENT', action: string, payload: Record<string, unknown>,
  ref?: string): AssistantBundleCommand => ({ kind, action, payload, ...(ref ? { ref } : {}) });
const pct = (value: number) => `${Math.round(value * 100)}%`;
const same = (a: unknown, b: unknown) => typeof a === 'number' && typeof b === 'number'
  ? Math.abs(a - b) < 1e-3 : String(a).toLowerCase() === String(b).toLowerCase();

const COLOR_NAMES: Record<string, string> = {
  yellow: '#FFD400', white: '#FFFFFF', black: '#000000', red: '#FF3B30', blue: '#2F80FF',
  green: '#34C759', orange: '#FF9500', pink: '#FF2D95', purple: '#AF52DE', gold: '#FFC83D',
  grey: '#9CA3AF', gray: '#9CA3AF', cyan: '#22D3EE', teal: '#14B8A6'
};
export const colorValue = (value: unknown): string | undefined => {
  const raw = text(value);
  if (!raw) return undefined;
  if (/^#[0-9a-f]{6}$/iu.test(raw)) return raw.toUpperCase();
  return COLOR_NAMES[raw.toLowerCase()];
};

/** Named screen positions for overlays/text, as a top-left x/y for a box. */
const POSITIONS: Record<string, [number, number]> = {
  TOP_LEFT: [0.04, 0.04], TOP_CENTER: [0.5, 0.04], TOP_RIGHT: [0.96, 0.04],
  CENTER_LEFT: [0.04, 0.5], CENTER: [0.5, 0.5], CENTER_RIGHT: [0.96, 0.5],
  BOTTOM_LEFT: [0.04, 0.9], BOTTOM_CENTER: [0.5, 0.9], BOTTOM_RIGHT: [0.96, 0.9]
};
export const POSITION_NAMES = Object.keys(POSITIONS);
const place = (position: string, width: number, height: number) => {
  const anchor = POSITIONS[position.toUpperCase().replace(/[\s-]+/gu, '_')];
  if (!anchor) return undefined;
  const [ax, ay] = anchor;
  const x = ax <= 0.05 ? ax : ax >= 0.95 ? ax - width : ax - width / 2;
  const y = ay <= 0.05 ? ay : ay >= 0.85 ? Math.min(ay, 1 - height - 0.04) : ay - height / 2;
  return { x: round(clamp(x, 0, 1 - width)), y: round(clamp(y, 0, 1 - height)) };
};

/** Resolves a context handle ("text:hook", "video:2", "captions:all"...) to elements. */
export function resolveHandle(handle: unknown, ctx: ChatContext): ChatElementView[] {
  const raw = text(handle)?.toLowerCase();
  if (!raw) return [];
  if (raw === 'selected') {
    const id = ctx.runtime.selectedElementId;
    return ctx.elements.filter((view) => view.id === id);
  }
  if (raw === 'captions:all') return ctx.elements.filter((view) => view.type === 'SUBTITLE');
  if (raw === 'video:all') return ctx.elements.filter((view) => view.type === 'VIDEO');
  if (raw === 'logos:all') return ctx.elements.filter((view) => view.semantic === 'LOGO');
  if (raw === 'music:all') return ctx.elements.filter((view) => view.type === 'AUDIO');
  if (raw === 'text:all') return ctx.elements.filter((view) => view.type === 'TEXT');
  return ctx.elements.filter((view) => view.handle.toLowerCase() === raw);
}
const hookOf = (ctx: ChatContext) => ctx.elements.find((view) => view.semantic === 'HOOK');
const videoAt = (ctx: ChatContext, sec: number) => ctx.elements.find((view) =>
  view.type === 'VIDEO' && sec >= view.startSec - 1e-6 && sec < view.endSec - 1e-6);
const currentVideo = (ctx: ChatContext) => {
  const selected = resolveHandle('selected', ctx)[0];
  if (selected?.type === 'VIDEO') return selected;
  return videoAt(ctx, ctx.selection.playheadSec) ?? ctx.elements.find((view) => view.type === 'VIDEO');
};
const captionsOf = (project: ToolProject) => project.elements.filter((item) => item.type === 'SUBTITLE');
const videosOf = (project: ToolProject) => project.elements.filter((item) => item.type === 'VIDEO');
const byId = (project: ToolProject, id: string) => project.elements.find((item) => item.id === id);
const prop = (item: ToolElement | undefined, key: string) => item?.properties[key];

/** Text-like target: explicit handle, else the hook for HOOK tools, else the selection. */
function textTargets(args: Record<string, unknown>, ctx: ChatContext, hook = false) {
  if (hook) { const view = hookOf(ctx); return view ? [view] : []; }
  const views = resolveHandle(args.target ?? 'selected', ctx);
  return views.filter((view) => view.type === 'TEXT' || view.type === 'SUBTITLE');
}

// --- text/caption style: one tool, many optional properties -------------------

const STYLE_PARAMS: ToolParam[] = [
  { name: 'fontSize', type: 'number', description: 'absolute size in design units (16-160)' },
  { name: 'sizeFactor', type: 'number', description: 'relative size, e.g. 0.85 = 15% smaller' },
  { name: 'color', type: 'text', description: 'hex (#RRGGBB) or a colour name' },
  { name: 'fontWeight', type: 'number', description: '100-900' },
  { name: 'fontFamily', type: 'text', description: 'font id from the editor catalogue' },
  { name: 'textAlign', type: 'text', description: 'left|center|right', enum: ['left', 'center', 'right'] },
  { name: 'uppercase', type: 'flag', description: 'draw in capitals (wording untouched)' },
  { name: 'strokeColor', type: 'text', description: 'outline colour' },
  { name: 'strokeWidth', type: 'number', description: 'outline width 0-12 (0 = off)' },
  { name: 'shadow', type: 'flag', description: 'drop shadow on/off' },
  { name: 'backgroundColor', type: 'text', description: 'plate colour; "none" removes it' },
  { name: 'backgroundOpacity', type: 'number', description: 'plate opacity 0-1' }
];

export function styleCommands(args: Record<string, unknown>, target: Record<string, unknown>,
  currentSize: number | null, label: string): { commands: AssistantBundleCommand[]; lines: string[] } {
  const commands: AssistantBundleCommand[] = [];
  const lines: string[] = [];
  const size = num(args.fontSize) ?? (num(args.sizeFactor) && currentSize
    ? Math.round(currentSize * Number(args.sizeFactor)) : undefined);
  if (size !== undefined) {
    const value = clamp(Math.round(size), 16, 160);
    commands.push(el('ELEMENT', 'SET_TEXT_SIZE', { ...target, fontSize: value }));
    lines.push(`${label} size -> ${value}`);
  }
  const color = colorValue(args.color);
  if (color) { commands.push(el('ELEMENT', 'SET_TEXT_COLOR', { ...target, color }));
    lines.push(`${label} colour -> ${color}`); }
  const weight = num(args.fontWeight);
  if (weight !== undefined) { commands.push(el('ELEMENT', 'SET_TEXT_WEIGHT',
    { ...target, fontWeight: clamp(Math.round(weight / 100) * 100, 100, 900) }));
  lines.push(`${label} weight -> ${weight}`); }
  const family = text(args.fontFamily);
  if (family) { commands.push(el('ELEMENT', 'SET_TEXT_FONT', { ...target, fontFamily: family }));
    lines.push(`${label} font -> ${family}`); }
  const align = text(args.textAlign);
  if (align) { commands.push(el('ELEMENT', 'SET_TEXT_ALIGNMENT', { ...target, textAlign: align }));
    lines.push(`${label} alignment -> ${align}`); }
  const upper = flag(args.uppercase);
  if (upper !== undefined) { commands.push(el('ELEMENT', 'SET_TEXT_CASE', { ...target, uppercase: upper }));
    lines.push(`${label} ${upper ? 'uppercase' : 'normal case'}`); }
  const strokeWidth = num(args.strokeWidth);
  const strokeColor = colorValue(args.strokeColor);
  if (strokeWidth !== undefined || strokeColor) {
    commands.push(el('ELEMENT', 'SET_TEXT_STROKE', { ...target,
      strokeEnabled: (strokeWidth ?? 2) > 0, strokeColor: strokeColor ?? '#000000',
      strokeWidth: clamp(strokeWidth ?? 2, 0, 12) }));
    lines.push(`${label} outline -> ${strokeWidth ?? 2}`);
  }
  const shadow = flag(args.shadow);
  if (shadow !== undefined) { commands.push(el('ELEMENT', 'SET_TEXT_SHADOW', { ...target,
    shadowEnabled: shadow, shadowColor: '#000000', shadowOpacity: 0.6, shadowBlur: 4,
    shadowOffsetX: 0, shadowOffsetY: 2 }));
  lines.push(`${label} shadow ${shadow ? 'on' : 'off'}`); }
  const plate = text(args.backgroundColor);
  if (plate) {
    const off = /^(none|off|transparent|no)$/iu.test(plate);
    commands.push(el('ELEMENT', 'SET_TEXT_BACKGROUND', { ...target, backgroundEnabled: !off,
      backgroundColor: off ? '#000000' : colorValue(plate) ?? '#000000',
      backgroundOpacity: clamp(num(args.backgroundOpacity) ?? 0.6, 0, 1),
      backgroundPadding: 8, backgroundRadius: 8 }));
    lines.push(`${label} background ${off ? 'off' : plate}`);
  }
  return { commands, lines };
}

function verifyStyle(args: Record<string, unknown>, targets: ToolElement[], currentSize: number | null) {
  const evidence: string[] = [];
  let ok = targets.length > 0;
  const size = num(args.fontSize) ?? (num(args.sizeFactor) && currentSize
    ? clamp(Math.round(currentSize * Number(args.sizeFactor)), 16, 160) : undefined);
  if (size !== undefined) {
    const hits = targets.filter((item) => same(item.properties.fontSize, clamp(Math.round(size), 16, 160)));
    evidence.push(`fontSize ${Math.round(size)} on ${hits.length}/${targets.length}`);
    ok &&= hits.length === targets.length;
  }
  const color = colorValue(args.color);
  if (color) {
    const hits = targets.filter((item) => same(item.properties.color, color));
    evidence.push(`colour ${color} on ${hits.length}/${targets.length}`);
    ok &&= hits.length === targets.length;
  }
  return { ok, evidence };
}

// --- the registry -------------------------------------------------------------

const TOOLS: AgentTool[] = [
  // ============================ VIDEO ==========================================
  { name: 'video.frame', category: 'VIDEO', destructive: false,
    description: 'Crop/reframe: FIT, FILL, or an aspect (9:16, 16:9, 1:1) for the current segment or the whole clip. Keeps cuts, captions, text, audio.',
    params: [
      { name: 'mode', type: 'text', required: true, enum: ['FIT', 'FILL', 'ASPECT'], description: 'framing mode' },
      { name: 'aspectRatio', type: 'text', enum: ['9:16', '16:9', '1:1'], description: 'for ASPECT' },
      { name: 'scope', type: 'text', enum: ['CURRENT_SEGMENT', 'WHOLE_CLIP'], description: 'default WHOLE_CLIP' }],
    build(args, ctx) {
      const mode = String(args.mode ?? '').toUpperCase();
      const whole = String(args.scope ?? 'WHOLE_CLIP').toUpperCase() !== 'CURRENT_SEGMENT';
      const segment = whole ? undefined : currentVideo(ctx);
      if (!whole && !segment) return { question: 'Which segment? Put the playhead on it.' };
      return { commands: [el('ELEMENT', 'SET_VIDEO_FRAMING', { mode, ...(args.aspectRatio
        ? { aspectRatio: args.aspectRatio } : {}),
      scope: whole ? 'ALL_VIDEO_SEGMENTS' : 'CURRENT_VIDEO_SEGMENT',
      ...(segment ? { elementId: segment.id } : {}) })],
      lines: [`${whole ? 'Whole clip' : 'Current segment'} framing -> ${mode === 'ASPECT'
        ? String(args.aspectRatio) : mode}`] };
    },
    verify(args, after, _before, ctx) {
      const whole = String(args.scope ?? 'WHOLE_CLIP').toUpperCase() !== 'CURRENT_SEGMENT';
      const mode = String(args.mode ?? '').toUpperCase();
      const targets = whole ? videosOf(after) : videosOf(after).filter((item) =>
        item.id === currentVideo(ctx)?.id);
      const expected = mode === 'ASPECT' ? (whole || after.settings.aspectRatio === args.aspectRatio
        ? 'FILL' : 'FIT') : mode;
      const hits = targets.filter((item) => item.properties.frameLayout === expected);
      const canvasOk = !(whole && mode === 'ASPECT') || after.settings.aspectRatio === args.aspectRatio;
      return { ok: targets.length > 0 && hits.length === targets.length && canvasOk,
        evidence: [`${hits.length}/${targets.length} segments ${expected}`,
          ...(whole && mode === 'ASPECT' ? [`canvas ${String(after.settings.aspectRatio)}`] : [])] };
    } },
  { name: 'video.reframe', category: 'VIDEO', destructive: false,
    description: 'Whole-clip reframe policy: AUTO, FACE_PRIORITY, TALKING_HEAD, CENTERED, INFORMATION_PRIORITY, SCREEN_TUTORIAL, SOURCE.',
    params: [{ name: 'policy', type: 'text', required: true, description: 'policy name' }],
    build: (args) => ({ commands: [el('ELEMENT', 'SET_REFRAME_POLICY', { policy: args.policy,
      clearSegmentOverrides: true })], lines: [`Reframe policy -> ${String(args.policy)}`] }) },
  { name: 'video.speed', category: 'VIDEO', destructive: false,
    description: 'Playback speed of one segment (0.25-4).',
    params: [{ name: 'target', type: 'text', description: 'video handle; default current segment' },
      { name: 'speed', type: 'number', required: true, description: 'rate' }],
    build(args, ctx) {
      const view = resolveHandle(args.target, ctx)[0] ?? currentVideo(ctx);
      if (!view || view.type !== 'VIDEO') return { question: 'Which segment should change speed?' };
      return { commands: [el('ELEMENT', 'SET_SPEED', { elementId: view.id, speed: num(args.speed) })],
        lines: [`${view.label} speed -> ${String(args.speed)}x`] };
    } },
  { name: 'video.split', category: 'VIDEO', destructive: false,
    description: 'Split the video at a timeline second.',
    params: [{ name: 'atSec', type: 'number', required: true, description: 'timeline second' }],
    build: (args) => ({ commands: [el('ELEMENT', 'SPLIT_ELEMENT', { targetAtSec: num(args.atSec),
      playheadSec: num(args.atSec) })], lines: [`Split at ${String(args.atSec)}s`] }) },
  { name: 'video.delete_range', category: 'VIDEO',
    destructive: true,
    description: 'Remove a timeline range from the video (ripple). Destructive.',
    params: [{ name: 'startSec', type: 'number', required: true, description: 'timeline start' },
      { name: 'endSec', type: 'number', required: true, description: 'timeline end' }],
    build(args, ctx) {
      const start = num(args.startSec); const end = num(args.endSec);
      if (start === undefined || end === undefined || end <= start) {
        return { question: 'Which part should I remove? Give a start and end.' };
      }
      const commands: AssistantBundleCommand[] = [];
      const duration = ctx.project.timelineDurationSec;
      if (start > 0.05) commands.push(el('ELEMENT', 'SPLIT_ELEMENT', { targetAtSec: start, playheadSec: start }));
      if (end < duration - 0.05) commands.push(el('ELEMENT', 'SPLIT_ELEMENT', { targetAtSec: end, playheadSec: end }));
      commands.push(el('ELEMENT', 'DELETE_ELEMENT', { targetAtSec: (start + end) / 2 }));
      return { commands, lines: [`Remove ${start.toFixed(1)}s-${end.toFixed(1)}s`] };
    } },
  { name: 'video.source_boundary', category: 'VIDEO',
    destructive: (args) => Math.abs(num(args.startDelta) ?? 0) + Math.abs(num(args.endDelta) ?? 0) > 8,
    description: 'Move the clip start/end in the ORIGINAL source (seconds; + later, - earlier). Simple contiguous clips only.',
    params: [{ name: 'startDelta', type: 'number', description: 'seconds to move the start' },
      { name: 'endDelta', type: 'number', description: 'seconds to move the end' }],
    build(args) {
      const payload: Record<string, number> = {};
      if (num(args.startDelta) !== undefined) payload.startDelta = Number(args.startDelta);
      if (num(args.endDelta) !== undefined) payload.endDelta = Number(args.endDelta);
      if (!Object.keys(payload).length) return { question: 'How much earlier or later?' };
      return { via: 'SOURCE_BOUNDARY', payload, lines: [`Source boundary ${JSON.stringify(payload)}`] };
    },
    verify(args, after, before) {
      const [first, last] = outerSegments(before);
      if (!first || !last) return { ok: false, evidence: ['no video segment'] };
      const checks = [num(args.startDelta) !== undefined
        ? verifyOuterEdge(before, after, 'START', (first.trimStart ?? 0) + Number(args.startDelta)) : null,
      num(args.endDelta) !== undefined
        ? verifyOuterEdge(before, after, 'END', (last.trimEnd ?? 0) + Number(args.endDelta)) : null]
        .filter((item): item is VerifyResult => !!item);
      return { ok: checks.every((item) => item.ok), evidence: checks.flatMap((item) => item.evidence) };
    } },
  { name: 'video.semantic_boundary', category: 'VIDEO',
    // Removing more than a few seconds of what the viewer currently sees is a cut.
    destructive: (args, ctx) => {
      const plan = semanticBoundaryPlan(args, ctx);
      return 'removedSec' in plan && plan.removedSec > 5;
    },
    description: 'Move the clip START or END to a transcript moment: PHRASE (quoted words), PREVIOUS_SENTENCE, NEXT_SENTENCE, COMPLETE_SENTENCE, DROP_FIRST_SENTENCE, DROP_LAST_SENTENCE. Keeps internal cuts.',
    params: [{ name: 'edge', type: 'text', required: true, enum: ['START', 'END'], description: 'which boundary' },
      { name: 'anchor', type: 'text', required: true, enum: BOUNDARY_ANCHORS, description: 'transcript anchor' },
      { name: 'phrase', type: 'text', description: 'exact spoken words for PHRASE' }],
    build(args, ctx) {
      const plan = semanticBoundaryPlan(args, ctx);
      if ('question' in plan) return plan;
      const line = `${plan.edge === 'START' ? 'Start' : 'End'} -> ${plan.sec.toFixed(2)}s of the source (${plan.evidence})`;
      const trim = el('ELEMENT', 'TRIM_ELEMENT', { elementId: plan.segment.id,
        trimStart: plan.edge === 'START' ? plan.sec : plan.segment.trimStartSec,
        trimEnd: plan.edge === 'END' ? plan.sec : plan.segment.trimEndSec });
      // A single contiguous clip moves its outer range (lineage-aware ripple);
      // a multi-cut edit only moves its first/last segment, so no removed
      // interval inside the edit is ever restored.
      return plan.single
        ? { via: 'SOURCE_BOUNDARY', payload: (plan.edge === 'START' ? { start: plan.sec }
          : { end: plan.sec }) as Record<string, number>,
          lines: [line], fallback: [trim] }
        : { commands: [trim], lines: [`${line} (outer segment only; internal cuts kept)`] };
    },
    // The outer-range path runs outside the element bundle (no command results), so
    // the generic verifier cannot judge it: check the reloaded edge itself.
    verify(args, after, before, ctx) {
      const plan = semanticBoundaryPlan(args, ctx);
      if ('question' in plan) return { ok: false, evidence: [plan.question] };
      return verifyOuterEdge(before, after, plan.edge, plan.sec);
    } },
  { name: 'video.transform', category: 'VIDEO', destructive: false,
    description: 'Scale/position/rotate/flip the current segment or whole clip.',
    params: [{ name: 'scale', type: 'number', description: '0.1-4' },
      { name: 'x', type: 'number', description: 'offset -1..1' }, { name: 'y', type: 'number', description: 'offset -1..1' },
      { name: 'rotation', type: 'number', description: 'degrees' },
      { name: 'flipH', type: 'flag', description: 'mirror' },
      { name: 'scope', type: 'text', enum: ['CURRENT_SEGMENT', 'WHOLE_CLIP'], description: 'default CURRENT_SEGMENT' }],
    build(args, ctx) {
      const whole = String(args.scope ?? '').toUpperCase() === 'WHOLE_CLIP';
      const segment = currentVideo(ctx);
      const target = whole ? { scope: 'ALL_VIDEO_SEGMENTS' }
        : segment ? { elementId: segment.id, scope: 'CURRENT_VIDEO_SEGMENT' } : null;
      if (!target) return { question: 'Which segment?' };
      const commands: AssistantBundleCommand[] = []; const lines: string[] = [];
      if (num(args.scale) !== undefined) { commands.push(el('ELEMENT', 'SET_VIDEO_SCALE', { ...target, scale: num(args.scale) })); lines.push(`Scale -> ${String(args.scale)}`); }
      if (num(args.x) !== undefined || num(args.y) !== undefined) { commands.push(el('ELEMENT', 'SET_VIDEO_POSITION', { ...target, x: num(args.x) ?? 0, y: num(args.y) ?? 0 })); lines.push('Reposition video'); }
      if (num(args.rotation) !== undefined) { commands.push(el('ELEMENT', 'SET_VIDEO_ROTATION', { ...target, rotation: num(args.rotation) })); lines.push(`Rotate -> ${String(args.rotation)}°`); }
      if (flag(args.flipH) !== undefined) { commands.push(el('ELEMENT', 'SET_VIDEO_FLIP', { ...target, flipH: flag(args.flipH), flipV: false })); lines.push('Flip video'); }
      return commands.length ? { commands, lines } : { question: 'What should change - scale, position, rotation or flip?' };
    } },

  // ============================ CAPTIONS =======================================
  { name: 'captions.style', category: 'CAPTIONS', destructive: false,
    description: 'Restyle captions. scope ALL = whole caption track (default); SELECTED = the selected caption only. Never changes wording or timing.',
    params: [{ name: 'scope', type: 'text', enum: ['ALL', 'SELECTED'], description: 'default ALL' },
      { name: 'activeWordColor', type: 'text', description: 'highlight colour for the spoken word' },
      { name: 'activeWord', type: 'flag', description: 'active-word highlight on/off' },
      { name: 'preset', type: 'text', description: 'caption style preset id' }, ...STYLE_PARAMS],
    build(args, ctx) {
      const selected = String(args.scope ?? 'ALL').toUpperCase() === 'SELECTED';
      const view = selected ? resolveHandle('selected', ctx)[0] : undefined;
      if (selected && view?.type !== 'SUBTITLE') return { question: 'Select the caption to change first.' };
      if (!ctx.tracks.captions.count) return { question: 'There are no captions yet. Generate captions first?' };
      const target = selected ? { elementId: view!.id, scope: 'SELECTED_ELEMENT' }
        : { elementType: 'SUBTITLE', scope: 'TRACK' };
      const currentSize = selected ? num(view!.properties.fontSize) ?? null : ctx.tracks.captions.fontSize;
      const built = styleCommands(args, target, currentSize, selected ? 'This caption' : 'Captions');
      const preset = text(args.preset);
      if (preset) { built.commands.unshift(el('ELEMENT', 'SET_CAPTION_STYLE', { ...target, captionStyleId: preset }));
        built.lines.unshift(`Caption style -> ${preset}`); }
      const activeColor = colorValue(args.activeWordColor);
      const activeOn = flag(args.activeWord) ?? (activeColor ? true : undefined);
      if (activeOn !== undefined) {
        built.commands.push(el('ELEMENT', 'SET_CAPTION_ACTIVE_WORD', { ...target,
          activeWordEnabled: activeOn, activeWordColor: activeColor ?? '#FFD400' }));
        built.lines.push(`Active word ${activeOn ? `on (${activeColor ?? '#FFD400'})` : 'off'}`);
      }
      return built.commands.length ? built : { question: 'How should the captions change?' };
    },
    verify(args, after, _before, ctx) {
      const selected = String(args.scope ?? 'ALL').toUpperCase() === 'SELECTED';
      const targets = selected ? captionsOf(after).filter((item) => item.id === ctx.runtime.selectedElementId)
        : captionsOf(after);
      const base = verifyStyle(args, targets, selected ? null : ctx.tracks.captions.fontSize);
      const activeColor = colorValue(args.activeWordColor);
      if (activeColor) {
        const hits = targets.filter((item) => same((item.properties.activeWord as Record<string, unknown>
          | undefined)?.color, activeColor));
        base.evidence.push(`active word ${activeColor} on ${hits.length}/${targets.length}`);
        base.ok &&= hits.length === targets.length;
      }
      return base;
    } },
  { name: 'captions.position', category: 'CAPTIONS', destructive: false,
    description: 'Move the caption track (y 0 top .. 1 bottom, or dy relative).',
    params: [{ name: 'y', type: 'number', description: 'absolute top of caption box 0-1' },
      { name: 'dy', type: 'number', description: 'relative move, + = lower' }],
    build(args, ctx) {
      const current = ctx.tracks.captions.y ?? 0.73;
      const y = num(args.y) ?? (num(args.dy) !== undefined ? current + Number(args.dy) : undefined);
      if (y === undefined) return { question: 'Higher or lower?' };
      const value = round(clamp(y, 0.02, 0.9));
      return { commands: [el('ELEMENT', 'MOVE_ELEMENT', { elementType: 'SUBTITLE', scope: 'TRACK', y: value })],
        lines: [`Captions position y -> ${value}`] };
    },
    verify(args, after, _before, ctx) {
      const current = ctx.tracks.captions.y ?? 0.73;
      const y = num(args.y) ?? current + (num(args.dy) ?? 0);
      const targets = captionsOf(after);
      const hits = targets.filter((item) => Math.abs(Number(item.properties.y) - clamp(y, 0.02, 0.9)) < 0.2);
      const moved = targets.filter((item) => (num(args.dy) ?? 0) === 0 ||
        Math.sign(Number(item.properties.y) - current) === Math.sign(Number(args.dy)));
      return { ok: targets.length > 0 && hits.length === targets.length && moved.length === targets.length,
        evidence: [`${hits.length}/${targets.length} captions near y ${round(clamp(y, 0.02, 0.9), 2)}`] };
    } },
  { name: 'captions.visible', category: 'CAPTIONS', destructive: false,
    description: 'Show or hide the whole caption track.',
    params: [{ name: 'visible', type: 'flag', required: true, description: 'true shows' }],
    build: (args) => ({ commands: [el('ELEMENT', 'SET_CAPTIONS_VISIBLE', { visible: flag(args.visible) ?? true })],
      lines: [`Captions ${flag(args.visible) === false ? 'hidden' : 'shown'}`] }) },
  { name: 'captions.edit_text', category: 'CAPTIONS', destructive: false,
    description: 'Change the wording of ONE caption (explicit correction only).',
    params: [{ name: 'target', type: 'text', description: 'caption handle; default selected' },
      { name: 'content', type: 'text', required: true, description: 'new wording' }],
    build(args, ctx) {
      const view = resolveHandle(args.target ?? 'selected', ctx)[0];
      if (!view || view.type !== 'SUBTITLE') return { question: 'Which caption? Select it first.' };
      return { commands: [el('ELEMENT', 'SET_CAPTION_TEXT', { elementId: view.id, content: text(args.content) })],
        lines: [`Caption wording -> "${String(args.content)}"`] };
    } },
  { name: 'captions.generate', category: 'CAPTIONS', destructive: false,
    description: 'Generate transcript captions when none exist.',
    params: [{ name: 'preset', type: 'text', description: 'caption style preset id' }],
    build: (args, ctx) => ctx.tracks.captions.count
      ? { question: 'Captions already exist. Regenerate them (this replaces edited wording)?' }
      : { commands: [el('ELEMENT', 'GENERATE_CAPTIONS', { captionStyleId: text(args.preset) ?? 'CLEAN' })],
        lines: ['Generate captions from the transcript'] } },
  { name: 'captions.regenerate', category: 'CAPTIONS',
    destructive: (_args, ctx) => ctx.tracks.captions.manualEdited > 0,
    description: 'Rebuild caption WORDING from the transcript (replaces manual corrections). Style kept.',
    params: [],
    build: () => ({ commands: [el('ELEMENT', 'REGENERATE_CAPTIONS', {})],
      lines: ['Regenerate caption wording from the transcript'] }) },

  // ============================ TEXT + HOOK ====================================
  { name: 'text.style', category: 'TEXT', destructive: false,
    description: 'Restyle a TEXT element (target handle) or all TEXT (target text:all). Not captions.',
    params: [{ name: 'target', type: 'text', description: 'text handle, "text:all" or "selected"' }, ...STYLE_PARAMS],
    build(args, ctx) {
      const all = String(args.target ?? '').toLowerCase() === 'text:all';
      if (all) {
        const sizes = ctx.elements.filter((view) => view.type === 'TEXT').map((view) => num(view.properties.fontSize)).filter((v): v is number => v !== undefined);
        const built = styleCommands(args, { elementType: 'TEXT', scope: 'TRACK' }, sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : null, 'All text');
        return built.commands.length ? built : { question: 'How should the text change?' };
      }
      const view = textTargets(args, ctx)[0];
      if (!view || view.type !== 'TEXT') return { question: 'Which text? Select it first.' };
      const built = styleCommands(args, { elementId: view.id }, num(view.properties.fontSize) ?? null, view.label);
      return built.commands.length ? built : { question: 'How should the text change?' };
    } },
  { name: 'hook.style', category: 'HOOK', destructive: false,
    description: 'Restyle the canonical HOOK text only.',
    params: STYLE_PARAMS,
    build(args, ctx) {
      const view = hookOf(ctx);
      if (!view) return { question: 'There is no hook yet. Should I write one from the opening?' };
      const built = styleCommands(args, { elementId: view.id }, num(view.properties.fontSize) ?? null, 'Hook');
      return built.commands.length ? built : { question: 'How should the hook change?' };
    },
    verify(args, after, _before, ctx) {
      const view = hookOf(ctx);
      const item = view ? byId(after, view.id) : undefined;
      return verifyStyle(args, item ? [item] : [], num(view?.properties.fontSize) ?? null);
    } },
  { name: 'hook.move', category: 'HOOK', destructive: false,
    description: 'Move the hook: a named position (TOP_CENTER...) or relative dx/dy.',
    params: [{ name: 'position', type: 'text', enum: POSITION_NAMES, description: 'named position' },
      { name: 'dx', type: 'number', description: 'relative, + = right' }, { name: 'dy', type: 'number', description: 'relative, + = down' }],
    build(args, ctx) { return moveElement(hookOf(ctx), args, 'Hook'); },
    verify(args, after, _before, ctx) { return verifyMove(hookOf(ctx), args, after); } },
  { name: 'text.move', category: 'TEXT', destructive: false,
    description: 'Move a TEXT element (target handle) by named position or dx/dy.',
    params: [{ name: 'target', type: 'text', description: 'text handle or "selected"' },
      { name: 'position', type: 'text', enum: POSITION_NAMES, description: 'named position' },
      { name: 'dx', type: 'number', description: 'relative' }, { name: 'dy', type: 'number', description: 'relative' }],
    build(args, ctx) { return moveElement(textTargets(args, ctx)[0], args, 'Text'); },
    verify(args, after, _before, ctx) { return verifyMove(textTargets(args, ctx)[0], args, after); } },
  { name: 'hook.rewrite', category: 'HOOK', destructive: false,
    description: 'Set the hook wording to exact text (creates the hook if missing).',
    params: [{ name: 'content', type: 'text', required: true, description: 'exact wording' }],
    build(args, ctx) {
      const content = text(args.content);
      if (!content) return { question: 'What should the hook say?' };
      const view = hookOf(ctx);
      if (view) return { commands: [el('ELEMENT', 'SET_TEXT_CONTENT', { elementId: view.id, content })],
        lines: [`Hook -> "${content}"`] };
      return { commands: [el('ELEMENT', 'ADD_TEXT', { content, textStyleId: 'HOOK', origin: 'ASSISTANT' }, 'new-hook')],
        lines: [`Add hook "${content}"`] };
    },
    verify(args, after, _before, ctx) {
      const hook = after.elements.find((item) => item.type === 'TEXT' &&
        (item.id === hookOf(ctx)?.id || item.properties.content === text(args.content)));
      return { ok: prop(hook, 'content') === text(args.content), evidence: [`hook "${String(prop(hook, 'content'))}"`] };
    } },
  { name: 'hook.write', category: 'HOOK', destructive: false,
    description: 'Write hook wording from the video itself: SHORTER, ANOTHER or NEW. Grounded in the transcript.',
    params: [{ name: 'mode', type: 'text', required: true, enum: ['SHORTER', 'ANOTHER', 'NEW'], description: 'what to write' }],
    // Creative wording goes through the chat's grounded hook writer (the
    // service handles this tool specially); `build` is never used for it.
    build: () => ({ unsupported: 'hook.write is executed by the agent service' }) },
  { name: 'text.add', category: 'TEXT', destructive: false,
    description: 'Add a TEXT element with exact wording.',
    params: [{ name: 'content', type: 'text', required: true, description: 'wording' },
      { name: 'style', type: 'text', description: 'text style preset id' }],
    build: (args) => text(args.content) ? { commands: [el('ELEMENT', 'ADD_TEXT', { content: text(args.content),
      textStyleId: text(args.style) ?? 'BASIC', origin: 'ASSISTANT' })], lines: [`Add text "${String(args.content)}"`] }
      : { question: 'What should the text say?' } },
  { name: 'text.delete', category: 'TEXT', destructive: false,
    description: 'Remove one TEXT element (not captions).',
    params: [{ name: 'target', type: 'text', required: true, description: 'text handle' }],
    build(args, ctx) {
      const view = textTargets(args, ctx)[0];
      if (!view || view.type !== 'TEXT') return { question: 'Which text should I remove?' };
      return { commands: [el('ELEMENT', 'REMOVE_ELEMENT', { elementId: view.id })], lines: [`Remove ${view.label}`] };
    } },

  // ============================ COLOR ==========================================
  { name: 'color.adjust', category: 'COLOR', destructive: false,
    description: 'One colour control (exposure, brightness, contrast, highlights, shadows, saturation, temperature, tint, sharpness, fade, vignette) for the current segment or the whole clip; value or delta.',
    params: [{ name: 'control', type: 'text', required: true, description: 'control name',
      enum: ['exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'saturation', 'temperature', 'tint', 'sharpness', 'fade', 'vignette'] },
    { name: 'value', type: 'number', description: 'absolute -1..1 (sharpness/fade/vignette 0..1)' },
    { name: 'delta', type: 'number', description: 'relative change' },
    { name: 'scope', type: 'text', enum: ['CURRENT_SEGMENT', 'WHOLE_CLIP'], description: 'default WHOLE_CLIP' }],
    build(args, ctx) {
      const control = String(args.control ?? '').toLowerCase();
      if (!/^(exposure|brightness|contrast|highlights|shadows|saturation|temperature|tint|sharpness|fade|vignette)$/u.test(control)) {
        return { question: 'Which colour control?' };
      }
      const whole = String(args.scope ?? 'WHOLE_CLIP').toUpperCase() !== 'CURRENT_SEGMENT';
      const segment = currentVideo(ctx);
      const current = num((segment?.properties.colorAdjustments as Record<string, unknown> | undefined)?.[control]) ?? 0;
      const bipolar = !['sharpness', 'fade', 'vignette'].includes(control);
      const value = round(clamp(num(args.value) ?? current + (num(args.delta) ?? 0), bipolar ? -1 : 0, 1));
      return { commands: [el('ELEMENT', `SET_VIDEO_${control.toUpperCase()}`, { [control]: value,
        ...(whole ? { scope: 'ALL_VIDEO_SEGMENTS' } : { elementId: segment?.id, scope: 'CURRENT_VIDEO_SEGMENT' }) })],
      lines: [`${whole ? 'Whole clip' : 'This shot'} ${control} -> ${value}`] };
    },
    verify(args, after, _before, ctx) {
      const control = String(args.control ?? '').toLowerCase();
      const whole = String(args.scope ?? 'WHOLE_CLIP').toUpperCase() !== 'CURRENT_SEGMENT';
      const targets = whole ? videosOf(after) : videosOf(after).filter((item) => item.id === currentVideo(ctx)?.id);
      const segment = currentVideo(ctx);
      const current = num((segment?.properties.colorAdjustments as Record<string, unknown> | undefined)?.[control]) ?? 0;
      const bipolar = !['sharpness', 'fade', 'vignette'].includes(control);
      const expected = round(clamp(num(args.value) ?? current + (num(args.delta) ?? 0), bipolar ? -1 : 0, 1));
      const hits = targets.filter((item) => same((item.properties.colorAdjustments as Record<string, unknown> | undefined)?.[control], expected));
      return { ok: targets.length > 0 && hits.length === targets.length, evidence: [`${control} ${expected} on ${hits.length}/${targets.length} segments`] };
    } },
  { name: 'color.filter', category: 'COLOR', destructive: false,
    description: 'Apply a built-in colour filter/look (id) at a strength, current segment or whole clip.',
    params: [{ name: 'filterId', type: 'text', required: true, description: 'filter id' },
      { name: 'strength', type: 'number', description: '0-1, default 0.7' },
      { name: 'scope', type: 'text', enum: ['CURRENT_SEGMENT', 'WHOLE_CLIP'], description: 'default WHOLE_CLIP' }],
    build(args, ctx) {
      const whole = String(args.scope ?? 'WHOLE_CLIP').toUpperCase() !== 'CURRENT_SEGMENT';
      const segment = currentVideo(ctx);
      return { commands: [el('ELEMENT', 'APPLY_COLOR_FILTER', { filterId: String(args.filterId ?? '').toUpperCase(),
        strength: clamp(num(args.strength) ?? 0.7, 0, 1),
        ...(whole ? { scope: 'ALL_VIDEO_SEGMENTS' } : { elementId: segment?.id, scope: 'CURRENT_VIDEO_SEGMENT' }) })],
      lines: [`${whole ? 'Whole clip' : 'This shot'} look -> ${String(args.filterId)}`] };
    } },

  // ============================ AUDIO ==========================================
  { name: 'audio.music_volume', category: 'AUDIO', destructive: false,
    description: 'Music volume (all music, or target one audio clip). volume 0-2 gain (0.15 = 15%) or factor.',
    params: [{ name: 'volume', type: 'number', description: 'absolute gain' },
      { name: 'factor', type: 'number', description: 'relative, 0.8 = 20% lower' },
      { name: 'target', type: 'text', description: 'audio handle; default all music' }],
    build(args, ctx) {
      const music = resolveHandle(args.target ?? 'music:all', ctx).filter((view) => view.type === 'AUDIO');
      if (!music.length) return { question: 'There is no music in this project. Add a track first?' };
      const single = args.target && String(args.target) !== 'music:all' ? music[0] : undefined;
      const current = num((single ?? music[0]).properties.volume) ?? 0.25;
      const volume = round(clamp(num(args.volume) ?? current * (num(args.factor) ?? 1), 0, 2));
      return { commands: [el('ELEMENT', 'SET_AUDIO_VOLUME', single ? { elementId: single.id, volume }
        : { volume, scope: 'TRACK' })], lines: [`${single ? single.label : 'Music'} volume -> ${pct(volume)}`] };
    },
    verify(args, after, _before, ctx) {
      const music = resolveHandle(args.target ?? 'music:all', ctx).filter((view) => view.type === 'AUDIO');
      const single = args.target && String(args.target) !== 'music:all' ? music[0] : undefined;
      const current = num((single ?? music[0])?.properties.volume) ?? 0.25;
      const expected = round(clamp(num(args.volume) ?? current * (num(args.factor) ?? 1), 0, 2));
      const targets = after.elements.filter((item) => item.type === 'AUDIO' && (!single || item.id === single.id));
      const hits = targets.filter((item) => same(item.properties.volume, expected));
      return { ok: targets.length > 0 && hits.length === targets.length,
        evidence: [`music volume ${expected} on ${hits.length}/${targets.length} clips`] };
    } },
  { name: 'audio.source_volume', category: 'AUDIO', destructive: false,
    description: "The video's own recorded audio (not music): volume/factor or mute.",
    params: [{ name: 'volume', type: 'number', description: 'gain 0-2' },
      { name: 'factor', type: 'number', description: 'relative' }, { name: 'muted', type: 'flag', description: 'mute' }],
    build(args, ctx) {
      if (flag(args.muted) !== undefined) return { commands: [el('ELEMENT', 'SET_SOURCE_AUDIO_MUTED',
        { muted: flag(args.muted), scope: 'ALL_VIDEO_SEGMENTS' })], lines: [`Video audio ${flag(args.muted) ? 'muted' : 'unmuted'}`] };
      const current = ctx.tracks.sourceAudio.volume;
      const volume = round(clamp(num(args.volume) ?? current * (num(args.factor) ?? 1), 0, 2));
      return { commands: [el('ELEMENT', 'SET_SOURCE_AUDIO_VOLUME', { volume, scope: 'ALL_VIDEO_SEGMENTS' })],
        lines: [`Video audio volume -> ${pct(volume)}`] };
    },
    verify(args, after) {
      const targets = videosOf(after);
      if (flag(args.muted) !== undefined) {
        const hits = targets.filter((item) => (item.properties.sourceMuted === true) === flag(args.muted));
        return { ok: hits.length === targets.length, evidence: [`source muted=${String(flag(args.muted))} on ${hits.length}/${targets.length}`] };
      }
      return { ok: true, evidence: ['source volume written by the command layer'] };
    } },
  { name: 'audio.music_mute', category: 'AUDIO', destructive: false,
    description: 'Mute or unmute all music.',
    params: [{ name: 'muted', type: 'flag', required: true, description: 'mute' }],
    build: (args) => ({ commands: [el('ELEMENT', 'SET_AUDIO_MUTED', { muted: flag(args.muted) ?? true, scope: 'TRACK' })],
      lines: [`Music ${flag(args.muted) === false ? 'unmuted' : 'muted'}`] }) },
  { name: 'audio.fade', category: 'AUDIO', destructive: false,
    description: 'Fade in/out on one music clip (default the first).',
    params: [{ name: 'fadeInSec', type: 'number', description: 'seconds' }, { name: 'fadeOutSec', type: 'number', description: 'seconds' },
      { name: 'target', type: 'text', description: 'audio handle' }],
    build(args, ctx) {
      const view = resolveHandle(args.target ?? 'music:all', ctx).find((item) => item.type === 'AUDIO');
      if (!view) return { question: 'There is no music to fade.' };
      return { commands: [el('ELEMENT', 'SET_AUDIO_FADE', { elementId: view.id,
        fadeInSec: num(args.fadeInSec) ?? num(view.properties.fadeInSec) ?? 0,
        fadeOutSec: num(args.fadeOutSec) ?? num(view.properties.fadeOutSec) ?? 0 })], lines: ['Music fades'] };
    } },
  { name: 'audio.ducking', category: 'AUDIO', destructive: false,
    description: 'Lower music under speech (needs word timings).',
    params: [{ name: 'enabled', type: 'flag', required: true, description: 'on/off' },
      { name: 'strength', type: 'text', enum: ['LIGHT', 'MEDIUM', 'STRONG'], description: 'duck depth' }],
    build(args, ctx) {
      const music = ctx.elements.filter((view) => view.type === 'AUDIO');
      if (!music.length) return { question: 'There is no music to duck.' };
      return { commands: music.map((view) => el('ELEMENT', 'SET_AUDIO_DUCKING', { elementId: view.id,
        duckEnabled: flag(args.enabled) ?? true, duckStrength: text(args.strength)?.toUpperCase() ?? 'MEDIUM' })),
      lines: [`Ducking ${flag(args.enabled) === false ? 'off' : 'on'}`] };
    } },

  // ============================ ZOOM ===========================================
  { name: 'zoom.adjust', category: 'ZOOM', destructive: false,
    description: 'Make zooms WEAKER or STRONGER: scope ALL (every zoom) or SELECTED.',
    params: [{ name: 'direction', type: 'text', required: true, enum: ['WEAKER', 'STRONGER'], description: 'direction' },
      { name: 'scope', type: 'text', enum: ['ALL', 'SELECTED'], description: 'default ALL' }],
    build(args, ctx) {
      const selected = String(args.scope ?? 'ALL').toUpperCase() === 'SELECTED';
      const view = selected ? resolveHandle('selected', ctx)[0] : undefined;
      if (selected && view?.type !== 'EFFECT') return { question: 'Select the zoom first.' };
      if (!selected && !ctx.tracks.zooms && ctx.project.style.zoomPolicy === 'OFF') {
        return { question: 'There are no zooms in this clip.' };
      }
      return { commands: [el('ELEMENT', 'ADJUST_ZOOM_STRENGTH', { direction: String(args.direction).toUpperCase(),
        ...(selected ? { elementId: view!.id } : { scope: 'TRACK' }) })],
      lines: [`${selected ? 'This zoom' : 'All zooms'} ${String(args.direction).toLowerCase()}`] };
    },
    verify(args, after, before) {
      const weaker = String(args.direction).toUpperCase() === 'WEAKER';
      const beforeZ = new Map(before.elements.filter((item) => item.type === 'EFFECT').map((item) => [item.id, num(item.properties.scale) ?? 1.1]));
      const moved = after.elements.filter((item) => item.type === 'EFFECT' && beforeZ.has(item.id)).map((item) => {
        const prior = beforeZ.get(item.id)!; const now = num(item.properties.scale) ?? 1.1;
        return weaker ? now < prior || now <= MIN_ZOOM_SCALE : now > prior || now >= MAX_ZOOM_SCALE;
      });
      const policyMoved = before.settings.zoomPolicy !== after.settings.zoomPolicy;
      return { ok: moved.every(Boolean) && (moved.length > 0 || policyMoved),
        evidence: [`${moved.filter(Boolean).length}/${moved.length} zoom events ${weaker ? 'weaker' : 'stronger'}`,
          ...(policyMoved ? [`zoom policy ${String(before.settings.zoomPolicy)} -> ${String(after.settings.zoomPolicy)}`] : [])] };
    } },
  { name: 'zoom.remove', category: 'ZOOM', destructive: false,
    description: 'Remove zooms: scope ALL or SELECTED.',
    params: [{ name: 'scope', type: 'text', enum: ['ALL', 'SELECTED'], description: 'default ALL' }],
    build(args, ctx) {
      const selected = String(args.scope ?? 'ALL').toUpperCase() === 'SELECTED';
      const view = selected ? resolveHandle('selected', ctx)[0] : undefined;
      if (selected && view?.type !== 'EFFECT') return { question: 'Select the zoom first.' };
      return { commands: [el('ELEMENT', 'REMOVE_ZOOM', selected ? { elementId: view!.id } : { scope: 'TRACK' })],
        lines: [selected ? 'Remove this zoom' : 'Remove all zooms'] };
    },
    verify(args, after) {
      const left = after.elements.filter((item) => item.type === 'EFFECT' && item.properties.enabled !== false).length;
      const all = String(args.scope ?? 'ALL').toUpperCase() !== 'SELECTED';
      return { ok: !all || (left === 0 && after.settings.zoomPolicy !== 'SUBTLE' && after.settings.zoomPolicy !== 'MODERATE' && after.settings.zoomPolicy !== 'STRONG'),
        evidence: [`${left} active zoom events remain; policy ${String(after.settings.zoomPolicy ?? 'OFF')}`] };
    } },
  { name: 'zoom.add', category: 'ZOOM', destructive: false,
    description: 'Add one zoom at a timeline second.',
    params: [{ name: 'atSec', type: 'number', required: true, description: 'timeline second' },
      { name: 'durationSec', type: 'number', description: 'default 1.6' },
      { name: 'strength', type: 'text', enum: ['SUBTLE', 'BALANCED', 'STRONG'], description: 'default SUBTLE' }],
    build(args, ctx) {
      const at = num(args.atSec); if (at === undefined) return { question: 'Where should the zoom go?' };
      const duration = clamp(num(args.durationSec) ?? 1.6, 1.1, 4);
      const start = round(clamp(at, 0, Math.max(0, ctx.project.timelineDurationSec - duration)));
      return { commands: [el('ELEMENT', 'ADD_ZOOM', { startTime: start, duration, scale: zoomScale(args.strength) })],
        lines: [`Zoom at ${start}s`] };
    } },
  { name: 'zoom.add_semantic', category: 'ZOOM', destructive: false,
    description: 'Add zooms at the strongest spoken emphasis moments found in the transcript/analysis.',
    params: [{ name: 'strength', type: 'text', enum: ['SUBTLE', 'BALANCED', 'STRONG'], description: 'default SUBTLE' },
      { name: 'maxCount', type: 'number', description: 'default 3' },
      { name: 'scale', type: 'number', description: 'exact peak scale 1.03-1.15 (overrides strength)' },
      { name: 'minSpacingSec', type: 'number', description: 'minimum gap between zooms, default 3' },
      { name: 'phraseTimed', type: 'flag', description: 'cover the complete scored phrase' },
      { name: 'profile', type: 'text', description: 'template-owned zoom policy' }],
    build(args, ctx) {
      const duration = ctx.project.timelineDurationSec;
      // Automatic 2 owns its zoom track: zooms inherited from the base edit (Automatic 1
      // punches on filler words) are replaced, and only the strongest emphasis moments
      // are zoomed, ranked by score, at most one per ~20 s.
      const automatic2 = String(args.profile ?? '') === 'AUTOMATIC_2';
      const existing = automatic2 ? [] : ctx.elements.filter((view) => view.type === 'EFFECT');
      const phraseTimed = flag(args.phraseTimed) === true;
      const peaks = automatic2
        ? [...ctx.analysis.semanticPeaks].filter((peak) => peak.score >= AUTOMATIC_2_ZOOM_MIN_SCORE)
          .sort((left, right) => right.score - left.score)
        : ctx.analysis.semanticPeaks;
      const starts = peaks.flatMap((peak) => ctx.runtime.map.toTimeline(peak.startSec)
        .map((at) => ({ at, endAt: ctx.runtime.map.toTimeline(peak.endSec)
          .find((value) => value >= at) ?? at + 1.6, text: peak.triggerText,
          reason: peak.reason, score: peak.score })))
        .filter((item) => item.at >= 0.5 && item.at < duration - 1.2)
        .filter((item) => existing.every((view) => Math.abs(view.startSec - item.at) > 2));
      const chosen: typeof starts = [];
      const durationBudget = automatic2 ? (duration <= 20 ? 1 : duration <= 40 ? 2 : 3)
        : duration <= 15 ? 1 : duration <= 45 ? 3 : 4;
      for (const item of starts) {
        if (chosen.length >= Math.min(clamp(num(args.maxCount) ?? 3, 1, 6),
          phraseTimed ? durationBudget : 6)) break;
        const spacing = clamp(num(args.minSpacingSec) ?? 3, 1, 20);
        // Phrase-timed moves occupy 2.5-5s themselves. Spacing is measured
        // between envelopes, not merely between trigger words.
        if (chosen.every((other) => Math.abs(other.at - item.at) >=
          spacing + (phraseTimed ? 2.5 : 0))) chosen.push(item);
      }
      chosen.sort((left, right) => left.at - right.at);
      const clear = automatic2 && ctx.elements.some((view) => view.type === 'EFFECT')
        ? [el('ELEMENT', 'REMOVE_ZOOM', { scope: 'TRACK' })] : [];
      if (!chosen.length) {
        if (automatic2) return { commands: clear, lines: clear.length
          ? ['No zoom: no strong emphasis moment in this clip'] : [] };
        return { question: 'I could not find clear emphasis moments for zooms. Put the playhead where you want one and say "zoom here".' };
      }
      return { commands: [...clear, ...chosen.map((item) => {
        const moveDuration = phraseTimed
          ? clamp(Math.max(0, item.endAt - item.at) + .7, 2.5, 5) : 1.4;
        const startTime = phraseTimed
          ? clamp(item.at - .25, 0, Math.max(0, duration - moveDuration)) : item.at;
        return el('ELEMENT', 'ADD_ZOOM', { startTime: round(startTime),
          duration: round(moveDuration),
          scale: num(args.scale) !== undefined ? clamp(Number(args.scale), 1.03, 1.15)
            : zoomScale(args.strength), triggerText: item.text.slice(0, 80),
          semanticReason: item.reason || 'SEMANTIC_IMPORTANCE' });
      })],
      lines: chosen.map((item) => `Zoom at ${round(item.at, 1)}s ("${item.text.slice(0, 40)}")`) };
    },
    verify(_args, after, before) {
      const added = after.elements.filter((item) => item.type === 'EFFECT').length -
        before.elements.filter((item) => item.type === 'EFFECT').length;
      return { ok: added > 0, evidence: [`${added} zoom events added`] };
    } },

  // ============================ OVERLAYS =======================================
  { name: 'logo.move', category: 'OVERLAYS', destructive: false,
    description: 'Move a logo (target handle / selected) or ALL logos to a named position.',
    params: [{ name: 'position', type: 'text', required: true, enum: POSITION_NAMES, description: 'named position' },
      { name: 'scope', type: 'text', enum: ['ALL', 'SELECTED'], description: 'default ALL' }],
    build(args, ctx) {
      const logos = ctx.elements.filter((view) => view.semantic === 'LOGO');
      if (!logos.length) return { question: 'There is no logo in this project.' };
      const selected = String(args.scope ?? 'ALL').toUpperCase() === 'SELECTED';
      const view = selected ? resolveHandle('selected', ctx)[0] : logos[0];
      if (!view) return { question: 'Select the logo first.' };
      const spot = place(String(args.position), num(view.properties.width) ?? 0.2, num(view.properties.height) ?? 0.1);
      if (!spot) return { question: 'Where should the logo go (top right, bottom left...)?' };
      return { commands: [el('ELEMENT', 'MOVE_ELEMENT', selected ? { elementId: view.id, ...spot }
        : { semanticRole: 'LOGO', scope: 'TRACK', ...spot })], lines: [`${selected ? 'Logo' : 'All logos'} -> ${String(args.position)}`] };
    },
    verify(args, after, _before, ctx) {
      const logos = after.elements.filter((item) => item.type === 'IMAGE' && ctx.elements.some((view) => view.id === item.id && view.semantic === 'LOGO'));
      const view = ctx.elements.find((item) => item.semantic === 'LOGO');
      const spot = place(String(args.position), num(view?.properties.width) ?? 0.2, num(view?.properties.height) ?? 0.1);
      const hits = logos.filter((item) => spot && Math.abs(Number(item.properties.x) - spot.x) < 0.02);
      const selected = String(args.scope ?? 'ALL').toUpperCase() === 'SELECTED';
      return { ok: selected ? hits.length >= 1 : hits.length === logos.length && logos.length > 0,
        evidence: [`${hits.length}/${logos.length} logos at ${String(args.position)}`] };
    } },
  { name: 'overlay.opacity', category: 'OVERLAYS', destructive: false,
    description: 'Opacity of one overlay/text element.',
    params: [{ name: 'target', type: 'text', required: true, description: 'handle' }, { name: 'opacity', type: 'number', required: true, description: '0-1' }],
    build(args, ctx) {
      const view = resolveHandle(args.target, ctx)[0];
      if (!view) return { question: 'Which element?' };
      return { commands: [el('ELEMENT', 'SET_ELEMENT_OPACITY', { elementId: view.id, opacity: clamp(num(args.opacity) ?? 1, 0, 1) })],
        lines: [`${view.label} opacity -> ${String(args.opacity)}`] };
    } },

  // ============================ TEMPLATES / REVIEW / EXPORT ====================
  { name: 'template.apply', category: 'TEMPLATES', destructive: false,
    description: 'Apply a full template by id (style policy only; keeps wording, cuts, protected edits).',
    params: [{ name: 'templateId', type: 'text', required: true, description: 'template id' }],
    build(args, ctx) {
      const wanted = String(args.templateId ?? '').toLowerCase();
      const template = ctx.templates.find((item) => item.id.toLowerCase() === wanted ||
        item.name.toLowerCase() === wanted);
      return template ? { via: 'TEMPLATE', templateId: template.id, lines: [`Apply template ${template.name}`] }
        : { question: 'Which template? I could not find that one.' };
    } },
  { name: 'review.inspect', category: 'REVIEW', destructive: false,
    description: 'Inspect the project (hook, pacing, captions, framing, zoom, colour, audio, overlays). Read-only.',
    params: [], build: () => ({ via: 'REVIEW', lines: ['Review the edit'] }) },
  { name: 'export.render', category: 'EXPORT', destructive: false,
    description: 'Start the final render/export of the current canonical state.',
    params: [], build: () => ({ via: 'EXPORT', lines: ['Export the clip'] }) }
];

function semanticBoundaryPlan(args: Record<string, unknown>, ctx: ChatContext):
  { question: string } | { edge: 'START' | 'END'; sec: number; evidence: string; removedSec: number;
    single: boolean; segment: ChatElementView } {
  const edge = String(args.edge ?? '').toUpperCase() === 'END' ? 'END' : 'START';
  const anchor = String(args.anchor ?? '').toUpperCase() as BoundaryAnchor;
  if (!(BOUNDARY_ANCHORS as readonly string[]).includes(anchor)) return { question: 'Where should the clip start or end?' };
  const videos = ctx.elements.filter((view) => view.type === 'VIDEO').sort((a, b) => a.position - b.position);
  if (!videos.length) return { question: 'This project has no video.' };
  const first = videos[0]; const last = videos[videos.length - 1];
  const clipStart = first.trimStartSec;
  const clipEnd = last.trimEndSec ?? last.trimStartSec + (last.endSec - last.startSec);
  const resolved = resolveSemanticBoundary({ words: ctx.runtime.words, clipStart, clipEnd,
    sourceDuration: ctx.project.sourceDurationSec || Number.MAX_SAFE_INTEGER, edge, anchor,
    phrase: text(args.phrase) });
  if ('question' in resolved) return resolved;
  const segment = edge === 'START' ? first : last;
  const otherBound = edge === 'START' ? (segment.trimEndSec ?? clipEnd) : segment.trimStartSec;
  if ((edge === 'START' && resolved.sec >= otherBound - 0.3) || (edge === 'END' && resolved.sec <= otherBound + 0.3)) {
    return { question: 'That would leave the clip empty at that edge. Pick a different moment.' };
  }
  const removedSec = edge === 'START' ? Math.max(0, resolved.sec - clipStart) : Math.max(0, clipEnd - resolved.sec);
  return { edge, sec: round(resolved.sec), evidence: resolved.evidence, removedSec,
    single: videos.length === 1, segment };
}

/** First and last VIDEO segment in timeline order. */
function outerSegments(project: ToolProject): [ToolElement | undefined, ToolElement | undefined] {
  const videos = project.elements.filter((item) => item.type === 'VIDEO').sort((a, b) => a.startTime - b.startTime);
  return [videos[0], videos[videos.length - 1]];
}

/**
 * The moved outer edge landed on the planned source second, and every INTERNAL segment
 * kept its source range (a boundary move must never restore or remove inner cuts).
 */
function verifyOuterEdge(before: ToolProject, after: ToolProject, edge: 'START' | 'END', sec: number): VerifyResult {
  const [first, last] = outerSegments(after);
  const moved = edge === 'START' ? first?.trimStart : last?.trimEnd;
  if (moved === undefined || moved === null) return { ok: false, evidence: ['no video segment after the edit'] };
  const inner = (project: ToolProject) => project.elements.filter((item) => item.type === 'VIDEO')
    .sort((a, b) => a.startTime - b.startTime).slice(1, -1).map((item) => `${item.trimStart}:${item.trimEnd}`).join();
  const landed = Math.abs(moved - sec) < 0.05;
  const innerKept = inner(before) === inner(after);
  return { ok: landed && innerKept, evidence: [
    `${edge === 'START' ? 'start' : 'end'} ${moved.toFixed(2)}s of the source (planned ${sec.toFixed(2)}s)`,
    ...(innerKept ? [] : ['internal cuts changed'])] };
}

function zoomScale(strength: unknown) {
  const value = String(strength ?? 'SUBTLE').toUpperCase();
  return value === 'STRONG' ? 1.14 : value === 'BALANCED' || value === 'MODERATE' ? 1.1 : 1.06;
}

function moveElement(view: ChatElementView | undefined, args: Record<string, unknown>, label: string): BuildResult {
  if (!view) return { question: `There is no ${label.toLowerCase()} to move.` };
  const width = num(view.properties.width) ?? 0.5; const height = num(view.properties.height) ?? 0.15;
  const named = text(args.position) ? place(String(args.position), width, height) : undefined;
  const x = named?.x ?? (num(args.dx) !== undefined ? clamp((num(view.properties.x) ?? 0) + Number(args.dx), 0, 1 - width) : num(view.properties.x) ?? 0);
  const y = named?.y ?? (num(args.dy) !== undefined ? clamp((num(view.properties.y) ?? 0) + Number(args.dy), 0, 1 - height) : num(view.properties.y) ?? 0);
  return { commands: [el('ELEMENT', 'MOVE_ELEMENT', { elementId: view.id, x: round(x), y: round(y) })],
    lines: [`${label} position -> (${round(x, 2)}, ${round(y, 2)})`] };
}

function verifyMove(view: ChatElementView | undefined, args: Record<string, unknown>, after: ToolProject): VerifyResult {
  const item = view ? byId(after, view.id) : undefined;
  if (!view || !item) return { ok: false, evidence: ['element not found after the edit'] };
  const x0 = num(view.properties.x) ?? 0; const y0 = num(view.properties.y) ?? 0;
  const x1 = num(item.properties.x) ?? 0; const y1 = num(item.properties.y) ?? 0;
  // The expected spot is exactly what `moveElement` asked for (it already
  // clamps to the frame), so an element pinned at an edge still verifies.
  const planned = moveElement(view, args, '');
  const payload = 'commands' in planned ? planned.commands[0].payload : {};
  const ok = Math.abs(x1 - Number(payload.x)) < 1e-3 && Math.abs(y1 - Number(payload.y)) < 1e-3;
  return { ok, evidence: [`(${round(x0, 2)}, ${round(y0, 2)}) -> (${round(x1, 2)}, ${round(y1, 2)})`] };
}

const REGISTRY = new Map(TOOLS.map((tool) => [tool.name, tool]));
export const agentTool = (name: string) => REGISTRY.get(name);
export const agentTools = () => TOOLS;

/** The catalogue the OpenAI planner is shown: names, categories, params. No code. */
export function toolCatalog() {
  return TOOLS.map((tool) => ({ name: tool.name, category: tool.category,
    description: tool.description, destructive: tool.destructive === true,
    params: tool.params.map((param) => ({ name: param.name, type: param.type,
      ...(param.required ? { required: true } : {}), ...(param.enum ? { enum: param.enum } : {}),
      description: param.description })) }));
}

export function isDestructive(tool: AgentTool, args: Record<string, unknown>, ctx: ChatContext) {
  return typeof tool.destructive === 'function' ? tool.destructive(args, ctx) : tool.destructive;
}
