// Renders the actual React EditPreviewText component and the canonical ASS on
// identical plain footage. No running frontend/backend or account is required.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..'),out=path.join(root,'.real-qa-preview/style-two/parity');
fs.mkdirSync(out,{recursive:true});
const ts=require('typescript'), Module=require('node:module'), original=Module._resolveFilename;
Module._resolveFilename=function(request,...args){return original.call(this,request.startsWith('@/')?path.join(root,'apps/frontend/src',request.slice(2)):request,...args);};
for(const extension of ['.ts','.tsx']) require.extensions[extension]=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const React=require('react'), {renderToStaticMarkup}=require('react-dom/server');
const {EditPreviewText}=require(path.join(root,'apps/frontend/src/components/edit-mode/edit-preview-text.tsx'));
const {STYLE_TWO:S,STYLE_TWO_ID:ID,normalized}=require('@ai-content-platform/shared/style-two.cjs');
const {readTextStyle,captionStylePreset}=require('../dist/modules/edit-mode/edit-mode-text');
const {buildEditModeAss}=require('../dist/modules/edit-mode/render/edit-mode-ass');
const rects=[S.hook,S.captions];
const properties=[{...normalized(S.hook),content:'“Being Somali-American is like\nbananas and rice...” - Wait for\nCrowder’s reaction',fontFamily:S.hookFont,fontSize:S.hookSize,fontWeight:700,color:'#000000',
  textAlign:'center',lineSpacing:S.hookLineHeight,stroke:{enabled:false},shadow:{enabled:false},background:{enabled:false}},
  {...normalized(S.captions),content:"SOMALI ISN'T",...captionStylePreset('STYLE_TWO').style}];
const overlays=properties.map((p,i)=>({...readTextStyle(p),...rects[i],elementId:`parity-${i}`,content:p.content,
  fontSizePx:p.fontSize*1.8,startSec:0,endSec:1,zIndex:35,words:[],textRuns:[],rotation:0,kind:i?'SUBTITLE':'TEXT',backgroundColor:'transparent',lines:[]}));
const canvas={width:1080,height:1920,visualLayout:{editingProfile:ID}};
const ass=buildEditModeAss(canvas,overlays);fs.writeFileSync(path.join(out,'parity.ass'),ass.content);
const ffmpeg=path.join(root,'.cache/ffmpeg-benchmark/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe');
execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=white:s=1080x1920:d=1','-vf',
  'drawbox=x=0:y=630:w=1080:h=860:color=gray:t=fill,ass=parity.ass','-frames:v','1','-y','export.png'],{cwd:out});
// Transcribed visible reference samples, only for visual QA. Generation uses
// the clip transcript and existing creative package, never these fixtures.
for (const [t, content] of [[.2,'TO ME, BEING'],[1,"SOMALI ISN'T"],[5,'WHAT IS IT THEN?'],
  [15,'IT MEANS TO'],[29,"PEOPLE DON'T THINK,"],[45,''],[57,"THAT'S PRETTY MUCH"]]) {
  const sample = buildEditModeAss(canvas, content ? [overlays[0], {...overlays[1],content}] : [overlays[0]]);
  fs.writeFileSync(path.join(out,`sample-${t}.ass`),sample.content);
  execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=white:s=1080x1920:d=1','-vf',
    `drawbox=x=0:y=630:w=1080:h=860:color=gray:t=fill,ass=sample-${t}.ass`,'-frames:v','1','-y',`sample-${t}.png`],{cwd:out});
}
let markup='';
properties.forEach((p,i)=>{const r=rects[i];markup+=`<div style="position:absolute;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px">`+
  renderToStaticMarkup(React.createElement(EditPreviewText,{element:{id:`parity-${i}`,type:i?'SUBTITLE':'TEXT',properties:p},offsetSec:0,canvasWidth:1080,styleTwo:true}))+'</div>';});
const html=`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0}#canvas{position:relative;width:1080px;height:1920px;background:white}</style><div id="canvas"><div style="position:absolute;left:0;top:630px;width:1080px;height:860px;background:gray"></div>${markup}</div>`;
fs.writeFileSync(path.join(out,'preview.html'),html);
async function main(){
 const {chromium}=require('@playwright/test');
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1080,height:1920},deviceScaleFactor:1});
 await page.setContent(html);await page.locator('#canvas').screenshot({path:path.join(out,'preview.png')});
 await page.setViewportSize({width:360,height:640});
 await page.evaluate(()=>{document.querySelector('#canvas').style.transform='scale(0.3333333333)';document.querySelector('#canvas').style.transformOrigin='top left';});
 await page.screenshot({path:path.join(out,'preview-mobile.png')});
 await browser.close(); console.log(`Actual React/ASS comparison: ${out}`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
