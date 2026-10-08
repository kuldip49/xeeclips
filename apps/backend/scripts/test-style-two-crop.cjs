const assert=require('node:assert/strict');
const {styleTwoCropTransform,styleTwoCropFilter}=require('@ai-content-platform/shared/style-two-crop.cjs');
const {createHarness}=require('./test-edit-mode-isolation.cjs');
const fs=require('node:fs');
const crop={top:.028301,left:.028301,right:.028303,bottom:.028303};
const geometry=styleTwoCropTransform(1080,1920,{crop});
assert.deepEqual(geometry.rect,{x:31,y:54,width:1019,height:1811});
assert.deepEqual(geometry.fitted,{x:0,y:0,width:1080,height:1919});
assert.deepEqual(geometry.target,{x:0,y:630,width:1080,height:860});
assert(styleTwoCropFilter(geometry).includes('crop=1019:1811:31:54:exact=1'));
assert.equal(styleTwoCropTransform(906,1152,{confirmed:{crop:{x:.08,y:.24,w:.84,h:.60}}}),null,
 'Quick Reframe confirmed crop is already baked; never read it as another crop');
assert.equal(styleTwoCropTransform(1080,1920,{}),null,'No-crop path stays byte-identical');
for(const [w,h] of [[1080,1920],[906,1152],[1920,1080]])for(const c of [crop,
 {left:.32,right:.32,top:.03,bottom:.03},{left:.03,right:.03,top:.32,bottom:.32}]) {
 const g=styleTwoCropTransform(w,h,{crop:c,scale:.7,offsetX:.012,offsetY:-.01});
 assert(g.rect.x+g.rect.width<=w&&g.rect.y+g.rect.height<=h);
 assert(g.fitted.x>=0&&g.fitted.y>=0);
 assert(!styleTwoCropFilter(g).includes('force_original_aspect_ratio'),'No second fit calculation in FFmpeg');
 assert.deepEqual(styleTwoCropTransform(w,h,{crop:JSON.parse(JSON.stringify(c)),scale:.7,offsetX:.012,offsetY:-.01}),g);
}

// Optional retained project: real canonical commands, storage reload and Undo/Redo.
async function main(){
 if(process.argv[2]){
  const p=JSON.parse(fs.readFileSync(process.argv[2])),h=createHarness();
  h.rows.editProjects.set(p.id,{...p,assets:undefined,elements:undefined});
  for(const a of p.assets)h.rows.editAssets.set(a.id,a);
  for(const e of p.elements)h.rows.editElements.set(e.id,e);
  let state=await h.service.get(p.id);const video=state.elements.find(e=>e.type==='VIDEO'),
    hook=state.elements.find(e=>e.type==='TEXT'),caption=state.elements.find(e=>e.type==='SUBTITLE');
  const run=async(action,payload)=>state=await h.service.phase3Command(p.id,action,{revision:state.revision,...payload});
  await run('set-text-content',{elementId:hook.id,content:'Crop parity verified'});
  const correction=caption.properties.content.replace(/^\S+/,'One');
  await run('set-caption-text',{elementId:caption.id,content:correction});
  await run('set-video-crop',{elementId:video.id,cropLeft:crop.left,cropRight:crop.right,cropTop:crop.top,cropBottom:crop.bottom});
  state=await h.service.get(p.id);
  const g=styleTwoCropTransform(p.assets.find(a=>a.role==='SOURCE').width,p.assets.find(a=>a.role==='SOURCE').height,
    state.elements.find(e=>e.id===video.id).properties);
  state=await h.service.undo(p.id,state.revision);
  state=await h.service.redo(p.id,state.revision);
  state=await h.service.get(p.id);
  assert.deepEqual(styleTwoCropTransform(p.assets.find(a=>a.role==='SOURCE').width,p.assets.find(a=>a.role==='SOURCE').height,
    state.elements.find(e=>e.id===video.id).properties),g);
  assert.equal(state.settings.resolvedVisualLayout.editingProfile,'AUTOMATIC_3_STYLE_TWO');
  assert.equal(state.elements.find(e=>e.id===hook.id).properties.fontSize,44.5);
  assert.equal(state.elements.find(e=>e.id===caption.id).properties.content,correction);
  assert.equal(state.elements.find(e=>e.id===caption.id).properties.background.color,'#B0321B');
  if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(state,null,2));
 }
 console.log('PASS: shared integer crop geometry, odd offsets, fit/pad, scale, neutral and baked Quick Reframe isolation; canonical save/reload/Undo/Redo.');
}
main().catch(e=>{console.error(e);process.exitCode=1});
