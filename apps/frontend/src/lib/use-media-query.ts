'use client';

import { useEffect, useState } from 'react';

/** Tailwind's `md` breakpoint: below it the app uses its phone layouts. */
export const MOBILE_QUERY = '(max-width: 767px)';
/** Below Tailwind's `lg`: the desktop sidebar is replaced by the mobile shell. */
export const COMPACT_QUERY = '(max-width: 1023px)';

/**
 * `null` until mounted, so server HTML and the first client render agree. Layout that can be
 * expressed in CSS should stay in CSS; this is for choosing which component tree to mount
 * (a docked drawer vs. a sidebar), where mounting both would double requests or media.
 */
export function useMediaQuery(query: string): boolean | null {
  const [matches, setMatches] = useState<boolean | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener?.('change', update);
    return () => list.removeEventListener?.('change', update);
  }, [query]);
  return matches;
}

export const useIsMobile = () => useMediaQuery(MOBILE_QUERY) === true;
