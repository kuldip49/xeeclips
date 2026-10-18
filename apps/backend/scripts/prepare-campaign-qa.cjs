// Builds only the isolated QA image. Run the SQL preview review before starting its Compose stack.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');const root=path.resolve(__dirname,'../../..'),context=root+'/.cache/clippers/build';fs.mkdirSync(context,{recursive:true});fs.mkdirSync(root+'/.cache/clippers/qa',{recursive:true});
fs.cpSync(root+'/apps/backend/prisma',context+'/prisma',{recursive:true});
fs.writeFileSync(context+'/Dockerfile','FROM xeeclip-backend:result-flow-791547e\nWORKDIR /app/apps/backend\nCOPY prisma ./prisma\nRUN npx prisma generate --schema prisma/schema.prisma\n');
if(!fs.existsSync(root+'/.cache/clippers/qa/provider-state.json'))fs.writeFileSync(root+'/.cache/clippers/qa/provider-state.json',JSON.stringify({busy:false,freeAttempts:0,proCalls:0,transportAttempts:0}));
execFileSync('docker',['build','--tag','xeeclip-backend:clipper-v1-qa',context],{stdio:'inherit'});
