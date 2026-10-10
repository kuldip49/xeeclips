import { STYLE_TWO, styleTwoText } from '@ai-content-platform/shared/style-two.cjs';
import { fitHookText } from '../editing/text-layout';
import { autoFitText } from '../edit-mode/styles/resolved-visual-layout';
import { AUTOMATIC_2_STREET3_LAYOUT as STREET3 } from '../edit-mode/styles/automatic-2-street3-layout';

/** Headline zone StyleZero fits into (design units of the 1080-wide canvas). */
const STYLE_ZERO_ZONE = { x: 0, y: 0, width: 930, height: 345 };
const STYLE_TWO_SCALE = 1.8;

/**
 * Whether a headline fits the vertical templates WITHOUT shortening it, using the real fitters
 * (wrapping, bounded font floors, the template's maximum line count). All three are checked explicitly.
 * The template exports remain the authority.
 */
export function hookFitsTemplates(text: string) {
  const zero = fitHookText(text, STYLE_ZERO_ZONE) !== null;
  const two = styleTwoText({ ...STYLE_TWO.hook, content: text, fontFamily: STYLE_TWO.hookFont, fontSize: STYLE_TWO.hookSize * STYLE_TWO_SCALE,
    lineHeight: STYLE_TWO.hookLineHeight, scale: STYLE_TWO_SCALE });
  const fitsTwo = !!two && !two.overflow;
  const font = autoFitText(text, { ...STREET3.hookBox, maxLines: text.split(/\s+/u).length > 14 ? 3 : 2,
    preferred: STREET3.typography.hook.fontSize, minimum: 20, lineHeight: STREET3.typography.hook.lineHeight,
    glyphWidthEm: STREET3.typography.glyphWidthEm });
  // Verify the fitted size in the actual measured StyleOne box, including the height constraint.
  const capacity = STREET3.hookBox.width * 600 / (font * STREET3.typography.glyphWidthEm);
  let lines = 1, used = 0, wide = false;
  for (const word of text.trim().split(/\s+/u)) {
    if (word.length > capacity) wide = true;
    if (used && used + 1 + word.length > capacity) { lines++; used = word.length; }
    else used += (used ? 1 : 0) + word.length;
  }
  const one = !wide && lines <= (text.split(/\s+/u).length > 14 ? 3 : 2)
    && lines * font * STREET3.typography.hook.lineHeight * 1.8 <= STREET3.hookBox.height * 1920;
  return { styleZero: zero, styleOne: one, styleTwo: fitsTwo, all: zero && one && fitsTwo };
}
