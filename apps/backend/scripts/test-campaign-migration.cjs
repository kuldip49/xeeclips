// Run inside the dedicated QA container, first against legacy_template, then its restored copy.
const fs=require('node:fs'),assert=require('node:assert/strict'),{createHash}=require('node:crypto'),{PrismaClient}=require('@prisma/client');
const db=new PrismaClient(),file='/qa/legacy-fingerprint.json';
async function fingerprint(){const result={};for(const model of ['user','project','video','processingJob','generatedClip','editProject'])result[model]=await db[model].findMany({where:{id:{startsWith:'legacy-'}},orderBy:{id:'asc'}});return createHash('sha256').update(JSON.stringify(result,(_key,value)=>typeof value==='bigint'?String(value):value)).digest('hex');}
(async()=>{assert(new URL(process.env.DATABASE_URL).hostname==='postgres'&&/clipper_(legacy_template|backend_hardening)$/.test(new URL(process.env.DATABASE_URL).pathname));
 if(process.argv.includes('--seed')){
  await db.user.create({data:{id:'legacy-user',email:'legacy-fixture@example.invalid',passwordHash:'not-an-authentication-fixture'}});await db.project.create({data:{id:'legacy-project',userId:'legacy-user',name:'Existing user project'}});
  await db.video.create({data:{id:'legacy-video',projectId:'legacy-project',bucket:'isolated-only',objectKey:'legacy-source',originalName:'Existing source.mp4',mimeType:'video/mp4',sizeBytes:100n,duration:90}});await db.processingJob.create({data:{id:'legacy-job',videoId:'legacy-video',status:'COMPLETED',aiMode:'FALLBACK_ONLY'}});
  await db.generatedClip.create({data:{id:'legacy-clip',videoId:'legacy-video',rangeKey:'0:20',variantKey:'legacy',startTime:0,endTime:20,duration:20,bucket:'isolated-only',objectKey:'legacy-render',mimeType:'video/mp4',sizeBytes:100n,width:720,height:1280,codec:'h264'}});await db.editProject.create({data:{id:'legacy-editor',userId:'legacy-user',name:'Existing canonical editor',generatedClipId:'legacy-clip',revision:4,settings:{aspectRatio:'9:16'}}});
  fs.writeFileSync(file,JSON.stringify({fingerprint:await fingerprint()}));console.log('PRE_CLIPPER_FIXTURE_SEEDED');return;
 }
 assert.equal(await fingerprint(),JSON.parse(fs.readFileSync(file)).fingerprint,'legacy rows remain byte-equivalent');
 const constraints=await db.$queryRaw`SELECT conname FROM pg_constraint WHERE conname LIKE 'Campaign%_check'`;
 assert.equal(constraints.length,17);const foreign=await db.$queryRaw`SELECT conname FROM pg_constraint WHERE contype='f' AND conrelid IN (SELECT oid FROM pg_class WHERE relname IN ('Campaign','CampaignBrief','CampaignAsset','CampaignSource','CampaignRun','CampaignClip','CampaignPost'))`;assert.equal(foreign.length,13);
 for(const statement of [`INSERT INTO "Campaign" (id,"userId","projectId",name,status,"updatedAt") VALUES ('bad-state','legacy-user','legacy-project','Invalid','INVALID',now())`,`INSERT INTO "Campaign" (id,"userId","projectId",name,"defaultClipCount","updatedAt") VALUES ('bad-count','legacy-user','legacy-project','Invalid',0,now())`])await assert.rejects(()=>db.$executeRawUnsafe(statement));
 fs.writeFileSync('/qa/migration-result.json',JSON.stringify({status:'PASS',legacyFingerprintPreserved:true,checkConstraints:constraints.length,foreignKeys:foreign.length},null,2));console.log('CAMPAIGN_MIGRATION_COPY_PASSED');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());
