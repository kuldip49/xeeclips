// Remove only the exact disposable accounts' content through their authenticated APIs.
const { chromium }=require('playwright');const assert=require('node:assert/strict');const fs=require('node:fs');const {join}=require('node:path');const {spawnSync}=require('node:child_process');
const root=join(__dirname,'..'),folder=join(root,'storage/security-backups'),s=JSON.parse(fs.readFileSync(join(folder,'production-test-state.json'),'utf8'));
const config=Object.fromEntries(fs.readFileSync(join(root,'.env'),'utf8').split(/\r?\n/).filter(v=>/^[A-Z_]+=/.test(v)).map(v=>{const i=v.indexOf('=');return[v.slice(0,i),v.slice(i+1).replace(/^(['"])(.*)\1$/,'$2')]}));
const origin='https://xeeclip.me',api='https://api.xeeclip.me';let browser;
config.ADMIN_INITIAL_PASSWORD ||= fs.readFileSync(join(folder,'owner-login.txt'),'utf8').match(/^Initial password: (.+)$/m)?.[1];
async function call(c,p,method='GET',body){const r=await c.request.fetch(api+p,{method,headers:{Origin:origin},...(body===undefined?{}:{data:body}),timeout:60000});return{status:r.status(),body:await r.json().catch(()=>null)}}
async function good(c,p,m,b){const r=await call(c,p,m,b);if(r.status>=400)throw new Error(p+': HTTP '+r.status);return r.body;}
async function main(){
 if(!/^security-\d+$/.test(s.prefix)||!s.aEmail.startsWith(s.prefix)||!s.bEmail.startsWith(s.prefix))throw new Error('Disposable account identity required.');
 browser=await chromium.launch({headless:true,channel:'chrome'});const owner=await browser.newContext(),a=await browser.newContext(),b=await browser.newContext();
 await good(owner,'/auth/login','POST',{email:config.ADMIN_EMAIL,password:config.ADMIN_INITIAL_PASSWORD});
 for(const [c,email,id]of[[a,s.aEmail,s.aId],[b,s.bEmail,s.bId]]){const u=await good(c,'/auth/login','POST',{email,password:s.password});assert.equal(u.id,id);assert.equal(u.role,'USER');}
 await good(owner,'/admin/users/'+s.aId+'/credits','POST',{mode:'SET',amount:1,reason:'Disposable live concurrency acceptance'});
 const q=await good(a,'/quick-reframe/'+s.qId);const before=await good(owner,'/admin/users/'+s.aId);
 const requests=await Promise.all([call(a,'/videos/'+s.videoId+'/clip-selection','POST',{requestedClipCount:1,outputStyle:'NORMAL',regenerate:true}),call(a,'/quick-reframe/'+s.qId+'/export','POST',{revision:q.revision,resolution:720})]);
 assert.equal(requests.filter(r=>r.status===201).length,1);assert.equal(requests.filter(r=>r.status===403&&r.body.code==='NO_CREDITS').length,1);
 const end=Date.now()+600000;let done=false;
 while(Date.now()<end){const v=requests[0].status===201?await good(a,'/videos/'+s.videoId+'/clip-results'):await good(a,'/quick-reframe/'+s.qId);if(v.status==='FAILED')throw new Error('Live concurrent winner failed.');if(v.status==='COMPLETED'||v.status==='COMPLETE'){done=true;break;}await new Promise(r=>setTimeout(r,4000));}
 assert.ok(done);assert.equal((await good(a,'/auth/session')).creditBalance,0);
 const after=await good(owner,'/admin/users/'+s.aId);assert.equal(after.ledger.filter(t=>t.type==='GENERATION_RESERVE').length,before.ledger.filter(t=>t.type==='GENERATION_RESERVE').length+1);
 console.log('PASS live concurrent Create Clips / Quick Reframe with ONE credit: one accepted, one NO_CREDITS, one reservation and consumption.');
 for(const c of[a,b]){
  for(const q of await good(c,'/quick-reframe/history'))await good(c,'/quick-reframe/'+q.id,'DELETE');
  for(const p of await good(c,'/edit-mode/projects'))await good(c,'/edit-mode/projects/'+p.id,'DELETE');
  for(const clip of await good(c,'/history/clips'))await good(c,'/generated-clips/'+clip.id,'DELETE');
  for(const v of await good(c,'/videos'))await good(c,'/videos/'+v.id,'DELETE');
  assert.deepEqual(await good(c,'/history/clips'),[]);await good(c,'/auth/logout','POST');
 }
 await good(owner,'/auth/logout','POST');
 const docker=process.env.DOCKER_EXE||'C:\\Users\\kuldi\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin\\docker.exe';
 let r=spawnSync(docker,['compose','cp','apps/backend/scripts/cleanup-auth-acceptance.cjs','backend:/app/apps/backend/scripts/cleanup-auth-acceptance.cjs'],{cwd:root,encoding:'utf8'});if(r.status!==0)throw new Error('Could not install operator cleanup helper.');
 r=spawnSync(docker,['compose','exec','-T','backend','node','scripts/cleanup-auth-acceptance.cjs','--apply'],{cwd:root,encoding:'utf8',input:JSON.stringify({prefix:s.prefix,aId:s.aId,bId:s.bId,aEmail:s.aEmail,bEmail:s.bEmail})});process.stdout.write(r.stdout||'');if(r.status!==0)throw new Error(r.stderr||'Account cleanup failed.');
 fs.writeFileSync(join(folder,'production-cleanup.json'),JSON.stringify({concurrency:'PASS: one accepted, one rejected, one reservation',accountsRemoved:2,contentRemoved:true,auditRetained:true},null,2));
 // Passwords and exact IDs are no longer needed; this file is task-specific inside ignored storage.
 fs.unlinkSync(join(folder,'production-test-state.json'));console.log('PASS disposable production content and accounts cleaned up.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>browser?.close());
