// Strict public operation contracts for the shared canonical editor. No raw properties/settings/URLs.
import { z } from 'zod';
import { PHASE3_ACTIONS } from './edit-command-actions';
import { CAPTION_STYLE_PRESETS, TEXT_STYLE_PRESETS, EDIT_MODE_FONT_IDS } from './edit-mode-text';
const uuid = z.uuid(), num = z.number().finite(), unit = num.min(0).max(1), sec = num.min(0).max(10800), positive = sec.min(.001), text = z.string().max(2000), color = z.string().regex(/^#[a-fA-F0-9]{6}(?:[a-fA-F0-9]{2})?$/);
export const TEXT_ROLES = ['HOOK', 'HEADLINE', 'TITLE', 'CTA', 'LABEL', 'OTHER_TEXT'] as const;
export const REGIONS = ['AUTO', 'HOOK', 'HEADLINE', 'CAPTIONS', 'BELOW_CAPTIONS', 'LOWER_CTA', 'LOGO', 'TOP_LEFT', 'TOP_CENTER', 'TOP_RIGHT', 'CENTER_LEFT', 'CENTER', 'CENTER_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_CENTER', 'BOTTOM_RIGHT', 'REUSE_ELEMENT'] as const;
export const placementSchema = z.object({ region: z.enum(REGIONS).default('AUTO'), reuseElementId: uuid.optional(), allowOverlap: z.boolean().default(false) }).strict();
const f: Record<string, z.ZodType> = { elementId: uuid, fromElementId: uuid, assetId: uuid, scope: z.enum(['SELECTED_ELEMENT', 'TRACK', 'CURRENT_VIDEO_SEGMENT', 'ALL_VIDEO_SEGMENTS', 'PROJECT']), elementType: z.enum(['VIDEO', 'AUDIO', 'TEXT', 'SUBTITLE', 'IMAGE']), content: text, textStyleId: z.enum(TEXT_STYLE_PRESETS.map(x => x.id) as [
        string,
        ...string[]
    ]), captionStyleId: z.enum(CAPTION_STYLE_PRESETS.map(x => x.id) as [
        string,
        ...string[]
    ]), role: z.enum(TEXT_ROLES), placement: placementSchema, startTime: sec, duration: positive, trimStart: sec, trimEnd: positive, playheadSec: sec, toPosition: z.number().int().min(0).max(10000), track: z.number().int().min(0).max(100), x: unit, y: unit, width: unit.min(.02), height: unit.min(.02), opacity: unit, zIndex: z.number().int().min(-1000).max(1000), rotation: num.min(-360).max(360), flipH: z.boolean(), flipV: z.boolean(), cropLeft: unit.max(.95), cropRight: unit.max(.95), cropTop: unit.max(.95), cropBottom: unit.max(.95), scale: num.min(.1).max(4), speed: num.min(.25).max(4), offsetX: num.min(-1).max(1), offsetY: num.min(-1).max(1), volume: num.min(0).max(2), muted: z.boolean(), fadeInSec: sec, fadeOutSec: sec, duckEnabled: z.boolean(), duckStrength: z.enum(['LIGHT', 'MEDIUM', 'STRONG']), attackMs: num.min(0).max(10000), releaseMs: num.min(0).max(10000), fontFamily: z.string().min(1).max(100), fontSize: num.min(8).max(300), fontWeight: z.number().int().min(100).max(900).multipleOf(100), color, textAlign: z.enum(['left', 'center', 'right']), strokeEnabled: z.boolean(), strokeColor: color, strokeWidth: num.min(0).max(40), shadowEnabled: z.boolean(), shadowColor: color, shadowOpacity: unit, shadowBlur: num.min(0).max(60), shadowOffsetX: num.min(-60).max(60), shadowOffsetY: num.min(-60).max(60), backgroundEnabled: z.boolean(), backgroundColor: color, backgroundOpacity: unit, backgroundPadding: num.min(0).max(120), backgroundRadius: num.min(0).max(120), letterSpacing: num.min(-20).max(60), lineSpacing: num.min(.6).max(3), uppercase: z.boolean(), activeWordEnabled: z.boolean(), activeWordColor: color, visible: z.boolean(), locked: z.boolean(), atSec: sec, direction: z.enum(['PREVIOUS', 'NEXT', 'WEAKER', 'STRONGER']), enabled: z.boolean(), claimsMoment: z.string().max(120), triggerText: z.string().max(200), mode: z.enum(['FIT', 'FILL', 'FREE', 'ASPECT']), aspectRatio: z.enum(['SOURCE', '9:16', '16:9', '1:1']), fitMode: z.enum(['FIT', 'FILL']), policy: z.enum(['AUTO', 'FACE_FOCUSED', 'INFORMATION_PRESERVING', 'SOURCE', 'OFF', 'SUBTLE', 'BALANCED', 'STRONG', 'SEMANTIC', 'FACE_PRIORITY', 'TALKING_HEAD', 'CENTERED', 'INFORMATION_PRIORITY', 'SCREEN_TUTORIAL']), clearSegmentOverrides: z.boolean(), step: num.min(.001).max(.2), background: z.enum(['BLUR', 'BLACK', 'WHITE']), filterId: z.enum(['ORIGINAL', 'CLEAN', 'WARM', 'COOL', 'CINEMATIC', 'VIBRANT', 'SOFT', 'HIGH_CONTRAST', 'VINTAGE', 'BLACK_AND_WHITE']), strength: unit, textRuns: z.array(z.object({ text: z.string().max(2000), color }).strict()).max(24) };
export type EditorActionDefinition = {
    action: string;
    fields: string[];
    required: string[];
    kind: 'ELEMENT';
    schema: z.ZodObject<any>;
};
export const EDITOR_ACTIONS: EditorActionDefinition[] = [];
function action(name: string, fields: string = '', required: string = '') {
    const names = [...new Set(['elementId', ...fields.split(' ').filter(Boolean)])];
    const req = required.split(' ').filter(Boolean);
    const shape: Record<string, z.ZodType> = { action: z.literal(name) };
    for (const key of names) {
        if (!f[key])
            throw Error('Unknown canonical contract field ' + key);
        const field = key === 'direction' ? z.enum(name === 'MERGE_CAPTION' ? ['PREVIOUS', 'NEXT'] : ['WEAKER', 'STRONGER']) : f[key];
        shape[key] = req.includes(key) ? field : field.optional();
    }
    EDITOR_ACTIONS.push({ action: name, fields: names, required: req, kind: 'ELEMENT', schema: z.object(shape).strict() });
}
action('ADD_TEXT', 'content textStyleId role placement startTime duration', 'content');
action('ADD_SUBTITLE', 'content placement startTime duration', 'content startTime duration');
for (const x of ['ADD_IMAGE', 'ADD_LOGO'])
    action(x, 'assetId placement startTime duration', 'assetId');
action('ADD_AUDIO', 'assetId startTime', 'assetId');
action('MOVE_ELEMENT', 'x y scope elementType placement');
action('RESIZE_ELEMENT', 'width height scope elementType');
action('SET_ELEMENT_TIMING', 'startTime duration trimStart trimEnd', 'elementId startTime duration');
action('SET_ELEMENT_OPACITY', 'opacity scope elementType', 'opacity');
action('SET_ELEMENT_Z_INDEX', 'zIndex', 'elementId zIndex');
action('UPDATE_TEXT', 'content fontSize fontWeight fontFamily color textAlign', 'elementId content');
action('SET_TEXT_CONTENT', 'content', 'elementId content');
action('SET_TEXT_RUNS', 'textRuns', 'elementId textRuns');
for (const [a, k] of Object.entries({ SET_TEXT_FONT: 'fontFamily', SET_TEXT_SIZE: 'fontSize', SET_TEXT_WEIGHT: 'fontWeight', SET_TEXT_COLOR: 'color', SET_TEXT_ALIGNMENT: 'textAlign', SET_TEXT_CASE: 'uppercase' }))
    action(a, k + ' scope elementType', k);
action('SET_TEXT_STROKE', 'strokeEnabled strokeColor strokeWidth scope elementType', 'strokeEnabled strokeColor strokeWidth');
action('SET_TEXT_SHADOW', 'shadowEnabled shadowColor shadowOpacity shadowBlur shadowOffsetX shadowOffsetY scope elementType', 'shadowEnabled shadowColor shadowOpacity shadowBlur shadowOffsetX shadowOffsetY');
action('SET_TEXT_BACKGROUND', 'backgroundEnabled backgroundColor backgroundOpacity backgroundPadding backgroundRadius scope elementType', 'backgroundEnabled backgroundColor backgroundOpacity backgroundPadding backgroundRadius');
action('SET_TEXT_SPACING', 'letterSpacing lineSpacing scope elementType');
action('SET_TEXT_STYLE_PRESET', 'textStyleId scope elementType', 'textStyleId');
action('SET_CAPTION_ACTIVE_WORD', 'activeWordEnabled activeWordColor scope elementType', 'activeWordEnabled activeWordColor');
for (const a of ['GENERATE_CAPTIONS', 'REGENERATE_CAPTIONS'])
    action(a, 'captionStyleId');
action('REMOVE_CAPTIONS');
action('SET_CAPTIONS_VISIBLE', 'visible', 'visible');
action('SET_CAPTION_TEXT', 'content', 'elementId content');
action('SPLIT_CAPTION', 'atSec', 'elementId atSec');
action('MERGE_CAPTION', 'direction', 'elementId direction');
action('SET_CAPTION_STYLE', 'captionStyleId scope elementType', 'captionStyleId');
action('APPLY_CAPTION_STYLE_TO_ALL', '', 'elementId');
for (const a of ['SET_ELEMENT_VISIBLE', 'SET_ELEMENT_LOCKED'])
    action(a, (a === 'SET_ELEMENT_VISIBLE' ? 'visible' : 'locked') + ' scope elementType', a === 'SET_ELEMENT_VISIBLE' ? 'visible' : 'locked');
action('SET_AUDIO_VOLUME', 'volume scope', 'volume');
action('SET_SOURCE_AUDIO_VOLUME', 'volume scope', 'volume');
action('SET_AUDIO_MUTED', 'muted scope', 'muted');
action('SET_SOURCE_AUDIO_MUTED', 'muted scope', 'muted');
action('SET_AUDIO_FADE', 'fadeInSec fadeOutSec', 'elementId');
action('SET_AUDIO_TRIM', 'trimStart trimEnd', 'elementId trimStart trimEnd');
action('SET_AUDIO_DUCKING', 'duckEnabled duckStrength attackMs releaseMs', 'duckEnabled');
action('SET_VIDEO_CROP', 'cropLeft cropRight cropTop cropBottom scope', 'cropLeft cropRight cropTop cropBottom');
action('SET_VIDEO_ROTATION', 'rotation scope', 'rotation');
action('SET_VIDEO_FLIP', 'flipH flipV scope', 'flipH flipV');
action('SET_VIDEO_SCALE', 'scale scope', 'scale');
f.x = num.min(-1).max(1);
f.y = num.min(-1).max(1);
action('SET_VIDEO_POSITION', 'x y scope', 'x y');
f.x = unit;
f.y = unit;
action('SET_SPEED', 'speed', 'elementId speed');
action('SET_VIDEO_FRAMING', 'mode aspectRatio fitMode cropLeft cropRight cropTop cropBottom scope', 'mode');
action('SET_REFRAME_POLICY', 'policy clearSegmentOverrides', 'policy');
action('SET_FIT_BACKGROUND', 'background', 'background');
for (const field of ['EXPOSURE', 'BRIGHTNESS', 'CONTRAST', 'SATURATION', 'HIGHLIGHTS', 'SHADOWS', 'TEMPERATURE', 'TINT', 'SHARPNESS', 'FADE', 'VIGNETTE']) {
    const key = field.toLowerCase();
    f[key] = ['SHARPNESS', 'FADE', 'VIGNETTE'].includes(field) ? unit : num.min(-1).max(1);
    action('SET_VIDEO_' + field, key + ' scope', key);
}
action('RESET_VIDEO_ADJUSTMENTS', 'scope');
action('APPLY_COLOR_FILTER', 'filterId strength scope', 'filterId');
action('PASTE_VIDEO_ADJUSTMENTS', 'fromElementId scope', 'fromElementId');
action('ADD_ZOOM', 'startTime duration scale claimsMoment triggerText enabled', 'startTime duration scale');
action('SET_ZOOM_SCALE', 'scale scope', 'scale');
action('REMOVE_ZOOM', 'scope');
action('ADJUST_ZOOM_STRENGTH', 'direction step scope', 'direction');
action('DUPLICATE_ELEMENT', 'placement', 'elementId');
action('REMOVE_ELEMENT', '', 'elementId');
action('TRIM_ELEMENT', 'trimStart trimEnd', 'elementId trimStart trimEnd');
action('SPLIT_ELEMENT', 'playheadSec', 'elementId playheadSec');
action('DELETE_ELEMENT', '', 'elementId');
action('REORDER_ELEMENT', 'toPosition', 'elementId toPosition');
const missing = PHASE3_ACTIONS.filter(a => !EDITOR_ACTIONS.some(d => d.action === a));
if (missing.length)
    throw Error('Unmapped canonical editor actions: ' + missing.join(','));
export const editorCommandSchema = z.discriminatedUnion('action', EDITOR_ACTIONS.map(d => d.schema) as any);
export const editorBatchSchema = z.array(editorCommandSchema).min(1).max(50);
export const editorCommandCatalog = () => EDITOR_ACTIONS.map(({ action, fields, required }) => ({ action, fields, required }));
export const editorStyleCatalog = () => ({ fonts: EDIT_MODE_FONT_IDS, textStyles: TEXT_STYLE_PRESETS.map(p => ({ id: p.id, label: p.label })), captionStyles: CAPTION_STYLE_PRESETS.map(p => ({ id: p.id, label: p.label })), coordinateSpace: 'NORMALIZED_TOP_LEFT_CANVAS', volume: { recorded100Percent: 1, min: 0, max: 2, hiddenGain: false }, unsupported: ['ARBITRARY_CSS', 'ARBITRARY_FILESYSTEM_OR_ASSET_URL', 'RAW_DATABASE_OR_RENDERER_MUTATION', 'UNSUPPORTED_VIDEO_TRANSITIONS', 'ARBITRARY_KEYFRAME_ANIMATIONS'] });
