import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AttachEditAssetDto } from './dto/attach-edit-asset.dto';
import { CreateEditProjectDto } from './dto/create-edit-project.dto';
import { UpdateEditElementsDto } from './dto/update-edit-elements.dto';
import {
  AdjustSourceRangeDto,
  DeleteElementDto,
  MoveElementDto,
  Phase3EditCommandDto,
  ProjectConstraintsDto,
  RevisionCommandDto,
  SplitElementDto,
  TrimElementDto
} from './dto/manual-edit-command.dto';
import { ApplyEditPresetDto } from './dto/apply-edit-preset.dto';
import { ExportEditProjectDto } from './dto/export-edit-project.dto';
import { ApplyEditChatDto, CancelEditChatDto, PlanEditChatDto } from './dto/edit-chat.dto';
import { EditChatService } from './chat/edit-chat.service';
import { EditReviewService } from './review/edit-review.service';
import { EditBriefService } from './brief/edit-brief.service';
import { CreateEditBriefDto, ProposeReviewSuggestionDto, RespondEditBriefDto,
  ReviewEditDto } from './dto/edit-review.dto';
import { EditModePresetService } from './edit-mode-preset.service';
import { EditTemplateService } from './edit-template.service';
import { EditModeService, MediaRangeNotSatisfiableError } from './edit-mode.service';
import { DUCK_STRENGTHS, MAX_VOLUME } from './edit-mode-audio';
import { COLOR_BOUNDS, COLOR_FILTERS, NEUTRAL_COLOR } from './edit-mode-color';
import { CAPTION_STYLE_PRESETS, EDIT_MODE_FONT_IDS,
  TEXT_STYLE_PRESETS } from './edit-mode-text';
import {
  ApplyEditTemplateDto, CreateEditTemplateDto, DuplicateEditTemplateDto, UpdateEditTemplateDto
} from './dto/edit-template.dto';
import { EditModeRenderService } from './render/edit-mode-render.service';
import { GeneratedClipEditProjectMaterializerService } from './generated-clip-edit-project-materializer.service';
import { EditAgentService } from './agent/edit-agent.service';
import { toolCatalog } from './agent/edit-agent-tools';
import { creativeCatalog } from './styles/creative-style-library';
import { resolveCreativeStyle } from './styles/creative-style-resolver';
import { resolveVisualLayout } from './styles/resolved-visual-layout';
import { interpretBrief } from './styles/creative-brief';
import { GenerationStylingService } from './styles/generation-styling.service';
import { ReferenceAnalysisService } from './styles/reference-analysis.service';
import { SavedStylesService } from './styles/saved-styles.service';
import { LlmRouterService } from '../processing/llm-router.service';
import { chatPlannerAiMode } from './chat/edit-chat-planner';

@Controller('edit-mode')
export class EditModeController {
  constructor(private readonly editMode: EditModeService,
    private readonly generatedClips: GeneratedClipEditProjectMaterializerService,
    private readonly presets: EditModePresetService,
    private readonly templates: EditTemplateService,
    private readonly render: EditModeRenderService,
    private readonly chat: EditChatService,
    private readonly reviews: EditReviewService,
    private readonly briefs: EditBriefService,
    private readonly agent: EditAgentService,
    private readonly styling: GenerationStylingService,
    private readonly references: ReferenceAnalysisService,
    private readonly savedStyles: SavedStylesService,
    private readonly llm: LlmRouterService) {}

  // --- Step 9/10: unified generation styles ---------------------------------

  /** Full templates + every component style library (with honest support flags). */
  @Get('creative/catalog')
  creativeCatalog() {
    return creativeCatalog();
  }

  /**
   * THE precedence resolver, exposed so the UI preview and the generator agree:
   * instruction > component > reference > template > default.
   */
  @Post('creative/resolve')
  async resolveCreative(@Body() body: { templateId?: unknown; components?: unknown;
    brief?: unknown; useAi?: unknown; referenceId?: unknown;
    sourceWidth?: unknown; sourceHeight?: unknown }) {
    const brief = typeof body.brief === 'string' ? body.brief.slice(0, 1500) : '';
    const interpreted = await interpretBrief({ brief, llm: body.useAi === true ? this.llm : null,
      aiMode: chatPlannerAiMode() });
    const components = body.components && typeof body.components === 'object' &&
      !Array.isArray(body.components) ? body.components as Record<string, string> : {};
    const templateId = typeof body.templateId === 'string' && body.templateId ? body.templateId
      : interpreted.templateHint;
    // Same layer the generation request uses, so the preview resolves exactly
    // what will be applied. A reference still analysing contributes nothing yet.
    const reference = typeof body.referenceId === 'string' && body.referenceId
      ? await this.references.get(body.referenceId).catch(() => null) : null;
    const derived = reference?.status === 'READY' ? reference.derivedStyle as { choices?: unknown } : null;
    const savedIds = Object.values(components).filter((id) => typeof id === 'string' &&
      /^[0-9a-f-]{36}$/iu.test(id));
    const saved = await this.savedStyles.byIds(savedIds).catch(() => ({}));
    const resolved = resolveCreativeStyle({ instruction: interpreted.styleHints,
      components, templateId, saved,
      reference: derived?.choices && typeof derived.choices === 'object' ? derived.choices as never : undefined });
    return { interpreted, resolved, layout: resolveVisualLayout(resolved, {
      sourceWidth: Number(body.sourceWidth) || undefined,
      sourceHeight: Number(body.sourceHeight) || undefined,
    }) };
  }

  // --- Step 17: user-saved component styles (stable ids) ---------------------

  @Get('saved-styles')
  listSavedStyles(@Headers('x-category') category?: string) {
    return this.savedStyles.list(category);
  }

  @Post('saved-styles')
  createSavedStyle(@Body() body: Record<string, unknown>) {
    return this.savedStyles.create(body);
  }

  @Delete('saved-styles/:styleId')
  deleteSavedStyle(@Param('styleId') styleId: string) {
    return this.savedStyles.remove(styleId);
  }

  // --- Step 12: reference video (analysed for editing principles, never copied)

  @Post('references/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 300 * 1024 * 1024 } }))
  uploadReference(@Body('videoId') videoId: unknown, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Reference video file is required');
    return this.references.upload(file, typeof videoId === 'string' && videoId ? videoId : null);
  }

  @Post('references/url')
  referenceFromUrl(@Body() body: { url?: unknown; videoId?: unknown }) {
    return this.references.fromUrl(String(body.url ?? ''),
      typeof body.videoId === 'string' && body.videoId ? body.videoId : null);
  }

  @Get('references/:referenceId')
  getReference(@Param('referenceId') referenceId: string) {
    return this.references.get(referenceId);
  }

  /** (Re)starts canonical styling of a video's delivered clips. Idempotent. */
  @Post('generation/videos/:videoId/style')
  styleGeneratedClips(@Param('videoId') videoId: string) {
    return this.styling.ensureStyled(videoId);
  }

  @Post('generation/clips/:generatedClipId/retry-style')
  retryGeneratedClipStyle(@Param('generatedClipId') generatedClipId: string) {
    return this.styling.retryClip(generatedClipId);
  }

  // --- Workstream F: templates ----------------------------------------------
  //
  // A template is a style POLICY applied into the same canonical EditProject.
  // Preview writes nothing; apply is one TEMPLATE history revision.

  /** Built-in and user-saved templates, with the documented limits and scope. */
  @Get('templates')
  listTemplates() {
    return this.templates.list();
  }

  @Get('templates/:templateId')
  getTemplate(@Param('templateId') templateId: string) {
    return this.templates.get(templateId);
  }

  /** With `editProjectId`, captures that project's current style; otherwise
   *  saves a template supplied field by field. */
  @Post('templates')
  createTemplate(@Body() body: CreateEditTemplateDto) {
    const input = body as unknown as Record<string, unknown>;
    return input.editProjectId
      ? this.templates.createFromProject(input)
      : this.templates.create(input);
  }

  @Patch('templates/:templateId')
  updateTemplate(@Param('templateId') templateId: string, @Body() body: UpdateEditTemplateDto) {
    return this.templates.update(templateId, body as unknown as Record<string, unknown>);
  }

  @Post('templates/:templateId/duplicate')
  duplicateTemplate(@Param('templateId') templateId: string,
    @Body() body: DuplicateEditTemplateDto) {
    return this.templates.duplicate(templateId, body);
  }

  @Delete('templates/:templateId')
  deleteTemplate(@Param('templateId') templateId: string) {
    return this.templates.remove(templateId);
  }

  /** The bounded structured diff. Canonical state is untouched. */
  @Post('projects/:id/template/preview')
  previewTemplate(@Param('id') id: string, @Body() body: ApplyEditTemplateDto) {
    return this.templates.preview(id, body);
  }

  @Post('projects/:id/template/apply')
  applyTemplate(@Param('id') id: string, @Body() body: ApplyEditTemplateDto) {
    return this.templates.apply(id, body);
  }

  /** The preset catalogue: typed policies, not templates. */
  @Get('presets')
  listPresets() {
    return this.presets.list();
  }

  /**
   * The built-in text and caption style catalogues.
   *
   * The editor mirrors these in `lib/edit-mode-text.ts` so it can draw a styled
   * preview without a round trip; this endpoint is what the parity test compares
   * that mirror against, so the two can never drift apart unnoticed.
   */
  @Get('text-styles')
  listTextStyles() {
    return { textStyles: TEXT_STYLE_PRESETS, captionStyles: CAPTION_STYLE_PRESETS,
      fontFamilies: EDIT_MODE_FONT_IDS };
  }

  /**
   * The built-in colour filters, the bounds of every Adjust control and the
   * ducking strengths.
   *
   * The editor mirrors these in `lib/edit-mode-color.ts` so a slider can redraw
   * without a round trip; this endpoint is what the parity test compares that
   * mirror against, so the two cannot drift apart unnoticed.
   */
  @Get('color')
  listColor() {
    return { filters: COLOR_FILTERS, bounds: COLOR_BOUNDS, neutral: NEUTRAL_COLOR,
      duckStrengths: DUCK_STRENGTHS, maxVolume: MAX_VOLUME };
  }

  @Post('projects')
  create(@Body() body: CreateEditProjectDto) {
    return this.editMode.create(body);
  }

  @Post('projects/from-generated-clip/:generatedClipId')
  materializeGeneratedClip(@Param('generatedClipId') generatedClipId: string) {
    return this.generatedClips.materialize(generatedClipId);
  }

  @Get('projects')
  list() {
    return this.editMode.list();
  }

  @Get('projects/:id')
  get(@Param('id') id: string) {
    return this.editMode.get(id);
  }

  @Patch('projects/:id')
  update(@Param('id') id: string, @Body() body: CreateEditProjectDto & { revision?: unknown }) {
    return this.editMode.update(id, body);
  }

  @Delete('projects/:id')
  remove(@Param('id') id: string) {
    return this.editMode.remove(id);
  }

  @Post('projects/:id/assets')
  attachAsset(@Param('id') id: string, @Body() body: AttachEditAssetDto) {
    return this.editMode.attachFromVideo(id, body.sourceVideoId, body.revision);
  }

  @Post('projects/:id/source/from-video')
  attachFromVideo(@Param('id') id: string, @Body() body: AttachEditAssetDto) {
    return this.editMode.attachFromVideo(id, body.sourceVideoId, body.revision);
  }

  @Post('projects/:id/source/upload')
  @UseInterceptors(FileInterceptor('file'))
  attachUpload(
    @Param('id') id: string,
    @Body('revision') revision: unknown,
    @UploadedFile() file?: Express.Multer.File
  ) {
    if (!file) throw new BadRequestException('Video file is required');
    return this.editMode.attachUpload(id, file, revision);
  }

  @Post('projects/:id/assets/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 200 * 1024 * 1024 } }))
  uploadAsset(
    @Param('id') id: string,
    @Body('revision') revision: unknown,
    @Body('role') role: unknown,
    @UploadedFile() file?: Express.Multer.File
  ) {
    if (!file) throw new BadRequestException('Asset file is required');
    return this.editMode.uploadAsset(id, file, role, revision);
  }

  @Delete('projects/:id/assets/:assetId')
  deleteAsset(@Param('id') id: string, @Param('assetId') assetId: string,
    @Body() body: RevisionCommandDto) {
    return this.editMode.deleteAsset(id, assetId, body.revision);
  }

  @Post('projects/:id/analyze')
  analyze(@Param('id') id: string, @Body('revision') revision: unknown) {
    return this.editMode.analyze(id, revision);
  }

  /** PREVIEW: returns a structured proposal and mutates nothing. */
  @Post('projects/:id/preset/preview')
  previewPreset(@Param('id') id: string, @Body() body: ApplyEditPresetDto) {
    return this.presets.preview(id, body);
  }

  /** APPLY: executes the validated plan as one PRESET history revision. */
  @Post('projects/:id/preset/apply')
  applyPreset(@Param('id') id: string, @Body() body: ApplyEditPresetDto) {
    return this.presets.apply(id, body);
  }

  @Patch('projects/:id/elements')
  updateElements(@Param('id') id: string, @Body() body: UpdateEditElementsDto) {
    return this.editMode.updateElements(id, body);
  }

  @Post('projects/:id/commands/trim')
  trimElement(@Param('id') id: string, @Body() body: TrimElementDto) {
    return this.editMode.trimElement(id, body);
  }

  @Post('projects/:id/commands/split')
  splitElement(@Param('id') id: string, @Body() body: SplitElementDto) {
    return this.editMode.splitElement(id, body);
  }

  @Post('projects/:id/commands/delete')
  deleteElement(@Param('id') id: string, @Body() body: DeleteElementDto) {
    return this.editMode.deleteElement(id, body);
  }

  @Post('projects/:id/commands/move')
  moveElement(@Param('id') id: string, @Body() body: MoveElementDto) {
    return this.editMode.moveElement(id, body);
  }

  @Post('projects/:id/commands/adjust-source-range')
  adjustSourceRange(@Param('id') id: string, @Body() body: AdjustSourceRangeDto) {
    return this.editMode.adjustSourceRange(id, body);
  }

  /** Step 5: persistent project locks (bind manual edits too, until removed). */
  @Get('projects/:id/constraints')
  getConstraints(@Param('id') id: string) {
    return this.editMode.getConstraints(id);
  }

  @Put('projects/:id/constraints')
  setConstraints(@Param('id') id: string, @Body() body: ProjectConstraintsDto) {
    return this.editMode.setConstraints(id, body);
  }

  @Post('projects/:id/commands/:action')
  phase3Command(@Param('id') id: string, @Param('action') action: string,
    @Body() body: Phase3EditCommandDto) {
    return this.editMode.phase3Command(id, action, body as unknown as Record<string, unknown>);
  }

  @Post('projects/:id/undo')
  undo(@Param('id') id: string, @Body() body: RevisionCommandDto) {
    return this.editMode.undo(id, body.revision);
  }

  @Post('projects/:id/redo')
  redo(@Param('id') id: string, @Body() body: RevisionCommandDto) {
    return this.editMode.redo(id, body.revision);
  }

  // --- Phase 5: render and export ------------------------------------------
  // EditMode's own rendering path. Nothing here reaches the frozen clip export,
  // render queue or processing pipeline.

  /** Starts a render and returns immediately with its progress. */
  @Post('projects/:id/export')
  startExport(@Param('id') id: string, @Body() body: ExportEditProjectDto) {
    return this.render.startExport(id, body.revision);
  }

  /** Live export progress, or the last persisted one after a restart. */
  @Get('projects/:id/export/progress')
  exportProgress(@Param('id') id: string) {
    return this.render.progress(id);
  }

  /** Every export this project has produced, newest first. */
  @Get('projects/:id/exports')
  listExports(@Param('id') id: string) {
    return this.render.listExports(id);
  }

  @Get('projects/:id/exports/:assetId')
  getExport(@Param('id') id: string, @Param('assetId') assetId: string) {
    return this.render.getExport(id, assetId);
  }

  // --- Step 7/8: the AI editor agent ----------------------------------------
  // The agent EDITS the project through validated tools and verifies every
  // clause; destructive work waits for a yes unless autonomy was granted.

  @Get('agent/tools')
  agentTools() {
    return { tools: toolCatalog() };
  }

  @Get('projects/:id/agent')
  agentState(@Param('id') id: string) {
    return this.agent.state(id);
  }

  @Post('projects/:id/agent/run')
  agentRun(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.agent.run(id, body);
  }

  @Put('projects/:id/agent/autonomy')
  agentAutonomy(@Param('id') id: string, @Body() body: { autonomy?: unknown }) {
    return this.agent.setAutonomy(id, body.autonomy);
  }

  // --- Phase 6: AI chat editor ---------------------------------------------
  // Natural language in, validated EditMode commands out. Planning writes no
  // edit; only Apply does, and it goes through the canonical bundle path.

  /** The stored conversation for this project. */
  @Get('projects/:id/chat')
  chatThread(@Param('id') id: string) {
    return this.chat.thread(id);
  }

  /** PLAN: builds a proposal. The timeline is not touched. */
  @Post('projects/:id/chat/plan')
  chatPlan(@Param('id') id: string, @Body() body: PlanEditChatDto) {
    return this.chat.plan(id, body);
  }

  /** APPLY: commits the server-held proposal as one ASSISTANT revision. */
  @Post('projects/:id/chat/apply')
  chatApply(@Param('id') id: string, @Body() body: ApplyEditChatDto) {
    return this.chat.apply(id, body);
  }

  /** CANCEL: discards a pending proposal. */
  @Post('projects/:id/chat/cancel')
  chatCancel(@Param('id') id: string, @Body() body: CancelEditChatDto) {
    return this.chat.cancel(id, body);
  }

  // --- Workstream H: read-only AI review -----------------------------------

  @Get('projects/:id/review')
  latestReview(@Param('id') id: string) {
    return this.reviews.latest(id);
  }

  @Post('projects/:id/review')
  review(@Param('id') id: string, @Body() body: ReviewEditDto) {
    return this.reviews.review(id, body);
  }

  @Post('projects/:id/review/propose')
  proposeReviewSuggestion(@Param('id') id: string,
    @Body() body: ProposeReviewSuggestionDto) {
    return this.reviews.propose(id, String(body.findingId ?? ''), body);
  }

  // --- Workstream I: supervised edit from brief ----------------------------

  @Get('projects/:id/brief')
  currentBrief(@Param('id') id: string) {
    return this.briefs.current(id);
  }

  @Post('projects/:id/brief')
  createBrief(@Param('id') id: string, @Body() body: CreateEditBriefDto) {
    return this.briefs.create(id, body);
  }

  @Post('projects/:id/brief/respond')
  respondBrief(@Param('id') id: string, @Body() body: RespondEditBriefDto) {
    return this.briefs.respond(id, body);
  }

  @Get('projects/:id/history')
  history(@Param('id') id: string) {
    return this.editMode.history(id);
  }

  @Get('assets/:assetId/file')
  async assetFile(
    @Param('assetId') assetId: string,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) response: Response
  ) {
    let file;
    try {
      file = await this.editMode.assetFile(assetId, range);
    } catch (caught) {
      if (caught instanceof MediaRangeNotSatisfiableError) {
        response.setHeader('Accept-Ranges', 'bytes');
        response.setHeader('Content-Range', `bytes */${caught.size}`);
        response.status(416).json({ code: 'MEDIA_RANGE_NOT_SATISFIABLE',
          message: caught.message });
        return;
      }
      throw caught;
    }
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', file.end - file.start + 1);
    if (file.partial) {
      response.status(206);
      response.setHeader('Content-Range', `bytes ${file.start}-${file.end}/${file.size}`);
    }
    // Chrome frequently abandons one MP4 range as soon as it has enough bytes
    // and opens another for the moov/sample data it needs next. Tear down the
    // corresponding MinIO stream when the HTTP response closes; otherwise
    // those abandoned upstream reads keep consuming sockets and can make
    // unrelated project/agent/export requests appear hung after repeated seeks.
    response.once('close', () => {
      if (!file.stream.destroyed) file.stream.destroy();
    });
    return new StreamableFile(file.stream);
  }
}
