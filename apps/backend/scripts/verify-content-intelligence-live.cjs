// Isolated real-media acceptance. Never run against the production API.
const assert = require('node:assert/strict');
const {readFileSync,writeFileSync,mkdirSync} = require('node:fs');
const {basename,resolve} = require('node:path');
const {randomBytes} = require('node:crypto');
const {transcriptSimilarity} = require('../dist/modules/content-intelligence/creative-quality.service');
const root=resolve(__dirname,'../../..'), out=resolve(root,process.env.INTEL_QA_OUT || '.real-qa-preview/content-intelligence');
const base=process.env.INTEL_QA_URL || 'http://127.0.0.1:4100', origin='http://localhost:3100';
if(!/^http:\/\/(?:127\.0\.0\.1|localhost):4100$/u.test(base))throw Error('Only isolated QA on port 4100 is allowed.');
// INTEL_QA_MEDIA: an authorized source video (default: the authored advice speech).
const mediaPath=process.env.INTEL_QA_MEDIA || resolve(root,'.real-qa-preview/content-intelligence/disposable-advice.mp4');
const media=readFileSync(mediaPath), mediaName=basename(mediaPath);let cookie='';
const online=process.env.INTEL_QA_ONLINE==='true';
async function api(path,method='GET',body){
  const form=body instanceof FormData;
  const r=await fetch(base+path,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body&&!form?{'Content-Type':'application/json'}:{})},body:form?body:body?JSON.stringify(body):undefined});
  const data=await r.json().catch(()=>({}));
  assert.ok(r.ok,`${method} ${path}: ${r.status} ${data.message || data.error || ''}`);
  if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return data;
}
async function wait(load,done,label){const start=Date.now();for(;;){const s=await load();
  if(s.status==='FAILED'||s.analysisStatus==='FAILED')throw Error(`${label} failed: ${s.error || s.message || JSON.stringify(s)}`);
  if(done(s))return s;if(Date.now()-start>600000)throw Error(`${label} timed out`);await new Promise(r=>setTimeout(r,1500));}}
async function download(url,file){const r=await fetch(base+url,{headers:{Cookie:cookie}});assert.ok(r.ok,`download ${r.status}`);writeFileSync(resolve(out,file),Buffer.from(await r.arrayBuffer()));}
async function createClips(){
  const project=await api('/projects','POST',{name:'Disposable Content Intelligence QA',description:'Disposable acceptance source: '+mediaName});
  const form=new FormData();form.set('file',new Blob([media],{type:'video/mp4'}),mediaName);form.set('aiMode',online?'ONLINE':'FALLBACK_ONLY');form.set('processingType','EDITED_CLIPS');form.set('aspectRatio','9:16');form.set('targetPlatform','YOUTUBE_SHORTS');
  const video=await api(`/projects/${project.id}/videos`,'POST',form);const id=video.id;
  console.log('Create Clips: source uploaded; waiting for analysis.');
  await wait(()=>api(`/videos/${id}/clip-analysis`),s=>s.analysisStatus==='READY','Create Clips analysis');
  await api(`/videos/${id}/clip-selection`,'POST',{requestedClipCount:1,outputStyle:'AI_EDITED',generation:{templateId:'AUTOMATIC_2'}});
  const result=await wait(()=>api(`/videos/${id}/clip-results`),s=>['COMPLETED','PARTIAL','FAILED'].includes(s.status),'Create Clips render');
  assert.ok(result.clips?.length,`No rendered clip: ${JSON.stringify(result)}`);
  const styled=await wait(()=>api(`/videos/${id}/clip-results`),s=>s.clips?.some(c=>c.style?.playbackUrl || c.style?.status==='STYLE_FAILED'),'StyleOne styling');
  const clip=styled.clips[0];assert.ok(clip.hook && clip.synopsis && clip.caption && clip.hashtags.length);
  assert.ok(clip.style?.playbackUrl,'StyleOne export ready');
  await download(clip.style.playbackUrl,'create-styleone.mp4');
  const transcript=await api(`/videos/${id}/transcript`);
  assert.ok(!transcriptSimilarity(clip.hook,transcript.text).copied,'rendered headline reframes the spoken idea');
  // Topic-agnostic specificity: the synopsis names actual spoken content, tags are not generic spam.
  const words=text=>new Set(text.toLowerCase().match(/[\p{L}\p{N}']{4,}/gu) ?? []);
  const spoken=words(transcript.text);
  assert.ok([...words(clip.synopsis)].filter(w=>spoken.has(w)).length>=2,'synopsis is specific to the spoken content');
  assert.ok(!clip.hashtags.some(t=>/^#(?:viral|fyp|foryou|trending|reels|shorts)$/iu.test(t)),'no generic hashtag spam');
  const history=await api('/history/clips');const saved=history.find(c=>c.id===clip.id);assert.ok(saved,'History persists generated clip');
  assert.equal(saved.synopsis,clip.synopsis);assert.ok(saved.caption && saved.hashtags.length,'History exposes useful final post copy');
  assert.ok(!JSON.stringify(saved).includes('"model"'),'History hides internal model details');
  console.log('Create Clips → StyleOne: actual export downloaded.');
  return {videoId:id,clip,transcript};
}
async function quickManual(){
  let s=await api('/quick-reframe','POST',{});const id=s.id;
  const u=await api(`/quick-reframe/${id}/upload`,'POST',{name:mediaName,size:media.length,mimeType:'video/mp4'});
  for(let i=0;i<u.chunks;i++){
    const r=await fetch(`${base}/quick-reframe/uploads/${u.id}/chunks/${i}`,{method:'PUT',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/octet-stream'},body:media.subarray(i*u.chunkBytes,(i+1)*u.chunkBytes)});assert.ok(r.ok);
  }
  await api(`/quick-reframe/uploads/${u.id}/complete`,'POST',{});
  await api(`/quick-reframe/${id}/playback`,'POST',{});
  const active=['PLAYBACK','ANALYZE','PREPARE','PREVIEW','EXPORT','IMPORT'];
  const settle=()=>wait(()=>api(`/quick-reframe/${id}`),s=>!active.includes(s.status),'Quick Reframe');
  s=await settle();await api(`/quick-reframe/${id}/confirm-crop`,'POST',{revision:s.revision});s=await settle();
  await api(`/quick-reframe/${id}/path`,'POST',{revision:s.revision,path:'MANUAL'});s=await settle();
  console.log('Quick Reframe: confirmed crop, Manual selected.');
  const h=await api(`/quick-reframe/${id}/hooks`,'POST',{externalAiAuthorized:online});s=h.session;
  assert.ok(s.hooks.length && s.hooks.some(h=>h.recommended),'ranked manual suggestions');
  const copy=await api(`/quick-reframe/${id}/post-copy`,'POST',{revision:s.revision,version:s.postCopy.version,externalAiAuthorized:online});s=copy.session;
  assert.ok(s.postCopy.synopsis && s.postCopy.generatedCaptions.length && s.postCopy.generatedHashtagSets.length);
  assert.ok(!JSON.stringify(s.postCopy).includes('"model"'),'internal models hidden');
  const editorHooks=await api(`/edit-mode/projects/${s.editProjectId}/hooks`,'POST',{revision:s.revision,externalAiAuthorized:false,direction:'More professional'});
  assert.ok(editorHooks.package.hooks.length,'generic editor uses same service');
  const editorCopy=await api(`/edit-mode/projects/${s.editProjectId}/hooks`,'POST',{revision:s.revision,externalAiAuthorized:false,hooksOnly:false});
  assert.ok(editorCopy.package.synopsis && editorCopy.package.captions.length,'manual editor writes a full shared package');
  await api(`/quick-reframe/${id}/export`,'POST',{revision:s.revision,resolution:720});s=await settle();
  assert.ok(s.exports[0]?.current);await download(s.exports[0].url,'quick-manual.mp4');
  console.log('Quick Reframe → Manual: actual export downloaded.');
  return {id,postCopy:s.postCopy,hooks:s.hooks,export:s.exports[0],warnings:[...h.warnings,...copy.warnings]};
}
async function main(){
  mkdirSync(out,{recursive:true});
  await api('/auth/signup','POST',{email:`intel-qa-${Date.now()}@example.invalid`,password:randomBytes(24).toString('base64url'),displayName:'Disposable Intelligence QA'});
  await api('/auth/preferences','PATCH',{aiProcessingConsent:true});
  const results=await Promise.allSettled([createClips(),quickManual()]);
  const report={date:new Date().toISOString(),environment:'isolated production services',online,results:results.map(r=>r.status==='fulfilled'?{passed:true,...r.value}:{passed:false,error:r.reason.message})};
  writeFileSync(resolve(out,'live-report.json'),JSON.stringify(report,null,2));
  assert.ok(results.every(r=>r.status==='fulfilled'),JSON.stringify(report.results.filter(r=>!r.passed)));
  console.log('Both acceptance paths passed. Report saved without credentials.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
