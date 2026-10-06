'use client';

import { memo } from 'react';
import { Eye, EyeOff, Lock, LockOpen, Volume2, VolumeX } from 'lucide-react';
import type { TimelineTrack, TrackToggleState } from '@/lib/edit-mode-tracks';

/**
 * One track header.
 *
 * Only controls a track can actually honour are rendered: the video row has no
 * hide button because hiding footage would silently restack a sequential track,
 * and the text rows have no mute button because they make no sound. A control
 * that is present is backed by a canonical command and survives a reload.
 *
 * A MIXED state (some of the track hidden, some not) shows the "off" icon with
 * a dot, and one click resolves the whole track to the toggled-on state.
 */

/** An EMPTY track is neither on nor off: with nothing on it there is nothing to
 *  hide, mute or lock, and showing the "on" icon would claim a state the track
 *  does not have. Only ALL and MIXED light a toggle up. */
const active = (state: TrackToggleState) => state === 'ALL' || state === 'MIXED';

const Toggle = ({ label, hint, on, mixed, onClick, disabled, children }: {
  label: string; hint: string; on: boolean; mixed: boolean; onClick: () => void;
  disabled?: boolean; children: React.ReactNode;
}) => <button type='button' aria-label={label} title={hint} onClick={onClick} disabled={disabled}
  aria-pressed={on} data-testid={`timeline-track-toggle-${label.toLowerCase().replace(/[^a-z]+/gu, '-')}`}
  className={`relative rounded p-1 transition disabled:opacity-25 ${
    on ? 'text-warning hover:bg-warning/10' : 'text-faint hover:bg-tint-strong hover:text-soft'}`}>
  {children}
  {mixed && <span aria-hidden className='absolute right-0.5 top-0.5 h-1 w-1 rounded-full bg-warning' />}
</button>;

export const EditTimelineTrackHeader = memo(function EditTimelineTrackHeader({ track, count,
  hidden, locked, muted, disabled, compact = false, onToggleHidden, onToggleLocked, onToggleMuted }: {
  track: TimelineTrack; count: number;
  /** Phones: name only. Track hide/mute/lock stay on the desktop editor. */
  compact?: boolean;
  hidden: TrackToggleState; locked: TrackToggleState; muted: TrackToggleState;
  disabled: boolean;
  onToggleHidden: () => void; onToggleLocked: () => void; onToggleMuted: () => void;
}) {
  const empty = count === 0;
  if (compact) return <div data-testid={`timeline-track-header-${track.id}`}
    data-hidden={hidden} data-locked={locked} data-muted={muted} title={track.label}
    className='flex items-center gap-1 border-b border-border px-1.5 last:border-0'
    style={{ height: `${track.heightPx}px` }}>
    <span aria-hidden className={`h-5 w-1 shrink-0 rounded-full ${track.chip} ${empty ? 'opacity-25' : 'opacity-80'}`} />
    <span className='min-w-0 truncate text-[10px] font-medium text-soft'>{track.label}</span>
  </div>;
  return <div data-testid={`timeline-track-header-${track.id}`}
    data-hidden={hidden} data-locked={locked} data-muted={muted}
    className='flex items-center gap-1.5 border-b border-border px-2 last:border-0'
    style={{ height: `${track.heightPx}px` }}>
    <span aria-hidden className={`h-6 w-1 shrink-0 rounded-full ${track.chip} ${empty ? 'opacity-25' : 'opacity-80'}`} />
    <span className='min-w-0 flex-1'>
      <span className='block truncate text-[11px] font-medium text-soft'>{track.label}</span>
      <span className='block text-[9px] tabular-nums text-faint'>
        {empty ? 'empty' : `${count} item${count === 1 ? '' : 's'}`}</span>
    </span>
    <span className='flex shrink-0 items-center'>
      {track.canHide && <Toggle label={`Hide ${track.label}`} on={active(hidden)}
        mixed={hidden === 'MIXED'} disabled={disabled || empty} onClick={onToggleHidden}
        hint={hidden === 'ALL' ? `${track.label} is hidden — click to show`
          : `Hide ${track.label} (still stored, just not shown or exported)`}>
        {active(hidden) ? <EyeOff size={13} /> : <Eye size={13} />}</Toggle>}
      {track.canMute && <Toggle label={`Mute ${track.label}`} on={active(muted)}
        mixed={muted === 'MIXED'} disabled={disabled || empty} onClick={onToggleMuted}
        hint={muted === 'ALL' ? `${track.label} is muted — click to unmute` : `Mute ${track.label}`}>
        {active(muted) ? <VolumeX size={13} /> : <Volume2 size={13} />}</Toggle>}
      <Toggle label={`Lock ${track.label}`} on={active(locked)} mixed={locked === 'MIXED'}
        disabled={disabled || empty} onClick={onToggleLocked}
        hint={locked === 'ALL' ? `${track.label} is locked — click to unlock`
          : `Lock ${track.label} so it cannot be dragged, trimmed or deleted here`}>
        {active(locked) ? <Lock size={13} /> : <LockOpen size={13} />}</Toggle>
    </span>
  </div>;
});
