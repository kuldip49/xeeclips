/**
 * The automatic looks a request can name. Automatic 1 is the full automatic edit, Automatic 2
 * its editorial street3 style, and Raw the same edit (selection, start/end, speaker framing,
 * zoom) with nothing drawn or mixed on top: no captions, hook, text, music or grade.
 */
export const AUTOMATIC_LOOKS = ['AUTOMATIC_1', 'AUTOMATIC_2', 'AUTOMATIC_3_STYLE_TWO', 'AUTOMATIC_RAW'] as const;
export type AutomaticLook = typeof AUTOMATIC_LOOKS[number];

export const isAutomaticLook = (value: unknown): value is AutomaticLook =>
  typeof value === 'string' && (AUTOMATIC_LOOKS as readonly string[]).includes(value);

export const RAW_LOOK = {
  value: 'AUTOMATIC_RAW' as const, title: 'No Edit',
  description: 'Minimal editing. Keep the selected moment without automatic styling.'
};
