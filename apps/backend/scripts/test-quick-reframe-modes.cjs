const assert = require('node:assert/strict');
const { QuickReframeService } = require('../dist/modules/quick-reframe/quick-reframe.service');
const { reframeMode, parseReframeMode } = require('../dist/modules/quick-reframe/quick-reframe-mode');
const { projectExecutionPolicy } = require('../dist/modules/processing/execution-policy');
const { currentExecutionPolicy, performanceContext } = require('../dist/modules/processing/performance-telemetry');
const { markProviderBusy } = require('../dist/modules/processing/generation-availability');
const review = require('./fixtures/hook-review.cjs');

async function main() {
  const transcript = 'The explanation changes the debate. Arguments must stand on their own regardless of the speaker’s credentials.';
  let busy = false, calls = 0;
  const telemetry = [];
  const router = { async generate(input) {
    calls++; assert.equal(currentExecutionPolicy().mode, 'XEEPRO');
    telemetry.push(performanceContext.getStore());
    if (busy) { markProviderBusy('PROVIDER_QUOTA_UNAVAILABLE'); throw Error('synthetic capacity failure'); }
    return {data:input.role === 'critic' ? review(input) : input.role === 'clipUnderstanding' ? {}
      : {hooks:[{text:'Credentials cannot win this argument',category:'CURIOSITY',support:'Arguments must stand on their own merits'}]}};
  }};
  const q = {id:'disposable',editProjectId:'project',status:'CROPPED',operationId:null,postCopy:{version:0},hooks:[],editPath:'STYLEONE',
    editProject:{revision:1,userId:'qa',settings:{feature:'QUICK_REFRAME',origin:{aiMode:'FALLBACK_ONLY'},manual:'keep'},
      assets:[{id:'source',role:'SOURCE',duration:12,metadata:{hasAudio:true},transcript:{text:transcript}}]}};
  const service = Object.create(QuickReframeService.prototype);
  service.router = router; service.load = async()=>q; service.get = async()=>({...q,revision:q.editProject.revision,mode:reframeMode(q.editProject.settings)});
  service.cropConfirmed = ()=>true; service.needsAnalysis = ()=>false;
  service.postCopyContext = ()=>({transcript,sourceId:q.id,visibleText:'',subtitleText:'',sourceContext:null,selectedHook:'',editingDirection:'',purpose:'',selectedCaption:''});
  service.prisma = {user:{findUnique:async()=>({aiProcessingConsentAt:new Date()})},
    quickReframe:{updateMany:async({data})=>{Object.assign(q,data);return{count:1};}},
    editProject:{updateMany:async({where,data})=>{if(where.revision!==q.editProject.revision)return{count:0};
      q.editProject.settings=data.settings;q.editProject.revision++;return{count:1};}}};
  service.prisma.$transaction = async fn=>fn(service.prisma);
  const free = await service.hooks(q.id,{externalAiAuthorized:true});
  assert(free.session.hooks.length); assert.equal(calls,0,'Free ignores a malicious external consent flag');
  await service.generateCopy(q.id,{revision:q.editProject.revision,version:q.postCopy.version,externalAiAuthorized:true});
  assert.equal(calls,0,'Free social copy never reaches a cloud route');
  assert.equal(reframeMode({feature:'QUICK_REFRAME'}),'XEEFREE','old Quick Reframe fails closed');
  assert.equal(projectExecutionPolicy({feature:'QUICK_REFRAME'}).mode,'XEEFREE');
  assert.throws(()=>parseReframeMode('ONLINE'));
  await assert.rejects(()=>service.setMode(q.id,{revision:0,mode:'XEEPRO'}));
  await service.setMode(q.id,{revision:q.editProject.revision,mode:'XEEPRO'});
  assert.equal(reframeMode(q.editProject.settings),'XEEPRO'); assert.equal(q.editProject.settings.manual,'keep');
  assert.equal(q.hooks.length,0,'mode switch invalidates suggestions without changing manual content');
  busy = true;
  await assert.rejects(()=>service.hooks(q.id,{externalAiAuthorized:false}),error=>error.getResponse().code==='XEEPRO_BUSY');
  assert.equal(q.hooks.length,0); const failedCalls=calls;
  busy = false; // SAME evidence, router and process: no deployment, restart or flag change.
  const recovered = await service.hooks(q.id,{externalAiAuthorized:false});
  assert(calls>failedCalls,'busy understanding/package results were not cached');
  assert(recovered.session.hooks.some(h=>h.text==='Credentials cannot win this argument'));
  assert(telemetry.every(t=>t.executionMode==='XEEPRO'));
  q.status='ANALYZE'; await assert.rejects(()=>service.setMode(q.id,{revision:q.editProject.revision,mode:'XEEFREE'}));
  q.status='CROPPED'; await service.setMode(q.id,{revision:q.editProject.revision,mode:'XEEFREE'});
  const before=calls; await service.hooks(q.id,{externalAiAuthorized:true}); assert.equal(calls,before);
  q.editProject.settings.resolvedVisualLayout={editingProfile:'AUTOMATIC_3_STYLE_TWO'};
  q.editProject.settings.quickReframeStyleOne=true; // Older sessions could retain both style flags.
  assert.equal(service.styleOf(q),'STYLETWO','canonical layout overrides an older wizard path and stale flags');
  q.editProject.settings={feature:'QUICK_REFRAME',origin:{aiMode:'FALLBACK_ONLY'}};
  assert.equal(service.styleOf(q),null,'Undo to the unstyled crop composes the canonical manual project');
  console.log('PASS Quick Reframe: saved modes, legacy fail-closed, zero Free provider entries, Pro-only routing, busy, same-process recovery, no implicit switching, stale revisions and manual-content preservation');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
