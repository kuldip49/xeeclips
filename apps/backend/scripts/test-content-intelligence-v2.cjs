require('reflect-metadata');
const assert = require('node:assert/strict');
const {ClipBoundaryService, BOUNDARY_POLICY} = require('../dist/modules/content-intelligence/clip-boundary.service');
const {CreativeQualityService, HOOK_POLICY} = require('../dist/modules/content-intelligence/creative-quality.service');
const {CreativePackageService} = require('../dist/modules/content-intelligence/creative-package.service');
const {localUnderstanding, spokenRegister} = require('../dist/modules/content-intelligence/content-understanding.service');
const {styleTwoText, STYLE_TWO:S} = require('@ai-content-platform/shared/style-two.cjs');
const {fitHookText} = require('../dist/modules/editing/text-layout');
const {resolveCreativeStyle} = require('../dist/modules/edit-mode/styles/creative-style-resolver');
const {resolveVisualLayout} = require('../dist/modules/edit-mode/styles/resolved-visual-layout');
const b = new ClipBoundaryService(), q = new CreativeQualityService();
function words(sentences) {
  let t = 0;
  return sentences.map(([text, duration, speaker='speaker']) => {
    const w = {start:t,end:t+duration,text,speaker}; t += duration + .2; return w;
  });
}
const cases = [
  ['podcast-answer', [['Why did the experiment fail?',5,'host'],['The equipment overheated.',6,'guest'],['That is why we changed the cooling system.',18,'guest']], 10, 29.4],
  ['cut-sentence', [['We started testing the product because we realized the numbers did not match customer experience.',44]], 28,44],
  ['story-payoff', [['We decided to test the delivery claim.',8],['We ordered lunch that day.',19],['The result revealed that the driver had used a borrowed account.',12]],18,39.4],
  ['joke', [['I wrote a joke about my clock.',7],['The setup promised a better morning.',9],['The punchline was that the clock overslept too.',14]],10,30.4],
  ['argument', [['Our claim is that better cooling protects the equipment.',8],['The measurements confirmed it.',12],['Therefore we changed the cooling system.',8]],14,28.4],
  ['list', [['There are three steps.',4],['First prepare the soil.',8],['Second water the roots.',8],['Third add compost.',10]],10,30.6],
  ['confession', [['I thought asking for help meant failure.',8],['I called my sister after losing my job.',9],['That conversation made asking for help possible.',12]],15,29.4],
  ['advice', [['Healthy boundaries require clarity.',8],['Protecting focused work means accepting some disagreement.',19]],15,27.2],
  ['debate', [['Remote work makes collaboration harder.',7,'a'],['I disagree because we document every decision.',20,'b']],14,27.2],
  ['tutorial', [['Open Settings and select Keyboard.',6],['Choose an unused shortcut and save it.',21]],12,27.2],
  ['hindi', [['यह परीक्षण हमने शुरू किया।',8],['नतीजा यह था कि मशीन बहुत गर्म हो रही थी।',23]],16,31.2],
  ['hinglish', [['Humne cooling ka test shuru kiya.',8],['Result mein pata chala ki machine bahut garam ho rahi hai.',23]],16,31.2],
  ['mixed', [['We started the experiment.',8],['नतीजा मिला और we changed the cooling system.',23]],16,31.2],
  ['long-answer', [['Why was the equipment failing?',5,'host'],['The equipment overheated during the test.',10,'guest'],['That is why we replaced the entire cooling system after checking every measurement.',26,'guest']],5,41.4],
  ['previous-context', [['The experiment compared two cooling systems.',9],['That is why we chose the second system.',22]],18,31.2]
];
async function main() {
  const reports=[];
  for(const [id, lines,target,expected] of cases){
    const w=words(lines), raw={startTime:id==='previous-context'?9.2:0,endTime:target,transcriptText:''};
    const r=b.repair(raw,w,{minDuration:1});
    assert(r.valid, id+': '+JSON.stringify(r)); assert(r.endTime>=expected-.001,id+' includes payoff');
    assert(Object.values(r.qa).every(Boolean),id); assert.equal(Object.keys(r.qa).length,14);
    assert(b.validate(r,w,{minDuration:1}).valid,id+' final validation');
    reports.push({id,target,raw:[raw.startTime,target],repaired:[r.startTime,r.endTime],duration:r.endTime-r.startTime,reasons:r.reasons});
  }
  const missingPayoff=words([['We decided to test the delivery claim.',8],['We ordered lunch that day.',19]]);
  assert(!b.repair({startTime:0,endTime:27.2,transcriptText:''},missingPayoff,{minDuration:1}).valid,'grammatical setup-only source must fail');
  const topic=words([['We decided to test the delivery claim.',8],['We ordered lunch that day.',12],['Moving on to gardening. The result was healthy soil.',8]]);
  assert(!b.repair({startTime:0,endTime:16,transcriptText:''},topic,{minDuration:1}).valid,'unrelated topic cannot supply payoff');
  assert(!b.repair({startTime:0,endTime:2,transcriptText:''},words([['The complete answer takes too long to deliver.',65]]),{minDuration:1}).valid,'safety cap rejects incomplete range');
  const bad=b.validate({startTime:0,endTime:10,transcriptText:''},words([['The equipment overheated during the experiment.',24]]),{minDuration:1});
  assert(!bad.qa.END_COMPLETE && !bad.qa.THOUGHT_COMPLETE && !bad.qa.VIEWER_SATISFIED_END,'QA reflects actual delivered cut');
  const answerStart=words([['Why did the test fail?',8,'host'],['The equipment overheated.',20,'guest']]);
  assert.equal(b.repair({startTime:8.2,endTime:28.2,transcriptText:''},answerStart,{minDuration:1}).startTime,0,'restore question before answer');
  const reject=await b.repairSemantic({startTime:0,endTime:20,transcriptText:''},words([['Our test showed the equipment overheated.',25]]),{async generate(){return {data:{selectedIndex:-1,reason:'Missing answer context'}};}},true,{minDuration:1});
  assert(!reject.valid && !reject.qa.VIEWER_SATISFIED_END,'semantic critic can veto grammatical range');
  const unavailable=await b.repairSemantic({startTime:0,endTime:20,transcriptText:''},words([['Our test showed the equipment overheated.',25]]),{async generate(){throw Error('Unavailable');}},true,{minDuration:1});
  assert(!unavailable.valid && unavailable.reasons.includes('SEMANTIC_REVIEW_UNAVAILABLE'),'automatic online clips fail closed when semantic review is unavailable');
  const conclusionWords=words([['Bananas and rice describe the cultural fusion.',10],['I eat them together.',10],["That's what being Somali and American means to me.",10]]);
  assert(b.repair({startTime:0,endTime:20.2,transcriptText:''},conclusionWords,{minDuration:1}).endTime>30,'include nearby explanatory conclusion after a short response');
  assert.equal(spokenRegister('Har kisi ko impress karna zaroori nahi hai. Apni boundaries ke liye time rakhna.'),'Hinglish');
  assert.equal(spokenRegister('हमने मशीन का परीक्षण किया। नतीजा देखकर हमने मशीन बदल दी।'),'Hindi');
  assert.equal(spokenRegister('We tested the machine and found that cooling matters.'),'English');
  const e={transcript:'The cooling experiment showed that equipment overheated because the original system could not handle the workload. After replacing the cooling system, the measurements stayed stable and the equipment stopped overheating.'};
  const u=localUnderstanding(e);
  const long='Why did the equipment keep overheating even after the first cooling experiment seemed to prove the system could handle the workload?';
  assert(long.split(' ').length>14 && long.split(' ').length<=26);
  const ranked=q.rank([{text:long,category:'QUESTION'},{text:'The cooling mistake behind the overheated equipment',category:'MISTAKE'},{text:'What did the cooling measurements reveal about the equipment?',category:'REVEAL'}],e,u);
  assert.equal(ranked.length,3);assert(ranked.some(h=>h.text===long),'long grounded hook retained verbatim');
  assert(ranked.every(h=>h.CLICKABILITY_SCORE>=70&&h.CONTEXT_SCORE>=65));
  assert.equal(q.rank([{text:'How delivery apps work',category:'PROFESSIONAL'}],e,u).length,0,'summary hook rejected');
  assert.equal(q.rank([{text:'The hidden celebrity scandal nobody wanted exposed',category:'CURIOSITY'}],e,u).length,0,'clickability cannot beat low context');
  const weak=q.rank([{text:'The equipment cooling system measurements',category:'PROFESSIONAL'}],e,u);
  assert(!q.evaluate({hooks:[],synopsis:'',captions:[],hashtagSets:[],supportingLine:''},weak,e,true).passed,'flat headline triggers regeneration');
  const tiers=[];
  const pkg=await new CreativePackageService({async generate(i){
    if(i.role==='critic')return{data:{supported:true,failures:[]}};
    tiers.push(i.creativeTier);
    assert.equal(i.request.schema.properties.hooks.minItems,8);assert.equal(i.request.schema.properties.hooks.maxItems,15);
    assert(!i.request.systemPrompt.includes('3-12 words'));
    return{data:{hooks:i.creativeTier==='PRIMARY'?[{text:'How cooling systems work',category:'PROFESSIONAL'}]:ranked}};
  }}).create({external:true,hooksOnly:true,evidence:{...e,analysis:{mainClaim:e.transcript}}});
  assert.deepEqual(tiers,['PRIMARY','ESCALATION']);assert.equal(pkg.internal.escalations,1);assert.equal(pkg.status,'ACCEPTED');assert.equal(pkg.version,2);
  for(const template of ['AUTOMATIC_1','AUTOMATIC_2','AUTOMATIC_3_STYLE_TWO']){
    const resolved=resolveCreativeStyle({templateId:template}), short=resolveVisualLayout(resolved,{hookText:'Why did the equipment overheat?'}), layout=resolveVisualLayout(resolved,{hookText:long});
    assert.deepEqual(layout.videoFrame,short.videoFrame);assert.deepEqual(layout.captions,short.captions);assert.deepEqual(layout.background,short.background);
    assert.equal(layout.hook.x,short.hook.x);assert.equal(layout.hook.y,short.hook.y);assert.equal(layout.hook.height,short.hook.height);
    assert(layout.hook.fontSize<=short.hook.fontSize);
  }
  for(const text of [long,'Why did the equipment keep overheating after every test when the cooling measurements appeared stable and the workload never exceeded the original design limits?','इस परीक्षण में मशीन के गर्म होने की असली वजह क्या थी और नया कूलिंग सिस्टम लगाने से नतीजा कैसे बदल गया?']){
    const fit=styleTwoText({...S.hook,content:text,fontFamily:S.hookFont,fontSize:S.hookSize*1.8,lineHeight:S.hookLineHeight,scale:1.8});
    assert(!fit.overflow && !fit.truncated,text);assert.equal(fit.lines.join(' '),text);assert(fit.lines.length<=4);assert(fit.plate.y+fit.plate.height<=S.media.y);
    if(/[\u0900-\u097f]/u.test(text))assert(fit.fallback.every(g=>g.text.split(/\s+/u).length>1 && g.anchor==='middle'),'Hindi fallback shapes complete lines');
    const zero=fitHookText(text,{x:0,y:0,width:930,height:345});assert(zero && zero.shortenLevel===0);assert.equal(zero.text,text);
  }
  console.log(JSON.stringify({cases:reports,policy:BOUNDARY_POLICY,hookPolicy:HOOK_POLICY,semanticVeto:true,qualityEscalation:true,templates:'unchanged media geometry, full wording'},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
