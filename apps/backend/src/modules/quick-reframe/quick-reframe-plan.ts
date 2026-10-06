import { BadRequestException } from '@nestjs/common';
import type { ReframeAnalysis, ReframeBox, ReframePlan, ReframePreparation, ReframeRegion } from '@ai-content-platform/shared';
import { EDIT_MODE_FONT_FAMILIES } from '../edit-mode/edit-mode-text';
import { AUTOMATIC_2_STREET3_LAYOUT as STYLEONE } from '../edit-mode/styles/automatic-2-street3-layout';
export type { ReframeAnalysis, ReframeBox, ReframePlan, ReframePreparation, ReframeRegion } from '@ai-content-platform/shared';
/** Preset ratios offered by the crop step; any other "W:H" the user types is accepted too. */
export const REFRAME_PRESET_RATIOS = ['9:16','16:9','1:1','4:5','5:4','3:4','4:3','2:3','3:2','21:9'] as const;
export const REFRAME_GRIDS = ['THIRDS','GRID3','GRID4','CROSSHAIR','GOLDEN','NONE'] as const;
const RATIO = /^(\d{1,4}(?:\.\d{1,3})?):(\d{1,4}(?:\.\d{1,3})?)$/u;
/** SOURCE (original ratio), CUSTOM (Free Crop), a positive "W:H" up to 1:20..20:1, or V2's STYLEONE window. */
export function isReframeAspect(v: unknown): v is ReframePlan['aspect'] {
  if (v==='SOURCE'||v==='CUSTOM'||v==='STYLEONE') return true;
  const m=typeof v==='string'?RATIO.exec(v):null; if(!m) return false;
  const r=Number(m[1])/Number(m[2]); return Number.isFinite(r) && r>=1/20 && r<=20;
}
/** Width/height of a fixed crop shape (null = not locked). STYLEONE is the fixed StyleOne media window (1080x700). */
export function aspectValue(aspect: ReframePlan['aspect'], sourceWidth?: number, sourceHeight?: number): number | null {
  if (aspect==='CUSTOM') return null;
  if (aspect==='SOURCE') return sourceWidth&&sourceHeight ? sourceWidth/sourceHeight : null;
  if (aspect==='STYLEONE') return STYLEONE.mediaBox.width*1080/(STYLEONE.mediaBox.height*1920);
  const [a,b]=aspect.split(':').map(Number); return a/b;
}
/** The smallest crop side that still encodes as a valid H.264 frame, in source pixels. */
export const MIN_CROP_PIXELS = 16;
/** The pixel-changing part of a plan. Confirming the crop bakes exactly this into SOURCE. */
export function preparationOf(p: ReframePlan): ReframePreparation {
  return {aspect:p.aspect,crop:p.crop,framing:p.framing,tracking:p.tracking,cleanup:p.cleanup,denoise:p.color.denoise};
}
/** Nothing to bake: the uploaded pixels already are the confirmed source. */
export function isIdentityPreparation(p: ReframePreparation) {
  return p.crop.x<=1e-4 && p.crop.y<=1e-4 && p.crop.w>=.9999 && p.crop.h>=.9999 && !p.tracking?.length && !p.cleanup.length && !p.denoise;
}
export const record = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
export const overlap = (a: ReframeBox, b: ReframeBox) => Math.max(0, Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)) * Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
export const contains = (a: ReframeBox, b: ReframeBox, pad = 0) => b.x-pad >= a.x-0.001 && b.y-pad >= a.y-0.001 && b.x+b.w+pad <= a.x+a.w+0.001 && b.y+b.h+pad <= a.y+a.h+0.001;
export function validBox(v: unknown): ReframeBox {
  const b = record(v); const result = { x: b.x, y: b.y, w: b.w, h: b.h };
  if (!Object.values(result).every(n => typeof n === 'number' && Number.isFinite(n)) || b.x < 0 || b.y < 0 || b.w < .02 || b.h < .02 || b.x+b.w > 1.00001 || b.y+b.h > 1.00001) throw new BadRequestException('The selected region must stay inside the video.');
  return result;
}
const box = (v: unknown): ReframeBox | null => { try { return validBox(v); } catch { return null; } };
export function analyzeRegions(raw: unknown, duration: number): ReframeAnalysis {
  const data = record(raw); const frames = (Array.isArray(data.frames) ? data.frames : []).map(record);
  const regions: ReframeRegion[] = [];
  for (let i=0;i<frames.length;i++) {
    const f = frames[i]; const start = Number(f.t) || 0; const end = Math.min(duration, Number(frames[i+1]?.t) || duration);
    // OCR boxes carry per-frame wording and score. Geometric text candidates remain UNKNOWN.
    for (const value of (f.ocr_boxes?.length ? f.ocr_boxes : f.text_boxes || [])) {
      const b = box(value); if (!b) continue;
      const r = record(value); const text = typeof r.text === 'string' ? r.text.slice(0,200) : '';
      const confidence = clamp(Number(r.confidence) || .35);
      const attribution = /(?:@|©|copyright|instagram|twitter|tiktok|watermark|\bcredit\b)/iu.test(text) || ((b.x < .12 || b.x+b.w > .88) && b.w < .25 && b.h < .12);
      const caption = !attribution && b.y >= .62 && b.w >= .22;
      // Headlines stacked above the picture (common on reposts) are decorative too, up to the top 40%.
      const decorative = !attribution && !caption && confidence >= .65 && (b.y < .2 || b.y + b.h < .4);
      const kind = attribution ? 'ATTRIBUTION' : caption ? 'CAPTION' : decorative ? 'DECORATIVE' : 'UNKNOWN';
      // Merge only adjacent, similar positions AND wording. Moving/changing text gets a new timed region.
      const prior = [...regions].reverse().find(r => r.kind===kind && r.text===text && Math.abs(r.end-start)<.15 && overlap(r,b) / Math.max(.001, b.w*b.h+r.w*r.h-overlap(r,b)) > .8);
      if (prior) { prior.end=end; prior.confidence=Math.min(prior.confidence,confidence); }
      else regions.push({ ...b, id:`region-${regions.length}`,start,end,text,confidence,kind });
    }
  }
  const ocrAvailable = !!data.runtime?.ocr;
  const subtitleState = subtitleStateOf(regions, frames.map(f=>Number(f.t)||0), ocrAvailable, null);
  const warnings: string[] = [];
  if (!data.runtime?.ocr) warnings.push('Text recognition is unavailable. Review detected regions and existing captions before adding new captions.');
  if (!data.runtime?.faceDetector && !data.runtime?.yolo) warnings.push('Subject detection is unavailable. Automatic framing keeps the full source.');
  const minBar = (key: string) => frames.length ? Math.min(...frames.map(f=>Number(f.bars?.[key])||0)) : 0;
  return { regions: regions.slice(0,600), frames: frames.map(f=>({t:Number(f.t)||0,
    faces:(f.faces||[]).map(box).filter(Boolean),persons:(f.persons||[]).map(box).filter(Boolean),
    information: (Number(f.text_coverage)>.15 || Number(f.edge_density)>.2) ? [{x:0,y:0,w:1,h:1}] : [] })),
    boundaries: (data.shot_boundaries||[]).filter((n:unknown)=>typeof n==='number'), subtitleState,warnings,
    appearance: frames.some(f=>Number.isFinite(f.brightness)) ? {brightness:frames.reduce((n,f)=>n+(Number(f.brightness)||0),0)/frames.length,contrast:frames.reduce((n,f)=>n+(Number(f.contrast)||0),0)/frames.length} : undefined,
    bars:{top:minBar('top'),bottom:minBar('bottom'),left:minBar('left'),right:minBar('right')}, ocrAvailable } as ReframeAnalysis;
}
/** Burned-in captions only count when (most of) the line is still inside the frame that is kept. */
function subtitleStateOf(regions: ReframeRegion[], times: number[], ocrAvailable: boolean, crop: ReframeBox | null): ReframeAnalysis['subtitleState'] {
  const kept = (r: ReframeRegion) => crop ? overlap(crop,r)/Math.max(.0001,r.w*r.h) : 1;
  const captions = regions.filter(r=>r.kind==='CAPTION' && kept(r)>=.6);
  // A line the crop cuts through is still visible in part: uncertain, never "no captions".
  const cut = regions.some(r=>r.kind==='CAPTION' && kept(r)>.05 && kept(r)<.6);
  const captionFrames = times.filter(t => captions.some(r=>r.start<=t && r.end>t && r.text && r.confidence>=.72)).length;
  return times.length && captionFrames/times.length >= .65 ? 'EXISTING_READABLE' : captions.length || cut || !ocrAvailable ? 'PARTIAL_OR_UNREADABLE' : 'MISSING';
}
/** The caption situation of the confirmed (cropped) video: captions cropped away are not "existing". */
export function subtitleStateFor(analysis: ReframeAnalysis, crop: ReframeBox | null | undefined): ReframeAnalysis['subtitleState'] {
  if (!crop) return analysis.subtitleState;
  const ocr = analysis.ocrAvailable ?? !analysis.warnings.some(w=>w.startsWith('Text recognition is unavailable'));
  return subtitleStateOf(analysis.regions, analysis.frames.map(f=>f.t), ocr, crop);
}
/** The first crop draft: the whole frame, exactly as uploaded. Nothing is detected or suggested. */
export function defaultPlan(): ReframePlan {
  return {version:1,aspect:'SOURCE',crop:{x:0,y:0,w:1,h:1},framing:'CROP',cleanup:[],grid:'THIRDS',hook:{enabled:false,text:'',y:STYLEONE.hookBox.y},
    captions:{enabled:false,replaceExisting:false,font:'Inter, sans-serif',size:STYLEONE.typography.captions.fontSize,y:STYLEONE.captionSafeBox.y,color:STYLEONE.colors.captionBase,cues:[]},
    color:{exposure:0,contrast:1,saturation:1,temperature:0,sharpness:0,denoise:false},audio:{muted:false,volume:1},resolution:1080,reasons:[]};
}
/** The user's crop rectangle, checked only for what a valid video needs. Float noise is the only thing clamped. */
export function cropBox(v: unknown, frame: { width: number; height: number }): ReframeBox {
  const b = record(v); const r = { x: b.x, y: b.y, w: b.w, h: b.h };
  if (!Object.values(r).every(n => typeof n === 'number' && Number.isFinite(n)) || r.x < -1e-6 || r.y < -1e-6 || r.w <= 0 || r.h <= 0 || r.x+r.w > 1+1e-5 || r.y+r.h > 1+1e-5)
    throw new BadRequestException('The crop must be a rectangle inside the video.');
  if (r.w*frame.width < MIN_CROP_PIXELS-1e-6 || r.h*frame.height < MIN_CROP_PIXELS-1e-6)
    throw new BadRequestException(`The crop must be at least ${MIN_CROP_PIXELS} × ${MIN_CROP_PIXELS} pixels.`);
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  return { x, y, w: Math.min(r.w, 1-x), h: Math.min(r.h, 1-y) };
}
/**
 * Technical validation only. The crop is the user's choice: any finite rectangle inside the frame with
 * sides of at least MIN_CROP_PIXELS is stored exactly. No face, caption, attribution, coverage or ratio
 * rule applies, nothing is recentred or resized, and subject tracking is removed (the crop is fixed).
 * `analysis` only matters for overlay cleanup saved by V2 sessions, which keeps its rights checks.
 */
export function validatePlan(input: unknown, duration: number, frame: { width: number; height: number }, analysis?: ReframeAnalysis | null): ReframePlan {
  const p=record(input); const num=(v:unknown,lo:number,hi:number)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<lo||v>hi)throw new BadRequestException('An edit is outside its supported range.');return v;};
  const bool=(v:unknown)=>{if(typeof v!=='boolean')throw new BadRequestException('Invalid edit option.');return v;};
  if(p.version!==1 || !isReframeAspect(p.aspect) || ![720,1080].includes(p.resolution)) throw new BadRequestException('Unsupported crop settings.');
  const crop=cropBox(p.crop,frame);
  const grid=(REFRAME_GRIDS as readonly string[]).includes(p.grid)?p.grid as ReframePlan['grid']:'THIRDS';
  const requested=Array.isArray(p.cleanup)?p.cleanup:[];
  if(requested.length>24)throw new BadRequestException('Too many cleanup regions.');
  if(requested.length&&!analysis)throw new BadRequestException('Overlay cleanup is not available for this video.');
  const cleanup=requested.map((v:unknown)=>{
    const r=record(v);const b=validBox(r); const start=num(r.start,0,duration);const end=num(r.end,start+.01,duration);
    if(b.w*b.h>.3 || !['BLUR','COVER'].includes(r.method) || r.authorized!==true)throw new BadRequestException('Confirm your rights to clean a localized region.');
    if(analysis!.frames.filter(f=>f.t>=start&&f.t<end).some(f=>[...f.faces,...f.information].some(a=>overlap(a,b)>.001)))throw new BadRequestException('Cleanup would obscure a face or important visual information.');
    if(analysis!.regions.some(a=>a.kind==='ATTRIBUTION' && a.start<end && a.end>start && overlap(a,b)>.001 && !(r.ownedBranding===true && r.regionId===a.id && contains(b,a))))throw new BadRequestException('Keep creator attribution visible. Only explicitly selected branding you own may be removed.');
    return {...b,regionId:String(r.regionId||'manual').slice(0,80),start,end,method:r.method,intensity:num(r.intensity,1,30),authorized:true,ownedBranding:r.ownedBranding===true};
  });
  for(const t of cleanup.map(r=>r.start)) {
    if(cleanup.filter(r=>r.start<=t&&r.end>t).reduce((area,r)=>area+r.w*r.h,0)>.3)throw new BadRequestException('Keep cleanup localized to at most 30% of the frame at a time.');
  }
  const hook=record(p.hook);const cap=record(p.captions);const color=record(p.color);const audio=record(p.audio);
  if(typeof hook.text!=='string'||hook.text.length>160 || !EDIT_MODE_FONT_FAMILIES[cap.font] || !/^#[0-9a-f]{6}$/iu.test(cap.color))throw new BadRequestException('Check hook text and caption style.');
  if(!Array.isArray(cap.cues)||cap.cues.length>400)throw new BadRequestException('Too many caption lines.');
  const cues=cap.cues.map((v:unknown)=>{const s=record(v);if(typeof s.text!=='string'||s.text.length>500)throw new BadRequestException('Caption text is too long.');return {start:num(s.start,0,duration),end:num(s.end,s.start+.01,duration),text:s.text};});
  // StyleOne's hook lives above the media window, never in source coordinates.
  return {version:1,aspect:p.aspect,crop,framing:'CROP',tracking:undefined,grid,cleanup,hook:{enabled:bool(hook.enabled),text:hook.text.trim(),y:STYLEONE.hookBox.y},
    captions:{enabled:bool(cap.enabled),replaceExisting:bool(cap.replaceExisting),font:'Inter, sans-serif',size:STYLEONE.typography.captions.fontSize,y:STYLEONE.captionSafeBox.y,color:STYLEONE.colors.captionBase,cues},
    color:{exposure:num(color.exposure,-.3,.3),contrast:num(color.contrast,.8,1.2),saturation:num(color.saturation,.8,1.2),temperature:num(color.temperature,-.15,.15),sharpness:num(color.sharpness,0,.5),denoise:bool(color.denoise)},
    audio:{muted:bool(audio.muted),volume:num(audio.volume,0,2)},resolution:p.resolution,reasons:Array.isArray(p.reasons)?p.reasons.filter((s:unknown)=>typeof s==='string').slice(0,10):[]};
}
export function outputGeometry(p: ReframePlan, w: number, h: number, preview=false) {
  const sw=w*p.crop.w,sh=h*p.crop.h;
  const ratio=aspectValue(p.aspect) ?? sw/sh;
  const target=preview?480:p.resolution; const scale=Math.min(1,target/Math.min(sw,sh));
  let width:number,height:number;
  if(p.framing==='FIT') { const maxW=sw*scale,maxH=sh*scale; width=Math.min(maxW,maxH*ratio);height=width/ratio; }
  else {height=Math.min(sh*scale,sw*scale/ratio);width=height*ratio;}
  return {width:Math.max(16,Math.floor(width/2)*2),height:Math.max(16,Math.floor(height/2)*2)};
}
