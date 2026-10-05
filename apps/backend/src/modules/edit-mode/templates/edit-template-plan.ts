// EditMode Workstream F: turning a template into canonical commands.
//
// Pure - no Prisma, no Nest, no IO - so every ownership rule below can be
// exercised directly by scripts/test-edit-mode-templates.cjs.
//
// THE OWNERSHIP MODEL
// ===================
// A template application is classified into exactly three buckets, and the
// preview names all three before anything is written:
//
//   1. PROJECT-LEVEL STYLE DEFAULTS - aspect ratio, pacing, zoom, reframe,
//      information-region policy and the default style for future text. These
//      are inherently project-wide, so a template always sets them.
//
//   2. TEMPLATE-OWNED ELEMENT PROPERTIES - caption STYLING, hook/CTA styling on
//      text the user did not write, logo placement, the footage grade, and music
//      levels. A template sets these, but only while it still owns them (below).
//
//   3. USER-MANUAL CONTENT - caption wording, caption timing, the text of any
//      TEXT element, cuts/trims/splits, element timing, crop/rotation/flip/speed,
//      and which asset a logo or a music clip points at. A template NEVER writes
//      any of these. There is no command in the plan that could.
//
// STILL-OWNS: every apply records an IMPRINT - a fingerprint of the exact values
// it wrote, per element per facet. On a later apply the current values are
// fingerprinted the same way and compared:
//
//   * no imprint for that element+facet  -> the template has not claimed it yet,
//                                           so it applies (this is the first-apply
//                                           case, and also a clip added since);
//   * imprint matches what is stored now -> still template-owned, so it applies;
//   * imprint differs                    -> the user changed it after the last
//                                           apply, so it is PRESERVED and the
//                                           preview says so by name.
//
// That rule is deterministic, needs no extra flags on the element, and makes
// "re-apply the template" mean "restore the parts of the look I have not
// deliberately changed" rather than "throw away my work".

import {
  captionStylePreset, DEFAULT_CAPTION_BOX, textStylePreset, type TextBox
} from '../edit-mode-text';
import { colorFilter, readColorFilterId, readColorFilterStrength } from '../edit-mode-color';
import { readAudioState } from '../edit-mode-audio';
import type { EditProjectStyle } from '../presets/edit-preset-policy';
import type { EditTemplate } from './edit-template-schema';

export type TemplateFacet = 'PROJECT' | 'CAPTIONS' | 'TEXT' | 'LOGO' | 'COLOR' | 'AUDIO';

/** The text roles a template may restyle. Anything else is the user's own copy. */
export const TEMPLATE_TEXT_ROLES = ['HOOK', 'CTA'] as const;
export type TemplateTextRole = typeof TEMPLATE_TEXT_ROLES[number];

/** Key for a track-wide facet, which is owned as one thing rather than per row. */
export const CAPTION_TRACK_KEY = '__captions__';

export type TemplateImprint = { elementId: string; facet: TemplateFacet; fingerprint: string };

export type TemplateRun = {
  templateId: string;
  templateName: string;
  templateRunId: string;
  source: 'BUILTIN' | 'USER';
  appliedAtRevision: number;
  imprints: TemplateImprint[];
};

/** One line of the bounded, human-readable diff. Never raw JSON. */
export type TemplateChange = { facet: TemplateFacet; label: string; from: string; to: string };
/** One thing the template deliberately did not touch, and why. */
export type TemplatePreserved = { label: string; reason: string };

export type TemplateSettingsCommand = { kind: 'SETTINGS'; payload: Record<string, unknown> };
export type TemplateElementCommand = {
  kind: 'ELEMENT'; action: string; payload: Record<string, unknown>;
  facet: TemplateFacet; elementId: string;
};
export type TemplateCommand = TemplateSettingsCommand | TemplateElementCommand;

export type TemplatePlanElement = {
  id: string;
  type: string;
  track: number;
  position: number;
  assetId?: string | null;
  properties: Record<string, unknown>;
};

export type TemplatePlanAsset = { id: string; role: string };

export type TemplatePlan = {
  templateId: string;
  templateName: string;
  source: 'BUILTIN' | 'USER';
  summary: string;
  changes: TemplateChange[];
  preserved: TemplatePreserved[];
  warnings: string[];
  commands: TemplateCommand[];
  imprints: TemplateImprint[];
};

const round = (value: number, places = 4) => Number(value.toFixed(places));
const percent = (value: number) => `${Math.round(value * 100)}%`;
const title = (value: string) => value.replace(/_/gu, ' ').toLowerCase()
  .replace(/(^|\s)\S/gu, (match) => match.toUpperCase());

const number = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** The caption band a placement resolves to. PRESET defers to the style itself. */
export function captionBox(template: EditTemplate): TextBox {
  const preset = captionStylePreset(template.captions.styleId);
  switch (template.captions.placement) {
    case 'LOWER': return { ...DEFAULT_CAPTION_BOX };
    case 'CENTER': return { x: 0.1, y: 0.6, width: 0.8, height: 0.16 };
    case 'UPPER': return { x: 0.1, y: 0.12, width: 0.8, height: 0.14 };
    default: return { ...preset.box };
  }
}

/** Resolved caption look: the preset, with the template's explicit overrides. */
export function resolvedCaptions(template: EditTemplate) {
  const preset = captionStylePreset(template.captions.styleId);
  return {
    styleId: template.captions.styleId,
    box: captionBox(template),
    uppercase: template.captions.uppercase ?? preset.style.uppercase ?? false,
    activeWord: template.captions.activeWord ?? preset.style.activeWord?.enabled ?? false,
    activeWordColor: preset.style.activeWord?.color ?? '#ffe066'
  };
}

/** The logo box a placement resolves to, keeping the element's own aspect. */
export function logoBox(template: EditTemplate, current: { width: number; height: number }) {
  const width = template.logo.scale;
  const aspect = current.width > 0 ? current.height / current.width : 1;
  const height = Math.min(0.9, Math.max(0.02, width * aspect));
  const margin = 0.04;
  const left = margin;
  const right = Math.max(margin, 1 - margin - width);
  const top = margin;
  const bottom = Math.max(margin, 1 - margin - height);
  switch (template.logo.placement) {
    case 'TOP_LEFT': return { x: left, y: top, width, height };
    case 'TOP_RIGHT': return { x: right, y: top, width, height };
    case 'BOTTOM_LEFT': return { x: left, y: bottom, width, height };
    case 'BOTTOM_RIGHT': return { x: right, y: bottom, width, height };
    default: return null;
  }
}

// --- Fingerprints ------------------------------------------------------------
//
// One projection per facet, used BOTH to describe what a template intends to
// write and to read back what is stored now. Because it is the same function,
// "did the user change this since the template wrote it?" is a string compare.

const fp = (value: unknown) => JSON.stringify(value);

export const captionFingerprint = (element: TemplatePlanElement | null) => element ? fp({
  styleId: element.properties.captionStyleId ?? null,
  x: round(number(element.properties.x, 0)), y: round(number(element.properties.y, 0)),
  width: round(number(element.properties.width, 0)),
  height: round(number(element.properties.height, 0)),
  uppercase: element.properties.uppercase === true,
  activeWord: (element.properties.activeWord as { enabled?: unknown } | undefined)?.enabled === true
}) : fp(null);

export const intendedCaptionFingerprint = (template: EditTemplate) => {
  const resolved = resolvedCaptions(template);
  return fp({
    styleId: resolved.styleId,
    x: round(resolved.box.x), y: round(resolved.box.y),
    width: round(resolved.box.width), height: round(resolved.box.height),
    uppercase: resolved.uppercase, activeWord: resolved.activeWord
  });
};

export const textFingerprint = (element: TemplatePlanElement) =>
  fp({ styleId: element.properties.textStyleId ?? null });
export const intendedTextFingerprint = (styleId: string) => fp({ styleId });

export const logoFingerprint = (element: TemplatePlanElement) => fp({
  x: round(number(element.properties.x, 0)), y: round(number(element.properties.y, 0)),
  width: round(number(element.properties.width, 0))
});
export const intendedLogoFingerprint = (box: { x: number; y: number; width: number }) =>
  fp({ x: round(box.x), y: round(box.y), width: round(box.width) });

export const colorFingerprint = (element: TemplatePlanElement) => fp({
  filterId: readColorFilterId(element.properties),
  strength: round(readColorFilterStrength(element.properties), 3)
});
export const intendedColorFingerprint = (template: EditTemplate) =>
  fp({ filterId: template.color.filterId, strength: round(template.color.strength, 3) });

export const audioFingerprint = (element: TemplatePlanElement) => {
  const state = readAudioState(element.properties);
  return fp({ volume: round(state.volume, 3), duck: state.duckEnabled,
    strength: state.duckStrength, fadeIn: round(state.fadeInSec, 3),
    fadeOut: round(state.fadeOutSec, 3) });
};
/**
 * `duckEnabled` here is what will ACTUALLY be written, not what the template
 * wished for. A template that asks for ducking on a source with no word timings
 * writes ducking OFF, and an imprint that recorded ON would then never match
 * what is stored - so the next apply would read its own work as a user edit and
 * preserve it. The imprint is a record of what the template wrote, always.
 */
export const intendedAudioFingerprint = (template: EditTemplate, duckEnabled: boolean) => fp({
  volume: round(template.audio.musicVolume, 3), duck: duckEnabled,
  strength: template.audio.duckStrength, fadeIn: round(template.audio.fadeInSec, 3),
  fadeOut: round(template.audio.fadeOutSec, 3) });

// --- The plan ----------------------------------------------------------------

export type TemplatePlanInput = {
  template: EditTemplate;
  style: EditProjectStyle;
  elements: TemplatePlanElement[];
  assets: TemplatePlanAsset[];
  previousRun: TemplateRun | null;
  /** True when the source has word timings, which is what ducking needs. */
  duckingAvailable: boolean;
};

/** Is this element's facet still the template's to write? */
const stillOwned = (previousRun: TemplateRun | null, elementId: string, facet: TemplateFacet,
  current: string) => {
  const imprint = previousRun?.imprints.find((entry) =>
    entry.elementId === elementId && entry.facet === facet);
  if (!imprint) return true;
  return imprint.fingerprint === current;
};

/** TEXT the template may restyle: written by a preset or an earlier template
 *  run in a role the template has an opinion about - never the user's own copy. */
const templateTextRole = (element: TemplatePlanElement): TemplateTextRole | null => {
  if (element.type !== 'TEXT') return null;
  const origin = String(element.properties.origin ?? 'USER');
  if (origin === 'USER' && element.properties.templateRole === undefined) return null;
  // Either stamp may carry the role. Projects templated before the stamp was
  // fixed hold templateRole 'TEXT' (a facet name) with the real role still in
  // presetRole, so the first recognised role wins rather than the first field.
  const role = [element.properties.templateRole, element.properties.presetRole]
    .map((value) => String(value ?? ''))
    .find((value) => (TEMPLATE_TEXT_ROLES as readonly string[]).includes(value));
  return role ? role as TemplateTextRole : null;
};

export function planTemplate(input: TemplatePlanInput): TemplatePlan {
  const { template, style, elements, assets, previousRun } = input;
  const changes: TemplateChange[] = [];
  const preserved: TemplatePreserved[] = [];
  const warnings: string[] = [];
  const warn = (message: string) => { if (!warnings.includes(message)) warnings.push(message); };
  const commands: TemplateCommand[] = [];
  const imprints: TemplateImprint[] = [];
  // The diff describes FACETS, not elements. A project can hold hundreds of
  // captions and dozens of overlays; "Logo position 40%,40% -> 80%,4%" is one
  // fact about the template whether it moves one logo or fifty, and a diff that
  // grew with the timeline would stop being readable exactly when it mattered.
  const seen = new Set<string>();
  const change = (facet: TemplateFacet, label: string, from: string, to: string) => {
    if (from === to || seen.has(label)) return;
    seen.add(label);
    changes.push({ facet, label, from, to });
  };
  const keptLabels = new Set<string>();
  const keep = (label: string, reason: string) => {
    if (keptLabels.has(label)) return;
    keptLabels.add(label);
    preserved.push({ label, reason });
  };

  // --- 1. Project-level style defaults ---------------------------------------
  // Inherently project-wide, so always written. These are the values the render
  // plan itself reads, which is what makes a template reach the export.
  change('PROJECT', 'Aspect ratio', style.aspectRatio, template.project.aspectRatio);
  change('PROJECT', 'Pacing', title(style.pacing), title(template.project.pacing));
  change('PROJECT', 'Zoom', title(style.zoomPolicy), title(template.zoom));
  change('PROJECT', 'Reframing', title(style.reframePolicy), title(template.reframe));
  change('PROJECT', 'Information regions', title(style.informationRegionPolicy),
    title(template.informationRegion));
  commands.push({ kind: 'SETTINGS', payload: {
    aspectRatio: template.project.aspectRatio,
    pacing: template.project.pacing,
    zoomPolicy: template.zoom,
    reframePolicy: template.reframe,
    informationRegionPolicy: template.informationRegion
  } });

  // --- 2. Captions -----------------------------------------------------------
  // STYLE ONLY. Nothing in this branch can reach a caption's wording, its start
  // time or its duration: the commands used are SET_CAPTION_STYLE (style + box),
  // MOVE/RESIZE (box), SET_CAPTION_ACTIVE_WORD, SET_TEXT_CASE and
  // APPLY_CAPTION_STYLE_TO_ALL, and none of them writes content or timing.
  const captions = elements.filter((element) => element.type === 'SUBTITLE')
    .sort((left, right) => number(left.properties.startTime, 0) - number(right.properties.startTime, 0)
      || left.position - right.position);
  const resolved = resolvedCaptions(template);
  if (captions.length) {
    const reference = captions[0];
    const current = captionFingerprint(reference);
    const intended = intendedCaptionFingerprint(template);
    if (stillOwned(previousRun, CAPTION_TRACK_KEY, 'CAPTIONS', current)) {
      const currentStyleId = reference.properties.captionStyleId;
      change('CAPTIONS', 'Caption style',
        typeof currentStyleId === 'string' ? title(currentStyleId) : 'Custom',
        title(template.captions.styleId));
      change('CAPTIONS', 'Caption placement',
        `${Math.round(number(reference.properties.y, 0) * 100)}% down`,
        `${Math.round(resolved.box.y * 100)}% down`);
      change('CAPTIONS', 'Highlight spoken word',
        (reference.properties.activeWord as { enabled?: unknown } | undefined)?.enabled === true
          ? 'On' : 'Off', resolved.activeWord ? 'On' : 'Off');
      change('CAPTIONS', 'Uppercase captions',
        reference.properties.uppercase === true ? 'On' : 'Off', resolved.uppercase ? 'On' : 'Off');
      commands.push({ kind: 'ELEMENT', facet: 'CAPTIONS', elementId: reference.id,
        action: 'SET_CAPTION_STYLE',
        payload: { elementId: reference.id, captionStyleId: template.captions.styleId } });
      commands.push({ kind: 'ELEMENT', facet: 'CAPTIONS', elementId: reference.id,
        action: 'MOVE_ELEMENT',
        payload: { elementId: reference.id, x: resolved.box.x, y: resolved.box.y } });
      commands.push({ kind: 'ELEMENT', facet: 'CAPTIONS', elementId: reference.id,
        action: 'RESIZE_ELEMENT',
        payload: { elementId: reference.id, width: resolved.box.width,
          height: resolved.box.height } });
      commands.push({ kind: 'ELEMENT', facet: 'CAPTIONS', elementId: reference.id,
        action: 'SET_CAPTION_ACTIVE_WORD',
        payload: { elementId: reference.id, activeWordEnabled: resolved.activeWord,
          activeWordColor: resolved.activeWordColor } });
      commands.push({ kind: 'ELEMENT', facet: 'CAPTIONS', elementId: reference.id,
        action: 'SET_TEXT_CASE',
        payload: { elementId: reference.id, uppercase: resolved.uppercase } });
      // One command restyles the whole track, so a 400-caption project costs the
      // same as a 4-caption one.
      commands.push({ kind: 'ELEMENT', facet: 'CAPTIONS', elementId: reference.id,
        action: 'APPLY_CAPTION_STYLE_TO_ALL', payload: { elementId: reference.id } });
      imprints.push({ elementId: CAPTION_TRACK_KEY, facet: 'CAPTIONS', fingerprint: intended });
    } else {
      keep('Your caption styling',
        'you restyled the captions after this template was last applied');
      const kept = previousRun?.imprints.find((entry) =>
        entry.elementId === CAPTION_TRACK_KEY && entry.facet === 'CAPTIONS');
      if (kept) imprints.push(kept);
    }
    keep(`Caption wording (${captions.length} line${captions.length === 1 ? '' : 's'})`,
      'a template restyles captions and never rewrites or re-times them');
    keep('Caption timing',
      'caption start times and durations are content, not style');
  } else if (template.captions.styleId) {
    warn('This timeline has no captions yet, so the caption style is stored as the ' +
      'default and will be used the next time this template is applied.');
  }

  // --- 3. Text ---------------------------------------------------------------
  // Only hook/CTA elements a preset or an earlier template run authored are
  // restyled; the user's own text is untouched, and nothing rewrites wording.
  const manualText = elements.filter((element) =>
    element.type === 'TEXT' && !templateTextRole(element));
  if (manualText.length) {
    keep(`Your text (${manualText.length} element${manualText.length === 1 ? '' : 's'})`,
      'a template never restyles or rewrites text you wrote yourself');
  }
  for (const element of elements) {
    const role = templateTextRole(element);
    if (!role) continue;
    const styleId = role === 'HOOK' ? template.text.hookStyleId : template.text.ctaStyleId;
    const current = textFingerprint(element);
    const intended = intendedTextFingerprint(styleId);
    if (!stillOwned(previousRun, element.id, 'TEXT', current)) {
      keep(`${title(role)} styling`,
        'you restyled it after this template was last applied');
      const kept = previousRun?.imprints.find((entry) =>
        entry.elementId === element.id && entry.facet === 'TEXT');
      if (kept) imprints.push(kept);
      continue;
    }
    const currentStyleId = element.properties.textStyleId;
    change('TEXT', `${title(role)} style`,
      typeof currentStyleId === 'string' ? title(currentStyleId) : 'Custom',
      textStylePreset(styleId).label);
    commands.push({ kind: 'ELEMENT', facet: 'TEXT', elementId: element.id,
      action: 'SET_TEXT_STYLE_PRESET',
      payload: { elementId: element.id, textStyleId: styleId, applyBox: false } });
    imprints.push({ elementId: element.id, facet: 'TEXT', fingerprint: intended });
  }
  change('TEXT', 'Style for new text', title(String(style.textPolicy ?? 'OFF')),
    textStylePreset(template.text.defaultStyleId).label);

  // --- 4. Logo ---------------------------------------------------------------
  // Placement only, and only when a logo actually exists. A template never
  // creates one and never changes which file a logo points at.
  const logos = elements.filter((element) => element.type === 'IMAGE' &&
    String(element.properties.role ?? '') === 'LOGO');
  if (template.logo.placement === 'KEEP') {
    if (logos.length) keep('Logo placement',
      'this template has no opinion about where a logo sits');
  } else if (!logos.length) {
    warn('This timeline has no logo, so the logo placement in this template does ' +
      'nothing. Add a logo and apply the template again to place it.');
  } else {
    for (const element of logos) {
      const box = logoBox(template, {
        width: number(element.properties.width, 0.2), height: number(element.properties.height, 0.1) });
      if (!box) continue;
      const current = logoFingerprint(element);
      if (!stillOwned(previousRun, element.id, 'LOGO', current)) {
        keep('Logo placement',
          'you moved or resized the logo after this template was last applied');
        const kept = previousRun?.imprints.find((entry) =>
          entry.elementId === element.id && entry.facet === 'LOGO');
        if (kept) imprints.push(kept);
        continue;
      }
      change('LOGO', 'Logo position',
        `${Math.round(number(element.properties.x, 0) * 100)}%, ${Math.round(number(element.properties.y, 0) * 100)}%`,
        `${Math.round(box.x * 100)}%, ${Math.round(box.y * 100)}%`);
      change('LOGO', 'Logo size', percent(number(element.properties.width, 0.2)),
        percent(box.width));
      commands.push({ kind: 'ELEMENT', facet: 'LOGO', elementId: element.id,
        action: 'RESIZE_ELEMENT',
        payload: { elementId: element.id, width: box.width, height: box.height } });
      commands.push({ kind: 'ELEMENT', facet: 'LOGO', elementId: element.id,
        action: 'MOVE_ELEMENT', payload: { elementId: element.id, x: box.x, y: box.y } });
      imprints.push({ elementId: element.id, facet: 'LOGO',
        fingerprint: intendedLogoFingerprint(box) });
    }
  }

  // --- 5. Colour -------------------------------------------------------------
  // Workstream D's rule holds: a filter RESOLVES on apply into concrete stored
  // adjustments, so the sliders show exactly what renders and there is no hidden
  // filter state fighting them.
  const videos = elements.filter((element) => element.type === 'VIDEO' && element.track === 0);
  const intendedColor = intendedColorFingerprint(template);
  let colorApplied = 0;
  for (const element of videos) {
    const current = colorFingerprint(element);
    if (!stillOwned(previousRun, element.id, 'COLOR', current)) {
      const kept = previousRun?.imprints.find((entry) =>
        entry.elementId === element.id && entry.facet === 'COLOR');
      if (kept) imprints.push(kept);
      continue;
    }
    commands.push({ kind: 'ELEMENT', facet: 'COLOR', elementId: element.id,
      action: 'APPLY_COLOR_FILTER',
      payload: { elementId: element.id, filterId: template.color.filterId,
        strength: template.color.strength } });
    imprints.push({ elementId: element.id, facet: 'COLOR', fingerprint: intendedColor });
    colorApplied += 1;
  }
  if (colorApplied) {
    const before = videos[0] ? readColorFilterId(videos[0].properties) : null;
    change('COLOR', 'Look', before ? title(before) : 'Original',
      colorFilter(template.color.filterId)?.label ?? title(template.color.filterId));
    if (template.color.strength < 1) {
      change('COLOR', 'Look strength', '100%', percent(template.color.strength));
    }
  } else if (videos.length) {
    keep('Your colour grade',
      'you graded the footage after this template was last applied');
  }

  // --- 6. Audio --------------------------------------------------------------
  // Levels only. A template never adds, removes or re-points a music clip.
  const music = elements.filter((element) => element.type === 'AUDIO');
  const duckWanted = template.audio.duckEnabled && input.duckingAvailable;
  const intendedAudio = intendedAudioFingerprint(template, duckWanted);
  if (template.audio.duckEnabled && !input.duckingAvailable && music.length) {
    warn('Ducking needs word timings from "Analyze source"; this template\'s ducking ' +
      'setting is stored but not applied.');
  }
  let audioApplied = 0;
  for (const element of music) {
    const current = audioFingerprint(element);
    if (!stillOwned(previousRun, element.id, 'AUDIO', current)) {
      keep('Your music levels',
        'you changed the music after this template was last applied');
      const kept = previousRun?.imprints.find((entry) =>
        entry.elementId === element.id && entry.facet === 'AUDIO');
      if (kept) imprints.push(kept);
      continue;
    }
    const state = readAudioState(element.properties);
    if (audioApplied === 0) {
      change('AUDIO', 'Music volume', percent(state.volume), percent(template.audio.musicVolume));
      change('AUDIO', 'Duck under speech', state.duckEnabled ? 'On' : 'Off',
        duckWanted ? 'On' : 'Off');
      change('AUDIO', 'Music fades', `${round(state.fadeInSec, 2)}s / ${round(state.fadeOutSec, 2)}s`,
        `${round(template.audio.fadeInSec, 2)}s / ${round(template.audio.fadeOutSec, 2)}s`);
    }
    commands.push({ kind: 'ELEMENT', facet: 'AUDIO', elementId: element.id,
      action: 'SET_AUDIO_VOLUME',
      payload: { elementId: element.id, volume: template.audio.musicVolume } });
    commands.push({ kind: 'ELEMENT', facet: 'AUDIO', elementId: element.id,
      action: 'SET_AUDIO_FADE',
      payload: { elementId: element.id, fadeInSec: template.audio.fadeInSec,
        fadeOutSec: template.audio.fadeOutSec } });
    commands.push({ kind: 'ELEMENT', facet: 'AUDIO', elementId: element.id,
      action: 'SET_AUDIO_DUCKING',
      payload: { elementId: element.id, duckEnabled: duckWanted,
        duckStrength: template.audio.duckStrength } });
    imprints.push({ elementId: element.id, facet: 'AUDIO', fingerprint: intendedAudio });
    audioApplied += 1;
  }
  if (!music.length) {
    warn('This timeline has no music, so the audio settings are stored as defaults and ' +
      'will be used the next time this template is applied.');
  }

  // --- 7. Optional asset binding --------------------------------------------
  // A bound asset that is not in THIS project is reported and skipped; the rest
  // of the template still applies.
  const assetIds = new Set(assets.map((asset) => asset.id));
  for (const [label, bound] of [['logo', template.assets.logoAssetId],
    ['music', template.assets.musicAssetId]] as const) {
    if (!bound) continue;
    if (assetIds.has(bound)) {
      keep(`Bound ${label}`,
        `this template remembers a ${label} file, and it is in this project`);
    } else {
      warn(`This template remembers a ${label} file that is not in this project. ` +
        'Everything else in the template was applied; add one here and re-apply to place it.');
    }
  }

  // Always-true preservation facts, stated so the preview can show them.
  keep('Your cuts, trims and splits', 'a template changes style, never the edit');
  keep('Crop, rotation, flip and speed',
    'manual transforms are yours; a template has no command that touches them');

  const summary = `${template.name}: ${changes.length} change${changes.length === 1 ? '' : 's'}, ` +
    `${preserved.length} thing${preserved.length === 1 ? '' : 's'} preserved.`;
  return { templateId: template.id, templateName: template.name, source: template.source,
    summary, changes, preserved, warnings, commands, imprints };
}

/** The defaults a template leaves behind for things that do not exist yet (a
 *  music clip that has not been added, the next text element). Stored on
 *  settings so a later apply, or a later "add music", has them to read. */
export function templateDefaults(template: EditTemplate) {
  return {
    textStyleId: template.text.defaultStyleId,
    hookStyleId: template.text.hookStyleId,
    ctaStyleId: template.text.ctaStyleId,
    captionStyleId: template.captions.styleId,
    captionPlacement: template.captions.placement,
    musicVolume: template.audio.musicVolume,
    duckEnabled: template.audio.duckEnabled,
    duckStrength: template.audio.duckStrength,
    fadeInSec: template.audio.fadeInSec,
    fadeOutSec: template.audio.fadeOutSec,
    logoPlacement: template.logo.placement,
    logoScale: template.logo.scale
  };
}

/** Reads the last template run back off EditProject.settings, defensively:
 *  settings is free-form JSON, so anything malformed reads as "no run". */
export function readTemplateRun(settings: unknown): TemplateRun | null {
  const record = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? settings as Record<string, unknown> : {};
  const run = record.templateRun;
  if (!run || typeof run !== 'object' || Array.isArray(run)) return null;
  const value = run as Record<string, unknown>;
  if (typeof value.templateId !== 'string' || typeof value.templateRunId !== 'string') return null;
  const imprints = (Array.isArray(value.imprints) ? value.imprints : []).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const entry = item as Record<string, unknown>;
    return typeof entry.elementId === 'string' && typeof entry.facet === 'string' &&
      typeof entry.fingerprint === 'string'
      ? [{ elementId: entry.elementId, facet: entry.facet as TemplateFacet,
        fingerprint: entry.fingerprint }] : [];
  });
  return {
    templateId: value.templateId,
    templateName: typeof value.templateName === 'string' ? value.templateName : value.templateId,
    templateRunId: value.templateRunId,
    source: value.source === 'USER' ? 'USER' : 'BUILTIN',
    appliedAtRevision: Number(value.appliedAtRevision) || 0,
    imprints
  };
}
