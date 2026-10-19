import {expect,test} from '@playwright/test';
import {fixture} from './support/campaign-fixture';
const routes=['/clippers','/clippers/campaigns','/clippers/campaigns/new','/clippers/campaigns/campaign-fixture','/clippers/assets','/clippers/clips','/clippers/ready','/clippers/posted','/clippers/performance'];
for(const width of [1440,375,390])test(`static deep links and refresh at ${width}px`,async({page})=>{
 test.setTimeout(90000);await fixture(page);await page.setViewportSize({width,height:850});
 for(const route of routes){const response=await page.goto(route);expect(response?.status(),route).toBe(200);await expect(page.getByRole('heading',{level:1})).toBeVisible();await page.reload();await expect(page.getByRole('heading',{level:1})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),route).toBeTruthy();if(route.endsWith('/campaign-fixture')){await expect(page.getByRole('heading',{name:'Argument campaign',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Clippers',exact:true}).first()).toHaveAttribute('aria-current','page');}}
});
