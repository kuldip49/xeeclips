import { Module } from '@nestjs/common';
import { VideosModule } from '../videos/videos.module';
import { EditModeModule } from '../edit-mode/edit-mode.module';
import { StorageModule } from '../storage/storage.module';
import { ProcessingModule } from '../processing/processing.module';
import { CampaignsService } from './campaigns.service';
import { CampaignAssetsService } from './campaign-assets.service';
import { CampaignUnderstandingService } from './campaign-understanding.service';
import { CampaignsController } from './campaigns.controller';
@Module({ imports: [VideosModule, EditModeModule, StorageModule, ProcessingModule], controllers: [CampaignsController], providers: [CampaignsService, CampaignAssetsService, CampaignUnderstandingService] })
export class CampaignsModule {
}
