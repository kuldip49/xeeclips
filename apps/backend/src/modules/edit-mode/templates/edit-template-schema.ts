// EditMode Workstream F: the template schema.
//
// A template is a STYLE POLICY, not a second project model. It says what an edit
// of this kind should look like; it never carries a timeline, an element list,
// or a renderer path of its own. Applying one turns into validated canonical
// commands against the same EditProject the manual editor writes to.
//
// Every field is a closed enum or a bounded number, and every one of them points
// at something that already exists elsewhere in EditMode: a caption style preset
// from Workstream C, a colour filter from D, an audio bound from D, a zoom or
// reframe policy from Phase 4. Nothing here is free-form JSON, so nothing here
// can reach an EditElement unvalidated.
//
// The schema is VERSIONED. `readTemplate` accepts any supported version,
// normalizes missing optional fields to the documented defaults, and refuses an
// unknown major version outright rather than half-reading it.

import {
  CAPTION_STYLE_PRESET_IDS, TEXT_STYLE_PRESET_IDS, type CaptionStylePresetId,
  type TextStylePresetId
} from '../edit-mode-text';
import { COLOR_FILTER_IDS, type ColorFilterId } from '../edit-mode-color';
import {
  DUCK_STRENGTH_IDS, MAX_FADE_SEC, MAX_VOLUME, type DuckStrengthId
} from '../edit-mode-audio';
import {
  EDIT_ASPECT_RATIOS, EDIT_PACING, INFORMATION_REGION_POLICIES, REFRAME_POLICIES, ZOOM_POLICIES,
  type EditAspectRatio, type EditPacing, type InformationRegionPolicy, type ReframePolicy,
  type ZoomPolicy
} from '../presets/edit-preset-policy';

/**
 * The current schema version.
 *
 * Bump the MINOR part for additive optional fields (old templates keep working,
 * `readTemplate` fills the new field with its default). Bump the MAJOR part only
 * for a change that would make an old template mean something different - and
 * then `readTemplate` must refuse the old major rather than guess.
 */
export const TEMPLATE_SCHEMA_VERSION = 1;
/** Majors this build knows how to read. */
export const SUPPORTED_TEMPLATE_VERSIONS = [1] as const;

export const TEMPLATE_SOURCES = ['BUILTIN', 'USER'] as const;
export type TemplateSource = typeof TEMPLATE_SOURCES[number];

/** Where captions sit. PRESET keeps whatever band the caption style defines. */
export const CAPTION_PLACEMENTS = ['PRESET', 'LOWER', 'CENTER', 'UPPER'] as const;
export type CaptionPlacement = typeof CAPTION_PLACEMENTS[number];

/** KEEP means the template has no opinion and leaves a logo exactly where it is. */
export const LOGO_PLACEMENTS = ['KEEP', 'TOP_LEFT', 'TOP_RIGHT', 'BOTTOM_LEFT',
  'BOTTOM_RIGHT'] as const;
export type LogoPlacement = typeof LOGO_PLACEMENTS[number];

export const MIN_LOGO_SCALE = 0.05;
export const MAX_LOGO_SCALE = 0.5;
export const MAX_TEMPLATE_NAME_LENGTH = 60;
export const MAX_TEMPLATE_DESCRIPTION_LENGTH = 200;

export type EditTemplate = {
  version: number;
  id: string;
  name: string;
  description: string;
  source: TemplateSource;
  project: { aspectRatio: EditAspectRatio; pacing: EditPacing };
  text: {
    /** The style new text is created in after this template is applied. */
    defaultStyleId: TextStylePresetId;
    /** Applied to template-owned hook text only; never to text the user wrote. */
    hookStyleId: TextStylePresetId;
    ctaStyleId: TextStylePresetId;
  };
  captions: {
    styleId: CaptionStylePresetId;
    placement: CaptionPlacement;
    /** null = inherit whatever the caption style preset says. */
    activeWord: boolean | null;
    uppercase: boolean | null;
  };
  logo: { placement: LogoPlacement; scale: number };
  color: { filterId: ColorFilterId; strength: number };
  audio: {
    musicVolume: number;
    duckEnabled: boolean;
    duckStrength: DuckStrengthId;
    fadeInSec: number;
    fadeOutSec: number;
  };
  zoom: ZoomPolicy;
  reframe: ReframePolicy;
  informationRegion: InformationRegionPolicy;
  /**
   * Optional asset binding (Part 9). Absent by default: a template is portable
   * across projects, so it stores a POLICY, never a source video, a caption
   * wording, a hook wording or - unless the user explicitly opts in here - a
   * particular logo or music file.
   */
  assets: { logoAssetId: string | null; musicAssetId: string | null };
};

export class TemplateSchemaError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TemplateSchemaError';
  }
}

const fail = (code: string, message: string): never => { throw new TemplateSchemaError(code, message); };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

/** An enum field: the stored value when it is legal, the default otherwise. A
 *  template written by an older build simply reads as the default rather than
 *  poisoning the whole template. */
const enumField = <T extends string>(value: unknown, options: readonly string[], fallback: T): T =>
  typeof value === 'string' && options.includes(value) ? value as T : fallback;

const boolField = (value: unknown, fallback: boolean) =>
  typeof value === 'boolean' ? value : fallback;

const tristate = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;

const numberField = (value: unknown, min: number, max: number, fallback: number) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Number(Math.min(max, Math.max(min, parsed)).toFixed(4));
};

const textField = (value: unknown, max: number, fallback: string) => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().slice(0, max);
  return trimmed || fallback;
};

/** Asset ids are opaque to the schema but must still look like ids, so a bound
 *  template cannot smuggle something else into an element's assetId. */
const assetField = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-z0-9-]{1,64}$/iu.test(value) ? value : null;

/**
 * The documented defaults. Anything a template does not state reads as this, so
 * a v1 template gains a v1.x field without being rewritten.
 */
export const TEMPLATE_DEFAULTS: Omit<EditTemplate, 'id' | 'name' | 'description' | 'source' | 'version'> = {
  project: { aspectRatio: 'SOURCE', pacing: 'SOURCE' },
  text: { defaultStyleId: 'BASIC', hookStyleId: 'HOOK', ctaStyleId: 'CTA' },
  captions: { styleId: 'CLEAN', placement: 'PRESET', activeWord: null, uppercase: null },
  logo: { placement: 'KEEP', scale: 0.2 },
  color: { filterId: 'ORIGINAL', strength: 1 },
  audio: { musicVolume: 0.25, duckEnabled: false, duckStrength: 'MEDIUM', fadeInSec: 0.5,
    fadeOutSec: 0.5 },
  zoom: 'OFF', reframe: 'SOURCE', informationRegion: 'RESPECT',
  assets: { logoAssetId: null, musicAssetId: null }
};

/**
 * Reads a stored template.
 *
 * Accepts any supported major version, normalizes every missing optional field
 * to its default, and clamps every number into its real bound - so a template
 * that has been sitting in the database since an earlier build still applies,
 * and still cannot ask for a value a command would refuse.
 */
export function readTemplate(value: unknown, over: Partial<Pick<EditTemplate,
'id' | 'name' | 'description' | 'source'>> = {}): EditTemplate {
  const raw = record(value);
  const version = Number(raw.version ?? TEMPLATE_SCHEMA_VERSION);
  if (!Number.isFinite(version) || version < 1) {
    fail('INVALID_TEMPLATE_VERSION', 'A template must carry a numeric schema version.');
  }
  const major = Math.floor(version);
  if (!(SUPPORTED_TEMPLATE_VERSIONS as readonly number[]).includes(major)) {
    fail('UNSUPPORTED_TEMPLATE_VERSION',
      `This template was written for schema version ${major}, which this build cannot read. ` +
      `Supported: ${SUPPORTED_TEMPLATE_VERSIONS.join(', ')}.`);
  }
  const project = record(raw.project);
  const text = record(raw.text);
  const captions = record(raw.captions);
  const logo = record(raw.logo);
  const color = record(raw.color);
  const audio = record(raw.audio);
  const assets = record(raw.assets);
  const defaults = TEMPLATE_DEFAULTS;
  return {
    version: major,
    id: textField(over.id ?? raw.id, 64, 'UNKNOWN'),
    name: textField(over.name ?? raw.name, MAX_TEMPLATE_NAME_LENGTH, 'Untitled template'),
    description: textField(over.description ?? raw.description,
      MAX_TEMPLATE_DESCRIPTION_LENGTH, ''),
    source: enumField(over.source ?? raw.source, TEMPLATE_SOURCES, 'USER'),
    project: {
      aspectRatio: enumField(project.aspectRatio, EDIT_ASPECT_RATIOS, defaults.project.aspectRatio),
      pacing: enumField(project.pacing, EDIT_PACING, defaults.project.pacing)
    },
    text: {
      defaultStyleId: enumField(text.defaultStyleId, TEXT_STYLE_PRESET_IDS,
        defaults.text.defaultStyleId),
      hookStyleId: enumField(text.hookStyleId, TEXT_STYLE_PRESET_IDS, defaults.text.hookStyleId),
      ctaStyleId: enumField(text.ctaStyleId, TEXT_STYLE_PRESET_IDS, defaults.text.ctaStyleId)
    },
    captions: {
      styleId: enumField(captions.styleId, CAPTION_STYLE_PRESET_IDS, defaults.captions.styleId),
      placement: enumField(captions.placement, CAPTION_PLACEMENTS, defaults.captions.placement),
      activeWord: tristate(captions.activeWord),
      uppercase: tristate(captions.uppercase)
    },
    logo: {
      placement: enumField(logo.placement, LOGO_PLACEMENTS, defaults.logo.placement),
      scale: numberField(logo.scale, MIN_LOGO_SCALE, MAX_LOGO_SCALE, defaults.logo.scale)
    },
    color: {
      filterId: enumField(color.filterId, COLOR_FILTER_IDS, defaults.color.filterId),
      strength: numberField(color.strength, 0, 1, defaults.color.strength)
    },
    audio: {
      musicVolume: numberField(audio.musicVolume, 0, MAX_VOLUME, defaults.audio.musicVolume),
      duckEnabled: boolField(audio.duckEnabled, defaults.audio.duckEnabled),
      duckStrength: enumField(audio.duckStrength, DUCK_STRENGTH_IDS, defaults.audio.duckStrength),
      fadeInSec: numberField(audio.fadeInSec, 0, MAX_FADE_SEC, defaults.audio.fadeInSec),
      fadeOutSec: numberField(audio.fadeOutSec, 0, MAX_FADE_SEC, defaults.audio.fadeOutSec)
    },
    zoom: enumField(raw.zoom, ZOOM_POLICIES, defaults.zoom),
    reframe: enumField(raw.reframe, REFRAME_POLICIES, defaults.reframe),
    informationRegion: enumField(raw.informationRegion, INFORMATION_REGION_POLICIES,
      defaults.informationRegion),
    assets: {
      logoAssetId: assetField(assets.logoAssetId),
      musicAssetId: assetField(assets.musicAssetId)
    }
  };
}

/**
 * Validates a template the user is trying to SAVE.
 *
 * Stricter than `readTemplate`, which forgives an old or partial stored
 * template: here an explicitly wrong value is an error the user should see,
 * rather than a silent fallback that saves something they did not ask for.
 */
export function validateTemplateInput(value: unknown): EditTemplate {
  const raw = record(value);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) fail('INVALID_TEMPLATE_NAME', 'A template needs a name.');
  if (name.length > MAX_TEMPLATE_NAME_LENGTH) {
    fail('INVALID_TEMPLATE_NAME',
      `A template name may be at most ${MAX_TEMPLATE_NAME_LENGTH} characters.`);
  }
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    fail('INVALID_TEMPLATE_DESCRIPTION', 'description must be text.');
  }
  const strictEnum = (path: string, candidate: unknown, options: readonly string[]) => {
    if (candidate !== undefined && candidate !== null &&
      !(typeof candidate === 'string' && options.includes(candidate))) {
      fail('INVALID_TEMPLATE_FIELD', `${path} must be one of: ${options.join(', ')}.`);
    }
  };
  const strictNumber = (path: string, candidate: unknown, min: number, max: number) => {
    if (candidate === undefined) return;
    const parsed = Number(candidate);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      fail('INVALID_TEMPLATE_FIELD', `${path} must be a number between ${min} and ${max}.`);
    }
  };
  const project = record(raw.project); const text = record(raw.text);
  const captions = record(raw.captions); const logo = record(raw.logo);
  const color = record(raw.color); const audio = record(raw.audio);
  strictEnum('project.aspectRatio', project.aspectRatio, EDIT_ASPECT_RATIOS);
  strictEnum('project.pacing', project.pacing, EDIT_PACING);
  for (const key of ['defaultStyleId', 'hookStyleId', 'ctaStyleId']) {
    strictEnum(`text.${key}`, text[key], TEXT_STYLE_PRESET_IDS);
  }
  strictEnum('captions.styleId', captions.styleId, CAPTION_STYLE_PRESET_IDS);
  strictEnum('captions.placement', captions.placement, CAPTION_PLACEMENTS);
  strictEnum('logo.placement', logo.placement, LOGO_PLACEMENTS);
  strictNumber('logo.scale', logo.scale, MIN_LOGO_SCALE, MAX_LOGO_SCALE);
  strictEnum('color.filterId', color.filterId, COLOR_FILTER_IDS);
  strictNumber('color.strength', color.strength, 0, 1);
  strictNumber('audio.musicVolume', audio.musicVolume, 0, MAX_VOLUME);
  strictEnum('audio.duckStrength', audio.duckStrength, DUCK_STRENGTH_IDS);
  strictNumber('audio.fadeInSec', audio.fadeInSec, 0, MAX_FADE_SEC);
  strictNumber('audio.fadeOutSec', audio.fadeOutSec, 0, MAX_FADE_SEC);
  strictEnum('zoom', raw.zoom, ZOOM_POLICIES);
  strictEnum('reframe', raw.reframe, REFRAME_POLICIES);
  strictEnum('informationRegion', raw.informationRegion, INFORMATION_REGION_POLICIES);
  return readTemplate({ ...raw, version: TEMPLATE_SCHEMA_VERSION }, { source: 'USER' });
}

/** The stored payload for a template: everything except the identity columns the
 *  database owns, so a row and its JSON can never disagree about the name. */
export function templatePayload(template: EditTemplate) {
  const { id: _id, name: _name, description: _description, source: _source, ...payload } = template;
  return { ...payload, version: TEMPLATE_SCHEMA_VERSION } as Record<string, unknown>;
}
