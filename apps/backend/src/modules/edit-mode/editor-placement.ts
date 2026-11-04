// Shared canonical placement: named regions from the existing layout resolver, timed layer conflicts,
// template defaults, and the editor's own text metrics. No random coordinates or image analysis.
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { resolveVisualLayout, autoFitText, type NormalizedRect } from './styles/resolved-visual-layout';
import { resolveCreativeStyle } from './styles/creative-style-resolver';
import { fullTemplate, componentStyle } from './styles/creative-style-library';
import { readTextStyle, textStylePreset, captionStylePreset, styleProperties } from './edit-mode-text';
import { measureTextLayout, textCanvasSize } from '@ai-content-platform/shared/editor-text-layout.cjs';
import { elementBox, elementRole, object } from './editor-element-view';
export function projectStyleId(p: any) { const s = object(p.settings), run = object(s.templateRun), state = object(s.editorTemplateState); if (Number(run.appliedAtRevision || 0) > Number(state.appliedAtRevision || 0))
    return String(run.templateId); return String(state.templateId || object(s.generationStyle).templateId || object(s.resolvedCreativeStyle).templateId || object(s.generationTier).templateId || 'STYLE_ZERO'); }
export function editorLayout(p: any) { const s = object(p.settings), source = p.assets.find((a: any) => a.role === 'SOURCE'), id = projectStyleId(p); const resolved = resolveCreativeStyle({ templateId: id }); const layout = s.resolvedVisualLayout && typeof s.resolvedVisualLayout === 'object' ? s.resolvedVisualLayout : resolveVisualLayout(resolved, { sourceWidth: source?.width, sourceHeight: source?.height }); return { template: id, regions: { HOOK: layout.hook, HEADLINE: layout.hook, CAPTIONS: layout.captions, LOGO: layout.overlays.logo, PRIMARY_MEDIA: layout.videoFrame, ...(layout.supportingText ? { SUPPORTING_TEXT: layout.supportingText } : {}) }, safeAreas: layout.safeAreas, faceSafeEnvelope: layout.faceSafeRegion || null, faceEvidence: 'LAYOUT_ENVELOPE_ONLY_NOT_MEASURED_FACE_DETECTION', layout }; }
const overlap = (a: NormalizedRect, b: NormalizedRect) => a.x < b.x + b.width - .002 && a.x + a.width > b.x + .002 && a.y < b.y + b.height - .002 && a.y + a.height > b.y + .002;
export function planPlacement(p: any, input: {
    role: string;
    placement?: any;
    width?: number;
    height?: number;
    start?: number;
    end?: number;
    excludeIds?: string[];
}) {
    const { layout, safeAreas: safe } = editorLayout(p), region = String(input.placement?.region || 'AUTO'), existing = input.placement?.reuseElementId ? p.elements.find((e: any) => e.id === input.placement.reuseElementId) : null;
    if (input.placement?.reuseElementId && !existing)
        throw new NotFoundException('Placement target not found.');
    const start = input.start ?? 0, end = input.end ?? Math.max(...p.elements.filter((e: any) => e.type === 'VIDEO').map((e: any) => e.startTime + e.duration), 0);
    const captionBoxes = p.elements.filter((e: any) => e.type === 'SUBTITLE' && e.startTime < end && e.startTime + e.duration > start && !e.properties?.hidden).map(elementBox);
    const role = input.role, hook = ['HOOK', 'HEADLINE', 'TITLE'].includes(role), base = hook ? layout.hook : role === 'CAPTION' ? layout.captions : role === 'LOGO' ? layout.overlays.logo : { x: safe.left, y: 1 - safe.bottom - .075, width: 1 - safe.left - safe.right, height: role === 'CTA' ? .05 : .075 };
    const width = input.width ?? (existing ? elementBox(existing).width : base.width), height = input.height ?? (existing ? elementBox(existing).height : base.height);
    let candidates: NormalizedRect[] = [];
    if (region === 'REUSE_ELEMENT') {
        if (!existing)
            throw new BadRequestException({ code: 'PLACEMENT_TARGET_REQUIRED', message: 'Choose the existing element whose box should be reused.' });
        candidates = [elementBox(existing)];
    }
    else if (region === 'HOOK' || region === 'HEADLINE' || region === 'AUTO' && hook)
        candidates = [{ ...layout.hook, width, height }];
    else if (region === 'CAPTIONS' || region === 'AUTO' && role === 'CAPTION')
        candidates = [{ ...(captionBoxes[0] || layout.captions), width, height }];
    else if (region === 'LOGO' || region === 'AUTO' && role === 'LOGO')
        candidates = [{ ...layout.overlays.logo, width, height }];
    else if (['BELOW_CAPTIONS', 'LOWER_CTA'].includes(region) || region === 'AUTO' && role === 'CTA') {
        const bottom = captionBoxes.length ? Math.max(...captionBoxes.map((b: any) => b.y + b.height)) : layout.captions.y + layout.captions.height;
        candidates = [{ x: Math.max(safe.left, (1 - width) / 2), y: bottom + .012, width, height }];
        if (region === 'AUTO')
            candidates.push({ x: Math.max(safe.left, (1 - width) / 2), y: 1 - safe.bottom - height, width, height });
    }
    else {
        const [v, h] = region.split('_');
        const x = h === 'LEFT' ? safe.left : h === 'RIGHT' ? 1 - safe.right - width : (1 - width) / 2;
        const y = v === 'TOP' ? safe.top : v === 'BOTTOM' ? 1 - safe.bottom - height : (1 - height) / 2;
        candidates = [{ x, y, width, height }];
    }
    const excluded = new Set([...(input.excludeIds || []), ...(existing ? [existing.id] : [])]), conflicts = new Set<string>();
    for (const box of candidates) {
        const canonical = region === 'REUSE_ELEMENT' || ['HOOK', 'HEADLINE', 'CAPTIONS'].includes(region) || region === 'AUTO' && (hook || role === 'CAPTION');
        const margin = canonical ? { left: 0, top: 0, right: 0, bottom: 0 } : safe;
        if (box.x < margin.left - .002 || box.y < margin.top - .002 || box.x + box.width > 1 - margin.right + .002 || box.y + box.height > 1 - margin.bottom + .002)
            continue;
        const hits = p.elements.filter((e: any) => ['TEXT', 'SUBTITLE', 'IMAGE'].includes(e.type) && !excluded.has(e.id) && !e.properties?.hidden && Number(e.properties?.opacity ?? 1) > 0 && e.startTime < end && e.startTime + e.duration > start && overlap(box, elementBox(e)));
        hits.forEach((e: any) => conflicts.add(e.id));
        if (!hits.length || input.placement?.allowOverlap)
            return { box, region, source: existing ? 'EXISTING_ELEMENT_GEOMETRY' : 'CANONICAL_LAYOUT_REGION', conflicts: hits.map((e: any) => e.id), faceCheck: 'NOT_VISUALLY_VERIFIED; use approved rendered review' };
    }
    throw new BadRequestException({ code: 'PLACEMENT_CONFLICT', message: 'No safe space is available in that region. Choose a different region or adjust the conflicting layers.', conflictingElementIds: [...conflicts].slice(0, 20) });
}
export function roleTextStyle(p: any, role: string): Record<string, any> {
    const template = fullTemplate(projectStyleId(p)), category = role === 'CAPTION' ? 'CAPTIONS' : ['HOOK', 'HEADLINE', 'TITLE', 'CTA'].includes(role) ? 'HOOK' : 'TEXT';
    const spec: any = componentStyle(template?.components[category] || '')?.spec;
    const existing = !template ? p.elements.find((e: any) => elementRole(e) === role) : null;
    const preset = role === 'CAPTION' ? captionStylePreset(spec?.preset || 'CLEAN') : textStylePreset(spec?.textStyle || 'BASIC');
    const style = existing ? readTextStyle(existing.properties) : readTextStyle(styleProperties(preset.style));
    if (spec) {
        for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'color', 'uppercase'] as const)
            if (spec[key] !== undefined)
                (style as any)[key] = spec[key];
        if (spec.plate === 'none')
            style.background = { ...style.background, enabled: false };
        else if (spec.plate)
            style.background = { ...style.background, enabled: true, color: spec.plate, opacity: spec.plateOpacity ?? 1 };
        if (spec.strokeWidth !== undefined)
            style.stroke = { ...style.stroke, enabled: spec.strokeWidth > 0, width: spec.strokeWidth };
        if (spec.shadow !== undefined)
            style.shadow = { ...style.shadow, enabled: spec.shadow };
        if (spec.noStroke && !spec.plate)
            style.background = { ...style.background, enabled: false };
        if (spec.noStroke) {
            style.stroke = { ...style.stroke, enabled: false, width: 0 };
            style.shadow = { ...style.shadow, enabled: false };
        }
        if (spec.activeWord !== undefined)
            style.activeWord = { enabled: spec.activeWord, color: spec.activeWordColor || style.activeWord.color };
    }
    if (role === 'CTA')
        style.fontSize = Math.min(32, style.fontSize);
    return styleProperties(style);
}
export function assertTextBoxFits(p: any, element: any) { if (!['TEXT', 'SUBTITLE'].includes(element.type) || element.properties?.hidden)
    return; const source = p.assets.find((a: any) => a.role === 'SOURCE'), canvas = textCanvasSize(p.settings?.aspectRatio, source?.width, source?.height), props = object(element.properties), style = readTextStyle(props), box = elementBox(element); const measured = measureTextLayout({ content: style.uppercase ? String(props.content || '').toUpperCase() : String(props.content || ''), width: box.width * canvas.width, height: box.height * canvas.height, fontSizePx: style.fontSize * canvas.width / 600, fontFamily: style.fontFamily, lineHeight: style.lineSpacing, letterSpacing: style.letterSpacing * canvas.width / 600, padding: style.background.enabled ? style.background.padding * canvas.width / 600 : 0 }); if (measured.overflow)
    throw new BadRequestException({ code: elementRole(element) === 'HOOK' ? 'HOOK_DOES_NOT_FIT' : elementRole(element) === 'HEADLINE' ? 'HEADLINE_DOES_NOT_FIT' : 'TEXT_DOES_NOT_FIT', message: 'The text does not fit its current box. Shorten it, choose a smaller supported size or resize the box.' }); }
/** Fit new default text using the exact preview/ASS metric, without moving its planned box. */
export function fitDefaultText(p: any, element: any) { const preferred = Number(element.properties.fontSize || 40), minimum = elementRole(element) === 'HOOK' ? 26 : 16; for (let size = preferred; size >= minimum; size -= 2) {
    const next = { ...element, properties: { ...element.properties, fontSize: size } };
    try {
        assertTextBoxFits(p, next);
        return size;
    }
    catch (error) {
        if (!(error instanceof BadRequestException))
            throw error;
    }
} assertTextBoxFits(p, element); return preferred; }
