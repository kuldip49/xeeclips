// Build the complete reviewed backend/shared code on the verified runtime/dependency image.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'.cache/xeeclip-v1-release'),context=path.join(dir,'image');fs.mkdirSync(context,{recursive:true});
const run=(command,args)=>execFileSync(command,args,{cwd:root,encoding:'utf8',maxBuffer:64<<20});
const commit=run('git',['rev-parse','HEAD']).trim();
assert.equal(run('git',['diff','791547e','HEAD','--','package-lock.json','apps/backend/package.json','packages/shared/package.json','apps/ai-service']).trim(),'','Dependencies and AI runtime must stay unchanged');
const manifest=[];
for(const relative of ['apps/backend/src','apps/backend/prisma','apps/backend/scripts','packages/shared/src','packages/shared/dist','packages/shared/package.json','packages/shared/tsconfig.json']){
 const target=path.join(context,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.cpSync(path.join(root,relative),target,{recursive:true});
 const walk=p=>{if(fs.statSync(p).isDirectory())for(const name of fs.readdirSync(p))walk(path.join(p,name));else manifest.push({path:path.relative(context,p).replaceAll('\\','/'),sha256:createHash('sha256').update(fs.readFileSync(p)).digest('hex')});};walk(target);
}
const baseline='sha256:804f1ab4879fa2e41063455086cb8d4c634db2f73c67288d4d1fdc1d9f46e708';
assert.equal(JSON.parse(run('docker',['image','inspect','xeeclip-backend:result-flow-791547e']))[0].Id,baseline);
fs.writeFileSync(path.join(context,'Dockerfile'),`FROM xeeclip-backend:result-flow-791547e\nCOPY apps/backend/ /app/apps/backend/\nCOPY packages/shared/ /app/packages/shared/\nWORKDIR /app\nRUN npm --workspace packages/shared run build && npm --workspace apps/backend run prisma:generate && npm --workspace apps/backend run build\nWORKDIR /app/apps/backend\nARG RELEASE_COMMIT\nLABEL org.opencontainers.image.revision=$RELEASE_COMMIT\n`);
const tag='xeeclip-backend:xeeclip-v1-'+commit.slice(0,7);
execFileSync('docker',['build','--build-arg','RELEASE_COMMIT='+commit,'-t',tag,context],{cwd:root,stdio:'inherit'});
const image=JSON.parse(run('docker',['image','inspect',tag]))[0];
fs.writeFileSync(path.join(dir,'candidate.json'),JSON.stringify({commit,tag,backendImage:image.Id,baseline,manifest,sourceClean:run('git',['status','--porcelain']).trim()==='',migrations:['20261017000000_clipper_workspace_v1','20261018000000_clipper_backend_hardening']},null,2));
console.log('Backend candidate built: '+tag);
