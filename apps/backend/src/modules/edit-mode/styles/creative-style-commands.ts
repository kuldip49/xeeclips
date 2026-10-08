// Step 10: a resolved creative style -> the canonical EditMode commands that
// produce it on ONE clip's EditProject.
//
// Nothing here writes state. It returns the same typed commands the editor and
// the AI agent use (several through the agent tool builders themselves), so a
// styled clip is an ordinary editable project: undoable, constraint-checked and
// rendered by the one canonical renderer. What the clip cannot support (no
// music track, no logo, no transcript) is reported as skipped, never faked.

import type { AssistantBundleCommand } from '../edit-mode.service';
import type { ChatContext } from '../chat/edit-chat-context';
import { agentTool, styleCommands } from '../agent/edit-agent-tools';
import type { AudioSpec, BackgroundSpec, CaptionSpec, ColorSpec, FramingSpec, HookSpec,
  OverlaySpec, TextSpec, ZoomSpec } from './creative-style-library';
import type { ResolvedCreativeStyle } from './creative-style-resolver';
import { layoutEvidenceFromContext, resolveVisualLayout } from './resolved-visual-layout';
import { planCamera } from '../render/edit-mode-camera';
import { phraseZoomLimits, planEditModeZoom } from '../render/edit-mode-zoom';
import type { AnalysisFrame } from '../../editing/edit-analysis';
import { remapAnalysisFrames, timelineShotBoundaries } from '../render/edit-mode-timeline-map';
import { STYLE_TWO_ID } from '@ai-content-platform/shared/style-two.cjs';

export type HookOption = { text: string; style?: string | null };
export type CompiledStyle = { commands: AssistantBundleCommand[]; lines: string[]; skipped: string[] };

const el = (action: string, payload: Record<string, unknown>, ref?: string): AssistantBundleCommand =>
  ({ kind: 'ELEMENT', action, payload, ...(ref ? { ref } : {}) });

function toolCommands(tool: string, args: Record<string, unknown>, ctx: ChatContext,
  out: CompiledStyle, label: string) {
  const built = agentTool(tool)?.build(args, ctx);
  if (!built) { out.skipped.push(`${label}: tool ${tool} missing`); return; }
  if ('commands' in built) { out.commands.push(...built.commands); out.lines.push(...built.lines); return; }
  if ('question' in built) { out.skipped.push(`${label}: ${built.question}`); return; }
  if ('unsupported' in built) { out.skipped.push(`${label}: ${built.unsupported}`); return; }
  out.skipped.push(`${label}: not an element change`);
}

/** Picks grounded hook wording from the clip's own content package. */
export function chooseHook(options: HookOption[], writing: HookSpec['writing']) {
  const clean = options.filter((option) => option.text.trim());
  if (!clean.length) return null;
  const want = writing === 'QUESTION' ? /question/iu : writing === 'CURIOSITY' ? /curios|stakes|conseq/iu
    : writing === 'STATEMENT' ? /claim|statement|value|educat/iu : null;
  const byStyle = want ? clean.find((option) => want.test(option.style ?? '')) : undefined;
  const byShape = writing === 'QUESTION' ? clean.find((option) => option.text.trim().endsWith('?')) : undefined;
  return (byStyle ?? byShape ?? clean[0]).text.trim();
}

const LOW_INFORMATION_WORDS = new Set(['about', 'after', 'again', 'because', 'before', 'could',
  'every', 'from', 'have', 'here', 'into', 'just', 'many', 'more', 'most', 'really', 'should',
  'some', 'that', 'their', 'them', 'there', 'these', 'they', 'this', 'those', 'very', 'what',
  'when', 'where', 'which', 'while', 'with', 'would', 'your']);

/** Deterministic semantic emphasis for the persisted hook. It favours entities,
 * numbers and substantive long words, never random positions. */
export function semanticHookRuns(text: string, baseColor: string,
  emphasis?: string | readonly string[]) {
  const palette = typeof emphasis === 'string' ? [emphasis] : [...(emphasis ?? [])];
  if (!palette.length) return [{ text, color: baseColor }];
  const words = [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)];
  // Title Case hooks capitalise every word, which says nothing about entities.
  const titleCase = words.length > 3 &&
    words.filter((match) => /^\p{Lu}/u.test(match[0])).length / words.length > 0.6;
  const scored = words.map((match, index) => {
    const word = match[0];
    const plain = word.toLocaleLowerCase();
    const entity = !titleCase && index > 0 && /^\p{Lu}/u.test(word);
    const number = /\p{N}/u.test(word);
    const substantive = word.length >= 7 && !LOW_INFORMATION_WORDS.has(plain);
    return { start: match.index ?? 0, end: (match.index ?? 0) + word.length,
      score: (number ? 5 : 0) + (entity ? 4 : 0) + (substantive ? 2 : 0) + word.length / 100 };
  }).filter((item) => item.score >= 2).sort((left, right) => right.score - left.score).slice(0, 2);
  if (!scored.length) return [{ text, color: baseColor }];
  const selected = scored.sort((left, right) => left.start - right.start);
  const runs: Array<{ text: string; color: string }> = [];
  let cursor = 0;
  for (const [rangeIndex, range] of selected.entries()) {
    const emphasisColor = palette[rangeIndex % palette.length];
    if (range.start > cursor) runs.push({ text: text.slice(cursor, range.start), color: baseColor });
    runs.push({ text: text.slice(range.start, range.end), color: emphasisColor });
    cursor = range.end;
  }
  if (cursor < text.length) runs.push({ text: text.slice(cursor), color: baseColor });
  return runs;
}

// Generic narrator filler ("The speaker says...", "This clip discusses...") is never
// an acceptable supporting line: an empty black region beats filler.
const FILLER_SUPPORT = /^(?:the|this|that|in this|here,? the)\s+(?:clip|video|speaker|answer|segment|discussion|conversation|interview|host|guest|moment)\b|\b(?:examines|discusses|is about|talks about|looks at|explores|covers|offered here)\b|^(?:the )?speaker\s+(?:says|explains|argues|notes)\b|\buseful in practice\b/iu;
// ("...useful in practice" is the deterministic fallback judge's question template,
// e.g. "What makes <title> useful in practice?", not a sub-hook.)
const DANGLING_END = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'but',
  'with', 'by', 'from', 'as', 'is', 'that', 'which', 'if', 'so', 'than', 'because']);
const normalizeHookText = (text: string) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const contentWords = (text: string) => new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [])
  .filter((word) => word.length > 3));

/** `hook` may list every hook wording that can be on screen (the layout's choice and an
 * already-present hook element); the line must be distinct from all of them. */
export function chooseSupportingLine(options: HookOption[], hook: string | null | Array<string | null>) {
  const hooks = (Array.isArray(hook) ? hook : [hook]).filter((item): item is string => !!item?.trim());
  const hookWords = contentWords(hooks.join(' '));
  return options.map((option) => option.text.trim()).find((text) => {
    if (text.length < 12 || text.length > 110) return false;
    if (hooks.some((item) => normalizeHookText(text) === normalizeHookText(item))) return false;
    if (FILLER_SUPPORT.test(text) || /[,;:]$/u.test(text)) return false;
    const words = text.replace(/[.!?…"'”’),;:]+$/u, '').split(/\s+/u);
    if (words.length < 3 || DANGLING_END.has(words[words.length - 1].toLocaleLowerCase())) return false;
    // A sub-hook must add something: reject a near-duplicate of the hook.
    const own = contentWords(text);
    const shared = [...own].filter((word) => hookWords.has(word)).length;
    return !own.size || shared / own.size < 0.6;
  }) ?? null;
}

export function compileCreativeStyle(resolved: ResolvedCreativeStyle, ctx: ChatContext,
  info: { hookOptions: HookOption[]; supportingLine?: string; hasWordTimings: boolean }): CompiledStyle {
  const out: CompiledStyle = { commands: [], lines: [], skipped: [] };
  const component = <T>(category: keyof ResolvedCreativeStyle['components']) => {
    const value = resolved.components[category];
    return value.source === 'DEFAULT' || !value.spec ? null : { ...value, spec: value.spec as T };
  };

  const hookSpecForLayout = component<HookSpec>('HOOK');
  const layoutHook = hookSpecForLayout
    ? chooseHook(info.hookOptions, hookSpecForLayout.spec.writing) : null;
  const visualLayout = resolveVisualLayout(resolved, layoutEvidenceFromContext(ctx, layoutHook));
  const styleTwo = resolved.templateId === STYLE_TWO_ID;
  const persistentDuration = styleTwo ? ctx.runtime.map.durationSec : Math.max(1, ctx.project.timelineDurationSec);
  // The card camera the renderer will recompute; kept so emphasis zooms can be checked against it.
  let cardCamera: ReturnType<typeof planCamera> | null = null;
  let cardFrames: AnalysisFrame[] = [];
  if (visualLayout.editingProfile === 'AUTOMATIC_2' || styleTwo) {
    const frames = remapAnalysisFrames(ctx.runtime.analysisFrames, ctx.runtime.map);
    const boundaries = timelineShotBoundaries(ctx.runtime.shotBoundaries, ctx.runtime.map);
    const frame = visualLayout.videoFrame;
    const camera = planCamera({ policy: styleTwo ? ctx.project.style.reframePolicy : 'FACE_FOCUSED',
      preserveInformation: styleTwo ? ctx.project.style.informationRegionPolicy !== 'IGNORE' : true,
      aspectRatio: '9:16', canvas: { width: 1080, height: 1920, fps: 30 },
      source: { width: ctx.runtime.sourceWidth, height: ctx.runtime.sourceHeight },
      // StyleOne's speakerSafe option also enables its special sentence punches.
      // StyleTwo keeps the base EditMode camera decisions; its emphasis zooms come from the
      // shared phrase-timed ZOOM component below, exactly like StyleOne's.
      frames, boundaries, map: ctx.runtime.map, speakerSafe: !styleTwo, words: ctx.runtime.words,
      viewport: { x: 0, y: 0, width: 1080,
        height: Math.max(2, Math.round(frame.height * 1920 / 2) * 2) } });
    cardCamera = camera; cardFrames = frames;
    const times = new Set<number>();
    for (let t = 0; t <= ctx.project.timelineDurationSec + 1e-6; t += .1) {
      times.add(Number(Math.min(t, ctx.project.timelineDurationSec).toFixed(3)));
    }
    camera.speakerSegments.slice(1).forEach((segment) => times.add(segment.startSec));
    visualLayout.cameraPath = [...times].sort((a, b) => a - b).map((t) => {
      const crop = camera.cropAt(t);
      return { t, x: crop.x, y: crop.y, w: crop.w, h: crop.h };
    });
    if (styleTwo) {
      visualLayout.frameSegments = camera.frameSegments.map(({ startSec, endSec, layout }) => ({ startSec, endSec, layout }));
      const crop = camera.informationCrop;
      visualLayout.informationCrop = crop ? { x: crop.x / ctx.runtime.sourceWidth, y: crop.y / ctx.runtime.sourceHeight,
        w: crop.width / ctx.runtime.sourceWidth, h: crop.height / ctx.runtime.sourceHeight } : null;
    }
  }
  // One backend-resolved geometry object is persisted with the same revision as
  // the elements. Browser preview and FFmpeg consume these exact values.
  out.commands.push({ kind: 'SETTINGS', action: 'SET_RESOLVED_VISUAL_LAYOUT',
    payload: { resolvedVisualLayout: visualLayout, ...(styleTwo ? { aspectRatio: '9:16' } : {}) } });
  out.lines.push('Resolved professional visual layout');

  // --- FRAMING, then BACKGROUND (a background layout overrides the framing layout)
  const framing = component<FramingSpec>('FRAMING');
  if (framing) {
    toolCommands('video.reframe', { policy: framing.spec.reframePolicy }, ctx, out, 'Framing');
    if (framing.spec.layout) toolCommands('video.frame', { mode: framing.spec.layout, scope: 'WHOLE_CLIP' }, ctx, out, 'Framing');
  }
  const background = component<BackgroundSpec>('BACKGROUND');
  if (background) {
    if (!background.supported) out.skipped.push(`Background: ${background.note ?? 'not supported'}`);
    else if (background.spec.composition !== 'STREET_EDITORIAL' && !styleTwo) {
      toolCommands('video.frame', { mode: background.spec.layout, scope: 'WHOLE_CLIP' }, ctx, out, 'Background');
      if (background.spec.layout === 'FIT') {
        out.commands.push(el('SET_FIT_BACKGROUND', { background: background.spec.fitBackground ?? 'BLUR' }));
        out.lines.push(`Background -> ${(background.spec.fitBackground ?? 'BLUR').toLowerCase()}`);
      }
    }
  }

  // --- COLOR
  const color = component<ColorSpec>('COLOR');
  if (color) {
    toolCommands('color.filter', { filterId: color.spec.filterId, strength: color.spec.strength,
      scope: 'WHOLE_CLIP' }, ctx, out, 'Colour');
    for (const [control, value] of Object.entries(color.spec.overrides ?? {})) {
      toolCommands('color.adjust', { control, value, scope: 'WHOLE_CLIP' }, ctx, out, 'Colour');
    }
  }

  // --- CAPTIONS (generated from the transcript when the clip has none yet)
  const captions = component<CaptionSpec>('CAPTIONS');
  if (captions) {
    const spec = captions.spec;
    const exist = ctx.tracks.captions.count > 0;
    if (spec.hidden) {
      if (exist) { out.commands.push(el('SET_CAPTIONS_VISIBLE', { visible: false })); out.lines.push('Captions hidden'); }
    } else if (!exist && !ctx.project.hasWordTimings) {
      out.skipped.push('Captions: this source has no word-timed transcript to caption from');
    } else {
      const track = { elementType: 'SUBTITLE', scope: 'TRACK' };
      out.commands.push(exist ? el('SET_CAPTION_STYLE', { ...track, captionStyleId: spec.preset })
        : el('GENERATE_CAPTIONS', { captionStyleId: spec.preset }));
      out.lines.push(`${exist ? 'Caption style' : 'Captions'} -> ${captions.name ?? spec.preset}`);
      const refined = styleCommands({ fontSize: spec.fontSize, color: spec.color, fontWeight: spec.fontWeight,
        fontFamily: spec.fontFamily, uppercase: spec.uppercase, strokeWidth: spec.strokeWidth, shadow: spec.shadow,
        backgroundColor: spec.plate, backgroundOpacity: spec.plateOpacity }, track, null, 'Captions');
      out.commands.push(...refined.commands); out.lines.push(...refined.lines);
      if (spec.activeWord !== undefined || spec.activeWordColor) {
        out.commands.push(el('SET_CAPTION_ACTIVE_WORD', { ...track, activeWordEnabled: spec.activeWord ?? true,
          activeWordColor: spec.activeWordColor ?? '#FFD400' }));
        out.lines.push(`Active word ${spec.activeWord === false ? 'off' : `on (${spec.activeWordColor ?? '#FFD400'})`}`);
      }
      out.commands.push(el('MOVE_ELEMENT', { ...track, x: visualLayout.captions.x,
        y: visualLayout.captions.y }));
      out.commands.push(el('RESIZE_ELEMENT', { ...track, width: visualLayout.captions.width,
        height: visualLayout.captions.height }));
      out.commands.push(el('SET_TEXT_SIZE', { ...track, fontSize: visualLayout.captions.fontSize }));
      if (styleTwo) out.commands.push(el('SET_TEXT_SPACING', { ...track,
        letterSpacing: 0, lineSpacing: visualLayout.captions.lineHeight }));
      out.lines.push(`Captions -> lower safe region (${visualLayout.captions.maxLines} lines max)`);
    }
  }

  // --- HOOK (wording from the clip's own grounded content package)
  const hook = component<HookSpec>('HOOK');
  if (hook) {
    const spec = hook.spec;
    const existing = ctx.elements.find((view) => view.semantic === 'HOOK');
    const y = background?.spec.hookY ?? (spec.position === 'CENTER' ? 0.42 : spec.position === 'UPPER' ? 0.16 : 0.08);
    if (spec.none) {
      if (existing) { out.commands.push(el('SET_ELEMENT_VISIBLE', { elementId: existing.id, visible: false })); out.lines.push('Hook hidden'); }
    } else {
      const wording = spec.writing === 'KEEP' && existing ? null : chooseHook(info.hookOptions, spec.writing);
      let target: Record<string, unknown>;
      if (existing) {
        target = { elementId: existing.id };
        if (wording && wording !== String(existing.properties.content ?? '')) {
          out.commands.push(el('SET_TEXT_CONTENT', { elementId: existing.id, content: wording }));
          out.lines.push(`Hook -> "${wording}"`);
        }
        out.commands.push(el('SET_TEXT_STYLE_PRESET', { elementId: existing.id, textStyleId: spec.textStyle }));
        const finalText = wording ?? String(existing.properties.content ?? '');
        if (finalText && (spec.semanticHighlightColor || spec.singleColor)) {
          out.commands.push(el('SET_TEXT_RUNS', { elementId: existing.id,
            textRuns: semanticHookRuns(finalText, spec.color ?? '#FFFFFF', spec.semanticHighlightColor) }));
        }
      } else if (wording) {
        out.commands.push(el('ADD_TEXT', { content: wording, textStyleId: spec.textStyle, origin: 'PRESET',
          presetRole: 'HOOK', textRuns: semanticHookRuns(wording, spec.color ?? '#FFFFFF',
            spec.semanticHighlightColor) }, 'style-hook'));
        out.commands.push(el('SET_ELEMENT_TIMING', { ref: 'style-hook', startTime: 0,
          duration: spec.persistent ? persistentDuration
            : Math.min(spec.durationSec ?? 3.5, Math.max(1, ctx.project.timelineDurationSec * 0.5)) }));
        out.lines.push(`Hook "${wording}"`);
        target = { ref: 'style-hook' };
      } else {
        out.skipped.push('Hook: no grounded hook wording is available for this clip');
        target = {};
      }
      if (Object.keys(target).length) {
        const refined = styleCommands({ fontSize: visualLayout.hook.fontSize, color: spec.color,
          fontFamily: spec.fontFamily, uppercase: spec.uppercase,
          fontWeight: spec.fontWeight, ...(spec.noStroke ? { strokeWidth: 0, shadow: false } : {}),
          backgroundColor: spec.plate }, target, null, 'Hook');
        out.commands.push(...refined.commands); out.lines.push(...refined.lines);
        if (styleTwo) out.commands.push(el('SET_TEXT_SIZE', { ...target, fontSize: visualLayout.hook.fontSize }));
        if (spec.noStroke) {
          out.commands.push(el('SET_TEXT_SPACING', { ...target, letterSpacing: 0,
            lineSpacing: visualLayout.hook.lineHeight }));
        }
        if (spec.persistent && existing) {
          out.commands.push(el('SET_ELEMENT_TIMING', { elementId: existing.id, startTime: 0,
            duration: persistentDuration }));
        }
        out.commands.push(el('MOVE_ELEMENT', { ...target, x: visualLayout.hook.x,
          y: visualLayout.hook.y }));
        out.commands.push(el('RESIZE_ELEMENT', { ...target, width: visualLayout.hook.width,
          height: visualLayout.hook.height }));
      }
    }
  }

  // Optional second angle from the shared creative package.
  const text = component<TextSpec>('TEXT');
  if (text?.spec.role === 'SUPPORTING_LINE' && visualLayout.supportingText) {
    const shownHook = String(ctx.elements.find((view) => view.semantic === 'HOOK')
      ?.properties.content ?? '');
    const wording = chooseSupportingLine(info.supportingLine ? [{text:info.supportingLine}] : [], [layoutHook, shownHook]);
    if (wording) {
      const region = visualLayout.supportingText;
      out.commands.push(el('ADD_TEXT', { content: wording, textStyleId: text.spec.textStyle,
        origin: 'PRESET', presetRole: 'KEY_POINT' }, 'style-support'));
      out.commands.push(el('SET_ELEMENT_TIMING', { ref: 'style-support', startTime: 0,
        duration: Math.max(1, ctx.project.timelineDurationSec) }));
      const refined = styleCommands({ fontSize: text.spec.fontSize ?? region.fontSize,
        color: text.spec.color, fontFamily: text.spec.fontFamily, fontWeight: text.spec.fontWeight,
        ...(text.spec.noStroke ? { strokeWidth: 0, shadow: false } : {}) }, { ref: 'style-support' },
      null, 'Supporting line');
      out.commands.push(...refined.commands); out.lines.push(...refined.lines);
      if (text.spec.noStroke) {
        out.commands.push(el('SET_TEXT_SPACING', { ref: 'style-support', letterSpacing: 0,
          lineSpacing: region.lineHeight }));
      }
      out.commands.push(el('MOVE_ELEMENT', { ref: 'style-support', x: region.x, y: region.y }));
      out.commands.push(el('RESIZE_ELEMENT', { ref: 'style-support', width: region.width,
        height: region.height }));
      out.lines.push(`Supporting line -> "${wording}"`);
    }
  }

  // --- ZOOM
  const zoom = component<ZoomSpec>('ZOOM');
  if (zoom) {
    if (zoom.spec.maxCount <= 0) {
      if (ctx.tracks.zooms || ctx.project.style.zoomPolicy !== 'OFF') {
        out.commands.push(el('REMOVE_ZOOM', { scope: 'TRACK' })); out.lines.push('No zoom');
      }
    } else {
      const commandStart = out.commands.length;
      toolCommands('zoom.add_semantic', { maxCount: zoom.spec.maxCount, scale: zoom.spec.scale,
        minSpacingSec: zoom.spec.minSpacingSec, phraseTimed: zoom.spec.phraseTimed === true,
        profile: zoom.spec.phraseTimed ? 'AUTOMATIC_2' : undefined }, ctx, out, 'Zoom');
      if ((visualLayout.editingProfile === 'AUTOMATIC_2' || styleTwo) && visualLayout.cameraPath) {
        for (const command of out.commands.slice(commandStart)) {
          if (command.action !== 'ADD_ZOOM') continue;
          const mid = Number(command.payload.startTime) + Number(command.payload.duration) / 2;
          const crop = [...visualLayout.cameraPath].sort((a, b) =>
            Math.abs(a.t - mid) - Math.abs(b.t - mid))[0];
          const sourceSec = ctx.runtime.map.toSource(mid);
          const frame = sourceSec == null ? null : [...ctx.runtime.analysisFrames].sort((a, b) =>
            Math.abs(a.t - sourceSec) - Math.abs(b.t - sourceSec))[0];
          const face = frame?.faces.slice().sort((a, b) =>
            (b.mouthActivity ?? 0) - (a.mouthActivity ?? 0) || b.w * b.h - a.w * a.h)[0];
          if (crop && face) {
            command.payload.focusX = Math.max(.25, Math.min(.75,
              (face.x + face.w / 2 - crop.x) / crop.w));
            command.payload.focusY = Math.max(.25, Math.min(.75,
              (face.y + face.h / 2 - crop.y) / crop.h));
            if (face.trackId) command.payload.focusTrackId = face.trackId;
          }
        }
      }
      // The canonical timeline must not carry an emphasis zoom the renderer will drop (it would play in the
      // editor preview and vanish from the export). Ask the renderer's own planner, with the same camera,
      // shots and spacing it will use, and keep only what it accepts. Rendered output is unchanged: a rejected
      // zoom was never rendered.
      if (zoom.spec.phraseTimed && cardCamera) {
        const pending = out.commands.slice(commandStart).filter((command) => command.action === 'ADD_ZOOM');
        const limits = phraseZoomLimits(ctx.runtime.map.durationSec);
        const verdict = planEditModeZoom({ policy: 'OFF', moments: [], map: ctx.runtime.map, shots: cardCamera.shots,
          frameSegments: cardCamera.frameSegments, frames: cardFrames, cropAt: cardCamera.cropAt,
          focalAt: cardCamera.focalAt, fps: 30, durationSec: ctx.runtime.map.durationSec, ...limits,
          switchTimes: cardCamera.speakerSegments.slice(1).map((segment) => segment.startSec),
          manual: pending.map((command, index) => ({ elementId: `pending-${index}`,
            startSec: Number(command.payload.startTime),
            endSec: Number(command.payload.startTime) + Number(command.payload.duration),
            scale: Number(command.payload.scale), enabled: true, claimsMoment: null,
            triggerText: String(command.payload.triggerText ?? ''),
            focusX: command.payload.focusX as number | undefined, focusY: command.payload.focusY as number | undefined,
            focusTrackId: command.payload.focusTrackId as string | undefined })) }).events;
        const accepted = new Set(verdict.map((event) => event.id));
        pending.forEach((command, index) => {
          if (accepted.has(`ze-pending-${index}`)) return;
          out.commands.splice(out.commands.indexOf(command), 1);
          out.skipped.push(`Zoom at ${Number(command.payload.startTime).toFixed(1)}s dropped: the renderer cannot settle it inside one shot`);
          const line = out.lines.findIndex((text) => text.startsWith('Zoom at ') &&
            text.includes(`("${String(command.payload.triggerText ?? '').slice(0, 40)}")`));
          if (line >= 0) out.lines.splice(line, 1);
        });
      }
    }
  }

  // --- AUDIO (music settings need a music track; the voice level always applies)
  const audio = component<AudioSpec>('AUDIO');
  if (audio) {
    const hasMusic = ctx.elements.some((view) => view.type === 'AUDIO');
    if (audio.spec.sourceVolume !== undefined) {
      toolCommands('audio.source_volume', { volume: audio.spec.sourceVolume }, ctx, out, 'Audio');
    }
    if (hasMusic) {
      if (audio.spec.muteMusic) toolCommands('audio.music_mute', { muted: true }, ctx, out, 'Audio');
      if (audio.spec.musicVolume !== undefined) toolCommands('audio.music_volume', { volume: audio.spec.musicVolume }, ctx, out, 'Audio');
      if (audio.spec.ducking) {
        if (info.hasWordTimings) toolCommands('audio.ducking', { enabled: true, strength: audio.spec.ducking }, ctx, out, 'Audio');
        else out.skipped.push('Audio: ducking needs word timings, which this source lacks');
      }
    } else if (audio.spec.musicVolume !== undefined || audio.spec.ducking) {
      out.skipped.push('Audio: this clip has no music track, so music level/ducking do not apply');
    }
  }

  // --- OVERLAY (only when the project has a logo)
  const overlay = component<OverlaySpec>('OVERLAY');
  if (overlay) {
    if (ctx.elements.some((view) => view.semantic === 'LOGO')) {
      toolCommands('logo.move', { position: overlay.spec.logoPosition, scope: 'ALL' }, ctx, out, 'Logo');
    } else out.skipped.push('Logo: this project has no logo to place');
  }
  return out;
}
