import {expect,test,type Page} from '@playwright/test';

test.setTimeout(90000);
test.use({actionTimeout:15000});
const api=process.env.E2E_API_URL??'http://localhost:4200';
const busyMessage='XeePro is busy right now. Try XeeFree or try again later.';
const now=new Date().toISOString();
function brief(){return {...Object.fromEntries(['targetPlatforms','requiredTopics','preferredTopics','forbiddenTopics','requiredKeywords','forbiddenKeywords','contentDo','contentDont','requiredHashtags','requiredMentions','unresolvedRules'].map(k=>[k,[]])),...Object.fromEntries(['requiredCTA','forbiddenCTA','hookRequirements','captionRequirements','brandingRequirements','musicRequirements','logoRequirements','postingRules','submissionRules','tone','audience','referenceStyleHints','requiredText','brandColor','deadlineText','payoutText','hashtagRequirements'].map(k=>[k,''])),minDurationSec:15,maxDurationSec:90,aspectRatio:'9:16',warnings:[],confidence:'EXPLICIT',assetInstructions:[]};}
async function fixture(page:Page,{busy=false,clips=false,admin=false}={}){
 const calls:any[]=[];let c:any={id:'campaign-fixture',projectId:'existing-project',name:'Argument campaign',description:'A campaign over the existing engine.',platforms:['TikTok'],status:'DRAFT',deadline:null,payoutDescription:'Recorded rewards',defaultClipCount:1,createdAt:now,brief:{campaignId:'campaign-fixture',version:1,sourceText:'',mode:'XEEFREE',confirmedByUser:false,data:brief()},assets:[],sources:[{id:'existing-source',videoId:'existing-video',video:{id:'existing-video',originalName:'Authorized conversation.mp4',processingJobs:[{status:'COMPLETED',error:null}]}}],runs:[],clips:[]};
 const result:any={id:'clip-fixture',campaignId:c.id,campaignName:c.name,title:'Arguments stand on their merits',mode:'XEEPRO',style:'STYLEONE',lifecycleStatus:'NEEDS_REVIEW',complianceStatus:'FAIL',complianceScore:80,compliance:{status:'FAIL',overallScore:80,checks:[{code:'LOGO',status:'FAIL',detail:'Required logo is missing.',fixable:true}]},socialPackage:{caption:'Arguments stand on their merits.',hashtags:['#Arguments'],requiredMentions:[],cta:'Learn more',postingNotes:'Review before posting',alternateCaptions:[]},previewUrl:null,downloadUrl:'/test-export.mp4',exportCurrent:true,editorUrl:'/edit-mode/existing-editor',post:null};
 if(clips){c.clips=[result];c.brief.confirmedByUser=true;c.status='ACTIVE';}
 const summary=()=>({activeCampaigns:c.status==='ACTIVE'?1:0,campaigns:1,clipsGenerated:c.clips.length,ready:c.clips.filter((x:any)=>x.lifecycleStatus==='READY').length,posted:c.clips.filter((x:any)=>x.post).length,totalViews:result.post?.views??0,totalEngagement:0,earningsByCurrency:result.post?{USD:result.post.earnings}:{},averageViews:null,bestClipId:result.post?result.id:null,bestCampaign:null,averageCampaignMatch:80});
 await page.route(`${api}/**`,async route=>{
  const request=route.request(),p=new URL(request.url()).pathname,method=request.method(),body=request.postDataJSON?.bind(request);let data:any={};
  const json=()=>{try{return body?.()??{};}catch{return {};}};
  if(p==='/auth/session')data={id:'owner',email:'owner@example.invalid',role:admin?'ADMIN':'USER',creditBalance:10,aiProcessingConsentAt:now};
  else if(p==='/videos/import-capabilities')data={xeeFree:true,xeePro:true};
  else if(p==='/videos'||p==='/history/clips')data=[];
  else if(p==='/campaigns/overview'||p.endsWith('/performance'))data=summary();
  else if(p==='/campaign-assets')data=c.assets;
  else if(p==='/campaign-clips')data=c.clips;
  else if(p==='/campaigns'&&method==='GET')data=[c];
  else if(p==='/campaigns'&&method==='POST'){c={...c,...json()};data=c;calls.push({p,method,body:json()});}
  else if(p.endsWith('/understand')){calls.push({p,method,body:json()});if(busy&&json().mode==='XEEPRO')return route.fulfill({status:503,json:{code:'XEEPRO_BUSY',message:busyMessage}});c.brief={...c.brief,sourceText:json().sourceText,mode:json().mode,version:c.brief.version+1,data:{...brief(),requiredTopics:['arguments']}};data={brief:c.brief,audit:{cloudLlmCalls:0}};}
  else if(p.endsWith('/confirm')){c.brief.confirmedByUser=true;c.status='ACTIVE';data=c.brief;calls.push({p,method,body:json()});}
  else if(p.endsWith('/brief')){c.brief={...c.brief,...json(),version:c.brief.version+1,confirmedByUser:false};data=c.brief;}
  else if(p.endsWith('/assets')&&method==='POST'){const a={id:'asset-'+c.assets.length,campaignId:c.id,type:'LOGO',fileName:'logo.png',mimeType:'image/png',label:'',required:false,intendedUse:'',fileUrl:'/test-logo.png',sizeBytes:100,metadata:{handling:'VERIFIED_MEDIA'},extractedTextAvailable:false};c.assets.push(a);c.brief.version++;data=a;calls.push({p,method});}
  else if(/\/assets\/asset-/.test(p)){Object.assign(c.assets.find((a:any)=>p.endsWith(a.id)),json());data={};}
  else if(p.endsWith('/generate')){calls.push({p,method,body:json()});c.runs=[{id:'run',mode:json().mode,style:json().style,status:busy?'FAILED':'COMPLETED',error:busy?busyMessage:null,errorCode:busy?'XEEPRO_BUSY':null}];if(!busy)c.clips=[result];data=c.runs;}
  else if(p.startsWith('/campaign-clips/')){
   calls.push({p,method,body:json()});
   if(p.endsWith('/fix')){result.complianceStatus='WARN';result.compliance={status:'WARN',overallScore:95,checks:[{code:'LOGO',status:'PASS',detail:'Required logo is applied.',fixable:true},{code:'TONE',status:'WARN',detail:'Review the professional tone.',fixable:false}]};result.exportCurrent=false;}
   if(p.endsWith('/export'))result.exportCurrent=true;
   if(p.endsWith('/ready'))result.lifecycleStatus='READY';
   if(p.endsWith('/social'))Object.assign(result.socialPackage,json());
   if(p.endsWith('/mark-posted')){result.lifecycleStatus='POSTED';result.post={...json(),postedAt:now,views:0,likes:0,comments:0,shares:0,earnings:'0.00',currency:'USD'};}
   if(p.endsWith('/metrics'))Object.assign(result.post,json());data=result;
  }else if(p==='/campaigns/'+c.id)data=c;
  return route.fulfill({json:data});
 });return{calls,c};
}

for(const width of [1440,375,390]){
 test(`five-step campaign confirmation and source generation at ${width}px`,async({page})=>{
  const f=await fixture(page);await page.setViewportSize({width,height:900});await page.goto('/clippers/campaigns/new');
  await page.getByLabel('Campaign name',{exact:true}).fill('Argument campaign');await page.getByLabel('Platforms (comma-separated)').fill('TikTok');await page.getByRole('button',{name:'Create draft and continue'}).click();
  await page.getByLabel('Paste the complete campaign description/rules here').fill('Required topics: arguments\nDuration: 15–90 seconds');await page.getByRole('button',{name:'Continue to assets'}).click();
  await page.getByLabel('Upload as').selectOption('LOGO');await page.getByLabel('Select campaign files').setInputFiles([{name:'logo.png',mimeType:'image/png',buffer:Buffer.from('fixture')},{name:'second-logo.png',mimeType:'image/png',buffer:Buffer.from('fixture')}]);await expect(page.getByText('logo.png',{exact:true})).toHaveCount(2);expect(f.calls.filter(c=>c.p.endsWith('/assets'))).toHaveLength(2);
  await expect(page.getByRole('button',{name:'Upload a folder'})).toBeVisible();await page.getByRole('button',{name:'Continue to understanding'}).click();await page.getByRole('button',{name:'Understand Campaign',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Required Topics',exact:true})).toHaveValue('arguments');await expect(page.getByRole('button',{name:'Confirm Campaign',exact:true})).toBeDisabled();await page.getByLabel('I reviewed and confirm these campaign rules.').check();await page.getByRole('button',{name:'Confirm Campaign',exact:true}).click();await page.getByRole('link',{name:'Open Campaign',exact:true}).click();
  await page.getByRole('button',{name:'Create Campaign Clips',exact:true}).click();await page.getByLabel('Authorized conversation.mp4').check();await page.getByRole('combobox',{name:/^Style/}).selectOption('STYLETWO');await page.getByRole('button',{name:'Generate Campaign Clips',exact:true}).click();expect(f.calls.find(c=>c.p.endsWith('/generate')).body).toMatchObject({mode:'XEEFREE',style:'STYLETWO',count:1,sourceIds:['existing-source']});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
 });
 test(`Pro busy requires explicit Free choice at ${width}px`,async({page})=>{
  const f=await fixture(page,{busy:true});await page.setViewportSize({width,height:900});await page.goto('/clippers/campaigns/campaign-fixture');await page.getByRole('button',{name:'Rules',exact:true}).click();await page.getByRole('button',{name:'XeePro',exact:true}).click();await page.getByRole('button',{name:'Understand Campaign',exact:true}).click();await expect(page.locator('p[role="alert"]')).toContainText(busyMessage);expect(f.calls.filter(c=>c.p.endsWith('/understand'))).toHaveLength(1);await expect(page.getByRole('button',{name:'XeePro',exact:true})).toHaveAttribute('aria-pressed','true');await page.getByRole('button',{name:'Use XeeFree',exact:true}).click();await expect(page.getByRole('button',{name:'XeeFree',exact:true})).toHaveAttribute('aria-pressed','true');expect(f.calls.filter(c=>c.p.endsWith('/understand'))).toHaveLength(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
 });
 test(`compliance fix, current export, Ready, posting and decimal metrics at ${width}px`,async({page})=>{
  const f=await fixture(page,{clips:true,admin:true});await page.setViewportSize({width,height:900});await page.goto('/clippers/clips');const card=page.getByTestId('campaign-clip');await card.getByText('View Compliance').click();await expect(card.getByText('Required logo is missing.')).toBeVisible();await expect(card.getByRole('button',{name:'Mark Ready to Post'})).toBeDisabled();await expect(card.getByRole('link',{name:'Edit Video'})).toHaveAttribute('href','/edit-mode/existing-editor');await card.getByRole('button',{name:'Fix Automatically'}).click();await expect(card.getByRole('button',{name:'Mark Ready to Post'})).toBeDisabled();await card.getByRole('button',{name:'Export latest'}).click();await card.getByLabel('I reviewed and accept the listed warnings.').check();await card.getByRole('button',{name:'Mark Ready to Post'}).click();await expect(card.getByText('READY TO POST',{exact:true})).toBeVisible();
  await card.getByText('Edit social copy',{exact:true}).click();await card.locator('textarea[name=caption]').fill('A grounded campaign caption.');await card.getByRole('button',{name:'Save social copy'}).click();await card.getByText('Mark Posted',{exact:true}).click();await card.getByLabel('Platform',{exact:true}).fill('TikTok');await card.getByLabel('Post URL (optional)').fill('https://example.invalid/recorded');await card.getByRole('button',{name:'Confirm manually posted'}).click();await card.getByRole('spinbutton',{name:/^views$/i}).fill('1234');await card.getByLabel('Recorded earnings').fill('12.50');await card.getByRole('button',{name:'Save metrics'}).click();expect(f.calls.find(c=>c.p.endsWith('/metrics')).body).toMatchObject({views:1234,earnings:'12.50',currency:'USD'});expect(f.calls.find(c=>c.p.endsWith('/social')).body.caption).toBe('A grounded campaign caption.');
  for(const route of ['/clippers','/clippers/campaigns','/clippers/assets','/clippers/ready','/clippers/posted','/clippers/performance']){await page.goto(route);await expect(page.getByRole('navigation',{name:'Clipper workspace navigation'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),route).toBeTruthy();}
  if(width===1440){const main=page.getByRole('navigation',{name:'Main navigation'});for(const name of ['Create','Quick Reframe','Clippers','History','Admin','Settings'])await expect(main.getByRole('link',{name,exact:true})).toBeVisible();}
 });
}
