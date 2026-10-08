// Local real React/FFmpeg acceptance against retained production project JSON.
// Usage: node ... SOURCE PROJECT_JSON OUTPUT_DIR [--before]
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const source=path.resolve(process.argv[2]),projectFile=path.resolve(process.argv[3]),out=path.resolve(process.argv[4]);
const before=process.argv.includes('--before');fs.mkdirSync(out,{recursive:true});
const {buildRenderPlan}=require('../dist/modules/edit-mode/render/edit-mode-render-plan');
const {buildEditModeAss}=require('../dist/modules/edit-mode/render/edit-mode-ass');
const {buildFfmpegArgs}=require('../dist/modules/edit-mode/render/edit-mode-filtergraph');
const {styleTwoCropTransform}=require('@ai-content-platform/shared/style-two-crop.cjs');
const bin=path.join(root,'.cache/ffmpeg-benchmark/ffmpeg-9.0.2-essentials_build/bin');
const ffmpeg=path.join(bin,'ffmpeg.exe');
const copy=o=>JSON.parse(JSON.stringify(o)),original=JSON.parse(fs.readFileSync(projectFile));
const cases={exact:null,centered:{left:.08,right:.08,top:.08,bottom:.08},
 left:{left:.26,right:.01,top:.03,bottom:.03},right:{left:.01,right:.26,top:.03,bottom:.03},
 top:{left:.03,right:.03,top:.26,bottom:.01},bottom:{left:.03,right:.03,top:.01,bottom:.26},
 narrow:{left:.32,right:.32,top:.03,bottom:.03},wide:{left:.03,right:.03,top:.32,bottom:.32},
 zoom:null,scaled:null,rotated:null,neutral:{left:0,right:0,top:0,bottom:0}};
const fixtures={};
for(const [name,crop] of Object.entries(cases)) {
 const p=copy(original),v=p.elements.find(e=>e.type==='VIDEO');if(crop)v.properties.crop=crop;
 if(name==='zoom')p.elements.push({id:'crop-zoom-qa',type:'EFFECT',track:3,position:0,startTime:4.5,duration:2.5,
  properties:{effect:'ZOOM',enabled:true,scale:1.06,focusX:.5,focusY:.5}});
 if(name==='scaled')Object.assign(v.properties,{scale:1.1,offsetX:.013,offsetY:-.012});
 if(name==='rotated')Object.assign(v.properties,{rotation:7,flipH:true});
 fixtures[name]=p;fs.writeFileSync(path.join(out,`${name}-project.json`),JSON.stringify(p,null,2));
 if(process.argv.includes('--exact-only')&&name!=='exact')continue;
 if(before||process.argv.includes('--capture-only'))continue;
 if(process.argv.includes('--resume')&&fs.existsSync(path.join(out,`${name}.mp4`))&&name!=='zoom')continue;
 const built=buildRenderPlan({project:p,assets:p.assets,elements:p.elements,hasSourceAudio:true,fps:30});
 if(name==='zoom')assert.equal(built.plan.zoomEvents.length,1,'Zoom fixture must actually render');
 fs.writeFileSync(path.join(out,`${name}-plan.json`),JSON.stringify(built.plan,null,2));
 fs.writeFileSync(path.join(out,`${name}.ass`),buildEditModeAss(built.plan.canvas,[...built.plan.textOverlays,...built.plan.subtitles]).content);
 const args=buildFfmpegArgs({plan:built.plan,sourcePath:source,overlayPaths:{},audioPaths:{},assFileName:`${name}.ass`,
  fontsDir:'fonts',outputPath:path.join(out,`${name}.mp4`),...built.evidence});
 if(name!=='exact')args[args.lastIndexOf('-t')+1]=name==='zoom'?'7.100':'4.100';
 fs.cpSync(path.join(root,'apps/frontend/public/fonts'),path.join(out,'fonts'),{recursive:true});
 fs.writeFileSync(path.join(out,`${name}-args.json`),JSON.stringify(args,null,2));
 execFileSync(ffmpeg,args,{cwd:out,stdio:['ignore','ignore','pipe'],maxBuffer:10e6});
 console.log('rendered',name);
}
const loader=path.join(out,'loader.cjs'),entry=path.join(out,'entry.tsx');
const previewFile=path.join(root,'apps/frontend/src/components/edit-mode/edit-preview.tsx');
if(before)fs.writeFileSync(path.join(out,'before-preview.tsx'),execFileSync('git',['show','64998bf:apps/frontend/src/components/edit-mode/edit-preview.tsx']));
fs.writeFileSync(loader,`module.exports=function(s){${before?`if(this.resourcePath.replaceAll('\\\\','/').endsWith('/edit-mode/edit-preview.tsx'))s=require('node:fs').readFileSync(${JSON.stringify(path.join(out,'before-preview.tsx'))},'utf8');`:''}return require(${JSON.stringify(require.resolve('typescript'))}).transpileModule(s,{compilerOptions:{jsx:4,module:99,target:9,esModuleInterop:true}}).outputText;};`);
fs.writeFileSync(entry,`import React from 'react';import{createRoot}from'react-dom/client';import{EditPreview}from ${JSON.stringify(previewFile.replaceAll('\\','/'))};
const q=new URL(location.href).searchParams;fetch('/project.json?case='+q.get('case')).then(r=>r.json()).then(p=>{window.project=p;createRoot(document.getElementById('app')).render(<EditPreview source={p.assets.find(a=>a.role==='SOURCE')} assets={p.assets} aspectRatio='9:16' reframePolicy={p.settings.reframePolicy} resolvedVisualLayout={p.settings.resolvedVisualLayout} elements={p.elements} selectedElementId={null} currentPlayheadSec={Number(q.get('t'))} onPlayheadChange={()=>{}} onSelect={()=>{}} onPreviewElements={()=>{}} onCommitTransform={()=>{}}/>);});`);
const cssDir=path.join(root,'apps/frontend/.next/static/css'),css=fs.readdirSync(cssDir).find(f=>f.endsWith('.css'));
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');let file,mime;
 if(url.pathname==='/project.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(fixtures[url.searchParams.get('case')]));return;}
 if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}</style><div id="app"></div><script src="/bundle.js"></script>');return;}
 if(url.pathname==='/bundle.js'){file=path.join(out,'bundle.js');mime='application/javascript';}
 else if(url.pathname==='/style.css'){file=path.join(cssDir,css);mime='text/css';}
 else if(url.pathname.includes('/edit-mode/assets/')){file=source;mime='video/mp4';}
 else if(url.pathname.startsWith('/fonts/')){file=path.join(root,'apps/frontend/public',url.pathname);mime='font/ttf';}
 else {res.statusCode=404;res.end();return;}
 const bytes=fs.readFileSync(file);res.setHeader('Content-Type',mime);res.setHeader('Access-Control-Allow-Origin','*');
 const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');if(range){const start=Number(range[1]),end=range[2]?Number(range[2]):bytes.length-1;res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':end-start+1,'Accept-Ranges':'bytes'});res.end(bytes.subarray(start,end+1));}else res.end(bytes);
});
async function main(){
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 const packaged=require('next/dist/compiled/webpack/webpack');packaged.init();const webpack=packaged.webpack;
 await new Promise((resolve,reject)=>webpack({mode:'development',devtool:false,entry,output:{path:out,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js','.cjs','.json'],alias:{'@':path.join(root,'apps/frontend/src')}},module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:loader}]},plugins:[new webpack.DefinePlugin({'process.env.NEXT_PUBLIC_API_URL':JSON.stringify(url)})]},(e,s)=>e||s.hasErrors()?reject(e||new Error(s.toString({all:false,errors:true}))):resolve()));
 const {chromium}=require('@playwright/test'),browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const evidence=[];
 try{for(const name of before?['exact']:process.argv.includes('--exact-only')?['exact']:Object.keys(cases))for(const [view,w,h,dpr] of before?[['desktop',1106,2050,1]]:[['desktop',1106,2050,1],['mobile375',375,844,3],['mobile390',390,844,3]]){
  const page=await browser.newPage({viewport:{width:w,height:h},deviceScaleFactor:dpr});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  for(const t of name==='exact'?[.5,3,12,25,34]:name==='zoom'?[5.5]:[3]){
   await page.goto(`${url}/?case=${name}&t=${t}`);
   await page.waitForFunction(t=>{const v=document.querySelector('video');return v&&v.readyState>=2&&Math.abs(v.currentTime-t)<.04;},t);
   await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(150);
   const canvas=page.getByTestId('edit-preview-canvas');const bounds=await canvas.boundingBox();
   // Preserve device resolution for mobile; reducing to CSS pixels before
   // measurement would inflate a screenshot edge rounding error threefold.
   await page.screenshot({path:path.join(out,`${name}-${view}-t${t}.png`),
     clip:{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height},scale:'device'});
   const surface=page.getByTestId('style-two-crop-surface');
   const g=await surface.count()?await surface.getAttribute('data-crop-transform'):null;
   const asset=fixtures[name].assets.find(a=>a.role==='SOURCE');
   const expected=styleTwoCropTransform(asset.width,asset.height,fixtures[name].elements.find(e=>e.type==='VIDEO').properties);
   if(!before&&expected)assert.deepEqual(JSON.parse(g),expected);
   evidence.push({name,view,t,bounds,dpr,geometry:g?JSON.parse(g):null,errors});assert.deepEqual(errors,[]);
  }await page.close();
 }}finally{await browser.close();server.close();}
 fs.writeFileSync(path.join(out,'preview-results.json'),JSON.stringify(evidence,null,2));console.log('preview capture complete',out);
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;server.close();});
