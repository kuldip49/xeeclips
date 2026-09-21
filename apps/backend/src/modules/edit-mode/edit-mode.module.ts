import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { LlmProviderService } from '../processing/llm-provider.service';
import { LlmRouterService } from '../processing/llm-router.service';
import { ProviderRegistry } from '../processing/provider-registry';
import { EditModeAnalysisService } from './edit-mode-analysis.service';
import { EditModePresetService } from './edit-mode-preset.service';
import { EditModeController } from './edit-mode.controller';
import { EditModeService } from './edit-mode.service';

// LLM routing is provided directly rather than by importing ProcessingModule, so
// the frozen processing queue and video processor never enter EditMode's
// injector graph. Preset planning stays deterministic without it.
@Module({
  imports: [StorageModule],
  controllers: [EditModeController],
  providers: [EditModeService, EditModeAnalysisService, EditModePresetService,
    LlmProviderService, ProviderRegistry, LlmRouterService]
})
export class EditModeModule {}
