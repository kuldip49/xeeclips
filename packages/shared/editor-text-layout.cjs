// Canonical EditMode text measurement. Browser preview and ASS compilation use
// the same tokens, pixel dimensions and fit decision; no layout is cached here.
const NARROW = new Set([...'iljtfrI!.,:;\'"|()[]']);
const WIDE = new Set([...'mwMW@%']);
const HEADLINE_FIT_MESSAGE = 'Headline is too large for this layout. Reduce the size, enlarge the text box, or shorten the text.';
function normalizeText(value) {
  return String(value).normalize('NFC').replace(/[\u2018\u2019\u02BC]/gu, "'")
    .replace(/[\u201C\u201D]/gu, '"').replace(/[\u2010-\u2015]/gu, '-')
    .replace(/[\u00A0\u202F]/gu, ' ').replace(/[\uFFFD\u200B-\u200D\u2060\uFEFF]/gu, '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, ' ').replace(/^\s*[*_`#]+|[*_`#]+\s*$/gu, '')
    .replace(/\s+/gu, ' ').trim();
}
function estimateTextWidth(text, fontSize) {
  let em=0;for(const char of text){if(char===' ')em+=.27;else if(NARROW.has(char))em+=.34;else if(WIDE.has(char))em+=.92;else if(/[A-Z0-9]/u.test(char))em+=.68;else em+=.6;}return em*fontSize*.8;
}
function fontWidthOptions(family) {
  return String(family).startsWith('EB Garamond') ? {widthScale:.8,balance:true,glyphWidthEm:.4} : {widthScale:1,balance:false,glyphWidthEm:0};
}
function tokenWidth(text,fontSize,options={}) {
  return Math.max(0,Math.max(estimateTextWidth(text,fontSize)*(options.widthScale??1),(options.glyphWidthEm??0)*fontSize*text.length)+(options.letterSpacing??0)*Math.max(0,[...text].length-1));
}
function wrapTokens(tokens,fontSize,maxWidth,options={}) {
  if(!tokens.length)return[];const width=text=>tokenWidth(text,fontSize,options),lines=[];let current=[],text='';
  for(let index=0;index<tokens.length;index++){const next=text?`${text} ${tokens[index]}`:tokens[index];if(current.length&&width(next)>maxWidth){lines.push(current);current=[index];text=tokens[index];}else{current.push(index);text=next;}}if(current.length)lines.push(current);
  if(options.balance&&lines.length===2&&tokens.length>3){let best=lines,widest=Math.max(...lines.map(line=>width(line.map(at=>tokens[at]).join(' '))));for(let cut=1;cut<tokens.length;cut++){const next=Math.max(width(tokens.slice(0,cut).join(' ')),width(tokens.slice(cut).join(' ')));if(next<=maxWidth&&next<widest-1e-6){widest=next;best=[Array.from({length:cut},(_,at)=>at),Array.from({length:tokens.length-cut},(_,at)=>cut+at)];}}return best;}return lines;
}
function measureTextLayout(input) {
  const tokens=normalizeText(input.content).split(' ').filter(Boolean),options={...fontWidthOptions(input.fontFamily),letterSpacing:input.letterSpacing??0};
  const padding=input.padding??0;
  const lines=wrapTokens(tokens,input.fontSizePx,Math.max(1,input.width-padding*2),options),widths=lines.map(line=>tokenWidth(line.map(at=>tokens[at]).join(' '),input.fontSizePx,options)+padding*2);
  const lineHeight=input.fontSizePx*(input.lineHeight??1.2),blockHeight=lines.length*lineHeight+padding*2;
  // Preserve the established libass glyph/line-box allowance. This is shared
  // with preview; enlarging a box changes the inputs, never the tolerance.
  const allowedHeight=input.height*1.35+1;
  return {tokens,lines,widths,lineHeight,blockHeight,allowedHeight,overflow:widths.some(w=>w>input.width+1)||blockHeight>allowedHeight};
}
function textCanvasSize(aspectRatio,sourceWidth=1920,sourceHeight=1080) {
  if(aspectRatio==='9:16')return{width:1080,height:1920};if(aspectRatio==='1:1')return{width:1080,height:1080};if(aspectRatio==='16:9')return{width:1920,height:1080};
  const width=sourceWidth>0?sourceWidth:1920,height=sourceHeight>0?sourceHeight:1080,scale=Math.min(1,1920/Math.max(width,height));
  return{width:Math.max(128,Math.round(width*scale/2)*2),height:Math.max(128,Math.round(height*scale/2)*2)};
}
/** The drawn headline must stay on its layout surface, not behind the media. */
function fitsRegion(bounds,region) {
  return bounds.x>=region.x-.1&&bounds.y>=region.y-.1&&
    bounds.x+bounds.width<=region.x+region.width+.1&&bounds.y+bounds.height<=region.y+region.height+.1;
}
module.exports={HEADLINE_FIT_MESSAGE,normalizeText,estimateTextWidth,fontWidthOptions,wrapTokens,measureTextLayout,textCanvasSize,fitsRegion};
