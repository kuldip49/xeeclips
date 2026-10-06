/**
 * Verify a real late caption's active-word pixels in a StyleOne export, rather than just stored style flags.
 *   REFRAME_LIVE_ID=<kept StyleOne session with generated captions> node scripts/verify-quick-reframe-word-highlight.cjs
 */
const assert=require('node:assert/strict');
const {writeFile,mkdtemp,rm}=require('node:fs/promises'),{join}=require('node:path'),{tmpdir}=require('node:os');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');const exec=promisify(execFile);
const {STREET3_MEASURED_PX:S}=require('../dist/modules/edit-mode/styles/automatic-2-street3-layout');
async function main(){const base=process.env.API_BASE||'http://127.0.0.1:4000',dir=await mkdtemp(join(tmpdir(),'quick-highlight-'));try{
  const id=process.env.REFRAME_LIVE_ID;assert.ok(id,'Set REFRAME_LIVE_ID');
  const s=await (await fetch(`${base}/quick-reframe/${id}`)).json();assert.equal(s.editPath,'STYLEONE');assert.ok(s.exports[0],'a StyleOne export');
  const project=await (await fetch(`${base}/edit-mode/projects/${s.editProjectId}`)).json();
  const captions=project.elements.filter(e=>e.type==='SUBTITLE');assert.ok(captions.length>3);
  for(const c of captions)for(const w of c.properties.words||[])assert.ok(w.start>=0&&w.end<=c.duration+.001,'Word timestamps must be caption-relative');
  const c=captions.find(e=>e.startTime>2&&e.properties.words?.length);assert.ok(c,'a caption after 2s with word timings');
  const w=c.properties.words[0],t=c.startTime+(w.start+w.end)/2;
  const path=join(dir,'export.mp4');const response=await fetch(base+s.exports[0].url);assert.ok(response.ok);await writeFile(path,Buffer.from(await response.arrayBuffer()));
  const box=S.captionBox;
  const {stdout}=await exec('ffmpeg',['-v','error','-ss',String(t),'-i',path,'-vf',`crop=${box.width}:${box.height}:${box.x}:${box.y}`,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{encoding:'buffer',maxBuffer:4000000});
  let lime=0;for(let i=0;i<stdout.length;i+=3)if(stdout[i]>=100&&stdout[i]<=220&&stdout[i+1]>180&&stdout[i+2]<60)lime++;
  assert.ok(lime>50,`The spoken word at ${t}s must be highlighted; lime pixels=${lime}`);
  console.log(JSON.stringify({captionCount:captions.length,lateHighlightTime:Number(t.toFixed(3)),limePixels:lime,result:'PASS'}));
}finally{await rm(dir,{recursive:true,force:true});}}
main().catch(e=>{console.error(e);process.exitCode=1;});
