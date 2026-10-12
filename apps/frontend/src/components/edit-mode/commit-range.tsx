'use client';

import { useRef } from 'react';

/**
 * A range input that previews while it moves and commits exactly once when the user is done.
 *
 * "Done" is a pointer release, a key release or leaving the control - so a keyboard user's change
 * is saved as well as a mouse user's - and only a slider that actually MOVED commits, so tabbing
 * past it or releasing it where it started never writes an empty undo step.
 */
export function CommitRange({ value, min, max, step, className, ariaLabel, disabled, onPreview, onCommit }: {
  value: number; min: number; max: number; step: number; className?: string;
  ariaLabel?: string; disabled?: boolean;
  onPreview: (value: number) => void; onCommit: (value: number) => void;
}) {
  const moved = useRef(false);
  const commit = () => { if (!moved.current) return; moved.current = false; onCommit(value); };
  return <input type='range' min={min} max={max} step={step} value={value} disabled={disabled}
    aria-label={ariaLabel} className={className}
    onChange={(event) => { moved.current = true; onPreview(Number(event.target.value)); }}
    onPointerUp={commit} onKeyUp={commit} onBlur={commit} />;
}
