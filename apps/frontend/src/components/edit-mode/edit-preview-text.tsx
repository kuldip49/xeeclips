'use client';

import { memo } from 'react';
import { activeWordIndex, canHighlightWords, readCaptionWords, readTextRuns, readTextStyle,
  textStyleCss } from '@/lib/edit-mode-text';
import type { EditElement } from '@/lib/edit-mode-types';

/**
 * One TEXT or SUBTITLE element, drawn the way it will export.
 *
 * The plate is applied to the INLINE run rather than the element box, with
 * `box-decoration-break: clone`, because that is what libass does in
 * BorderStyle 3: the plate hugs each line of text, it is not a rectangle behind
 * the whole element. Matching that here is what makes a caption's plate the same
 * shape in the preview and in the MP4.
 *
 * The active-word highlight is drawn only when `canHighlightWords` says the
 * stored word timings line up with the stored wording, which is the same test
 * `assSpans` applies on the renderer. Word-level animation is never faked.
 */
export const EditPreviewText = memo(function EditPreviewText({ element, offsetSec,
  canvasWidth }: {
  element: EditElement;
  /** Seconds into this element at the current playhead. */
  offsetSec: number;
  /** The measured canvas width in pixels - the same number the renderer calls
   * `canvas.width`, so type is sized by the renderer's own formula. */
  canvasWidth: number;
}) {
  const properties = element.properties;
  const style = readTextStyle(properties);
  const css = textStyleCss(properties, canvasWidth);
  const { textAlign, ...run } = css;
  const content = String(properties.content ?? '');
  const highlight = canHighlightWords(properties);
  const words = highlight ? readCaptionWords(properties) : [];
  const active = highlight ? activeWordIndex(words, offsetSec) : -1;
  const textRuns = readTextRuns(properties);

  return <div className='flex h-full w-full items-center'>
    {/* The block's own strut must match the text, or an inherited 24px line box inflates the
        line pitch (visible with the tight editorial serif). */}
    <div className='w-full' style={{ textAlign, ...(style.fontFamily === 'EB Garamond, serif'
      ? { lineHeight: css.lineHeight, fontSize: css.fontSize } : {}) }}>
      <span style={{ ...run, display: 'inline',
        WebkitBoxDecorationBreak: 'clone', boxDecorationBreak: 'clone' }}>
        {highlight
          ? words.map((word, index) => <span key={`${index}-${word.start}`}
            style={index === active ? { color: style.activeWord.color } : undefined}>
            {index === 0 ? '' : ' '}{word.text}</span>)
          : textRuns.length ? textRuns.map((item, index) =>
            <span key={`${index}-${item.text}`} style={{ color: item.color }}>{item.text}</span>) : content}
      </span>
    </div>
  </div>;
});
