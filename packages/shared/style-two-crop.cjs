'use strict';

const { STYLE_TWO } = require('./style-two.cjs');

/** Source geometry, in pixels, before the existing camera/zoom composition.
 * Normalized saved insets are converted exactly once, by both consumers here.
 * Geometry runs in 4:4:4: round to the nearest integer (ties up), with integer
 * padding biased toward the top/left. Only the final encoder needs 4:2:0.
 * Quick Reframe's baked source is the input; its confirmed crop is never read.
 */
function styleTwoCropTransform(width, height, properties) {
  const crop = properties.crop || {};
  const inset = edge => Math.max(0, Number(crop[edge]) || 0);
  if (!['left', 'right', 'top', 'bottom'].some(edge => inset(edge) > 0)) return null;
  const w = Math.max(2, Math.round(width)), h = Math.max(2, Math.round(height));
  const cw = Math.max(2, Math.min(w, Math.round(w * (1 - inset('left') - inset('right')))));
  const ch = Math.max(2, Math.min(h, Math.round(h * (1 - inset('top') - inset('bottom')))));
  const rect = { x: Math.max(0, Math.min(w - cw, Math.round(w * inset('left')))),
    y: Math.max(0, Math.min(h - ch, Math.round(h * inset('top')))), width: cw, height: ch };
  const fit = Math.min(w / cw, h / ch);
  const fw = Math.round(cw * fit), fh = Math.round(ch * fit);
  const fitted = { x: Math.floor((w - fw) / 2), y: Math.floor((h - fh) / 2), width: fw, height: fh };
  const scale = Number(properties.scale) || 1;
  const sw = Math.max(2, Math.round(w * scale)), sh = Math.max(2, Math.round(h * scale));
  const position = (source, scaled, offset) => scale >= 1
    ? -Math.max(0, Math.min(scaled - source, Math.round((scaled - source) / 2 - offset * source)))
    : Math.max(0, Math.min(source - scaled, Math.round((source - scaled) / 2 + offset * source)));
  return { source: { width: w, height: h }, rect, fitted,
    scaled: { width: sw, height: sh,
      x: position(w, sw, Number(properties.offsetX) || 0) || 0,
      y: position(h, sh, Number(properties.offsetY) || 0) || 0 },
    rotation: Number(properties.rotation) || 0, flipH: properties.flipH === true, flipV: properties.flipV === true,
    target: { ...STYLE_TWO.media },
    // Useful for diagnostics; axis scales differ only by explicit integer raster rounding.
    sourceScale: { x: fw / cw * sw / w, y: fh / ch * sh / h } };
}

function styleTwoCropFilter(t) {
  const { source: s, rect: r, fitted: f, scaled: z } = t;
  const filters = ['format=yuv444p', `crop=${r.width}:${r.height}:${r.x}:${r.y}:exact=1`];
  if (t.flipH) filters.push('hflip');
  if (t.flipV) filters.push('vflip');
  if (t.rotation) filters.push(`rotate=${(t.rotation * Math.PI / 180).toFixed(6)}:ow=iw:oh=ih:c=black`);
  filters.push(`scale=${f.width}:${f.height}`, `pad=${s.width}:${s.height}:${f.x}:${f.y}:black`, 'setsar=1');
  if (z.width !== s.width || z.height !== s.height || z.x || z.y) {
    filters.push(`scale=${z.width}:${z.height}`);
    filters.push(z.width >= s.width && z.height >= s.height
      ? `crop=${s.width}:${s.height}:${-z.x}:${-z.y}:exact=1`
      : `pad=${s.width}:${s.height}:${z.x}:${z.y}:black`);
    filters.push('setsar=1');
  }
  return filters.join(',');
}

/** Emulate the existing fill camera's integer raster without changing its
 * planned focal point. The manual source stage uses 4:4:4, so no even offsets. */
function styleTwoCropCamera(camera, geometry) {
  const {source:s,target:t}=geometry;
  const scale=Math.max(t.width/s.width,t.height/s.height);
  const w=Math.round(s.width*scale),h=Math.round(s.height*scale);
  return { ...camera,
    x:Math.max(0,Math.min(w-t.width,Math.round(camera.x*w)))/w,
    y:Math.max(0,Math.min(h-t.height,Math.round(camera.y*h)))/h,
    w:t.width/w,h:t.height/h };
}

function styleTwoCropCameraFilter(filter) {
  return filter.replace(/:([xy])='([^']+)'/g, (_,axis,expression)=>`:${axis}='round(${expression})'`);
}

/** The whole already-baked Quick Reframe source is fitted, never recropped.
 * Default overlay on a 4:2:0 frame aligns its offsets to the chroma grid. */
function styleTwoFitBox(width, height, chroma = 2, target = STYLE_TWO.media) {
  const t=target, scale=Math.min(t.width/width,t.height/height);
  const w=Math.round(width*scale),h=Math.round(height*scale);
  return {x:t.x+Math.floor((t.width-w)/2/chroma)*chroma,
    y:t.y+Math.floor((t.height-h)/2/chroma)*chroma,width:w,height:h};
}

function styleTwoBakedCropTransform(width, height, properties = {}) {
  const manual=styleTwoCropTransform(width,height,properties);
  const full={x:0,y:0,width,height};
  return {...(manual || {source:{width,height},rect:{...full},fitted:{...full},scaled:{...full},
    rotation:0,flipH:false,flipV:false,target:{...STYLE_TWO.media},sourceScale:{x:1,y:1}}),
    picture:styleTwoFitBox(width,height,manual?1:2)};
}

module.exports = { styleTwoCropTransform, styleTwoCropFilter, styleTwoCropCamera, styleTwoCropCameraFilter,
  styleTwoFitBox,styleTwoBakedCropTransform };
