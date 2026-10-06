import { expect, test, type Page } from '@playwright/test';
/** Quick Reframe V3 crop step (mocked API): a fully manual crop, no AI before Done Cropping. */
const plan={version:1,aspect:'SOURCE',crop:{x:0,y:0,w:1,h:1},framing:'CROP',cleanup:[],grid:'THIRDS',hook:{enabled:false,text:'',y:.24},captions:{enabled:false,replaceExisting:false,font:'Inter, sans-serif',size:36,y:.57,color:'#FFFFFF',cues:[]},color:{exposure:0,contrast:1,saturation:1,temperature:0,sharpness:0,denoise:false},audio:{muted:false,volume:1},resolution:1080,reasons:[]};
const base={id:'responsive-fixture',editProjectId:'project-fixture',revision:4,name:'authorized-video.mp4',duration:30,width:720,height:1280,originalUrl:'/fixture.mp4',sourceUrl:'/fixture.mp4',sourceWidth:720,sourceHeight:1280,
  cropConfirmed:false,confirmed:null,editPath:null,styleOneApplied:false,previewUrl:null,exportUrl:null,previewRevision:null,exportRevision:null,exports:[],status:'CROPPING',progress:100,message:'Adjust the crop, then press Done Cropping',error:null,
  analysis:null,plan,hooks:[],outputs:null,hasAudio:true,hasTranscript:false,captionCount:0,createdAt:new Date().toISOString()};
const confirmed={...base,cropConfirmed:true,confirmed:{aspect:'SOURCE',crop:{x:0,y:.1,w:1,h:.8},framing:'CROP',cleanup:[],denoise:false},status:'CROPPED',sourceWidth:720,sourceHeight:1024,outputs:{720:{width:720,height:1024},1080:{width:1080,height:1536}}};
type Box={x:number;y:number;w:number;h:number};
/** Serves a session whose plan follows every PUT, and records each API call the page makes. */
async function serve(page:Page,session:Record<string,unknown>){
  const calls:string[]=[];const saved:Box[]=[];let current={...session};
  await page.route('**/quick-reframe/responsive-fixture**',async(route)=>{
    const url=new URL(route.request().url());calls.push(`${route.request().method()} ${url.pathname}`);
    if(url.pathname.endsWith('/plan')){const body=route.request().postDataJSON();current={...current,plan:body.plan};saved.push(body.plan.crop);return route.fulfill({json:current});}
    if(url.pathname.endsWith('/confirm-crop'))return route.fulfill({json:{...current,status:'PREPARE',message:'Applying your crop',progress:5}});
    return route.fulfill({json:current});
  });
  await page.route('**/fixture.mp4',route=>route.fulfill({status:204,body:''}));
  return {calls,saved};
}
const noOverflow=(page:Page)=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
/** The crop rectangle as drawn (normalized), read from the crop box's percentage style. */
const cropOf=(page:Page)=>page.getByTestId('crop-box').evaluate((el:HTMLElement)=>({x:parseFloat(el.style.left)/100,y:parseFloat(el.style.top)/100,w:parseFloat(el.style.width)/100,h:parseFloat(el.style.height)/100}));
const ratioOf=(b:Box)=>(b.w*720)/(b.h*1280);
async function drag(page:Page,label:string,dx:number,dy:number){
  const handle=page.getByLabel(label,{exact:true});const box=(await handle.boundingBox())!;
  const x=box.x+box.width/2,y=box.y+box.height/2;
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:6});await page.mouse.up();
}
async function open(page:Page,width=1280,height=900){
  await page.setViewportSize({width,height});await page.goto('/quick-reframe?video=responsive-fixture');
  await expect(page.getByTestId('crop-stage')).toBeVisible();
  await expect.poll(async()=>(await page.getByTestId('crop-stage').boundingBox())?.height??0).toBeGreaterThan(150);
}

test('crop comes first, has no AI tools, and fits every requested width',async({page})=>{
  const {calls}=await serve(page,base);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  for(const width of [320,375,390,430,768,1024,1440]){
    await open(page,width);
    await expect(page.getByRole('heading',{name:'Quick Reframe AI'})).toBeVisible();
    await expect(page.locator('[data-testid^="crop-done"]:visible')).toHaveCount(1);
    await expect(page.locator('[data-testid^="crop-done"]:visible')).toHaveText(/Done Cropping/);
    const stage=(await page.getByTestId('crop-stage').boundingBox())!;const holder=(await page.getByTestId('crop-stage').locator('xpath=..').boundingBox())!;
    expect(stage.y).toBeGreaterThanOrEqual(holder.y-1);expect(stage.y+stage.height).toBeLessThanOrEqual(holder.y+holder.height+1);
    expect(stage.x+stage.width).toBeLessThanOrEqual(holder.x+holder.width+1);expect(Math.abs(stage.width/stage.height-720/1280)).toBeLessThan(.02);
    // Removed: smart crop, detection overlays and overlay cleanup. Not yet offered: StyleOne, hooks, editing.
    for(const name of [/Smart crop/i,/Show detected text/i,/Clean overlays/i,/Auto-detect/i,'Apply StyleOne',/Suggest hooks/i])await expect(page.getByRole('button',{name})).toHaveCount(0);
    for(const label of ['Crop top','Crop bottom','Crop left','Crop right','Zoom','Pan horizontally','Pan vertically','Width (px)','Height (px)','Grid style','Custom aspect ratio'])await expect(page.getByLabel(label,{exact:true})).toBeAttached();
    for(const shape of ['Original','Free','9:16','16:9','1:1','4:5','5:4','3:4','4:3','2:3','3:2','21:9'])await expect(page.getByRole('group',{name:'Aspect ratio'}).getByRole('button',{name:shape,exact:true})).toBeAttached();
    for(const name of ['Reset','Cancel'])await expect(page.getByRole('button',{name,exact:true}).locator('visible=true')).toHaveCount(1);
    expect(await noOverflow(page)).toBeTruthy();
  }
  expect(errors).toEqual([]);
  // No analysis, suggestion or hook request is ever made while cropping.
  expect(calls.filter(c=>/\/(analyze|suggest|hooks|styleone)/.test(c))).toEqual([]);
});

test('corners, edges and the whole box drag; fixed ratios hold; Free resizes each side',async({page})=>{
  const {calls,saved}=await serve(page,base);await open(page);
  // Free Crop: each edge independently, then a corner, then the whole rectangle.
  await page.getByRole('group',{name:'Aspect ratio'}).getByRole('button',{name:'Free',exact:true}).click();
  let b=await cropOf(page);expect(b).toEqual({x:0,y:0,w:1,h:1});
  await drag(page,'Crop handle: top edge',0,60);b=await cropOf(page);expect(b.y).toBeGreaterThan(.05);expect(b.w).toBe(1);expect(b.y+b.h).toBeCloseTo(1,5);
  await drag(page,'Crop handle: bottom edge',0,-60);b=await cropOf(page);expect(b.y+b.h).toBeLessThan(.95);
  await drag(page,'Crop handle: left edge',40,0);b=await cropOf(page);expect(b.x).toBeGreaterThan(.05);
  await drag(page,'Crop handle: right edge',-40,0);b=await cropOf(page);expect(b.x+b.w).toBeLessThan(.95);
  const beforeCorner=b;await drag(page,'Crop handle: bottom-right corner',-30,-50);b=await cropOf(page);
  expect(b.x).toBeCloseTo(beforeCorner.x,5);expect(b.y).toBeCloseTo(beforeCorner.y,5);expect(b.w).toBeLessThan(beforeCorner.w);expect(b.h).toBeLessThan(beforeCorner.h);
  const beforeMove=b;const box=(await page.getByTestId('crop-box').boundingBox())!;
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+25,box.y+box.height/2+35,{steps:6});await page.mouse.up();
  b=await cropOf(page);expect(b.w).toBeCloseTo(beforeMove.w,6);expect(b.h).toBeCloseTo(beforeMove.h,6);expect(b.x).toBeGreaterThan(beforeMove.x);expect(b.y).toBeGreaterThan(beforeMove.y);
  // Fixed shapes keep their ratio through corner and edge drags.
  for(const [shape,ratio] of [['9:16',9/16],['16:9',16/9],['1:1',1],['4:5',.8],['21:9',21/9]] as const){
    await page.getByRole('group',{name:'Aspect ratio'}).getByRole('button',{name:shape,exact:true}).click();
    expect(ratioOf(await cropOf(page))).toBeCloseTo(ratio,3);
    await drag(page,'Crop handle: top-left corner',20,30);expect(ratioOf(await cropOf(page))).toBeCloseTo(ratio,3);
    await drag(page,'Crop handle: right edge',-15,0);expect(ratioOf(await cropOf(page))).toBeCloseTo(ratio,3);
  }
  // Custom ratio typed by the user.
  await page.getByLabel('Custom aspect ratio',{exact:true}).fill('7:5');await page.getByRole('button',{name:'Apply',exact:true}).click();
  expect(ratioOf(await cropOf(page))).toBeCloseTo(7/5,3);
  // Grid styles never change the crop.
  const kept=await cropOf(page);
  for(const grid of ['GRID3','GRID4','CROSSHAIR','GOLDEN','NONE','THIRDS']){await page.getByLabel('Grid style').selectOption(grid);expect(await cropOf(page)).toEqual(kept);}
  await page.getByRole('button',{name:'Hide grid'}).click();await expect(page.getByTestId('crop-grid')).toHaveCount(0);expect(await cropOf(page)).toEqual(kept);
  await page.getByRole('button',{name:'Show grid'}).click();await expect(page.getByTestId('crop-grid')).toHaveAttribute('data-grid','THIRDS');
  // Numeric fields stay in sync with the rectangle.
  await page.getByLabel('Width (px)',{exact:true}).fill('300');await page.getByLabel('Width (px)',{exact:true}).press('Enter');
  b=await cropOf(page);expect(Math.round(b.w*720)).toBe(300);expect(ratioOf(b)).toBeCloseTo(7/5,3);
  await page.getByRole('group',{name:'Aspect ratio'}).getByRole('button',{name:'Free',exact:true}).click();
  expect(await cropOf(page)).toEqual(b);
  await page.getByLabel('Crop top (px)',{exact:true}).fill('100');await page.getByLabel('Crop top (px)',{exact:true}).press('Enter');
  expect(Math.round((await cropOf(page)).y*1280)).toBe(100);
  // The exact crop shown is what was saved, and Done Cropping sends it.
  await page.waitForTimeout(1000);const shown=await cropOf(page);const last=saved[saved.length-1];
  for(const k of ['x','y','w','h'] as const)expect(last[k]).toBeCloseTo(shown[k],3);
  await page.getByTestId('crop-done-desktop').click();
  await expect.poll(()=>calls.some(c=>c.endsWith('/confirm-crop'))).toBeTruthy();
  expect(calls.filter(c=>/\/(analyze|suggest|hooks|styleone)/.test(c))).toEqual([]);
});

test('reset, preview result, zoom and pan controls',async({page})=>{
  await serve(page,base);await open(page);
  await page.getByLabel('Zoom',{exact:true}).fill('2');
  let b=await cropOf(page);expect(b.w).toBeCloseTo(.5,3);expect(b.h).toBeCloseTo(.5,3);
  await page.getByLabel('Pan horizontally',{exact:true}).fill('0.25');b=await cropOf(page);expect(b.x).toBeCloseTo(0,3);
  await page.getByLabel('Pan vertically',{exact:true}).fill('0.75');b=await cropOf(page);expect(b.y).toBeCloseTo(.5,3);
  await page.getByRole('button',{name:'Preview result'}).click();await expect(page.getByTestId('crop-result')).toBeVisible();
  await page.getByRole('button',{name:'Adjust crop'}).click();
  await page.getByRole('button',{name:'Reset',exact:true}).locator('visible=true').click();expect(await cropOf(page)).toEqual({x:0,y:0,w:1,h:1});
  await expect(page.getByTestId('crop-live-preview')).toBeVisible();
});

test('touch: one finger drags, two fingers pinch and pan, the page does not scroll',async({page,browserName})=>{
  test.skip(browserName!=='chromium','CDP touch input');
  await serve(page,base);await open(page,390,844);
  await page.getByRole('group',{name:'Aspect ratio'}).getByRole('button',{name:'Free',exact:true}).click();
  // Clicking "Free" scrolled down to the controls; bring the picture back as a user would.
  await page.getByTestId('crop-stage').evaluate((el)=>el.scrollIntoView({block:'start'}));
  const cdp=await page.context().newCDPSession(page);
  const touch=(type:'touchStart'|'touchMove'|'touchEnd',points:Array<{x:number;y:number}>)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map((p,i)=>({x:p.x,y:p.y,id:i}))});
  const scrollBefore=await page.evaluate(()=>scrollY);
  // One finger on the bottom-right corner shrinks the crop.
  const corner=(await page.getByLabel('Crop handle: bottom-right corner',{exact:true}).boundingBox())!;
  const c={x:corner.x+corner.width/2,y:corner.y+corner.height/2};
  await touch('touchStart',[c]);for(let i=1;i<=6;i++)await touch('touchMove',[{x:c.x-i*8,y:c.y-i*12}]);await touch('touchEnd',[]);
  let b=await cropOf(page);expect(b.w).toBeLessThan(.95);expect(b.h).toBeLessThan(.95);
  expect(await page.evaluate(()=>scrollY)).toBe(scrollBefore);
  // Two fingers spread apart to zoom in (a smaller crop, same shape) while moving together to pan.
  const box=(await page.getByTestId('crop-box').boundingBox())!;const cx=box.x+box.width/2,cy=box.y+box.height/2;
  const before=b;
  await touch('touchStart',[{x:cx-40,y:cy},{x:cx+40,y:cy}]);
  for(let i=1;i<=6;i++)await touch('touchMove',[{x:cx-40-i*8+i*4,y:cy+i*4},{x:cx+40+i*8+i*4,y:cy+i*4}]);
  await touch('touchEnd',[]);
  b=await cropOf(page);expect(b.w).toBeLessThan(before.w*.8);expect(ratioOf(b)).toBeCloseTo(ratioOf(before),3);
  expect(b.x+b.w/2).toBeGreaterThan(before.x+before.w/2);expect(b.y+b.h/2).toBeGreaterThan(before.y+before.h/2);
  expect(await page.evaluate(()=>scrollY)).toBe(scrollBefore);
  // Full-screen workspace with Done/Reset in reach.
  await page.getByRole('button',{name:'Full screen'}).click();
  await expect(page.getByTestId('crop-workspace')).toHaveAttribute('data-expanded','true');
  await expect(page.getByTestId('crop-done')).toBeInViewport();
  await expect(page.getByTestId('crop-stage')).toBeInViewport();
  await page.getByRole('button',{name:'Exit full screen'}).click();
  await expect(page.getByTestId('crop-workspace')).not.toHaveAttribute('data-expanded','true');
});

test('the saved crop is restored exactly when returning to Crop',async({page})=>{
  const crop={x:.137,y:.271,w:.611,h:.389};
  await serve(page,{...confirmed,plan:{...plan,aspect:'CUSTOM',crop,grid:'GOLDEN'},confirmed:{...confirmed.confirmed,aspect:'CUSTOM',crop},editPath:'MANUAL',status:'EDITING'});
  await page.setViewportSize({width:1280,height:900});await page.goto('/quick-reframe?video=responsive-fixture&step=crop');
  await expect(page.getByTestId('crop-stage')).toBeVisible();
  const b=await cropOf(page);for(const k of ['x','y','w','h'] as const)expect(b[k]).toBeCloseTo(crop[k],6);
  await expect(page.getByLabel('Grid style')).toHaveValue('GOLDEN');
  await expect(page.getByRole('group',{name:'Aspect ratio'}).getByRole('button',{name:'Free',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByTestId('crop-summary')).toContainText(`${Math.round(.611*720)} × ${Math.round(.389*1280)} px`);
});

test('a very small crop is allowed with a quality warning',async({page})=>{
  await serve(page,base);await open(page);
  await page.getByLabel('Width (px)',{exact:true}).fill('120');await page.getByLabel('Width (px)',{exact:true}).press('Enter');
  await expect(page.getByText(/will look soft/)).toBeVisible();
  await expect(page.getByTestId('crop-done-desktop')).toBeEnabled();
});

test('after the crop, StyleOne and Manual are offered; switching from Manual asks first',async({page})=>{
  await serve(page,{...confirmed,editPath:'MANUAL'});
  for(const width of [375,1280]){
    await page.setViewportSize({width,height:900});await page.goto('/quick-reframe?video=responsive-fixture&step=choose');
    await expect(page.getByRole('heading',{name:'How would you like to edit your video?'})).toBeVisible();
    await expect(page.getByTestId('choose-styleone')).toBeVisible();await expect(page.getByTestId('choose-manual')).toBeVisible();
    await page.getByTestId('choose-styleone').click();
    await expect(page.getByRole('dialog',{name:'Apply StyleOne over your edits?'})).toBeVisible();
    await page.getByRole('button',{name:'Keep my edits'}).click();
    expect(await noOverflow(page)).toBeTruthy();
  }
});

test('export shows the real resolution for each quality and both paths share it',async({page})=>{
  await serve(page,{...confirmed,editPath:'MANUAL',status:'EDITING'});
  for(const width of [375,1280]){
    await page.setViewportSize({width,height:900});await page.goto('/quick-reframe?video=responsive-fixture&step=export');
    await expect(page.getByRole('heading',{name:'Export video'})).toBeVisible();
    await expect(page.getByText('1080 × 1536')).toBeVisible();
    await page.getByRole('button',{name:'720p',exact:true}).click();
    await expect(page.getByText('720 × 1024')).toBeVisible();
    await expect(page.getByTestId('export-video')).toHaveText(/Export 720p/);
    expect(await noOverflow(page)).toBeTruthy();
  }
});

test('navigation exposes Quick Reframe without adding mobile bottom-bar tabs',async({page})=>{
  await page.setViewportSize({width:375,height:812});await page.goto('/quick-reframe');
  await expect(page.getByRole('link',{name:'Quick Reframe',exact:true})).toBeVisible();
  await expect(page.getByTestId('mobile-nav').getByRole('link')).toHaveCount(4);
  await expect(page.getByRole('button',{name:'Import video',exact:true})).toBeDisabled();
  expect(await noOverflow(page)).toBeTruthy();
});
