// Local regressions only. Separate processes keep test fixture environments isolated.
const {spawn} = require('node:child_process');
const {mkdirSync,writeFileSync} = require('node:fs');
const {resolve} = require('node:path');
const root=resolve(__dirname,'../../..'),out=resolve(root,'.real-qa-preview/content-intelligence-v2');
mkdirSync(out,{recursive:true});
const tests=['test-content-intelligence','test-content-intelligence-v2','test-clip-boundary-optimizer','test-clip-boundary-continuation',
  'test-content-package','test-content-packaging-phase','test-style-two','test-style-two-crop','test-style-two-zoom',
  'test-automatic-2-camera','test-automatic-2-reliability','test-quick-reframe','test-quick-reframe-styleone',
  'test-quick-reframe-styletwo','test-quick-reframe-post-copy','test-edit-mode-chat','test-edit-mode-presets',
  'test-generated-clip-edit-project','test-generated-clip-edit-plan-reconstruction','test-clip-selection-flow',
  'test-style-readiness','test-clip-export','test-hook-plate-lengths','test-ai-service-http',
  'test-creative-hook-pipeline','test-ending-asr-uncertainty','test-ending-eof-and-strong-tail'];
async function run(test){
  const started=Date.now();return new Promise(resolveResult=>{
    const p=spawn(process.execPath,[resolve(__dirname,test+'.cjs')],{cwd:root,windowsHide:true,env:{...process.env,
      PATH:resolve(root,'.cache/ffmpeg-benchmark/ffmpeg-9.0.2-essentials_build/bin')+';'+process.env.PATH}});
    let log='';p.stdout.on('data',x=>log+=x);p.stderr.on('data',x=>log+=x);
    p.on('error',e=>{log+=e.message;});
    p.on('close',code=>{writeFileSync(resolve(out,test+'.log'),log);resolveResult({test,code,durationMs:Date.now()-started,skipped:/\bSKIP\b/u.test(log),failure:code?log.slice(-5000):undefined});});
  });
}
async function main(){
  let cursor=0;const results=[];
  await Promise.all(Array.from({length:3},async()=>{while(cursor<tests.length){const test=tests[cursor++];const r=await run(test);results.push(r);console.log(`${r.code?'FAIL':'PASS'} ${test}${r.skipped?' (contains skip)':''}`);}}));
  writeFileSync(resolve(out,'regressions.json'),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2));
  const failures=results.filter(r=>r.code);console.log(JSON.stringify({passed:results.length-failures.length,failures},null,2));
  if(failures.length)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
