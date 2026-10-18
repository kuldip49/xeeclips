'use client';
import { CAMPAIGN_LIST_FIELDS, CAMPAIGN_TEXT_FIELDS } from '@ai-content-platform/shared';
import type { StructuredCampaignBrief } from '@/lib/campaign-api';
export const field = 'min-h-11 w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2 text-sm';
export const area = field + ' min-h-24 resize-y';
export const labelOf = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, s => s.toUpperCase()).replace('CTA', 'CTA');
export function BriefEditor({ value, onChange, disabled = false }: {
    value: StructuredCampaignBrief;
    onChange: (v: StructuredCampaignBrief) => void;
    disabled?: boolean;
}) {
    const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });
    return <div className='grid min-w-0 gap-5'>
  <div className='grid gap-3 sm:grid-cols-3'>{(['minDurationSec', 'maxDurationSec'] as const).map(k => <label key={k} className='grid gap-2 text-sm'>{k === 'minDurationSec' ? 'Minimum duration (seconds)' : 'Maximum duration (seconds)'}<input disabled={disabled} className={field} type='number' min='1' max='120' value={value[k] ?? ''} onChange={e => set(k, e.target.value === '' ? null : Number(e.target.value))}/></label>)}<label className='grid gap-2 text-sm'>Aspect ratio<select disabled={disabled} className={field} value={value.aspectRatio ?? ''} onChange={e => set('aspectRatio', e.target.value || null)}><option value=''>No required ratio</option>{['9:16', '16:9', '1:1', '4:5'].map(v => <option key={v}>{v}</option>)}</select></label></div>
  <div className='grid min-w-0 gap-4 sm:grid-cols-2'>{CAMPAIGN_LIST_FIELDS.filter(k => k !== 'unresolvedRules').map(k => <label key={k} className='grid min-w-0 gap-2 text-sm'>{labelOf(k)}<textarea disabled={disabled} className={area} value={value[k].join('\n')} onChange={e => set(k, e.target.value.split('\n'))} placeholder='One rule per line'/></label>)}</div>
  <details className='min-w-0 rounded-xl border border-border p-4' open><summary className='cursor-pointer font-semibold'>Creative, branding and posting rules</summary><div className='mt-4 grid min-w-0 gap-4 sm:grid-cols-2'>{CAMPAIGN_TEXT_FIELDS.map(k => <label key={k} className='grid min-w-0 gap-2 text-sm'>{labelOf(k)}<textarea disabled={disabled} className={area} value={value[k]} onChange={e => set(k, e.target.value)}/></label>)}</div></details>
  <label className='grid gap-2 text-sm text-warning-soft'>Unresolved rules · correct the fields above, then remove each resolved item<textarea disabled={disabled} className={area} value={value.unresolvedRules.join('\n')} onChange={e => set('unresolvedRules', e.target.value.split('\n').filter(Boolean))}/></label>
  {!!value.assetInstructions.length && <div className='grid gap-2 rounded-xl border border-border p-4 text-sm'><p className='font-semibold'>Confirmed asset mappings</p>{value.assetInstructions.map(a => <span key={a.assetId}>{a.use.replaceAll('_', ' ')} · {a.required ? 'Required' : 'Optional'}</span>)}<p className='text-xs text-muted-foreground'>Manage mappings in Assets, then understand and confirm the brief again.</p></div>}
 </div>;
}
