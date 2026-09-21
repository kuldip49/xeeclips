import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { ProcessingModule } from "../processing/processing.module";
import { VideosController } from "./videos.controller";
import { VideosService } from "./videos.service";

import { ClipExportService } from './clip-export.service';
import { ClipRenderQueueService } from './clip-render-queue.service';
import { EditingModule } from '../editing/editing.module';

@Module({
  imports: [StorageModule, ProcessingModule, EditingModule],
  controllers: [VideosController],
  providers: [ClipExportService, ClipRenderQueueService, VideosService],
  exports: [VideosService]
})
export class VideosModule {}
