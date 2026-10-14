import { copyFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { prepareStyleTwoFonts } from './style-two-fonts';

/** Canonical headlines use exactly the face shipped to the browser preview. */
export async function prepareEditorFonts(directory: string, styleTwo: boolean) {
  const relative = styleTwo ? await prepareStyleTwoFonts(directory) : 'edit-mode-fonts';
  const target = join(directory, relative);
  await mkdir(target, { recursive: true });
  const shared = dirname(require.resolve('@ai-content-platform/shared/style-two.cjs'));
  await copyFile(join(shared, 'assets/fonts/XeeClipInterDisplay.ttf'), join(target, 'XeeClipInterDisplay.ttf'));
  return relative;
}
