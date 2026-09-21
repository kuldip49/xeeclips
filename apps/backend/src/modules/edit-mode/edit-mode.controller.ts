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
  DeleteElementDto,
  MoveElementDto,
  Phase3EditCommandDto,
  RevisionCommandDto,
  SplitElementDto,
  TrimElementDto
} from './dto/manual-edit-command.dto';
import { ApplyEditPresetDto } from './dto/apply-edit-preset.dto';
import { EditModePresetService } from './edit-mode-preset.service';
import { EditModeService } from './edit-mode.service';

@Controller('edit-mode')
export class EditModeController {
  constructor(private readonly editMode: EditModeService,
    private readonly presets: EditModePresetService) {}

  /** The preset catalogue: typed policies, not templates. */
  @Get('presets')
  listPresets() {
    return this.presets.list();
  }

  @Post('projects')
  create(@Body() body: CreateEditProjectDto) {
    return this.editMode.create(body);
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
    const file = await this.editMode.assetFile(assetId, range);
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', file.end - file.start + 1);
    if (file.partial) {
      response.status(206);
      response.setHeader('Content-Range', `bytes ${file.start}-${file.end}/${file.size}`);
    }
    return new StreamableFile(file.stream);
  }
}
