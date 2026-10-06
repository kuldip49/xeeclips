const assert=require('node:assert/strict');
const {analyzeRegions,defaultPlan,validatePlan,outputGeometry,subtitleStateFor,isReframeAspect,aspectValue,MIN_CROP_PIXELS}=require('../dist/modules/quick-reframe/quick-reframe-plan');
const {socialSource,pinnedLookup}=require('../dist/modules/quick-reframe/social-source');
const {quickCleanRender,quickOutputCanvas}=require('../dist/modules/quick-reframe/quick-reframe-render');
const full={x:0,y:0,w:1,h:1};
const frame={width:720,height:1280};
const raw={runtime:{ocr:true,faceDetector:true,yolo:true},frames:[0,1,2,3].map(t=>({t,faces:[{x:.35,y:.3,w:.25,h:.25}],persons:[],text_boxes:[],ocr_boxes:[{x:.1,y:.03,w:.8,h:.08,text:'A useful tip',confidence:.95}],text_coverage:0,edge_density:.02})),shot_boundaries:[]};
const a=analyzeRegions(raw,4);assert.equal(a.regions.length,1);assert.equal(a.regions[0].end,4);assert.equal(a.regions[0].kind,'DECORATIVE');assert.equal(a.subtitleState,'MISSING');assert.equal(a.ocrAvailable,true);

// V3: the first draft is the whole frame, with nothing detected or suggested.
const p=defaultPlan();assert.deepEqual(p.crop,full);assert.equal(p.aspect,'SOURCE');assert.equal(p.tracking,undefined);assert.deepEqual(p.cleanup,[]);assert.equal(p.captions.enabled,false);
assert.deepEqual(validatePlan(p,4,frame).crop,full);

// Any rectangle inside the frame is kept exactly, even when it cuts the face, the captions or the attribution.
const captionRaw=structuredClone(raw);captionRaw.frames.forEach(f=>f.ocr_boxes=[{x:.1,y:.78,w:.8,h:.06,text:'Spoken words',confidence:.95},{x:.8,y:.9,w:.17,h:.03,text:'@creator',confidence:.9}]);
const readable=analyzeRegions(captionRaw,4);assert.equal(readable.subtitleState,'EXISTING_READABLE');assert.ok(readable.regions.some(r=>r.kind==='ATTRIBUTION'));
const cutsEverything={...p,aspect:'CUSTOM',crop:{x:.61,y:.05,w:.3712,h:.4123}};
for(const analysis of [undefined,null,a,readable]){const kept=validatePlan(cutsEverything,4,frame,analysis).crop;assert.deepEqual(kept,cutsEverything.crop,'crop stored exactly');}
// Tracking from V1/V2 is removed: the crop is fixed for the whole video.
assert.equal(validatePlan({...p,tracking:[{t:0,x:0,y:0},{t:1,x:.01,y:0}],crop:{x:0,y:0,w:.5,h:.5}},4,frame).tracking,undefined);
// Only technical limits: inside the frame, finite, at least MIN_CROP_PIXELS on each side.
assert.equal(MIN_CROP_PIXELS,16);
for(const crop of [{x:.99,y:0,w:.5,h:.5},{x:-.1,y:0,w:.5,h:.5},{x:0,y:0,w:0,h:.5},{x:0,y:0,w:NaN,h:.5},{x:0,y:0,w:15/720,h:.5},{x:0,y:0,w:.5,h:15/1280}])
  assert.throws(()=>validatePlan({...p,crop},4,frame),/crop/i,JSON.stringify(crop));
assert.deepEqual(validatePlan({...p,crop:{x:0,y:0,w:16/720,h:16/1280}},4,frame).crop,{x:0,y:0,w:16/720,h:16/1280},'smallest encodable crop accepted');
// Float overshoot is clamped (not reinterpreted).
const edge=validatePlan({...p,crop:{x:.5,y:.5,w:.500001,h:.5}},4,frame).crop;assert.ok(edge.x+edge.w<=1&&Math.abs(edge.w-.5)<1e-5);

// Aspect ratios: all presets, custom "W:H", Free (CUSTOM), Original (SOURCE); grid is display-only.
for(const r of ['9:16','16:9','1:1','4:5','5:4','3:4','4:3','2:3','3:2','21:9','7:5','2.35:1','SOURCE','CUSTOM','STYLEONE'])assert.ok(isReframeAspect(r),r);
for(const r of ['0:1','1:0','abc','1:25','9:16:1',''])assert.equal(isReframeAspect(r),false,r);
assert.equal(aspectValue('21:9'),21/9);assert.equal(aspectValue('2.35:1'),2.35);assert.equal(aspectValue('CUSTOM'),null);assert.equal(aspectValue('SOURCE',1920,1080),1920/1080);
assert.equal(validatePlan({...p,aspect:'7:5'},4,frame).aspect,'7:5');assert.throws(()=>validatePlan({...p,aspect:'7-5'},4,frame),/Unsupported/);
assert.equal(validatePlan({...p,grid:'GOLDEN'},4,frame).grid,'GOLDEN');assert.equal(validatePlan({...p,grid:'bogus'},4,frame).grid,'THIRDS');

// Caption state follows the confirmed crop: captions cropped away are no longer "existing".
assert.equal(subtitleStateFor(readable,full),'EXISTING_READABLE');assert.equal(subtitleStateFor(readable,{x:0,y:0,w:1,h:.6}),'MISSING');
assert.equal(subtitleStateFor(readable,{x:0,y:0,w:1,h:.8}),'PARTIAL_OR_UNREADABLE','a caption line cut in half is uncertain');
const uncertain=analyzeRegions({...raw,runtime:{ocr:false}},4);assert.equal(uncertain.subtitleState,'PARTIAL_OR_UNREADABLE');assert.equal(subtitleStateFor(uncertain,{x:0,y:0,w:1,h:.5}),'PARTIAL_OR_UNREADABLE');

// Overlay cleanup is no longer offered; V2 sessions keep theirs, still under the rights/attribution checks.
const watermark=structuredClone(a);watermark.regions.push({id:'credit',x:.8,y:.85,w:.18,h:.05,start:0,end:4,confidence:.9,text:'@creator',kind:'ATTRIBUTION'});
const cleanup={...p,cleanup:[{x:.75,y:.8,w:.2,h:.1,start:0,end:4,regionId:'credit',method:'BLUR',intensity:8,authorized:true}]};
assert.throws(()=>validatePlan(cleanup,4,frame),/not available/);assert.throws(()=>validatePlan(cleanup,4,frame,watermark),/attribution/);
const own={...p,cleanup:[{x:.8,y:.85,w:.18,h:.05,start:0,end:4,regionId:'credit',method:'COVER',intensity:8,authorized:true,ownedBranding:true}]};validatePlan(own,4,frame,watermark);
const widespread={...p,cleanup:[0,.5].map(x=>({x,y:.65,w:.5,h:.35,start:0,end:4,regionId:'manual',method:'BLUR',intensity:8,authorized:true}))};assert.throws(()=>validatePlan(widespread,4,frame,a),/30%/);

for(const u of ['http://x.com/u/status/123','https://x.com.evil.test/u/status/123','https://x.com@127.0.0.1/u/status/123','https://instagram.com/reel/x/../../bad','https://twitter.com/intent/tweet','https://x.com:443/u/status/123#bad'])assert.throws(()=>socialSource(u));
assert.equal(socialSource('https://www.instagram.com/reel/abc_123/?igsh=foo').platform,'instagram');assert.equal(socialSource('https://x.com/test/status/123456').platform,'x');
pinnedLookup('1.1.1.1')('cdn.example',{all:true},(error,addresses)=>{assert.equal(error,null);assert.deepEqual(addresses,[{address:'1.1.1.1',family:4}]);});
pinnedLookup('1.1.1.1')('cdn.example',{all:false},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'1.1.1.1');assert.equal(family,4);});
for(const aspect of ['SOURCE','9:16','16:9','1:1','CUSTOM','21:9']){const d=outputGeometry({...p,aspect},360,640);assert.ok(d.width<=360 && d.height<=640);assert.equal(d.width%2,0);assert.equal(d.height%2,0);}
// Export canvases keep the confirmed crop's exact shape; extreme Free Crops stay within 3840 px.
assert.deepEqual(quickOutputCanvas({aspectRatio:'SOURCE'},690,616,720),{width:806,height:720});
assert.deepEqual(quickOutputCanvas({aspectRatio:'SOURCE'},54,1080,1080),{width:192,height:3840});
assert.deepEqual(quickOutputCanvas({aspectRatio:'SOURCE'},1920,1080,1080),{width:1920,height:1080});

// The bake is one exact crop: x/y/w/h floored to even source pixels, nothing else.
const input=(w,h)=>({project:{id:'p',revision:1,settings:{}},assets:[{id:'s',role:'SOURCE',mimeType:'video/mp4',width:w,height:h,duration:4,fps:30,metadata:{hasAudio:true},analysis:{},transcript:{}}],elements:[{id:'v',type:'VIDEO',assetId:'s',track:0,position:0,startTime:0,duration:4,trimStart:0,trimEnd:4,properties:{}}],hasSourceAudio:true});
const free=quickCleanRender(input(1280,720),{...p,aspect:'CUSTOM',crop:{x:.1,y:.2,w:.33,h:.41}},'source.mp4','output.mp4');
const freeGraph=free.args[free.args.indexOf('-filter_complex')+1];
assert.ok(freeGraph.includes("crop=422:294:'128':'144',scale=422:294"),freeGraph);assert.deepEqual([free.plan.canvas.width,free.plan.canvas.height],[422,294]);assert.equal(free.plan.durationSec,4);assert.equal(free.plan.subtitles.length,0);
const legacy=quickCleanRender(input(720,1280),{...p,crop:full,cleanup:[{regionId:'manual',x:.1,y:.1,w:.3,h:.1,start:0,end:3,method:'BLUR',intensity:8,authorized:true}]},'source.mp4','output.mp4');
const graph=legacy.args[legacy.args.indexOf('-filter_complex')+1];assert.ok(graph.includes('boxblur=8:2'));assert.ok(graph.includes('crop=216:128:72:128'));assert.ok(!graph.includes('alimiter'));
console.log('Quick Reframe V3: manual crops kept exactly (faces/captions/attribution never block), technical limits only, all ratios + custom, grid display-only, crop-aware caption state, legacy cleanup rights, URL validation, exact canvases and bake graph passed.');
if(process.env.REFRAME_FFMPEG==='true'){
  const {execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quick-tiny-crop-'));
  try{
    const source=path.join(dir,'source.mp4'),out=path.join(dir,'out.mp4');
    execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=blue:size=128x128:rate=5:duration=2','-c:v','libx264',source]);
    const tiny={...p,aspect:'CUSTOM',crop:{x:.5,y:.25,w:16/128,h:16/128}};
    const built=quickCleanRender({...input(128,128),assets:[{id:'s',role:'SOURCE',mimeType:'video/mp4',width:128,height:128,duration:2,fps:5,metadata:{hasAudio:false}}],elements:[{id:'v',type:'VIDEO',assetId:'s',track:0,position:0,startTime:0,duration:2,trimStart:0,trimEnd:2,properties:{}}],hasSourceAudio:false},tiny,source,out);
    execFileSync('ffmpeg',built.args,{cwd:dir,stdio:'pipe'});
    const probe=execFileSync('ffprobe',['-v','error','-show_entries','stream=width,height','-of','csv=p=0',out]).toString().trim();assert.equal(probe,'16,16');
    execFileSync('ffmpeg',['-v','error','-xerror','-i',out,'-f','null','-']);
    console.log('Smallest 16x16 crop and local-only input decoding: real FFmpeg PASS');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
