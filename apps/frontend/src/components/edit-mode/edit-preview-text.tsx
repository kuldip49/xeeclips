'use client';

import { Fragment, memo } from 'react';
import { activeWordIndex, canHighlightWords, exportLines, readCaptionWords, readTextStyle,
  textStyleCss, wordColors } from '@/lib/edit-mode-text';
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
  // The export's own line breaks and per-word colours (runs), so both show identical lines.
  const { tokens, lines } = exportLines(properties);
  const colors = wordColors(properties).map((word) => word.color);

  return <div className='flex h-full w-full items-center'>
    {/* The block's own strut must match the text, or an inherited 24px line box inflates the
        line pitch (visible with the tight editorial serif). */}
    <div className='w-full' style={{ textAlign, ...(style.fontFamily === 'EB Garamond, serif'
      ? { lineHeight: css.lineHeight, fontSize: css.fontSize } : {}) }}>
      {/* nowrap: only the export's breaks (<br>) apply; the space before each break keeps the text
          readable as one sentence and is dropped at the line end, so it is never painted. */}
      <span style={{ ...run, display: 'inline', whiteSpace: 'nowrap',
        WebkitBoxDecorationBreak: 'clone', boxDecorationBreak: 'clone' }}>
        {lines.length ? lines.map((line, row) => <Fragment key={row}>{row > 0 && <>{' '}<br /></>}
          {line.map((at, position) => { const color = highlight && at === active ? style.activeWord.color : colors[at];
            return <span key={at} style={color && color !== style.color.toLowerCase() ? { color } : undefined}>{position ? ' ' : ''}{tokens[at]}</span>; })}
        </Fragment>) : content}
      </span>
    </div>
  </div>;
});
