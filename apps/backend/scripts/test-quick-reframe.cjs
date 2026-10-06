const assert=require('node:assert/strict');
const {analyzeRegions,proposePlan,validatePlan,outputGeometry}=require('../dist/modules/quick-reframe/quick-reframe-plan');
const {socialSource,pinnedLookup}=require('../dist/modules/quick-reframe/social-source');
const {quickRender}=require('../dist/modules/quick-reframe/quick-reframe-render');
const full={x:0,y:0,w:1,h:1};
const raw={runtime:{ocr:true,faceDetector:true,yolo:true},frames:[0,1,2,3].map(t=>({t,faces:[{x:.35,y:.3,w:.25,h:.25}],persons:[],text_boxes:[],ocr_boxes:[{x:.1,y:.03,w:.8,h:.08,text:'A useful tip',confidence:.95}],text_coverage:0,edge_density:.02})),shot_boundaries:[]};
const a=analyzeRegions(raw,4);assert.equal(a.regions.length,1);assert.equal(a.regions[0].end,4);assert.equal(a.regions[0].kind,'DECORATIVE');assert.equal(a.subtitleState,'MISSING');
const p=proposePlan(a,720,1280,{segments:[{start:0,end:2,text:'Original words'}]});
assert.ok(p.crop.y>.1);assert.ok(p.captions.enabled);assert.ok(!p.hook.enabled);validatePlan(p,4,a);
const moving=structuredClone(a);moving.frames[3].faces=[{x:.1,y:.01,w:.2,h:.2}];assert.deepEqual(proposePlan(moving,720,1280,{}).crop,full);
const trackingAnalysis={...a,regions:[],frames:Array.from({length:9},(_,t)=>({t,faces:[{x:.08+.08*t,y:.3,w:.1,h:.2}],persons:[],information:[]}))};
const tracked=proposePlan(trackingAnalysis,1920,1080,{},'1:1');assert.ok(tracked.tracking.length>1);assert.equal(tracked.framing,'CROP');validatePlan(tracked,9,trackingAnalysis);
const graphics=structuredClone(a);graphics.frames[2].information=[full];const fit=proposePlan(graphics,1920,1080,{},'9:16');assert.equal(fit.framing,'FIT');assert.deepEqual(fit.crop,full);
const captionRaw=structuredClone(raw);captionRaw.frames.forEach(f=>f.ocr_boxes=[{x:.1,y:.78,w:.8,h:.06,text:'Spoken words',confidence:.95}]);const readable=analyzeRegions(captionRaw,4);assert.equal(readable.subtitleState,'EXISTING_READABLE');assert.equal(proposePlan(readable,720,1280,{}).captions.enabled,false);
const uncertain=analyzeRegions({...raw,runtime:{ocr:false}},4);assert.equal(uncertain.subtitleState,'PARTIAL_OR_UNREADABLE');
const letterboxed={...a,regions:[],frames:a.frames.map(f=>({...f,faces:[],persons:[]})),bars:{top:.08,bottom:.08,left:0,right:0}};assert.equal(proposePlan(letterboxed,720,1280,{}).crop.y,.08);
const bad=structuredClone(p);bad.crop.x=.99;assert.throws(()=>validatePlan(bad,4,a));
const dup=proposePlan(readable,720,1280,{});dup.captions.enabled=true;assert.throws(()=>validatePlan(dup,4,readable),/replacement/);
const hookOverOriginal=proposePlan(readable,720,1280,{});hookOverOriginal.hook={enabled:true,text:'A useful tip',y:.65};assert.throws(()=>validatePlan(hookOverOriginal,4,readable),/original captions/);
const widespread=structuredClone(p);widespread.cleanup=[0,.5].map(x=>({x,y:.4,w:.5,h:.4,start:0,end:4,regionId:'manual',method:'BLUR',intensity:8,authorized:true}));assert.throws(()=>validatePlan(widespread,4,a),/30%/);
const watermark=structuredClone(a);watermark.regions.push({id:'credit',x:.8,y:.85,w:.18,h:.05,start:0,end:4,confidence:.9,text:'@creator',kind:'ATTRIBUTION'});
const cleanup=structuredClone(p);cleanup.cleanup=[{x:.75,y:.8,w:.2,h:.1,start:0,end:4,regionId:'credit',method:'BLUR',intensity:8,authorized:true}];assert.throws(()=>validatePlan(cleanup,4,watermark),/attribution/);
const ownBranding=proposePlan(watermark,720,1280,{});ownBranding.cleanup=[{x:.8,y:.85,w:.18,h:.05,start:0,end:4,regionId:'credit',method:'COVER',intensity:8,authorized:true,ownedBranding:true}];validatePlan(ownBranding,4,watermark);
ownBranding.cleanup[0].regionId='manual';assert.throws(()=>validatePlan(ownBranding,4,watermark),/attribution/);
for(const u of ['http://x.com/u/status/123','https://x.com.evil.test/u/status/123','https://x.com@127.0.0.1/u/status/123','https://instagram.com/reel/x/../../bad','https://twitter.com/intent/tweet','https://x.com:443/u/status/123#bad'])assert.throws(()=>socialSource(u));
assert.equal(socialSource('https://www.instagram.com/reel/abc_123/?igsh=foo').platform,'instagram');assert.equal(socialSource('https://x.com/test/status/123456').platform,'x');
pinnedLookup('1.1.1.1')('cdn.example',{all:true},(error,addresses)=>{assert.equal(error,null);assert.deepEqual(addresses,[{address:'1.1.1.1',family:4}]);});
pinnedLookup('1.1.1.1')('cdn.example',{all:false},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'1.1.1.1');assert.equal(family,4);});
for(const aspect of ['SOURCE','9:16','16:9','1:1','CUSTOM']){const d=outputGeometry({...p,aspect},360,640);assert.ok(d.width<=360 && d.height<=640);assert.equal(d.width%2,0);assert.equal(d.height%2,0);}
const renderPlan={...p,crop:full,captions:{...p.captions,enabled:false},cleanup:[{regionId:'manual',x:.1,y:.1,w:.3,h:.1,start:0,end:3,method:'BLUR',intensity:8,authorized:true}]};
const r=quickRender({project:{id:'p',revision:1,settings:{}},assets:[{id:'s',role:'SOURCE',mimeType:'video/mp4',width:720,height:1280,duration:4,fps:30,metadata:{hasAudio:true},analysis:{},transcript:{}}],elements:[{id:'v',type:'VIDEO',assetId:'s',track:0,position:0,startTime:0,duration:4,trimStart:0,trimEnd:4,properties:{}}],hasSourceAudio:true},renderPlan,'source.mp4','output.mp4');
const graph=r.args[r.args.indexOf('-filter_complex')+1];assert.ok(graph.includes('boxblur=8:2'));assert.ok(graph.includes('crop=216:128:72:128'));assert.ok(!graph.includes('alimiter'));assert.equal(r.plan.durationSec,4);assert.equal(r.plan.subtitles.length,0);
console.log('Quick Reframe: conservative crops, moving-subject protection, charts, subtitle states, attribution, URL validation, bounded geometry, and localized render graph passed.');
if(process.env.REFRAME_FFMPEG==='true'){
  const {execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quick-tiny-mask-'));
  try{
    const source=path.join(dir,'source.mp4'),out=path.join(dir,'out.mp4');
    execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=blue:size=128x128:rate=5:duration=2','-c:v','libx264',source]);
    const tiny={...renderPlan,cleanup:[{regionId:'manual',x:.1,y:.1,w:.02,h:.02,start:0,end:2,method:'BLUR',intensity:30,authorized:true}]};
    const input={project:{id:'p',revision:1,settings:{}},assets:[{id:'s',role:'SOURCE',mimeType:'video/mp4',width:128,height:128,duration:2,fps:5,metadata:{hasAudio:false}}],elements:[{id:'v',type:'VIDEO',assetId:'s',track:0,position:0,startTime:0,duration:2,trimStart:0,trimEnd:2,properties:{}}],hasSourceAudio:false};
    const built=quickRender(input,tiny,source,out);execFileSync('ffmpeg',built.args,{cwd:dir,stdio:'pipe'});
    execFileSync('ffmpeg',['-v','error','-xerror','-i',out,'-f','null','-']);
    console.log('Smallest localized mask and local-only input decoding: real FFmpeg PASS');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
