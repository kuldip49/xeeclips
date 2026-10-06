import type { ReframePlan } from './quick-reframe-plan';
import { outputGeometry } from './quick-reframe-plan';
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
import { readEditProjectStyle } from '../edit-mode/presets/edit-preset-policy';
import { STREET3_CANVAS } from '../edit-mode/styles/automatic-2-street3-layout';

export const QUICK_REFRAME_PIPELINE = 'CLEAN_THEN_STYLEONE_V2';
// PostgreSQL JSONB reorders object keys. Hash the values, independent of storage order.
function stableJson(value: unknown): string {
  if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Only changes affecting source pixels invalidate the clean intermediate. */
export function cleanFingerprint(sourceId: string, p: ReframePlan) {
  return createHash('sha256').update(stableJson({pipeline:QUICK_REFRAME_PIPELINE,sourceId,crop:p.crop,tracking:p.tracking||[],cleanup:p.cleanup,denoise:p.color.denoise})).digest('hex');
}
export function styleFingerprint(p: ReframePlan) {
  return createHash('sha256').update(stableJson({pipeline:QUICK_REFRAME_PIPELINE,hook:p.hook,captions:p.captions})).digest('hex');
}

/** Compile the actual StyleOne template through the same editor commands as Create Clips. */
export function quickStyleOneCommands(input: PlanInput, p: ReframePlan) {
  const source=input.assets.find(a=>a.role==='SOURCE')!;
  const context=buildChatContext({revision:input.project.revision,settings:input.project.settings,style:readEditProjectStyle(input.project.settings),
    elements:input.elements.map(e=>({...e,type:e.type as EditElementType,properties:e.properties as Record<string,unknown>})),
    assets:input.assets.map(a=>({...a,originalName:'Quick Reframe source'})),
    evidence:buildPresetEvidence({durationSec:source.duration!,width:source.width,height:source.height,metadata:source.metadata,transcript:source.transcript,analysis:source.analysis,aspectRatio:'SOURCE',preserveInformation:true}),
    thread:EMPTY_CHAT_THREAD,selection:{},message:'Apply StyleOne to the complete cleaned source'});
  const resolved=resolveCreativeStyle({templateId:'AUTOMATIC_2',components:{ZOOM:'ZOOM_NONE',
    ...(p.hook.enabled?{}:{HOOK:'HOOK_NONE'}),...(p.captions.enabled?{}:{CAPTIONS:'CAP_NONE'})}});
  const compiled=compileCreativeStyle(resolved,context,{hookOptions:p.hook.enabled?[{text:p.hook.text}]:[],hasWordTimings:context.project.hasWordTimings});
  // The clean stage already chose the safe crop. Reuse StyleOne's canonical full-frame
  // fit inside its fixed card, rather than performing a second face crop.
  for(const command of compiled.commands) if(command.kind==='SETTINGS' && command.payload.resolvedVisualLayout) {
    const layout=command.payload.resolvedVisualLayout as {cameraPath:unknown[]};
    layout.cameraPath=[{t:0,x:0,y:0,w:1,h:1},{t:source.duration!,x:0,y:0,w:1,h:1}];
  }
  for(const command of compiled.commands) if(command.action==='SET_REFRAME_POLICY')command.payload.policy='SOURCE';
  for(const command of compiled.commands) if(command.action==='SET_ELEMENT_TIMING'&&Number(command.payload.duration)>source.duration!)command.payload.duration=source.duration!;
  compiled.commands.push({kind:'SETTINGS',action:'QUICK_REFRAME_STYLEONE',payload:{aspectRatio:'9:16',reframePolicy:'SOURCE',zoomPolicy:'OFF',subtitlePolicy:'OFF',gradingPolicy:'NONE',quickReframeStyleKey:styleFingerprint(p)}});
  return compiled;
}

/** Only source-local masking is new. Composition, text, codecs, color, and audio reuse the canonical engine. */
export function quickCleanRender(input: PlanInput, p: ReframePlan, sourcePath: string, outputPath: string) {
  const source=input.assets.find(a=>a.role==='SOURCE')!;
  const sw=source.width!,sh=source.height!;
  const dimensions=outputGeometry({...p,aspect:'SOURCE',resolution:1080},sw,sh);
  // Stage 1 has no new text, captions, style, grading, or audio edits.
  const built=buildRenderPlan({...input,elements:input.elements.filter(e=>e.type==='VIDEO'&&e.track===0).map(e=>({...e,properties:{sourceVolume:1,sourceMuted:false}})),canvasOverride:dimensions,project:{...input.project,settings:{aspectRatio:'SOURCE',reframePolicy:'SOURCE',zoomPolicy:'OFF',subtitlePolicy:'OFF',gradingPolicy:'NONE'}}});
  const plan=built.plan;plan.canvas.visualLayout=null;plan.grading.filter='null';plan.zoomEvents=[];
  // The original sequence stays as one canonical source segment at exactly 1x.
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

/** Stage 2 consumes only the validated CLEAN asset. All layout/text composition is canonical. */
export function quickStyleOneRender(input: PlanInput, sourcePath: string, outputPath: string, preview=false) {
  const built=buildRenderPlan({...input,canvasOverride:preview?{width:540,height:960}:STREET3_CANVAS});
  const plan=built.plan;
  if(plan.canvas.visualLayout?.editingProfile!=='AUTOMATIC_2')throw new Error('StyleOne layout must be resolved before composition');
  validateRenderPlan(plan,{assets:input.assets});
  if(plan.subtitles.some(c=>wrapToWidth(c.content,c.fontSizePx,c.width).length>plan.canvas.visualLayout!.captions.maxLines))throw new BadRequestException('Shorten the edited caption to fit StyleOne’s two-line caption area.');
  const ass=buildEditModeAss(plan.canvas,[...plan.textOverlays,...plan.subtitles]);
  const assName=plan.textOverlays.length||plan.subtitles.length?'captions.ass':null;
  const args=buildFfmpegArgs({plan,sourcePath,outputPath,overlayPaths:{},audioPaths:{},assFileName:assName,
    informationCrop:null,fitExpression:'1',informationFitExpression:'',cameraFilter:built.evidence.cameraFilter,preserveSourceAudio:true});
  args.splice(args.indexOf('-i'),0,'-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm');
  return {args,ass:assName?ass.content:null,plan};
}
