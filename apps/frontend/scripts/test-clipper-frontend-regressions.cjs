const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..'),dir=path.join(root,'.cache/clipper-frontend/final');fs.mkdirSync(dir,{recursive:true});
const suites=['test-ai-mode-ui','test-clip-creation-ui','test-timeline-virtualization','test-timeline-ux','test-templates-ui','test-chat-ui','test-review-brief-ui','test-campaign-routes'];
const results=suites.map(suite=>{const r=spawnSync(process.execPath,[path.join(__dirname,suite+'.cjs')],{cwd:path.join(root,'apps/frontend'),encoding:'utf8'});fs.writeFileSync(path.join(dir,suite+'.log'),(r.stdout||'')+(r.stderr||''));console.log(suite+': '+(r.status===0?'PASS':'FAIL'));return {suite,status:r.status,summary:(r.stdout||'').trim().split('\n').at(-1)};});
fs.writeFileSync(path.join(dir,'regressions.json'),JSON.stringify(results,null,2));process.exitCode=results.some(r=>r.status!==0)?1:0;
