/** Full authorized-source acceptance, with all analysis/transcription kept local. */
const assert=require('node:assert/strict');
const {PrismaClient}=require('@prisma/client');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {mkdtemp,writeFile,rm}=require('node:fs/promises'),{tmpdir}=require('node:os'),{join}=require('node:path');
const {STREET3_MEASURED_PX:S}=require('../dist/modules/edit-mode/styles/automatic-2-street3-layout');
const prisma=new PrismaClient(),exec=promisify(execFile),base='http://127.0.0.1:4000';
async function api(path,method='GET',body){const r=await fetch(base+'/quick-reframe'+path,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});const s=await r.json();assert.ok(r.ok,s.message);return s;}
async function wait(id){for(let i=0;i<1200;i++){const s=await api('/'+id);assert.notEqual(s.status,'FAILED',s.error);if(!['ANALYZE','PREVIEW','EXPORT','IMPORT'].includes(s.status))return s;await new Promise(r=>setTimeout(r,1000));}throw new Error('Timeout');}
async function main(){
  assert.ok(process.env.REFRAME_SOCIAL_URL,'Supply a user-authorized public short video');
  const dir=await mkdtemp(join(tmpdir(),'quick-styleone-')),ids=[];
  try{
    let s=await api('','POST');ids.push(s.id);
    await api('/'+s.id+'/import','POST',{url:process.env.REFRAME_SOCIAL_URL,authorized:true});s=await wait(s.id);
    await api('/'+s.id+'/analyze','POST',{externalAiAuthorized:false});s=await wait(s.id);
    s=await api('/'+s.id+'/auto-clean','POST',{revision:s.revision,cleanupAuthorized:true});
    let q=await prisma.quickReframe.findUniqueOrThrow({where:{id:s.id},include:{editProject:{include:{assets:true,elements:true}}}});
    const source=q.editProject.assets.find(a=>a.role==='SOURCE');
    const words=String(source.transcript?.text||'').split(/\s+/).slice(0,12).join(' ').slice(0,160);
    s.plan.hook={...s.plan.hook,enabled:!!words,text:words};
    s.plan.color={exposure:0,contrast:1,saturation:1,temperature:0,sharpness:0,denoise:false};
    s=await api('/'+s.id+'/plan','PUT',{revision:s.revision,plan:s.plan});
    for(const kind of ['preview','export']){await api('/'+s.id+'/'+kind,'POST',{revision:s.revision});s=await wait(s.id);}
    assert.ok(s.cleanUrl);assert.equal(s.previewRevision,s.revision);assert.equal(s.exportRevision,s.revision);
    q=await prisma.quickReframe.findUniqueOrThrow({where:{id:s.id},include:{editProject:{include:{assets:true,elements:true}}}});
    const clean=q.editProject.assets.find(a=>a.metadata?.quickReframeKind==='CLEAN');
    const exports=q.editProject.assets.filter(a=>a.metadata?.quickReframeKind==='EXPORT');assert.equal(exports.length,1);
    assert.equal(exports[0].metadata.cleanAssetId,clean.id);assert.ok(clean.createdAt<=exports[0].createdAt);
    assert.equal(q.editProject.elements.filter(e=>e.type==='VIDEO').length,1);
    if(s.analysis.subtitleState==='EXISTING_READABLE')assert.equal(q.editProject.elements.filter(e=>e.type==='SUBTITLE').length,0);
    assert.equal(q.editProject.settings.resolvedVisualLayout.editingProfile,'AUTOMATIC_2');
    const files={};for(const [name,url] of [['source',s.sourceUrl],['clean',s.cleanUrl],['preview',s.previewUrl],['export',s.exportUrl]]){files[name]=join(dir,name+'.mp4');const r=await fetch(base+url);assert.equal(r.status,200);await writeFile(files[name],Buffer.from(await r.arrayBuffer()));}
    for(const name of ['clean','preview','export']){const {stdout}=await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',files[name]]);const p=JSON.parse(stdout);assert.ok(Math.abs(Number(p.format.duration)-s.duration)<.2);if(name==='export')assert.deepEqual([p.streams[0].width,p.streams[0].height],[1080,1920]);if(name==='preview')assert.deepEqual([p.streams[0].width,p.streams[0].height],[540,960]);}
    const pcm=async name=>(await exec('ffmpeg',['-v','error','-i',files[name],'-map','0:a:0','-ac','1','-ar','8000','-f','s16le','pipe:1'],{encoding:'buffer',maxBuffer:10000000})).stdout;
    const original=await pcm('source'),correlations={};for(const name of ['clean','export']){const audio=await pcm(name);let a=0,b=0,ab=0;for(let i=0;i<Math.min(audio.length,original.length)/2;i++){const x=original.readInt16LE(i*2),y=audio.readInt16LE(i*2);a+=x*x;b+=y*y;ab+=x*y;}correlations[name]=ab/Math.sqrt(a*b);assert.ok(correlations[name]>.97,`${name} audio correlation ${correlations[name]}`);}
    // Match fitted source content in the actual fixed window at beginning/middle/end.
    const similarities=[];
    for(const t of [.2,s.duration/2,s.duration-.4]){
      const image=async(name,filter)=>(await exec('ffmpeg',['-v','error','-ss',String(t),'-i',files[name],'-vf',filter,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{encoding:'buffer',maxBuffer:4000000})).stdout;
      const expectedFilter=`scale=${S.media.width}:${S.media.height}:force_original_aspect_ratio=decrease,pad=${S.media.width}:${S.media.height}:(ow-iw)/2:(oh-ih)/2:black,scale=216:140`;
      const [expected,actual]=await Promise.all([image('clean',expectedFilter),image('export',`crop=${S.media.width}:${S.media.height}:${S.media.x}:${S.media.y},scale=216:140`)]);
      assert.equal(expected.length,actual.length);let error=0;for(let i=0;i<actual.length;i++)error+=Math.abs(expected[i]-actual[i]);const mae=error/actual.length;similarities.push(mae);assert.ok(mae<12,`Source sequence/window mismatch ${mae}`);
      const black=await image('export','crop=32:32:0:0');assert.ok([...black].every(v=>v<=3),'StyleOne canvas must remain black');
    }
    console.log(JSON.stringify({authorizedInstagram:true,duration:s.duration,subtitleState:s.analysis.subtitleState,faceSamples:s.analysis.frames.filter(f=>f.faces.length).length,cleanBeforeStyleOne:true,outputs:1,audioCorrelations:correlations,sourceWindowMeanAbsoluteErrors:similarities,externalAi:false,result:'PASS'}));
  }finally{for(const id of ids)await api('/'+id,'DELETE').catch(()=>undefined);await prisma.$disconnect();await rm(dir,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
