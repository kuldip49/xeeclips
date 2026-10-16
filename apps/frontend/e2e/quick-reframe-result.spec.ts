import {expect,test,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';

const now=new Date().toISOString();
const api=process.env.E2E_API_URL??'http://localhost:4000';
const plan={version:1,aspect:'SOURCE',crop:{x:.1,y:.1,w:.8,h:.8},framing:'CROP',cleanup:[],grid:'THIRDS',hook:{enabled:false,text:'',y:.24},captions:{enabled:false,cues:[]},color:{exposure:0,contrast:1,saturation:1,temperature:0,sharpness:0,denoise:false},audio:{muted:false,volume:1},resolution:1080,reasons:[]};
async function serve(page:Page,mode:string,style:string,options:{busy?:boolean;immediate?:boolean;processing?:boolean}={}){
 const calls={style:0,preview:0,export:0,editor:0};let allowedEditor=false,pending=options.processing?'style':'',pendingReads=options.processing?1:0;
 let current:any={id:'result-fixture',editProjectId:'result-project',revision:4,name:'Owned test video',duration:12,width:640,height:480,sourceWidth:512,sourceHeight:384,originalUrl:'/result-source.mp4',sourceUrl:'/result-source.mp4',cropConfirmed:true,confirmed:{...plan,denoise:false},plan,mode,editPath:null,styleZeroApplied:false,styleOneApplied:false,styleTwoApplied:false,previewUrl:null,previewRevision:null,exportUrl:null,exports:[],status:options.processing?'ANALYZE':'CROPPED',progress:100,message:'Crop confirmed',error:null,errorCode:null,analysis:{subtitleState:'MISSING',frames:[],regions:[]},hooks:[{text:'Judge each argument on its merits',category:'PROFESSIONAL',score:85,recommended:true,source:mode==='XEEPRO'?'OPENAI':'LOCAL'}],hasAudio:true,hasTranscript:true,captionCount:2,createdAt:now,postCopy:{version:0,selectedCaption:'',selectedHashtags:[]},outputs:{720:{width:720,height:1280},1080:{width:1080,height:1920}}};
 const complete=()=>current=options.busy?{...current,status:'FAILED',progress:100,errorCode:'XEEPRO_BUSY',error:'XeePro is busy right now. Try XeeFree or try again later.'}:{...current,status:'READY',editPath:style,previewUrl:'/result-styled.mp4',previewRevision:current.revision,styleZeroApplied:style==='STYLEZERO',styleOneApplied:style==='STYLEONE',styleTwoApplied:style==='STYLETWO'};
 await page.route('**/auth/session',r=>r.fulfill({json:{id:'result-owner',email:'result@example.invalid',role:'ADMIN',creditBalance:5,creditsConsumed:0,aiProcessingConsentAt:now}}));
 await page.route('**/videos/import-capabilities',r=>r.fulfill({json:{xeeFree:true,xeePro:true}}));
 await page.route('**/history/clips',r=>r.fulfill({json:[]}));await page.route('**/videos',r=>r.fulfill({json:[]}));
 await page.route(`${api}/quick-reframe/**`,async r=>{
  const p=new URL(r.request().url()).pathname,method=r.request().method();
  if(p.endsWith('/history'))return r.fulfill({json:current.previewUrl&&current.status!=='FAILED'?[current]:[]});
  if(p.endsWith('/mode')){current={...current,mode:r.request().postDataJSON().mode,revision:current.revision+1,error:null,errorCode:null,status:'CROPPED'};return r.fulfill({json:current});}
  if(method==='POST'&&/\/style(?:zero|one|two)$/.test(p)){calls.style++;expect(p).toContain(style.toLowerCase());current={...current,status:'ANALYZE',progress:20};if(options.immediate)complete();else pending='style';return r.fulfill({json:current});}
  if(p.endsWith('/export')){calls.export++;expect(r.request().postDataJSON().revision).toBe(current.revision);current={...current,status:'EXPORT',progress:30};pending='export';return r.fulfill({json:current});}
  if(p.endsWith('/preview')){calls.preview++;return r.fulfill({json:current});}
  if(method==='GET'&&pending){if(pendingReads-->0)return r.fulfill({json:current});if(pending==='style')complete();else current={...current,status:'COMPLETE',progress:100,exportUrl:'/result-export.mp4',exports:[{id:'exported',url:'/result-export.mp4',revision:current.revision,current:true,width:720,height:1280,duration:12,createdAt:now}]};pending='';}
  return r.fulfill({json:current});
 });
 await page.route(`${api}/edit-mode/projects/**`,r=>{calls.editor++;expect(allowedEditor,'The editor must not load before Edit Video is clicked').toBe(true);const p=new URL(r.request().url()).pathname;return r.fulfill({json:p.endsWith('/history')?[]:{id:'result-project',revision:current.revision,name:current.name,status:'READY',settings:{feature:'QUICK_REFRAME',aspectRatio:'9:16',origin:{aiMode:mode==='XEEPRO'?'ONLINE':'FALLBACK_ONLY'}},assets:[],elements:[],createdAt:now,updatedAt:now}});});
 await page.route('**/result-*.mp4*',r=>r.fulfill(new URL(r.request().url()).searchParams.has('download')?{body:Buffer.from('verified canonical export'),headers:{'content-type':'video/mp4','content-disposition':'attachment; filename="result.mp4"'}}:{status:204,body:''}));
 return {calls,current:()=>current,allowEditor:()=>{allowedEditor=true;}};
}

for(const width of [1440,375,390])for(const mode of ['XEEFREE','XEEPRO'])for(const style of ['STYLEZERO','STYLEONE','STYLETWO']){
 test(`${mode} ${style}: result, History, direct export/download and explicit editor at ${width}px`,async({page})=>{
  const f=await serve(page,mode,style,{immediate:style==='STYLEZERO'});await page.setViewportSize({width,height:900});const editorNavigations:string[]=[];page.on('framenavigated',frame=>{if(frame===page.mainFrame()&&frame.url().includes('/edit-mode/'))editorNavigations.push(frame.url());});
  await page.goto('/quick-reframe?video=result-fixture&step=choose');await page.getByTestId('choose-'+style.toLowerCase()).click();
  const result=page.getByRole('region',{name:'Quick Reframe result'});await expect(result).toBeVisible();await expect(page).toHaveURL(/quick-reframe\?video=result-fixture&step=result$/);await expect(result.getByRole('status')).toHaveText('Processing complete · Saved in History');await expect(result.getByText(mode==='XEEPRO'?'XeePro':'XeeFree',{exact:true})).toBeVisible();await expect(result.getByText(style==='STYLEZERO'?'StyleZero':style==='STYLEONE'?'StyleOne':'StyleTwo',{exact:true}).first()).toBeVisible();
  await expect(result.getByLabel('Final preview')).toHaveAttribute('src',/\/result-styled.mp4$/);expect(f.calls.editor).toBe(0);expect(editorNavigations).toEqual([]);
  await page.reload();await expect(result).toBeVisible();expect(f.calls.style).toBe(1);expect(f.calls.preview).toBe(0);
  await result.getByRole('link',{name:'Open History',exact:true}).click();const card=page.getByTestId('quick-reframe-history-item');await expect(card).toBeVisible();expect(f.current().exports).toHaveLength(0);await expect(card.locator('video')).toHaveAttribute('src',/\/result-styled.mp4$/);await expect(card.getByRole('link',{name:'Edit Video',exact:true})).toBeVisible();await card.getByRole('link',{name:'View result',exact:true}).click();await expect(result).toBeVisible();expect(f.calls.editor).toBe(0);
  await result.getByRole('button',{name:'720p',exact:true}).click();await result.getByTestId('export-video').click();const download=result.getByTestId('download-video');await expect(download).toBeVisible();expect(f.calls.export).toBe(1);expect(f.calls.editor).toBe(0);expect(editorNavigations).toEqual([]);
  const [file]=await Promise.all([page.waitForEvent('download'),download.click()]);expect(readFileSync((await file.path())!).toString()).toBe('verified canonical export');await page.reload();await expect(download).toBeVisible();expect(f.calls.style).toBe(1);expect(f.calls.preview).toBe(0);expect(f.calls.export).toBe(1);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  f.allowEditor();await result.getByTestId('edit-video').click();await expect(page).toHaveURL(/\/edit-mode\/result-project$/);await page.goBack();await expect(result).toBeVisible();await expect(download).toBeVisible();expect(f.calls.style).toBe(1);expect(f.calls.preview).toBe(0);expect(f.calls.export).toBe(1);
 });
}
for(const width of [1440,375,390])test(`busy stays on choices with no result or editor at ${width}px`,async({page})=>{
 const f=await serve(page,'XEEPRO','STYLETWO',{busy:true});await page.setViewportSize({width,height:900});await page.goto('/quick-reframe?video=result-fixture&step=choose');await page.getByTestId('choose-styletwo').click();await expect(page.locator('p[role="alert"]')).toHaveText('XeePro is busy right now. Try XeeFree or try again later.');await expect(page.getByRole('region',{name:'Quick Reframe result'})).toHaveCount(0);await expect(page.getByRole('button',{name:'Use XeeFree',exact:true})).toBeVisible();await page.reload();await expect(page.getByRole('button',{name:'XeePro',exact:true})).toHaveAttribute('aria-pressed','true');expect(f.calls.editor).toBe(0);expect(f.calls.export).toBe(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
test('refresh during processing and legacy edit links resolve to the saved result',async({page})=>{
 const f=await serve(page,'XEEFREE','STYLEONE',{processing:true});await page.goto('/quick-reframe?video=result-fixture&step=choose');await expect(page.getByRole('region',{name:'Quick Reframe result'})).toBeVisible();await page.goto('/quick-reframe?video=result-fixture&step=edit');await expect(page).toHaveURL(/step=result$/);await expect(page.getByRole('region',{name:'Quick Reframe result'})).toBeVisible();await page.goto('/quick-reframe?video=result-fixture');await expect(page).toHaveURL(/step=result$/);expect(f.calls.style).toBe(0);expect(f.calls.editor).toBe(0);expect(f.calls.preview).toBe(0);
});
