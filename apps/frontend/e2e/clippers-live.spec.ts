import {expect,test} from '@playwright/test';
import {readFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=path.resolve(__dirname,'../../..'),dir=path.join(root,'.real-qa-preview/clipper-v1');
test.skip(process.env.CLIPPER_LIVE_QA!=='1','Opt in only against the isolated Clipper QA backend.');
test.setTimeout(180000);
for(const width of [1440,375,390])test(`real canonical campaign media and workspace at ${width}px`,async({page,context})=>{
 const report=JSON.parse(readFileSync(path.join(dir,'acceptance.json'),'utf8'));
 expect(report.status).toBe('CLIPPER_API_ACCEPTANCE_PASSED');expect(report.cases).toHaveLength(6);
 const auth=JSON.parse(readFileSync(path.join(root,'.cache/clippers/qa/browser-private.json'),'utf8'));
 const index=auth.cookie.indexOf('=');await context.addCookies([{name:auth.cookie.slice(0,index),value:auth.cookie.slice(index+1),domain:'localhost',path:'/',httpOnly:true,sameSite:'Lax'}]);
 await page.setViewportSize({width,height:900});
 for(const route of ['/clippers','/clippers/campaigns','/clippers/assets','/clippers/clips','/clippers/ready','/clippers/posted','/clippers/performance']){
  await page.goto(route);await expect(page.getByRole('navigation',{name:'Clipper workspace navigation'})).toBeVisible();await expect(page.getByRole('status').filter({hasText:'Loading workspace'})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),route).toBeTruthy();await expect(page.locator('p[role="alert"]')).toHaveCount(0);
 }
 await expect(page.getByText('USD 12.50',{exact:true})).toBeVisible();
 await page.goto('/clippers/campaigns/'+report.campaigns.complex);await expect(page.getByRole('heading',{name:'Complex discussion campaign',exact:true})).toBeVisible();
 for(const tab of ['Rules','Assets','Sources','Generated Clips','Ready to Post','Posted','Performance']){await page.getByRole('button',{name:tab,exact:true}).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),tab).toBeTruthy();}
 await page.getByRole('button',{name:'Generated Clips',exact:true}).click();const cards=page.getByTestId('campaign-clip');expect(await cards.count()).toBeGreaterThanOrEqual(2);
 const video=cards.first().locator('video');await expect(video).toBeVisible();await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.readyState)).toBeGreaterThanOrEqual(2);
 await video.evaluate(async(v:HTMLVideoElement)=>{v.muted=true;await v.play();});await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(.1);await video.evaluate((v:HTMLVideoElement)=>v.pause());
 const editor=cards.first().getByRole('link',{name:'Edit Video'}),href=await editor.getAttribute('href');expect(href).toMatch(/^\/edit-mode\//);
 mkdirSync(path.join(dir,'browser'),{recursive:true});await page.screenshot({path:path.join(dir,'browser',`campaign-${width}.png`),fullPage:true});
 await editor.click();await expect(page).toHaveURL(new RegExp(href!+'$'));await expect(page.getByText('Edit project was not found.',{exact:false})).toHaveCount(0);
});

test('six exports retain campaign logo geometry and canonical editor mode',async({page,context})=>{
 const report=JSON.parse(readFileSync(path.join(dir,'acceptance.json'),'utf8')),auth=JSON.parse(readFileSync(path.join(root,'.cache/clippers/qa/browser-private.json'),'utf8'));
 const index=auth.cookie.indexOf('=');await context.addCookies([{name:auth.cookie.slice(0,index),value:auth.cookie.slice(index+1),domain:'localhost',path:'/',httpOnly:true,sameSite:'Lax'}]);
 await page.setViewportSize({width:1600,height:1200});
 for(const item of report.cases){
  const response=await context.request.get('http://localhost:4200/edit-mode/projects/'+item.editProjectId);expect(response.ok()).toBeTruthy();const p=await response.json();expect(p.settings.origin.aiMode).toBe(item.mode==='XEEPRO'?'ONLINE':'FALLBACK_ONLY');
  const logo=p.elements.find((e:any)=>e.type==='IMAGE'&&p.assets.some((a:any)=>a.id===e.assetId&&a.metadata?.campaignAssetId));expect(logo).toBeTruthy();
  await page.goto('/edit-mode/'+item.editProjectId);const canvas=page.getByTestId('edit-preview-canvas');await expect(canvas).toBeVisible();const fit=page.getByTitle('Show the whole export frame');if(await fit.count())await fit.click();
  const image=page.locator(`[data-testid="preview-element"][data-element-id="${logo.id}"]`);await expect(image).toBeVisible();const frame=await canvas.boundingBox(),box=await image.boundingBox();expect(frame).toBeTruthy();expect(box).toBeTruthy();expect(Math.abs((box!.x-frame!.x)/frame!.width-logo.properties.x)).toBeLessThan(.025);expect(Math.abs((box!.y-frame!.y)/frame!.height-logo.properties.y)).toBeLessThan(.025);
  const pixels=execFileSync('ffmpeg',['-v','error','-ss','0.5','-i',item.export,'-frames:v','1','-vf','scale=360:640,format=rgb24','-f','rawvideo','-'],{maxBuffer:8<<20});
  let purple=0;const x=Math.round((logo.properties.x+.02)*360),y=Math.round((logo.properties.y+.02)*640);for(let dy=0;dy<10;dy++)for(let dx=0;dx<10;dx++){const i=((y+dy)*360+x+dx)*3;if(pixels[i]>85&&pixels[i]<170&&pixels[i+1]>25&&pixels[i+1]<100&&pixels[i+2]>180)purple++;}expect(purple,item.mode+' '+item.style+' visible exported logo').toBeGreaterThan(80);
  if(item.style==='STYLEONE'){const cta=p.elements.find((e:any)=>e.type==='TEXT'&&e.properties.content==='Learn more');expect(cta).toBeTruthy();await expect(page.locator(`[data-testid="preview-element"][data-element-id="${cta.id}"]`)).toBeVisible();}
  await canvas.screenshot({path:path.join(dir,'browser',`${item.mode}-${item.style}-editor.png`)});
 }
});
