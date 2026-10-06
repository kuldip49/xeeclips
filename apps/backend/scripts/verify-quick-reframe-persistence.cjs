/**
 * Run after `docker restart ai-content-backend` with a disposable exported session kept by
 * `KEEP=1 node scripts/verify-quick-reframe-v2.cjs ...`:  REFRAME_LIVE_ID=<id> node scripts/verify-quick-reframe-persistence.cjs
 * Checks the confirmed crop, editing path, export currency, History and ranged playback survive a restart;
 * REFRAME_DELETE=true then deletes the session and checks every owned file is gone.
 */
const assert=require('node:assert/strict');
async function main(){
  const id=process.env.REFRAME_LIVE_ID;assert.ok(id,'Set REFRAME_LIVE_ID');
  const base=process.env.API_BASE||'http://127.0.0.1:4000';
  const s=await (await fetch(`${base}/quick-reframe/${id}`)).json();
  assert.equal(s.cropConfirmed,true,'confirmed crop survives');assert.ok(s.confirmed?.crop,'confirmed preparation stored');
  assert.ok(['STYLEONE','MANUAL'].includes(s.editPath),'editing path survives');
  assert.ok(s.exports.length>0,'export kept');
  const project=await (await fetch(`${base}/edit-mode/projects/${s.editProjectId}`)).json();
  const original=project.assets.find(a=>a.metadata?.quickReframeKind==='ORIGINAL');
  const history=await (await fetch(`${base}/quick-reframe/history`)).json();assert.ok(history.some(i=>i.id===s.id),'still in History');
  const editorList=await (await fetch(`${base}/edit-mode/projects`)).json();assert.ok(!editorList.some(p=>p.id===s.editProjectId),'not a visible editor project');
  for(const url of [s.exports[0].url,s.sourceUrl,s.originalUrl]){const file=await fetch(base+url,{headers:{Range:'bytes=0-999'}});assert.equal(file.status,206,url);await file.arrayBuffer();}
  if(process.env.REFRAME_DELETE==='true'){
    assert.equal((await fetch(`${base}/quick-reframe/${s.id}`,{method:'DELETE'})).status,200);
    assert.equal((await fetch(`${base}/quick-reframe/${s.id}`)).status,404);
    for(const url of [s.exports[0].url,s.sourceUrl,...(original?[`/edit-mode/assets/${original.id}/file`]:[])])assert.equal((await fetch(base+url)).status,404,url);
    console.log('Restart: confirmed crop, path, export, History and ranged playback persisted; owned deletion removed export, cropped source and original: PASS');
  }else console.log(`Restart: confirmed crop, ${s.editPath} path, ${s.exports.length} export(s), History, hidden from editor list and ranged playback persisted: PASS`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
