const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{const source=fs.readFileSync(path.join(__dirname,'../cloudflare/router.mjs'),'utf8'),router=(await import('data:text/javascript,'+encodeURIComponent(source))).default;
 const cases=[['/clippers/campaigns/owned','/clippers/campaigns/_'],['/clippers/campaigns/owned.txt','/clippers/campaigns/_.txt'],['/clippers/campaigns/new','/clippers/campaigns/new'],['/clippers/campaigns/new.txt','/clippers/campaigns/new.txt'],['/clippers/assets','/clippers/assets'],['/edit-mode/owned','/edit-mode/_'],['/projects/owned','/projects/_']];
 for(const [input,expected]of cases){let target;await router.fetch(new Request('https://local.invalid'+input+'?test=1'),{ASSETS:{fetch(request){target=new URL(request.url);return new Response('ok');}}});assert.equal(target.pathname,expected);assert.equal(target.search,'?test=1');}
 console.log('Campaign static routing passed: '+cases.length+' checks');
})().catch(e=>{console.error(e);process.exitCode=1});
