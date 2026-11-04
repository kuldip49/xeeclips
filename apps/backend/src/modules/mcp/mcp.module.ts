import { MediaReviewModule } from "../media-review/media-review.module";
import { Module } from "@nestjs/common";
import { VideosModule } from "../videos/videos.module";
import { EditModeModule } from "../edit-mode/edit-mode.module";
import { QuickReframeModule } from "../quick-reframe/quick-reframe.module";
import { CampaignsModule } from "../campaigns/campaigns.module";
import { McpOAuthService } from "./mcp-oauth.service";
import { McpOperationsService } from "./mcp-operations.service";
import { McpAdapterService } from "./mcp-adapter.service";
import { McpHttpService } from "./mcp-http.service";
import { McpController } from "./mcp.controller";
@Module({
  imports: [
    MediaReviewModule,
    VideosModule,
    EditModeModule,
    QuickReframeModule,
    CampaignsModule,
  ],
  controllers: [McpController],
  providers: [
    McpOAuthService,
    McpOperationsService,
    McpAdapterService,
    McpHttpService,
  ],
  exports: [McpHttpService],
})
export class McpModule {}
