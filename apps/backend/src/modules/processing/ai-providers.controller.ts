import { BadRequestException, Body, Controller, Get, NotFoundException, Param,
  Patch, Post } from '@nestjs/common';
import { LlmProviderError, LlmProviderService, LlmTaskRole } from './llm-provider.service';
import { LlmRouterService } from './llm-router.service';
import { ProviderRegistry, ProviderUpdate } from './provider-registry';

const roles = new Set<LlmTaskRole>(['wholeVideoUnderstanding', 'multimodalUnderstanding',
  'clipUnderstanding', 'deepReasoning', 'candidateJudge', 'creativeGeneration',
  'hookGeneration', 'captionGeneration', 'titleGeneration', 'hashtagGeneration',
  'synopsisGeneration', 'critic', 'groundingVerification', 'componentRepair']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const validModel = (value: unknown) => typeof value === 'string' && value.length <= 200 &&
  !/[\r\n]/u.test(value);

@Controller('ai-providers')
export class AiProvidersController {
  constructor(private readonly registry: ProviderRegistry,
    private readonly router: LlmRouterService,
    private readonly providerService: LlmProviderService) {}

  @Get()
  list() {
    return { routingMode: 'PRIORITY', providers: this.registry.view().map(provider => {
      const route = this.registry.get(provider.id)?.routeFor('creativeGeneration');
      return { ...provider, state: route ? this.router.stateFor(route, 'creativeGeneration') :
        provider.state };
    }) };
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    const provider = this.registry.get(id);
    if (!provider) throw new NotFoundException('Unknown provider');
    if (!isRecord(body) || Object.keys(body).some(key => ![
      'enabled', 'priority', 'model', 'modelsByRole', 'capabilities', 'concurrency'].includes(key)))
      throw new BadRequestException('Invalid provider settings');
    const { enabled, priority, model, modelsByRole, capabilities, concurrency } = body;
    if (enabled !== undefined && typeof enabled !== 'boolean' ||
      priority !== undefined && (!Number.isInteger(priority) || Number(priority) < 1) ||
      model !== undefined && !validModel(model) ||
      concurrency !== undefined && (!Number.isInteger(concurrency) || Number(concurrency) < 1 ||
        Number(concurrency) > 16) ||
      modelsByRole !== undefined && (!isRecord(modelsByRole) ||
        Object.entries(modelsByRole).some(([role, value]) => !roles.has(role as LlmTaskRole) ||
          !validModel(value))) ||
      capabilities !== undefined && (!Array.isArray(capabilities) ||
        capabilities.some(role => !roles.has(role as LlmTaskRole) ||
          !provider.capabilities.has(role as LlmTaskRole))))
      throw new BadRequestException('Invalid provider settings');
    this.registry.update(id, body as ProviderUpdate);
    return this.registry.view().find(item => item.id === id);
  }

  @Post('reorder')
  reorder(@Body() body: unknown) {
    if (!isRecord(body) || !Array.isArray(body.providerIds) ||
      body.providerIds.some(id => typeof id !== 'string') ||
      !this.registry.reorder(body.providerIds as string[]))
      throw new BadRequestException('Invalid provider order');
    return this.list();
  }

  @Post(':id/test')
  async test(@Param('id') id: string) {
    const adapter = this.registry.get(id);
    if (!adapter) throw new NotFoundException('Unknown provider');
    const role: LlmTaskRole = 'critic';
    const route = adapter.routeFor(role);
    if (!adapter.isConfigured(role)) return { provider: id, configured: false,
      reachable: false, modelAvailable: false, latencyMs: 0 };
    const started = Date.now();
    try {
      await this.providerService.generateStructuredWithConfig({ ...route,
        timeoutMs: Math.min(route.timeoutMs, 8000), maxRetries: 0 }, {
        role, schemaName: 'provider_connectivity',
        schema: { type: 'object', additionalProperties: false,
          properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        systemPrompt: 'Return JSON containing only {"ok":true}.',
        userPrompt: 'Connection test.', maxOutputTokens: 32 });
      return { provider: id, configured: true, reachable: true,
        modelAvailable: true, latencyMs: Date.now() - started };
    } catch (error) {
      const kind = error instanceof LlmProviderError ? error.kind : 'UNKNOWN_PROVIDER_FAILURE';
      return { provider: id, configured: true, reachable: false,
        modelAvailable: kind !== 'MODEL_NOT_FOUND', latencyMs: Date.now() - started,
        failureCategory: kind };
    }
  }
}
