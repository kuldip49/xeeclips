const assert = require('node:assert/strict');
const { ClipBoundaryService, transcriptBoundaryWords } = require('../dist/modules/content-intelligence/clip-boundary.service');
const { localUnderstanding, sharedUnderstanding } = require('../dist/modules/content-intelligence/content-understanding.service');
const { CreativeQualityService, transcriptSimilarity } = require('../dist/modules/content-intelligence/creative-quality.service');
const { CreativePackageService, publicCreativePackage } = require('../dist/modules/content-intelligence/creative-package.service');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { createPerformanceTelemetry, performanceContext } = require('../dist/modules/processing/performance-telemetry');
const fixtures = require('./fixtures/content-intelligence.cjs');
const boundary = new ClipBoundaryService(), quality = new CreativeQualityService();
function timing(turns, step = .65) {
  let t = 0; return turns.flatMap(([speaker,text]) => text.split(/\s+/u).map(text => {
    const word = { start:t, end:t+step-.08, text, speaker }; t += step; return word;
  }));
}
const evidence = { transcript: fixtures[0].turns.map(t=>t[1]).join(' '), sourceId: 'disposable-advice',
  speakerTurns: fixtures[0].turns.map(([speaker,text])=>({speaker,text})) };
const good = { hooks: [
  {text:'Where approval ends, boundaries begin', category:'BOLD'},
  {text:'The boundary problem behind people-pleasing',category:'AUTHORITY'},
  {text:'Whose approval gets to decide your boundaries?',category:'QUESTION'},
  {text:'Saying yes has a boundary cost',category:'WARNING'} ],
  synopsis:'Chasing approval makes decisions depend on others. Accepting disagreement gives boundaries room to work.',
  captions:[{style:'Concise',text:'Approval should leave room for your boundaries.'},
    {style:'Engaging',text:'Every yes asks something of your boundaries. How do you decide which requests deserve it?'},
    {style:'Professional',text:'Decisions based on approval leave little room for sustainable boundaries.'}],
  hashtagSets:[{label:'Focused',hashtags:['#Approval','#Boundaries']},{label:'Niche',hashtags:['#SustainableBoundaries']},{label:'Broad',hashtags:['#Decisions']}],supportingLine:'' };
async function main() {
  const repaired = [];
  const localService=new CreativePackageService({generate(){throw Error('fixture analysis must remain local');}});
  for (const f of fixtures) {
    const words = timing(f.turns), text = f.turns.map(t=>t[1]).join(' '), end = words.at(-1).end;
    const r = boundary.repair({startTime:1.3,endTime:end-1.5,transcriptText:text},words,{minDuration:5});
    assert.ok(r.valid, `${f.id}: ${JSON.stringify(r)}`);
    assert.ok(r.startTime <= words[0].start+.001, f.id+' recovers setup');
    assert.ok(r.endTime >= end-.001, f.id+' includes final sentence');
    assert.ok(Object.values(r.qa).every(Boolean));
    repaired.push({id:f.id,start:[1.3,r.startTime],end:[end-1.5,r.endTime]});
    const u = localUnderstanding({transcript:text,visibleText:f.visibleText,sceneType:f.sceneType,
      sourceCaption:f.sourceCaption,tone:f.tone,speakerTurns:f.turns.map(([speaker,text])=>({speaker,text}))});
    assert.ok(u.centralClaim && u.payoff && u.supportedClaims.length);
    assert.ok(u.participants.every(p=>['SPEAKER','INTERVIEWER','INTERVIEWEE'].includes(p.role) && /^person \d+$/u.test(p.name)), 'unknown people are not identified from order or appearance');
    if(f.id.startsWith('E')) assert.equal(u.humorSupported,false);
    const ep={transcript:text,visibleText:f.visibleText,sourceCaption:f.sourceCaption,tone:f.tone};
    const creative=await localService.create({evidence:ep,external:false});
    assert.ok(creative.hooks.length && creative.hooks.every(h=>!transcriptSimilarity(h.text,text).copied && h.text.length<=64),f.id+' novel bounded hooks');
    assert.ok(creative.synopsis.length>20 && creative.captions.length>0,f.id+' specific synopsis and captions');
    assert.ok(creative.captions.every(c=>require('../dist/modules/content-intelligence/creative-quality.service').grounded(c.text,ep)),f.id+' captions grounded in video');
    assert.ok(creative.hashtagSets.length===3 && creative.hashtagSets.every(s=>s.hashtags.length && s.hashtags.every(t=>!/^#(?:viral|fyp|trending)$/iu.test(t))),f.id+' focused relevant tags');
    assert.ok(creative.hooks.every(h=>!creative.captions.some(c=>c.text===h.text)));
  }
  const exact = timing([['a','A complete sentence has its natural ending.'],['b','The next thought begins here.']]);
  const firstSentenceLast = exact.findIndex(w=>w.text.endsWith('.'));
  const boundaryEnd = exact[firstSentenceLast].end;
  assert.ok(boundary.repair({startTime:0,endTime:boundaryEnd,transcriptText:''},exact,{minDuration:1}).endTime <= exact[firstSentenceLast+1].start);
  assert.ok(boundary.validate({startTime:0,endTime:exact[4].end,transcriptText:''},exact,{minDuration:1}).valid === false,'renderer rejects cutoff');
  const pauseWords = [{start:0,end:1,text:'Focus',speaker:'a'},{start:1.2,end:2,text:'matters',speaker:'a'},
    {start:4,end:5,text:'Rest',speaker:'b'},{start:5.2,end:6,text:'helps.',speaker:'b'}];
  const pause=boundary.repair({startTime:0,endTime:1.5,transcriptText:''},pauseWords,{minDuration:1});
  assert.ok(pause.valid && pause.endTime < 4,'pause and speaker turn close sentence');
  const qaWords=timing(fixtures[0].turns);
  const questionEnd=qaWords.find(w=>w.text.endsWith('?')).end;
  const qa=boundary.repair({startTime:0,endTime:questionEnd,transcriptText:''},qaWords,{minDuration:1,extension:40});
  assert.ok(qa.valid && qa.endTime >= qaWords.at(-1).end,'question includes the complete answer, not its first sentence');
  const tooLong=boundary.repair({startTime:0,endTime:questionEnd,transcriptText:''},qaWords,{minDuration:1,maxDuration:questionEnd+1,extension:40});
  assert.equal(tooLong.valid,false,'no arbitrary cut to satisfy duration');
  const unrepairable=timing([['a','Because this'],['a','and that is why we must']],1);
  assert.equal(boundary.repair({startTime:0,endTime:3,transcriptText:''},unrepairable,{minDuration:1}).valid,false);
  assert.equal(boundary.repair({startTime:0,endTime:20,transcriptText:'Unknown'},[]).evidenceAvailable,false);
  const segment=transcriptBoundaryWords([{start:0,end:2,text:'A complete sentence.',speaker:'guest',words:[{start:0,end:1,text:'A complete'},{start:1,end:2,text:'sentence'}]}]);
  assert.ok(segment.at(-1).text.endsWith('.')); assert.equal(segment[0].speaker,'guest');
  assert.ok(transcriptSimilarity('Chasing approval makes every decision depend on someone else',evidence.transcript).copied);
  assert.ok(!transcriptSimilarity(good.hooks[0].text,evidence.transcript).copied);
  const u=localUnderstanding(evidence), hooks=quality.rank(good.hooks,evidence,u);
  assert.ok(hooks.length>=3 && hooks[0].recommended);
  assert.ok(hooks.every(h=>h.text.length<=64));
  assert.ok(quality.evaluate(good,hooks,evidence).passed);
  assert.equal(quality.rank([{text:'Advice from Jane Doe about boundaries',category:'BOLD'}],evidence,u).length,0);
  assert.equal(quality.rank([{text:'Boundaries guarantee 999 dollars',category:'BOLD'}],evidence,u).length,0);
  assert.equal(quality.rank([{text:'Approval is hilarious, what a joke',category:'SARCASTIC'}],evidence,u).length,0);
  const bad={...good,synopsis:'This video discusses mindset and success.',hashtagSets:[{label:'Focused',hashtags:['#Viral']}]};
  assert.equal(quality.evaluate(bad,hooks,evidence).passed,false);
  let analysisCalls=0,creativeCalls=0,reviewCalls=0;const tiers=[];
  const fake={async generate(input){
    if(input.role==='clipUnderstanding'){analysisCalls++; return {data:{},metadata:{role:input.role,provider:'test',model:'analysis',attempts:[]}};}
    if(input.role==='critic'){reviewCalls++;return {data:{supported:true,failures:[]},metadata:{role:input.role,provider:'test',model:'review',attempts:[]}};}
    creativeCalls++; tiers.push(input.creativeTier); return {data:creativeCalls===1?{...good,hooks:[{text:'Chasing approval makes every decision depend on someone else',category:'BOLD'}]}:good,
      metadata:{role:input.role,provider:'test',model:input.creativeTier,attempts:[]}};
  }};
  const service=new CreativePackageService(fake);
  const p=await service.create({evidence,external:true});
  assert.equal(p.status,'ACCEPTED'); assert.equal(p.internal.escalations,1);
  assert.equal(analysisCalls,1);assert.equal(creativeCalls,2);assert.equal(reviewCalls,1);
  assert.deepEqual(tiers,['PRIMARY','ESCALATION'],'only a quality-rejected draft escalates');
  await service.create({evidence,external:true}); assert.equal(creativeCalls,2,'identical package cached');
  const rewrite=await service.create({evidence,external:true,hooksOnly:true,direction:'More professional'});
  assert.equal(analysisCalls,1,'hook rewrite reuses understanding'); assert.equal(rewrite.status,'ACCEPTED');
  assert.ok(!JSON.stringify(publicCreativePackage(p)).includes('"model"'));
  let calls=0;
  const alwaysBad=new CreativePackageService({async generate(i){calls++;return{data:i.role==='clipUnderstanding'?{}:bad,metadata:{role:i.role,provider:'test',model:'bad',attempts:[]}};}});
  const failed=await alwaysBad.create({evidence:{...evidence,sourceId:'bad-source'},external:true});
  assert.equal(failed.status,'NEEDS_REVIEW');assert.ok(calls<=3,'one escalation maximum');
  // A provider failure is not a quality verdict: it retries the primary tier and never escalates.
  const failTiers=[];let failedOnce=false;
  const flaky=await new CreativePackageService({async generate(i){
    if(i.role==='clipUnderstanding')return{data:{},metadata:{role:i.role,provider:'test',model:'analysis',attempts:[]}};
    if(i.role==='critic')return{data:{supported:true,failures:[]},metadata:{role:i.role,provider:'test',model:'review',attempts:[]}};
    failTiers.push(i.creativeTier);if(!failedOnce){failedOnce=true;throw Error('TIMEOUT_FAILURE');}
    return{data:good,metadata:{role:i.role,provider:'test',model:i.creativeTier,attempts:[]}};}})
    .create({evidence:{...evidence,sourceId:'flaky-provider'},external:true});
  assert.deepEqual(failTiers,['PRIMARY','PRIMARY']);assert.equal(flaky.internal.escalations,0);assert.equal(flaky.status,'ACCEPTED');
  const offline = await new CreativePackageService({generate(){throw Error('must not call a provider');}}).create({evidence,external:false});
  assert.equal(offline.internal.routes.length,0);
  let noEvidenceCalls=0;
  const empty = await new CreativePackageService({generate(){noEvidenceCalls++;throw Error('no evidence');}})
    .create({external:true,evidence:{transcript:'',sourceCaption:'This famous chef made 500 cakes and won a prize.'}});
  assert.equal(noEvidenceCalls,0);assert.equal(empty.hooks.length,0);assert.equal(empty.captions.length,0);
  const listWords=timing([['a','There are three steps. First prepare the soil. Second water the roots. Third add the compost.']],.4);
  const list=boundary.repair({startTime:0,endTime:4,transcriptText:''},listWords,{minDuration:1,extension:20});
  assert.ok(list.valid && list.endTime>=listWords.at(-1).end,'announced list includes every item');
  const unsupportedService=new CreativePackageService({async generate(i){return {data:i.role==='clipUnderstanding'?{}:i.role==='critic'?{supported:false,failures:['Invented outcome']}:{...good,synopsis:'Approval causes boundaries to collapse overnight.'},metadata:{role:i.role,model:'test',provider:'test',attempts:[]}};}});
  const unsupported=await unsupportedService.create({external:true,evidence:{...evidence,sourceId:'rejected-semantic'}});
  assert.equal(unsupported.status,'NEEDS_REVIEW');assert.ok(!unsupported.synopsis.includes('overnight'),'semantically rejected copy never surfaces');
  // Paraphrase-only copy (low word overlap) is judged by meaning; hard factual failures never reach review.
  const { SEMANTIC_REVIEWABLE_FAILURES } = require('../dist/modules/content-intelligence/creative-quality.service');
  const paraphrased={...good,captions:[...good.captions,{style:'Bold',text:'Think about the commitment you accepted despite knowing you could not keep up.'}],
    hashtagSets:[{label:'Focused',hashtags:['#Boundaries','#PeoplePleasing']},{label:'Niche',hashtags:['#Overcommitment']},{label:'Broad',hashtags:['#PersonalGrowth']}]};
  const softHooks=quality.rank(paraphrased.hooks,evidence,u);
  const soft=quality.evaluate(paraphrased,softHooks,evidence);
  assert.equal(soft.passed,false);assert.ok(soft.failures.length&&soft.failures.every(f=>SEMANTIC_REVIEWABLE_FAILURES.has(f)),'paraphrase-only failures are soft: '+soft.failures);
  assert.ok(quality.afterSemanticReview(soft,softHooks).passed);
  const invented={...paraphrased,captions:[{style:'Concise',text:'Boundaries saved 300 hours of focused work.'}]};
  const hard=quality.evaluate(invented,softHooks,evidence);
  assert.ok(hard.failures.includes('CAPTION_UNGROUNDED_OR_REPEATED'));assert.equal(quality.afterSemanticReview(hard,softHooks).passed,false,'review cannot clear hard failures');
  let softReviews=0;
  const reviewedSoft=await new CreativePackageService({async generate(i){if(i.role==='critic')softReviews++;
    return{data:i.role==='clipUnderstanding'?{}:i.role==='critic'?{supported:true,failures:[]}:paraphrased,metadata:{role:i.role,provider:'test',model:'test',attempts:[]}};}})
    .create({external:true,evidence:{...evidence,sourceId:'paraphrased-soft'}});
  assert.equal(reviewedSoft.status,'ACCEPTED');assert.equal(reviewedSoft.internal.escalations,0);assert.equal(softReviews,1);
  assert.ok(reviewedSoft.captions.some(c=>c.text.startsWith('Think about the commitment')),'reviewed paraphrase is kept');
  assert.ok(reviewedSoft.hashtagSets.flatMap(x=>x.hashtags).includes('#Overcommitment'));
  let hardReviews=0;
  const hardPkg=await new CreativePackageService({async generate(i){if(i.role==='critic')hardReviews++;
    return{data:i.role==='clipUnderstanding'?{}:i.role==='critic'?{supported:true,failures:[]}:invented,metadata:{role:i.role,provider:'test',model:'test',attempts:[]}};}})
    .create({external:true,evidence:{...evidence,sourceId:'invented-hard'}});
  assert.equal(hardPkg.status,'NEEDS_REVIEW');assert.equal(hardReviews,0,'hard failures skip review');
  assert.ok(!JSON.stringify(hardPkg.captions).includes('300 hours'));
  const {editProjectEvidence}=require('../dist/modules/content-intelligence/edit-project-evidence');
  const retained=editProjectEvidence({id:'manual',assets:[{id:'source',role:'SOURCE',transcript:{segments:[{start:0,end:4,text:'Removed topic.',words:[{start:0,end:1,text:'Removed'}]},{start:5,end:10,text:'Retained boundaries.',words:[{start:5,end:6,text:'Retained'},{start:6,end:7,text:'boundaries.'}]}]}}],elements:[{type:'VIDEO',assetId:'source',trimStart:5,trimEnd:10,duration:5,properties:{}},{type:'TEXT',properties:{presetRole:'HOOK',content:'Excluded generated claims'}}]});
  assert.ok(!retained.transcript.includes('Removed'));assert.equal(retained.visibleText,'');
  // Actual router routes both tiers through the configured provider, with separate caches.
  const original={primary:process.env.CREATIVE_PRIMARY_MODEL, escalation:process.env.CREATIVE_ESCALATION_MODEL};
  process.env.CREATIVE_PRIMARY_MODEL='qa-primary';process.env.CREATIVE_ESCALATION_MODEL='qa-stronger';
  const models=[];
  let routeProvider='openai';
  const registry={chain(){return[{routeFor(){return{provider:routeProvider,model:'configured',timeoutMs:20000,maxRetries:0};}}];},get(){return undefined;}};
  const provider={isConfigured(){return true;},async generateStructuredWithConfig(route){models.push(route.model);return{ok:true};}};
  const router=new LlmRouterService(provider,registry);
  const request={schemaName:'routing-test',schema:{type:'object'},systemPrompt:'test',userPrompt:'test'};
  await performanceContext.run(createPerformanceTelemetry('ONLINE'),async()=>{
    await router.generate({role:'creativeGeneration',creativeTier:'PRIMARY',request});
    await router.generate({role:'creativeGeneration',creativeTier:'ESCALATION',request});
    await router.generate({role:'clipUnderstanding',creativeTier:'ESCALATION',request});
    routeProvider='google';
    await router.generate({role:'creativeGeneration',creativeTier:'ESCALATION',request:{...request,userPrompt:'other provider'}});
  });
  assert.deepEqual(models,['qa-primary','qa-stronger','configured','configured'],'creative override only reaches the OpenAI route');
  for(const [k,v] of [['CREATIVE_PRIMARY_MODEL',original.primary],['CREATIVE_ESCALATION_MODEL',original.escalation]])v===undefined?delete process.env[k]:process.env[k]=v;
  console.log(JSON.stringify({fixtures:fixtures.length,repaired,similarityProtection:true,boundedEscalation:true,cache:true,routerIsolation:true}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
