import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query } from
  '@nestjs/common';
import { VideoImportService } from './video-import.service';
import { ImportError } from './youtube-import.adapter';

@Controller()
export class VideoImportController {
  constructor(private readonly imports: VideoImportService) {}

  @Get('videos/import-capabilities')
  capabilities() {
    return { youtubeEnabled: process.env.YOUTUBE_IMPORT_APPROVED === 'true' };
  }

  @Post('videos/import-url')
  @HttpCode(202)
  async importUrl(@Body() body: Record<string, unknown>) {
    try { return await this.imports.submit(body || {}); }
    catch (error) {
      if (error instanceof ImportError) throw new BadRequestException({ code: error.code,
        message: error.message });
      throw error;
    }
  }

  @Get('videos/import-jobs')
  listImports(@Query('projectId') projectId: string) {
    if (!projectId) throw new BadRequestException('projectId is required');
    return this.imports.list(projectId);
  }

  @Get('videos/import-jobs/:id')
  getImport(@Param('id') id: string) { return this.imports.get(id); }

  @Post('videos/import-jobs/:id/retry')
  retryImport(@Param('id') id: string) { return this.imports.retry(id); }

  @Post('videos/import-jobs/:id/cancel')
  cancelImport(@Param('id') id: string) { return this.imports.cancel(id); }
}
