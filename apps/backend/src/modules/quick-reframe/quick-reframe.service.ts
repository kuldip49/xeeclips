import { UsageService } from '../auth/usage.service';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { randomUUID, createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, basename, extname } from 'path';
import type { ReframeEditPath, ReframeExport, ReframeHook, ReframeSession, ReframeSocialSource, ReframePostCopy } from '@ai-content-platform/shared';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import { EditModeService } from '../edit-mode/edit-mode.service';
import { editAssetStorageLocation } from '../edit-mode/edit-asset-storage';
import { DiskUploadSessionStore } from '../videos/disk-upload-session-store';
import { normalizeImportedMedia } from '../videos/media-normalize';
import { probeMedia } from '../processing/media-probe';
import { postAiServiceJson } from '../processing/ai-service-http';
import { LlmRouterService } from '../processing/llm-router.service';
import { sampleImageStats, type ImageStats } from '../editing/color-grade';
import { analyzeRegions, defaultPlan, isIdentityPreparation, preparationOf, record, subtitleStateFor, validatePlan, contains, overlap,
  type ReframeAnalysis, type ReframeBox, type ReframePlan } from './quick-reframe-plan';
import { preparationFingerprint, quickCleanRender, quickComposeRender, quickOutputCanvas, quickStyleCommands,
  QUICK_REFRAME_PIPELINE, type QuickStyle } from './quick-reframe-render';
import { prepareStyleTwoFonts } from '../edit-mode/render/style-two-fonts';
import { publicCreativePackage } from '../content-intelligence/creative-package.service';
import { INTELLIGENCE_VERSION } from '../content-intelligence/content-understanding.service';
import { retainedBoundaryQa } from '../content-intelligence/edit-project-evidence';
import { suggestHooks, HOOK_CATEGORIES } from './quick-reframe-hooks';
import { downloadSocial, MAX_REFRAME_BYTES, socialSource } from './social-source';
import { CAPTION_STYLES, emptyPostCopy, generatePostCopy, normalizeHashtags, REWRITE_DIRECTIONS, type PostCopyContext } from './quick-reframe-post-copy';
const exec=promisify(execFile);
const json=(v:unknown):Prisma.InputJsonValue=>JSON.parse(JSON.stringify(v));
const include={editProject:{include:{assets:true,elements:true}}};
type StyleOptions={hookText?:string;captions?:string};
/** Display name and canonical project layout of each automatic look Quick Reframe offers. */
const STYLES:Record<QuickStyle,{name:string;profile:string;template:string}>={
  STYLEONE:{name:'StyleOne',profile:'AUTOMATIC_2',template:'STYLEONE'},
  STYLETWO:{name:'StyleTwo',profile:'AUTOMATIC_3_STYLE_TWO',template:'STYLETWO'}};
/**
 * PLAYBACK readies the upload for the manual crop step (deterministic: probe/transcode only). ANALYZE is
 * the local AI pass (faces, OCR, Whisper); it only runs after the crop is confirmed and an editing mode chosen.
 */
type Task={id:string;operationId:string;kind:'PLAYBACK'|'ANALYZE'|'PREPARE'|'PREVIEW'|'EXPORT'|'IMPORT';url?:string;resolution?:720|1080;
  next?:QuickStyle;style?:StyleOptions};
type Loaded=Prisma.QuickReframeGetPayload<{include:typeof include}>;
type Asset=Loaded['editProject']['assets'][number];
const activeStatuses=['PLAYBACK','ANALYZE','PREPARE','PREVIEW','EXPORT','IMPORT'];
const IMAGE_EXTENSIONS:Record<string,string>={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp'};
const kindOf=(a:Asset)=>record(a.metadata).quickReframeKind as string|undefined;
const transcriptText=(t:unknown)=>{const r=record(t);if(typeof r.text==='string'&&r.text.trim())return r.text;
  return (Array.isArray(r.segments)?r.segments:[]).map((s:unknown)=>String(record(s).text??'')).join(' ').trim();};

@Injectable()
export class QuickReframeService implements OnModuleInit,OnModuleDestroy {
  private readonly logger=new Logger(QuickReframeService.name);
  private readonly connection=new IORedis(process.env.REDIS_URL||'redis://localhost:6379',{maxRetriesPerRequest:null});
  private readonly queue=new Queue<Task>('quick-reframe',{connection:this.connection});
  private worker?:Worker<Task>;
  private readonly aborts=new Map<string,AbortController>();
  readonly uploads:DiskUploadSessionStore;
  constructor(private readonly prisma:PrismaService,private readonly storage:StorageService,private readonly editor:EditModeService,private readonly router:LlmRouterService) {
    this.uploads=new DiskUploadSessionStore((manifest,file)=>this.ingest(manifest.projectId,file.path,file.originalname),'quick-reframe');
  }
  async onModuleInit(){
    // A committed claim without a queue entry means the previous process died before dispatch.
    // Manual-editor exports recover through their atomically persisted EditProject progress.
    const stranded = await this.prisma.quickReframe.findMany({ where: { operationId: { not: null }, status: { in: activeStatuses } }, include: { editProject: { select: { status: true } } } });
    for (const q of stranded) {
      if (q.status === 'EXPORT' && q.editProject.status === 'EXPORTING') continue;
      const queued = await this.queue.getJob(q.operationId!);
      if (!queued || ['failed','completed'].includes(await queued.getState())) {
        await this.prisma.quickReframe.updateMany({ where: { id: q.id, operationId: q.operationId }, data: { status: 'FAILED', operationId: null, error: 'Processing was interrupted. Retry to continue.', message: 'Processing interrupted' } });
        // Output settlement is atomic, so any still-reserved orphan has no delivered output.
        if(q.status === 'EXPORT') await new UsageService(this.prisma).settle(`reframe:${q.operationId}`, false);
      }
    }
    this.worker=new Worker<Task>('quick-reframe',job=>this.run(job.data),{connection:this.connection,concurrency:1,lockDuration:120000});
    this.worker.on('error',error=>this.logger.error(error.message));
    this.worker.on('failed',(job)=>{if(job)void this.prisma.quickReframe.updateMany({where:{id:job.data.id,operationId:job.data.operationId},data:{status:'FAILED',operationId:null,error:'Processing was interrupted. Retry to continue.',message:'Processing interrupted'}});});
  }
  async onModuleDestroy(){for(const c of this.aborts.values())c.abort();await this.worker?.close();await this.queue.close();await this.connection.quit();}
  async create(){
    const project=await this.prisma.editProject.create({data:{name:'Quick Reframe',settings:{feature:'QUICK_REFRAME',aspectRatio:'SOURCE',reframePolicy:'SOURCE',subtitlePolicy:'OFF',zoomPolicy:'OFF',gradingPolicy:'NONE'},quickReframe:{create:{}}},include:{quickReframe:true}});
    return this.get(project.quickReframe!.id);
  }
  private async load(id:string){const q=await this.prisma.quickReframe.findUnique({where:{id},include});if(!q)throw new NotFoundException('Quick Reframe video not found.');return q;}
  /** The uploaded file. Until a crop is baked, the SOURCE asset still is the original. */
  private originalOf(q:Loaded){const assets=q.editProject.assets;return assets.find(a=>kindOf(a)==='ORIGINAL')??assets.find(a=>a.role==='SOURCE');}
  private sourceOf(q:Loaded){return q.editProject.assets.find(a=>a.role==='SOURCE');}
  private latest(q:Loaded,kind:string){return q.editProject.assets.filter(a=>kindOf(a)===kind).sort((a,b)=>b.createdAt.getTime()-a.createdAt.getTime())[0];}
  private cropConfirmed(q:Loaded){const source=this.sourceOf(q);
    return !!source&&!!q.plan&&record(source.metadata).quickReframeKey===preparationFingerprint(preparationOf(q.plan as unknown as ReframePlan));}
  private view(q:Loaded):ReframeSession{
    const project=q.editProject;const source=this.sourceOf(q);const original=this.originalOf(q);
    const url=(a?:Asset)=>a?`/edit-mode/assets/${a.id}/file`:null;
    const preview=this.latest(q,'PREVIEW');const current=(a?:Asset)=>a&&record(a.metadata).pipeline===QUICK_REFRAME_PIPELINE?Number(record(a.metadata).sourceRevision):null;
    const exports:ReframeExport[]=project.assets.filter(a=>a.role==='EXPORT'&&kindOf(a)==='EXPORT').sort((a,b)=>b.createdAt.getTime()-a.createdAt.getTime())
      .map(a=>({id:a.id,url:url(a)!,revision:current(a),width:a.width,height:a.height,duration:a.duration,sizeBytes:Number(a.sizeBytes),createdAt:a.createdAt.toISOString(),current:current(a)===project.revision}));
    const settings=record(project.settings);
    const hooks=(Array.isArray(q.hooks)?q.hooks:[]).map((h:unknown,i:number):ReframeHook|null=>typeof h==='string'?{text:h,category:'PROFESSIONAL',score:0,recommended:i===0,source:'OPENAI'}
      :record(h).text&&HOOK_CATEGORIES.includes(record(h).category)?h as unknown as ReframeHook:null).filter((h):h is ReframeHook=>!!h);
    return {id:q.id,editProjectId:project.id,revision:project.revision,name:original?.originalName||'Quick Reframe',duration:original?.duration||0,
      width:original?.width||0,height:original?.height||0,originalUrl:url(this.latest(q,'SOURCE_PLAYBACK')||original),
      sourceUrl:url(source),sourceWidth:source?.width||0,sourceHeight:source?.height||0,
      cropConfirmed:this.cropConfirmed(q),confirmed:(q.confirmed??null) as ReframeSession['confirmed'],editPath:(q.editPath??null) as ReframeEditPath|null,
      // In a Quick Reframe project a card layout only ever comes from the style the user chose (V1 sessions included).
      styleOneApplied:record(settings.resolvedVisualLayout).editingProfile===STYLES.STYLEONE.profile,
      styleTwoApplied:record(settings.resolvedVisualLayout).editingProfile===STYLES.STYLETWO.profile,
      previewUrl:url(preview),exportUrl:exports[0]?.url??null,previewRevision:current(preview),exportRevision:exports[0]?.revision??null,exports,
      status:q.status,progress:q.progress,message:q.message,error:q.error,analysis:this.analysisOf(q),plan:q.plan as ReframeSession['plan'],hooks,
      sourceContext:q.sourceContext as ReframeSocialSource|null,postCopy:this.publicPostCopy(q),
      outputs:source?.width&&source.height&&this.cropConfirmed(q)?{720:quickOutputCanvas(project.settings,source.width,source.height,720),1080:quickOutputCanvas(project.settings,source.width,source.height,1080)}:null,
      hasAudio:record(original?.metadata).hasAudio===true,hasTranscript:!!transcriptText(original?.transcript??source?.transcript),
      captionCount:project.elements.filter(e=>e.type==='SUBTITLE').length,createdAt:q.createdAt.toISOString()};
  }
  private publicPostCopy(q:Loaded):ReframePostCopy {
    const { _intelligenceInternal: _internal, ...copy } = record(q.postCopy);
    return { ...emptyPostCopy(), ...copy } as ReframePostCopy;
  }
  /** Analysis is measured on the uploaded frame; the caption situation is reported for the confirmed crop. */
  private analysisOf(q:Loaded):ReframeSession['analysis']{
    if(!q.analysis)return null;const analysis=q.analysis as unknown as ReframeAnalysis;
    return {...analysis,subtitleState:subtitleStateFor(analysis,record(q.confirmed).crop as ReframeBox|undefined)};
  }
  /** The post-crop AI pass has not run yet (or did not finish) for this upload. */
  private needsAnalysis(q:Loaded){const original=this.originalOf(q);
    return !q.analysis||(record(original?.metadata).hasAudio===true&&original?.transcript==null&&this.sourceOf(q)?.transcript==null);}
  private frameOf(q:Loaded){const original=this.originalOf(q)!;return {width:original.width!,height:original.height!};}
  async get(id:string){return this.view(await this.load(id));}
  async forProject(editProjectId:string){const q=await this.prisma.quickReframe.findUnique({where:{editProjectId},include});if(!q)throw new NotFoundException('This project is not a Quick Reframe video.');return this.view(q);}
  async history(){const rows=await this.prisma.quickReframe.findMany({where:{editProject:{assets:{some:{role:'EXPORT',metadata:{path:['quickReframeKind'],equals:'EXPORT'}}}}},include,orderBy:{createdAt:'desc'}});return rows.map(q=>this.view(q));}
  async startUpload(id:string,body:Record<string,unknown>){const q=await this.load(id);if(q.editProject.assets.some(a=>a.role==='SOURCE'))throw new ConflictException('This video already has a source. Start a new Quick Reframe.');
    if(typeof body.size!=='number'||body.size>MAX_REFRAME_BYTES||!['.mp4','.mov','.m4v','.webm'].includes(extname(String(body.name)).toLowerCase()))throw new BadRequestException('Upload an MP4, MOV, M4V, or WebM up to 1 GiB.');
    await this.prisma.quickReframe.update({where:{id},data:{status:'INPUT',message:'Uploading video',error:null}});return this.uploads.create(id,body);}
  private async ingest(id:string,path:string,name:string,operationId?:string,sourceContext?:ReframeSocialSource){
    const q=await this.load(id);if(q.editProject.assets.some(a=>a.role==='SOURCE'))throw new ConflictException('This video already has a source.');
    let media;try{media=await probeMedia(path,{timeoutMs:15000,localOnly:true});}catch{throw new BadRequestException('This file could not be read. Upload a compatible MP4, MOV, or WebM.');}const size=(await stat(path)).size;
    if(!media.hasVideo||!media.width||!media.height||!media.durationSec||media.durationSec<=0)throw new BadRequestException('Upload a readable video file.');
    if(media.durationSec>180+1e-6)throw new BadRequestException('Quick Reframe accepts videos up to 180 seconds. This source was not trimmed.');
    if(size>MAX_REFRAME_BYTES||media.width<16||media.height<16||media.width*media.height>4096*2160)throw new BadRequestException('This video exceeds the supported file size or resolution.');
    const assetId=randomUUID();const key=`quick-reframe/${id}/${assetId}/source${extname(name).toLowerCase()||'.mp4'}`;
    const stored=await this.storage.uploadFile({filePath:path,objectKey:key,mimeType:'video/mp4'});
    try{
      await this.prisma.$transaction(async tx=>{
        const current=await tx.quickReframe.findUniqueOrThrow({where:{id},include:{editProject:{include:{assets:true}}}});
        if(operationId && current.operationId!==operationId)throw new Error('Canceled');
        if(current.editProject.assets.some(a=>a.role==='SOURCE'))throw new ConflictException('This video already has a source.');
        await tx.editAsset.create({data:{id:assetId,editProjectId:current.editProjectId,role:'SOURCE',...stored,originalName:basename(name).slice(0,255),mimeType:media.formatName?.includes('webm')?'video/webm':'video/mp4',sizeBytes:BigInt(size),duration:media.durationSec,width:media.width,height:media.height,fps:media.fps,metadata:{hasAudio:media.hasAudio,videoCodec:media.videoCodec,audioCodec:media.audioCodec}}});
        await tx.editElement.create({data:{editProjectId:current.editProjectId,assetId,type:'VIDEO',track:0,position:0,startTime:0,duration:media.durationSec!,trimEnd:media.durationSec}});
        await tx.editProject.update({where:{id:current.editProjectId},data:{revision:{increment:1}}});
        await tx.quickReframe.update({where:{id},data:{status:'INPUT',message:'Checking video',progress:100,error:null,operationId:null,...(sourceContext?{sourceContext:json(sourceContext)}:{})}});
      },{isolationLevel:'Serializable'});
      return this.get(id);
    }catch(error){await this.storage.removeObject(stored.bucket,stored.objectKey);throw error;}
  }
  async start(id:string,kind:Task['kind'],body:Record<string,unknown>={},chain:Pick<Task,'next'|'style'>={}){
    const q=await this.load(id);if(activeStatuses.includes(q.status))throw new ConflictException('Processing is already in progress.');
    if(kind!=='IMPORT' && !this.sourceOf(q))throw new BadRequestException('Upload a source video first.');
    if(kind==='PREPARE'){
      if(!q.plan)throw new BadRequestException('Wait for your video to load, then press Done Cropping.');
      validatePlan(q.plan,this.originalOf(q)!.duration!,this.frameOf(q),q.analysis as unknown as ReframeAnalysis|null);
    }
    // No AI runs while cropping: the analysis starts only after Done Cropping and an editing mode.
    if(kind==='ANALYZE'){
      if(!this.cropConfirmed(q))throw new BadRequestException('Confirm the crop first.');
      if(!q.editPath&&!chain.next)throw new BadRequestException('Choose StyleOne, StyleTwo or Manual editing first.');
    }
    if(kind==='EXPORT'||kind==='PREVIEW'){
      if(!this.cropConfirmed(q))throw new BadRequestException('Confirm the crop first.');
      if(!q.editPath)throw new BadRequestException('Choose StyleOne, StyleTwo or Manual editing first.');
      if(body.revision!==q.editProject.revision)throw new ConflictException('Your edits changed. Refresh and try again.');
    }
    const resolution=body.resolution===720?720:1080;
    let url:string|undefined;
    if(kind==='IMPORT') {if(body.authorized!==true)throw new BadRequestException('Confirm that you are authorized to process this video.');url=socialSource(body.url).url;
      if(q.editProject.assets.length)throw new ConflictException('Start a new Quick Reframe to import another video.');
      if(process.env.QUICK_REFRAME_SOCIAL_IMPORT_APPROVED!=='true')throw new BadRequestException('Automatic social import is unavailable. Upload your authorized video file instead.');}
    const operationId=randomUUID();
    const message={PLAYBACK:'Preparing your video for cropping',ANALYZE:chain.next?`Checking speech and captions for ${STYLES[chain.next].name}`:'Checking speech and on-screen captions',IMPORT:'Checking video',PREPARE:'Applying your crop',PREVIEW:'Rendering preview',EXPORT:`Exporting ${resolution}p video`}[kind];
    const claimed=await this.prisma.$transaction(async tx=>{
      const result=await tx.quickReframe.updateMany({where:{id,status:q.status,operationId:q.operationId},data:{status:kind,operationId,message,progress:5,error:null}});
      if(result.count&&kind==='EXPORT')await new UsageService(this.prisma).reserve(tx,q.editProject.userId,`reframe:${operationId}`,'QUICK_REFRAME',id);
      return result;
    });
    if(!claimed.count)throw new ConflictException('Another operation started. Refresh this video.');
    try{await this.queue.add(kind,{id,operationId,kind,url,resolution,...chain},{jobId:operationId,attempts:1,removeOnComplete:100,removeOnFail:100});}
    catch{await this.prisma.quickReframe.updateMany({where:{id,operationId},data:{status:'FAILED',error:'Processing could not start. Please retry.',operationId:null}});await new UsageService(this.prisma).settle(`reframe:${operationId}`,false);throw new BadRequestException('Processing could not start. Please retry.');}
    return this.get(id);
  }
  private async stage(task:Task,message:string,progress:number,data:Prisma.QuickReframeUpdateManyMutationInput={}){
    const update=await this.prisma.quickReframe.updateMany({where:{id:task.id,operationId:task.operationId},data:{message,progress,...data}});
    if(!update.count)throw new Error('Canceled');
  }
  private async retryWriteConflict<T>(write:()=>Promise<T>):Promise<T>{
    for(let attempt=0;;attempt++)try{return await write();}catch(error){
      if(!(error instanceof Prisma.PrismaClientKnownRequestError)||error.code!=='P2034'||attempt>=2)throw error;
    }
  }
  private async post(path:string,body:Record<string,unknown>,signal?:AbortSignal){const response=await postAiServiceJson(`${process.env.AI_SERVICE_URL||'http://localhost:8000'}${path}`,body,600000,signal);if(!response.ok)throw new Error('Local analysis unavailable');return response.json();}
  private async run(task:Task){
    const controller=new AbortController();this.aborts.set(task.id,controller);const dir=await mkdtemp(join(tmpdir(),'quick-reframe-'));let uploaded:{bucket:string;objectKey:string}|null=null;
    try{
      const q=await this.load(task.id);if(q.operationId!==task.operationId)return;
      if(task.kind==='IMPORT'){const path=join(dir,'import.mp4');const context=await downloadSocial(task.url,path,controller.signal);await this.ingest(task.id,path,'Imported video.mp4',task.operationId,context);return;}
      if(task.kind==='PLAYBACK'){await this.playback(task,q,dir,controller.signal,(v)=>{uploaded=v;});return;}
      if(task.kind==='ANALYZE'){await this.analyze(task,q,controller.signal);if(task.next)await this.continueStyle(task);return;}
      if(task.kind==='PREPARE'){await this.prepare(task,q,dir,controller.signal,(v)=>{uploaded=v;});return;}
      await this.compose(task,q,dir,controller.signal,(v)=>{uploaded=v;});
      if(task.kind==='EXPORT')await new UsageService(this.prisma).settle(`reframe:${task.operationId}`,true);
    }catch(error){this.logger.warn(`Quick Reframe ${task.kind} failed: ${error instanceof Error?error.message:String(error)}`);
      const message=error instanceof BadRequestException?error.message:task.kind==='IMPORT'?'This link could not be imported. Upload your authorized video file instead.':'Processing could not finish. Retry or upload another copy of the video.';
      await this.prisma.quickReframe.updateMany({where:{id:task.id,operationId:task.operationId},data:{status:'FAILED',error:message,message,operationId:null}});
      if(task.kind==='EXPORT')await new UsageService(this.prisma).settle(`reframe:${task.operationId}`,false);
    }finally{if(uploaded)await this.storage.removeObject((uploaded as {bucket:string}).bucket,(uploaded as {objectKey:string}).objectKey).catch(()=>undefined);this.aborts.delete(task.id);await rm(dir,{recursive:true,force:true});}
  }
  /**
   * Readies the upload for manual cropping: a browser-playable copy when the codec needs one, and the
   * whole-frame crop draft. Deterministic media handling only; no detection or suggestion runs here.
   */
  private async playback(task:Task,q:Loaded,dir:string,signal:AbortSignal,track:(v:{bucket:string;objectKey:string}|null)=>void){
    const original=this.originalOf(q)!;const meta=record(original.metadata);
    if((meta.videoCodec!=='h264' || meta.hasAudio && meta.audioCodec!=='aac') && !this.latest(q,'SOURCE_PLAYBACK')){
      const input=join(dir,'original.video');const at=editAssetStorageLocation(original);await this.storage.downloadToFile(at.bucket,at.objectKey,input);
      const normalized=await normalizeImportedMedia(input,dir,signal,{allowSilent:true,localOnly:true,timeoutMs:600000});
      if(normalized.action!=='none'){
        await this.stage(task,'Preparing browser playback',15);const playbackId=randomUUID();const stored=await this.storage.uploadFile({filePath:normalized.filePath,objectKey:`quick-reframe/${task.id}/${playbackId}/playback.mp4`,mimeType:'video/mp4'});track(stored);
        await this.prisma.$transaction(async tx=>{const current=await tx.quickReframe.findUniqueOrThrow({where:{id:task.id}});if(current.operationId!==task.operationId)throw new Error('Canceled');await tx.editAsset.create({data:{id:playbackId,editProjectId:q.editProjectId,role:'REFERENCE',...stored,originalName:'Original preview.mp4',mimeType:'video/mp4',sizeBytes:BigInt(normalized.size),duration:normalized.probe.durationSec,width:normalized.probe.width,height:normalized.probe.height,metadata:{quickReframeKind:'SOURCE_PLAYBACK'}}});});track(null);
      }
    }
    await this.stage(task,'Adjust the crop, then press Done Cropping',100,{...(q.plan?{}:{plan:json(defaultPlan())}),status:this.cropConfirmed(q)?'CROPPED':'CROPPING',operationId:null});
  }
  /**
   * Local-only AI pass, after the crop is confirmed and an editing mode chosen: faces/OCR on the uploaded
   * frame (cached, so a re-crop never repeats it) and Whisper. Nothing here changes the crop.
   */
  private async analyze(task:Task,q:Loaded,signal:AbortSignal){
    const original=this.originalOf(q)!;const meta=record(original.metadata);
    let raw:unknown=original.analysis,transcript:unknown=original.transcript;
    await this.stage(task,'Checking on-screen captions',25);
    const at=editAssetStorageLocation(original);
    if(!raw){raw=json(await this.post('/quick-reframe-analysis',{bucket:at.bucket,object_key:at.objectKey},signal));}
    const analysis=analyzeRegions(raw,original.duration!);
    await this.stage(task,'Transcribing speech for captions and hooks',60);
    if(!transcript && meta.hasAudio){transcript=json(await this.post('/transcriptions',{bucket:at.bucket,object_key:at.objectKey,task:'transcribe'},signal));}
    const source=this.sourceOf(q)!;
    await this.prisma.editAsset.update({where:{id:original.id},data:{analysis:json(raw),transcript:transcript?json(transcript):undefined}});
    // A baked SOURCE keeps the original's timing, so it shares the transcript (captions, ducking).
    if(source.id!==original.id&&transcript&&!source.transcript)await this.prisma.editAsset.update({where:{id:source.id},data:{transcript:json(transcript)}});
    // Chained into a style, the operation stays claimed so the browser never sees an idle gap.
    if(task.next)await this.stage(task,`Applying ${STYLES[task.next].name}`,90,{analysis:json(analysis)});
    else await this.stage(task,'Video checked',100,{analysis:json(analysis),status:q.editPath==='MANUAL'?'EDITING':'ANALYZED',operationId:null});
  }
  /** A style chosen before the analysis existed: apply it now. A failure is reported like any job failure. */
  private async continueStyle(task:Task){
    const name=STYLES[task.next!].name;
    try{const q=await this.load(task.id);if(q.operationId!==task.operationId)return;
      await this.applyStyle(task.id,{...task.style,revision:q.editProject.revision},task.next!,true);}
    catch(error){this.logger.warn(`Quick Reframe ${name} failed: ${error instanceof Error?error.message:String(error)}`);
      const message=error instanceof BadRequestException?error.message:`${name} could not be applied. Choose it again to retry.`;
      await this.prisma.quickReframe.updateMany({where:{id:task.id,operationId:task.operationId},data:{status:'FAILED',error:message,message,operationId:null}});}
  }
  /**
   * Bakes the confirmed crop/cleanup into SOURCE. The SOURCE row keeps its id (so every element,
   * history snapshot and undo step stays valid); only its storage and dimensions change. The
   * uploaded file is kept as an ORIGINAL reference, so the crop can be re-edited at any time.
   */
  private async prepare(task:Task,q:Loaded,dir:string,signal:AbortSignal,track:(v:{bucket:string;objectKey:string}|null)=>void){
    const original=this.originalOf(q)!;const source=this.sourceOf(q)!;
    const p=validatePlan(q.plan,original.duration!,this.frameOf(q),q.analysis as unknown as ReframeAnalysis|null);const prep=preparationOf(p);const key=preparationFingerprint(prep);
    const baked=source.id!==original.id;
    const needBake=!isIdentityPreparation(prep)||!!this.latest(q,'SOURCE_PLAYBACK');
    const finish=async(tx:Prisma.TransactionClient)=>{
      const current=await tx.quickReframe.findUniqueOrThrow({where:{id:task.id}});if(current.operationId!==task.operationId)throw new Error('Canceled');
      const project=await tx.editProject.update({where:{id:q.editProjectId},data:{revision:{increment:1}}});
      // Logged under its own action: canonical undo replays only edit actions, so it never undoes a crop.
      await tx.editHistory.create({data:{editProjectId:q.editProjectId,revision:project.revision,actor:'USER',action:'QUICK_REFRAME_SOURCE_PREPARED',command:json({preparation:prep}),beforeState:json({confirmed:q.confirmed}),afterState:json({confirmed:prep})}});
      await tx.quickReframe.update({where:{id:task.id},data:{confirmed:json(prep),status:'CROPPED',message:'Crop confirmed',progress:100,operationId:null,error:null}});
    };
    if(record(source.metadata).quickReframeKey===key){await this.retryWriteConflict(()=>this.prisma.$transaction(finish,{isolationLevel:'Serializable'}));return;}
    const originalAt=editAssetStorageLocation(original),sourceAt=editAssetStorageLocation(source);
    if(!needBake){
      // Back to the uploaded pixels: SOURCE points at the original object again.
      await this.retryWriteConflict(()=>this.prisma.$transaction(async tx=>{
        if(baked){
          await tx.editAsset.delete({where:{id:original.id}});
          await tx.editAsset.update({where:{id:source.id},data:{bucket:originalAt.bucket,objectKey:originalAt.objectKey,storageObjectKey:null,storageOwnership:original.storageOwnership,mimeType:original.mimeType,sizeBytes:original.sizeBytes,width:original.width,height:original.height,fps:original.fps,
            metadata:json({...record(original.metadata),quickReframeKind:undefined,quickReframeKey:key}),analysis:original.analysis??Prisma.DbNull,transcript:original.transcript??Prisma.DbNull}});
        }else await tx.editAsset.update({where:{id:source.id},data:{metadata:json({...record(source.metadata),quickReframeKey:key})}});
        await finish(tx);
      },{isolationLevel:'Serializable'}));
      if(baked)await this.storage.removeObject(sourceAt.bucket,sourceAt.objectKey).catch(()=>undefined);
      return;
    }
    const input=join(dir,'original.video'),out=join(dir,'source.mp4');
    await this.stage(task,'Applying your crop to the full video',15);
    await this.storage.downloadToFile(originalAt.bucket,originalAt.objectKey,input);
    const hasAudio=record(original.metadata).hasAudio===true;
    const pixels={...original,role:'SOURCE' as const};
    const prepared=quickCleanRender({project:{id:q.editProjectId,revision:q.editProject.revision,settings:{}},assets:[pixels],
      elements:[{id:'quick-reframe-original',assetId:original.id,type:'VIDEO',track:0,position:0,startTime:0,duration:original.duration!,trimStart:0,trimEnd:original.duration!,properties:{}}],
      hasSourceAudio:hasAudio,fps:Math.min(30,original.fps||30)},p,input,out);
    await exec('ffmpeg',prepared.args,{cwd:dir,timeout:600000,maxBuffer:10*1024*1024,signal});
    const media=await this.validateOutput(out,original.duration!,prepared.plan.canvas,hasAudio,signal);
    await this.stage(task,'Crop verified',80);
    const stored=await this.storage.uploadFile({filePath:out,objectKey:`quick-reframe/${task.id}/${randomUUID()}/source.mp4`,mimeType:'video/mp4'});track(stored);
    const size=(await stat(out)).size;
    await this.retryWriteConflict(()=>this.prisma.$transaction(async tx=>{
      // A distinct identity key; storageObjectKey names the real (still owned) uploaded object.
      if(!baked)await tx.editAsset.create({data:{editProjectId:q.editProjectId,role:'REFERENCE',originalName:original.originalName,bucket:originalAt.bucket,objectKey:`${originalAt.objectKey}#original`,storageObjectKey:originalAt.objectKey,storageOwnership:original.storageOwnership,
        mimeType:original.mimeType,sizeBytes:original.sizeBytes,duration:original.duration,width:original.width,height:original.height,fps:original.fps,
        metadata:json({...record(original.metadata),quickReframeKey:undefined,quickReframeKind:'ORIGINAL'}),analysis:original.analysis??Prisma.DbNull,transcript:original.transcript??Prisma.DbNull,sourceVideoId:original.sourceVideoId}});
      // Duration stays the original's: the timeline is unchanged and every trim remains valid.
      await tx.editAsset.update({where:{id:source.id},data:{...stored,storageObjectKey:null,storageOwnership:'OWNED',mimeType:'video/mp4',sizeBytes:BigInt(size),width:media.width,height:media.height,fps:media.fps,
        metadata:json({hasAudio:media.hasAudio,videoCodec:media.videoCodec,audioCodec:media.audioCodec,quickReframeKey:key,quickReframeBaked:true}),
        analysis:Prisma.DbNull,transcript:(source.transcript??original.transcript)??Prisma.DbNull}});
      await finish(tx);
    },{isolationLevel:'Serializable'}));track(null);
    // The previous baked file is derived and owned by this session; the ORIGINAL is never removed.
    if(baked)await this.storage.removeObject(sourceAt.bucket,sourceAt.objectKey).catch(()=>undefined);
  }
  /** Preview/export: the canonical composition of the confirmed SOURCE, for either editing path. */
  private async compose(task:Task,q:Loaded,dir:string,signal:AbortSignal,track:(v:{bucket:string;objectKey:string}|null)=>void){
    const source=this.sourceOf(q)!;const project=q.editProject;
    if(!this.cropConfirmed(q))throw new BadRequestException('Confirm the crop first.');
    const style:QuickStyle|null=q.editPath==='STYLEONE'||q.editPath==='STYLETWO'?q.editPath:null;const preview=task.kind==='PREVIEW';const resolution=task.resolution??1080;
    const sourcePath=join(dir,'source.mp4'),out=join(dir,'output.mp4');
    await this.stage(task,preview?'Rendering preview':`Exporting ${resolution}p video`,15);
    const sourceAt=editAssetStorageLocation(source);await this.storage.downloadToFile(sourceAt.bucket,sourceAt.objectKey,sourcePath);
    const probe=await probeMedia(sourcePath,{timeoutMs:15000,localOnly:true});
    let imageStats:ImageStats|null=null;try{imageStats=await sampleImageStats(sourcePath);}catch{imageStats=null;}
    const overlayPaths:Record<string,string>={},audioPaths:Record<string,string>={};
    for(const element of project.elements){
      if(!element.assetId||(element.type!=='IMAGE'&&element.type!=='AUDIO'))continue;
      const asset=project.assets.find(a=>a.id===element.assetId);if(!asset)throw new BadRequestException('An overlay or audio file is missing. Remove it in the editor and retry.');
      const target=element.type==='IMAGE'?overlayPaths:audioPaths;if(target[element.id])continue;
      const path=join(dir,`asset-${element.id}${element.type==='IMAGE'?IMAGE_EXTENSIONS[asset.mimeType]??'.png':'.bin'}`);
      const at=editAssetStorageLocation(asset);await this.storage.downloadToFile(at.bucket,at.objectKey,path);target[element.id]=path;
    }
    const canvas=quickOutputCanvas(project.settings,source.width!,source.height!,preview?540:resolution);
    const rendered=quickComposeRender({project:{id:project.id,revision:project.revision,settings:project.settings},canvasOverride:canvas,
      assets:project.assets.map(a=>({id:a.id,role:a.role,mimeType:a.mimeType,duration:a.duration,width:a.width,height:a.height,fps:a.fps,metadata:a.metadata,transcript:a.transcript,analysis:a.analysis})),
      elements:project.elements.map(e=>({id:e.id,assetId:e.assetId,type:e.type,track:e.track,position:e.position,startTime:e.startTime,duration:e.duration,trimStart:e.trimStart,trimEnd:e.trimEnd,properties:e.properties})),
      imageStats,hasSourceAudio:probe.hasAudio,fps:Math.max(1,Math.min(30,Math.round(probe.fps??30)))},sourcePath,out,{overlayPaths,audioPaths},style,
      {fontsDir:style==='STYLETWO'?await prepareStyleTwoFonts(dir):undefined});
    if(preview){const i=rendered.args.indexOf('-preset');if(i>=0)rendered.args[i+1]='veryfast';}
    if(rendered.ass)await writeFile(join(dir,'captions.ass'),rendered.ass);
    await this.stage(task,preview?'Rendering preview':`Exporting ${resolution}p video`,30);
    await exec('ffmpeg',rendered.args,{cwd:dir,timeout:900000,maxBuffer:20*1024*1024,signal});
    const audible=(rendered.plan.hasSourceAudio&&rendered.plan.videoSegments.some(s=>!s.sourceMuted&&s.sourceVolume>0))||rendered.plan.audioTracks.some(t=>!t.muted&&t.volume>0&&audioPaths[t.elementId]);
    const media=await this.validateOutput(out,rendered.plan.durationSec,canvas,audible,signal);
    await this.stage(task,preview?'Preview verified':'Export verified',90);
    const assetId=randomUUID();const stored=await this.storage.uploadFile({filePath:out,objectKey:`quick-reframe/${task.id}/${assetId}/${task.kind.toLowerCase()}.mp4`,mimeType:'video/mp4'});track(stored);
    const size=(await stat(out)).size;
    await this.prisma.$transaction(async tx=>{
      const current=await tx.quickReframe.findUniqueOrThrow({where:{id:task.id}});if(current.operationId!==task.operationId)throw new Error('Canceled');
      await tx.editAsset.create({data:{id:assetId,editProjectId:q.editProjectId,...stored,role:preview?'REFERENCE':'EXPORT',originalName:'Quick Reframe.mp4',mimeType:'video/mp4',sizeBytes:BigInt(size),width:media.width,height:media.height,duration:media.durationSec,fps:media.fps,
        metadata:json({quickReframeKind:task.kind,sourceRevision:project.revision,operationId:task.operationId,pipeline:QUICK_REFRAME_PIPELINE,editPath:q.editPath,resolution:preview?null:resolution,sourceKey:record(source.metadata).quickReframeKey,
          codec:{video:media.videoCodec,audio:media.audioCodec??null},hasAudio:media.hasAudio})}});
      await tx.quickReframe.update({where:{id:task.id},data:{status:preview?'READY':'COMPLETE',message:preview?'Preview ready':'Export complete',progress:100,operationId:null,error:null}});
      if(!preview)await new UsageService(this.prisma).settleInTransaction(tx,`reframe:${task.operationId}`,true);
    });track(null);
    // Previews are owned and bounded; final exports persist until deletion.
    if(preview)for(const old of project.assets.filter(a=>kindOf(a)==='PREVIEW')){await this.storage.removeObject(old.bucket,old.objectKey).catch(()=>undefined);await this.prisma.editAsset.deleteMany({where:{id:old.id}});}
  }
  private async validateOutput(path:string,duration:number,canvas:{width:number;height:number},requireAudio:boolean,signal:AbortSignal){
    const media=await probeMedia(path,{timeoutMs:15000,localOnly:true});
    if(!media.hasVideo||media.videoCodec!=='h264'||Math.abs((media.durationSec||0)-duration)>.25||media.width!==canvas.width||media.height!==canvas.height||(requireAudio&&!media.hasAudio)||media.hasAudio&&media.audioCodec!=='aac')throw new Error(`Output validation failed (${media.width}x${media.height}, ${media.durationSec}s, ${media.videoCodec}/${media.audioCodec})`);
    await exec('ffmpeg',['-v','error','-xerror','-i',path,'-f','null','-'],{timeout:300000,maxBuffer:1024*1024,signal});return media;
  }
  /** Saves the crop-step draft. It never touches the canonical timeline. */
  async save(id:string,body:Record<string,unknown>){
    const q=await this.load(id);if(activeStatuses.includes(q.status))throw new ConflictException('Wait for processing to finish before editing.');
    const original=this.originalOf(q);if(!original)throw new BadRequestException('Upload a video first.');
    const p=validatePlan(body.plan,original.duration!,this.frameOf(q),q.analysis as unknown as ReframeAnalysis|null);
    const undo=Array.isArray(q.undo)?q.undo:[];
    await this.prisma.quickReframe.update({where:{id},data:{plan:json(p),undo:json([...undo,...(q.plan?[q.plan]:[])].slice(-30)),redo:json([]),error:null,...(q.status==='FAILED'||q.status==='CANCELED'?{status:this.cropConfirmed(q)?'CROPPED':'CROPPING',message:''}:{})}});
    return this.get(id);
  }
  async undo(id:string,redo=false){const q=await this.load(id);if(activeStatuses.includes(q.status))throw new ConflictException('Wait for processing to finish.');const from=(redo?q.redo:q.undo) as unknown[];const to=(redo?q.undo:q.redo) as unknown[];
    if(!Array.isArray(from)||!from.length)throw new BadRequestException(redo?'Nothing to redo.':'No more crop changes to undo.');const p=validatePlan(from[from.length-1],this.originalOf(q)!.duration!,this.frameOf(q),q.analysis as unknown as ReframeAnalysis|null);
    await this.prisma.quickReframe.update({where:{id},data:{plan:json(p),undo:json(redo?[...(Array.isArray(to)?to:[]),q.plan]:from.slice(0,-1)),redo:json(redo?from.slice(0,-1):[...(Array.isArray(to)?to:[]),q.plan])}});return this.get(id);}
  /** Restores the last confirmed crop into the draft (crop step "Cancel"). */
  async revert(id:string){const q=await this.load(id);if(!q.confirmed||!q.plan)return this.get(id);const c=record(q.confirmed);const p=q.plan as unknown as ReframePlan;
    return this.save(id,{plan:{...p,aspect:c.aspect,crop:c.crop,framing:c.framing,cleanup:c.cleanup,color:{...p.color,denoise:c.denoise===true}}});}
  /** Shared ranked hook suggestions; external generation requires explicit consent. */
  async hooks(id:string,body:Record<string,unknown>){
    const q=await this.load(id);const original=this.originalOf(q);if(!original)throw new BadRequestException('Upload a video first.');
    if(!this.cropConfirmed(q))throw new BadRequestException('Confirm the crop first.');
    if(!q.editPath)throw new BadRequestException('Choose StyleOne, StyleTwo or Manual editing first.');
    if(activeStatuses.includes(q.status))throw new ConflictException('Wait for processing to finish.');
    const external=body.externalAiAuthorized===true;
    if(this.needsAnalysis(q)&&record(original.metadata).hasAudio===true)throw new BadRequestException(activeStatuses.includes(q.status)?'XeeClip is still checking the speech in your video. Try again in a moment.':'Check the video first, then ask for hook suggestions.');
    const exclude=Array.isArray(body.exclude)?body.exclude.filter((t):t is string=>typeof t==='string').map(t=>t.slice(0,200)).slice(0,30):[];
    const context=this.postCopyContext(q,body);
    const category=typeof body.category==='string'&&HOOK_CATEGORIES.includes(body.category as never)?body.category as ReframeHook['category']:undefined;
    const {hooks,warnings,package:p}=await suggestHooks(this.router,context.transcript,external,exclude,
      {sourceId:context.sourceId,transcriptVersion:context.transcriptVersion,visualVersion:context.visualVersion,
       visibleText:[context.visibleText,context.subtitleText].filter(Boolean).join('\n'),sceneType:context.sceneType,visualSummary:context.visualSummary,
       speakerTurns:context.speakerTurns,template:context.template,boundaryQa:context.boundaryQa,
       sourceTitle:context.sourceContext?.sourcePostTitle,sourceCaption:context.sourceContext?.sourcePostText,sourceHashtags:context.sourceContext?.sourceHashtags},
      typeof body.direction==='string'?body.direction.slice(0,500):'',category,context.selectedHook);
    // Regenerate with nothing new keeps the current list rather than emptying it.
    if(hooks.length||!exclude.length){const saved=await this.prisma.quickReframe.updateMany({where:{id,postCopy:{equals:q.postCopy as Prisma.InputJsonValue},editProject:{revision:q.editProject.revision},status:q.status,operationId:q.operationId},data:{hooks:json(hooks),externalAiAuthorized:external,
      postCopy:json({...emptyPostCopy(),...record(q.postCopy),version:(Number(record(q.postCopy).version)||0)+1,
        creativePackage:{...record(record(q.postCopy).creativePackage),version:p.version,understanding:p.understanding,hooks:p.hooks,selectedHook:p.selectedHook,status:p.status,boundaryQa:p.boundaryQa},contentUnderstandingVersion:INTELLIGENCE_VERSION,_intelligenceInternal:p.internal})}});if(!saved.count)throw new ConflictException('The video or post copy changed. Refresh and try again.');}
    return {session:await this.get(id),warnings};
  }
  /** Use only content retained by the confirmed crop and canonical timeline. Original post text is supporting context. */
  private postCopyContext(q:Loaded,body:Record<string,unknown>):PostCopyContext {
    const source=this.sourceOf(q)!;const original=this.originalOf(q)!;
    const clips=q.editProject.elements.filter(e=>e.type==='VIDEO'&&e.assetId===source.id&&record(e.properties).hidden!==true);
    const ranges=clips.map(e=>({start:e.trimStart??0,end:e.trimEnd??((e.trimStart??0)+e.duration)}));
    const kept=(start:number,end:number)=>ranges.some(r=>start<r.end&&end>r.start);
    const transcript=record(source.transcript??original.transcript);
    const segments=Array.isArray(transcript.segments)?transcript.segments:[];
    const speech=segments.length?segments.flatMap(s=>{const segment=record(s);const words=Array.isArray(segment.words)?segment.words:[];return words.length?words.filter(w=>ranges.some(r=>Number(record(w).start)>=r.start-.001&&Number(record(w).end)<=r.end+.001)).map(w=>String(record(w).text??'')):ranges.some(r=>Number(segment.start)>=r.start-.001&&Number(segment.end)<=r.end+.001)?[String(segment.text??'')]:[];}).join(' ')
      :ranges.some(r=>r.start<=.01&&r.end>=original.duration!-.01)?transcriptText(transcript):'';
    const preparation=record(q.confirmed) as ReframePlan;
    const regions=(q.analysis as unknown as ReframeAnalysis|null)?.regions??[];
    const retained=regions.filter(r=>r.text&&r.confidence>=.65&&r.kind!=='ATTRIBUTION'&&kept(r.start,r.end)&&contains(preparation.crop,r)
      &&!(preparation.cleanup??[]).some(c=>c.start<r.end&&c.end>r.start&&overlap(c,r)>.001));
    const unique=(lines:string[])=>[...new Set(lines)].join('\n');
    const subtitles=q.editProject.elements.filter(e=>e.type==='SUBTITLE'&&record(e.properties).hidden!==true).map(e=>String(record(e.properties).content??record(e.properties).text??''));
    const hook=q.editProject.elements.find(e=>e.type==='TEXT'&&record(e.properties).presetRole==='HOOK'&&record(e.properties).hidden!==true);
    const copy={...emptyPostCopy(),...record(q.postCopy)};
    return {sourceId:source.id,transcriptVersion:createHash('sha256').update(JSON.stringify({transcript:source.transcript??original.transcript,ranges})).digest('hex'),
      boundaryQa:retainedBoundaryQa(segments,ranges,source.duration??original.duration??undefined),
      speakerTurns:segments.map(record).filter(s=>typeof s.speaker==='string'&&ranges.some(r=>Number(s.start)>=r.start-.001&&Number(s.end)<=r.end+.001)).map(s=>({speaker:String(s.speaker),text:String(s.text??'')})),
      template:q.editPath ?? 'MANUAL',
      visualVersion:createHash('sha256').update(JSON.stringify({confirmed:q.confirmed,regions:retained})).digest('hex'),sceneType:regions.length?'video with on-screen text':'',
      visualSummary:retained.map(r=>r.kind+': '+r.text).join('; ').slice(0,1200),transcript:speech,visibleText:unique(retained.filter(r=>r.kind!=='CAPTION').map(r=>r.text)),
      subtitleText:unique([...retained.filter(r=>r.kind==='CAPTION').map(r=>r.text),...subtitles]),sourceContext:q.sourceContext as ReframeSocialSource|null,
      selectedHook:hook?String(record(hook.properties).content??''):'',editingDirection:typeof body.editingDirection==='string'?body.editingDirection.slice(0,500):copy.editingDirection??'',
      purpose:typeof body.purpose==='string'?body.purpose.slice(0,500):copy.purpose??'',selectedCaption:copy.selectedCaption};
  }
  private assertPostCopy(q:Loaded,body:Record<string,unknown>){
    this.assertEditable(q,body.revision);
    if(!q.editPath)throw new BadRequestException('Choose StyleOne, StyleTwo or Manual editing first.');
    if(body.version!==(record(q.postCopy).version??0))throw new ConflictException('Post copy changed. Refresh before saving.');
  }
  private async writePostCopy(q:Loaded,copy:ReframePostCopy){
    const result=await this.prisma.quickReframe.updateMany({where:{id:q.id,postCopy:{equals:q.postCopy as Prisma.InputJsonValue},
      editProject:{revision:q.editProject.revision},status:q.status,operationId:q.operationId},data:{postCopy:json(copy)}});
    if(!result.count)throw new ConflictException('The video or post copy changed. Refresh and try again.');
    return this.get(q.id);
  }
  async generateCopy(id:string,body:Record<string,unknown>){
    const q=await this.load(id);this.assertPostCopy(q,body);
    if(this.needsAnalysis(q))throw new BadRequestException('Check video speech and on-screen text first.');
    const rewrite=body.rewrite;
    if(rewrite!==undefined&&(!(REWRITE_DIRECTIONS as readonly unknown[]).includes(rewrite)||!record(q.sourceContext).sourcePostText))throw new BadRequestException('Choose a rewrite direction for an imported post caption.');
    const context=this.postCopyContext(q,body);
    const result=await generatePostCopy(this.router,context,body.externalAiAuthorized===true,typeof rewrite==='string'?rewrite:'');
    const prior={...emptyPostCopy(),...record(q.postCopy)} as ReframePostCopy;
    const hashtagOnly=body.hashtagsOnly===true;
    const copy:ReframePostCopy={...prior,version:prior.version+1,generatedCaptions:hashtagOnly?prior.generatedCaptions:result.generatedCaptions,generatedHashtagSets:result.generatedHashtagSets,
      understanding:result.understanding,synopsis:result.synopsis,creativePackage:result.creativePackage,contentUnderstandingVersion:INTELLIGENCE_VERSION,editingDirection:context.editingDirection,purpose:context.purpose,contextRevision:q.editProject.revision,
      selectedCaption:prior.selectedCaption||(!hashtagOnly?result.generatedCaptions.find(c=>c.recommended)?.text:'')||'',
      selectedHashtags:prior.selectedHashtags.length?prior.selectedHashtags:result.generatedHashtagSets[0]?.hashtags??[]};
    return {session:await this.writePostCopy(q,{...copy,_intelligenceInternal:result.internal} as ReframePostCopy),warnings:result.warnings};
  }
  async saveCopy(id:string,body:Record<string,unknown>){
    const q=await this.load(id);this.assertPostCopy(q,body);
    if(typeof body.selectedCaption!=='string'||body.selectedCaption.length>2200||!Array.isArray(body.selectedHashtags)||body.selectedHashtags.length>15
      ||body.selectedHashtags.some(t=>typeof t!=='string'||!/^#?[\p{L}\p{N}_]{1,60}$/u.test(t)))throw new BadRequestException('Use a Social Caption up to 2200 characters and up to 15 valid hashtags.');
    const copy={...emptyPostCopy(),...record(q.postCopy)} as ReframePostCopy;
    if(body.captionStyle!==undefined&&!(CAPTION_STYLES as readonly unknown[]).includes(body.captionStyle))throw new BadRequestException('Choose a valid Social Caption style.');
    return this.writePostCopy(q,{...copy,version:copy.version+1,selectedCaption:body.selectedCaption.trim(),selectedHashtags:normalizeHashtags(body.selectedHashtags),
      generatedCaptions:copy.generatedCaptions.map(c=>c.style===body.captionStyle?{...c,text:body.selectedCaption as string}:c)});
  }
  private assertEditable(q:Loaded,revision:unknown,claimed=false){
    if(!claimed&&activeStatuses.includes(q.status))throw new ConflictException('Wait for processing to finish.');
    if(!this.cropConfirmed(q))throw new BadRequestException('Confirm the crop first.');
    if(revision!==q.editProject.revision)throw new ConflictException('Your edits changed. Refresh and try again.');
  }
  /**
   * Applies the actual StyleOne / StyleTwo template to the confirmed source as ONE canonical revision, so the
   * editor's Undo restores whatever was there before. Captions are generated only when the video
   * has none of its own, unless the user explicitly chooses otherwise.
   */
  applyStyleOne(id:string,body:Record<string,unknown>,analyzed=false){return this.applyStyle(id,body,'STYLEONE',analyzed);}
  applyStyleTwo(id:string,body:Record<string,unknown>,analyzed=false){return this.applyStyle(id,body,'STYLETWO',analyzed);}
  async applyStyle(id:string,body:Record<string,unknown>,style:QuickStyle,analyzed=false){
    const name=STYLES[style].name;
    const q=await this.load(id);this.assertEditable(q,body.revision,analyzed);
    // The local AI pass runs first (once per upload); the style then continues from the job.
    if(!analyzed&&this.needsAnalysis(q))return this.start(id,'ANALYZE',{},{next:style,style:{hookText:typeof body.hookText==='string'?body.hookText:undefined,captions:typeof body.captions==='string'?body.captions:undefined}});
    const view=this.view(q);
    const mode=['GENERATE','KEEP','OFF'].includes(String(body.captions))?String(body.captions)
      :view.analysis?.subtitleState==='MISSING'&&view.hasTranscript?'GENERATE':'KEEP';
    let hooks=view.hooks;
    // Both styles open with a hook written from the video itself; without consent it is written locally.
    if(typeof body.hookText!=='string'&&!hooks.length&&view.hasTranscript){
      const context=this.postCopyContext(q,{});const suggestions=await suggestHooks(this.router,context.transcript,false,[],
        {sourceId:context.sourceId,transcriptVersion:context.transcriptVersion,visualVersion:context.visualVersion,
         visibleText:context.visibleText,visualSummary:context.visualSummary,speakerTurns:context.speakerTurns,boundaryQa:context.boundaryQa,template:STYLES[style].template,sourceTitle:context.sourceContext?.sourcePostTitle,sourceCaption:context.sourceContext?.sourcePostText});
      hooks=suggestions.hooks;
      await this.prisma.quickReframe.update({where:{id},data:{hooks:json(hooks),postCopy:json({...emptyPostCopy(),...record(q.postCopy),
        version:(Number(record(q.postCopy).version)||0)+1,contentUnderstandingVersion:INTELLIGENCE_VERSION,
        creativePackage:{...record(record(q.postCopy).creativePackage),version:suggestions.package.version,understanding:suggestions.package.understanding,hooks,boundaryQa:suggestions.package.boundaryQa,status:suggestions.package.status},
        _intelligenceInternal:suggestions.package.internal})}});
    }
    const hookText=typeof body.hookText==='string'?body.hookText.slice(0,320):hooks.find(h=>h.recommended)?.text??'';
    let project=await this.editor.get(q.editProjectId) as unknown as {revision:number;settings:unknown;assets:Asset[];elements:Loaded['editProject']['elements']};
    if(mode==='GENERATE'&&!project.elements.some(e=>e.type==='SUBTITLE')){
      if(!view.hasTranscript)throw new BadRequestException('No speech was found to caption.');
      project=await this.editor.phase3Command(q.editProjectId,'GENERATE_CAPTIONS',{revision:project.revision}) as unknown as typeof project;
    }
    const captions=mode!=='OFF'&&project.elements.some(e=>e.type==='SUBTITLE');
    const compiled=quickStyleCommands({project:{id:q.editProjectId,revision:project.revision,settings:project.settings},assets:project.assets as never,elements:project.elements as never},{hookText,captions,replaceHook:typeof body.hookText==='string'},style);
    const applied=await this.retryWriteConflict(()=>this.editor.applyAssistantBundle(q.editProjectId,project.revision,{proposalId:randomUUID(),summary:`Apply ${name} to the confirmed crop`,userMessage:`Quick Reframe: ${name}`,commands:compiled.commands,actor:'TEMPLATE_ACTION',onInvalid:'ABORT'}));
    await this.prisma.quickReframe.update({where:{id},data:{editPath:style,status:'STYLED',message:`${name} applied`,error:null}});
    return this.start(id,'PREVIEW',{revision:(applied as {project:{revision:number}}).project.revision});
  }
  /**
   * Chooses Manual editing. The composition is kept unless the user explicitly asks to remove
   * the applied style, which is itself one undoable canonical revision.
   */
  async choosePath(id:string,body:Record<string,unknown>){
    const q=await this.load(id);this.assertEditable(q,body.revision);
    if(body.path!=='MANUAL')throw new BadRequestException('Use Apply StyleOne or Apply StyleTwo to choose a style.');
    const applied=this.view(q);
    if((body.removeStyleOne===true||body.removeStyle===true)&&(applied.styleOneApplied||applied.styleTwoApplied)){
      const hooks=q.editProject.elements.filter(e=>e.type==='TEXT'&&record(e.properties).presetRole==='HOOK');
      const commands=[...hooks.map(e=>({kind:'ELEMENT' as const,action:'REMOVE_ELEMENT',payload:{elementId:e.id}})),
        ...(q.editProject.elements.some(e=>e.type==='SUBTITLE')?[{kind:'ELEMENT' as const,action:'REMOVE_CAPTIONS',payload:{}}]:[]),
        {kind:'ELEMENT' as const,action:'SET_VIDEO_FRAMING',payload:{mode:'FIT',scope:'ALL_VIDEO_SEGMENTS'}},
        {kind:'SETTINGS' as const,action:'QUICK_REFRAME_MANUAL',payload:{resolvedVisualLayout:null,selectedPreset:null,aspectRatio:'SOURCE',reframePolicy:'SOURCE',zoomPolicy:'OFF',subtitlePolicy:'OFF',gradingPolicy:'NONE',quickReframeStyleOne:false,quickReframeStyleTwo:false}}];
      await this.retryWriteConflict(()=>this.editor.applyAssistantBundle(q.editProjectId,q.editProject.revision,{proposalId:randomUUID(),summary:`Remove ${applied.styleTwoApplied?'StyleTwo':'StyleOne'} and edit manually`,userMessage:'Quick Reframe: Manual editing',commands,actor:'TEMPLATE_ACTION',onInvalid:'ABORT'}));
    }
    await this.prisma.quickReframe.update({where:{id},data:{editPath:'MANUAL',status:'EDITING',message:'Manual editing',error:null}});
    // Hook suggestions and the caption decision need the local AI pass; the editor opens meanwhile.
    if(this.needsAnalysis(await this.load(id)))return this.start(id,'ANALYZE');
    return this.get(id);
  }
  async cancel(id:string){await this.load(id);await this.prisma.quickReframe.update({where:{id},data:{operationId:null,status:'CANCELED',message:'Processing canceled',error:null}});this.aborts.get(id)?.abort();return this.get(id);}
  async remove(id:string){const q=await this.load(id);await this.cancel(id);await this.editor.remove(q.editProjectId);return {deleted:true};}
}
