import { useId } from 'react';
import { STYLE_TWO, styleTwoText, svgPath, roundedRect } from '@ai-content-platform/shared/style-two.cjs';
import { readTextStyle } from '@/lib/edit-mode-text';
import type { EditElement } from '@/lib/edit-mode-types';

/** Same glyph outlines, fitter, line pitch and rounded path as StyleTwo ASS. */
export function StyleTwoPreviewText({ element }: { element: Pick<EditElement, 'properties'> }) {
  const id = useId().replace(/:/gu, '');
  const p = element.properties, style = readTextStyle(p);
  const width = Number(p.width) * 1080, height = Number(p.height) * 1920;
  const layout = styleTwoText({ x: 0, y: 0, width, height,
    content: String(p.content ?? ''), fontFamily: style.fontFamily, fontSize: style.fontSize * 1.8,
    uppercase: style.uppercase, textAlign: style.textAlign, lineHeight: style.lineSpacing,
    letterSpacing: style.letterSpacing * 1.8, boxed: style.background.enabled,
    padding: style.background.padding, radius: style.background.radius, scale: 1.8 });
  if (!layout || !layout.lines.length) return null;
  const paths = layout.paths.map(svgPath).join(' ');
  const shadow = style.shadow;
  const filter = shadow.blur > 0 ? `url(#style-two-${id})` : undefined;
  const shadowPath = (d: string) => shadow.enabled ? <path d={d} fill={shadow.color}
    opacity={shadow.opacity} transform={`translate(${shadow.offsetX * 1.8} ${shadow.offsetY * 1.8})`}
    filter={filter} /> : null;
  return <svg data-testid='style-two-text' viewBox={`0 0 ${width} ${height}`} width='100%' height='100%'
    style={{ overflow: 'visible' }} aria-label={String(p.content ?? '')}>
    <defs><filter id={`style-two-${id}`} x='-50%' y='-50%' width='200%' height='200%'>
      <feGaussianBlur stdDeviation={shadow.blur * .9} />
    </filter></defs>
    {style.background.enabled && shadowPath(svgPath(roundedRect(layout.plate)))}
    {style.background.enabled && <path d={svgPath(roundedRect(layout.plate))}
      fill={style.background.color} fillOpacity={style.background.opacity}
      stroke={STYLE_TWO.edge} strokeOpacity={style.background.opacity} strokeWidth={STYLE_TWO.edgeWidth * 3.6} paintOrder='stroke fill' />}
    {shadowPath(paths)}
    <path d={paths} fill={style.color} stroke={style.stroke.enabled ? style.stroke.color : 'none'}
      strokeWidth={style.stroke.enabled ? style.stroke.width * 3.6 : 0}
      paintOrder='stroke fill' />
    {layout.fallback.map((g, i) => <text key={i} x={g.x} y={g.y} fontSize={g.size}
      fontFamily={style.fontFamily} fill={style.color}>{g.text}</text>)}
  </svg>;
}
