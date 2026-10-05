'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

export type BackendStatus = 'checking' | 'online' | 'offline';

/** apiFetch's wording for a network failure or a tunnel/proxy 5xx. */
export const SERVER_UNAVAILABLE = 'Processing server is currently unavailable.';

export function isServerUnavailable(error: unknown) {
  return error instanceof Error && error.message === SERVER_UNAVAILABLE;
}

/**
 * Whether the processing API (the laptop behind the tunnel) answers. The public frontend keeps
 * working without it; pages use this to pause generation cleanly instead of surfacing raw
 * network errors. While offline it re-checks every 15 s and recovers on its own.
 */
export function useBackendStatus() {
  const [status, setStatus] = useState<BackendStatus>('checking');
  const check = useCallback(async () => {
    try {
      await apiFetch<unknown>('/health');
      setStatus('online');
      return true;
    } catch (error) {
      setStatus(isServerUnavailable(error) ? 'offline' : 'online');
      return !isServerUnavailable(error);
    }
  }, []);
  useEffect(() => { void check(); }, [check]);
  useEffect(() => {
    if (status !== 'offline') return;
    const timer = window.setInterval(() => { void check(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [check, status]);
  return { status, offline: status === 'offline', recheck: check };
}
