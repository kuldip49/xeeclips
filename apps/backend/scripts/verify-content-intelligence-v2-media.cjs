// Direct-module acceptance over the owner's existing authorized QA media.
// No application/database mutations or deployment. Only temporary QA audio objects,
// deleted after fresh transcription. Requires the existing local worker/storage.
require('reflect-metadata');
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..'),out=path.join(root,'.real-qa-preview/content-intelligence-v2/media');
fs.mkdirSync(out,{recursive:true});process.loadEnvFile(path.join(root,'.env'));
process.env.MINIO_ENDPOINT='localhost';process.env.MINIO_PORT='9000';
const {ClipBoundaryService,transcriptBoundaryWords}=require('../dist/modules/content-intelligence/clip-boundary.service');
const {CreativePackageService,publicCreativePackage}=require('../dist/modules/content-intelligence/creative-package.service');
const {LlmRouterService}=require('../dist/modules/processing/llm-router.service');
const {StorageService}=require('../dist/modules/storage/storage.service');
const {performanceContext,createPerformanceTelemetry}=require('../dist/modules/processing/performance-telemetry');
const read=p=>JSON.parse(fs.readFileSync(path.join(root,'.real-qa-preview',p),'utf8'));
const advice=read('content-intelligence/live-report.json').results[0];
const delivery=read('conversational-acceptance-final/rendered-audio-words.json')[1];
const cultural=read('style-two/before/stylezero-project.json').assets[0].transcript;
const cases=[
 {id:'advice',file:'content-intelligence/disposable-advice.mp4',segments:advice.transcript.segments,start:9,end:28,oldHook:advice.clip.hook},
 {id:'delivery',file:'conversational-acceptance-final/quick-manual.mp4',words:delivery.words,start:1.15,end:31.9,oldHook:'Delivery app fraud explained'},
 {id:'cultural-fusion',file:'style-two/reference-footage.mp4',segments:cultural.segments,start:0,end:30,oldHook:'Being Somali-American is like bananas and rice'},
 {id:'missing-start-and-ending',file:'clean-selected.mp4',words:read('words-clean.json'),start:0,end:20,oldHook:'How bond prices work'}
];
const bin=path.join(root,'.cache/ffmpeg-benchmark/ffmpeg-9.0.2-essentials_build/bin');
const ff=(args)=>execFileSync(path.join(bin,'ffmpeg.exe'),['-v','error',...args],{cwd:out});
const router=new LlmRouterService(),boundary=new ClipBoundaryService(),storage=new StorageService();
async function main(){
 if(process.argv.includes('--rewrite-existing')){
  const report=JSON.parse(fs.readFileSync(path.join(out,'report.json'),'utf8'));
  for(const record of report.results.filter(r=>r.repaired.valid)){
   console.log('Checking isolated hook rewrite: '+record.id);
   const u=record.creative.understanding,metrics=createPerformanceTelemetry('ONLINE');
   const rewrite=await performanceContext.run(metrics,()=>new CreativePackageService(router).create({external:true,hooksOnly:true,
    evidence:{sourceId:record.id,transcript:record.repaired.transcriptText,boundaryQa:record.repaired.qa,
      analysis:{mainClaim:u.centralClaim,mainTopic:u.mainTopic,conclusion:u.payoff,supportedClaims:u.supportedClaims}},
    direction:'Make the hook more interesting with a specific question or tension that the actual ending delivers. Keep the claim precise.'}));
   record.hookRewrite={package:publicCreativePackage(rewrite),quality:rewrite.quality,escalations:rewrite.internal.escalations};
   // Record the latest verdict even when a prior run passed; stale accepted copy
   // must not make a rejected rerun look successful in the before/after report.
   const chosen=rewrite.hooks.find(h=>h.text===rewrite.selectedHook);record.newHook=rewrite.selectedHook;
   record.hookCategory=chosen?.category;record.clickability=chosen?.CLICKABILITY_SCORE;record.context=chosen?.CONTEXT_SCORE;
   record.hookRewriteCheckedAt=new Date().toISOString();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
   console.log(JSON.stringify({id:record.id,status:rewrite.status,hook:rewrite.selectedHook,quality:rewrite.quality,escalations:rewrite.internal.escalations}));
  }
  return;
 }
 const results=[];
 for(const c of cases){
  console.log(`Checking ${c.id}: boundary, creative, actual exported audio`);
  const source=path.join(root,'.real-qa-preview',c.file),words=c.words||transcriptBoundaryWords(c.segments);
  const sourceDuration=Number(execFileSync(path.join(bin,'ffprobe.exe'),['-v','error','-show_entries','format=duration','-of','csv=p=0',source],{encoding:'utf8'}));
  const raw={startTime:c.start,endTime:Math.min(c.end,sourceDuration),transcriptText:words.filter(w=>w.end>c.start&&w.start<c.end).map(w=>w.text).join(' ')};
  const telemetry=createPerformanceTelemetry('ONLINE');
  const repaired=await performanceContext.run(telemetry,()=>boundary.repairSemantic(raw,words,router,true,{sourceDuration}));
  const record={id:c.id,source:c.file,sourceDuration,targetDuration:raw.endTime-raw.startTime,raw,repaired,oldHook:c.oldHook,exported:false};
  if(repaired.valid){
   const evidence={sourceId:`v2-acceptance-${c.id}`,transcript:repaired.transcriptText,boundaryQa:repaired.qa,
    previousContext:words.filter(w=>w.end<=repaired.startTime).slice(-100).map(w=>w.text).join(' '),
    nextContext:words.filter(w=>w.start>=repaired.endTime).slice(0,100).map(w=>w.text).join(' ')};
   record.creativeDrafts=[];
   const observed={async generate(input){const result=await router.generate(input);if(input.role==='creativeGeneration')record.creativeDrafts.push({tier:input.creativeTier,data:result.data});return result;}};
   const service=new CreativePackageService(observed);
   const pkg=await performanceContext.run(telemetry,()=>service.create({evidence,external:true}));
   record.creative=publicCreativePackage(pkg);record.quality=pkg.quality;record.escalations=pkg.internal.escalations;
   record.newHook=pkg.selectedHook;record.hookCategory=pkg.hooks.find(h=>h.text===pkg.selectedHook)?.category;
   record.clickability=pkg.hooks.find(h=>h.text===pkg.selectedHook)?.CLICKABILITY_SCORE;
   record.context=pkg.hooks.find(h=>h.text===pkg.selectedHook)?.CONTEXT_SCORE;
   if(pkg.status==='NEEDS_REVIEW'){
    // Separate acceptance of the editor's "make the hook more interesting" request.
    // It preserves the existing post copy and reuses understanding; each request has its own one-repair cap.
    const rewrite=await performanceContext.run(telemetry,()=>service.create({evidence,external:true,hooksOnly:true,
      direction:'Make the hook more interesting with a specific question or tension that the actual ending delivers. Keep the claim precise.'}));
    record.hookRewrite={package:publicCreativePackage(rewrite),quality:rewrite.quality,escalations:rewrite.internal.escalations};
    if(rewrite.status==='ACCEPTED'){
     const chosen=rewrite.hooks.find(h=>h.text===rewrite.selectedHook);record.newHook=rewrite.selectedHook;
     record.hookCategory=chosen?.category;record.clickability=chosen?.CLICKABILITY_SCORE;record.context=chosen?.CONTEXT_SCORE;
    }
   }
   const video=path.join(out,c.id+'.mp4'),audio=path.join(out,c.id+'.wav');
   ff(['-i',source,'-ss',String(repaired.startTime),'-t',String(repaired.endTime-repaired.startTime),'-map','0:v:0','-map','0:a:0','-c:v','libx264','-threads','2','-preset','ultrafast','-crf','23','-c:a','aac','-y',video]);
   ff(['-i',video,'-vn','-ar','16000','-ac','1','-y',audio]);record.exported=true;record.output=video;
   const key=`qa/content-intelligence-v2/${Date.now()}-${c.id}.wav`;
   const uploaded=await storage.uploadFile({filePath:audio,objectKey:key,mimeType:'audio/wav'});
   try{
    const response=await fetch('http://127.0.0.1:8000/transcriptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bucket:uploaded.bucket,object_key:key,task:'transcribe'}),signal:AbortSignal.timeout(180000)});
    if(!response.ok)throw Error(`worker transcription ${response.status}`);
    record.exportedAudioTranscript=await response.json();
    record.audioOpening=record.exportedAudioTranscript.segments?.slice(0,2).map(s=>s.text).join(' ');
    record.audioEnding=record.exportedAudioTranscript.segments?.slice(-2).map(s=>s.text).join(' ');
   }finally{await storage.removeObject(uploaded.bucket,key);}
  }
  record.llmCalls=telemetry.cloudLlmCalls;record.manualListening='Pending human listening; fresh exported audio was transcribed and inspected.';
  results.push(record);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({date:new Date().toISOString(),results},null,2));
  console.log(JSON.stringify({id:c.id,valid:repaired.valid,start:repaired.startTime,end:repaired.endTime,hook:record.newHook,status:record.creative?.status,escalations:record.escalations,reasons:repaired.reasons}));
 }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
