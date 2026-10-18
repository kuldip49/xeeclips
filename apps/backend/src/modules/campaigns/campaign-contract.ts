import { BadRequestException, ConflictException, Injectable, PipeTransform } from '@nestjs/common';

@Injectable()
export class CampaignBodyPipe implements PipeTransform {
  transform(value:unknown){if(!value||typeof value!=='object'||Array.isArray(value))throw new BadRequestException({code:'CAMPAIGN_INVALID_INPUT',message:'A request object is required.'});return value;}
}

export function campaignText(value: unknown, name: string, max: number, optional = true): string {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) {
    throw new BadRequestException({code:'CAMPAIGN_INVALID_INPUT',message:`${name} must be text of at most ${max} characters.`});
  }
  const result = value.trim();
  if (!optional && !result) throw new BadRequestException({code:'CAMPAIGN_INVALID_INPUT',message:`${name} is required.`});
  return result;
}

export function campaignPage(input: {limit?: unknown; offset?: unknown} = {}, defaultLimit = 50) {
  const number = (value: unknown, fallback: number, max: number, name: string) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' && typeof value !== 'number' || !/^\d+$/.test(String(value))) throw new BadRequestException(`Invalid ${name}.`);
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n > max) throw new BadRequestException(`Invalid ${name}.`);
    return n;
  };
  const take=number(input.limit,defaultLimit,100,'limit'), skip=number(input.offset,0,1000000,'offset');
  if (take < 1) throw new BadRequestException('Limit must be 1–100.');
  return {take,skip};
}

export function campaignConflict(message = 'The campaign, edit or social copy changed. Refresh and review the current version.') {
  return new ConflictException({code:'CAMPAIGN_STATE_CHANGED',message});
}

export const objectValue=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
export const postDto=(p:any)=>p?{campaignClipId:p.campaignClipId,platform:p.platform,postedAt:p.postedAt,postUrl:p.postUrl,views:p.views,likes:p.likes,comments:p.comments,shares:p.shares,earnings:p.earnings.toFixed?.(2)??String(p.earnings),currency:p.currency,notes:p.notes,updatedAt:p.updatedAt}:null;
export const runDto=(r:any)=>({id:r.id,campaignId:r.campaignId,sourceId:r.sourceId,requestKey:r.requestKey,mode:r.mode,style:r.style,requestedClipCount:r.requestedClipCount,briefVersion:r.briefVersion,status:r.status,error:r.errorCode==='XEEPRO_BUSY'?'XeePro is busy right now. Try XeeFree or try again later.':r.errorCode==='NO_CREDITS'?'No generations remaining.':r.error?'Campaign processing could not finish. Review the source and campaign requirements, then retry.':null,errorCode:r.errorCode?['XEEPRO_BUSY','NO_CREDITS'].includes(r.errorCode)?r.errorCode:'CAMPAIGN_RUN_FAILED':null,createdAt:r.createdAt,updatedAt:r.updatedAt});
export const campaignDto=(c:any)=>({id:c.id,projectId:c.projectId,name:c.name,description:c.description,status:c.status,platforms:c.platforms,payoutDescription:c.payoutDescription,deadline:c.deadline,defaultClipCount:c.defaultClipCount,createdAt:c.createdAt,updatedAt:c.updatedAt,...(c.brief!==undefined?{brief:c.brief}:{}),...(c._count?{_count:c._count}:{})});

/** Explicit public DTO: ORM relations contain storage paths, transcripts and provider telemetry. */
export function clipDto(c:any, renders:any[]=[]){
  const latest=renders.find(e=>e.current)??renders[0], previewUrl=latest?`/edit-mode/assets/${latest.id}/file`:null;
  const creative=objectValue(objectValue(c.generatedClip?.contentPackaging).sharedPackage);
  return {id:c.id,campaignId:c.campaignId,runId:c.runId,generatedClipId:c.generatedClipId,editProjectId:c.editProjectId,
    campaignName:c.campaign.name,title:objectValue(c.generatedClip?.editTelemetry).hookFinalText||creative.selectedHook||c.generatedClip?.candidate?.title||c.campaign.name,
    mode:c.mode,style:c.style,lifecycleStatus:c.lifecycleStatus,compliance:c.compliance,complianceStatus:c.complianceStatus,complianceScore:c.complianceScore,
    checkedRevision:c.checkedRevision,checkedBriefVersion:c.checkedBriefVersion,socialPackage:c.socialPackage,post:postDto(c.post),
    createdAt:c.createdAt,updatedAt:c.updatedAt,exportCurrent:latest?.current===true,previewUrl,downloadUrl:previewUrl?previewUrl+'?download=1':null,
    editorUrl:c.editProjectId?`/edit-mode/${c.editProjectId}`:null};
}
