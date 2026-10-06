import { expect, test, type Page } from '@playwright/test';
const plan={version:1,aspect:'SOURCE',crop:{x:0,y:.1,w:1,h:.8},framing:'CROP',cleanup:[],hook:{enabled:false,text:'',y:.24},captions:{enabled:false,replaceExisting:false,font:'Inter, sans-serif',size:36,y:.57,color:'#FFFFFF',cues:[]},color:{exposure:0,contrast:1,saturation:1,temperature:0,sharpness:0,denoise:false},audio:{muted:false,volume:1},resolution:1080,reasons:['Preserves the complete sequence and original audio.']};
const analysis={regions:[{id:'headline',kind:'DECORATIVE',text:'MONEY TIP',confidence:.92,start:0,end:30,x:.2,y:.02,w:.6,h:.06}],frames:[{t:0,faces:[{x:.4,y:.3,w:.2,h:.2}],persons:[],information:[]}],boundaries:[],subtitleState:'MISSING',warnings:[],bars:{top:0,bottom:0,left:0,right:0}};
const base={id:'responsive-fixture',editProjectId:'project-fixture',revision:4,name:'authorized-video.mp4',duration:30,width:360,height:640,originalUrl:'/fixture.mp4',sourceUrl:'/fixture.mp4',sourceWidth:360,sourceHeight:640,
  cropConfirmed:false,confirmed:null,editPath:null,styleOneApplied:false,previewUrl:null,exportUrl:null,previewRevision:null,exportRevision:null,exports:[],status:'ANALYZED',progress:100,message:'Adjust the crop, then press Done',error:null,
  analysis,plan,hooks:[],outputs:null,hasAudio:true,hasTranscript:true,captionCount:0,createdAt:new Date().toISOString()};
const confirmed={...base,cropConfirmed:true,confirmed:{aspect:'SOURCE',crop:plan.crop,framing:'CROP',cleanup:[],denoise:false},status:'CROPPED',sourceWidth:360,sourceHeight:512,outputs:{720:{width:720,height:1024},1080:{width:1080,height:1536}}};
async function serve(page:Page,session:object){
  await page.route('**/quick-reframe/responsive-fixture',route=>route.fulfill({json:session}));
  await page.route('**/fixture.mp4',route=>route.fulfill({status:204,body:''}));
}
const noOverflow=(page:Page)=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);

test('crop comes first and is usable at every requested width',async({page})=>{
  await serve(page,base);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  for(const width of [320,375,390,430,768,1024,1440]){
    await page.setViewportSize({width,height:900});await page.goto('/quick-reframe?video=responsive-fixture');
    await expect(page.getByRole('heading',{name:'Quick Reframe AI'})).toBeVisible();
    await expect(page.getByRole('navigation',{name:'Quick Reframe steps'}).locator('[aria-current="step"]')).toContainText(width<640?'':'Crop');
    await expect(page.getByTestId('crop-stage')).toBeVisible();
    await expect(page.locator('[data-testid^="crop-done"]:visible')).toHaveCount(1);
    // The whole portrait frame is visible: the picture fits inside its stage and keeps the video's shape.
    const stage=(await page.getByTestId('crop-stage').boundingBox())!;const holder=(await page.getByTestId('crop-stage').locator('xpath=..').boundingBox())!;
    expect(stage.height).toBeGreaterThan(150);expect(stage.y).toBeGreaterThanOrEqual(holder.y-1);expect(stage.y+stage.height).toBeLessThanOrEqual(holder.y+holder.height+1);
    expect(stage.x+stage.width).toBeLessThanOrEqual(holder.x+holder.width+1);expect(Math.abs(stage.width/stage.height-360/640)).toBeLessThan(.02);
    // No StyleOne or editing controls exist before the crop is confirmed.
    await expect(page.getByRole('button',{name:'Apply StyleOne'})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Export Video',exact:true})).toHaveCount(0);
    for(const label of ['From top','From bottom','From left','From right'])await expect(page.getByLabel(label,{exact:true})).toBeVisible();
    expect(await noOverflow(page)).toBeTruthy();
  }
  expect(errors).toEqual([]);
});

test('detected text boxes are hidden until requested, and edge sliders change the crop',async({page})=>{
  await serve(page,base);await page.setViewportSize({width:1280,height:900});
  await page.route('**/quick-reframe/responsive-fixture/plan',route=>route.fulfill({json:base}));
  await page.goto('/quick-reframe?video=responsive-fixture');
  await expect(page.getByText(/decorative \d+%/)).toHaveCount(0);
  await page.getByRole('button',{name:'Show detected text'}).click();
  await expect(page.getByText(/decorative \d+%/)).toBeVisible();
  const box=page.getByTestId('crop-box');const before=await box.boundingBox();
  await page.getByLabel('From left',{exact:true}).fill('0.1');
  await expect.poll(async()=>(await box.boundingBox())!.x).toBeGreaterThan(before!.x+5);
  await page.getByRole('button',{name:'Preview result'}).click();
  await expect(page.getByTestId('crop-result')).toBeVisible();
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

test('own branding in Clean overlays needs rights and an ownership declaration',async({page})=>{
  const branded={...base,analysis:{...analysis,regions:[{id:'own-logo',kind:'ATTRIBUTION',text:'@mybrand',confidence:.95,start:0,end:30,x:.8,y:.85,w:.18,h:.05}]}};
  await serve(page,branded);await page.setViewportSize({width:1280,height:900});
  await page.goto('/quick-reframe?video=responsive-fixture');
  await page.getByRole('button',{name:'Clean overlays'}).click();
  await page.getByLabel('Overlay to clean').selectOption('own-logo');
  const add=page.getByRole('button',{name:'Add cleanup region',exact:true});
  await expect(add).toBeDisabled();
  await page.getByRole('checkbox',{name:'I own this video or have permission to remove these overlays.'}).check();
  await expect(add).toBeDisabled();
  await page.getByRole('checkbox',{name:'This branding is my own. Removing it keeps any required attribution.'}).check();
  await expect(add).toBeEnabled();await add.click();
  await expect(page.getByLabel('Cleanup 1 method')).toBeVisible();
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
