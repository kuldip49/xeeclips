import { createHash } from 'node:crypto';
import { readTextStyle } from './edit-mode-text';
import { readAudioState } from './edit-mode-audio';
export const object = (x: any): Record<string, any> => x && typeof x === 'object' && !Array.isArray(x) ? x : {};
export function elementRole(e: any) { const p = object(e.properties), role = String(p.templateRole || p.presetRole || p.role || '').toUpperCase(); if (e.type === 'VIDEO')
    return 'VIDEO'; if (e.type === 'SUBTITLE')
    return 'CAPTION'; if (e.type === 'AUDIO')
    return 'MUSIC'; if (e.type === 'IMAGE')
    return role === 'LOGO' ? 'LOGO' : 'IMAGE'; if (e.type === 'EFFECT')
    return p.effect === 'ZOOM' || p.kind === 'ZOOM' || p.zoomType ? 'ZOOM' : 'EFFECT'; return ['HOOK', 'HEADLINE', 'TITLE', 'CTA', 'LABEL'].includes(role) ? role : 'OTHER_TEXT'; }
export const elementBox = (e: any) => { const p = object(e.properties); return { x: Number(p.x ?? 0), y: Number(p.y ?? 0), width: Number(p.width ?? 1), height: Number(p.height ?? 1) }; };
export function captionGroups(p: any) { const groups = new Map<string, any>(); for (const e of p.elements.filter((e: any) => e.type === 'SUBTITLE')) {
    const q = object(e.properties), key = JSON.stringify([e.track, elementBox(e), q.captionTrackRole || null]);
    const id = 'cg_' + createHash('sha256').update(p.id + key).digest('hex').slice(0, 20);
    if (!groups.has(id))
        groups.set(id, { groupId: id, track: e.track, box: elementBox(e), role: q.captionTrackRole === 'PRIMARY_CAPTIONS' ? 'PRIMARY_CAPTIONS' : q.captionTrackRole === 'GENERATED_DUPLICATE' ? 'GENERATED_DUPLICATE' : q.captionTrackRole === 'SECONDARY_CAPTIONS' ? 'SECONDARY_CAPTIONS' : 'UNCLASSIFIED_CAPTIONS', classification: 'STRUCTURAL_GROUP_NOT_VISUAL_PROOF', elementIds: [], start: Infinity, end: 0 });
    const g = groups.get(id);
    g.elementIds.push(e.id);
    g.start = Math.min(g.start, e.startTime);
    g.end = Math.max(g.end, e.startTime + e.duration);
} const out = [...groups.values()].sort((a, b) => a.track - b.track || a.start - b.start || a.groupId.localeCompare(b.groupId)); return out; }
export function elementView(e: any, groups: any[] = []) { const p = object(e.properties), role = elementRole(e), text = e.type === 'TEXT' || e.type === 'SUBTITLE', visual = ['TEXT', 'SUBTITLE', 'IMAGE'].includes(e.type); return { elementId: e.id, type: e.type, role, assetId: e.assetId || null, startTime: e.startTime, endTime: e.startTime + e.duration, track: e.track, position: e.position, layer: Number(p.zIndex ?? e.track), anchor: p.anchor || 'top-left', ...(visual ? elementBox(e) : {}), editable: ['VIDEO', 'TEXT', 'SUBTITLE', 'IMAGE', 'AUDIO', 'EFFECT'].includes(e.type), removable: true, hidden: p.hidden === true, locked: p.locked === true, opacity: Number(p.opacity ?? 1), ...(text ? { text: String(p.content || ''), style: readTextStyle(p), captionGroupId: groups.find(g => g.elementIds.includes(e.id))?.groupId || null, textSource: p.textSource || null } : {}), ...(e.type === 'VIDEO' ? { sourceStart: e.trimStart, sourceEnd: e.trimEnd, speed: p.speed ?? 1, crop: p.crop || { left: 0, right: 0, top: 0, bottom: 0 }, zoom: p.scale ?? 1, pan: { x: p.offsetX ?? 0, y: p.offsetY ?? 0 }, framing: { fitMode: p.frameLayout || null, rotation: p.rotation || 0, flipH: p.flipH === true, flipV: p.flipV === true }, sourceVolume: p.sourceVolume ?? 1, sourceMuted: p.sourceMuted === true } : {}), ...(e.type === 'IMAGE' ? { transform: { rotation: p.rotation ?? 0, flipH: p.flipH === true, flipV: p.flipV === true, crop: p.crop || { left: 0, right: 0, top: 0, bottom: 0 }, preserveAspectRatio: p.preserveAspectRatio !== false } } : {}), ...(e.type === 'AUDIO' ? { audio: { volume: p.volume ?? 1, muted: p.muted === true, fadeInSec: p.fadeInSec ?? 0, fadeOutSec: p.fadeOutSec ?? 0, duckEnabled: p.duckUnderSpeech === true, duckStrength: p.duckStrength || null }, sourceStart: e.trimStart, sourceEnd: e.trimEnd } : {}), ...(e.type === 'EFFECT' ? { effect: { kind: 'ZOOM', scale: p.scale ?? 1, enabled: p.enabled !== false, claimsMoment: p.claimsMoment || null } } : {}), template: { role: p.templateRole || p.presetRole || null, templateId: p.templateId || p.presetId || null, origin: p.origin || 'USER' } }; }
