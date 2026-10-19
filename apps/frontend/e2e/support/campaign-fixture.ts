import {type Page} from '@playwright/test';
const api=process.env.E2E_API_URL??'http://localhost:4200';
const busyMessage='XeePro is busy right now. Try XeeFree or try again later.';
const now=new Date().toISOString();
export function brief(){return {...Object.fromEntries(['targetPlatforms','requiredTopics','preferredTopics','forbiddenTopics','requiredKeywords','forbiddenKeywords','contentDo','contentDont','requiredHashtags','requiredMentions','unresolvedRules'].map(k=>[k,[]])),...Object.fromEntries(['requiredCTA','forbiddenCTA','hookRequirements','captionRequirements','brandingRequirements','musicRequirements','logoRequirements','postingRules','submissionRules','tone','audience','referenceStyleHints','requiredText','brandColor','deadlineText','payoutText','hashtagRequirements'].map(k=>[k,''])),minDurationSec:15,maxDurationSec:90,aspectRatio:'9:16',warnings:[],confidence:'EXPLICIT',assetInstructions:[]};}
export async function fixture(page:Page,{busy=false,clips=false,admin=false}={}){
 const calls:any[]=[];let c:any={id:'campaign-fixture',projectId:'existing-project',name:'Argument campaign',description:'A campaign over the existing engine.',platforms:['TikTok'],status:'DRAFT',deadline:null,payoutDescription:'Recorded rewards',defaultClipCount:1,createdAt:now,brief:{campaignId:'campaign-fixture',version:1,sourceText:'',mode:'XEEFREE',confirmedByUser:false,data:brief()},assets:[],sources:[{id:'existing-source',videoId:'existing-video',video:{id:'existing-video',originalName:'Authorized conversation.mp4',processingJobs:[{status:'COMPLETED',error:null}]}}],runs:[],clips:[]};
 const result:any={editProjectId:'existing-editor',checkedRevision:1,checkedBriefVersion:1,id:'clip-fixture',campaignId:c.id,campaignName:c.name,title:'Arguments stand on their merits',mode:'XEEPRO',style:'STYLEONE',lifecycleStatus:'NEEDS_REVIEW',complianceStatus:'FAIL',complianceScore:80,compliance:{status:'FAIL',overallScore:80,checks:[{code:'LOGO',status:'FAIL',detail:'Required logo is missing.',fixable:true}]},socialPackage:{caption:'Arguments stand on their merits.',hashtags:['#Arguments'],requiredMentions:[],cta:'Learn more',postingNotes:'Review before posting',alternateCaptions:[]},previewUrl:null,downloadUrl:'/test-export.mp4',exportCurrent:true,editorUrl:'/edit-mode/existing-editor',post:null};
 if(clips){c.clips=[result];c.brief.confirmedByUser=true;c.status='ACTIVE';}
 const summary=()=>({activeCampaigns:c.status==='ACTIVE'?1:0,campaigns:1,clipsGenerated:c.clips.length,ready:c.clips.filter((x:any)=>x.lifecycleStatus==='READY').length,posted:c.clips.filter((x:any)=>x.post).length,totalViews:result.post?.views??0,totalEngagement:0,earningsByCurrency:result.post?{USD:result.post.earnings}:{},averageViews:null,bestClipId:result.post?result.id:null,bestCampaign:null,averageCampaignMatch:c.clips.length?80:null});
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
  else if(p.endsWith('/assets')&&method==='POST'){const name=/filename="([^"]+)"/.exec(request.postData()||'')?.[1]||'logo.png';const a={id:'asset-'+c.assets.length,campaignId:c.id,type:/\.wav$/i.test(name)?'MUSIC':'LOGO',fileName:name,mimeType:/\.wav$/i.test(name)?'audio/wav':'image/png',label:'',required:false,intendedUse:'',fileUrl:'/test-logo.png',sizeBytes:100,metadata:{handling:'VERIFIED_MEDIA'},extractedTextAvailable:false};c.assets.push(a);c.brief.version++;data=a;calls.push({p,method});}
  else if(/\/assets\/asset-/.test(p)){Object.assign(c.assets.find((a:any)=>p.endsWith(a.id)),json());data={};}
  else if(p.endsWith('/generate')){calls.push({p,method,body:json()});c.runs=[{id:'run',mode:json().mode,style:json().style,status:busy?'FAILED':'COMPLETED',error:busy?busyMessage:null,errorCode:busy?'XEEPRO_BUSY':null}];if(!busy){result.mode=json().mode;result.style=json().style;c.clips=[result];}data=c.runs;}
  else if(p.startsWith('/campaign-clips/')){
   calls.push({p,method,body:json()});
   if(p.endsWith('/fix')){result.complianceStatus='WARN';result.compliance={status:'WARN',overallScore:95,checks:[{code:'LOGO',status:'PASS',detail:'Required logo is applied.',fixable:true},{code:'TONE',status:'WARN',detail:'Review the professional tone.',fixable:false}]};result.exportCurrent=false;}
   if(p.endsWith('/export'))result.exportCurrent=true;
   if(p.endsWith('/ready'))result.lifecycleStatus='READY';
   if(p.endsWith('/social')){result.checkedRevision++;Object.assign(result.socialPackage,json());result.lifecycleStatus='NEEDS_REVIEW';}
   if(p.endsWith('/mark-posted')){result.lifecycleStatus='POSTED';result.post={...json(),postedAt:now,views:0,likes:0,comments:0,shares:0,earnings:'0.00',currency:'USD'};}
   if(p.endsWith('/metrics'))Object.assign(result.post,json());data=result;
  }else if(p==='/campaigns/'+c.id)data=c;
  return route.fulfill({json:data});
 });return{calls,c,result};
}
