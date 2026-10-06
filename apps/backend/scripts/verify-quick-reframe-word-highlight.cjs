/** Verify a real late caption's active-word pixels, rather than just stored style flags. */
const assert=require('node:assert/strict'),{PrismaClient}=require('@prisma/client');
const {readFile,writeFile,mkdtemp,rm}=require('node:fs/promises'),{join}=require('node:path'),{tmpdir}=require('node:os');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');const exec=promisify(execFile);
async function main(){const prisma=new PrismaClient(),dir=await mkdtemp(join(tmpdir(),'quick-highlight-'));try{
  const kept=JSON.parse(await readFile('/tmp/quick-reframe-persistence.json','utf8'));
  const q=await prisma.quickReframe.findUniqueOrThrow({where:{id:kept.id},include:{editProject:{include:{elements:true}}}});
  const captions=q.editProject.elements.filter(e=>e.type==='SUBTITLE');assert.ok(captions.length>3);
  for(const c of captions)for(const w of c.properties.words||[])assert.ok(w.start>=0&&w.end<=c.duration+.001,'Word timestamps must be caption-relative');
  const c=captions.find(e=>e.startTime>2&&e.properties.words?.length);assert.ok(c);
  const w=c.properties.words[0],t=c.startTime+(w.start+w.end)/2;
  const path=join(dir,'export.mp4');const response=await fetch('http://127.0.0.1:4000'+kept.exportUrl);assert.ok(response.ok);await writeFile(path,Buffer.from(await response.arrayBuffer()));
  const {stdout}=await exec('ffmpeg',['-v','error','-ss',String(t),'-i',path,'-vf','crop=908:196:86:1090','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{encoding:'buffer',maxBuffer:1000000});
  let lime=0;for(let i=0;i<stdout.length;i+=3)if(stdout[i]>=100&&stdout[i]<=220&&stdout[i+1]>180&&stdout[i+2]<60)lime++;
  assert.ok(lime>50,`The original word at ${t}s must be highlighted; lime pixels=${lime}`);
  console.log(JSON.stringify({captionCount:captions.length,lateHighlightTime:t,limePixels:lime,result:'PASS'}));
}finally{await prisma.$disconnect();await rm(dir,{recursive:true,force:true});}}
main().catch(e=>{console.error(e);process.exitCode=1;});
