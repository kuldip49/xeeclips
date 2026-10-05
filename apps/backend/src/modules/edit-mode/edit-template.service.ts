// EditMode Workstream F: template orchestration.
//
//   template (built-in or user-saved)
//     -> planTemplate() -> validated canonical commands
//     -> EditModeService.applyTemplateBundle() -> EditProject -> renderer -> export
//
// PREVIEW builds the same plan APPLY does and writes nothing at all - not a
// revision, not a settings key, not an element. APPLY hands the plan to the
// canonical layer, which commits it as one TEMPLATE history revision.
//
// This service never enqueues work, never creates ProcessingJob / ClipCandidate
// / GeneratedClip rows, and never reads or writes Project or Video records.
//
// SCOPE: this build has no user identity, so user templates are workspace-global
// under a single `LOCAL` owner scope. That is a real limitation and is stated in
// the API response, not hidden: anyone with access to this instance sees the
// same template library.

import type { EditConstraint } from './edit-command-scope';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { EditModeService } from './edit-mode.service';
import { readEditProjectStyle } from './presets/edit-preset-policy';
import { wordsFromCache } from './presets/edit-preset-evidence';
import {
  BUILTIN_TEMPLATES, builtinTemplateList, isBuiltinTemplateId
} from './templates/edit-template-library';
import {
  planTemplate, readTemplateRun, templateDefaults, type TemplatePlanAsset, type TemplatePlanElement
} from './templates/edit-template-plan';
import {
  MAX_TEMPLATE_DESCRIPTION_LENGTH, MAX_TEMPLATE_NAME_LENGTH, readTemplate, TemplateSchemaError,
  TEMPLATE_SCHEMA_VERSION, templatePayload, validateTemplateInput, type EditTemplate
} from './templates/edit-template-schema';

/** The single owner scope this build has. Adding real users later is a data
 *  migration on this column, not a schema change. */
const OWNER_SCOPE = 'LOCAL';
/** Documented limits. A template is a small policy object; nothing here should
 *  ever be large, so a large one is a bug or an abuse rather than a use case. */
export const MAX_USER_TEMPLATES = 100;
export const MAX_TEMPLATE_PAYLOAD_BYTES = 8 * 1024;

@Injectable()
export class EditTemplateService {
  private readonly logger = new Logger(EditTemplateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly editMode: EditModeService
  ) {}

  // --- Library ---------------------------------------------------------------

  /** Built-ins and user templates in one list, so the browser renders one grid. */
  async list() {
    const rows = await this.prisma.editTemplate.findMany({
      where: { ownerScope: OWNER_SCOPE }, orderBy: { updatedAt: 'desc' } });
    const user = rows.map((row) => this.fromRow(row));
    return {
      version: TEMPLATE_SCHEMA_VERSION,
      scope: OWNER_SCOPE,
      scopeNote: 'This build has no user accounts, so saved templates are shared by everyone ' +
        'using this instance.',
      limits: { maxUserTemplates: MAX_USER_TEMPLATES, maxNameLength: MAX_TEMPLATE_NAME_LENGTH,
        maxDescriptionLength: MAX_TEMPLATE_DESCRIPTION_LENGTH,
        maxPayloadBytes: MAX_TEMPLATE_PAYLOAD_BYTES },
      builtin: builtinTemplateList(),
      user
    };
  }

  async get(templateId: string): Promise<EditTemplate> {
    if (isBuiltinTemplateId(templateId)) return BUILTIN_TEMPLATES[templateId];
    const row = await this.prisma.editTemplate.findUnique({ where: { id: templateId } });
    if (!row || row.ownerScope !== OWNER_SCOPE) throw new NotFoundException('Template not found');
    return this.fromRow(row);
  }

  // --- User template CRUD ----------------------------------------------------

  /**
   * Saves the CURRENT project's style as a portable template.
   *
   * Style and policy only. The source video, the caption wording, the hook
   * wording and the asset ids are deliberately not captured - a template that
   * remembered them would only ever work on the project it came from. A logo or
   * a music file is bound only when the caller explicitly opts in.
   */
  async createFromProject(input: {
    editProjectId?: unknown; name?: unknown; description?: unknown;
    includeLogo?: unknown; includeMusic?: unknown;
  }) {
    const editProjectId = String(input.editProjectId ?? '');
    const project = await this.prisma.editProject.findUnique({
      where: { id: editProjectId },
      include: { assets: true, elements: { orderBy: [{ track: 'asc' }, { position: 'asc' }] } } });
    if (!project) throw new NotFoundException('EditProject not found');
    const draft = this.captureTemplate(project, {
      includeLogo: input.includeLogo === true, includeMusic: input.includeMusic === true });
    return this.create({ ...draft, name: input.name, description: input.description });
  }

  async create(input: Record<string, unknown>) {
    const template = this.validate(input);
    const count = await this.prisma.editTemplate.count({ where: { ownerScope: OWNER_SCOPE } });
    if (count >= MAX_USER_TEMPLATES) {
      throw new BadRequestException({ code: 'TOO_MANY_TEMPLATES',
        message: `You already have ${MAX_USER_TEMPLATES} saved templates. Delete one first.` });
    }
    const payload = this.boundedPayload(template);
    const row = await this.prisma.editTemplate.create({ data: {
      name: template.name, description: template.description, ownerScope: OWNER_SCOPE,
      version: TEMPLATE_SCHEMA_VERSION, payload } }).catch((error) => this.uniqueName(error));
    this.logger.log(JSON.stringify({ event: 'edit_template_created', templateId: row.id }));
    return this.fromRow(row);
  }

  /** Rename / re-describe, and optionally replace the style payload. */
  async update(templateId: string, input: Record<string, unknown>) {
    const existing = await this.requireUserRow(templateId);
    const current = this.fromRow(existing);
    const merged = this.validate({
      ...templatePayload(current),
      name: input.name === undefined ? current.name : input.name,
      description: input.description === undefined ? current.description : input.description,
      ...(input.template && typeof input.template === 'object'
        ? input.template as Record<string, unknown> : {})
    });
    const row = await this.prisma.editTemplate.update({ where: { id: templateId }, data: {
      name: merged.name, description: merged.description, version: TEMPLATE_SCHEMA_VERSION,
      payload: this.boundedPayload(merged) } }).catch((error) => this.uniqueName(error));
    return this.fromRow(row);
  }

  /** Duplicating a BUILT-IN is how a user starts their own from a product one. */
  async duplicate(templateId: string, input: { name?: unknown }) {
    const source = await this.get(templateId);
    const name = typeof input.name === 'string' && input.name.trim()
      ? input.name : await this.uniqueCopyName(source.name);
    return this.create({ ...templatePayload(source), name, description: source.description });
  }

  async remove(templateId: string) {
    await this.requireUserRow(templateId);
    await this.prisma.editTemplate.delete({ where: { id: templateId } });
    return { deleted: true, id: templateId };
  }

  // --- Preview and apply -----------------------------------------------------

  /** PREVIEW: the structured diff. Nothing is written - no revision, no row. */
  async preview(editProjectId: string, input: { templateId?: unknown; revision?: unknown }) {
    const { plan } = await this.buildPlan(editProjectId, input.templateId, input.revision);
    const { commands: _commands, imprints: _imprints, ...proposal } = plan;
    return { mode: 'PREVIEW' as const, ...proposal };
  }

  /** APPLY: one transaction, one TEMPLATE history revision, one undo. */
  async apply(editProjectId: string, input: { templateId?: unknown; revision?: unknown;
    /** Task constraints of an automated caller (the AI agent); enforced per command. */
    constraints?: EditConstraint[] }) {
    const started = Date.now();
    const { plan, revision, template } = await this.buildPlan(editProjectId, input.templateId,
      input.revision);
    const templateRunId = randomUUID();
    const project = await this.editMode.applyTemplateBundle(editProjectId, revision, {
      templateId: template.id, templateName: template.name, templateRunId,
      source: template.source, summary: plan.summary, commands: plan.commands,
      imprints: plan.imprints, defaults: templateDefaults(template),
      ...(input.constraints ? { constraints: input.constraints } : {})
    });
    this.logger.log(JSON.stringify({ event: 'edit_template_apply', editProjectId,
      templateId: template.id, templateRunId, commandCount: plan.commands.length,
      changeCount: plan.changes.length, preservedCount: plan.preserved.length,
      revision: project.revision, ms: Date.now() - started }));
    const { commands: _commands, imprints: _imprints, ...proposal } = plan;
    return { mode: 'APPLY' as const, templateRunId, plan: proposal, project };
  }

  // --- Internals -------------------------------------------------------------

  private async buildPlan(editProjectId: string, templateIdValue: unknown, revisionValue: unknown) {
    const templateId = String(templateIdValue ?? '');
    if (!templateId) throw new BadRequestException({ code: 'INVALID_TEMPLATE',
      message: 'templateId is required' });
    const template = await this.get(templateId);
    const project = await this.prisma.editProject.findUnique({
      where: { id: editProjectId },
      include: { assets: true, elements: { orderBy: [{ track: 'asc' }, { position: 'asc' }] } } });
    if (!project) throw new NotFoundException('EditProject not found');
    if (revisionValue !== undefined && Number(revisionValue) !== project.revision) {
      throw new BadRequestException({ code: 'STALE_REVISION',
        message: 'EditProject revision is stale', currentRevision: project.revision });
    }
    const source = project.assets.find((asset) => asset.role === 'SOURCE');
    if (!source) throw new BadRequestException({ code: 'NO_SOURCE',
      message: 'Attach a source video before applying a template' });

    const elements: TemplatePlanElement[] = project.elements.map((element) => ({
      id: element.id, type: element.type, track: element.track, position: element.position,
      assetId: element.assetId,
      properties: {
        ...(element.properties && typeof element.properties === 'object' &&
          !Array.isArray(element.properties) ? element.properties as Record<string, unknown> : {}),
        // Timing is read-only context for ordering captions; no command writes it.
        startTime: element.startTime, duration: element.duration
      }
    }));
    const assets: TemplatePlanAsset[] = project.assets.map((asset) => ({
      id: asset.id, role: asset.role }));
    const plan = planTemplate({
      template,
      style: readEditProjectStyle(project.settings),
      elements, assets,
      previousRun: readTemplateRun(project.settings),
      // The SAME predicate the command layer's SET_AUDIO_DUCKING uses
      // (EditModeService.hasSpeechTiming): real WORD timings. Segment-level
      // timings produce words too, and counting them here made the preview
      // promise ducking that the apply then refused - failing the whole
      // template with DUCKING_UNAVAILABLE. Found by Workstream G's chat path.
      duckingAvailable: (() => {
        const cached = wordsFromCache(source.transcript);
        return cached.wordTimings && cached.words.length > 0;
      })()
    });
    return { revision: project.revision, plan, template };
  }

  /** Reads the current project's style back out as a portable template. */
  private captureTemplate(project: {
    settings: unknown;
    assets: Array<{ id: string; role: string }>;
    elements: Array<{ type: string; properties: unknown; assetId: string | null }>;
  }, options: { includeLogo: boolean; includeMusic: boolean }) {
    const style = readEditProjectStyle(project.settings);
    const settings = project.settings && typeof project.settings === 'object' &&
      !Array.isArray(project.settings) ? project.settings as Record<string, unknown> : {};
    const defaults = settings.templateDefaults && typeof settings.templateDefaults === 'object'
      ? settings.templateDefaults as Record<string, unknown> : {};
    const properties = (element: { properties: unknown }) =>
      element.properties && typeof element.properties === 'object' &&
        !Array.isArray(element.properties) ? element.properties as Record<string, unknown> : {};
    const caption = project.elements.find((element) => element.type === 'SUBTITLE');
    const logo = project.elements.find((element) => element.type === 'IMAGE' &&
      String(properties(element).role ?? '') === 'LOGO');
    const video = project.elements.find((element) => element.type === 'VIDEO');
    const music = project.elements.find((element) => element.type === 'AUDIO');
    const captionProps = caption ? properties(caption) : {};
    const videoProps = video ? properties(video) : {};
    const musicProps = music ? properties(music) : {};
    const logoProps = logo ? properties(logo) : {};
    const y = Number(captionProps.y);
    const placement = !caption ? defaults.captionPlacement
      : Number.isFinite(y) ? (y < 0.35 ? 'UPPER' : y < 0.68 ? 'CENTER' : 'LOWER') : 'PRESET';
    const logoY = Number(logoProps.y); const logoX = Number(logoProps.x);
    const logoPlacement = !logo ? defaults.logoPlacement
      : `${logoY < 0.5 ? 'TOP' : 'BOTTOM'}_${logoX < 0.5 ? 'LEFT' : 'RIGHT'}`;
    return {
      version: TEMPLATE_SCHEMA_VERSION,
      project: { aspectRatio: style.aspectRatio, pacing: style.pacing },
      text: {
        defaultStyleId: defaults.textStyleId, hookStyleId: defaults.hookStyleId,
        ctaStyleId: defaults.ctaStyleId
      },
      captions: {
        styleId: captionProps.captionStyleId ?? defaults.captionStyleId,
        placement,
        activeWord: (captionProps.activeWord as { enabled?: unknown } | undefined)?.enabled ===
          true ? true : caption ? false : undefined,
        uppercase: caption ? captionProps.uppercase === true : undefined
      },
      logo: { placement: logoPlacement, scale: Number(logoProps.width) || defaults.logoScale },
      color: { filterId: videoProps.colorFilterId, strength: videoProps.colorFilterStrength },
      audio: {
        musicVolume: music ? musicProps.volume : defaults.musicVolume,
        duckEnabled: music ? musicProps.duckUnderSpeech === true : defaults.duckEnabled,
        duckStrength: music ? musicProps.duckStrength : defaults.duckStrength,
        fadeInSec: music ? musicProps.fadeInSec : defaults.fadeInSec,
        fadeOutSec: music ? musicProps.fadeOutSec : defaults.fadeOutSec
      },
      zoom: style.zoomPolicy, reframe: style.reframePolicy,
      informationRegion: style.informationRegionPolicy,
      // Asset binding is OPT-IN and is the only place a template may name a file.
      assets: {
        logoAssetId: options.includeLogo ? logo?.assetId ?? null : null,
        musicAssetId: options.includeMusic ? music?.assetId ?? null : null
      }
    };
  }

  private validate(input: Record<string, unknown>): EditTemplate {
    try { return validateTemplateInput(input); }
    catch (error) {
      if (error instanceof TemplateSchemaError) {
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      throw error;
    }
  }

  private boundedPayload(template: EditTemplate): Prisma.InputJsonValue {
    const payload = templatePayload(template);
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (bytes > MAX_TEMPLATE_PAYLOAD_BYTES) {
      throw new BadRequestException({ code: 'TEMPLATE_TOO_LARGE',
        message: `A template may be at most ${MAX_TEMPLATE_PAYLOAD_BYTES} bytes.` });
    }
    return payload as Prisma.InputJsonValue;
  }

  private fromRow(row: { id: string; name: string; description: string; payload: unknown }) {
    try {
      return readTemplate(row.payload,
        { id: row.id, name: row.name, description: row.description, source: 'USER' });
    } catch (error) {
      if (error instanceof TemplateSchemaError) {
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      throw error;
    }
  }

  private async requireUserRow(templateId: string) {
    if (isBuiltinTemplateId(templateId)) {
      throw new BadRequestException({ code: 'BUILTIN_TEMPLATE',
        message: 'Built-in templates cannot be changed or deleted. Duplicate one instead.' });
    }
    const row = await this.prisma.editTemplate.findUnique({ where: { id: templateId } });
    if (!row || row.ownerScope !== OWNER_SCOPE) throw new NotFoundException('Template not found');
    return row;
  }

  private async uniqueCopyName(base: string) {
    const stem = base.slice(0, MAX_TEMPLATE_NAME_LENGTH - 6);
    for (let index = 2; index < 100; index += 1) {
      const candidate = index === 2 ? `${stem} copy` : `${stem} copy ${index}`;
      const clash = await this.prisma.editTemplate.findFirst({
        where: { ownerScope: OWNER_SCOPE, name: candidate } });
      if (!clash) return candidate;
    }
    return `${stem} ${Date.now()}`.slice(0, MAX_TEMPLATE_NAME_LENGTH);
  }

  private uniqueName(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new BadRequestException({ code: 'DUPLICATE_TEMPLATE_NAME',
        message: 'You already have a template with that name.' });
    }
    throw error;
  }
}
