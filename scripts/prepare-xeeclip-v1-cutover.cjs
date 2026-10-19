// Prepare concrete cutover/rollback commands; does not change production.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'.cache/xeeclip-v1-release');
const previous='C:/projects/ai-content-platform/.real-qa-preview/quick-reframe-result-flow-release';
const read=n=>JSON.parse(fs.readFileSync(path.join(dir,n)));const save=(n,v)=>fs.writeFileSync(path.join(dir,n),JSON.stringify(v,null,2));
const candidate=read('candidate.json'),backup=read('backup.json'),live=read('production-containers.private.json');
assert(backup.verified&&backup.migrationRehearsal);const backend=live.find(c=>c.Name==='/ai-content-backend');
save('backend-before.private.json',{Id:backend.Id,Image:backend.Image,Config:backend.Config,HostConfig:backend.HostConfig,Mounts:backend.Mounts});
save('production-initial.json',live.map(c=>({name:c.Name,id:c.Id,image:c.Image,startedAt:c.State.StartedAt,environmentHash:crypto.createHash('sha256').update(JSON.stringify([...c.Config.Env].sort())).digest('hex')})));
fs.copyFileSync(path.join(dir,'production-env.private'),path.join(dir,'env-before.private'));
backup.timestamp=backup.at;backup.cloudflareRollbackVersion='deed86b9-6b48-4d93-a48f-93a78f7fe45d';save('backup.json',backup);
const oldWin='C:\\projects\\ai-content-platform\\.real-qa-preview\\quick-reframe-result-flow-release';
for(const name of ['gate.cjs','maintenance-on.ps1','maintenance-off.ps1','deploy-backend.cjs','post-deploy-watch.cjs']){
 let text=fs.readFileSync(path.join(previous,name),'utf8');
 text=text.replaceAll(oldWin,dir).replaceAll('quick-reframe-result-flow-release.*gate.cjs','xeeclip-v1-release.*gate.cjs');
 if(name==='deploy-backend.cjs')text=text.replace("const image=rollback?backup.rollbackTag:'xeeclip-backend:result-flow-791547e'","const image=rollback?backup.rollbackTag:candidate.tag");
 if(name==='post-deploy-watch.cjs')text=text.replaceAll("'scripts/mobile-music-runtime-state.cjs'","'C:/projects/ai-content-platform/scripts/mobile-music-runtime-state.cjs'");
 fs.writeFileSync(path.join(dir,name),text);
}
if(!fs.existsSync(path.join(dir,'gate-state.json')))save('gate-state.json',{enabled:false,qaSessionHashes:[]});
const stateCode=fs.readFileSync('C:/projects/ai-content-platform/scripts/mobile-music-runtime-state.cjs','utf8');
const state=JSON.parse(execFileSync('docker',['exec','-i','ai-content-backend','node','-'],{input:stateCode,encoding:'utf8',maxBuffer:64<<20}));assert(state.idle);save('before-state.json',state);
console.log('Prepared maintenance, exact-environment backend cutover, rollback and bounded health watch. Nothing deployed.');
