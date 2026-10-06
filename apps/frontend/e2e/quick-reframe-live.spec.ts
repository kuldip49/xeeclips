import { expect, test } from '@playwright/test';
/** Live: a disposable exported session (REFRAME_LIVE_ID) plays its real MP4, survives reload, and re-opens from History. */
test('public Quick Reframe plays a real export and resumes from History',async({page})=>{
  test.skip(!process.env.REFRAME_LIVE_ID,'Requires a disposable exported Quick Reframe session.');
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`/quick-reframe?video=${process.env.REFRAME_LIVE_ID}&step=export`);
  await expect(page.getByRole('heading',{name:'Export video'})).toBeVisible();
  const video=page.getByLabel(/Exported video|Final preview/);
  await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.readyState),{timeout:30000}).toBeGreaterThanOrEqual(2);
  await video.evaluate((v:HTMLVideoElement)=>{v.muted=true;return v.play();});
  await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(.2);
  await expect(page.getByTestId('download-video')).toBeVisible();
  await page.screenshot({path:'test-results/quick-reframe-export.png',fullPage:true});
  await page.reload();await expect(page.getByTestId('download-video')).toBeVisible();
  await page.goto('/history');
  const section=page.getByRole('region',{name:'Quick Reframe history'});
  const card=section.getByTestId('quick-reframe-history-item').first();
  await expect(card.getByText('Quick Reframe',{exact:true})).toBeVisible();
  await expect(card.getByRole('link',{name:'Re-edit',exact:true})).toBeVisible();
  await page.setViewportSize({width:375,height:812});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  expect(errors).toEqual([]);
});
