import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import { rm } from 'fs/promises';
import { Request, Response } from 'express';
import { parseAutoGeneration } from './auto-generation';
import { VideosService } from './videos.service';
import { VideoUploadSessionService } from './video-upload-session.service';
import { parseClipCreationRequest } from './clip-selection.service';

export const parseClipSelection = parseClipCreationRequest;

@Controller()
export class VideosController {
  constructor(private readonly videosService: VideosService,
    private readonly uploadSessions: VideoUploadSessionService) {}

  @Post('projects/:projectId/videos/upload-sessions')
  createUploadSession(@Param('projectId') projectId: string, @Body() body: Record<string, unknown>) {
    return this.uploadSessions.create(projectId, body);
  }

  @Put('upload-sessions/:id/chunks/:index')
  writeUploadChunk(@Param('id') id: string, @Param('index') index: string, @Req() request: Request) {
    return this.uploadSessions.writeChunk(id, index, request);
  }

  @Post('upload-sessions/:id/complete')
  completeUpload(@Param('id') id: string) {
    return this.uploadSessions.complete(id);
  }

  @Get('videos')
  listVideos(@Query('projectId') projectId?: string) {
    return this.videosService.list(projectId);
  }

  @Get('videos/:id/transcript')
  getTranscript(@Param('id') id: string) {
    return this.videosService.getTranscript(id);
  }

  @Get('videos/:id/understanding')
  getUnderstanding(@Param('id') id: string) {
    return this.videosService.getUnderstanding(id);
  }

  @Post('videos/:id/retry')
  retry(@Param('id') id: string) {
    return this.videosService.retry(id);
  }

  @Delete('videos/:id')
  delete(@Param('id') id: string) {
    return this.videosService.delete(id);
  }

  @Get('videos/:id/chunks')
  getChunks(@Param('id') id: string) {
    return this.videosService.getChunks(id);
  }

  @Get('videos/:id/chunk-analysis')
  getChunkAnalysis(@Param('id') id: string) {
    return this.videosService.getChunkAnalysis(id);
  }

  @Get('videos/:id/clip-candidates')
  getClipCandidates(@Param('id') id: string, @Query('limit') limit = '100') {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    return this.videosService.getClipCandidates(id, parsedLimit);
  }

  @Get('videos/:id/clip-recommendations')
  getClipRecommendations(@Param('id') id: string) {
    return this.videosService.getClipRecommendations(id);
  }

  @Get('videos/:id/clip-analysis')
  getClipAnalysis(@Param('id') id: string) {
    return this.videosService.getClipAnalysis(id);
  }

  @Get('videos/:id/clip-results')
  getClipResults(@Param('id') id: string) {
    return this.videosService.getClipResults(id);
  }

  @Post('videos/:id/clip-selection')
  selectClips(@Param('id') id: string, @Body() body: unknown) {
    return this.videosService.selectClips(id, parseClipSelection(body));
  }

  @Get('videos/:id/generated-clips')
  getGeneratedClips(@Param('id') id: string) {
    return this.videosService.getGeneratedClips(id);
  }

  @Get('history/clips')
  getHistory() {
    return this.videosService.getHistory();
  }

  @Delete('generated-clips/:clipId')
  deleteGeneratedClip(@Param('clipId') clipId: string) {
    return this.videosService.deleteGeneratedClip(clipId);
  }

  /** Step 9.1: play the uploaded source before configuring generation. */
  @Get('videos/:id/file')
  async getVideoFile(
    @Param('id') id: string,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) response: Response
  ) {
    const file = await this.videosService.getVideoFile(id, range);
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', file.end - file.start + 1);
    if (file.partial) {
      response.status(206);
      response.setHeader('Content-Range', `bytes ${file.start}-${file.end}/${file.size}`);
    }
    return new StreamableFile(file.stream);
  }

  /** Step 9.1: a meaningful still of the source for the setup preview. */
  @Get('videos/:id/poster')
  async getVideoPoster(@Param('id') id: string, @Res({ passthrough: true }) response: Response) {
    const poster = await this.videosService.getVideoPoster(id);
    response.setHeader('Content-Type', poster.mimeType);
    response.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(poster.stream);
  }

  @Get('generated-clips/:clipId/file')
  async getGeneratedClipFile(
    @Param('clipId') clipId: string,
    @Headers('range') range: string | undefined,
    @Query('download') download: string | undefined,
    @Res({ passthrough: true }) response: Response
  ) {
    const file = await this.videosService.getGeneratedClipFile(clipId, range);
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', file.end - file.start + 1);
    if (download === '1') response.setHeader('Content-Disposition',
      `attachment; filename="xeeclip-${clipId.replace(/[^a-z0-9-]/giu, '')}.mp4"`);
    if (file.partial) {
      response.status(206);
      response.setHeader('Content-Range', `bytes ${file.start}-${file.end}/${file.size}`);
    }
    return new StreamableFile(file.stream);
  }

  @Get('generated-clips/:clipId/poster')
  async getGeneratedClipPoster(
    @Param('clipId') clipId: string,
    @Res({ passthrough: true }) response: Response
  ) {
    const poster = await this.videosService.getGeneratedClipPoster(clipId);
    response.setHeader('Content-Type', poster.mimeType);
    // The cover is immutable for a given clip id.
    response.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(poster.stream);
  }

  @Get('videos/:id/visual-analysis')
  getVisualAnalysis(@Param('id') id: string) {
    return this.videosService.getVisualAnalysis(id);
  }

  @Post('projects/:projectId/videos')
  // Disk, not memory: a long source is streamed to storage instead of held in the Node heap.
  @UseInterceptors(FileInterceptor('file', { storage: diskStorage({ destination: tmpdir() }) }))
  async uploadVideo(
    @Param('projectId') projectId: string,
    @Body('aiMode') aiMode: unknown,
    @Body('processingType') processingType: unknown,
    @Body('aspectRatio') aspectRatio: unknown,
    @Body('targetPlatform') targetPlatform: unknown,
    @Body('generationRequest') generationRequest: unknown,
    @UploadedFile() file?: Express.Multer.File
  ) {
    if (!file) {
      throw new BadRequestException('Video file is required');
    }

    if (!file.mimetype.startsWith('video/')) {
      throw new BadRequestException('Uploaded file must be a video');
    }

    // One-step entry: an optional pre-selected clip request (validated now) is handed to the
    // ordinary clip-selection path once analysis completes. Without it, uploads analyse only.
    let autoGeneration: ReturnType<typeof parseAutoGeneration>;
    try { autoGeneration = parseAutoGeneration(generationRequest); } catch (error) {
      if (file.path) await rm(file.path, { force: true }).catch(() => undefined);
      throw error;
    }
    return this.videosService.createFromUpload(projectId, file, aiMode, processingType, aspectRatio,
      targetPlatform, undefined, autoGeneration);
  }
}
