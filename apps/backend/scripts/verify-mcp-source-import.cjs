const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {request,connect,call,accounts,base}=require('./mcp-acceptance-client.cjs');
const dir=process.env.MCP_QA_DIR, file=path.join(dir,'source-import-acceptance.json');
const urls=JSON.parse(fs.readFileSync(process.env.MCP_IMPORT_URLS_FILE,'utf8'));
const report=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{providers:{}};
const save=()=>fs.writeFileSync(file,JSON.stringify(report,null,2)),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{const a=accounts[0],c=await connect(a),foreign=await connect(accounts[1]);try{
 const supported=await call(c,'get_supported_sources');assert.deepEqual(supported.providers.map(p=>p.id),['YOUTUBE','INSTAGRAM','X']);assert.equal(supported.maxDurationSeconds,10800);assert.equal(supported.analysisMode,'XEEFREE');report.supported=supported;
 const before=await call(c,'get_credits');
 for(const [provider,url]of Object.entries(urls)){
  if(report.providers[provider]?.sourceId)continue;
  const input={url,title:'Disposable URL import '+provider,idempotencyKey:'url-import-'+provider.toLowerCase()+(report.providers[provider]?.errorCode&&process.env.MCP_IMPORT_RETRY==='1'?'-retry-'+(process.env.MCP_IMPORT_RETRY_SUFFIX||'002'):'-001')};
  const at=Date.now(),job=await call(c,'import_source',input);assert(job.importId);assert.equal(job.provider,provider);assert(Date.now()-at<10000,'import admission must return without waiting for media');
  assert.deepEqual(await call(c,'import_source',input),job);
  const duplicates=await Promise.all([call(c,'import_source',input),call(c,'import_source',input)]);for(const x of duplicates)assert.deepEqual(x,job);
  const denied=await foreign.callTool({name:'xeeclip_get_source_import',arguments:{importId:job.importId}});assert(denied.isError);assert.equal(denied.structuredContent.error.code,'NOT_FOUND');
  const item=report.providers[provider]={importId:job.importId,admissionMs:Date.now()-at,stableRetries:true,foreignDenied:true};save();
  const end=Date.now()+1800000;let complete;
  while(Date.now()<end){const state=await call(c,'get_source_import',{importId:job.importId});assert(!/objectKey|bucket|yt-dlp|Prisma|ffmpeg|stack|googlevideo\.com/i.test(JSON.stringify(state)));if(state.status==='COMPLETE'){complete=state;break;}if(state.status==='FAILED'){Object.assign(item,{available:false,errorCode:state.errorCode,error:state.error,publicSafeFailure:true});save();console.log(provider+' import unavailable: '+state.errorCode);break;}if(!item.logged||Date.now()-item.logged>30000){console.log(provider+' import: '+state.status);item.logged=Date.now();}await sleep(state.recommendedPollAfterMs||5000);}
  if(complete){assert.equal(complete.sourceStatus,'READY');const source=await call(c,'get_source',{sourceId:complete.sourceId});assert.equal(source.status,'COMPLETED');const website=(await request('/videos',{cookie:a.cookie})).value;assert(website.some(v=>v.id===source.sourceId&&v.sourceType===provider));const reuse=await call(c,'import_source',{...input,idempotencyKey:input.idempotencyKey+'-different-intention'});assert.equal(reuse.importId,job.importId);Object.assign(item,{passed:true,available:true,sourceId:source.sourceId,duration:source.duration,websiteVisible:true,reusedOwnedImport:true});accounts[0].sourceId ||= source.sourceId;require('./mcp-acceptance-client.cjs').save();console.log('PASS '+provider+' URL → normal owned source READY, website visible, stable duplicate imports.');save();}
  else if(!item.errorCode){item.errorCode='QA_TIMEOUT';save();throw Error(provider+' did not settle within its bounded import test');}
 }
 report.creditsUnchanged=(await call(c,'get_credits')).credits===before.credits;assert(report.creditsUnchanged);
 for(const url of ['https://www.tiktok.com/@owner/video/123','https://facebook.com/watch?v=123','https://vimeo.com/123','https://twitch.tv/videos/123','https://example.com/video.mp4']){const r=await c.callTool({name:'xeeclip_import_source',arguments:{url,idempotencyKey:'unsupported-'+Buffer.from(url).toString('hex').slice(-40)}});assert(r.isError);assert.equal(r.structuredContent.error.code,'UNSUPPORTED_SOURCE');}
 report.unsupportedClean=true;report.passed=Object.values(report.providers).every(p=>p.passed);report.missingLiveUrls=supported.providers.filter(p=>p.urlImport&&!urls[p.id]).map(p=>p.id);report.at=new Date().toISOString();save();
 console.log('URL acceptance complete; imports with READY sources: '+Object.entries(report.providers).filter(([,p])=>p.passed).map(([p])=>p).join(', ')+'. Missing authorized URLs: '+report.missingLiveUrls.join(', '));
 if(!report.passed)process.exitCode=1;
}finally{await c.close();await foreign.close();}})().catch(e=>{report.failure=e.message;save();console.error(e.message);process.exitCode=1});
