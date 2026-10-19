// Read-only production backup, isolated restore, and additive campaign SQL rehearsal.
// Never points a migration command at production. Run before the gated cutover.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'.cache/xeeclip-v1-release');
fs.mkdirSync(dir,{recursive:true});
const run=(args,input)=>execFileSync('docker',args,{encoding:'utf8',input,maxBuffer:64<<20});
const save=(name,value)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(value,null,2));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const migrations=['20261017000000_clipper_workspace_v1','20261018000000_clipper_backend_hardening'];
const fingerprintSql=`DO $$ DECLARE t record; n bigint; h text; BEGIN
 CREATE TEMP TABLE release_fingerprints(name text,n bigint,hash text);
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename LOOP
 EXECUTE format('SELECT count(*), md5(coalesce(string_agg(row_hash, '''' ORDER BY row_hash), '''')) FROM (SELECT md5(row_to_json(r)::text) row_hash FROM %I r) s',t.tablename) INTO n,h;
 INSERT INTO release_fingerprints VALUES(t.tablename,n,h);
 END LOOP; END $$;
 SELECT coalesce(json_agg(f ORDER BY name),'[]') FROM release_fingerprints f;`;
function fingerprints(container,user,database){const out=run(['exec','-i',container,'psql','-U',user,'-d',database,'-Atq','-v','ON_ERROR_STOP=1'],fingerprintSql);return JSON.parse(out.trim());}
async function main(){
 const names=['ai-content-backend','ai-content-ai-service','ai-content-postgres','ai-content-redis','ai-content-minio','ai-content-frontend'];
 const live=JSON.parse(run(['inspect',...names]));assert(live.every(c=>c.State.Running),'Production containers must be running');
 const backend=live.find(c=>c.Name==='/ai-content-backend');
 const env=Object.fromEntries(backend.Config.Env.map(v=>{const i=v.indexOf('=');return[v.slice(0,i),v.slice(i+1)];}));
 const url=new URL(env.DATABASE_URL);assert.equal(url.hostname,'postgres');
 const user=decodeURIComponent(url.username),database=decodeURIComponent(url.pathname.slice(1));
 assert.equal(database,'ai_content_platform');
 const stamp=Date.now(),dump=path.join(dir,`production-${stamp}.dump`),tmp=`/tmp/xeeclip-v1-${stamp}.dump`;
 save('production-containers.private.json',live);
 fs.copyFileSync('C:/projects/ai-content-platform/.env',path.join(dir,'production-env.private'));
 fs.copyFileSync('C:/Users/kuldi/.cloudflared/config.yml',path.join(dir,'production-tunnel.private'));
 run(['image','tag',backend.Image,'xeeclip-backend-rollback:before-xeeclip-v1']);
 const before=fingerprints('ai-content-postgres',user,database);save('production-fingerprints.json',before);
 run(['exec','ai-content-postgres','pg_dump','-U',user,'-d',database,'-Fc','-f',tmp]);
 run(['cp','ai-content-postgres:'+tmp,dump]);run(['exec','ai-content-postgres','rm','-f',tmp]);
 const name='xeeclip-v1-restore-'+stamp;
 const id=run(['run','-d','--name',name,'--label','xeeclip.release=xeeclip-v1','--network','none','--tmpfs','/var/lib/postgresql/data','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16-alpine']).trim();
 try{
  let ready=false;for(let i=0;i<40;i++){try{run(['exec',id,'pg_isready','-U','postgres']);ready=true;break;}catch{}await pause(1000);}assert(ready);
  run(['cp',dump,id+':/tmp/backup.dump']);run(['exec',id,'createdb','-U','postgres','restorecheck']);
  run(['exec',id,'pg_restore','-U','postgres','-d','restorecheck','--no-owner','--no-privileges','--exit-on-error','--single-transaction','/tmp/backup.dump']);
  const restored=fingerprints(id,'postgres','restorecheck');assert.deepEqual(restored,before,'Restored production rows differ');
  const sql=migrations.map(m=>fs.readFileSync(path.join(root,'apps/backend/prisma/migrations',m,'migration.sql'),'utf8'));
  assert(sql.every(s=>!/^\s*(DROP|TRUNCATE|DELETE|UPDATE)\b/im.test(s)),'Only reviewed additive SQL is allowed');
  run(['exec','-i',id,'psql','-U','postgres','-d','restorecheck','-1','-v','ON_ERROR_STOP=1'],sql.join('\n'));
  const after=fingerprints(id,'postgres','restorecheck');
  assert.deepEqual(after.filter(t=>before.some(v=>v.name===t.name)),before,'Migration changed existing production rows');
  assert.equal(after.filter(t=>t.name.startsWith('Campaign')).length,7);
  assert(after.filter(t=>t.name.startsWith('Campaign')).every(t=>t.n===0));
  const checks=run(['exec',id,'psql','-U','postgres','-d','restorecheck','-At','-c',`SELECT count(*) FROM pg_constraint WHERE conname LIKE 'Campaign%_check'`]).trim();assert.equal(checks,'17');
  save('backup.json',{verified:true,migrationRehearsal:true,at:new Date().toISOString(),path:dump,bytes:fs.statSync(dump).size,sha256:createHash('sha256').update(fs.readFileSync(dump)).digest('hex'),tablesRestored:before.length,legacyRows:before.reduce((n,t)=>n+Number(t.n),0),existingFingerprintsPreserved:true,newEmptyTables:7,checks:17,migrations,rollbackBackend:backend.Image,rollbackTag:'xeeclip-backend-rollback:before-xeeclip-v1'});
  console.log('PASS production database backup restored in network-isolated PostgreSQL; both additive migrations preserve every existing table fingerprint.');
 }finally{assert.equal(JSON.parse(run(['inspect',id]))[0].Config.Labels['xeeclip.release'],'xeeclip-v1');run(['stop',id]);run(['rm',id]);}
}
module.exports={fingerprints,fingerprintSql};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
