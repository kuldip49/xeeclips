// Only the isolated Clipper V1 QA image preloads this. No production entry point imports it.
if(process.env.CLIPPER_QA!=='1')throw Error('Isolated Clipper QA mode is required');
require('./quick-reframe-qa-provider.cjs');
const fs=require('node:fs'),{LlmRouterService}=require('../dist/modules/processing/llm-router.service'),{LlmProviderError}=require('../dist/modules/processing/llm-provider.service'),{currentExecutionPolicy,performanceContext}=require('../dist/modules/processing/performance-telemetry'),{markProviderBusy}=require('../dist/modules/processing/generation-availability');
const base=LlmRouterService.prototype.generate,file=process.env.QUICK_REFRAME_QA_STATE;
LlmRouterService.prototype.generate=async function(input){
 const schema=input.request.schemaName;
 if(!['campaign_understanding_v1','campaign_candidate_match_v1','shared_semantic_boundaries_v2','clip_edit_plan_v2'].includes(schema)){
  const result=await base.call(this,input);
  if(input.role==='creativeGeneration')result.data.hooks.push(...[
   ['A weak explanation cannot hide behind credentials','CONTRARIAN'],
   ['Why confidence needs evidence to back it','QUESTION'],
   ['Respectful disagreement begins with better reasons','BOLD'],
   ['A polished introduction can hide weak reasoning','TENSION'],
   ['The speaker deserves respect and careful scrutiny','HIDDEN_TRUTH'],
   ['Why titles cannot replace a clear explanation','CURIOSITY']
  ].map(([text,category])=>({text,category,support:'Arguments stand on their merits'})));
  return result;
 }
 const state=JSON.parse(fs.readFileSync(file));if(currentExecutionPolicy().mode==='XEEFREE'){state.freeAttempts++;fs.writeFileSync(file,JSON.stringify(state));throw Error('QA_FREE_CLOUD_ATTEMPT');}
 state.proCalls++;state.schemas=[...(state.schemas||[]),schema];fs.writeFileSync(file,JSON.stringify(state));
 if(state.busy){markProviderBusy('PROVIDER_QUOTA_UNAVAILABLE');throw new LlmProviderError('QUOTA_FAILURE','QA_BUSY',429);}
 const telemetry=performanceContext.getStore();if(telemetry){telemetry.openAiCalls++;telemetry.cloudLlmCalls++;}
 const body=JSON.parse(input.request.userPrompt);
 let data;
 if(schema==='campaign_understanding_v1')data={rules:[...(/\bstudents\b/i.test(body.sourceText)?[{field:'audience',text:'students',evidence:'students'}]:[]),...(/\bprofessional\b/i.test(body.sourceText)?[{field:'tone',text:'professional',evidence:'professional'}]:[])],warnings:[]};
 else if(schema==='campaign_candidate_match_v1')data={scores:body.candidates.map(c=>({id:c.id,score:85}))};
 else if(schema==='shared_semantic_boundaries_v2'){
  // The application supplies only locally valid ranges; exercise its online selection contract.
  data={selectedIndex:body.ranges.length?0:-1,reason:'The complete synthetic fixture thought is supported by the supplied range.',rejectionKind:body.ranges.length?'NONE':'OTHER'};
 }else{
  const {fallbackEditPlan}=require('../dist/modules/editing/edit-plan');
  data=fallbackEditPlan(body.finalClip.startSec,body.finalClip.endSec,body.requestedAspectRatio);
  data.endingStrategy.endingComplete=true;
 }
 return{data,metadata:{role:input.role,provider:schema==='clip_edit_plan_v2'?'openai':'QA',model:schema==='clip_edit_plan_v2'?'gpt-5.6-luna':'QA',cacheHit:false}};
};
