// EditMode Phase 4 preset orchestration.
//
//   source + cached analysis -> preset policy -> content-aware planner
//     -> validated EditMode commands -> canonical EditProject/EditElement/EditHistory
//
// PREVIEW builds a plan and touches nothing. APPLY re-plans against the current
// revision and hands the command bundle to the canonical layer, which commits it
// atomically as one PRESET history revision.
//
// This service never enqueues work, never creates ProcessingJob / ClipCandidate /
// GeneratedClip rows, and never reads or writes Project or Video records. Video
// processing and clip rendering are reached through entirely different modules.

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { LlmRouterService } from '../processing/llm-router.service';
import { chooseBestHook } from '../editing/hook-generator';
import type { StrictJsonSchema } from '../processing/llm-provider.service';
import { PrismaService } from '../database/prisma.service';
import { EditModeService } from './edit-mode.service';
import { validatePresetCommands, type PresetPlan } from './presets/edit-preset-commands';
import { buildPresetEvidence } from './presets/edit-preset-evidence';
import { planPreset, type PlannerAsset, type PlannerElement } from './presets/edit-preset-planner';
import {
  EDIT_PRESETS, editPresetList, isEditPresetId, readEditPresetRun, readEditProjectStyle,
  type EditPresetId
} from './presets/edit-preset-policy';

const HOOK_SCHEMA: StrictJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['hooks'],
  properties: {
    hooks: { type: 'array', minItems: 1, maxItems: 5,
      items: { type: 'object', additionalProperties: false, required: ['text'],
        properties: { text: { type: 'string' } } } }
  }
};

@Injectable()
export class EditModePresetService {
  private readonly logger = new Logger(EditModePresetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly editMode: EditModeService,
    private readonly llm: LlmRouterService
  ) {}

  list() {
    return editPresetList().map((policy) => ({
      id: policy.id, displayName: policy.displayName, description: policy.description,
      automatic: policy.automatic, aspectRatio: policy.aspectRatio, pacing: policy.pacing,
      subtitlePolicy: policy.subtitlePolicy, hookPolicy: policy.hookPolicy,
      reframingPolicy: policy.reframingPolicy, zoomPolicy: policy.zoomPolicy,
      textPolicy: policy.textPolicy, audioPolicy: policy.audioPolicy,
      overlayPolicy: policy.overlayPolicy, gradingPolicy: policy.gradingPolicy,
      informationRegionPolicy: policy.informationRegionPolicy
    }));
  }

  /** PREVIEW: a structured proposal. Nothing is written. */
  async preview(id: string, input: { presetId?: unknown; revision?: unknown }) {
    const started = Date.now();
    const { plan } = await this.buildPlan(id, input.presetId, input.revision);
    // Counters only: which preset, how big the plan is, how long it took. The
    // hook wording, the caption text and the transcript stay out of the log.
    this.logger.log(JSON.stringify({ event: 'edit_mode_preset_preview', editProjectId: id,
      presetId: plan.presetId, commandCount: plan.commands.length,
      warningCount: plan.warnings?.length ?? 0, ms: Date.now() - started }));
    return { mode: 'PREVIEW' as const, ...plan };
  }

  /** APPLY: the validated plan is executed atomically by the canonical layer. */
  async apply(id: string, input: { presetId?: unknown; revision?: unknown }) {
    const started = Date.now();
    const { plan, revision } = await this.buildPlan(id, input.presetId, input.revision);
    const presetRunId = randomUUID();
    const project = await this.editMode.applyPresetBundle(id, revision, {
      presetId: plan.presetId, presetRunId, summary: plan.summary, commands: plan.commands,
      plannedZoomMoments: plan.plannedZoomMoments
    });
    this.logger.log(JSON.stringify({ event: 'edit_mode_preset_apply', editProjectId: id,
      presetId: plan.presetId, presetRunId, commandCount: plan.commands.length,
      warningCount: plan.warnings?.length ?? 0, revision: project.revision,
      ms: Date.now() - started }));
    const { commands: _commands, ...proposal } = plan;
    return { mode: 'APPLY' as const, presetRunId, plan: proposal, project };
  }

  private async buildPlan(id: string, presetIdValue: unknown, revisionValue: unknown) {
    if (!isEditPresetId(presetIdValue)) {
      throw new BadRequestException({ code: 'UNKNOWN_PRESET',
        message: 'presetId must be one of the supported EditMode presets' });
    }
    const presetId: EditPresetId = presetIdValue;
    const policy = EDIT_PRESETS[presetId];

    const project = await this.prisma.editProject.findUnique({ where: { id }, include: {
      assets: { orderBy: { createdAt: 'asc' } },
      elements: { orderBy: [{ track: 'asc' }, { position: 'asc' }] }
    } });
    if (!project) throw new NotFoundException('EditProject not found');
    if (revisionValue !== undefined && Number(revisionValue) !== project.revision) {
      throw new BadRequestException({ code: 'STALE_REVISION',
        message: 'EditProject revision is stale', currentRevision: project.revision });
    }
    const source = project.assets.find((asset) => asset.role === 'SOURCE');
    if (!source) throw new BadRequestException({ code: 'NO_SOURCE',
      message: 'Attach a source video before applying a preset' });

    const currentStyle = readEditProjectStyle(project.settings);
    const previousRun = readEditPresetRun(project.settings);
    // Cached transcript and cached visual analysis only - a preset never
    // re-transcribes or re-analyses a source that has already been analysed.
    const evidence = buildPresetEvidence({
      durationSec: source.duration ?? 0, width: source.width, height: source.height,
      metadata: source.metadata, transcript: source.transcript, analysis: source.analysis,
      aspectRatio: policy.aspectRatio,
      preserveInformation: policy.informationRegionPolicy !== 'IGNORE'
    });

    const elements: PlannerElement[] = project.elements.map((element) => ({
      id: element.id, type: element.type, track: element.track, position: element.position,
      startTime: element.startTime, duration: element.duration, trimStart: element.trimStart,
      trimEnd: element.trimEnd, assetId: element.assetId,
      properties: element.properties && typeof element.properties === 'object' &&
        !Array.isArray(element.properties) ? element.properties as Record<string, unknown> : {}
    }));
    const assets: PlannerAsset[] = project.assets.map((asset) => ({
      id: asset.id, role: asset.role, duration: asset.duration, width: asset.width,
      height: asset.height, originalName: asset.originalName
    }));

    const hookOverride = await this.llmHook(policy.hookPolicy, evidence.transcriptText,
      policy.automatic);
    const proposal = planPreset({ policy, evidence, elements, assets, currentStyle, previousRun,
      hookOverride });
    // A generated plan is validated before it can reach the canonical layer,
    // whichever path produced it.
    const commands = validatePresetCommands(proposal.commands);
    const warnings = [...proposal.warnings];
    if (!source.transcript) {
      warnings.push('This source has not been analysed yet. Run "Analyze source" first for a ' +
        'content-aware edit; the preset can only set project policy until then.');
    }
    const plan: PresetPlan = { ...proposal, commands, warnings };
    return { revision: project.revision, plan };
  }

  /**
   * Optional semantic judgement: headline wording.
   *
   * Deterministic logic is preferred and is always the fallback. When a
   * provider is configured for the current AI mode, candidates are requested
   * under a strict schema and then scored by the SAME grounding rules the
   * deterministic path uses, so an ungrounded or clickbait line is discarded
   * rather than written to the timeline. FALLBACK_ONLY skips this entirely.
   */
  private async llmHook(hookPolicy: string, transcript: string, automatic: boolean) {
    if (!automatic || hookPolicy === 'OFF' || !transcript.trim()) return null;
    if ((process.env.EDIT_MODE_PRESET_LLM_ENABLED ?? 'true').toLowerCase() === 'false') return null;
    if (!this.llm.isAnyConfigured('hookGeneration')) return null;
    const excerpt = transcript.slice(0, 6000);
    try {
      const result = await this.llm.generate<{ hooks: Array<{ text: string }> }>({
        role: 'hookGeneration',
        request: {
          schemaName: 'edit_mode_preset_hook', schema: HOOK_SCHEMA, role: 'hookGeneration',
          cacheKey: `edit-mode-preset-hook:${excerpt.length}:${excerpt.slice(0, 120)}`,
          systemPrompt: 'You write short on-screen headlines for a video edit. Use only facts ' +
            'stated in the transcript. Never invent names, numbers or claims. No clickbait, no ' +
            'meta phrasing about "this clip" or "this video". 5 to 12 words each.',
          userPrompt: `Transcript:\n${excerpt}\n\nReturn up to five candidate headlines.`,
          options: { temperature: 0.4, maxOutputTokens: 400 }
        }
      });
      const candidates = (result.data?.hooks ?? []).map((hook) => String(hook?.text ?? ''))
        .filter(Boolean);
      const best = chooseBestHook(candidates, { transcript, title: '', synopsis: '' }).best;
      return best ? { text: best.text, source: 'LLM_ASSISTED' as const } : null;
    } catch (error) {
      this.logger.warn(`Preset headline routing unavailable, using deterministic hook: ${
        error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
