// Local asset-only acceptance server. No Next.js server, SSR or Cloudflare Worker runs here.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../out'),port=3301;
if(!fs.existsSync(path.join(root,'index.html')))throw Error('Build the static frontend first.');
const mime={'.html':'text/html','.txt':'text/plain','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2','.mp4':'video/mp4'};
http.createServer((req,res)=>{
 try{
  let url=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  // Preserve legacy editor/project static shells; Clippers exercises only asset SPA fallback.
  url=url.replace(/^\/(edit-mode|projects)\/[^/]+?(\.txt)?\/?$/,(_all,kind,extension)=>`/${kind}/_${extension||''}`);
  let target=path.resolve(root,'.'+url);if(target!==root&&!target.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  const candidates=[target,path.join(target,'index.html'),target+'.html'];target=candidates.find(f=>fs.existsSync(f)&&fs.statSync(f).isFile());
  if(!target&&req.headers.accept?.includes('text/html'))target=path.join(root,'index.html');
  if(!target){res.writeHead(404).end('Not found');return;}
  const stat=fs.statSync(target);res.writeHead(200,{'content-type':mime[path.extname(target)]||'application/octet-stream','content-length':stat.size,'cache-control':'no-store'});fs.createReadStream(target).pipe(res);
 }catch{res.writeHead(400).end('Invalid path');}
}).listen(port,'127.0.0.1',()=>console.log(`Static frontend QA: http://127.0.0.1:${port}`));
