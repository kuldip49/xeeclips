require('reflect-metadata');
const assert = require('node:assert/strict');
const { HOOK_LANGUAGE_CHECKS, xeeProHookApproved, hookLanguageProblems } = require('../dist/modules/content-intelligence/hook-language');
const { sharedQuality:q, parseHookReview, hookMeetsThreshold } = require('../dist/modules/content-intelligence/creative-quality.service');
const { localUnderstanding } = require('../dist/modules/content-intelligence/content-understanding.service');
const { CreativePackageService, deterministicCreative } = require('../dist/modules/content-intelligence/creative-package.service');
const { VideoEditExecutorService } = require('../dist/modules/editing/video-edit-executor.service');
const { fallbackEditPlan } = require('../dist/modules/editing/edit-plan');
const { buildRenderPlan } = require('../dist/modules/edit-mode/render/edit-mode-render-plan');
const { hookFitsTemplates } = require('../dist/modules/content-intelligence/hook-fit');
const { EditChatService } = require('../dist/modules/edit-mode/chat/edit-chat.service');
const { EditModeService } = require('../dist/modules/edit-mode/edit-mode.service');
const { QuickReframeService } = require('../dist/modules/quick-reframe/quick-reframe.service');
const { LlmRouterService, AI_MODE_ROLE_TIMEOUTS } = require('../dist/modules/processing/llm-router.service');
const { performanceContext, createPerformanceTelemetry } = require('../dist/modules/processing/performance-telemetry');
const fixtures = require('./fixtures/xeepro-hook-grammar.json');
const language = Object.fromEntries(HOOK_LANGUAGE_CHECKS.map(k => [k, true]));
const verdict = over => ({ approved:true, clickability:90, context:95, grounding:95, misleadingRisk:5,
  specificity:90, naturalness:95, summaryLike:false, unclearReference:false, issue:'', why:'supported', language, ...over });
const hook = text => ({text,category:'CURIOSITY'});
const evidence = { transcript: 'The explanation changes the debate. Arguments must stand on their own regardless of the speaker’s credentials.',
  analysis:{mainClaim:'Arguments stand on their own merits.'} };
const u = localUnderstanding(evidence);
function judged(text, over={}) {
  const screened = q.screen([hook(text)], evidence, u, [], {strictLanguage:true});
  return q.applyReviews(screened.passed, [{index:0,...verdict(over)}], evidence);
}
(async()=>{
  let cases = 0;
  for(const fixture of fixtures) {
    const e={transcript:fixture.transcript};
    const old=q.screen([hook(fixture.oldHook)],e,localUnderstanding(e),[],{strictLanguage:true});
    assert.equal(old.passed.length,0);assert(old.rejected.some(r=>r.code==='NO_STITCHED_TRANSCRIPT_FRAGMENT'));cases++;
  }
  for(const text of ["What's behind clear and idea?",'Why does think and say?',"What's behind this and that?",'Why does the explanation?', 'The argument changes because', 'They changed the entire argument']) {
    assert(hookLanguageProblems(text).length,text);assert.equal(judged(text).approved.length,0);cases++;
  }
  // Semantic failures cannot be overridden by perfect clickability/context scores.
  for(const [text,key] of [
    ['The explanation agree the argument','GRAMMAR_OK'],
    ['Bananas negotiate invisible calendars','NO_WORD_SALAD'],
    ['Tell reason puffing agree argument','NO_STITCHED_TRANSCRIPT_FRAGMENT'],
    ['The credentials eat the explanation','MEANING_CLEAR'],
    ['Why did that change everything?','NO_DANGLING_PRONOUN'],
    ['Because the argument was','CONTEXT_COMPLETE']]) {
    assert.equal(judged(text,{language:{...language,[key]:false}}).approved.length,0);cases++;
  }
  for(const key of HOOK_LANGUAGE_CHECKS) {
    assert.equal(judged('The surprising gap between credentials and arguments',{language:{...language,[key]:false}}).approved.length,0);
    const missing={...language};delete missing[key];assert.equal(parseHookReview(verdict({language:missing})),undefined);cases++;
  }
  assert.equal(parseHookReview(verdict({language:undefined})),undefined);
  assert.equal(judged('The surprising gap between credentials and arguments',{summaryLike:true,specificity:10}).approved.length,0);cases++;
  assert.equal(judged('The debate proved every university suppresses speech',{grounding:10,misleadingRisk:90}).approved.length,0);cases++;
  for(const text of ['Credentials cannot win this argument',
    'Why impressive credentials still cannot settle a debate when the arguments have to stand on their own merits']) {
    const h=judged(text).approved[0];assert(h && xeeProHookApproved(h)&&hookMeetsThreshold(h));
    assert(hookFitsTemplates(text).all,text);cases++;
  }
  const calls=[];
  const corrected='Why credentials cannot settle the argument';
  const router={async generate(i){calls.push(i);return {data:i.role==='critic'
    ? {reviews:JSON.parse(i.request.userPrompt).hooks.map(h=>({index:h.index,...verdict()}))}
    : {hooks:[hook(i.request.schemaName==='shared_hook_language_rewrite_v1'?corrected:"What's behind tell and reason?")]}};}};
  const p=await new CreativePackageService(router).create({external:true,hooksOnly:true,evidence});
  assert.equal(p.selectedHook,corrected);assert(xeeProHookApproved(p.hooks[0]));
  assert.equal(calls.filter(i=>i.request.schemaName==='shared_hook_language_rewrite_v1').length,1);
  assert(calls.find(i=>i.role==='critic').request.userPrompt.includes(corrected));cases++;
  const down=await new CreativePackageService({async generate(){throw Error('unavailable');}})
    .create({external:true,hooksOnly:true,evidence,selectedHook:"What's behind tell and reason?"});
  assert.equal(down.hooks.length,0);assert.equal(down.selectedHook,'');cases++;
  const holistic=await new CreativePackageService({async generate(i){return {data:i.role==='critic'?{supported:true}: {hooks:[hook(corrected)]}};}})
    .create({external:true,hooksOnly:true,evidence});
  assert.equal(holistic.hooks.length,0);cases++;
  // XeeFree has its own typed-slot hook engine: it never calls a provider, never carries the XeePro gate marker, and can no longer
  // produce the stitched "What's behind X and Y?" / "X through the lens of Y" salad the old template baseline emitted for this clip.
  const free=await new CreativePackageService({generate(){throw Error('must not call');}}).create({external:false,evidence,hooksOnly:true});
  assert.equal(free.hookLanguageGate,undefined);
  assert(free.hooks.every(h=>h.source==='LOCAL' && !/what['’]s behind|through the lens of|what actually matters/iu.test(h.text) && require('../dist/modules/content-intelligence/hook-language').hookLanguageProblems(h.text).length===0));
  assert(!free.hooks.some(h=>/\b(?:tell|reason|explanation|changes)\b and\b/iu.test(h.text)),'no stitched transcript words');cases++;
  const bad=fixtures[0].oldHook, plan={...fallbackEditPlan(0,5,'9:16'),hookRequired:true,
    onScreenHook:{enabled:true,text:bad,startSec:0,endSec:5,position:'TOP',style:'TOP_HEADLINE'}};
  await assert.rejects(new VideoEditExecutorService().execute('missing.mp4','out.mp4',plan,[],[],[],[],{xeePro:true}),/grammar\/clarity review required/);cases++;
  const input={project:{id:'test',revision:0,settings:{contentIntelligence:{hookLanguageGate:'XEEPRO_V1',hooks:[]}}},
    assets:[{id:'src',role:'SOURCE',mimeType:'video/mp4',duration:5,width:1920,height:1080,fps:30,metadata:{},transcript:null,analysis:null}],
    elements:[{id:'video',assetId:'src',type:'VIDEO',track:0,position:0,startTime:0,duration:5,trimStart:0,trimEnd:5,properties:{}},
      {id:'hook',assetId:null,type:'TEXT',track:1,position:0,startTime:0,duration:5,trimStart:0,trimEnd:null,properties:{content:bad,presetRole:'HOOK'}}]};
  assert.throws(()=>buildRenderPlan(input),e=>e.code==='HOOK_LANGUAGE_GATE');cases++;
  // Legacy generated clips retain their ONLINE lineage even when newer suggestions are local.
  input.project.settings={origin:{aiMode:'ONLINE'},contentIntelligence:{hooks:[]}};
  assert.throws(()=>buildRenderPlan(input),e=>e.code==='HOOK_LANGUAGE_GATE');cases++;
  const approved=judged(corrected).approved[0];assert(approved);
  input.elements[1].properties.content=corrected;
  input.project.settings={contentIntelligence:{hookLanguageGate:'XEEPRO_V1',hooks:[approved]}};
  assert.equal(buildRenderPlan(input).plan.textOverlays[0].content,corrected);cases++;
  input.elements[1].properties.uppercase=true;
  assert.equal(buildRenderPlan(input).plan.textOverlays[0].content,corrected.toUpperCase());cases++;
  input.elements[1].properties.uppercase=false;
  input.project.settings.feature='QUICK_REFRAME';input.elements[1].properties.manualHookText=true;
  input.elements[1].properties.content='My manually chosen headline';
  assert.equal(buildRenderPlan(input).plan.textOverlays[0].content,'My manually chosen headline');cases++;
  input.elements[1].properties.manualHookText=false;
  assert.throws(()=>buildRenderPlan(input),e=>e.code==='HOOK_LANGUAGE_GATE');cases++;
  input.elements[1].properties.content=corrected;
  // New editor suggestions cannot erase an existing Pro requirement.
  const editor=Object.create(EditModeService.prototype);let saved;
  editor.prisma={editProject:{findUniqueOrThrow:async()=>({settings:input.project.settings}),
    updateMany:async({data})=>{saved=data.settings;return{count:1};}}};
  await editor.saveCreativeSuggestions('test',0,{hooks:[],selectedHook:''});
  assert.equal(saved.contentIntelligence.hookLanguageGate,'XEEPRO_V1');cases++;
  const envKeys=['EDIT_MODE_CHAT_AI_MODE','EDIT_MODE_CHAT_LLM_ENABLED','OPENAI_API_KEY','OPENAI_MODEL',
    'OPENAI_ENABLED','XEEPRO_HOOK_REVIEW_MODEL','XEEPRO_HOOK_REVIEW_TIMEOUT_MS'];
  const prior=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
  try {
    process.env.EDIT_MODE_CHAT_AI_MODE='ONLINE';process.env.EDIT_MODE_CHAT_LLM_ENABLED='true';
    const context={project:{revision:0},transcript:{available:true,opening:evidence.transcript},
      runtime:{thread:{hook:{elementId:null,tried:[]}},groundingText:evidence.transcript,creativeEvidence:evidence}};
    const chat=Object.create(EditChatService.prototype);chat.logger={};let installed;
    chat.editMode={saveCreativeSuggestions:async(_id,_revision,p)=>{installed=p;}};
    chat.llm={async generate(i){return{data:i.role==='critic'?require('./fixtures/hook-review.cjs')(i):
      i.role==='clipUnderstanding'?{}:{hooks:[hook(corrected)]}};}};
    const better=await chat.writeHook('NEW',null,context,'test');
    assert.equal(better.suggestion.text,corrected);assert(xeeProHookApproved(installed.hooks[0]));cases++;
    chat.llm={async generate(){throw Error('unavailable');}};installed=undefined;
    const failed=await chat.writeHook('NEW',null,context,'test');
    assert.equal(failed.code,'CREATIVE_UNAVAILABLE');assert.equal(installed,undefined);cases++;
    const quick=Object.create(QuickReframeService.prototype);
    quick.load=async()=>({externalAiAuthorized:true,editProject:{revision:0}});
    quick.assertEditable=()=>{};quick.view=()=>({hooks:[approved],hasTranscript:true});
    quick.externalFor=async()=>true; // This fixture isolates the Pro grammar gate; mode routing has its own suite.
    await assert.rejects(quick.applyStyleOne('test',{revision:0,hookText:bad},true),/grammar and clarity review/);cases++;
    // The stronger reviewer and its budget apply only to hook-review schemas, without network calls.
    process.env.OPENAI_API_KEY='synthetic-test-key';process.env.OPENAI_MODEL='configured-base-model';process.env.OPENAI_ENABLED='true';
    process.env.XEEPRO_HOOK_REVIEW_MODEL='configured-review-model';process.env.XEEPRO_HOOK_REVIEW_TIMEOUT_MS='40000';
    const routed=[];const scoped=new LlmRouterService({isConfigured:()=>true,
      async generateStructuredWithConfig(config){routed.push(config);return{};}});
    const request=schemaName=>({schemaName,schema:{type:'object'},systemPrompt:'test',userPrompt:'{}'});
    await performanceContext.run(createPerformanceTelemetry('ONLINE'),()=>scoped.generate({role:'critic',request:request('shared_hook_review_v2')}));
    await performanceContext.run(createPerformanceTelemetry('ONLINE'),()=>scoped.generate({role:'critic',request:request('other_critic_schema')}));
    assert.equal(routed[0].model,'configured-review-model');assert.equal(routed[0].timeoutMs,40000);
    assert.equal(routed[1].model,'configured-base-model');assert.equal(routed[1].timeoutMs,AI_MODE_ROLE_TIMEOUTS.ONLINE.critic);
    await performanceContext.run(createPerformanceTelemetry('ONLINE'),()=>scoped.generate({role:'clipUnderstanding',request:request('shared_content_understanding_v1')}));
    await performanceContext.run(createPerformanceTelemetry('ONLINE'),()=>scoped.generate({role:'clipUnderstanding',request:request('other_understanding_schema')}));
    assert.equal(routed[2].model,'configured-review-model');assert.equal(routed[3].model,'configured-base-model');
    await assert.rejects(performanceContext.run(createPerformanceTelemetry('FALLBACK_ONLY'),()=>scoped.generate({role:'critic',request:request('shared_hook_review_v2')})),e=>e.kind==='AI_MODE_FALLBACK_ONLY');
    assert.equal(routed.length,4);cases++;
  } finally {for(const k of envKeys) prior[k]===undefined?delete process.env[k]:process.env[k]=prior[k];}
  console.log(JSON.stringify({cases,realFixtureCount:fixtures.length,grammarRewrite:'one pass with fresh review',brokenHooksNeverRender:true,xeeFreeUnchanged:true}));
})().catch(e=>{console.error(e);process.exitCode=1;});
