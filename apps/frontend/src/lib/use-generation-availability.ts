'use client';
import { useEffect, useState } from 'react';
import { getVideoImportCapabilities } from './api';

/** Server-owned emergency switch. `false` means the owner turned Pro off; `null` is unknown and never blocks Pro. */
export function useGenerationAvailability() {
  const [proEnabled, setProEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => void getVideoImportCapabilities().then(value => {
      if (active) setProEnabled(value.xeePro !== false);
    }).catch(() => { if (active) setProEnabled(null); });
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  return { proEnabled };
}
