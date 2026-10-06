import type { ReframePlan, ReframePreparation } from './quick-reframe-plan';
import { outputGeometry, preparationOf } from './quick-reframe-plan';
import { buildRenderPlan, type PlanInput } from '../edit-mode/render/edit-mode-render-plan';
import { buildFfmpegArgs } from '../edit-mode/render/edit-mode-filtergraph';
import { buildEditModeAss, wrapToWidth } from '../edit-mode/render/edit-mode-ass';
import { BadRequestException } from '@nestjs/common';
import { validateRenderPlan } from '../edit-mode/render/edit-mode-render-validate';
import { createHash } from 'crypto';
import type { EditElementType } from '@prisma/client';
import { compileCreativeStyle } from '../edit-mode/styles/creative-style-commands';
import { resolveCreativeStyle } from '../edit-mode/styles/creative-style-resolver';
import { buildChatContext } from '../edit-mode/chat/edit-chat-context';
import { EMPTY_CHAT_THREAD } from '../edit-mode/chat/edit-chat.types';
import { buildPresetEvidence } from '../edit-mode/presets/edit-preset-evidence';
import { readEditProjectStyle, type EditAspectRatio } from '../edit-mode/presets/edit-preset-policy';
import { resolveCanvas } from '../edit-mode/render/edit-mode-camera';

/** V3: the confirmed crop/cleanup is baked into SOURCE once; StyleOne and Manual both compose from it. */
export const QUICK_REFRAME_PIPELINE = 'CROP_FIRST_V3';
// PostgreSQL JSONB reorders object keys. Hash the values, independent of storage order.
function stableJson(value: unknown): string {
  if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Identity of a baked source: only changes affecting source pixels produce a new one. */
export function preparationFingerprint(p: ReframePreparation) {
  return createHash('sha256').update(stableJson({pipeline:QUICK_REFRAME_PIPELINE,crop:p.crop,tracking:p.tracking||[],cleanup:p.cleanup,denoise:p.denoise})).digest('hex');
}
export function cleanFingerprint(p: ReframePlan) { return preparationFingerprint(preparationOf(p)); }

/**
 * Compile the actual StyleOne template through the same editor commands as Create Clips.
 * The confirmed crop is already baked into SOURCE, so StyleOne shows that whole frame inside its
 * fixed media window (canonical FIT framing) instead of cropping a second time.
 */
export function quickStyleOneCommands(input: PlanInput, options: { hookText: string; captions: boolean }) {
  const source=input.assets.find(a=>a.role==='SOURCE')!;
  const hook=options.hookText.trim();
  const context=buildChatContext({revision:input.project.revision,settings:input.project.settings,style:readEditProjectStyle(input.project.settings),
    elements:input.elements.map(e=>({...e,type:e.type as EditElementType,properties:e.properties as Record<string,unknown>})),
    assets:input.assets.map(a=>({...a,originalName:'Quick Reframe source'})),
    evidence:buildPresetEvidence({durationSec:source.duration!,width:source.width,height:source.height,metadata:source.metadata,transcript:source.transcript,analysis:source.analysis,aspectRatio:'SOURCE',preserveInformation:true}),
    thread:EMPTY_CHAT_THREAD,selection:{},message:'Apply StyleOne to the complete confirmed source'});
  const resolved=resolveCreativeStyle({templateId:'AUTOMATIC_2',components:{ZOOM:'ZOOM_NONE',
    ...(hook?{}:{HOOK:'HOOK_NONE'}),...(options.captions?{}:{CAPTIONS:'CAP_NONE'})}});
  const compiled=compileCreativeStyle(resolved,context,{hookOptions:hook?[{text:hook}]:[],hasWordTimings:context.project.hasWordTimings});
  for(const command of compiled.commands) if(command.kind==='SETTINGS' && command.payload.resolvedVisualLayout) {
    const layout=command.payload.resolvedVisualLayout as {cameraPath:unknown[]};
    layout.cameraPath=[{t:0,x:0,y:0,w:1,h:1},{t:source.duration!,x:0,y:0,w:1,h:1}];
  }
  for(const command of compiled.commands) if(command.action==='SET_REFRAME_POLICY')command.payload.policy='SOURCE';
  for(const command of compiled.commands) if(command.action==='SET_ELEMENT_TIMING'&&Number(command.payload.duration)>source.duration!)command.payload.duration=source.duration!;
  compiled.commands.push({kind:'ELEMENT',action:'SET_VIDEO_FRAMING',payload:{mode:'FIT',scope:'ALL_VIDEO_SEGMENTS'}});
  compiled.commands.push({kind:'SETTINGS',action:'QUICK_REFRAME_STYLEONE',payload:{aspectRatio:'9:16',reframePolicy:'SOURCE',zoomPolicy:'OFF',subtitlePolicy:'OFF',gradingPolicy:'NONE',quickReframeStyleOne:true}});
  return compiled;
}

/** Bakes the confirmed crop/cleanup into a new source. Source-local masking is the only new filter. */
export function quickCleanRender(input: PlanInput, p: ReframePlan, sourcePath: string, outputPath: string) {
  const source=input.assets.find(a=>a.role==='SOURCE')!;
  const sw=source.width!,sh=source.height!;
  const dimensions=outputGeometry({...p,aspect:'SOURCE',resolution:1080},sw,sh);
  // No text, captions, style, grading, or audio edits: one source segment at exactly 1x.
  const built=buildRenderPlan({...input,elements:input.elements.filter(e=>e.type==='VIDEO'&&e.track===0).slice(0,1).map(e=>({...e,startTime:0,trimStart:0,duration:source.duration!,trimEnd:source.duration!,properties:{sourceVolume:1,sourceMuted:false}})),canvasOverride:dimensions,project:{...input.project,settings:{aspectRatio:'SOURCE',reframePolicy:'SOURCE',zoomPolicy:'OFF',subtitlePolicy:'OFF',gradingPolicy:'NONE'}}});
  const plan=built.plan;plan.canvas.visualLayout=null;plan.grading.filter='null';plan.zoomEvents=[];plan.textOverlays=[];plan.subtitles=[];plan.visualOverlays=[];plan.audioTracks=[];
  for(const segment of plan.videoSegments) { segment.crop={left:0,right:0,top:0,bottom:0};segment.scale=1;segment.offsetX=0;segment.offsetY=0; }
  validateRenderPlan(plan,{assets:input.assets});
  const graph:string[]=[];let videoLabel='0:v';
  for(const [i,r] of p.cleanup.entries()) {
    const x=Math.floor(r.x*sw/2)*2,y=Math.floor(r.y*sh/2)*2;
    const w=Math.max(2,Math.min(sw-x,Math.floor(r.w*sw/2)*2)),h=Math.max(2,Math.min(sh-y,Math.floor(r.h*sh/2)*2));
    const enable=`gte(t,${r.start.toFixed(3)})*lt(t,${r.end.toFixed(3)})`;
    if(r.method==='COVER') graph.push(`[${videoLabel}]drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@1:t=fill:enable='${enable}'[q${i}]`);
    else {
      graph.push(`[${videoLabel}]split=2[qbase${i}][qmask${i}]`);
      const radius=Math.max(0,Math.min(Math.floor(Math.min(w,h)/2)-1,Math.round(r.intensity)));
      const chromaRadius=Math.max(0,Math.min(radius,Math.floor(Math.min(w,h)/4)-1));
      const blur=radius>0 ? `boxblur=${radius}:2:${chromaRadius}:2` : `gblur=sigma=${Math.min(10,r.intensity/3).toFixed(2)}:steps=2`;
      graph.push(`[qmask${i}]crop=${w}:${h}:${x}:${y},${blur}[qblur${i}]`);
      graph.push(`[qbase${i}][qblur${i}]overlay=${x}:${y}:enable='${enable}'[q${i}]`);
    }
    videoLabel=`q${i}`;
  }
  if(p.color.denoise){graph.push(`[${videoLabel}]hqdn3d=1.2:1.2:2:2[qnoise]`);videoLabel='qnoise';}
  const cw=Math.max(2,Math.floor(sw*p.crop.w/2)*2),ch=Math.max(2,Math.floor(sh*p.crop.h/2)*2);
  const cx=Math.min(sw-cw,Math.floor(sw*p.crop.x/2)*2),cy=Math.min(sh-ch,Math.floor(sh*p.crop.y/2)*2);
  const expression=(axis:'x'|'y',size:number)=>{
    const keys=p.tracking;if(!keys?.length)return String(axis==='x'?cx:cy);
    // Sum bounded interpolation ramps rather than a deeply nested conditional.
    let e=(keys[0][axis]*size).toFixed(3);
    for(let i=1;i<keys.length;i++){const prev=keys[i-1],next=keys[i];const delta=(next[axis]-prev[axis])*size;if(Math.abs(delta)<.001)continue;e+=`+(${delta.toFixed(3)})*clip((t-${prev.t.toFixed(3)})/${(next.t-prev.t).toFixed(3)},0,1)`;}
    return `2*floor((${e})/2)`;
  };
  const cameraFilter=`crop=${cw}:${ch}:'${expression('x',sw)}':'${expression('y',sh)}',scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease,pad=${dimensions.width}:${dimensions.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const args=buildFfmpegArgs({plan,sourcePath,outputPath,overlayPaths:{},audioPaths:{},assFileName:null,informationCrop:null,fitExpression:'',informationFitExpression:'',cameraFilter,
    sourcePreparation:graph.length?{graph,videoLabel}:undefined,preserveSourceAudio:true});
  args.splice(args.indexOf('-i'),0,'-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm');
  return {args,ass:null,plan};
}

/** Longest export side: a very narrow or wide Free Crop scales down rather than exceed common H.264 decoders. */
export const QUICK_MAX_LONG_SIDE = 3840;
/** The output canvas for a project at a target short side (720/1080, or 540 for previews). */
export function quickOutputCanvas(settings: unknown, sourceWidth: number, sourceHeight: number, shortSide: number) {
  const style=readEditProjectStyle(settings);
  // SOURCE keeps the confirmed crop's exact shape (resolveCanvas would widen a very narrow crop to 128 px).
  const aspect=(style.aspectRatio||'SOURCE') as EditAspectRatio;
  const base=aspect==='SOURCE'&&sourceWidth>0&&sourceHeight>0?{width:sourceWidth,height:sourceHeight}:resolveCanvas(aspect,sourceWidth,sourceHeight);
  const scale=Math.min(shortSide/Math.min(base.width,base.height),QUICK_MAX_LONG_SIDE/Math.max(base.width,base.height));
  const even=(n:number)=>Math.max(16,Math.round(n/2)*2);
  return {width:even(base.width*scale),height:even(base.height*scale)};
}

/**
 * One composition path for both editing modes: the canonical render plan, ASS text and FFmpeg
 * graph over the confirmed SOURCE, with the project's own images and audio. StyleOne additionally
 * requires its resolved AUTOMATIC_2 layout, so a project that lost it is never rendered as StyleOne.
 */
export function quickComposeRender(input: PlanInput & { canvasOverride: { width: number; height: number } }, sourcePath: string, outputPath: string,
  media: { overlayPaths: Record<string, string>; audioPaths: Record<string, string> }, styleOne: boolean) {
  const built=buildRenderPlan(input);
  const plan=built.plan;
  if(styleOne&&plan.canvas.visualLayout?.editingProfile!=='AUTOMATIC_2')throw new Error('StyleOne layout must be resolved before composition');
  validateRenderPlan(plan,{assets:input.assets});
  const captionLines=plan.canvas.visualLayout?.captions.maxLines;
  if(styleOne&&captionLines&&plan.subtitles.some(c=>wrapToWidth(c.content,c.fontSizePx,c.width).length>captionLines))throw new BadRequestException('Shorten the edited caption to fit StyleOne’s two-line caption area.');
  const ass=buildEditModeAss(plan.canvas,[...plan.textOverlays,...plan.subtitles]);
  const assName=plan.textOverlays.length||plan.subtitles.length?'captions.ass':null;
  const args=buildFfmpegArgs({plan,sourcePath,outputPath,overlayPaths:media.overlayPaths,audioPaths:media.audioPaths,assFileName:assName,
    informationCrop:built.evidence.informationCrop,fitExpression:built.evidence.fitExpression,informationFitExpression:built.evidence.informationFitExpression,cameraFilter:built.evidence.cameraFilter});
  args.splice(args.indexOf('-i'),0,'-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm');
  return {args,ass:assName?ass.content:null,plan,evidence:built.evidence};
}
