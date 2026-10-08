export const STYLE_TWO_ID: 'AUTOMATIC_3_STYLE_TWO';
export const STYLE_TWO: {
  canvas: { width: number; height: number };
  reference: { width: number; height: number; media: Box };
  media: Box; hook: Box; captions: Box;
  hookFont: string; captionFont: string; hookSize: number; captionSize: number;
  hookLineHeight: number; captionLineHeight: number; background: string; red: string;
  paddingX: number; paddingY: number; radius: number; edge: string; edgeWidth: number; textStroke: number;
  shadow: { color: string; opacity: number; blur: number; offsetX: number; offsetY: number };
};
export type Box = { x: number; y: number; width: number; height: number };
export type PathCommand = [string, ...number[]];
export function normalized(box: Box): Box;
export function fontRole(family: string): 'hook' | 'caption' | null;
export function usesStyleTwoVectors(style: { fontFamily: string; fontWeight?: number; color: string;
  activeWord?: { enabled: boolean }; textRuns?: Array<{ color: string }> }): boolean;
export function styleTwoText(input: Box & { content: string; fontFamily: string; fontSize: number;
  uppercase?: boolean; textAlign?: 'left' | 'center' | 'right'; letterSpacing?: number; lineHeight?: number; boxed?: boolean; padding?: number; radius?: number; scale: number }): {
  size: number; lines: string[]; paths: PathCommand[][];
  fallback: Array<{ text: string; x: number; y: number; size: number }>;
  plate: Box & { radius: number }; overflow: boolean; truncated: boolean;
} | null;
export function svgPath(commands: PathCommand[]): string;
export function assPath(commands: PathCommand[]): string;
export function roundedRect(box: Box & { radius: number }): PathCommand[];
