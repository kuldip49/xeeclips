// Reuse the reviewed hardening acceptance with a fresh, release-only Docker project.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),scripts=path.join(root,'apps/backend/scripts');
const qa=path.join(root,'.cache/clipper-hardening/qa');fs.mkdirSync(qa,{recursive:true});
const prepare=fs.readFileSync(path.join(scripts,'prepare-campaign-hardening-qa.cjs'),'utf8').replaceAll('clipper-backend-hardening','xeeclip-v1-acceptance');
new Function('require','__dirname',prepare)(require,scripts);
const verifier=fs.readFileSync(path.join(scripts,'verify-campaign-hardening-media.cjs'),'utf8')
 .replace("path.resolve(__dirname,'../../..')",JSON.stringify(root))
 .replaceAll('clipper-backend-hardening','xeeclip-v1-acceptance');
fs.writeFileSync(path.join(qa,'verify-release-media.cjs'),verifier);
console.log('Release QA project: xeeclip-v1-acceptance. Production is not a target.');
