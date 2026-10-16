// Real HTTP + PostgreSQL + local Whisper + FFmpeg acceptance. Hard-wired to the disposable qr-final-qa stack.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const root = path.resolve(__dirname,'../../..');
const out = path.join(root,'.real-qa-preview/quick-reframe-both-modes');
const stateFile = path.join(root,'.cache/quick-reframe-qa/provider-state.json');
const base = 'http://localhost:4100', origin = 'http://localhost:3100';
let cookie = '';
const resume = ['--resume','--editor-only','--refresh-zero'].some(flag=>process.argv.includes(flag));
const report = resume ? JSON.parse(fs.readFileSync(path.join(out,'acceptance.json'))) : {status:'RUNNING',cases:[],checks:[]};
const check = (value,label)=>{assert(value,label);report.checks.push(label);console.log('PASS '+label);};
const save = ()=>fs.writeFileSync(path.join(out,'acceptance.json'),JSON.stringify(report,null,2));
const sql = text=>execFileSync('docker',['exec','qr-final-qa-postgres-1','psql','-U','postgres','-d','quick_reframe_qa','-At','-v','ON_ERROR_STOP=1','-c',text],{encoding:'utf8'}).trim();
async function api(url,method='GET',body,expected=200){
  const form=body instanceof FormData;
  const r=await fetch(base+url,{method,headers:{Origin:origin,Cookie:cookie,...(body&&!form?{'Content-Type':'application/json'}:{})},
    body:form?body:body?JSON.stringify(body):undefined});
  if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
  const data=await r.json();assert(r.status===expected||expected===200&&r.status===201,`${method} ${url}: ${r.status} ${JSON.stringify(data).slice(0,400)}`);return data;
}
async function settle(id){
  const end=Date.now()+12*60*1000;
  while(Date.now()<end){const s=await api('/quick-reframe/'+id);if(!['IMPORT','PLAYBACK','PREPARE','ANALYZE','PREVIEW','EXPORT'].includes(s.status))return s;await new Promise(r=>setTimeout(r,1200));}
  throw Error('Timed out '+id);
}
async function uploadAndCrop(){
  let s=await api('/quick-reframe','POST',{});const bytes=fs.readFileSync(path.join(out,'source.mp4'));
  const u=await api(`/quick-reframe/${s.id}/upload`,'POST',{name:'Disposable speech.mp4',size:bytes.length,mimeType:'video/mp4'});
  for(let i=0;i<u.chunks;i++){
    const r=await fetch(`${base}/quick-reframe/uploads/${u.id}/chunks/${i}`,{method:'PUT',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/octet-stream'},body:bytes.subarray(i*u.chunkBytes,(i+1)*u.chunkBytes)});assert(r.ok);
  }
  await api(`/quick-reframe/uploads/${u.id}/complete`,'POST',{});await api(`/quick-reframe/${s.id}/playback`,'POST',{});s=await settle(s.id);
  check(!s.analysis&&!s.hasTranscript,'manual crop runs no intelligence '+s.id);
  const crop={x:.1,y:.1,w:.8,h:.8};
  s=await api(`/quick-reframe/${s.id}/plan`,'PUT',{revision:s.revision,plan:{...s.plan,aspect:'CUSTOM',crop}});
  await api(`/quick-reframe/${s.id}/confirm-crop`,'POST',{revision:s.revision});s=await settle(s.id);
  assert.deepEqual(s.confirmed?.crop,crop);check(s.cropConfirmed,'exact crop persisted '+s.id);
  check(!s.analysis&&!s.hasTranscript,'Done Cropping remains deterministic '+s.id);return s;
}
async function editAndExport(s,torture=false){
  const route=`/edit-mode/projects/${s.editProjectId}`;
  let p=await api(route);const video=p.elements.find(e=>e.type==='VIDEO');
  const cmd=async(action,payload)=>p=await api(route+'/commands/'+action,'POST',{revision:p.revision,...payload});
  p=await api(route+'/commands/trim','POST',{revision:p.revision,elementId:video.id,trimStart:1,trimEnd:s.duration-1});
  await cmd('set-video-scale',{elementId:video.id,scale:1.1});await cmd('set-video-position',{elementId:video.id,x:.02,y:-.01});
  const hook=p.elements.find(e=>e.type==='TEXT'&&e.properties.presetRole==='HOOK');assert(hook,'generated hook');
  const manualHook='Arguments must stand on their merits';await cmd('set-text-content',{elementId:hook.id,content:manualHook});
  const caption=p.elements.find(e=>e.type==='SUBTITLE');assert(caption,'speech captions');
  await cmd('set-caption-text',{elementId:caption.id,content:'Judge the argument on its merits.'});
  await cmd('set-video-brightness',{elementId:video.id,brightness:.08});
  if(torture){
    for(const [role,file,mime] of [['AUDIO','music.wav','audio/wav'],['IMAGE','overlay.png','image/png']]){
      const form=new FormData();form.set('revision',String(p.revision));form.set('role',role);form.set('file',new Blob([fs.readFileSync(path.join(out,file))],{type:mime}),file);
      const uploaded=await api(route+'/assets/upload','POST',form);p=await api(route);
      await cmd(role==='AUDIO'?'add-audio':'add-image',{assetId:uploaded.asset.id,startTime:0});
      const e=p.elements.find(e=>e.assetId===uploaded.asset.id);
      if(role==='AUDIO')await cmd('set-audio-volume',{elementId:e.id,volume:.2});
      else{await cmd('move-element',{elementId:e.id,x:.1,y:.6});await cmd('resize-element',{elementId:e.id,width:.2,height:.08});}
    }
  }
  const canonical=elements=>elements.map(({id,type,assetId,track,position,startTime,duration,trimStart,trimEnd,properties})=>
    ({id,type,assetId,track,position,startTime,duration,trimStart,trimEnd,properties})).sort((a,b)=>a.id.localeCompare(b.id));
  const snapshot=canonical(p.elements);
  p=await api(route+'/undo','POST',{revision:p.revision});p=await api(route+'/redo','POST',{revision:p.revision});
  assert.deepEqual(canonical(p.elements),snapshot);check(true,'Undo/Redo preserves full canonical state '+s.mode+' '+s.editPath);
  p=await api(route);check(p.elements.find(e=>e.id===hook.id).properties.content===manualHook,'reload preserves manual headline');
  if(torture){
    // Undo a pre-mode-change edit: provenance must not rewind with the timeline.
    s=await api('/quick-reframe/'+s.id);
    s=await api(`/quick-reframe/${s.id}/mode`,'PUT',{revision:s.revision,mode:'XEEPRO'});
    p=await api(route+'/undo','POST',{revision:s.revision});
    check(p.settings.origin.aiMode==='ONLINE','Undo cannot silently switch the project mode');
    p=await api(route+'/redo','POST',{revision:p.revision});
    s=await api(`/quick-reframe/${s.id}/mode`,'PUT',{revision:p.revision,mode:'XEEFREE'});p=await api(route);
  }
  const before=(await api('/auth/session')).creditBalance;
  await api(`/quick-reframe/${s.id}/export`,'POST',{revision:p.revision,resolution:720});s=await settle(s.id);
  check(s.status==='COMPLETE'&&s.exports[0]?.current,`${s.mode} ${s.editPath} real export`);
  check((await api('/auth/session')).creditBalance===before-1,'successful export consumes exactly one credit');
  const r=await fetch(base+s.exports[0].url,{headers:{Cookie:cookie}});assert(r.ok);
  const file=path.join(out,`${s.mode}-${s.editPath}.mp4`);fs.writeFileSync(file,Buffer.from(await r.arrayBuffer()));
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8'}));
  check(Math.abs(Number(probe.format.duration)-(s.duration-2))<.2&&probe.streams.some(t=>t.codec_type==='audio'),'trim duration and audio verified');
  report.cases.push({id:s.id,editProjectId:s.editProjectId,mode:s.mode,style:s.editPath,hook:manualHook,captions:s.captionCount,export:file});save();return s;
}
async function editorChecks(user){
  const free=report.cases.find(c=>c.mode==='XEEFREE'),pro=report.cases.find(c=>c.mode==='XEEPRO');
  let audit=JSON.parse(fs.readFileSync(stateFile));const calls=audit.proCalls;
  const local=await api(`/edit-mode/projects/${free.editProjectId}/agent/run`,'POST',{message:'mute the original audio',aiConsent:false});
  check(local.ledger.some(entry=>entry.status==='DONE'),'Free Ask AI executes a local editing command');
  await api(`/edit-mode/projects/${free.editProjectId}/agent/run`,'POST',{message:'Make this a thoughtful documentary for teachers',aiConsent:false});
  audit=JSON.parse(fs.readFileSync(stateFile));check(!audit.freeAttempts&&audit.proCalls===calls,'ambiguous Free Ask AI never escalates');
  audit.busy=true;fs.writeFileSync(stateFile,JSON.stringify(audit));
  const online=await api(`/edit-mode/projects/${pro.editProjectId}/agent/run`,'POST',{message:'Make this a thoughtful documentary for teachers',aiConsent:true});
  check(online.ai?.code==='XEEPRO_BUSY'||JSON.stringify(online).includes('XEEPRO_BUSY'),'Pro Ask AI reports busy while manual editing remains available');
  audit=JSON.parse(fs.readFileSync(stateFile));audit.busy=false;fs.writeFileSync(stateFile,JSON.stringify(audit));
  const id=sql(`SELECT q.id FROM "QuickReframe" q JOIN "EditProject" p ON p.id=q."editProjectId" WHERE p."userId"='${user.id}' ORDER BY q."createdAt" DESC LIMIT 1`);
  assert.match(id,/^[0-9a-f-]{36}$/u);let s=await api('/quick-reframe/'+id),route=`/edit-mode/projects/${s.editProjectId}`,p=await api(route);
  const head=p.elements.find(e=>e.type==='TEXT'&&e.properties.presetRole==='HOOK');assert(head);
  const cmd=async(action,payload)=>p=await api(route+'/commands/'+action,'POST',{revision:p.revision,...payload});
  await cmd('set-text-size',{elementId:head.id,fontSize:300});await cmd('resize-element',{elementId:head.id,width:.02,height:.02});
  const before=(await api('/auth/session')).creditBalance;
  await api(`/quick-reframe/${id}/export`,'POST',{revision:p.revision,resolution:720});s=await settle(id);
  check(s.status==='FAILED'&&s.errorCode==='HEADLINE_DOES_NOT_FIT','Quick export preserves typed headline-fit failure');
  check((await api('/auth/session')).creditBalance===before,'failed export refunds its reservation');
  const key=sql(`SELECT "jobKey" FROM "CreditReservation" WHERE "resourceId"='${id}' AND status='REFUNDED' ORDER BY "createdAt" DESC LIMIT 1`);
  assert.match(key,/^reframe:[0-9a-f-]{36}$/u);
  const settleCode=`require('reflect-metadata');const {PrismaClient}=require('@prisma/client');const {UsageService}=require('./dist/modules/auth/usage.service');const p=new PrismaClient();const u=new UsageService(p);Promise.all([u.settle('${key}',false),u.settle('${key}',false)]).then(()=>p.$disconnect()).catch(e=>{console.error(e);process.exit(1)});`;
  execFileSync('docker',['exec','qr-final-qa-backend-1','node','-e',settleCode],{encoding:'utf8'});
  check((await api('/auth/session')).creditBalance===before,'duplicate refund settlement cannot refund twice');
  check(sql(`SELECT COUNT(*) FROM "CreditReservation" WHERE "resourceId"='${id}' AND status='RESERVED'`)==='0','no stuck reservation');
  p=await api(route);await cmd('set-text-size',{elementId:head.id,fontSize:42});await cmd('resize-element',{elementId:head.id,width:.88,height:.22});
  await api(`/quick-reframe/${id}/export`,'POST',{revision:p.revision,resolution:720});s=await settle(id);
  check(s.status==='COMPLETE','resized valid headline exports successfully');
  report.editorAcceptance=true;report.status='API_AND_EDITOR_ACCEPTANCE_PASSED';delete report.error;save();console.log('EDITOR_ACCEPTANCE_PASSED');
}
async function main(){
  fs.mkdirSync(out,{recursive:true});
  for(let attempt=0;;attempt++){
    try{const r=await fetch(base+'/health');if(!r.ok)throw Error('Starting');break;}
    catch(error){if(attempt>=40)throw error;await new Promise(resolve=>setTimeout(resolve,1000));}
  }
  const c=JSON.parse(execFileSync('docker',['inspect','qr-final-qa-backend-1','qr-final-qa-postgres-1'],{encoding:'utf8'}));
  check(c.every(v=>v.Config.Labels['com.docker.compose.project']==='qr-final-qa'&&Object.keys(v.NetworkSettings.Networks).every(n=>n==='qr-final-qa_default')),'isolated QA stack verified');
  if(resume)cookie=JSON.parse(fs.readFileSync(path.join(root,'.cache/quick-reframe-qa/browser-private.json'))).cookie;
  const user=resume ? await api('/auth/session') : await api('/auth/signup','POST',{email:`quick-reframe-qa-${Date.now()}@example.invalid`,password:randomBytes(24).toString('base64url')});
  assert.match(user.id,/^[0-9a-f-]{36}$/u);assert.match(user.email,/^quick-reframe-qa-\d+@example.invalid$/u);
  sql(`UPDATE "User" SET "creditBalance"=100 WHERE id='${user.id}' AND email='${user.email}'`);
  await api('/auth/preferences','PATCH',{aiProcessingConsent:true});
  fs.writeFileSync(path.join(root,'.cache/quick-reframe-qa/browser-private.json'),JSON.stringify({cookie,userId:user.id}));
  if(process.argv.includes('--editor-only'))return editorChecks(user);
  if(process.argv.includes('--refresh-zero')){
    for(const fixture of report.cases.filter(c=>c.style==='STYLEZERO')){
      let s=await api('/quick-reframe/'+fixture.id);
      await api(`/quick-reframe/${s.id}/stylezero`,'POST',{revision:s.revision,captions:'KEEP'});s=await settle(s.id);
      check(s.status==='READY','StyleZero updated through its actual compiler');
      const p=await api(`/edit-mode/projects/${s.editProjectId}`);check(p.settings.fitBackground==='BLACK','StyleZero saves a shared preview/export matte');
      await api(`/quick-reframe/${s.id}/export`,'POST',{revision:s.revision,resolution:720});s=await settle(s.id);assert.equal(s.status,'COMPLETE');
      const r=await fetch(base+s.exports[0].url,{headers:{Cookie:cookie}});assert(r.ok);fs.writeFileSync(fixture.export,Buffer.from(await r.arrayBuffer()));
    }
    report.status='API_AND_EDITOR_ACCEPTANCE_PASSED';save();return;
  }
  for(const mode of ['XEEFREE','XEEPRO'])for(const style of ['STYLEZERO','STYLEONE','STYLETWO']){
    if(resume&&report.cases.some(c=>c.mode===mode&&c.style===style))continue;
    let s=await uploadAndCrop();s=await api(`/quick-reframe/${s.id}/mode`,'PUT',{revision:s.revision,mode});
    await api(`/quick-reframe/${s.id}/${style.toLowerCase()}`,'POST',{revision:s.revision,captions:'GENERATE'});s=await settle(s.id);
    check(s.status==='READY'&&s.mode===mode&&s.editPath===style,`${mode} ${style} style and mode persisted`);
    const styled=await api(`/edit-mode/projects/${s.editProjectId}`);check(styled.elements.some(e=>e.type==='TEXT')&&styled.elements.some(e=>e.type==='SUBTITLE'),'grounded hook and real local ASR captions');
    if(mode==='XEEFREE'){
      await api(`/quick-reframe/${s.id}/hooks`,'POST',{externalAiAuthorized:true});s=await api('/quick-reframe/'+s.id);
      await api(`/quick-reframe/${s.id}/post-copy`,'POST',{revision:s.revision,version:s.postCopy.version,externalAiAuthorized:true});
      const audit=JSON.parse(fs.readFileSync(stateFile));check(!audit.freeAttempts&&!audit.transportAttempts,'Free zero provider and transport attempts');
    }
    await editAndExport(s,mode==='XEEFREE'&&style==='STYLETWO');
  }
  let s=await uploadAndCrop();s=await api(`/quick-reframe/${s.id}/mode`,'PUT',{revision:s.revision,mode:'XEEPRO'});
  const before=(await api('/auth/session')).creditBalance;
  let provider=JSON.parse(fs.readFileSync(stateFile));provider.busy=true;fs.writeFileSync(stateFile,JSON.stringify(provider));
  await api(`/quick-reframe/${s.id}/styleone`,'POST',{revision:s.revision,captions:'GENERATE'});s=await settle(s.id);
  check(s.status==='FAILED'&&s.errorCode==='XEEPRO_BUSY'&&s.mode==='XEEPRO'&&!s.exports.length,'busy terminates with safe product error, no fallback or output');
  check((await api('/auth/session')).creditBalance===before,'provider failure charges zero credits (reservation starts at export)');
  provider=JSON.parse(fs.readFileSync(stateFile));provider.busy=false;fs.writeFileSync(stateFile,JSON.stringify(provider));
  await api(`/quick-reframe/${s.id}/styleone`,'POST',{revision:s.revision,captions:'GENERATE'});s=await settle(s.id);
  check(s.status==='READY'&&s.mode==='XEEPRO','same-process same-project Pro recovery');
  const history=await api('/quick-reframe/history');check(report.cases.every(v=>history.some(h=>h.id===v.id&&h.mode===v.mode)),'History retains both modes and all styles');
  report.providerAudit=JSON.parse(fs.readFileSync(stateFile));check(!report.providerAudit.freeAttempts&&!report.providerAudit.transportAttempts&&report.providerAudit.proCalls>0,'zero-cloud Free and exercised mock Pro');
  report.status='API_ACCEPTANCE_PASSED';delete report.error;save();console.log('API_ACCEPTANCE_PASSED');
}
main().catch(error=>{report.status='FAILED';report.error=error.message;save();console.error(error);process.exitCode=1;});
