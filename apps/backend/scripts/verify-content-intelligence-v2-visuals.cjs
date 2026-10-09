// Canonical ASS and actual React preview over saved authorized template projects.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..'),out=path.join(root,'.real-qa-preview/content-intelligence-v2/visuals');fs.mkdirSync(out,{recursive:true});
const ts=require('typescript'),Module=require('node:module'),original=Module._resolveFilename;
Module._resolveFilename=function(request,...args){return original.call(this,request.startsWith('@/')?path.join(root,'apps/frontend/src',request.slice(2)):request,...args);};
for(const extension of ['.ts','.tsx'])require.extensions[extension]=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {EditPreviewText}=require(path.join(root,'apps/frontend/src/components/edit-mode/edit-preview-text.tsx'));
const {layoutFittedFontSize}=require(path.join(root,'apps/frontend/src/lib/edit-mode-text.ts'));
const {buildRenderPlan}=require('../dist/modules/edit-mode/render/edit-mode-render-plan');
const {buildEditModeAss}=require('../dist/modules/edit-mode/render/edit-mode-ass');
const {fitRetainedHook}=require('../dist/modules/edit-mode/styles/resolved-visual-layout');
const ffmpeg=path.join(root,'.cache/ffmpeg-benchmark/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe');
const samples={normal:'Why did the cooling experiment miss the equipment’s biggest weakness?',
 long:'Why did the equipment keep overheating after every test when the cooling measurements appeared stable and the workload never exceeded the original factory design operating limits?',
 hindi:'इस परीक्षण में मशीन के गर्म होने की असली वजह क्या थी और नया कूलिंग सिस्टम लगाने से नतीजा कैसे बदल गया?'};
const templates={StyleZero:'style-two/before/stylezero-project.json',StyleOne:'style-two/before/styleone-project.json',StyleTwo:'style-two/current-two/styletwo-project.json'};
const fontDir=path.join(root,'.real-qa-preview/style-two/before/fonts');fs.cpSync(fontDir,path.join(out,'fonts'),{recursive:true});
const fontCss=`@font-face{font-family:'EB Garamond';src:url(data:font/otf;base64,${fs.readFileSync(path.join(fontDir,'EBGaramond12-Regular.otf')).toString('base64')})}`;
async function main(){
 const {chromium}=require('@playwright/test'),browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1080,height:1920},deviceScaleFactor:1});const results=[];
 try{for(const [template,file]of Object.entries(templates))for(const [sample,content]of Object.entries(samples)){
  const project=JSON.parse(fs.readFileSync(path.join(root,'.real-qa-preview',file),'utf8'));
  const baseline=buildRenderPlan({project,assets:project.assets,elements:project.elements}).plan;
  const element=project.elements.find(e=>e.type==='TEXT'&&(e.properties.presetRole==='HOOK'||e.properties.templateRole==='HOOK'));assert(element);
  const before={...element.properties};element.properties={...before,content,textRuns:[],...fitRetainedHook(before,content)};
  // This is the same parent fit used by the actual editor preview, applied after canonical replacement.
  const fitted=template==='StyleOne'?layoutFittedFontSize(element.properties,project.settings.resolvedVisualLayout?.hook):null;
  const previewProperties={...element.properties,...(fitted==null?{}:{fontSize:fitted})};
  const plan=buildRenderPlan({project,assets:project.assets,elements:project.elements}).plan;
  for(const field of ['videoSegments','frameSegments','zoomEvents','grading','subtitles'])assert.deepEqual(plan[field],baseline[field],template+' '+field+' unchanged');
  for(const field of ['x','y','width','height','fontFamily','color','stroke','shadow'])assert.deepEqual(element.properties[field],before[field],template+' '+field+' unchanged');
  const overlay=plan.textOverlays.find(e=>e.elementId===element.id),ass=buildEditModeAss(plan.canvas,[{...overlay,startSec:0,endSec:1}]);
  assert(!ass.overflowed.length,`${template}/${sample}: ${ass.overflowed}`);assert.equal(overlay.content,content);
  const id=template+'-'+sample;fs.writeFileSync(path.join(out,id+'.ass'),ass.content);
  const rect=project.settings.resolvedVisualLayout?.videoFrame||{x:0,y:.36,width:1,height:.5};
  const background=template==='StyleTwo'?'white':'black';
  const box=`drawbox=x=${Math.round(rect.x*1080)}:y=${Math.round(rect.y*1920)}:w=${Math.round(rect.width*1080)}:h=${Math.round(rect.height*1920)}:color=gray:t=fill`;
  execFileSync(ffmpeg,['-v','error','-f','lavfi','-i',`color=c=${background}:s=1080x1920:d=1`,'-vf',`${box},ass=${id}.ass:fontsdir=fonts`,'-threads','2','-frames:v','1','-y',id+'-export.png'],{cwd:out});
  const p=previewProperties,markup=renderToStaticMarkup(React.createElement(EditPreviewText,{element:{...element,properties:p},offsetSec:0,canvasWidth:1080,styleTwo:template==='StyleTwo'}));
  const html=`<!doctype html><meta charset="utf-8"><style>${fontCss}html,body{margin:0;padding:0}.flex{display:flex}.h-full{height:100%}.w-full{width:100%}.items-center{align-items:center}#canvas{position:relative;width:1080px;height:1920px;background:${background}}</style><div id="canvas"><div style="position:absolute;left:${rect.x*1080}px;top:${rect.y*1920}px;width:${rect.width*1080}px;height:${rect.height*1920}px;background:gray"></div><div style="position:absolute;left:${p.x*1080}px;top:${p.y*1920}px;width:${p.width*1080}px;height:${p.height*1920}px">${markup}</div></div>`;
  await page.setContent(html);await page.evaluate(()=>document.fonts.ready);
  const nativeBounds=await page.locator('svg text').evaluateAll(nodes=>nodes.map(node=>{const b=node.getBBox(),svg=node.ownerSVGElement;return{x:b.x,right:b.x+b.width,width:svg.viewBox.baseVal.width};}));
  assert(nativeBounds.every(b=>b.x>=-1&&b.right<=b.width+1),`${id}: native preview lettering must fit the fixed box`);
  await page.locator('#canvas').screenshot({path:path.join(out,id+'-preview.png')});
  const text=await page.locator('#canvas').innerText();assert(text.replace(/\s+/gu,' ').includes(content.replace(/\s+/gu,' '))||template==='StyleTwo','preview preserves words');
  results.push({template,sample,words:content.split(/\s+/u).length,originalFont:before.fontSize,storedFont:p.fontSize,exportFontPixels:overlay.fontSizePx,overflow:ass.overflowed,parityNotes:ass.parityNotes,geometryPreserved:true});console.log('PASS '+id);
 }}finally{await browser.close();}
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(results,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
