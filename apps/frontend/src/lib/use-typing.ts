'use client';

import { useEffect, useState } from 'react';

const TEXT_ENTRY = 'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=button]):not([type=submit]), textarea, select, [contenteditable="true"]';

/**
 * True while a text field has focus on a touch screen - i.e. the software keyboard is up.
 *
 * Works on both platforms: Android resizes the layout viewport (so visualViewport alone can't
 * tell), iOS doesn't (so viewport units alone can't). It also marks `<html data-keyboard="open">`
 * so CSS can step fixed chrome (the tab bar) out of the keyboard's way.
 */
export function useTypingFlag() {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const coarse = window.matchMedia?.('(pointer: coarse)');
    let timer = 0;
    const focusIn = (event: FocusEvent) => {
      if (!coarse?.matches || !(event.target instanceof Element) || !event.target.matches(TEXT_ENTRY)) return;
      window.clearTimeout(timer);
      setTyping(true);
    };
    // Moving focus between two fields fires out-then-in; wait a beat before showing chrome again.
    const focusOut = () => { window.clearTimeout(timer); timer = window.setTimeout(() => setTyping(false), 120); };
    document.addEventListener('focusin', focusIn);
    document.addEventListener('focusout', focusOut);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('focusin', focusIn);
      document.removeEventListener('focusout', focusOut);
    };
  }, []);
  useEffect(() => {
    if (typing) document.documentElement.dataset.keyboard = 'open';
    else delete document.documentElement.dataset.keyboard;
    return () => { delete document.documentElement.dataset.keyboard; };
  }, [typing]);
  return typing;
}
