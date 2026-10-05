import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { ProcessingModule } from "../processing/processing.module";
import { VideosController } from "./videos.controller";
import { VideosService } from "./videos.service";

import { ClipExportService } from './clip-export.service';
import { ClipRenderQueueService } from './clip-render-queue.service';
import { EditingModule } from '../editing/editing.module';
import { VideoImportService } from './video-import.service';
import { VideoImportController } from './video-import.controller';
import { VideoUploadSessionService } from './video-upload-session.service';

@Module({
  imports: [StorageModule, ProcessingModule, EditingModule],
  controllers: [VideosController, VideoImportController],
  providers: [ClipExportService, ClipRenderQueueService, VideosService, VideoImportService,
    VideoUploadSessionService],
  exports: [VideosService]
})
export class VideosModule {}
