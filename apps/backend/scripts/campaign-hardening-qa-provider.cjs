if(process.env.CLIPPER_QA!=='1')throw Error('Disposable QA is required');
require('./campaign-qa-provider.cjs');
const fs=require('node:fs'),{performanceContext}=require('../dist/modules/processing/performance-telemetry');
const file=process.env.QUICK_REFRAME_QA_STATE,contexts=new Set(),run=performanceContext.run;
const prior=JSON.parse(fs.readFileSync(file));
const {LlmRouterService}=require('../dist/modules/processing/llm-router.service');
const {XeeProBusyError}=require('../dist/modules/processing/generation-availability');
const {currentExecutionPolicy}=require('../dist/modules/processing/performance-telemetry');
const generate=LlmRouterService.prototype.generate;
LlmRouterService.prototype.generate=async function(input){const state=JSON.parse(fs.readFileSync(file));if(state.busyAfterAdmission&&input.request.schemaName==='campaign_candidate_match_v1'){if(currentExecutionPolicy().mode==='XEEFREE'){state.freeAttempts++;fs.writeFileSync(file,JSON.stringify(state));throw Error('QA_FREE_CLOUD_ATTEMPT');}state.proCalls++;fs.writeFileSync(file,JSON.stringify(state));throw new XeeProBusyError('PROVIDER_QUOTA_UNAVAILABLE');}return generate.call(this,input);};
function flush(){const state=JSON.parse(fs.readFileSync(file));state.freeTelemetry=Object.fromEntries(['openAiCalls','cloudLlmCalls','proEscalations','blockedProviderAttempts'].map(key=>[key,Number(prior.freeTelemetry?.[key])||0]));for(const c of contexts)for(const key of Object.keys(state.freeTelemetry))state.freeTelemetry[key]+=Number(c[key])||0;state.freeContexts=(Number(prior.freeContexts)||0)+contexts.size;fs.writeFileSync(file,JSON.stringify(state));}
performanceContext.run=function(store,callback,...args){if(store?.executionMode==='XEEFREE')contexts.add(store);const result=run.call(this,store,callback,...args);if(result&&typeof result.finally==='function')return result.finally(flush);flush();return result;};
const fetch=global.fetch;
global.fetch=async function(input,options){const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.protocol!=='http:'||!['localhost','127.0.0.1','ai-service','minio','backend'].includes(url.hostname)){const state=JSON.parse(fs.readFileSync(file));state.transportAttempts++;fs.writeFileSync(file,JSON.stringify(state));throw Error('QA_EXTERNAL_NETWORK_ATTEMPT');}return fetch(input,options);};
process.on('exit',flush);
