import { getPublicApiBaseUrl } from './api';
export type { ReframeSession, ReframePlan, ReframeRegion, ReframeBox } from '@ai-content-platform/shared';
import type { ReframeSession } from '@ai-content-platform/shared';
export async function reframeRequest<T=ReframeSession>(path='',method='GET',body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(`${getPublicApiBaseUrl()}/quick-reframe${path}`,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal,cache:'no-store'});
  if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(typeof error.message==='string'?error.message:'The video could not be processed. Please retry.');}
  return response.json();
}
export const mediaUrl=(path:string|null)=>path?`${getPublicApiBaseUrl()}${path}`:undefined;
export async function uploadReframe(id:string,file:File,progress:(percent:number)=>void,signal:AbortSignal){
  const session=await reframeRequest<{id:string;chunkBytes:number;chunks:number}>(`/${id}/upload`,'POST',{name:file.name,size:file.size,mimeType:file.type||'video/mp4'},signal);
  try{
    for(let i=0;i<session.chunks;i++){
      const start=i*session.chunkBytes,chunk=file.slice(start,Math.min(file.size,start+session.chunkBytes));
      for(let attempt=0;attempt<3;attempt++){
        try{await new Promise<void>((resolve,reject)=>{
          const xhr=new XMLHttpRequest();const abort=()=>xhr.abort();xhr.open('PUT',`${getPublicApiBaseUrl()}/quick-reframe/uploads/${session.id}/chunks/${i}`);xhr.setRequestHeader('Content-Type','application/octet-stream');
          xhr.upload.onprogress=e=>progress(Math.floor((start+e.loaded)/file.size*100));
          const cleanup=()=>signal.removeEventListener('abort',abort);
          xhr.onload=()=>{cleanup();xhr.status>=200&&xhr.status<300?resolve():reject(new Error('Upload interrupted. Please retry.'));};
          xhr.onerror=()=>{cleanup();reject(new Error('Upload interrupted. Please retry.'));};xhr.onabort=()=>{cleanup();reject(new DOMException('Upload canceled','AbortError'));};
          signal.addEventListener('abort',abort,{once:true});if(signal.aborted){cleanup();reject(new DOMException('Upload canceled','AbortError'));return;}xhr.send(chunk);
        });break;}catch(error){if(signal.aborted||attempt===2)throw error;}
      }
    }
    return await reframeRequest(`/${'uploads'}/${session.id}/complete`,'POST',undefined,signal);
  }catch(error){await reframeRequest(`/uploads/${session.id}`,'DELETE').catch(()=>undefined);throw error;}
}
