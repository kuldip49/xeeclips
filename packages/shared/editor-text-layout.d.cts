export const HEADLINE_FIT_MESSAGE: string;
export function fitsRegion(bounds: { x: number; y: number; width: number; height: number }, region: { x: number; y: number; width: number; height: number }): boolean;
export function textCanvasSize(aspectRatio?: string, sourceWidth?: number, sourceHeight?: number): { width: number; height: number };
export function normalizeText(value: unknown): string;
export function estimateTextWidth(text: string, fontSize: number): number;
export type WrapOptions = { widthScale?: number; balance?: boolean; glyphWidthEm?: number; letterSpacing?: number };
export function fontWidthOptions(family: string): WrapOptions;
export function wrapTokens(tokens: string[], fontSize: number, maxWidth: number, options?: WrapOptions): number[][];
export function measureTextLayout(input: { content: string; width: number; height: number; fontSizePx: number; fontFamily: string; lineHeight?: number; letterSpacing?: number; padding?: number }): {
  tokens: string[]; lines: number[][]; widths: number[]; lineHeight: number; blockHeight: number; allowedHeight: number; overflow: boolean;
};
