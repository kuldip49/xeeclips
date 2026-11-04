import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { MediaReviewService } from "./media-review.service";
import { MediaReviewEvidenceService } from "./media-review-evidence.service";
import { MediaReviewController } from "./media-review.controller";
@Module({
  imports: [StorageModule],
  controllers: [MediaReviewController],
  providers: [MediaReviewService, MediaReviewEvidenceService],
  exports: [MediaReviewService, MediaReviewEvidenceService],
})
export class MediaReviewModule {}
