/** Local-only speech, silent WebM compatibility, render geometry and persisted History checks. */
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const exec = promisify(execFile);
const base = 'http://127.0.0.1:4000';
const ids = [];
async function api(path, method='GET', body) {
  const r = await fetch(base+'/quick-reframe'+path, {method, headers:body?{'Content-Type':'application/json'}:undefined, body:body?JSON.stringify(body):undefined});
  const data = await r.json(); assert.ok(r.ok, data.message); return data;
}
async function wait(id) {
  const started = Date.now();
  while (Date.now()-started < 600000) {
    const s = await api('/'+id); assert.notEqual(s.status, 'FAILED', s.error);
    if (!['ANALYZE','PREVIEW','EXPORT'].includes(s.status)) return s;
    await new Promise(r=>setTimeout(r,1000));
  }
  throw new Error('Timed out');
}
async function upload(path, name) {
  const file = await readFile(path), s = await api('', 'POST'); ids.push(s.id);
  const u = await api('/'+s.id+'/upload', 'POST', {name, size:file.length, mimeType:name.endsWith('.webm')?'video/webm':'video/mp4'});
  const r = await fetch(base+`/quick-reframe/uploads/${u.id}/chunks/0`, {method:'PUT', headers:{'Content-Type':'application/octet-stream'}, body:file}); assert.equal(r.status,200);
  return api('/uploads/'+u.id+'/complete','POST');
}
async function main() {
  const dir = await mkdtemp(join(tmpdir(),'quick-reframe-speech-'));
  let keep;
  try {
    const source = join(dir,'speech.mp4');
    await exec('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=0x315b74:size=720x1280:rate=20','-i',process.env.REFRAME_SPEECH_FILE||'/tmp/quick-reframe-speech.wav','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',source]);
    let s = await upload(source,'spoken-tip.mp4');
    await api('/'+s.id+'/analyze','POST',{externalAiAuthorized:false}); s = await wait(s.id);
    s = await api('/'+s.id+'/auto-clean','POST',{revision:s.revision});
    assert.equal(s.analysis.subtitleState,'MISSING'); assert.ok(s.plan.captions.enabled); assert.ok(s.plan.captions.cues.length);
    assert.ok(s.plan.captions.cues.length>3,'Use the canonical short-phrase caption grouper');
    assert.ok(s.plan.captions.cues.every(c=>c.text.split(/\s+/).length<=6),'Bounded original-word captions');
    assert.match(s.plan.captions.cues.map(c=>c.text).join(' '),/speaker|visible|caption|original/i);
    for(const c of s.plan.captions.cues) assert.ok(c.start>=0 && c.end<=s.duration && c.end>c.start);
    s.plan.hook={enabled:true,text:'Keep the speaker clearly visible',y:.04};
    s=await api('/'+s.id+'/plan','PUT',{revision:s.revision,plan:s.plan});
    for(const kind of ['preview','export']) { await api('/'+s.id+'/'+kind,'POST',{revision:s.revision}); s=await wait(s.id); }
    assert.ok(s.cleanUrl);
    const clean=join(dir,'clean.mp4');await writeFile(clean,Buffer.from(await (await fetch(base+s.cleanUrl)).arrayBuffer()));
    const output = join(dir,'speech-output.mp4');
    const response=await fetch(base+s.exportUrl); await writeFile(output,Buffer.from(await response.arrayBuffer()));
    const blackCheck=await exec('ffmpeg',['-v','info','-i',output,'-vf','blackdetect=d=0.1:pix_th=0.02','-an','-f','null','-'],{maxBuffer:1000000});
    assert.ok(!/black_start:/.test(blackCheck.stderr),'Unexpected black interval in the colored speech fixture');
    const pcm = async path => (await exec('ffmpeg',['-v','error','-i',path,'-map','0:a:0','-ac','1','-ar','8000','-f','s16le','pipe:1'],{encoding:'buffer',maxBuffer:10000000})).stdout;
    const [before,after]=await Promise.all([pcm(source),pcm(output)]);
    const n=Math.min(before.length,after.length)/2; let aa=0,bb=0,ab=0;
    for(let i=0;i<n;i++){const a=before.readInt16LE(i*2),b=after.readInt16LE(i*2);aa+=a*a;bb+=b*b;ab+=a*b;}
    const correlation=ab/Math.sqrt(aa*bb); assert.ok(correlation>.97, `Original audio correlation ${correlation}`);
    const cleanPcm=await pcm(clean);let cc=0,ac=0;for(let i=0;i<Math.min(before.length,cleanPcm.length)/2;i++){const a=before.readInt16LE(i*2),c=cleanPcm.readInt16LE(i*2);cc+=c*c;ac+=a*c;}assert.ok(ac/Math.sqrt(aa*cc)>.97);
    const {stdout:exportProbe}=await exec('ffprobe',['-v','error','-show_streams','-of','json',output]);const exportStreams=JSON.parse(exportProbe).streams;assert.equal(exportStreams[0].width,1080);assert.equal(exportStreams[0].height,1920);
    console.log(JSON.stringify({name:'spoken-tip',duration:s.duration,cues:s.plan.captions.cues.length,audioCorrelation:correlation,previewRevision:s.previewRevision,exportRevision:s.exportRevision,result:'PASS'}));
    keep={id:s.id,exportUrl:s.exportUrl};
    const silent=join(dir,'silent.webm'); await exec('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=0x436f84:size=320x180:rate=10:duration=4','-c:v','libvpx-vp9',silent]);
    let w=await upload(silent,'silent.webm'); const originalUrl=w.sourceUrl;
    await api('/'+w.id+'/analyze','POST',{externalAiAuthorized:false});w=await wait(w.id);assert.notEqual(w.sourceUrl,originalUrl);
    w=await api('/'+w.id+'/auto-clean','POST',{revision:w.revision});
    w.plan.aspect='1:1';w.plan.crop={x:0,y:0,w:.5625,h:1};w.plan.tracking=[{t:0,x:0,y:0},{t:4,x:.4,y:0}];
    w.plan.cleanup=[{x:.2,y:.3,w:.2,h:.2,regionId:'manual',start:0,end:2,method:'BLUR',intensity:8,authorized:true},{x:.4,y:.4,w:.1,h:.1,regionId:'manual',start:2,end:4,method:'COVER',intensity:8,authorized:true}];
    w=await api('/'+w.id+'/plan','PUT',{revision:w.revision,plan:w.plan});
    await api('/'+w.id+'/export','POST',{revision:w.revision});w=await wait(w.id);assert.equal(w.status,'COMPLETE');
    const movie=join(dir,'silent-output.mp4');const r=await fetch(base+w.exportUrl);await writeFile(movie,Buffer.from(await r.arrayBuffer()));
    const {stdout}=await exec('ffprobe',['-v','error','-show_streams','-of','json',movie]);const streams=JSON.parse(stdout).streams;
    assert.equal(streams.find(s=>s.codec_type==='video').width,1080);assert.equal(streams.find(s=>s.codec_type==='video').height,1920);assert.equal(streams.some(s=>s.codec_type==='audio'),false);
    console.log(JSON.stringify({name:'silent-webm-tracked-square-localized-blur-cover',result:'PASS'}));
    if(process.env.REFRAME_KEEP==='true') { await writeFile('/tmp/quick-reframe-persistence.json',JSON.stringify(keep)); ids.splice(ids.indexOf(keep.id),1);console.log('Spoken test session retained only for backend restart validation.'); }
  } finally { for(const id of ids) await api('/'+id,'DELETE').catch(()=>undefined);await rm(dir,{recursive:true,force:true}); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
