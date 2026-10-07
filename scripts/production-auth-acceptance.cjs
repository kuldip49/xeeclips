// Explicitly requested live acceptance. Uses disposable accounts and local QA media only.
// No trace/video recording: login credentials never appear in artifacts or logs.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { join } = require('node:path');
const root = join(__dirname, '..'), folder = join(root, 'storage/security-backups');
const statePath = join(folder, 'production-test-state.json');
const config = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/).filter(v => /^[A-Z_]+=/.test(v)).map(v => { const i = v.indexOf('='); return [v.slice(0,i), v.slice(i+1).replace(/^(['"])(.*)\1$/, '$2')]; }));
const origin = 'https://xeeclip.me', api = 'https://api.xeeclip.me';
config.ADMIN_INITIAL_PASSWORD ||= readFileSync(join(folder, 'owner-login.txt'),'utf8').match(/^Initial password: (.+)$/m)?.[1];
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath,'utf8')) : { prefix: 'security-' + Date.now(), password: randomBytes(24).toString('base64url') };
const save = () => writeFileSync(statePath, JSON.stringify(state)); save();
const delay = ms => new Promise(r => setTimeout(r, ms));
let browser; const results = [];
function pass(name) { results.push(name); console.log('PASS', name); writeFileSync(join(folder,'production-results.json'), JSON.stringify({ results, completed: false },null,2)); }
async function call(ctx, path, method='GET', body, extra={}) {
  const res = await ctx.request.fetch(api + path, { method, headers: { Origin: origin }, ...(body === undefined ? {} : { data: body }), timeout: 60000, ...extra });
  return { status: res.status(), body: await res.json().catch(()=>null), res };
}
async function good(ctx,path,method='GET',body,extra={}) { const r=await call(ctx,path,method,body,extra); if(r.status>=400) throw new Error(`${method} ${path}: HTTP ${r.status} ${r.body?.code || r.body?.message || ''}`); return r.body; }
async function poll(label, fn, done, timeout=600000) {
  const until=Date.now()+timeout; let last;
  while(Date.now()<until) { last=await fn(); if(done(last)) return last; await delay(4000); }
  throw new Error(label+' timed out (status '+String(last?.status || last?.phase)+')');
}
async function account(ctx,page,email,signup) {
  await page.goto(origin+(signup?'/signup':'/login'),{waitUntil:'domcontentloaded'});
  await page.getByLabel('Email',{exact:true}).fill(email);
  await page.getByLabel('Password').fill(signup?state.password:email===config.ADMIN_EMAIL?config.ADMIN_INITIAL_PASSWORD:state.password);
  if(signup) await page.getByLabel('Name',{exact:true}).fill('Disposable security test');
  await page.getByRole('button',{name:signup?'Create account':'Log in',exact:true}).click();
  await page.waitForURL(origin+'/',{timeout:45000});
  return good(ctx,'/auth/session');
}
async function main() {
  browser=await chromium.launch({headless:true,channel:'chrome'});
  const owner=await browser.newContext(), a=await browser.newContext({viewport:{width:390,height:844}}), b=await browser.newContext();
  const op=await owner.newPage(), ap=await a.newPage(), bp=await b.newPage();
  await ap.goto(origin); await ap.getByRole('link',{name:'Create account',exact:true}).waitFor(); pass('public landing with login and signup');
  const admin=await account(owner,op,config.ADMIN_EMAIL,false); assert.equal(admin.role,'ADMIN');
  await op.getByRole('link',{name:'Admin',exact:true}).click(); await op.getByRole('heading',{name:'Admin',exact:true}).waitFor();
  const stats=await good(owner,'/admin/stats'); assert.ok(stats.clips>=162); await op.getByText('Total users',{exact:true}).waitFor();
  await op.screenshot({path:join(folder,'admin-dashboard.png'),fullPage:true}); pass('owner production browser login, secure cookie, admin navigation and real statistics');
  const cookies=await owner.cookies(api); const cookie=cookies.find(c=>c.name==='__Host-xeeclip-session'); assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite==='Lax');
  state.aEmail ||= state.prefix+'-a@example.com'; state.bEmail ||= state.prefix+'-b@example.com';
  const ua=await account(a,ap,state.aEmail,!state.aId); state.aId=ua.id; save();
  const ub=await account(b,bp,state.bEmail,!state.bId); state.bId=ub.id; save();
  assert.equal(ua.role,'USER'); assert.equal(ub.role,'USER');
  const width=await ap.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth})); assert.ok(width.scroll<=width.width+1);
  assert.equal(await ap.getByRole('link',{name:'Admin',exact:true}).count(),0);
  assert.equal((await call(a,'/admin/stats')).status,403);
  await ap.goto(origin+'/admin'); await ap.getByText('Administrator access required.').waitFor();
  assert.deepEqual(await good(b,'/history/clips'),[]); pass('mobile signup, ordinary-user admin denial and no legacy History exposure');
  state.projectId ||= (await good(a,'/projects','POST',{name:'Disposable production security acceptance'})).id; save();
  assert.equal((await call(b,'/projects/'+state.projectId)).status,404);
  if(!state.videoId) {
    const uploaded=await good(a,'/projects/'+state.projectId+'/videos','POST',undefined,{multipart:{file:{name:'security-acceptance.mp4',mimeType:'video/mp4',buffer:readFileSync(join(root,'.real-qa-preview/reference-qa.mp4'))},aiMode:'FALLBACK_ONLY',processingType:'NORMAL_CLIPS',aspectRatio:'9:16',targetPlatform:'YOUTUBE_SHORTS'}});
    state.videoId=uploaded.id; save();
  }
  await poll('Source analysis',()=>good(a,'/videos'),v=>{const video=v.find(x=>x.id===state.videoId); if(video?.processingJobs?.[0]?.status==='FAILED') throw new Error('Source analysis failed: '+video.processingJobs[0].error); return video?.processingJobs?.[0]?.status==='COMPLETED';});
  assert.equal((await call(b,'/videos/'+state.videoId+'/file')).status,404);
  const sourceRange=await a.request.get(api+'/videos/'+state.videoId+'/file',{headers:{Origin:origin,Range:'bytes=0-99'}}); assert.equal(sourceRange.status(),206); assert.equal((await sourceRange.body()).length,100);
  pass('live owned upload/analysis, direct source IDOR denial and byte-range playback');
  await good(owner,'/admin/users/'+state.aId+'/credits','POST',{mode:'SET',amount:2,reason:'Disposable production acceptance allowance'});
  const generation={requestedClipCount:1,outputStyle:'NORMAL',regenerate:true};
  for(let i=1;i<=2;i++) {
    await good(a,'/videos/'+state.videoId+'/clip-selection','POST',generation);
    const delivered=await poll('Create Clips generation '+i,()=>good(a,'/videos/'+state.videoId+'/clip-results'),r=>{if(r.status==='FAILED'&&!r.clips?.length) throw new Error('Generation failed: '+r.error); return r.status==='COMPLETED'&&r.clips?.length>0;});
    const user=await good(a,'/auth/session'); assert.equal(user.creditBalance,2-i);
    state.clipId=delivered.clips[0].id; save(); pass('real generation '+i+' consumed one credit: '+(3-i)+' → '+(2-i));
  }
  const blocked=await call(a,'/videos/'+state.videoId+'/clip-selection','POST',generation); assert.equal(blocked.status,403); assert.equal(blocked.body.code,'NO_CREDITS');
  await ap.goto(origin+'/settings'); await ap.getByText('0 credits remaining',{exact:false}).waitFor({timeout:30000}); pass('third direct generation rejected at zero; browser balance displays zero');
  await good(owner,'/admin/users/'+state.aId+'/credits','POST',{mode:'ADD',amount:3,reason:'Disposable production acceptance refill'});
  await ap.getByText('3 credits remaining',{exact:false}).waitFor({timeout:30000});
  await good(a,'/videos/'+state.videoId+'/clip-selection','POST',generation);
  await poll('Refilled generation',()=>good(a,'/videos/'+state.videoId+'/clip-results'),r=>r.status==='COMPLETED'&&r.clips?.length>0); assert.equal((await good(a,'/auth/session')).creditBalance,2);
  pass('admin +3 appears through live polling; generation works again');
  const history=await good(a,'/history/clips'); assert.ok(history.length>0 && history.length<10); assert.deepEqual(await good(b,'/history/clips'),[]);
  assert.equal((await call(b,'/generated-clips/'+state.clipId+'/file')).status,404);
  const range=await a.request.get(api+'/generated-clips/'+state.clipId+'/file',{headers:{Origin:origin,Range:'bytes=0-99'}}); assert.equal(range.status(),206);
  // Browser's cross-origin video element must send its API-host cookie and decode the media.
  await ap.goto(origin+'/history');
  await ap.evaluate(url => { const video=document.createElement('video'); video.dataset.securityTest='true'; video.crossOrigin='use-credentials'; video.preload='metadata'; video.src=url; document.body.append(video); video.load(); },api+'/generated-clips/'+state.clipId+'/file');
  await poll('Browser video metadata',()=>ap.locator('video[data-security-test]').evaluate(v=>v.readyState),r=>r>=1,45000);
  await ap.locator('video[data-security-test]').evaluate(v=>v.remove());
  pass('per-user production History, clip IDOR denial, range media and browser decoding');
  const detail=await good(owner,'/admin/users/'+state.aId); assert.ok(detail.audit.length>=2); assert.equal(detail.ledger.reduce((sum,t)=>sum+t.amount,0),2);
  await op.goto(origin+'/admin/users'); await op.getByRole('heading',{name:'Users',exact:true}).waitFor(); pass('admin users, ledger reconciliation and credit audit');
  await good(a,'/auth/logout','POST'); assert.equal((await call(a,'/history/clips')).status,401);
  await ap.goto(origin+'/history'); await ap.waitForURL(/\/login/); await ap.goBack(); assert.equal(await ap.locator('video').count(),0); pass('logout revokes API session and back navigation hides private media');
  await good(owner,'/auth/logout','POST'); await good(b,'/auth/logout','POST');
  writeFileSync(join(folder,'production-results.json'),JSON.stringify({results,completed:true,frontendVersion:'dede0600-bb85-4699-bcb6-f91c8ed9f4d3'},null,2));
  console.log('Production acceptance passed; exact disposable IDs saved for cleanup.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>browser?.close());
