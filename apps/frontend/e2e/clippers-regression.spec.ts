import {expect,test} from '@playwright/test';
import {fixture} from './support/campaign-fixture';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
const api=process.env.E2E_API_URL??'https://clipper-api.invalid';
const media=path.resolve(__dirname,'../../../.cache/clipper-frontend/playback.mp4');
test.beforeAll(()=>{mkdirSync(path.dirname(media),{recursive:true});execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=0x554488:s=160x284:r=15:d=3','-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-movflags','+faststart',media]);});
for(const width of [1440,375,390]){
 test(`existing Create, Reframe, History and Settings at ${width}px`,async({page})=>{
  await fixture(page);await page.setViewportSize({width,height:850});
  for(const [route,label] of [['/','Create clips'],['/quick-reframe','Quick Reframe'],['/history','History'],['/settings','Settings']]){await page.goto(route);await expect(page.getByRole('heading',{level:1})).toContainText(label);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),route).toBeTruthy();}
  await page.goto('/');for(const name of ['XeeFree','XeePro','StyleZero','StyleOne','StyleTwo'])await expect(page.getByRole('radio',{name:new RegExp(name)}).first()).toBeVisible();
  await expect(page.getByRole('link',{name:'Admin',exact:true})).toHaveCount(0);
 });
 test(`campaign video playback and actual download at ${width}px`,async({page})=>{
  const f=await fixture(page,{clips:true});f.result.previewUrl='/qa-media.mp4';f.result.downloadUrl='/qa-media.mp4?download=1';f.result.mode='XEEFREE';
  const bytes=readFileSync(media);await page.route(api+'/qa-media.mp4*',r=>r.fulfill({body:bytes,headers:{'content-type':'video/mp4',...(r.request().url().includes('download=1')?{'content-disposition':'attachment; filename="campaign-qa.mp4"'}:{})}}));
  await page.setViewportSize({width,height:850});await page.goto('/clippers/clips');const card=page.getByTestId('campaign-clip'),video=card.locator('video');await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.readyState)).toBeGreaterThanOrEqual(2);await card.getByRole('button',{name:'Preview',exact:true}).click();await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(.1);await video.evaluate((v:HTMLVideoElement)=>v.pause());
  const downloading=page.waitForEvent('download');await card.getByRole('link',{name:'Download',exact:true}).click();const download=await downloading;expect(download.suggestedFilename()).toBe('campaign-qa.mp4');expect(await download.failure()).toBeNull();
  const dir=path.dirname(media)+'/screenshots';mkdirSync(dir,{recursive:true});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:dir+`/clip-${width}.png`,fullPage:true});
 });
}
test('Admin navigation is visible only for the owner account',async({page})=>{await fixture(page,{admin:true});await page.goto('/clippers');const nav=page.getByRole('navigation',{name:'Main navigation'});await expect(nav.getByRole('link',{name:'Admin',exact:true})).toBeVisible();for(const label of ['Create','Quick Reframe','Clippers','History','Settings'])await expect(nav.getByRole('link',{name:label,exact:true})).toBeVisible();});
