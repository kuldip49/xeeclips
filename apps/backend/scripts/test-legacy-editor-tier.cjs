const assert=require('node:assert/strict');const {withTrustedProjectTier}=require('../dist/modules/processing/project-execution-policy');const {projectExecutionPolicy}=require('../dist/modules/processing/execution-policy');let count=0;
const clipDate=new Date('2026-10-10T12:00:00Z');const project={userId:'owner',generatedClipId:'clip',settings:{origin:{originKind:'GENERATED_CLIP'}}};
function db({clip,job}={}){return {generatedClip:{findFirst:async query=>{assert.equal(query.where.id,'clip');assert.equal(query.where.video.project.userId,'owner');return clip;}},processingJob:{findUnique:async query=>{assert.equal(query.where.id,'original');return job;},findFirst:async query=>{assert.equal(query.where.videoId,'video');assert.equal(query.where.createdAt.lte,clipDate);assert.deepEqual(query.orderBy,{createdAt:'desc'});return job;}}};}
const clip={videoId:'video',generationJobId:'original',createdAt:clipDate,editTelemetry:{}};const job={videoId:'video',aiMode:'ONLINE',telemetry:{effectiveAiMode:'ONLINE'},startedAt:new Date('2026-10-10T11:00:00Z'),status:'COMPLETED'};
async function check(name,input,expected){const before=JSON.stringify(project);const p=await withTrustedProjectTier(db(input),project);assert.equal(projectExecutionPolicy(p.settings).mode,expected);assert.equal(JSON.stringify(project),before,'projection cannot mutate persisted/input settings');count++;console.log('PASS',name);return p;}
(async()=>{
 await check('legacy Pro recovers original job tier',{clip,job},'XEEPRO');
 await check('legacy Free never follows a newer Pro analysis',{clip,job:{...job,aiMode:'FALLBACK_ONLY',telemetry:{effectiveAiMode:'FALLBACK_ONLY'}}},'XEEFREE');
 await check('clip effective mode wins over requested Pro',{clip:{...clip,editTelemetry:{effectiveAiMode:'FALLBACK_ONLY'}},job},'XEEFREE');
 await check('job effective Free wins over requested Online',{clip,job:{...job,telemetry:{effectiveAiMode:'FALLBACK_ONLY'}}},'XEEFREE');
 await check('pre-link legacy clip uses only historical completed jobs',{clip:{...clip,generationJobId:null},job},'XEEPRO');
 await check('rerun after clip cannot prove original Pro tier',{clip,job:{...job,startedAt:new Date('2026-10-11T12:00:00Z')}},'XEEFREE');
 await check('wrong source job is refused',{clip,job:{...job,videoId:'another-video'}},'XEEFREE');
 await check('foreign or missing clip stays fail-closed',{clip:null,job},'XEEFREE');
 const standalone={settings:{}};assert.equal(await withTrustedProjectTier({},standalone),standalone);assert.equal(projectExecutionPolicy(standalone.settings),null);count++;
 const explicit={...project,settings:{origin:{aiMode:'FALLBACK_ONLY'}}};assert.equal(await withTrustedProjectTier({},explicit),explicit);count++;
 console.log(JSON.stringify({legacyEditorTierChecks:count,databaseWrites:0,providerCalls:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});