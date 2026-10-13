import { ConflictException } from '@nestjs/common';

export const XEEPRO_UNAVAILABLE = 'XEEPRO_UNAVAILABLE';
export const XEEPRO_UNAVAILABLE_MESSAGE = 'XeePro is temporarily unavailable. XeeFree is available.';

/** Unset preserves existing deployments. Explicit invalid values fail closed. */
export function isXeeProEnabled(): boolean {
  const value = process.env.XEEPRO_ENABLED?.trim().toLowerCase();
  return value === undefined || value === '' || value === 'true';
}
export const generationCapabilities = () => ({ xeeFree: true, xeePro: isXeeProEnabled() });
export function assertXeeProAvailable(): void {
  if (!isXeeProEnabled()) throw new ConflictException({ code: XEEPRO_UNAVAILABLE,
    message: XEEPRO_UNAVAILABLE_MESSAGE, retryable: false });
}
/** Check before source storage, queue mutation or credit reservation. */
export function assertNewProcessingMode(value: unknown): void {
  if (typeof value === 'string' && ['ONLINE', 'XEEPRO'].includes(value.trim().toUpperCase())) assertXeeProAvailable();
}
