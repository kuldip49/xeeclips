import { copyFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';

/** Relative to the render's working directory, where the ASS file is written. */
export const STYLE_TWO_FONTS_DIR = 'style-two-fonts';

/**
 * Copies the licensed Anton / Roboto Condensed files beside the ASS file. StyleTwo text is drawn from vector
 * outlines, but explicit manual emphasis/weight edits use libass' native text and need these faces on hosts that
 * have no system fonts. Shared by the editor export and the Quick Reframe composition.
 */
export async function prepareStyleTwoFonts(directory: string) {
  await mkdir(join(directory, STYLE_TWO_FONTS_DIR), { recursive: true });
  const bundled = join(dirname(require.resolve('@ai-content-platform/shared/style-two.cjs')), 'assets', 'fonts');
  for (const font of ['Anton-Regular.ttf', 'RobotoCondensed-Bold.ttf']) {
    await copyFile(join(bundled, font), join(directory, STYLE_TWO_FONTS_DIR, font));
  }
  return STYLE_TWO_FONTS_DIR;
}
