'use client';

import { useEffect, useRef } from 'react';

/**
 * Re-runs `task` every `intervalMs` while `enabled`.
 *
 * The next run is scheduled only after the previous one settles, so a slow API (the laptop
 * behind the tunnel) never accumulates overlapping requests. Hidden tabs stop polling and catch
 * up with one immediate run when they become visible again.
 */
export function usePolling(task: () => Promise<unknown> | unknown, intervalMs: number, enabled: boolean) {
  const latest = useRef(task);
  latest.current = task;
  useEffect(() => {
    if (!enabled) return undefined;
    let stopped = false;
    let running = false;
    let timer: number | undefined;
    const visible = () => document.visibilityState !== 'hidden';
    const schedule = () => {
      if (!stopped && visible()) timer = window.setTimeout(run, intervalMs);
    };
    async function run() {
      timer = undefined;
      if (stopped || running) return;
      running = true;
      try { await latest.current(); } catch { /* the next run tries again */ }
      finally { running = false; schedule(); }
    }
    const onVisibility = () => {
      if (!visible()) { window.clearTimeout(timer); timer = undefined; return; }
      if (timer === undefined && !running) void run();
    };
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, intervalMs]);
}
