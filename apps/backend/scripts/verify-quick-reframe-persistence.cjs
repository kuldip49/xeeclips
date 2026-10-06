/** Run after `docker compose restart backend`; checks only the disposable retained speech fixture. */
const assert=require('node:assert/strict');
const {readFile}=require('node:fs/promises');
async function main(){
  const kept=JSON.parse(await readFile('/tmp/quick-reframe-persistence.json','utf8'));
  const base='http://127.0.0.1:4000';
  const s=await (await fetch(base+'/quick-reframe/'+kept.id)).json();
  assert.equal(s.exportUrl,kept.exportUrl);assert.equal(s.status,'COMPLETE');assert.ok(s.plan.captions.cues.length);
  assert.ok(s.cleanUrl);assert.equal(s.previewRevision,s.revision);assert.equal(s.exportRevision,s.revision);
  const history=await (await fetch(base+'/quick-reframe/history')).json();assert.ok(history.some(i=>i.id===s.id));
  const file=await fetch(base+s.exportUrl,{headers:{Range:'bytes=0-999'}});assert.equal(file.status,206);await file.arrayBuffer();
  if(process.env.REFRAME_DELETE==='true'){
    assert.equal((await fetch(base+'/quick-reframe/'+s.id,{method:'DELETE'})).status,200);
    assert.equal((await fetch(base+'/quick-reframe/'+s.id)).status,404);
    assert.equal((await fetch(base+s.exportUrl)).status,404);
    assert.equal((await fetch(base+s.sourceUrl)).status,404);
    assert.equal((await fetch(base+s.cleanUrl)).status,404);
    console.log('Backend restart, persisted History/plan, ranged export, owned deletion and missing source/output: PASS');
  }else console.log('Backend restart, persisted History/plan and ranged export: PASS');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
