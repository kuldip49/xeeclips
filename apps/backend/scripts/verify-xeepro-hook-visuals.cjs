// Visual acceptance uses exact failing downloads, canonical template geometry and actual React/ASS text renderers.
// Diagnostic media snippets retain the downloaded footage and captions; the old header is cropped out.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..'),out=path.join(root,'.real-qa-preview/xeepro-hook-grammar',process.argv.includes('--social-style')?'visuals-social-style':'visuals');fs.mkdirSync(out,{recursive:true});
const ts=require('typescript'),Module=require('node:module'),original=Module._resolveFilename;
Module._resolveFilename=function(request,...args){return original.call(this,request.startsWith('@/')?path.join(root,'apps/frontend/src',request.slice(2)):request,...args);};
for(const ext of ['.ts','.tsx'])require.extensions[ext]=(m,file)=>m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {EditPreviewText}=require(path.join(root,'apps/frontend/src/components/edit-mode/edit-preview-text.tsx'));
const {layoutFittedFontSize}=require(path.join(root,'apps/frontend/src/lib/edit-mode-text.ts'));
const {buildRenderPlan}=require('../dist/modules/edit-mode/render/edit-mode-render-plan');
const {buildEditModeAss}=require('../dist/modules/edit-mode/render/edit-mode-ass');
const {fitRetainedHook}=require('../dist/modules/edit-mode/styles/resolved-visual-layout');
const samples=JSON.parse(fs.readFileSync(path.join(out,process.argv.includes('--social-style')?'../real-style-results.json':'../real-results.json'),'utf8'));
const templates={StyleZero:'style-two/before/stylezero-project.json',StyleOne:'style-two/before/styleone-project.json',StyleTwo:'style-two/current-two/styletwo-project.json'};
const fontDir=path.join(root,'.real-qa-preview/style-two/before/fonts');fs.cpSync(fontDir,path.join(out,'fonts'),{recursive:true});
const fontCss=`@font-face{font-family:'EB Garamond';src:url(data:font/otf;base64,${fs.readFileSync(path.join(fontDir,'EBGaramond12-Regular.otf')).toString('base64')})}`;
(async()=>{
 const {chromium}=require('@playwright/test'),browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1080,height:1920},deviceScaleFactor:1}),results=[];
 try{for(const sample of samples)for(const [template,file]of Object.entries(templates)){
  assert(sample.grammar && sample.clarity && sample.status==='ACCEPTED');
  const content=sample.newHook,project=JSON.parse(fs.readFileSync(path.join(root,'.real-qa-preview',file),'utf8'));
  delete project.settings.origin;delete project.settings.contentIntelligence;
  const baseline=buildRenderPlan({project,assets:project.assets,elements:project.elements}).plan;
  const element=project.elements.find(e=>e.type==='TEXT'&&(e.properties.presetRole==='HOOK'||e.properties.templateRole==='HOOK'));assert(element);
  const before={...element.properties};element.properties={...before,content,textRuns:[],...fitRetainedHook(before,content)};
  project.settings.contentIntelligence=sample.package;
  const plan=buildRenderPlan({project,assets:project.assets,elements:project.elements}).plan;
  for(const field of ['videoSegments','frameSegments','zoomEvents','grading','subtitles'])assert.deepEqual(plan[field],baseline[field],template+' '+field);
  for(const field of ['x','y','width','height','fontFamily','color','stroke','shadow'])assert.deepEqual(element.properties[field],before[field],template+' '+field);
  const overlay=plan.textOverlays.find(e=>e.elementId===element.id),ass=buildEditModeAss(plan.canvas,[{...overlay,startSec:0,endSec:3}]);
  assert.equal(overlay.content,content);assert(!ass.overflowed.length,template+' text overflow');
  const id=sample.id+'-'+template;fs.writeFileSync(path.join(out,id+'.ass'),ass.content);
  const rect=project.settings.resolvedVisualLayout?.videoFrame||{x:0,y:.36,width:1,height:.5};
  const x=Math.round(rect.x*1080),y=Math.round(rect.y*1920),w=Math.round(rect.width*1080),h=Math.round(rect.height*1920);
  const background=template==='StyleTwo'?'white':'black',source=path.join('C:/Users/kuldi/Downloads',sample.id==='file24'?'file (24).mp4':'file (23).mp4');
  const filter=`[1:v]crop=1080:860:0:630,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black[pic];[0:v][pic]overlay=${x}:${y},ass=${id}.ass:fontsdir=fonts[v]`;
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i',`color=c=${background}:s=1080x1920:r=30:d=3`,'-ss','2','-i',source,'-filter_complex',filter,'-map','[v]','-map','1:a?','-t','3','-c:v','libx264','-preset','ultrafast','-crf','23','-c:a','aac','-threads','2','-y',id+'.mp4'],{cwd:out});
  execFileSync('ffmpeg',['-v','error','-ss','1','-i',id+'.mp4','-frames:v','1','-y',id+'-export.png'],{cwd:out});
  const fitted=template==='StyleOne'?layoutFittedFontSize(element.properties,project.settings.resolvedVisualLayout?.hook):null;
  const p={...element.properties,...(fitted==null?{}:{fontSize:fitted})};
  const markup=renderToStaticMarkup(React.createElement(EditPreviewText,{element:{...element,properties:p},offsetSec:0,canvasWidth:1080,styleTwo:template==='StyleTwo'}));
  const html=`<!doctype html><meta charset="utf-8"><style>${fontCss}html,body{margin:0;padding:0}.flex{display:flex}.h-full{height:100%}.w-full{width:100%}.items-center{align-items:center}#canvas{position:relative;width:1080px;height:1920px;background:${background}}</style><div id="canvas"><div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:gray"></div><div style="position:absolute;left:${p.x*1080}px;top:${p.y*1920}px;width:${p.width*1080}px;height:${p.height*1920}px">${markup}</div></div>`;
  await page.setContent(html);await page.evaluate(()=>document.fonts.ready);
  const bounds=await page.locator('svg text').evaluateAll(nodes=>nodes.map(n=>{const b=n.getBBox();return{x:b.x,right:b.x+b.width,width:n.ownerSVGElement.viewBox.baseVal.width};}));
  assert(bounds.every(b=>b.x>=-1&&b.right<=b.width+1),id+' preview overflow');
  await page.locator('#canvas').screenshot({path:path.join(out,id+'-preview.png')});
  const text=await page.locator('#canvas').innerText();assert(template==='StyleTwo'||text.replace(/\s+/gu,' ').includes(content.replace(/\s+/gu,' ')));
  results.push({id:sample.id,template,content,words:content.split(/\s+/u).length,font:p.fontSize,overflow:ass.overflowed,parityNotes:ass.parityNotes,geometryPreserved:true});console.log('PASS '+id);
 }}finally{await browser.close();}
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(results,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
