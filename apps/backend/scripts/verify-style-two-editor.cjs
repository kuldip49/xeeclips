// Mounts the actual interactive EditPreview with a local canonical fixture.
// No application backend, database, authentication changes or production access.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../..'),out=path.join(root,'.real-qa-preview/style-two/editor');
fs.mkdirSync(out,{recursive:true});
const loader=path.join(out,'typescript-loader.cjs');
fs.writeFileSync(loader,`module.exports=function(source){return require(${JSON.stringify(require.resolve('typescript'))}).transpileModule(source,{compilerOptions:{jsx:4,module:99,target:9,esModuleInterop:true}}).outputText;};`);
const entry=path.join(out,'entry.tsx');
fs.writeFileSync(entry,`import React from 'react';import {createRoot} from 'react-dom/client';
import {EditPreview} from ${JSON.stringify(path.join(root,'apps/frontend/src/components/edit-mode/edit-preview.tsx').replaceAll('\\','/'))};
fetch('/project.json').then(r=>r.json()).then(project=>{
const mount=(t)=>createRoot(document.getElementById('app')).render(<EditPreview source={project.assets.find(a=>a.role==='SOURCE')} assets={project.assets}
aspectRatio='9:16' reframePolicy={project.settings.reframePolicy} resolvedVisualLayout={project.settings.resolvedVisualLayout}
elements={project.elements} selectedElementId={null} currentPlayheadSec={t} onPlayheadChange={()=>{}} onSelect={()=>{}} onPreviewElements={()=>{}} onCommitTransform={()=>{}}/>);
mount(Number(new URL(location.href).searchParams.get('t')||1));});`);
const css=fs.readdirSync(path.join(root,'apps/frontend/.next/static/css')).find(f=>f.endsWith('.css'));
const html='<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}</style><div id="app"></div><script src="/bundle.js"></script>';
const projectFile=path.join(root,'.real-qa-preview/style-two/current/styletwo-project.json');
const sourceFile=path.join(root,'.real-qa-preview/style-two/reference-footage.mp4');
const server=http.createServer((req,res)=>{
 let file,mime;
 if(req.url.startsWith('/project.json')){file=projectFile;mime='application/json';}
 else if(req.url==='/bundle.js'){file=path.join(out,'bundle.js');mime='application/javascript';}
 else if(req.url==='/style.css'){file=path.join(root,'apps/frontend/.next/static/css',css);mime='text/css';}
 else if(req.url.includes('/edit-mode/assets/')){file=sourceFile;mime='video/mp4';}
 else if(req.url.startsWith('/fonts/')){file=path.join(root,'apps/frontend/public',req.url);mime='font/ttf';}
 else if(req.url==='/'||req.url.startsWith('/?')){res.setHeader('Content-Type','text/html');res.end(html);return;}
 else {res.statusCode=404;res.end();return;}
 if(!fs.existsSync(file)){res.statusCode=404;res.end();return;}
 const bytes=fs.readFileSync(file);res.setHeader('Content-Type',mime);res.setHeader('Access-Control-Allow-Origin','*');
 const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');
 if(range){const start=Number(range[1]),end=range[2]?Number(range[2]):bytes.length-1;
 res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':end-start+1,'Accept-Ranges':'bytes'});res.end(bytes.subarray(start,end+1));}
 else {res.setHeader('Content-Length',bytes.length);res.end(bytes);}
});
async function main(){
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}`;
 const packaged=require('next/dist/compiled/webpack/webpack');packaged.init();const webpack=packaged.webpack;
 await new Promise((resolve,reject)=>webpack({mode:'development',devtool:false,entry,output:{path:out,filename:'bundle.js'},
 resolve:{extensions:['.tsx','.ts','.js','.cjs','.json'],alias:{'@':path.join(root,'apps/frontend/src')}},
 module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:loader}]},
 plugins:[new webpack.DefinePlugin({'process.env.NEXT_PUBLIC_API_URL':JSON.stringify(url)})]},(error,stats)=>{
 if(error||stats.hasErrors())reject(error||new Error(stats.toString({all:false,errors:true})));else resolve();}));
 const {chromium}=require('@playwright/test');const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
 const evidence=[];
 for(const [name,width,height] of [['desktop',1200,2100],['mobile',390,844]]){
 const page=await browser.newPage({viewport:{width,height}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${url}/?t=1`);
 const canvas=page.getByTestId('edit-preview-canvas');
 await page.waitForFunction(()=>document.querySelector('[data-testid="edit-preview-video"]')?.getAttribute('data-media-state')==='READY');
 await page.waitForFunction(()=>{const v=document.querySelector('video');return v&&v.readyState>=2&&Math.abs(v.currentTime-1)<.1;});
 assert.equal(await canvas.getAttribute('data-view-mode'),'FIT');
 assert.equal(await canvas.evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(255, 255, 255)');
 const bounds=await canvas.boundingBox();assert(Math.abs(bounds.width/bounds.height-9/16)<.002);
 assert((await page.locator('[data-testid="style-two-text"]').count())>=1);
 await canvas.screenshot({path:path.join(out,`${name}.png`)});
 await page.screenshot({path:path.join(out,`${name}-workspace.png`)});
 evidence.push({name,bounds,errors});assert.deepEqual(errors,[]);await page.close();
 }
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(evidence,null,2));console.log(`Actual desktop/mobile EditPreview mounted, video sought, proportional white canvas and vector text: PASS (${out})`);
 }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());
