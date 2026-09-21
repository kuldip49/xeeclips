import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { VideosService } from './videos.service';
import { parseClipCreationRequest } from './clip-selection.service';

export const parseClipSelection = parseClipCreationRequest;

@Controller()
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

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

  @Get('generated-clips/:clipId/file')
  async getGeneratedClipFile(
    @Param('clipId') clipId: string,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) response: Response
  ) {
    const file = await this.videosService.getGeneratedClipFile(clipId, range);
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', file.end - file.start + 1);
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
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return new StreamableFile(poster.stream);
  }

  @Get('videos/:id/visual-analysis')
  getVisualAnalysis(@Param('id') id: string) {
    return this.videosService.getVisualAnalysis(id);
  }

  @Post('projects/:projectId/videos')
  @UseInterceptors(FileInterceptor('file'))
  uploadVideo(
    @Param('projectId') projectId: string,
    @Body('aiMode') aiMode: unknown,
    @Body('processingType') processingType: unknown,
    @Body('aspectRatio') aspectRatio: unknown,
    @Body('targetPlatform') targetPlatform: unknown,
    @UploadedFile() file?: Express.Multer.File
  ) {
    if (!file) {
      throw new BadRequestException('Video file is required');
    }

    if (!file.mimetype.startsWith('video/')) {
      throw new BadRequestException('Uploaded file must be a video');
    }

    // Uploads start analysis only; output style is chosen after analysis via clip-selection.
    return this.videosService.createFromUpload(projectId, file, aiMode, processingType, aspectRatio,
      targetPlatform);
  }
}
