import { getPublicApiBaseUrl } from './api';
export type { ReframeSession, ReframePlan, ReframeRegion, ReframeBox, ReframeHook, ReframeHookCategory, ReframeAspect,
  ReframeCleanup, ReframeExport, ReframeEditPath, ReframePreparation, ReframeAnalysis, ReframeCropGrid } from '@ai-content-platform/shared';
import type { ReframeHook, ReframeHookCategory, ReframePlan, ReframeSession } from '@ai-content-platform/shared';
export async function reframeRequest<T=ReframeSession>(path='',method='GET',body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(`${getPublicApiBaseUrl()}/quick-reframe${path}`,{credentials:'include',method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal,cache:'no-store'});
  if(response.status===401&&typeof window!=='undefined')window.dispatchEvent(new Event('xeeclip-auth-expired'));
  if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(typeof error.message==='string'?error.message:'The video could not be processed. Please retry.');}
  return response.json();
}
export const mediaUrl=(path:string|null|undefined)=>path?`${getPublicApiBaseUrl()}${path}`:undefined;
export async function uploadReframe(id:string,file:File,progress:(percent:number)=>void,signal:AbortSignal){
  const session=await reframeRequest<{id:string;chunkBytes:number;chunks:number}>(`/${id}/upload`,'POST',{name:file.name,size:file.size,mimeType:file.type||'video/mp4'},signal);
  try{
    for(let i=0;i<session.chunks;i++){
      const start=i*session.chunkBytes,chunk=file.slice(start,Math.min(file.size,start+session.chunkBytes));
      for(let attempt=0;attempt<3;attempt++){
        try{await new Promise<void>((resolve,reject)=>{
          const xhr=new XMLHttpRequest();const abort=()=>xhr.abort();xhr.open('PUT',`${getPublicApiBaseUrl()}/quick-reframe/uploads/${session.id}/chunks/${i}`);xhr.withCredentials=true;xhr.setRequestHeader('Content-Type','application/octet-stream');
          xhr.upload.onprogress=e=>progress(Math.floor((start+e.loaded)/file.size*100));
          const cleanup=()=>signal.removeEventListener('abort',abort);
          xhr.onload=()=>{cleanup();xhr.status>=200&&xhr.status<300?resolve():reject(new Error('Upload interrupted. Please retry.'));};
          xhr.onerror=()=>{cleanup();reject(new Error('Upload interrupted. Please retry.'));};xhr.onabort=()=>{cleanup();reject(new DOMException('Upload canceled','AbortError'));};
          signal.addEventListener('abort',abort,{once:true});if(signal.aborted){cleanup();reject(new DOMException('Upload canceled','AbortError'));return;}xhr.send(chunk);
        });break;}catch(error){if(signal.aborted||attempt===2)throw error;}
      }
    }
    return await reframeRequest(`/uploads/${session.id}/complete`,'POST',undefined,signal);
  }catch(error){await reframeRequest(`/uploads/${session.id}`,'DELETE').catch(()=>undefined);throw error;}
}
export const ACTIVE_STATUSES=['PLAYBACK','ANALYZE','PREPARE','PREVIEW','EXPORT','IMPORT'];
export const isProcessing=(s:ReframeSession|null)=>!!s&&ACTIVE_STATUSES.includes(s.status);
/** Readies an upload for the manual crop step (browser playback + whole-frame draft). No AI runs. */
export const preparePlayback=(id:string)=>reframeRequest(`/${id}/playback`,'POST');
/** The local AI pass (speech + on-screen captions). Only allowed after Done Cropping and a chosen mode. */
export const analyzeReframe=(id:string)=>reframeRequest(`/${id}/analyze`,'POST');
export const savePlan=(s:ReframeSession,plan:ReframePlan)=>reframeRequest(`/${s.id}/plan`,'PUT',{revision:s.revision,plan});
export const confirmCrop=(s:ReframeSession)=>reframeRequest(`/${s.id}/confirm-crop`,'POST',{revision:s.revision});
export const revertCrop=(s:ReframeSession)=>reframeRequest(`/${s.id}/revert-crop`,'POST');
/** The automatic looks Quick Reframe can apply to a confirmed crop; Manual is the full editor. */
export type QuickStyleKey='STYLEONE'|'STYLETWO';
export const QUICK_STYLE_LABEL:Record<QuickStyleKey|'MANUAL',string>={STYLEONE:'StyleOne',STYLETWO:'StyleTwo',MANUAL:'Manual'};
export const quickStyleOf=(s:Pick<ReframeSession,'editPath'>|null|undefined):QuickStyleKey|null=>s?.editPath==='STYLEONE'||s?.editPath==='STYLETWO'?s.editPath:null;
type StyleOptions={hookText?:string;captions?:'GENERATE'|'KEEP'|'OFF'};
export const applyQuickStyle=(s:ReframeSession,style:QuickStyleKey,options:StyleOptions={})=>reframeRequest(`/${s.id}/${style==='STYLETWO'?'styletwo':'styleone'}`,'POST',{revision:s.revision,...options});
export const applyStyleOne=(s:ReframeSession,options:StyleOptions={})=>applyQuickStyle(s,'STYLEONE',options);
export const applyStyleTwo=(s:ReframeSession,options:StyleOptions={})=>applyQuickStyle(s,'STYLETWO',options);
export const chooseManual=(s:ReframeSession,removeStyle=false)=>reframeRequest(`/${s.id}/path`,'POST',{revision:s.revision,path:'MANUAL',removeStyle,removeStyleOne:removeStyle});
/** `exclude` (Regenerate): hooks already shown, which are never suggested again. */
export const requestHooks=(id:string,externalAiAuthorized:boolean,exclude:string[]=[],options:{direction?:string;category?:ReframeHookCategory}={})=>reframeRequest<{session:ReframeSession;warnings:string[]}>(`/${id}/hooks`,'POST',{externalAiAuthorized,exclude,...options});
export const generatePostCopy=(s:ReframeSession,options:{externalAiAuthorized:boolean;rewrite?:string;editingDirection?:string;purpose?:string;hashtagsOnly?:boolean})=>reframeRequest<{session:ReframeSession;warnings:string[]}>(`/${s.id}/post-copy`,'POST',{revision:s.revision,version:s.postCopy?.version??0,...options});
export const savePostCopy=(s:ReframeSession,selectedCaption:string,selectedHashtags:string[],captionStyle?:string)=>reframeRequest(`/${s.id}/post-copy`,'PUT',{revision:s.revision,version:s.postCopy?.version??0,selectedCaption,selectedHashtags,...(captionStyle?{captionStyle}:{})});
export const renderReframe=(s:ReframeSession,kind:'preview'|'export',resolution:720|1080=1080)=>reframeRequest(`/${s.id}/${kind}`,'POST',{revision:s.revision,resolution});
export const reframeForProject=(editProjectId:string)=>reframeRequest(`/project/${encodeURIComponent(editProjectId)}`);
export const HOOK_CATEGORY_LABEL:Record<ReframeHookCategory,string>={BOLD:'Bold',CURIOSITY:'Curiosity',QUESTION:'Question',CONTRARIAN:'Contrarian',EMOTIONAL:'Emotional',PROFESSIONAL:'Professional',SARCASTIC:'Sarcastic',HUMOROUS:'Humorous',AUTHORITY:'Authority / Insight',STORY:'Story',WARNING:'Warning',HIDDEN_TRUTH:'Hidden truth',UNEXPECTED_RESULT:'Unexpected result',TENSION:'Tension',CHALLENGE:'Challenge',CONFLICT:'Conflict',MISTAKE:'Mistake',WAIT_UNTIL:'Wait until',MYTH_REALITY:'Myth vs reality',BEFORE_AFTER:'Before / After',REVEAL:'Reveal'};
export const recommendedHook=(hooks:ReframeHook[])=>hooks.find(h=>h.recommended)??hooks[0];
/** Where the wizard should open for a session that already exists. */
export type ReframeStep='crop'|'choose'|'edit'|'export';
export function defaultStep(s:ReframeSession):ReframeStep{
  if(!s.cropConfirmed)return 'crop';
  if(!s.editPath)return 'choose';
  if(s.exports.length&&s.exports[0].current)return 'export';
  return 'edit';
}
export const quickReframeUrl=(id:string,step?:ReframeStep)=>`/quick-reframe?video=${encodeURIComponent(id)}${step?`&step=${step}`:''}`;
export const editorUrl=(s:Pick<ReframeSession,'editProjectId'>,panel?:'hooks'|'post-copy')=>`/edit-mode/${encodeURIComponent(s.editProjectId)}${panel?`?tool=${panel}`:''}`;
