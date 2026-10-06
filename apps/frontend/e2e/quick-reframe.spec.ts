import { expect, test } from '@playwright/test';
const plan={version:1,aspect:'SOURCE',crop:{x:0,y:0,w:1,h:1},framing:'CROP',cleanup:[],hook:{enabled:false,text:'',y:.04},captions:{enabled:false,replaceExisting:false,font:'Noto Sans, sans-serif',size:32,y:.82,color:'#ffffff',cues:[{start:0,end:3,text:'Original spoken words'}]},color:{exposure:0,contrast:1,saturation:1,temperature:0,sharpness:0,denoise:false},audio:{muted:false,volume:1},resolution:1080,reasons:['Keeps the full frame to protect subjects.']};
const session={id:'responsive-fixture',revision:2,name:'authorized-video.mp4',duration:30,width:360,height:640,sourceUrl:'/fixture.mp4',previewUrl:null,exportUrl:null,previewRevision:null,exportRevision:null,status:'EDITING',progress:100,message:'Ready to edit',error:null,analysis:{regions:[],frames:[],boundaries:[],subtitleState:'MISSING',warnings:[],bars:{top:0,bottom:0,left:0,right:0}},plan,hooks:['Keep the speaker in view','A practical framing tip','Protect the original story'],createdAt:new Date().toISOString()};
test('Quick Reframe is independent and responsive at every requested width',async({page})=>{
  await page.route('**/quick-reframe/responsive-fixture',route=>route.fulfill({json:session}));
  await page.route('**/fixture.mp4',route=>route.fulfill({status:204,body:''}));
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  for(const width of [320,360,375,390,412,430,768,1024,1440]){
    await page.setViewportSize({width,height:900});await page.goto('/quick-reframe?video=responsive-fixture');
    await expect(page.getByRole('heading',{name:'Quick Reframe AI'})).toBeVisible();await expect(page.getByRole('button',{name:'Export Video',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    for(const name of ['Crop','Cleanup','Hook','Captions','Color','Audio']){
      await page.getByRole('button',{name,exact:true}).click();
      if(width<768){await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');}
      else {await expect(page.getByRole('complementary')).toBeVisible();await page.getByRole('button',{name:'Close controls'}).click();}
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    }
  }
  expect(errors).toEqual([]);
});
test('navigation exposes Quick Reframe without adding mobile bottom-bar tabs',async({page})=>{
  await page.setViewportSize({width:375,height:812});await page.goto('/quick-reframe');
  await expect(page.getByRole('link',{name:'Quick Reframe',exact:true})).toBeVisible();
  await expect(page.getByTestId('mobile-nav').getByRole('link')).toHaveCount(4);
  await expect(page.getByRole('button',{name:'Import video',exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
test('own branding requires a separate explicit selection and ownership declaration',async({page})=>{
  const branded={...session,analysis:{...session.analysis,regions:[{id:'own-logo',kind:'ATTRIBUTION',text:'@mybrand',confidence:.95,start:0,end:30,x:.8,y:.85,w:.18,h:.05}]}};
  await page.route('**/quick-reframe/responsive-fixture',route=>route.fulfill({json:branded}));
  await page.route('**/fixture.mp4',route=>route.fulfill({status:204,body:''}));
  await page.goto('/quick-reframe?video=responsive-fixture');
  await page.getByRole('button',{name:'Cleanup',exact:true}).click();
  await page.getByLabel('Cleanup region').selectOption('own-logo');
  const add=page.getByRole('button',{name:'I have rights to remove this region · Add',exact:true});
  await expect(add).toBeDisabled();
  await page.getByRole('checkbox',{name:'This selected branding is my own, and removing it will preserve required attribution.'}).check();
  await expect(add).toBeEnabled();await add.click();
  await expect(page.getByLabel('Cleanup 1 method')).toBeVisible();
});
