import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EditModeService, type AssistantBundleCommand } from './edit-mode.service';
import { EditChatService } from './chat/edit-chat.service';
import { EditTemplateService } from './edit-template.service';
import { EditModePresetService } from './edit-mode-preset.service';
import { editorBatchSchema, editorCommandCatalog, editorStyleCatalog } from './editor-command-contract';
import { elementRole, elementBox, elementView, captionGroups, object } from './editor-element-view';
import { editorLayout, planPlacement, roleTextStyle, assertTextBoxFits, fitDefaultText } from './editor-placement';
import { compileCreativeStyle } from './styles/creative-style-commands';
import { resolveCreativeStyle } from './styles/creative-style-resolver';
import { readTextStyle } from './edit-mode-text';
const el = (action: string, payload: Record<string, any>, ref?: string): AssistantBundleCommand => ({ kind: 'ELEMENT', action, payload, ...(ref ? { ref } : {}) });
const duration = (p: any) => p.elements.filter((e: any) => e.type === 'VIDEO').reduce((n: number, e: any) => Math.max(n, e.startTime + e.duration), 0);
const intersects = (a: any, b: any) => a.x < b.x + b.width - .002 && a.x + a.width > b.x + .002 && a.y < b.y + b.height - .002 && a.y + a.height > b.y + .002;
/** Shared application-level editor operations. OAuth adapters never mutate editor persistence. */
@Injectable()
export class EditorControlService {
    constructor(private readonly edit: EditModeService, private readonly chat: EditChatService, private readonly templates: EditTemplateService, private readonly presets: EditModePresetService) { }
    async capabilities() { const t = await this.templates.list(); return { version: 1, commands: editorCommandCatalog(), ...editorStyleCatalog(), templates: { styles: ['STYLE_ZERO', 'STYLE_ONE', 'STYLE_TWO'], builtin: t.builtin, user: t.user.map((x: any) => ({ id: x.id, name: x.name })) }, presets: this.presets.list(), history: 'SHARED_CANONICAL_EDIT_HISTORY', writes: 'expectedRevision + idempotencyKey; atomic batch; read latest state after success', placement: 'Named canonical regions, timed layer conflict detection; face envelope is advisory, rendered review required.', review: 'Separate scope and explicit human approval; sampled real media only; maximum three approved render versions within fifteen minutes.' }; }
    async elements(id: string, offset = 0, limit = 100) { const p = await this.edit.get(id), groups = captionGroups(p); return { editProjectId: id, revision: p.revision, duration: duration(p), total: p.elements.length, elements: p.elements.slice(offset, offset + limit).map(e => elementView(e, groups)), nextOffset: offset + limit < p.elements.length ? offset + limit : null, captionGroups: groups, embeddedSourceText: 'Not an editable layer. Structural caption grouping is not proof of duplicate visible captions.' }; }
    async layout(id: string) { const p = await this.edit.get(id); const { layout, ...view } = editorLayout(p); return { editProjectId: id, revision: p.revision, ...view, media: p.elements.filter(e => e.type === 'VIDEO').map(e => elementView(e)), captionGroups: captionGroups(p) }; }
    async placement(id: string, input: any) { const p = await this.edit.get(id); return { editProjectId: id, revision: p.revision, ...planPlacement(p, input) }; }
    private async commit(p: any, revision: number, commands: AssistantBundleCommand[], summary: string, validatePlacementRefs: string[] = [], overlapAllowed = new Set<string>(), fitDefaults = false) {
        const prior = new Map<string, any>(p.elements.map((e: any) => [e.id, e]));
        const result = await this.edit.applyAssistantBundle(p.id, revision, { proposalId: randomUUID(), summary, userMessage: summary, commands, actor: 'AI_ACTION', onInvalid: 'ABORT', onBlocked: 'ABORT', validatePlannedState: (elements, settings) => {
                const planned = { ...p, elements, settings };
                for (const e of elements) {
                    const old = prior.get(e.id);
                    if (['TEXT', 'SUBTITLE'].includes(e.type) && (!old || JSON.stringify(old.properties) !== JSON.stringify(e.properties))) {
                        if (fitDefaults)
                            e.properties = { ...object(e.properties), fontSize: fitDefaultText(planned, e) };
                        assertTextBoxFits(planned, e);
                    }
                }
                // Validate actual added geometry after canonical normalization, including conflicts introduced by later commands.
                if (validatePlacementRefs.length)
                    for (const e of elements.filter(e => !prior.has(e.id) && ['TEXT', 'SUBTITLE', 'IMAGE'].includes(e.type))) {
                        if (overlapAllowed.has(String(e.properties && object(e.properties).presetRunId)))
                            continue;
                        const hits = elements.filter(o => o.id !== e.id && ['TEXT', 'SUBTITLE', 'IMAGE'].includes(o.type) && !object(o.properties).hidden && Number(object(o.properties).opacity ?? 1) > 0 && o.startTime < e.startTime + e.duration && o.startTime + o.duration > e.startTime && intersects(elementBox(e), elementBox(o)));
                        if (hits.length)
                            throw new BadRequestException({ code: 'PLACEMENT_CONFLICT', message: 'The new layer overlaps another visible layer. Choose another region.' });
                    }
            } });
        return { editProjectId: p.id, revision: result.revision, saved: true };
    }
    async apply(id: string, revision: number, input: unknown) {
        const parsed = editorBatchSchema.safeParse(input);
        if (!parsed.success)
            throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Use the supported editor command contract.' });
        const p = await this.edit.get(id);
        const commands: AssistantBundleCommand[] = [], planned = { ...p, elements: p.elements.map(e => ({ ...e })) }, placed: string[] = [], allowed = new Set<string>();
        for (const [index, raw] of parsed.data.entries()) {
            const { action, placement, role, ...payload } = raw as any;
            const ref = 'new-' + index;
            const target = payload.elementId ? p.elements.find(e => e.id === payload.elementId) : null;
            if (payload.elementId && !target)
                throw new NotFoundException('Editor element not found.');
            if (action === 'MOVE_ELEMENT' && placement) {
                if (!target)
                    throw new BadRequestException('Choose an element to position.');
                const plan = planPlacement(planned, { role: elementRole(target), placement, ...elementBox(target), start: target.startTime, end: target.startTime + target.duration, excludeIds: [target.id] });
                commands.push(el(action, { elementId: target.id, x: plan.box.x, y: plan.box.y }));
                const at = planned.elements.findIndex(e => e.id === target.id);
                planned.elements[at] = { ...target, properties: { ...object(target.properties), x: plan.box.x, y: plan.box.y } };
                continue;
            }
            const addVisual = ['ADD_TEXT', 'ADD_SUBTITLE', 'ADD_IMAGE', 'ADD_LOGO'].includes(action), duplicate = action === 'DUPLICATE_ELEMENT' && target && ['TEXT', 'SUBTITLE', 'IMAGE'].includes(target.type);
            if (addVisual || duplicate) {
                const actualRole = duplicate ? elementRole(target) : role || (action === 'ADD_SUBTITLE' ? 'CAPTION' : action === 'ADD_LOGO' ? 'LOGO' : action === 'ADD_IMAGE' ? 'IMAGE' : 'OTHER_TEXT');
                const start = payload.startTime ?? target?.startTime ?? 0, len = payload.duration ?? target?.duration ?? duration(p), box = duplicate ? elementBox(target) : undefined;
                const plan = planPlacement(planned, { role: actualRole, placement, ...box, start, end: start + len });
                const { startTime: _start, duration: _duration, ...add } = payload;
                if (action === 'ADD_SUBTITLE') {
                    add.startTime = start;
                    add.duration = len;
                }
                add.presetRole = actualRole === 'CAPTION' ? 'SUBTITLE' : actualRole === 'IMAGE' ? 'PRODUCT' : actualRole;
                add.presetRunId = ref;
                commands.push(el(action, add, ref));
                placed.push(ref);
                if (placement?.allowOverlap)
                    allowed.add(ref);
                const sel = { ref };
                commands.push(el('MOVE_ELEMENT', { ...sel, x: plan.box.x, y: plan.box.y }), el('RESIZE_ELEMENT', { ...sel, width: plan.box.width, height: plan.box.height }), el('SET_ELEMENT_TIMING', { ...sel, startTime: start, duration: len }));
                if (!duplicate && ['ADD_TEXT', 'ADD_SUBTITLE'].includes(action)) {
                    const style = roleTextStyle(p, actualRole);
                    style.fontSize = fitDefaultText(p, { type: action === 'ADD_SUBTITLE' ? 'SUBTITLE' : 'TEXT', properties: { ...style, ...plan.box, content: payload.content, presetRole: actualRole } });
                    for (const [key, a] of [['fontSize', 'SET_TEXT_SIZE'], ['fontFamily', 'SET_TEXT_FONT'], ['fontWeight', 'SET_TEXT_WEIGHT'], ['color', 'SET_TEXT_COLOR']] as const)
                        commands.push(el(a, { ...sel, [key]: style[key] }));
                    const textStyle = readTextStyle(style);
                    commands.push(el('SET_TEXT_ALIGNMENT', { ...sel, textAlign: textStyle.textAlign }), el('SET_TEXT_BACKGROUND', { ...sel, backgroundEnabled: textStyle.background.enabled, backgroundColor: textStyle.background.color, backgroundOpacity: textStyle.background.opacity, backgroundPadding: textStyle.background.padding, backgroundRadius: textStyle.background.radius }), el('SET_TEXT_STROKE', { ...sel, strokeEnabled: textStyle.stroke.enabled, strokeColor: textStyle.stroke.color, strokeWidth: textStyle.stroke.width }), el('SET_TEXT_SPACING', { ...sel, letterSpacing: textStyle.letterSpacing, lineSpacing: textStyle.lineSpacing }), el('SET_TEXT_CASE', { ...sel, uppercase: textStyle.uppercase }), el('SET_TEXT_SHADOW', { ...sel, shadowEnabled: textStyle.shadow.enabled, shadowColor: textStyle.shadow.color, shadowOpacity: textStyle.shadow.opacity, shadowBlur: textStyle.shadow.blur, shadowOffsetX: textStyle.shadow.offsetX, shadowOffsetY: textStyle.shadow.offsetY }), ...(action === 'ADD_SUBTITLE' ? [el('SET_CAPTION_ACTIVE_WORD', { ...sel, activeWordEnabled: textStyle.activeWord.enabled, activeWordColor: textStyle.activeWord.color })] : []));
                }
                // Reserve the same box for subsequent additions in this atomic batch.
                planned.elements.push({ id: ref, type: duplicate ? target.type : action === 'ADD_SUBTITLE' ? 'SUBTITLE' : action === 'ADD_TEXT' ? 'TEXT' : 'IMAGE', startTime: start, duration: len, properties: { ...plan.box } } as any);
                continue;
            }
            commands.push(el(action, payload));
        }
        return this.commit(p, revision, commands, 'Apply authorized editor commands', placed, allowed);
    }
    async removeCaptionGroup(id: string, revision: number, groupId: string) { const p = await this.edit.get(id), group = captionGroups(p).find(g => g.groupId === groupId); if (!group)
        throw new NotFoundException('Caption group not found.'); return this.commit(p, revision, group.elementIds.map((elementId: string) => el('REMOVE_ELEMENT', { elementId })), 'Remove the explicitly selected caption group'); }
    async template(id: string, revision: number, target: string) {
        if (!['STYLE_ZERO', 'STYLE_ONE', 'STYLE_TWO'].includes(target)) {
            const p = await this.edit.get(id);
            const r = await this.templates.apply(id, { templateId: target, revision, onBlocked: 'ABORT', validatePlannedState: (elements, settings) => { for (const e of elements) {
                    const old = p.elements.find(o => o.id === e.id);
                    if (['TEXT', 'SUBTITLE'].includes(e.type) && (!old || JSON.stringify(old.properties) !== JSON.stringify(e.properties))) {
                        e.properties = { ...object(e.properties), fontSize: fitDefaultText({ ...p, elements, settings }, e) };
                        assertTextBoxFits({ ...p, elements, settings }, e);
                    }
                } } });
            return { editProjectId: id, revision: r.project.revision, saved: true };
        }
        const p = await this.edit.get(id), { context } = await this.chat.loadContext(id, 'Change the requested editor template', { revision });
        const templateId = target === 'STYLE_ONE' ? 'AUTOMATIC_2' : target === 'STYLE_TWO' ? 'AUTOMATIC_3_STYLE_TWO' : 'AUTOMATIC_1';
        // StyleZero has no generation template entry. Resolve existing clean components locally,
        // leaving the generation resolver/defaults unchanged.
        const resolved = resolveCreativeStyle(target === 'STYLE_ZERO' ? { components: { HOOK: 'HOOK_CLEAN', CAPTIONS: 'CAP_CLEAN_LOWER_THIRD', BACKGROUND: 'BG_FULL_FRAME' } } : { templateId });
        const compiled = compileCreativeStyle(resolved, context, { hookOptions: [], hasWordTimings: context.project.hasWordTimings });
        const preserve = new Set(['SET_TEXT_CONTENT', 'SET_TEXT_RUNS', 'SET_ELEMENT_TIMING', 'ADD_TEXT', 'ADD_AUDIO', 'ADD_LOGO', 'ADD_IMAGE', 'REMOVE_ELEMENT', 'REMOVE_CAPTIONS', 'REGENERATE_CAPTIONS', 'GENERATE_CAPTIONS', 'REMOVE_ZOOM', 'ADD_ZOOM', 'SET_ZOOM_SCALE', 'ADJUST_ZOOM_STRENGTH', 'SET_AUDIO_VOLUME', 'SET_AUDIO_MUTED', 'SET_SOURCE_AUDIO_VOLUME', 'SET_SOURCE_AUDIO_MUTED']);
        const commands = compiled.commands.filter(c => !preserve.has(c.action));
        if (target !== 'STYLE_ZERO')
            commands.unshift(el('SET_VIDEO_FRAMING', { mode: 'ASPECT', aspectRatio: '9:16', fitMode: 'FILL', scope: 'PROJECT' }));
        // Reframe/template commands remap composition; restore every existing manual source transform.
        for (const e of p.elements.filter(e => e.type === 'VIDEO')) {
            const q = object(e.properties), crop = object(q.crop);
            commands.push(el('SET_VIDEO_CROP', { elementId: e.id, cropLeft: crop.left ?? 0, cropRight: crop.right ?? 0, cropTop: crop.top ?? 0, cropBottom: crop.bottom ?? 0 }), el('SET_VIDEO_SCALE', { elementId: e.id, scale: q.scale ?? 1 }), el('SET_VIDEO_POSITION', { elementId: e.id, x: q.offsetX ?? 0, y: q.offsetY ?? 0 }));
        }
        commands.push({ kind: 'SETTINGS', action: 'SET_EDITOR_TEMPLATE', payload: { editorTemplateState: { templateId, style: target, appliedAtRevision: p.revision + 1, preserved: ['source ranges', 'manual transforms', 'text content and timing', 'corrected captions', 'audio', 'overlays', 'zoom events'] } } });
        return this.commit(p, revision, commands, 'Change editor template while preserving user content', [], new Set(), true);
    }
    async preset(id: string, revision: number, presetId: string) { const r = await this.presets.apply(id, { revision, presetId }); return { editProjectId: id, revision: r.project.revision, saved: true }; }
    async requirements(id: string, requirements: any[]) { const p = await this.edit.get(id), view = p.elements.map(e => elementView(e)), groups = captionGroups(p); const checks = requirements.map(r => { let pass: boolean | null = null; if (r.type === 'TEXT_PRESENT')
        pass = view.some(e => 'text' in e && String(e.text).includes(r.value || '')); if (r.type === 'ELEMENT_PRESENT')
        pass = view.some(e => e.elementId === r.elementId); if (r.type === 'ELEMENT_ABSENT')
        pass = !view.some(e => e.elementId === r.elementId); if (r.type === 'MAX_DURATION')
        pass = duration(p) <= r.seconds; if (r.type === 'CAPTION_GROUP_COUNT')
        pass = groups.length === r.count; return { type: r.type, status: pass === null ? 'WARN' : pass ? 'PASS' : 'FAIL', evidence: pass === null ? 'Requires actual approved rendered media review.' : 'CANONICAL_METADATA_ONLY' }; }); return { editProjectId: id, revision: p.revision, status: checks.some(c => c.status === 'FAIL') ? 'NEEDS_CHANGES' : checks.some(c => c.status === 'WARN') ? 'REQUIRES_RENDERED_REVIEW' : 'OBJECTIVE_CHECKS_PASSED', checks, visualQuality: 'NOT_EVALUATED', audioQuality: 'NOT_EVALUATED' }; }
}
