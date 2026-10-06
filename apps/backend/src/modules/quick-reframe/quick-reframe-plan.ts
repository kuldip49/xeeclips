import { BadRequestException } from '@nestjs/common';
import type { ReframeAnalysis, ReframeBox, ReframePlan, ReframeRegion } from '@ai-content-platform/shared';
import { EDIT_MODE_FONT_FAMILIES } from '../edit-mode/edit-mode-text';
export type { ReframeAnalysis, ReframeBox, ReframePlan, ReframeRegion } from '@ai-content-platform/shared';
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
      const decorative = !attribution && !caption && b.y < .2 && confidence >= .65;
      const kind = attribution ? 'ATTRIBUTION' : caption ? 'CAPTION' : decorative ? 'DECORATIVE' : 'UNKNOWN';
      // Merge only adjacent, similar positions AND wording. Moving/changing text gets a new timed region.
      const prior = [...regions].reverse().find(r => r.kind===kind && r.text===text && Math.abs(r.end-start)<.15 && overlap(r,b) / Math.max(.001, b.w*b.h+r.w*r.h-overlap(r,b)) > .8);
      if (prior) { prior.end=end; prior.confidence=Math.min(prior.confidence,confidence); }
      else regions.push({ ...b, id:`region-${regions.length}`,start,end,text,confidence,kind });
    }
  }
  const captions = regions.filter(r=>r.kind==='CAPTION');
  const captionFrames = frames.filter(f => captions.some(r=>r.start<=f.t && r.end>f.t && r.text && r.confidence>=.72)).length;
  const possibleCaptions = captions.length>0;
  const subtitleState = frames.length && captionFrames/frames.length >= .65 ? 'EXISTING_READABLE' : possibleCaptions || !data.runtime?.ocr ? 'PARTIAL_OR_UNREADABLE' : 'MISSING';
  const warnings: string[] = [];
  if (!data.runtime?.ocr) warnings.push('Text recognition is unavailable. Review detected regions and existing captions before adding new captions.');
  if (!data.runtime?.faceDetector && !data.runtime?.yolo) warnings.push('Subject detection is unavailable. Automatic framing keeps the full source.');
  const minBar = (key: string) => frames.length ? Math.min(...frames.map(f=>Number(f.bars?.[key])||0)) : 0;
  return { regions: regions.slice(0,600), frames: frames.map(f=>({t:Number(f.t)||0,
    faces:(f.faces||[]).map(box).filter(Boolean),persons:(f.persons||[]).map(box).filter(Boolean),
    information: (Number(f.text_coverage)>.15 || Number(f.edge_density)>.2) ? [{x:0,y:0,w:1,h:1}] : [] })),
    boundaries: (data.shot_boundaries||[]).filter((n:unknown)=>typeof n==='number'), subtitleState,warnings,
    appearance: frames.some(f=>Number.isFinite(f.brightness)) ? {brightness:frames.reduce((n,f)=>n+(Number(f.brightness)||0),0)/frames.length,contrast:frames.reduce((n,f)=>n+(Number(f.contrast)||0),0)/frames.length} : undefined,
    bars:{top:minBar('top'),bottom:minBar('bottom'),left:minBar('left'),right:minBar('right')} } as ReframeAnalysis;
}
export function proposePlan(analysis: ReframeAnalysis, width: number, height: number, transcript: unknown, aspect: ReframePlan['aspect'] = 'SOURCE'): ReframePlan {
  const full = { x:0,y:0,w:1,h:1 }; const candidates: ReframeBox[] = [full];
  const bars = analysis.bars;
  if (bars.top+bars.bottom+bars.left+bars.right > .01) candidates.push({x:bars.left,y:bars.top,w:1-bars.left-bars.right,h:1-bars.top-bars.bottom});
  for (const r of analysis.regions.filter(r=>r.kind==='DECORATIVE' && r.confidence>=.75)) {
    if (r.y+r.h<.25) candidates.push({x:0,y:r.y+r.h+.015,w:1,h:1-r.y-r.h-.015});
    if (r.x+r.w<.22) candidates.push({x:r.x+r.w+.015,y:0,w:1-r.x-r.w-.015,h:1});
    if (r.x>.78) candidates.push({x:0,y:0,w:r.x-.015,h:1});
  }
  const safeFrame = (c:ReframeBox,f:ReframeAnalysis['frames'][number]) => f.faces.every(b=>contains(c,b,.012)) && f.persons.every(b=>overlap(c,b)/Math.max(.001,b.w*b.h)>=.92) && f.information.every(b=>contains(c,b)) && analysis.regions.filter(r=>['CAPTION','ATTRIBUTION','INFORMATION'].includes(r.kind)&&r.start<=f.t&&r.end>f.t).every(r=>contains(c,r));
  const safe = (c: ReframeBox, target=false) => c.w*c.h>=(target?.28:.6) && analysis.frames.every(f=>safeFrame(c,f));
  const hasSubjects = analysis.frames.some(f=>f.faces.length || f.persons.length);
  const content={x:bars.left,y:bars.top,w:1-bars.left-bars.right,h:1-bars.top-bars.bottom};
  const score = (c: ReframeBox) => {
    const lostContent=Math.max(0,content.w*content.h-overlap(c,content));
    const removedBars=Math.max(0,1-c.w*c.h-lostContent);
    return analysis.regions.filter(r=>r.kind==='DECORATIVE').reduce((sum,r)=>sum+(1-overlap(c,r)/(r.w*r.h))*(r.end-r.start)*r.confidence,0)/Math.max(1,...analysis.regions.map(r=>r.end)) - lostContent*.35 + removedBars*.5;
  };
  const eligible=hasSubjects ? candidates : [full,...(safe(content)&&content.w*content.h<.99 ? [content] : [])];
  let chosen = eligible.filter(c=>safe(c)).sort((a,b)=>score(b)-score(a))[0] || full;
  let framing: ReframePlan['framing']='CROP'; const reasons = ['Preserves the complete sequence and original audio.'];
  let tracking: ReframePlan['tracking'];
  if (aspect!=='SOURCE' && aspect!=='CUSTOM') {
    const [a,b] = aspect.split(':').map(Number); const ratio = a/b;
    const retainedRatio=chosen.w*width/(chosen.h*height);
    const target = retainedRatio>ratio ? {...chosen,w:chosen.h*height*ratio/width} : {...chosen,h:chosen.w*width/ratio/height};
    target.x=chosen.x+(chosen.w-target.w)/2;target.y=chosen.y+(chosen.h-target.h)/2;
    if(hasSubjects && safe(target,true)) chosen=target;
    else if(hasSubjects && target.w*target.h>=.28 && analysis.frames.length>1 && analysis.frames.every(f=>f.faces.length||f.persons.length)) {
      // A bounded moving crop: rolling centres smooth detector jitter. Every sampled face,
      // subject, caption, and chart must remain inside before this candidate is accepted.
      const centers=analysis.frames.map(f=>{const subjects=f.faces.length?f.faces:f.persons;const left=Math.min(...subjects.map(b=>b.x)),right=Math.max(...subjects.map(b=>b.x+b.w));const top=Math.min(...subjects.map(b=>b.y)),bottom=Math.max(...subjects.map(b=>b.y+b.h));return {x:(left+right)/2,y:(top+bottom)/2};});
      const tracked=centers.map((_,i)=>{const window=centers.slice(Math.max(0,i-2),i+3);return {t:analysis.frames[i].t,x:clamp(window.reduce((n,c)=>n+c.x,0)/window.length-target.w/2,chosen.x,chosen.x+chosen.w-target.w),y:clamp(window.reduce((n,c)=>n+c.y,0)/window.length-target.h/2,chosen.y,chosen.y+chosen.h-target.h)};});
      const stable=tracked.every((key,i)=>safeFrame({...target,x:key.x,y:key.y},analysis.frames[i]) && (i===0 || Math.hypot(key.x-tracked[i-1].x,key.y-tracked[i-1].y)/Math.max(.01,key.t-tracked[i-1].t)<=.15));
      if(stable){chosen={...target,x:tracked[0].x,y:tracked[0].y};tracking=tracked;reasons.push('Smooth subject tracking keeps the main subject inside a verified moving crop.');}
      else {framing='FIT';reasons.push('Keeps the complete retained frame because a moving crop could lose important content.');}
    } else {framing='FIT';reasons.push('Fits the retained frame to protect faces, attribution, and visual information.');}
  }
  if(chosen.w*chosen.h<.999) reasons.push('A stable crop removes only regions that pass subject and information checks.');
  else reasons.push('Keeps the full frame because a tighter crop is not sufficiently safe.');
  const cues = (record(transcript).segments||[]).filter((s:any)=>Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>s.start&&typeof s.text==='string').map((s:any)=>({start:s.start,end:s.end,text:s.text.trim().slice(0,500)}));
  const hookSlots=[.04,.28,.46]; const hookY=hookSlots.find(y=>analysis.frames.every(f=>f.faces.every(face=>overlap({x:.08,y,w:.84,h:.15},face)<.001))) ?? .04;
  return {version:1,aspect,crop:chosen,framing,tracking,cleanup:[],hook:{enabled:false,text:'',y:hookY},
    captions:{enabled:analysis.subtitleState==='MISSING' && cues.length>0,replaceExisting:false,font:'Noto Sans, sans-serif',size:32,y:.82,color:'#ffffff',cues},
    color:{exposure:analysis.appearance && analysis.appearance.brightness<.22 ? .1 : analysis.appearance && analysis.appearance.brightness>.8 ? -.08 : 0,
      contrast:analysis.appearance && analysis.appearance.contrast<.09 ? 1.06 : 1,saturation:1,temperature:0,sharpness:0,denoise:false},audio:{muted:false,volume:1},resolution:1080,reasons};
}
export function validatePlan(input: unknown, duration: number, analysis: ReframeAnalysis): ReframePlan {
  const p=record(input); const num=(v:unknown,lo:number,hi:number)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<lo||v>hi)throw new BadRequestException('An edit is outside its supported range.');return v;};
  const bool=(v:unknown)=>{if(typeof v!=='boolean')throw new BadRequestException('Invalid edit option.');return v;};
  if(p.version!==1 || !['SOURCE','9:16','1:1','16:9','CUSTOM'].includes(p.aspect) || !['CROP','FIT'].includes(p.framing) || ![720,1080].includes(p.resolution)) throw new BadRequestException('Unsupported editing plan.');
  const crop=validBox(p.crop); if(crop.w*crop.h<.2)throw new BadRequestException('Keep at least 20% of the original frame.');
  const tracking=Array.isArray(p.tracking)&&p.tracking.length<=240 ? p.tracking.map((v:unknown)=>{const k=record(v);return {t:num(k.t,0,duration),x:num(k.x,0,1-crop.w),y:num(k.y,0,1-crop.h)};}) : undefined;
  if(tracking?.some((k,i)=>i>0 && (k.t<=tracking[i-1].t || Math.hypot(k.x-tracking[i-1].x,k.y-tracking[i-1].y)/(k.t-tracking[i-1].t)>.15)))throw new BadRequestException('Tracked framing must move smoothly.');
  const cropAt=(t:number)=>{if(!tracking?.length)return crop;let i=0;while(i<tracking.length-1&&tracking[i+1].t<=t)i++;const k=tracking[i],next=tracking[i+1];const f=next?clamp((t-k.t)/(next.t-k.t)):0;return {...crop,x:k.x+(next?next.x-k.x:0)*f,y:k.y+(next?next.y-k.y:0)*f};};
  if(analysis.regions.some(r=>r.kind==='ATTRIBUTION'&&!contains(cropAt(r.start),r)))throw new BadRequestException('Keep detected creator attribution inside the frame.');
  if(tracking?.length && analysis.frames.some(f=>f.faces.some(face=>!contains(cropAt(f.t),face,.01))||f.information.some(b=>!contains(cropAt(f.t),b))))throw new BadRequestException('The moving crop would lose a face or important visual information.');
  const cleanup=Array.isArray(p.cleanup)&&p.cleanup.length<=24 ? p.cleanup.map((v:unknown)=>{
    const r=record(v);const b=validBox(r); const start=num(r.start,0,duration);const end=num(r.end,start+.01,duration);
    if(b.w*b.h>.3 || !['BLUR','COVER'].includes(r.method) || r.authorized!==true)throw new BadRequestException('Confirm your rights to clean a localized region.');
    if(analysis.regions.some(a=>a.kind==='ATTRIBUTION' && a.start<end && a.end>start && overlap(a,b)>.001 && !(r.ownedBranding===true && r.regionId===a.id && contains(b,a))))throw new BadRequestException('Keep creator attribution visible. Only explicitly selected branding you own may be removed.');
    return {...b,regionId:String(r.regionId||'manual').slice(0,80),start,end,method:r.method,intensity:num(r.intensity,1,30),authorized:true,ownedBranding:r.ownedBranding===true};
  }) : (()=>{throw new BadRequestException('Too many cleanup regions.');})();
  for(const t of cleanup.map(r=>r.start)) {
    if(cleanup.filter(r=>r.start<=t&&r.end>t).reduce((area,r)=>area+r.w*r.h,0)>.3)throw new BadRequestException('Keep cleanup localized to at most 30% of the frame at a time.');
  }
  const hook=record(p.hook);const cap=record(p.captions);const color=record(p.color);const audio=record(p.audio);
  if(typeof hook.text!=='string'||hook.text.length>160 || !EDIT_MODE_FONT_FAMILIES[cap.font] || !/^#[0-9a-f]{6}$/iu.test(cap.color))throw new BadRequestException('Check hook text and caption style.');
  if(hook.enabled){
    const area={x:.08,y:num(hook.y,0,.7),w:.84,h:.14};
    const coversFace=analysis.frames.filter(f=>f.t<5).some(f=>f.faces.some(face=>{const c=cropAt(f.t);return overlap(area,{x:(face.x-c.x)/c.w,y:(face.y-c.y)/c.h,w:face.w/c.w,h:face.h/c.h})>.001;}));
    if(coversFace)throw new BadRequestException('Move the hook away from the detected faces.');
    if(analysis.regions.filter(r=>r.kind==='CAPTION'&&r.start<5).some(r=>{const c=cropAt(r.start);return overlap(area,{x:(r.x-c.x)/c.w,y:(r.y-c.y)/c.h,w:r.w/c.w,h:r.h/c.h})>.001;}))throw new BadRequestException('Move the hook away from the original captions.');
    if(cap.enabled && overlap(area,{x:.08,y:num(cap.y,0,.85),w:.84,h:.14})>.001)throw new BadRequestException('Keep the hook separate from generated captions.');
  }
  if(cap.enabled && analysis.subtitleState!=='MISSING' && cap.replaceExisting!==true)throw new BadRequestException('Confirm replacement before adding captions over an existing or uncertain caption layer.');
  if(!Array.isArray(cap.cues)||cap.cues.length>400)throw new BadRequestException('Too many caption lines.');
  const cues=cap.cues.map((v:unknown)=>{const s=record(v);if(typeof s.text!=='string'||s.text.length>500)throw new BadRequestException('Caption text is too long.');return {start:num(s.start,0,duration),end:num(s.end,s.start+.01,duration),text:s.text};});
  // Replacement requires every detected old caption to be cropped out or explicitly covered.
  if(cap.enabled && analysis.subtitleState!=='MISSING' && analysis.regions.filter(r=>r.kind==='CAPTION').some(r=>overlap(crop,r)>.001 && !cleanup.some((c:any)=>c.start<=r.start && c.end>=r.end && contains(c,r)))) throw new BadRequestException('Cover or crop out the detected original captions before replacing them.');
  return {version:1,aspect:p.aspect,crop,framing:p.framing,tracking,cleanup,hook:{enabled:bool(hook.enabled),text:hook.text.trim(),y:num(hook.y,0,.7)},
    captions:{enabled:bool(cap.enabled),replaceExisting:bool(cap.replaceExisting),font:cap.font,size:num(cap.size,16,64),y:num(cap.y,0,.85),color:cap.color,cues},
    color:{exposure:num(color.exposure,-.3,.3),contrast:num(color.contrast,.8,1.2),saturation:num(color.saturation,.8,1.2),temperature:num(color.temperature,-.15,.15),sharpness:num(color.sharpness,0,.5),denoise:bool(color.denoise)},
    audio:{muted:bool(audio.muted),volume:num(audio.volume,0,2)},resolution:p.resolution,reasons:Array.isArray(p.reasons)?p.reasons.filter((s:unknown)=>typeof s==='string').slice(0,10):[]};
}
export function outputGeometry(p: ReframePlan, w: number, h: number, preview=false) {
  const sw=w*p.crop.w,sh=h*p.crop.h;
  const ratio=p.aspect==='SOURCE'||p.aspect==='CUSTOM' ? sw/sh : Number(p.aspect.split(':')[0])/Number(p.aspect.split(':')[1]);
  const target=preview?480:p.resolution; const scale=Math.min(1,target/Math.min(sw,sh));
  let width:number,height:number;
  if(p.framing==='FIT') { const maxW=sw*scale,maxH=sh*scale; width=Math.min(maxW,maxH*ratio);height=width/ratio; }
  else {height=Math.min(sh*scale,sw*scale/ratio);width=height*ratio;}
  return {width:Math.max(16,Math.floor(width/2)*2),height:Math.max(16,Math.floor(height/2)*2)};
}
