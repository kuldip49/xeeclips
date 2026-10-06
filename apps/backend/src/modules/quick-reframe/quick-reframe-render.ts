import type { ReframePlan } from './quick-reframe-plan';
import { outputGeometry } from './quick-reframe-plan';
import { buildRenderPlan, type PlanInput } from '../edit-mode/render/edit-mode-render-plan';
import { buildFfmpegArgs } from '../edit-mode/render/edit-mode-filtergraph';
import { buildEditModeAss } from '../edit-mode/render/edit-mode-ass';
import { validateRenderPlan } from '../edit-mode/render/edit-mode-render-validate';

/** Only source-local masking is new. Composition, text, codecs, color, and audio reuse the canonical engine. */
export function quickRender(input: PlanInput, p: ReframePlan, sourcePath: string, outputPath: string, preview=false) {
  const source=input.assets.find(a=>a.role==='SOURCE')!;
  const sw=source.width!,sh=source.height!;
  const dimensions=outputGeometry(p,sw,sh,preview);
  // Plan text in the final canvas, then uniformly rescale for a preview.
  const built=buildRenderPlan({...input,canvasOverride:dimensions,project:{...input.project,settings:{aspectRatio:'SOURCE',reframePolicy:'SOURCE',zoomPolicy:'OFF',subtitlePolicy:'OFF',gradingPolicy:'NONE'}}});
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
  const ass=buildEditModeAss(plan.canvas,[...plan.textOverlays,...plan.subtitles]);
  const assName=plan.textOverlays.length||plan.subtitles.length?'captions.ass':null;
  const args=buildFfmpegArgs({plan,sourcePath,outputPath,overlayPaths:{},audioPaths:{},assFileName:assName,informationCrop:null,fitExpression:'',informationFitExpression:'',cameraFilter,
    sourcePreparation:graph.length?{graph,videoLabel}:undefined,preserveSourceAudio:true});
  args.splice(args.indexOf('-i'),0,'-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm');
  return {args,ass:assName ? ass.content : null,plan};
}
