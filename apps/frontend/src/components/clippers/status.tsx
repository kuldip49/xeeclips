import { CheckCircle2, CircleHelp, CircleMinus, TriangleAlert, XCircle } from 'lucide-react';

const states = {
  PASS: {label:'Meets requirement', icon:CheckCircle2, color:'text-success'},
  WARN: {label:'Review needed', icon:TriangleAlert, color:'text-warning-soft'},
  FAIL: {label:'Needs a fix', icon:XCircle, color:'text-danger'},
  UNKNOWN: {label:'Not yet verified', icon:CircleHelp, color:'text-warning-soft'},
  NOT_APPLICABLE: {label:'Not required', icon:CircleMinus, color:'text-muted-foreground'}
};
export function ComplianceStatus({status}:{status:string}) {
  const state=states[status as keyof typeof states]??states.UNKNOWN, Icon=state.icon;
  return <span className={'inline-flex items-center gap-1.5 text-xs font-semibold '+state.color}><Icon size={14} aria-hidden/>{state.label}</span>;
}
export const campaignState = (value:string) => ({DRAFT:'Draft',ACTIVE:'Active',PAUSED:'Paused',COMPLETED:'Completed',ARCHIVED:'Archived',QUEUED:'Queued',STARTING:'Starting',GENERATING:'Creating clips',PREPARING:'Preparing export',FAILED:'Could not finish',PENDING:'Waiting',PROCESSING:'Analyzing source'} as Record<string,string>)[value]??'Needs review';
export const checkLabel=(value:string)=>({LOGO:'Logo',CTA:'Call to action',FORBIDDEN_CTA:'Avoided call to action',IMAGE:'Campaign image',MUSIC:'Music',ASPECT_RATIO:'Video shape',UNKNOWN_RULE:'Unresolved instructions',BRIEF_CONFIRMATION:'Campaign confirmation',CANONICAL_PROJECT:'Video project'} as Record<string,string>)[value]??value.toLowerCase().replaceAll('_',' ').replace(/^./,s=>s.toUpperCase());
