// Loopback TLS proxy preserves real multipart/video streams during browser acceptance.
// Chrome resolves clipper-api.invalid locally only in the disposable QA browser.
const https=require('node:https'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const dir=path.resolve(__dirname,'../.cache/xeeclip-v1-release');
https.createServer({key:fs.readFileSync(path.join(dir,'qa-key.pem')),cert:fs.readFileSync(path.join(dir,'qa-cert.pem'))},(req,res)=>{
 const upstream=http.request({hostname:'127.0.0.1',port:4300,path:req.url,method:req.method,headers:{...req.headers,host:'localhost:4300',origin:'http://localhost:3300'}},r=>{
  res.writeHead(r.statusCode,{...r.headers,'access-control-allow-origin':'http://localhost:3301','access-control-allow-credentials':'true'});r.pipe(res);
 });
 upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Disposable QA API unavailable');});req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
}).listen(443,'127.0.0.1',()=>console.log('Disposable QA TLS proxy listening on loopback 443'));
