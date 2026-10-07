'use client';
import { useEffect, useState } from 'react';
import { getPublicApiBaseUrl } from '@/lib/api';
import { HOOK_CATEGORY_LABEL, type ReframeHook } from '@/lib/quick-reframe-api';
import { Button } from '@/components/ui/button';
import type { EditProject } from '@/lib/edit-mode-types';
export function EditorSuggestedHooks({project,busy,onApply}:{project:EditProject;busy:boolean;onApply:(text:string)=>void}) {
  const [hooks,setHooks] = useState<ReframeHook[]>([]), [loading,setLoading] = useState(false);
  const [external,setExternal] = useState(false), [category,setCategory] = useState(''), [direction,setDirection] = useState('Rewrite'), [message,setMessage] = useState('');
  const [copy,setCopy] = useState<{synopsis?:string;captions?:Array<{text:string;style:string;recommended:boolean}>;hashtagSets?:Array<{label:string;hashtags:string[]}>}>({});
  useEffect(()=>{
    const stored=project.settings.contentIntelligence as {contextRevision?:number;copyRevision?:number;hooks?:ReframeHook[]} & typeof copy | undefined;
    setHooks(stored?.contextRevision===project.revision ? stored.hooks ?? [] : []);
    setCopy(stored?.copyRevision===project.revision ? stored : {});
  },[project.id,project.revision,project.settings.contentIntelligence]);
  const generate = async (hooksOnly=true) => {
    setLoading(true);setMessage('');
    try {
      const r = await fetch(`${getPublicApiBaseUrl()}/edit-mode/projects/${project.id}/hooks`, {method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({revision:project.revision,externalAiAuthorized:external,category,direction,hooksOnly,exclude:hooksOnly?hooks.map(h=>h.text):[]})});
      const data=await r.json();if(!r.ok)throw new Error(data.message || 'Hook suggestions are unavailable.');
      setHooks(data.package.hooks);setMessage(data.warnings.join(' '));
      if(!hooksOnly)setCopy(data.package);
    } catch(e) {setMessage(e instanceof Error ? e.message : 'Hook suggestions are unavailable.');} finally {setLoading(false);}
  };
  return <section aria-label='Suggested Hooks' className='grid gap-3'>
    <h3 className='text-sm font-semibold'>Suggested Hooks</h3>
    <label className='grid gap-1 text-xs'>Category<select className='min-h-10 rounded-lg border border-border bg-background px-2' value={category} onChange={e=>setCategory(e.target.value)}>
      <option value=''>All suitable tones</option>{Object.entries(HOOK_CATEGORY_LABEL).map(([value,label])=><option key={value} value={value}>{label}</option>)}
    </select></label>
    <label className='grid gap-1 text-xs'>Rewrite<select className='min-h-10 rounded-lg border border-border bg-background px-2' value={direction} onChange={e=>setDirection(e.target.value)}>
      {['Rewrite','Stronger / bolder','Funnier','More sarcastic','More professional','Shorter'].map(value=><option key={value}>{value}</option>)}
    </select></label>
    <label className='flex gap-2 text-xs text-muted-foreground'><input type='checkbox' checked={external} onChange={e=>setExternal(e.target.checked)} />Use OpenAI for this request (sends relevant retained video text and context).</label>
    <Button disabled={busy || loading} onClick={()=>void generate()}>{loading?'Writing suggestions…':hooks.length?'Regenerate':'Suggest hooks'}</Button>
    <Button disabled={busy || loading} onClick={()=>void generate(false)}>Write post copy</Button>
    {message && <p role='status' className='text-xs text-warning-soft'>{message}</p>}
    {hooks.map(h=><div key={h.text} className='grid gap-2 rounded-xl border border-border p-3'>
      <p className='text-xs text-muted-foreground'>{HOOK_CATEGORY_LABEL[h.category]}{h.recommended?' · Recommended':''}</p><p className='text-sm'>{h.text}</p>
      <Button size='sm' disabled={busy} onClick={()=>onApply(h.text)}>Apply</Button>
    </div>)}
    {copy.synopsis && <p className='text-xs text-muted-foreground'>{copy.synopsis}</p>}
    {copy.captions?.map(c=><div key={c.style} className='grid gap-2 rounded-xl border border-border p-3'>
      <p className='text-xs text-muted-foreground'>{c.style}{c.recommended?' · Recommended':''}</p><p className='whitespace-pre-wrap text-sm'>{c.text}</p>
      <Button size='sm' onClick={()=>void navigator.clipboard.writeText(c.text).catch(()=>setMessage('Copy is unavailable. Select the text above.'))}>Copy caption</Button>
    </div>)}
    {copy.hashtagSets?.map(s=><div key={s.label} className='grid gap-2 text-xs'><span>{s.label}</span><p className='break-words'>{s.hashtags.join(' ')}</p>
      <Button size='sm' onClick={()=>void navigator.clipboard.writeText(s.hashtags.join(' ')).catch(()=>setMessage('Copy is unavailable. Select the text above.'))}>Copy hashtags</Button></div>)}
  </section>;
}
