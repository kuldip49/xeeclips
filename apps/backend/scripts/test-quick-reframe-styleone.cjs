/** Crop-first Quick Reframe: the actual StyleOne compiler/editor/renderer and the Manual path, locally, without providers. */
const assert=require('node:assert/strict');
const {createHarness,seedAnalyzedProject}=require('./test-edit-mode-isolation.cjs');
const {preparationOf,isIdentityPreparation}=require('../dist/modules/quick-reframe/quick-reframe-plan');
const {quickStyleOneCommands,quickComposeRender,quickOutputCanvas,preparationFingerprint}=require('../dist/modules/quick-reframe/quick-reframe-render');
const {rankHooks,HOOK_CATEGORIES}=require('../dist/modules/quick-reframe/quick-reframe-hooks');
const {AUTOMATIC_2_STREET3_LAYOUT:S}=require('../dist/modules/edit-mode/styles/automatic-2-street3-layout');
const media={overlayPaths:{},audioPaths:{}};
async function main(){
  const h=createHarness(),seed=await seedAnalyzedProject(h),id=seed.project.id;
  let project=await h.service.get(id);
  const source=project.assets.find(a=>a.role==='SOURCE'),duration=source.duration;
  // Baked-source identity: key order independent, pixel changes only.
  const prep={aspect:'CUSTOM',crop:{x:0,y:.1,w:1,h:.8},framing:'CROP',cleanup:[],denoise:false};
  const key=preparationFingerprint(prep);
  assert.equal(preparationFingerprint({...prep,crop:{h:.8,w:1,y:.1,x:0}}),key);
  assert.notEqual(preparationFingerprint({...prep,crop:{x:0,y:.2,w:1,h:.7}}),key);
  assert.notEqual(preparationFingerprint({...prep,denoise:true}),key);
  assert.equal(isIdentityPreparation({...prep,crop:{x:0,y:0,w:1,h:1}}),true);
  assert.equal(isIdentityPreparation(prep),false);
  assert.equal(preparationOf({aspect:'SOURCE',crop:prep.crop,framing:'CROP',cleanup:[],color:{denoise:true}}).denoise,true);

  // Manual path: the canonical project untouched by StyleOne renders at the confirmed source shape.
  project=await h.service.phase3Command(id,'ADD_TEXT',{revision:project.revision,content:'My own hook',presetRole:'HOOK',origin:'USER'});
  const manualCanvas=quickOutputCanvas(project.settings,source.width,source.height,1080);
  assert.deepEqual(manualCanvas,{width:1920,height:1080});
  assert.deepEqual(quickOutputCanvas(project.settings,source.width,source.height,720),{width:1280,height:720});
  const manual=quickComposeRender({project,assets:project.assets,elements:project.elements,hasSourceAudio:true,canvasOverride:manualCanvas},'source.mp4','manual.mp4',media,false);
  assert.equal(manual.plan.canvas.visualLayout,null);assert.equal(manual.plan.durationSec,duration);
  assert.equal(manual.plan.textOverlays.length,1);assert.match(manual.ass,/My own hook/);
  assert.throws(()=>quickComposeRender({project,assets:project.assets,elements:project.elements,canvasOverride:manualCanvas},'s.mp4','o.mp4',media,true),/StyleOne layout/);
  const userText=project.elements.find(e=>e.type==='TEXT');

  // StyleOne: the actual AUTOMATIC_2 compiler as ONE canonical revision, whole confirmed frame in its window.
  let input={project,assets:project.assets,elements:project.elements};
  const compiled=quickStyleOneCommands(input,{hookText:'Keep the original speaker visible',captions:false});
  assert.ok(compiled.commands.some(c=>c.action==='SET_VIDEO_FRAMING'&&c.payload.mode==='FIT'));
  const before=project.revision;
  const applied=await h.service.applyAssistantBundle(id,project.revision,{proposalId:'quick-styleone-test',summary:'StyleOne',userMessage:'StyleOne',actor:'TEMPLATE_ACTION',commands:compiled.commands});
  project=applied.project;assert.equal(project.revision,before+1);
  assert.deepEqual(project.settings.resolvedVisualLayout.videoFrame,{...project.settings.resolvedVisualLayout.videoFrame,...S.mediaBox});
  assert.equal(project.settings.resolvedVisualLayout.editingProfile,'AUTOMATIC_2');assert.equal(project.settings.quickReframeStyleOne,true);
  assert.equal(project.settings.reframePolicy,'SOURCE');assert.equal(project.settings.zoomPolicy,'OFF');
  assert.ok(project.elements.filter(e=>e.type==='VIDEO').every(e=>e.properties.frameLayout==='FIT'));
  const hook=project.elements.find(e=>e.type==='TEXT'&&e.properties.fontFamily===S.typography.fontFamily);
  assert.ok(hook,'StyleOne serif hook');assert.equal(hook.duration,duration);assert.equal(hook.properties.y,S.hookBox.y);
  assert.ok(hook.properties.textRuns.some(r=>r.color.toLowerCase()===S.colors.hookHighlight.toLowerCase()));
  const canvas=quickOutputCanvas(project.settings,source.width,source.height,1080);
  assert.deepEqual(canvas,{width:1080,height:1920});
  assert.deepEqual(quickOutputCanvas(project.settings,source.width,source.height,720),{width:720,height:1280});
  input={project,assets:project.assets,elements:project.elements,hasSourceAudio:true};
  const styled=quickComposeRender({...input,canvasOverride:canvas},'source.mp4','styled.mp4',media,true);
  const preview=quickComposeRender({...input,canvasOverride:quickOutputCanvas(project.settings,source.width,source.height,540)},'source.mp4','preview.mp4',media,true);
  assert.deepEqual([preview.plan.canvas.width,preview.plan.canvas.height],[540,960]);
  assert.equal(styled.plan.durationSec,duration);assert.equal(styled.plan.zoomEvents.length,0);
  assert.deepEqual(styled.plan.canvas.visualLayout.videoFrame,preview.plan.canvas.visualLayout.videoFrame);
  const graph=styled.args[styled.args.indexOf('-filter_complex')+1];
  assert.match(graph,/color=c=#000000:s=1080x1920/);assert.match(graph,/overlay=0:610/);
  // Whole-frame FIT inside the fixed window: the confirmed crop is never cropped a second time.
  assert.equal(styled.evidence.fitExpression.length>0,true);assert.match(graph,/scale=1080:700:force_original_aspect_ratio=decrease/);
  assert.match(styled.ass,/EB Garamond/);
  // Undo restores the pre-StyleOne composition, including the user's own text.
  const undone=await h.service.undo(id,project.revision);
  assert.equal(undone.settings.resolvedVisualLayout?.editingProfile,undefined);
  assert.ok(undone.elements.some(e=>e.id===userText.id&&e.properties.content==='My own hook'));
  project=await h.service.redo(id,undone.revision);assert.equal(project.settings.resolvedVisualLayout.editingProfile,'AUTOMATIC_2');

  // Existing captions receive StyleOne's own caption preset and active-word style.
  h.rows.editElements.set('caption',{...project.elements[0],id:'caption',assetId:null,type:'SUBTITLE',track:2,position:0,startTime:0,duration:2,trimStart:0,trimEnd:null,properties:{content:'Original words'}});project=await h.service.get(id);
  const captionBundle=quickStyleOneCommands({project,assets:project.assets,elements:project.elements},{hookText:'Keep the original speaker visible',captions:true});
  const captionResult=await h.service.applyAssistantBundle(id,project.revision,{proposalId:'quick-captions-test',summary:'StyleOne captions',userMessage:'captions',actor:'TEMPLATE_ACTION',commands:captionBundle.commands});
  const caption=captionResult.project.elements.find(e=>e.type==='SUBTITLE');
  assert.equal(caption.properties.captionStyleId,'BOLD_HIGHLIGHT');assert.equal(caption.properties.y,S.captionSafeBox.y);
  assert.equal(caption.properties.activeWord.enabled,true);assert.equal(caption.properties.activeWord.color.toLowerCase(),S.colors.captionActive.toLowerCase());
  const crowded=captionResult.project.elements.map(e=>e.type==='SUBTITLE'?{...e,properties:{...e.properties,content:'Preserve the complete original sequence and all the original spoken words '.repeat(5)}}:e);
  assert.throws(()=>quickComposeRender({project:captionResult.project,assets:project.assets,elements:crowded,canvasOverride:canvas},'s.mp4','o.mp4',media,true),/two-line/);
  const shortBundle=quickStyleOneCommands({project,assets:project.assets.map(a=>({...a,duration:.5})),elements:project.elements.filter(e=>e.type!=='SUBTITLE').map(e=>({...e,startTime:0,duration:.5,trimEnd:e.type==='VIDEO'?.5:null}))},{hookText:'Short source hook stays inside',captions:false});
  assert.ok(shortBundle.commands.filter(c=>c.action==='SET_ELEMENT_TIMING').every(c=>c.payload.duration<=.5));

  // Hook ranking: six categories, grounded only, one Recommended.
  const transcript='Most people think saving money means cutting coffee. But the real leak is subscriptions you forgot. I cancelled four of them and saved two hundred dollars a month. It felt amazing to finally take control of my budget.';
  const ranked=rankHooks([
    {text:'You Won\'t Believe This Money Trick',category:'BOLD',source:'OPENAI'},
    {text:'Forgotten Subscriptions Are Your Real Money Leak',category:'BOLD',source:'OPENAI'},
    {text:'Why Are Forgotten Subscriptions Draining Your Budget?',category:'QUESTION',source:'OPENAI'},
    {text:'Cutting Coffee Will Not Fix Your Budget',category:'CONTRARIAN',source:'OPENAI'},
    {text:'The Subscriptions I Cancelled Saved Two Hundred Dollars',category:'CURIOSITY',source:'OPENAI'},
    {text:'Taking Control Of My Budget Felt Amazing',category:'EMOTIONAL',source:'OPENAI'},
    {text:'Audit Subscriptions To Save Money Every Month',category:'PROFESSIONAL',source:'OPENAI'},
    {text:'Quantum Rockets Will Replace Every Bank',category:'BOLD',source:'OPENAI'}],transcript);
  assert.ok(ranked.length>=3);assert.equal(ranked.filter(h=>h.recommended).length,1);assert.equal(ranked[0].recommended,true);
  assert.ok(ranked.every(h=>HOOK_CATEGORIES.includes(h.category)));
  assert.ok(!ranked.some(h=>/believe|Quantum/u.test(h.text)),'clickbait and ungrounded hooks are rejected');
  assert.ok(ranked.some(h=>h.category==='QUESTION'&&h.text.endsWith('?')));
  assert.ok(ranked.every((h,i)=>i===0||ranked[i-1].score>=h.score));

  // A failed crop bake never reaches composition.
  const {QuickReframeService}=require('../dist/modules/quick-reframe/quick-reframe.service');
  const service=Object.create(QuickReframeService.prototype),stages=[];let failed=false;
  const plan={version:1,aspect:'CUSTOM',crop:prep.crop,framing:'CROP',cleanup:[],hook:{enabled:false,text:'',y:.25},captions:{enabled:false,replaceExisting:false,font:'Inter, sans-serif',size:36,y:.57,color:'#FFFFFF',cues:[]},color:{exposure:0,contrast:1,saturation:1,temperature:0,sharpness:0,denoise:false},audio:{muted:false,volume:1},resolution:1080,reasons:[]};
  const analysis={regions:[],frames:[],boundaries:[],subtitleState:'MISSING',warnings:[],bars:{top:0,bottom:0,left:0,right:0}};
  Object.assign(service,{aborts:new Map(),logger:{warn:()=>{}},load:async()=>({id:'failed-crop',operationId:'op',plan,analysis,confirmed:null,editPath:null,editProject:{...project,assets:project.assets.filter(a=>a.role==='SOURCE')}}),
    stage:async(_task,message)=>stages.push(message),storage:{downloadToFile:async()=>{throw new Error('Unreadable source');}},prisma:{quickReframe:{updateMany:async({data})=>{failed=data.status==='FAILED';return {count:1};}}}});
  await service.run({id:'failed-crop',operationId:'op',kind:'PREPARE'});
  assert.equal(failed,true);assert.ok(stages.every(s=>!/Rendering|Exporting/u.test(s)));
  const {Prisma}=require('@prisma/client');let attempts=0;
  assert.equal(await service.retryWriteConflict(async()=>{if(++attempts<3)throw new Prisma.PrismaClientKnownRequestError('Conflict',{code:'P2034',clientVersion:'test'});return 'ok';}),'ok');
  assert.equal(attempts,3);
  console.log('Crop-first: baked-source identity, Manual canonical composition, actual StyleOne as one undoable revision with whole-frame FIT in the fixed window, preview/export parity, caption styles, six-category hook ranking, and no composition after a failed crop: PASS');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
