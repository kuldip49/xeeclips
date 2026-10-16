import { BadRequestException } from '@nestjs/common';
import { projectExecutionPolicy } from '../processing/execution-policy';

export type ReframeMode = 'XEEFREE' | 'XEEPRO';
/** Only persisted project provenance selects a route. Request consent never changes a tier. */
export function reframeMode(settings: unknown): ReframeMode {
  return projectExecutionPolicy(settings)?.mode ?? 'XEEFREE';
}
export function parseReframeMode(value: unknown): ReframeMode {
  if (value !== 'XEEFREE' && value !== 'XEEPRO') throw new BadRequestException('Choose XeeFree or XeePro.');
  return value;
}
export const reframeAiMode = (mode: ReframeMode) => mode === 'XEEPRO' ? 'ONLINE' : 'FALLBACK_ONLY';
