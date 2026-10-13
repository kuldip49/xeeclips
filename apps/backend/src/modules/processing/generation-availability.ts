import { AsyncLocalStorage } from 'async_hooks';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';

export const XEEPRO_UNAVAILABLE = 'XEEPRO_UNAVAILABLE';
export const XEEPRO_UNAVAILABLE_MESSAGE = 'XeePro is temporarily unavailable. XeeFree is available.';

/**
 * XEEPRO_ENABLED is only an emergency/manual kill switch. Unset, empty or `true` means Pro is selectable; any other
 * value disables NEW Pro work. It says nothing about whether the provider currently has capacity: that is decided per
 * request (see the busy scope below), so topping up provider credit needs no flag change and no deployment.
 */
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

// ---------------------------------------------------------------------------------------------------------------------
// XeePro busy: the provider is out of capacity right now (429 / quota / overload / outage).
//
// A XeePro job that hits this must END, not quietly turn into a XeeFree job. The router records the condition here; the
// job entry points (analysis worker, clip creation, request-level AI calls) run inside a scope and check it at stage
// boundaries. Nothing is stored beyond the lifetime of the scope, so there is no permanent "Pro is down" state.
// ---------------------------------------------------------------------------------------------------------------------
export const XEEPRO_BUSY = 'XEEPRO_BUSY';
export const XEEPRO_BUSY_MESSAGE = 'XeePro is busy right now. Try XeeFree or try again later.';

/** Safe internal categories. They are persisted for operators and never shown to users. */
export type ProviderBusyCategory = 'PROVIDER_BUSY' | 'PROVIDER_RATE_LIMITED' | 'PROVIDER_QUOTA_UNAVAILABLE'
  | 'PROVIDER_UNAVAILABLE';

/** Maps a provider failure kind to a busy category, or null when the failure is not a capacity/availability problem. */
export function providerBusyCategory(kind: string | undefined): ProviderBusyCategory | null {
  switch (kind) {
    case 'RATE_LIMIT_FAILURE': return 'PROVIDER_RATE_LIMITED';
    case 'QUOTA_FAILURE': case 'QUOTA_EXHAUSTED_FAILURE': return 'PROVIDER_QUOTA_UNAVAILABLE';
    case 'PROVIDER_5XX_FAILURE': case 'PROVIDER_SATURATION_FAILURE': return 'PROVIDER_BUSY';
    case 'AUTH_FAILURE': case 'MODEL_NOT_FOUND': return 'PROVIDER_UNAVAILABLE';
    default: return null;
  }
}

/** HTTP 503 with a stable, provider-free body. Thrown by request handlers and by the job stage checks. */
export class XeeProBusyError extends ServiceUnavailableException {
  constructor(readonly category: ProviderBusyCategory) {
    super({ code: XEEPRO_BUSY, message: XEEPRO_BUSY_MESSAGE, retryable: true });
    this.name = 'XeeProBusyError';
  }
}

type BusyScope = { category: ProviderBusyCategory | null };
const busyScope = new AsyncLocalStorage<BusyScope>();

/** Runs one unit of Pro work. Nested performance contexts inherit the scope, so any stage can flag it. */
export function runInProviderBusyScope<T>(fn: () => Promise<T>): Promise<T> {
  return busyScope.run({ category: null }, fn);
}
/** Request-level helper: run an explicit Pro AI call and turn a capacity failure into XEEPRO_BUSY instead of a quiet local result. */
export async function withProviderBusyGuard<T>(fn: () => Promise<T>): Promise<T> {
  return runInProviderBusyScope(async () => { const result = await fn(); assertProviderNotBusy(); return result; });
}
export function markProviderBusy(category: ProviderBusyCategory): void {
  const scope = busyScope.getStore();
  if (scope && !scope.category) scope.category = category;
}
export const currentProviderBusy = (): ProviderBusyCategory | null => busyScope.getStore()?.category ?? null;
export function assertProviderNotBusy(): void {
  const category = currentProviderBusy();
  if (category) throw new XeeProBusyError(category);
}
export const isXeeProBusyError = (error: unknown): error is XeeProBusyError => error instanceof XeeProBusyError;
