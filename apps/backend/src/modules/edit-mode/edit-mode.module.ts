import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { LlmProviderService } from '../processing/llm-provider.service';
import { LlmRouterService } from '../processing/llm-router.service';
import { ProviderRegistry } from '../processing/provider-registry';
import { EditModeAnalysisService } from './edit-mode-analysis.service';
import { EditModePresetService } from './edit-mode-preset.service';
import { EditTemplateService } from './edit-template.service';
import { EditModeController } from './edit-mode.controller';
import { EditModeService } from './edit-mode.service';
import { EditModeRecoveryService } from './render/edit-mode-recovery.service';
import { EditModeRenderService } from './render/edit-mode-render.service';
import { EditChatService } from './chat/edit-chat.service';
import { EditChatProposalStore } from './chat/edit-chat-proposal-store';
import { EditReviewService } from './review/edit-review.service';
import { EditReviewStore } from './review/edit-review-store';
import { EditBriefService } from './brief/edit-brief.service';
import { EditBriefPlanStore } from './brief/edit-brief-plan-store';
import { GeneratedClipEditProjectMaterializerService } from './generated-clip-edit-project-materializer.service';
import { EditAgentService } from './agent/edit-agent.service';
import { GenerationStylingService } from './styles/generation-styling.service';
import { ReferenceAnalysisService } from './styles/reference-analysis.service';
import { SavedStylesService } from './styles/saved-styles.service';

// LLM routing is provided directly rather than by importing ProcessingModule, so
// the frozen processing queue and video processor never enter EditMode's
// injector graph. Preset planning stays deterministic without it.
@Module({
  imports: [StorageModule],
  controllers: [EditModeController],
  providers: [EditModeService, GeneratedClipEditProjectMaterializerService,
    EditModeAnalysisService, EditModePresetService, EditTemplateService,
    EditModeRenderService, EditModeRecoveryService,
    EditChatService, EditChatProposalStore,
    EditReviewService, EditReviewStore, EditBriefService, EditBriefPlanStore, EditAgentService,
    GenerationStylingService, ReferenceAnalysisService, SavedStylesService,
    LlmProviderService, ProviderRegistry, LlmRouterService],
  exports: [GenerationStylingService, SavedStylesService]
})
export class EditModeModule {}
