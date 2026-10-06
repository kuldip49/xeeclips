'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bookmark, Loader2, Trash2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { listSavedStyles, type SavedStyle } from '@/lib/creative-generation';

type Capturable = 'CAPTIONS' | 'COLOR';
const LABELS: Record<Capturable, string> = { CAPTIONS: 'Captions', COLOR: 'Colour' };

/**
 * Step 17: save this clip's captions or colour as "My ..." style. A saved style
 * has a stable id; generation offers it under "My styles" and the AI editor
 * resolves "use my usual podcast captions" to that id.
 */
export function EditSavedStyles({ projectId, hasCaptions, busy }: {
  projectId: string; hasCaptions: boolean; busy: boolean;
}) {
  const [styles, setStyles] = useState<SavedStyle[]>([]);
  const [category, setCategory] = useState<Capturable>(hasCaptions ? 'CAPTIONS' : 'COLOR');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  const reload = useCallback(() => listSavedStyles().then(setStyles).catch(() => setStyles([])), []);
  useEffect(() => { void reload(); }, [reload]);

  async function save() {
    if (!name.trim() || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      await apiFetch('/edit-mode/saved-styles', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, name: name.trim(), fromProjectId: projectId }) });
      setMessage({ error: false, text: `Saved "${name.trim()}". Use it when generating, or ask the AI for it.` });
      setName('');
      await reload();
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : 'Could not save the style' });
    } finally { setSaving(false); }
  }

  async function remove(id: string) {
    await apiFetch(`/edit-mode/saved-styles/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
    await reload();
  }

  const mine = styles.filter((style) => style.category === 'CAPTIONS' || style.category === 'COLOR');
  return <section data-testid='saved-styles' className='grid min-w-0 gap-2 border-t border-border pt-4'>
    <h3 className='flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground'>
      <Bookmark size={12} aria-hidden />My styles</h3>
    <p className='text-[11px] leading-relaxed text-faint'>Save this clip’s look as a reusable style.</p>
    <div className='flex gap-1.5'>
      <select aria-label='Style to save' value={category} disabled={busy || saving}
        onChange={(event) => setCategory(event.target.value as Capturable)}
        className='h-8 rounded-md border border-border bg-inset px-1.5 text-[11px] text-soft'>
        {(Object.keys(LABELS) as Capturable[]).map((value) =>
          <option key={value} value={value} disabled={value === 'CAPTIONS' && !hasCaptions}>{LABELS[value]}</option>)}
      </select>
      <input aria-label='Style name' value={name} maxLength={60} disabled={busy || saving}
        onChange={(event) => setName(event.target.value)} placeholder={`My ${LABELS[category].toLowerCase()}`}
        onKeyDown={(event) => { if (event.key === 'Enter') void save(); }}
        className='h-8 min-w-0 flex-1 rounded-md border border-border bg-inset px-2 text-[11px] text-soft' />
      <button type='button' onClick={() => void save()} disabled={busy || saving || !name.trim()}
        className='h-8 rounded-md bg-primary/80 px-2.5 text-[11px] font-semibold text-foreground disabled:opacity-40'>
        {saving ? <Loader2 size={12} className='animate-spin' /> : 'Save'}</button>
    </div>
    {message ? <p role={message.error ? 'alert' : 'status'}
      className={`text-[11px] ${message.error ? 'text-danger' : 'text-success'}`}>{message.text}</p> : null}
    {mine.length ? <ul className='grid gap-1'>
      {mine.map((style) => <li key={style.id} className='flex items-center justify-between gap-2 rounded-md bg-tint-subtle px-2 py-1 text-[11px]'>
        <span className='min-w-0 truncate text-soft'>{style.name} <span className='text-faint'>· {LABELS[style.category as Capturable]}</span></span>
        <button type='button' aria-label={`Delete ${style.name}`} disabled={busy} onClick={() => void remove(style.id)}
          className='text-faint hover:text-danger'><Trash2 size={12} /></button>
      </li>)}
    </ul> : null}
  </section>;
}
