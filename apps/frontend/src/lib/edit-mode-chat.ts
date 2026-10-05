// Workstream G: the pure half of the AI editor panel.
//
// Everything the panel decides without a network call lives here, so it can be
// exercised offline: how the current selection is named ("the AI sees: Hook"),
// how a before -> after line reads, and what the "Change" button does for a
// given proposal. The component only renders what these return.

import type { ChatChange, ChatProposal, EditElement, EditTimeRange } from './edit-mode-types';

/** What the user would call the selected element. Mirrors the server's roles. */
export function selectionName(element: EditElement | undefined | null): string | null {
  if (!element) return null;
  const props = element.properties as Record<string, unknown>;
  const text = typeof props.content === 'string' ? props.content.trim() : '';
  const quoted = text ? ` "${text.length > 28 ? `${text.slice(0, 27)}…` : text}"` : '';
  if (element.type === 'TEXT') {
    const role = [props.templateRole, props.presetRole].find((value) =>
      value === 'HOOK' || value === 'CTA');
    if (role === 'HOOK') return `Hook${quoted}`;
    if (role === 'CTA') return `Call to action${quoted}`;
    return `Text${quoted}`;
  }
  if (element.type === 'SUBTITLE') return `Caption${quoted}`;
  if (element.type === 'IMAGE') return props.role === 'LOGO' ? 'Logo' : 'Image';
  if (element.type === 'AUDIO') return 'Music';
  if (element.type === 'EFFECT') return 'Zoom';
  return 'Video segment';
}

/** One line telling the user what "this", "here" and "it" will mean. */
export function contextLine(input: { selected?: EditElement | null;
  range: EditTimeRange | null; playheadSec: number }): string {
  const parts: string[] = [];
  const name = selectionName(input.selected);
  if (name) parts.push(name);
  if (input.range) {
    parts.push(`${input.range.startSec.toFixed(1)}s–${input.range.endSec.toFixed(1)}s selected`);
  }
  parts.push(`playhead ${input.playheadSec.toFixed(1)}s`);
  return parts.join(' · ');
}

/** A change reads as "Current -> Proposed" pairs; wording is shown in full. */
export function changeRows(proposal: Pick<ChatProposal, 'changes' | 'plannedChanges'>):
  Array<ChatChange & { wording: boolean }> {
  return (proposal.changes ?? []).map((change) => ({ ...change,
    wording: /^".*"$/su.test(change.before) || /^".*"$/su.test(change.after) }));
}

/**
 * What "Change" does.
 *
 * For written wording (a hook), Change asks for another version - the most
 * common thing a person wants when a suggestion is close but not right. For
 * everything else it hands the instruction back to the composer so it can be
 * reworded; the pending proposal is cancelled either way, so nothing stale can
 * be applied afterwards.
 */
export function changeAction(proposal: Pick<ChatProposal, 'route' | 'userMessage'>):
  { kind: 'ANOTHER'; message: string } | { kind: 'EDIT'; draft: string } {
  if (proposal.route === 'CREATIVE_LLM' || proposal.route === 'CREATIVE_DETERMINISTIC') {
    return { kind: 'ANOTHER', message: 'try another' };
  }
  return { kind: 'EDIT', draft: proposal.userMessage };
}

/** Openers that teach the panel's own vocabulary - everyday words, no jargon. */
export const CHAT_SUGGESTIONS = [
  'Change the hook',
  'Make the logo smaller',
  'Music is too loud',
  'Make captions bigger',
  'Make it warmer',
  'Zoom in here'
];
