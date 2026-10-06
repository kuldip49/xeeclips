import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { EditModeModule } from '../edit-mode/edit-mode.module';
import { LlmProviderService } from '../processing/llm-provider.service';
import { LlmRouterService } from '../processing/llm-router.service';
import { ProviderRegistry } from '../processing/provider-registry';
import { QuickReframeService } from './quick-reframe.service';
import { QuickReframeController } from './quick-reframe.controller';
@Module({imports:[StorageModule,EditModeModule],controllers:[QuickReframeController],
  providers:[QuickReframeService,LlmProviderService,LlmRouterService,ProviderRegistry]})
export class QuickReframeModule {}
