// Refresh current canonical exports after exercising explicit campaign fixes.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..'),dir=root+'/.real-qa-preview/clipper-v1',auth=JSON.parse(fs.readFileSync(root+'/.cache/clippers/qa/browser-private.json')),report=JSON.parse(fs.readFileSync(dir+'/acceptance.json')),base='http://localhost:4200',stateFile=root+'/.cache/clippers/qa/provider-state.json';
async function api(url,method='GET',body){const r=await fetch(base+url,{method,headers:{Cookie:auth.cookie,Origin:'http://localhost:3200',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const value=await r.json();assert(r.ok,`${method} ${url} -> ${r.status}`);return value;}
async function wait(fn,done){for(let n=0;n<300;n++){const v=await fn();if(done(v))return v;await new Promise(r=>setTimeout(r,1000));}throw Error('QA wait timed out');}
(async()=>{
 const c=JSON.parse(execFileSync('docker',['inspect','clipper-v1-qa-backend-1'],{encoding:'utf8'}));assert(c[0].Config.Labels['com.docker.compose.project']==='clipper-v1-qa');
 await wait(()=>fetch(base+'/health').then(r=>r.ok).catch(()=>false),v=>v);const balance=(await api('/auth/session')).creditBalance;
 for(const item of report.cases){
  await api(`/campaign-clips/${item.clipId}/fix`,'POST',{});await api(`/campaign-clips/${item.clipId}/export`,'POST',{});const clip=await wait(()=>api('/campaign-clips').then(rows=>rows.find(c=>c.id===item.clipId)),c=>c?.exportCurrent);
  if(clip.lifecycleStatus!=='POSTED')await api(`/campaign-clips/${item.clipId}/ready`,'POST',{acceptWarnings:true});
  const p=await api('/edit-mode/projects/'+item.editProjectId),logo=p.elements.find(e=>e.type==='IMAGE'&&p.assets.some(a=>a.id===e.assetId&&a.metadata?.campaignAssetId));assert(Math.abs(logo.properties.height-.1125)<.0001,'portrait logo box preserves its square media aspect');
  const response=await fetch(base+clip.downloadUrl,{headers:{Cookie:auth.cookie}});assert(response.ok);fs.writeFileSync(item.export,Buffer.from(await response.arrayBuffer()));item.revision=p.revision;console.log('PASS current canonical logo export '+item.mode+' '+item.style);
 }
 assert((await api('/auth/session')).creditBalance===balance,'canonical fixes/exports do not charge another generation');
 if(process.argv.includes('--exports-only')){fs.writeFileSync(dir+'/acceptance.json',JSON.stringify(report,null,2));console.log('CAMPAIGN_CURRENT_EXPORTS_PASSED');return;}
 const audit=JSON.parse(fs.readFileSync(stateFile));const [run]=await api(`/campaigns/${report.campaigns.simple}/generate`,'POST',{sourceIds:[report.sources.simple],mode:'XEEFREE',style:'STYLEZERO',count:1,requestKey:'free-after-pro-'+Date.now()});
 const done=await wait(()=>api('/campaigns/'+report.campaigns.simple),c=>{const r=c.runs.find(r=>r.id===run.id);if(r.status==='FAILED')throw Error(r.error);return r.status==='COMPLETED';});const clip=done.clips.find(c=>c.runId===run.id);assert(clip.exportCurrent);const project=await api('/edit-mode/projects/'+clip.editProjectId);assert(project.settings.origin.aiMode==='FALLBACK_ONLY');const after=JSON.parse(fs.readFileSync(stateFile));assert(after.freeAttempts===0&&after.transportAttempts===0&&after.proCalls===audit.proCalls);assert((await api('/auth/session')).creditBalance===balance-1);
 report.freeAfterPro={runId:run.id,clipId:clip.id,editProjectId:clip.editProjectId,zeroAdditionalProCalls:true};report.canonicalExportsRefreshed=true;fs.writeFileSync(dir+'/acceptance.json',JSON.stringify(report,null,2));console.log('CAMPAIGN_CURRENT_EXPORTS_AND_FREE_AFTER_PRO_PASSED');
})().catch(e=>{console.error(e.message);process.exitCode=1});
