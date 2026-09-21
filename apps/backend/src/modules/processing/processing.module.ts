import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { ProcessingQueueService } from "./processing-queue.service";
import { VideoProcessorService } from "./video-processor.service";

import { ClipJudgeService } from './openai-clip-judge.service';
import { LlmProviderService } from './llm-provider.service';
import { VideoUnderstandingService } from './video-understanding.service';
import { LlmRouterService } from './llm-router.service';
import { ProviderRegistry } from './provider-registry';
import { AiProvidersController } from './ai-providers.controller';
import { ClipIntelligenceService } from './clip-intelligence.service';
import { ClipCriticService } from './clip-critic.service';
import { LocalSemanticSimilarityService } from './semantic-similarity.service';

@Module({
  imports: [StorageModule],
  controllers: [AiProvidersController],
  providers: [
    ProcessingQueueService,
    LlmProviderService,
    ProviderRegistry,
    LlmRouterService,
    ClipIntelligenceService,
    ClipCriticService,
    LocalSemanticSimilarityService,
    VideoUnderstandingService,
    ClipJudgeService,
    VideoProcessorService
  ],
  exports: [ProcessingQueueService, LlmRouterService]
})
export class ProcessingModule {}
