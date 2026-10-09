import { STYLE_TWO, styleTwoText } from '@ai-content-platform/shared/style-two.cjs';
import { fitHookText } from '../editing/text-layout';

/** Headline zone StyleZero fits into (design units of the 1080-wide canvas). */
const STYLE_ZERO_ZONE = { x: 0, y: 0, width: 930, height: 345 };
const STYLE_TWO_SCALE = 1.8;

/**
 * Whether a headline fits the vertical templates WITHOUT shortening it, using the real fitters
 * (wrapping, bounded font floors, the template's maximum line count). StyleTwo is the tightest template:
 * across a words x word-length sweep no headline failed StyleOne without also failing StyleTwo, so StyleTwo
 * plus StyleZero is a conservative proxy for all three. The template exports remain the authority.
 */
export function hookFitsTemplates(text: string) {
  const zero = fitHookText(text, STYLE_ZERO_ZONE) !== null;
  const two = styleTwoText({ ...STYLE_TWO.hook, content: text, fontFamily: STYLE_TWO.hookFont, fontSize: STYLE_TWO.hookSize * STYLE_TWO_SCALE,
    lineHeight: STYLE_TWO.hookLineHeight, scale: STYLE_TWO_SCALE });
  const fitsTwo = !!two && !two.overflow;
  return { styleZero: zero, styleTwo: fitsTwo, all: zero && fitsTwo };
}
