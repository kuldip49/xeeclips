// The typed operations a preset plan is allowed to contain.
//
// A preset never writes EditElement rows and never patches settings directly. It
// emits this closed command union, the command list is validated here, and the
// canonical EditMode layer executes each command through exactly the same
// element mutation and validation path the manual editor uses.

import { BadRequestException } from '@nestjs/common';
import {
  EDIT_ASPECT_RATIOS, EDIT_PACING, GRADING_POLICIES, HOOK_POLICIES,
  INFORMATION_REGION_POLICIES, MUSIC_POLICIES, OVERLAY_POLICIES, REFRAME_POLICIES,
  SUBTITLE_POLICIES, TEXT_POLICIES, ZOOM_POLICIES,
  type EditProjectStyle, type PlannedZoomMoment
} from './edit-preset-policy';

/** Element commands reuse the Phase 2/3 manual vocabulary. ADD_SUBTITLE is the
 * one Phase 4 addition: a transcript-exact caption line, added whole because
 * chaining five commands per phrase would be neither readable nor cheaper. */
export const PRESET_ELEMENT_ACTIONS = ['TRIM_ELEMENT', 'ADD_TEXT', 'ADD_SUBTITLE', 'ADD_IMAGE',
  'ADD_LOGO', 'ADD_AUDIO', 'UPDATE_TEXT', 'MOVE_ELEMENT', 'RESIZE_ELEMENT', 'SET_ELEMENT_TIMING',
  'SET_ELEMENT_OPACITY', 'SET_ELEMENT_Z_INDEX', 'SET_AUDIO_VOLUME', 'SET_AUDIO_FADE',
  'REMOVE_ELEMENT'] as const;
export type PresetElementAction = typeof PRESET_ELEMENT_ACTIONS[number];

/** Project-level commands. Each one sets one typed field of EditProject.settings
 * style block - there is no generic settings patch. */
export const PRESET_SETTINGS_ACTIONS = ['SET_PROJECT_STYLE', 'SET_ASPECT_RATIO',
  'SET_SUBTITLE_POLICY', 'SET_AUTO_REFRAME', 'SET_AUTO_ZOOM', 'SET_COLOR_GRADE',
  'SET_HOOK'] as const;
export type PresetSettingsAction = typeof PRESET_SETTINGS_ACTIONS[number];

export type PresetElementCommand = {
  kind: 'ELEMENT';
  action: PresetElementAction;
  /** Planner-local handle for an element this plan creates, so later commands in
   * the same plan can address it before its database id exists. */
  ref?: string;
  payload: Record<string, unknown>;
  reason: string;
};

export type PresetSettingsCommand = {
  kind: 'SETTINGS';
  action: PresetSettingsAction;
  payload: Partial<EditProjectStyle>;
  reason: string;
};

export type PresetCommand = PresetElementCommand | PresetSettingsCommand;

export type PresetEstimatedChanges = {
  trims: number;
  overlays: number;
  subtitles: number;
  removedPresetElements: number;
  subtitlePolicyChanged: boolean;
  zoomPolicyChanged: boolean;
  reframePolicyChanged: boolean;
  aspectRatioChanged: boolean;
  hookChanged: boolean;
};

export type PresetPlan = {
  presetId: string;
  displayName: string;
  description: string;
  summary: string;
  /** Human-readable "planned changes" lines for the preview dialog. */
  plannedChanges: string[];
  commands: PresetCommand[];
  affectedElements: string[];
  warnings: string[];
  estimatedChanges: PresetEstimatedChanges;
  style: EditProjectStyle;
  /** Zoom intent for the later render phase. Phase 4 renders nothing. */
  plannedZoomMoments: PlannedZoomMoment[];
  evidence: {
    sourceDurationSec: number;
    transcriptAvailable: boolean;
    analysisAvailable: boolean;
    analysisSource: string;
    shotCount: number;
    informationShotRatio: number;
    faceShotRatio: number;
    pairShotRatio: number;
    semanticPeakCount: number;
    usedCachedTranscript: boolean;
    usedCachedAnalysis: boolean;
  };
  /** Which path produced the semantic judgements in this plan. */
  generation: 'DETERMINISTIC' | 'LLM_ASSISTED';
};

const SETTINGS_FIELDS: Record<PresetSettingsAction, ReadonlyArray<keyof EditProjectStyle>> = {
  SET_PROJECT_STYLE: ['selectedPreset', 'pacing', 'textPolicy', 'overlayPolicy',
    'musicPolicy', 'informationRegionPolicy'],
  SET_ASPECT_RATIO: ['aspectRatio'],
  SET_SUBTITLE_POLICY: ['subtitlePolicy'],
  SET_AUTO_REFRAME: ['reframePolicy'],
  SET_AUTO_ZOOM: ['zoomPolicy'],
  SET_COLOR_GRADE: ['gradingPolicy'],
  SET_HOOK: ['hookPolicy', 'hookText']
};

const ENUMS: Partial<Record<keyof EditProjectStyle, readonly string[]>> = {
  aspectRatio: EDIT_ASPECT_RATIOS, pacing: EDIT_PACING, subtitlePolicy: SUBTITLE_POLICIES,
  hookPolicy: HOOK_POLICIES, zoomPolicy: ZOOM_POLICIES, reframePolicy: REFRAME_POLICIES,
  musicPolicy: MUSIC_POLICIES, gradingPolicy: GRADING_POLICIES, textPolicy: TEXT_POLICIES,
  overlayPolicy: OVERLAY_POLICIES, informationRegionPolicy: INFORMATION_REGION_POLICIES
};

const invalid = (message: string): never => {
  throw new BadRequestException({ code: 'INVALID_PRESET_COMMAND', message });
};

/**
 * Rejects a generated command before it can reach the canonical layer.
 *
 * This runs on every plan - deterministic or LLM-assisted - so a malformed
 * proposal fails as a bad plan rather than as a half-applied edit.
 */
export function validatePresetCommands(commands: unknown): PresetCommand[] {
  if (!Array.isArray(commands)) return invalid('Preset plan commands must be an array');
  if (commands.length > 2000) return invalid('Preset plan is too large to apply');
  const declared = new Set<string>();
  return commands.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return invalid(`Preset command ${index} must be an object`);
    }
    const command = value as Record<string, unknown>;
    const reason = typeof command.reason === 'string' && command.reason.trim()
      ? command.reason.trim().slice(0, 200)
      : invalid(`Preset command ${index} must state a reason`);
    const payload = command.payload && typeof command.payload === 'object' &&
      !Array.isArray(command.payload) ? command.payload as Record<string, unknown>
      : invalid(`Preset command ${index} payload must be an object`);

    if (command.kind === 'SETTINGS') {
      const action = command.action as PresetSettingsAction;
      if (!PRESET_SETTINGS_ACTIONS.includes(action)) {
        return invalid(`Preset command ${index} uses an unsupported settings action`);
      }
      const allowed = SETTINGS_FIELDS[action];
      for (const [key, item] of Object.entries(payload)) {
        if (!allowed.includes(key as keyof EditProjectStyle)) {
          return invalid(`${action} cannot set "${key}"`);
        }
        if (key === 'hookText') {
          if (item !== null && (typeof item !== 'string' || item.length > 200)) {
            return invalid('hookText must be null or a short string');
          }
          continue;
        }
        const options = ENUMS[key as keyof EditProjectStyle];
        if (key === 'selectedPreset') {
          if (typeof item !== 'string') return invalid('selectedPreset must be a string');
          continue;
        }
        if (!options || typeof item !== 'string' || !options.includes(item)) {
          return invalid(`${action} received an invalid value for "${key}"`);
        }
      }
      return { kind: 'SETTINGS', action, payload: payload as Partial<EditProjectStyle>, reason };
    }

    if (command.kind !== 'ELEMENT') return invalid(`Preset command ${index} has an unknown kind`);
    const action = command.action as PresetElementAction;
    if (!PRESET_ELEMENT_ACTIONS.includes(action)) {
      return invalid(`Preset command ${index} uses an unsupported element action`);
    }
    const ref = command.ref === undefined ? undefined
      : typeof command.ref === 'string' && /^[a-z0-9:_-]{1,64}$/iu.test(command.ref)
        ? command.ref : invalid(`Preset command ${index} has an invalid ref`);
    const creates = action === 'ADD_TEXT' || action === 'ADD_SUBTITLE' || action === 'ADD_IMAGE' ||
      action === 'ADD_LOGO' || action === 'ADD_AUDIO';
    if (creates && ref) {
      if (declared.has(ref)) return invalid(`Preset command ${index} reuses ref "${ref}"`);
      declared.add(ref);
    }
    // Later commands may only address an element this plan already created or an
    // element that already exists; a dangling ref is a planner bug, not an edit.
    const target = payload.ref;
    if (target !== undefined) {
      if (typeof target !== 'string' || !declared.has(target)) {
        return invalid(`Preset command ${index} references unknown ref "${String(target)}"`);
      }
    } else if (!creates && typeof payload.elementId !== 'string') {
      return invalid(`Preset command ${index} must address an element by ref or elementId`);
    }
    return { kind: 'ELEMENT', action, ref, payload, reason };
  });
}

export const emptyEstimatedChanges = (): PresetEstimatedChanges => ({
  trims: 0, overlays: 0, subtitles: 0, removedPresetElements: 0, subtitlePolicyChanged: false,
  zoomPolicyChanged: false, reframePolicyChanged: false, aspectRatioChanged: false,
  hookChanged: false
});
