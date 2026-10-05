import type { EditPlan } from './edit-plan';

/** Template id of the "Raw" look. */
export const AUTOMATIC_RAW = 'AUTOMATIC_RAW';

/**
 * "Raw" is the Automatic 1 edit with every presentation layer removed. Everything that decides
 * WHAT is shown and HOW it is framed stays exactly as Automatic 1 plans it: clip selection,
 * clean start/end boundaries, trims and silence removal, vertical framing that follows the
 * active speaker, and the zoom in/out moves. What is dropped is everything drawn or mixed on
 * top: the on-screen hook, captions, word highlights, on-screen text, music, sound effects and
 * the colour grade. The source audio is kept as-is (normalized as usual).
 *
 * Framing is Automatic 1's: the video sits in the middle of the 9:16 canvas (on-screen
 * information kept whole, the speaker followed inside the frame), but the surround is a plain
 * dark colour - no blurred or tinted copy of the footage behind it.
 */
export function rawEditPlan(plan: EditPlan): EditPlan {
  return {
    ...plan,
    hookRequired: false,
    onScreenHook: { ...plan.onScreenHook, enabled: false, text: '' },
    onScreenText: [],
    subtitleStyle: { ...plan.subtitleStyle, enabled: false, highlightCurrentWord: false },
    subtitleEmphasis: [],
    operations: plan.operations.filter((operation) => operation.type !== 'WORD_HIGHLIGHT'),
    retentionMoments: plan.retentionMoments.filter((moment) =>
      moment.action !== 'TEXT_EMPHASIS' && moment.action !== 'SUBTITLE_EMPHASIS'),
    musicMood: 'NONE',
    gradePreset: 'NO_CHANGE',
    backgroundMode: 'DARK_NEUTRAL'
  };
}
