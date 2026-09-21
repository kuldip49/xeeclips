import { Module } from '@nestjs/common';
import { ProcessingModule } from '../processing/processing.module';
import { EditPlanService } from './edit-plan.service';
import { EditingPlanValidator } from './editing-plan-validator';
import { ReframeService } from './reframe.service';
import { SubtitleRendererService } from './subtitle-renderer.service';
import { VideoEditExecutorService } from './video-edit-executor.service';
import { ContentPackagingService, ContentCategoryService,
  EntityResolutionService, FirstFramePackagingValidator } from './content-packaging.service';

@Module({
  imports: [ProcessingModule],
  providers: [EditPlanService, EditingPlanValidator, ReframeService,
    SubtitleRendererService, VideoEditExecutorService, ContentPackagingService,
    ContentCategoryService, EntityResolutionService, FirstFramePackagingValidator],
  exports: [EditPlanService, VideoEditExecutorService, ContentPackagingService]
})
export class EditingModule {}
