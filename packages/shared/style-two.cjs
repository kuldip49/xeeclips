// StyleTwo's measured composition and deterministic font outlines. Shared by the
// browser and ASS export; does not select clips or make camera/zoom decisions.
const fonts = require('./style-two-glyphs.json');
const STYLE_TWO_ID = 'AUTOMATIC_3_STYLE_TWO';
const STYLE_TWO = {
  canvas: { width: 1080, height: 1920 },
  // Decoded reference edges: y=419..992 inclusive. Codec-safe rounding differs
  // by at most 1.33 reference pixels; the geometry stays fixed across all shots.
  reference: { width: 720, height: 1280, media: { x: 0, y: 419, width: 720, height: 574 } },
  media: { x: 0, y: 630, width: 1080, height: 860 },
  hook: { x: 36, y: 285, width: 1008, height: 315 },
  captions: { x: 36, y: 1275, width: 1008, height: 192 },
  hookFont: 'Roboto Condensed, sans-serif', captionFont: 'Anton, sans-serif',
  hookSize: 44.5, captionSize: 52.5, hookLineHeight: 69 / 53.4,
  captionLineHeight: 1.05, background: '#FFFFFF', red: '#B0321B',
  paddingX: 15, paddingY: 50 / 3, radius: 15,
  edge: '#522018', edgeWidth: 0.8, textStroke: 0.8,
  shadow: { color: '#000000', opacity: 0.8, blur: 0, offsetX: 1, offsetY: 2 }
};
const normalized = box => ({ x: box.x / 1080, y: box.y / 1920,
  width: box.width / 1080, height: box.height / 1920 });
const fontRole = family => family === STYLE_TWO.hookFont ? 'hook'
  : family === STYLE_TWO.captionFont ? 'caption' : null;
// Explicit word emphasis and weight overrides continue through the existing
// editable text renderer. The fixed outlines represent the initial template.
const usesStyleTwoVectors = style => Boolean(fontRole(style.fontFamily)) &&
  (style.fontWeight === undefined || style.fontWeight === (fontRole(style.fontFamily) === 'hook' ? 700 : 400)) && !style.activeWord?.enabled &&
  !(style.textRuns || []).some(run => run.color.toLowerCase() !== style.color.toLowerCase());
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const chars = text => Array.from(graphemes.segment(text.normalize('NFC')), item => item.segment);
function width(text, role, size, spacing = 0) {
  return chars(text).reduce((n, c, i) => n + (fonts[role].glyphs[c]?.advance ?? 1) * size + (i ? spacing : 0), 0);
}
function wrap(text, role, size, maxWidth, spacing = 0) {
  return text.split(/\r?\n/u).flatMap(paragraph => {
    const words = paragraph.trim().split(/\s+/u).filter(Boolean);
    const lines = []; let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && width(next, role, size, spacing) > maxWidth) { lines.push(line); line = word; }
      else line = next;
    }
    if (line) lines.push(line);
    return lines;
  });
}
/** Returns current wording only. It never writes/regenerates captions. */
function styleTwoText(input) {
  const role = fontRole(input.fontFamily);
  if (!role) return null;
  const text = input.uppercase ? input.content.toUpperCase() : input.content;
  const spacing = input.letterSpacing || 0;
  const maxLines = role === 'hook' ? 3 : 2;
  const lineHeight = input.lineHeight || (role === 'hook' ? STYLE_TWO.hookLineHeight : STYLE_TWO.captionLineHeight);
  const padX = input.boxed ? (input.padding ?? STYLE_TWO.paddingX) * input.scale : 0;
  const padY = input.boxed ? (input.padding ?? STYLE_TWO.paddingX) * 10 / 9 * input.scale : 0;
  let size = input.fontSize;
  let lines = wrap(text, role, size, input.width - padX * 2, spacing);
  const minimum = Math.min(size, (role === 'hook' ? 28 : 24) * input.scale);
  while (size > minimum && (lines.length > maxLines ||
    lines.some(line => width(line, role, size, spacing) > input.width - padX * 2) ||
    ((lines.length - 1) * size * lineHeight + fonts[role].cap * size + padY * 2 > input.height))) {
    size = Math.max(minimum, size - input.scale);
    lines = wrap(text, role, size, input.width - padX * 2, spacing);
  }
  // Keep canonical wording editable, but a headline beyond the bounded minimum
  // displays an ellipsis instead of painting outside its three-line safe area.
  const truncated = role === 'hook' && (lines.length > maxLines ||
    lines.some(line => width(line, role, size, spacing) > input.width));
  if (truncated) {
    lines = lines.slice(0, maxLines);
    let last = chars(lines[lines.length - 1] || '').slice(0, -1).join('');
    while (last && width(`${last}…`, role, size, spacing) > input.width) last = chars(last).slice(0, -1).join('');
    lines[lines.length - 1] = `${last.trimEnd()}…`;
  }
  const cap = fonts[role].cap * size;
  const pitch = size * lineHeight;
  const inkHeight = Math.max(0, (lines.length - 1) * pitch + cap);
  const firstBaseline = input.y + (input.height - inkHeight) / 2 + cap;
  const widest = Math.max(0, ...lines.map(line => width(line, role, size, spacing)));
  const lineX = lineWidth => input.x + (input.textAlign === 'left' ? padX :
    input.textAlign === 'right' ? input.width - lineWidth - padX : (input.width - lineWidth) / 2);
  const plate = { x: lineX(widest) - padX,
    y: input.y + (input.height - inkHeight) / 2 - padY,
    width: widest + 2 * padX, height: inkHeight + 2 * padY,
    radius: Math.min((input.radius ?? STYLE_TWO.radius) * input.scale, (inkHeight + 2 * padY) / 2) };
  const paths = [], fallback = [];
  lines.forEach((line, row) => {
    let x = lineX(width(line, role, size, spacing));
    const y = firstBaseline + row * pitch;
    for (const c of chars(line)) {
      const glyph = fonts[role].glyphs[c];
      if (glyph) {
        const commands = glyph.path.map(command => [command[0], ...command.slice(1).map((n, i) =>
          Number((n * size + (i % 2 === 0 ? x : y)).toFixed(3)))]);
        if (commands.length) paths.push(commands);
      } else fallback.push({ text: c, x, y, size });
      x += (glyph?.advance ?? 1) * size + spacing;
    }
  });
  return { size, lines, paths, fallback, plate, truncated, overflow: lines.length > maxLines ||
    widest + 2 * padX > input.width + .1 || inkHeight + 2 * padY > input.height + .1 };
}
const svgPath = commands => commands.map(([kind, ...v]) =>
  `${({ m: 'M', l: 'L', b: 'C', c: 'Z' })[kind]}${v.join(' ')}`).join(' ');
const assPath = commands => commands.filter(command => command[0] !== 'c').map(([kind, ...v]) =>
  `${kind} ${v.map(n => Number(n.toFixed(2))).join(' ')}`).join(' ');
function roundedRect({ x, y, width: w, height: h, radius: r }) {
  const k = .55228475 * r;
  return [['m', x+r,y],['l',x+w-r,y],['b',x+w-r+k,y,x+w,y+r-k,x+w,y+r],
    ['l',x+w,y+h-r],['b',x+w,y+h-r+k,x+w-r+k,y+h,x+w-r,y+h],
    ['l',x+r,y+h],['b',x+r-k,y+h,x,y+h-r+k,x,y+h-r],
    ['l',x,y+r],['b',x,y+r-k,x+r-k,y,x+r,y],['c']];
}
module.exports = { STYLE_TWO_ID, STYLE_TWO, normalized, fontRole, usesStyleTwoVectors, styleTwoText, svgPath, assPath, roundedRect };
