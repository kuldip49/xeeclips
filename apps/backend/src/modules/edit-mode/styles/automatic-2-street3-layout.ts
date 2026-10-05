/**
 * AUTOMATIC_2_STREET3_LAYOUT — the single canonical outer geometry of Automatic 2.
 *
 * Every number below was MEASURED from the reference file street3.mp4
 * (1080x1920, 60 fps, 34.17 s) by sampling frames at 0.2 / 3.4 / 8.5 / 17 / 25.6 /
 * 30.7 / 34 s and reading pixel rows/columns (see docs/automatic-2-street3.md):
 *
 *   media window   x 0..1080   y 610..1310   (700 px tall, edge to edge, identical
 *                                              in every frame and for every shot)
 *   hook ink       x 37..1031  y 485..579     two lines, centred, Garamond-class serif
 *                                              cap height 33 px, colour #D0D0D1
 *   support ink    x 167..893  y 1324..1447   two lines, centred, cap height ~45 px
 *   emphasis       amber #A7761A, deep red #801B2E (two words in the hook)
 *   background     #000000
 *
 * Browser preview, the persisted EditProject layout and the FFmpeg export all
 * consume the ResolvedVisualLayout produced from this structure. Nothing may
 * re-derive these numbers.
 */
export const STREET3_CANVAS = { width: 1080, height: 1920 } as const;

const px = (value: number, axis: 'x' | 'y') =>
  value / (axis === 'x' ? STREET3_CANVAS.width : STREET3_CANVAS.height);

/** Pixel geometry as measured. Normalised rects below are derived from these. */
export const STREET3_MEASURED_PX = {
  media: { x: 0, y: 610, width: 1080, height: 700 },
  hookBox: { x: 27, y: 470, width: 1026, height: 124 },
  supportBox: { x: 140, y: 1306, width: 800, height: 150 },
  /** Caption band: bottom of the media window, anchored to it (the reference has
   * no burned captions; Automatic 2's lime active-word captions live inside the
   * media region, never outside it). */
  captionBox: { x: 86, y: 1090, width: 908, height: 196 }
} as const;

const rect = (box: { x: number; y: number; width: number; height: number }) => ({
  x: px(box.x, 'x'), y: px(box.y, 'y'), width: px(box.width, 'x'), height: px(box.height, 'y')
});

export const AUTOMATIC_2_STREET3_LAYOUT = {
  canvas: { ...STREET3_CANVAS, aspect: '9:16' as const },
  mediaBox: rect(STREET3_MEASURED_PX.media),
  hookBox: rect(STREET3_MEASURED_PX.hookBox),
  supportingTextBox: rect(STREET3_MEASURED_PX.supportBox),
  captionSafeBox: rect(STREET3_MEASURED_PX.captionBox),
  /** Font sizes are in the editor's 600-wide design units (px = units * 1080 / 600). */
  typography: {
    fontFamily: 'EB Garamond, serif',
    hook: { fontSize: 26, lineHeight: 1.14, maxLines: 2 as const, fontWeight: 400 },
    support: { fontSize: 35, lineHeight: 1.14, maxLines: 2 as const, fontWeight: 400 },
    captions: { fontSize: 36, lineHeight: 1.16, maxLines: 2 as const },
    /** Average advance of the serif in em, used by the deterministic fitter. The
     * reference face measures ~0.41 em/char, EB Garamond measures 0.383 em/char in Chrome; 0.40 keeps a margin. */
    glyphWidthEm: 0.4
  },
  colors: {
    background: '#000000',
    text: '#D0D0D1',
    /** Automatic 2 hook: white text; its highlighted words in one red (~5:1 on black). */
    hookText: '#FFFFFF',
    hookHighlight: '#E53935',
    emphasis: ['#A7761A', '#801B2E'] as const,
    captionBase: '#FFFFFF',
    captionActive: '#B7F000'
  }
} as const;
