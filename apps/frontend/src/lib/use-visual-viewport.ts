'use client';

import { useEffect, useState } from 'react';

export type VisualViewportState = {
  /** Visible height in CSS px (shrinks when an on-screen keyboard opens). */
  height: number | null;
  /** How far the browser has panned the visual viewport down (iOS keyboard). */
  offsetTop: number;
  /** Space the keyboard (or other browser UI) takes from the bottom of the layout viewport. */
  keyboardInset: number;
  /** A keyboard-sized inset: the software keyboard is very likely open. */
  keyboardOpen: boolean;
};

const CLOSED: VisualViewportState = { height: null, offsetTop: 0, keyboardInset: 0, keyboardOpen: false };

/**
 * Tracks `window.visualViewport`.
 *
 * Android Chrome (with `interactive-widget=resizes-content`) shrinks the layout viewport itself
 * when the keyboard opens, so `dvh` already follows it and the inset stays ~0. iOS Safari keeps
 * the layout viewport and only shrinks/pans the visual one; this hook is what lets fixed inputs
 * and sheets sit on top of the keyboard there instead of underneath it.
 */
export function useVisualViewport(enabled = true): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>(CLOSED);
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || !window.visualViewport) return;
    const viewport = window.visualViewport;
    let frame = 0;
    const read = () => {
      frame = 0;
      const inset = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
      const next = { height: Math.round(viewport.height), offsetTop: Math.max(0, Math.round(viewport.offsetTop)),
        keyboardInset: inset, keyboardOpen: inset > 120 || window.innerHeight - viewport.height > 120 };
      setState((current) => current.height === next.height && current.offsetTop === next.offsetTop &&
        current.keyboardInset === next.keyboardInset ? current : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(read); };
    read();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    return () => {
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled]);
  return enabled ? state : CLOSED;
}
