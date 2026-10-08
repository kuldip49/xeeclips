/**
 * Quick Reframe + StyleTwo. Regression for the source19 acceptance failure where applying StyleTwo to a saved
 * Quick Reframe crop returned HTTP 404. Root cause: Quick Reframe had no StyleTwo path at all - its chooser,
 * `/quick-reframe/:id/styleone` route, edit-path enum, compiler and composer were StyleOne-only - so the only
 * place a client could send AUTOMATIC_3_STYLE_TWO was the editor's EditTemplate library
 * (`POST /edit-mode/projects/:id/template/apply`), which resolves built-in/user EditTemplate ids and answers
 * "Template not found". StyleTwo is now a first-class server-side Quick Reframe path.
 * No providers, databases, servers or production writes.
 */
require('reflect-metadata');
const assert=require('node:assert/strict');
const {createHarness,seedAnalyzedProject}=require('./test-edit-mode-isolation.cjs');
const {STYLE_TWO_ID:ID,STYLE_TWO:S,normalized}=require('@ai-content-platform/shared/style-two.cjs');
const {quickStyleCommands,quickStyleOneCommands,quickComposeRender,quickOutputCanvas}=require('../dist/modules/quick-reframe/quick-reframe-render');
const {QuickReframeController}=require('../dist/modules/quick-reframe/quick-reframe.controller');
const {QuickReframeService}=require('../dist/modules/quick-reframe/quick-reframe.service');
const {fullTemplate,creativeCatalog}=require('../dist/modules/edit-mode/styles/creative-style-library');
const media={overlayPaths:{},audioPaths:{}};
const filterGraph=r=>r.args[r.args.indexOf('-filter_complex')+1];
async function main(){
  // ---- Registration: every server-side layer that gates StyleOne also knows StyleTwo.
  assert.ok(fullTemplate(ID),'template registry resolves AUTOMATIC_3_STYLE_TWO');
  assert.ok(creativeCatalog().templates.some(t=>t.id===ID),'creative catalog exposes StyleTwo');
  assert.equal(Reflect.getMetadata('path',QuickReframeController.prototype.styleTwo),':id/styletwo');
  assert.equal(Reflect.getMetadata('method',QuickReframeController.prototype.styleTwo),Reflect.getMetadata('method',QuickReframeController.prototype.styleOne),'same HTTP verb as StyleOne');
  for(const method of ['applyStyleOne','applyStyleTwo','applyStyle'])assert.equal(typeof QuickReframeService.prototype[method],'function',method);

  const h=createHarness(),seed=await seedAnalyzedProject(h),id=seed.project.id;
  let project=await h.service.get(id);
  const source=project.assets.find(a=>a.role==='SOURCE'),duration=source.duration;
  // The user's saved manual crop is baked into SOURCE (906x1152, the source19 crop). Compose from those pixels.
  const baked={...source,width:906,height:1152};
  const assets=project.assets.map(a=>a.id===source.id?baked:a);

  // ---- StyleTwo as ONE canonical revision over the confirmed crop.
  const input={project,assets,elements:project.elements};
  const hook='Why the crop stays exactly as you drew it';
  const compiled=quickStyleCommands(input,{hookText:hook,captions:false},'STYLETWO');
  assert.ok(compiled.commands.some(c=>c.action==='SET_VIDEO_FRAMING'&&c.payload.mode==='FIT'),'whole crop fitted, never re-cropped');
  assert.ok(!compiled.commands.some(c=>/CROP|ZOOM|REFRAME_POLICY|TRIM|SPLIT/u.test(c.action)&&c.action!=='REMOVE_ZOOM'),'no crop/zoom/camera command is issued');
  assert.ok(!compiled.commands.some(c=>c.action==='ADD_ZOOM'),'Quick Reframe never adds a zoom (the crop is the canonical framing)');
  const before=project.revision;
  const applied=await h.service.applyAssistantBundle(id,project.revision,{proposalId:'quick-styletwo-test',summary:'StyleTwo',userMessage:'StyleTwo',actor:'TEMPLATE_ACTION',commands:compiled.commands,onInvalid:'ABORT'});
  project=applied.project;assert.equal(project.revision,before+1,'one undoable revision');
  const layout=project.settings.resolvedVisualLayout;
  assert.equal(layout.editingProfile,ID);
  assert.deepEqual(layout.videoFrame,{...normalized(S.media),mode:'CARD',cropPolicy:layout.videoFrame.cropPolicy},'approved StyleTwo window, unchanged');
  assert.equal(project.settings.quickReframeStyleTwo,true);assert.ok(!project.settings.quickReframeStyleOne);
  assert.equal(project.settings.reframePolicy,'SOURCE');assert.equal(project.settings.zoomPolicy,'OFF');
  assert.deepEqual(layout.frameSegments,[{startSec:0,endSec:duration,layout:'FIT'}]);
  assert.deepEqual(layout.cameraPath.map(k=>[k.x,k.y,k.w,k.h]),[[0,0,1,1],[0,0,1,1]],'camera is the whole baked frame');
  assert.ok(project.elements.filter(e=>e.type==='VIDEO').every(e=>e.properties.frameLayout==='FIT'));
  assert.ok(project.elements.filter(e=>e.type==='VIDEO').every(e=>!e.properties.crop||Object.values(e.properties.crop).every(v=>!v)),'no crop is added to the timeline');
  assert.equal(project.elements.filter(e=>e.type==='EFFECT').length,0);
  const styleHook=project.elements.find(e=>e.type==='TEXT'&&e.properties.presetRole==='HOOK');
  assert.ok(styleHook,'StyleTwo hook');assert.equal(styleHook.properties.fontFamily,S.hookFont);assert.equal(styleHook.properties.content,hook);
  assert.equal(styleHook.duration,duration,'persistent hook spans the whole timeline');

  // ---- Undo restores the pre-StyleTwo composition (it is a normal canonical revision); redo brings it back.
  const undone=await h.service.undo(id,project.revision);
  assert.equal(undone.settings.resolvedVisualLayout?.editingProfile,undefined);
  project=await h.service.redo(id,undone.revision);assert.equal(project.settings.resolvedVisualLayout.editingProfile,ID);

  // ---- Preview and export: identical composition, fixed window, white canvas, no second crop.
  const exportCanvas=quickOutputCanvas(project.settings,baked.width,baked.height,1080);
  assert.deepEqual(exportCanvas,{width:1080,height:1920});
  assert.deepEqual(quickOutputCanvas(project.settings,baked.width,baked.height,720),{width:720,height:1280});
  const run=(canvas,style=ID==='x'?null:'STYLETWO',p=project)=>quickComposeRender({project:p,assets,elements:p.elements,hasSourceAudio:true,canvasOverride:canvas},'source.mp4','out.mp4',media,style);
  const styled=run(exportCanvas),preview=run(quickOutputCanvas(project.settings,baked.width,baked.height,540));
  assert.deepEqual([preview.plan.canvas.width,preview.plan.canvas.height],[540,960]);
  assert.equal(styled.plan.durationSec,duration);assert.equal(styled.plan.zoomEvents.length,0);
  assert.deepEqual(styled.plan.canvas.visualLayout.videoFrame,preview.plan.canvas.visualLayout.videoFrame,'preview and export share the geometry');
  const graph=filterGraph(styled);
  assert.match(graph,/color=c=#FFFFFF:s=1080x1920/u,'white canvas');
  assert.match(graph,/scale=1080:860:force_original_aspect_ratio=decrease/u,'whole crop fitted inside the 1080x860 window');
  assert.match(graph,/overlay=0:630/u,'window at y=630');
  // The visible picture is the fitted foreground (scale ... decrease, no crop filter) for the whole duration;
  // the only crop in the graph trims a backdrop that is immediately painted over with the canvas colour.
  const foreground=graph.match(/;\[vfitb\]([^;]*)\[vfitfg\]/u)?.[1];
  assert.ok(foreground,'fitted foreground exists');assert.doesNotMatch(foreground,/crop/u,'the baked crop is never cropped a second time');
  assert.ok(graph.includes(`enable='between(t\\,0.000\\,${(duration-.001).toFixed(3)})'`),'the fitted whole frame covers the full duration');
  assert.match(graph.match(/;\[vfita\]([^;]*)\[vfitbg\]/u)[1],/drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill/u,'the window matte is black in the export, exactly as the editor preview paints it');
  assert.match(styled.ass,/StyleTwoVector/u);assert.ok(styled.ass.includes('YCbCr Matrix: None'));
  assert.deepEqual(styled.plan.canvas.visualLayout.hook.fontSize,S.hookSize);
  // The right renderer: asking StyleOne to compose a StyleTwo project (or vice versa) is refused, never silently mixed.
  assert.throws(()=>run(exportCanvas,'STYLEONE'),/StyleOne layout/u);
  assert.throws(()=>quickComposeRender({project:{...project,settings:{...project.settings,resolvedVisualLayout:null}},assets,elements:project.elements,canvasOverride:exportCanvas},'s.mp4','o.mp4',media,'STYLETWO'),/StyleTwo layout/u);
  // StyleTwo's bundled fonts accompany an export that uses native-text overrides.
  const withFonts=quickComposeRender({project,assets,elements:project.elements,hasSourceAudio:true,canvasOverride:exportCanvas},'source.mp4','out.mp4',media,'STYLETWO',{fontsDir:'style-two-fonts'});
  assert.match(filterGraph(withFonts),/fontsdir=style-two-fonts/u);

  // ---- Captions: StyleTwo's red plates; an over-long edit is rejected with a StyleTwo message, not mangled.
  h.rows.editElements.set('caption',{...project.elements[0],id:'caption',assetId:null,type:'SUBTITLE',track:2,position:0,startTime:0,duration:2,trimStart:0,trimEnd:null,properties:{content:'Original words'}});project=await h.service.get(id);
  const withCaptions=quickStyleCommands({project,assets,elements:project.elements},{hookText:hook,captions:true},'STYLETWO');
  const captioned=await h.service.applyAssistantBundle(id,project.revision,{proposalId:'quick-styletwo-captions',summary:'StyleTwo captions',userMessage:'captions',actor:'TEMPLATE_ACTION',commands:withCaptions.commands,onInvalid:'ABORT'});
  const caption=captioned.project.elements.find(e=>e.type==='SUBTITLE');
  assert.equal(caption.properties.fontFamily,S.captionFont);
  const overlong=captioned.project.elements.map(e=>e.type==='SUBTITLE'?{...e,properties:{...e.properties,content:'Preserve the complete original sequence and all the original spoken words '.repeat(6)}}:e);
  assert.throws(()=>quickComposeRender({project:captioned.project,assets,elements:overlong,hasSourceAudio:true,canvasOverride:exportCanvas},'s.mp4','o.mp4',media,'STYLETWO'),/StyleTwo.s two-line/u);
  const okCaption=quickComposeRender({project:captioned.project,assets,elements:captioned.project.elements,hasSourceAudio:true,canvasOverride:exportCanvas},'s.mp4','o.mp4',media,'STYLETWO');
  assert.ok(okCaption.ass.includes('B0321B')||okCaption.ass.toLowerCase().includes('1b32b0'),'StyleTwo red plate colour in the ASS (#B0321B)');

  // ---- StyleOne is untouched by the generalization.
  const one=quickStyleOneCommands({project:await h.service.get(id),assets,elements:(await h.service.get(id)).elements},{hookText:hook,captions:false});
  assert.ok(one.commands.some(c=>c.action==='QUICK_REFRAME_STYLEONE'),'StyleOne still emits its own settings action');
  assert.ok(!one.commands.some(c=>c.action==='QUICK_REFRAME_STYLETWO'));

  console.log('Quick Reframe + StyleTwo: server route/registry, one undoable revision, fixed window/white canvas (black window matte, as in the preview), whole crop fitted with no second crop, no zoom/camera, preview/export parity, caption guard and StyleOne unchanged: PASS');
  console.log(JSON.stringify({graph:graph.split(';').filter(x=>/scale=|overlay=|color=/u.test(x)).slice(0,5)}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
