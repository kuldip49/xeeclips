'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/auth-provider';
import { Button } from '@/components/ui/button';
import { analyzeReframe, generatePostCopy, isProcessing, reframeRequest, savePostCopy, type ReframeSession } from '@/lib/quick-reframe-api';

const field = 'w-full min-w-0 rounded-xl border border-border bg-sunken p-3 text-sm';
const directions = ['Shorter', 'More engaging', 'Professional', 'Casual', 'Stronger opening', 'Cleaner CTA'];
export function PostCopyButtons({ caption, hashtags }: { caption: string; hashtags: string[] }) {
  const [status, setStatus] = useState('');
  const copy = async (value: string) => { try { await navigator.clipboard.writeText(value); setStatus('Copied'); } catch { setStatus('Copy failed. Select and copy the text manually.'); } };
  return <div className='grid min-w-0 gap-2'>
    <div className='flex flex-wrap gap-2'>
      <Button type='button' variant='secondary' disabled={!caption} onClick={() => void copy(caption)}>Copy Caption</Button>
      <Button type='button' variant='secondary' disabled={!hashtags.length} onClick={() => void copy(hashtags.join(' '))}>Copy Hashtags</Button>
      <Button type='button' variant='secondary' disabled={!caption && !hashtags.length} onClick={() => void copy([caption, hashtags.join(' ')].filter(Boolean).join('\n\n'))}>Copy Caption + Hashtags</Button>
    </div><p role='status' className='text-xs text-muted-foreground'>{status}</p>
  </div>;
}
/** One copy-writing tool shared by StyleOne, the canonical editor and export. Never emits a media command. */
export function PostCopyPanel({ session, onSession, busy = false }: { session: ReframeSession; onSession: (s: ReframeSession) => void; busy?: boolean }) {
  const { user } = useAuth();
  const [caption, setCaption] = useState(session.postCopy?.selectedCaption ?? '');
  const [hashtags, setHashtags] = useState<string[]>(session.postCopy?.selectedHashtags ?? []);
  const [variants, setVariants] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false), [loading, setLoading] = useState(false), [warnings, setWarnings] = useState<string[]>([]);
  const [direction, setDirection] = useState('More engaging'), [intent, setIntent] = useState(session.postCopy?.editingDirection ?? ''), [purpose, setPurpose] = useState(session.postCopy?.purpose ?? '');
  const [tag, setTag] = useState(''), [status, setStatus] = useState('');
  const running = isProcessing(session), disabled = busy || loading || running;
  useEffect(() => { setCaption(session.postCopy?.selectedCaption ?? ''); setHashtags(session.postCopy?.selectedHashtags ?? []);
    setVariants(Object.fromEntries((session.postCopy?.generatedCaptions ?? []).map(c => [c.style, c.text])));
  }, [session.id, session.postCopy?.version]); // Polling media status must not replace an unsaved draft.
  useEffect(() => { if (!running) return; const timer = window.setInterval(() => { void reframeRequest(`/${session.id}`).then(onSession).catch(() => undefined); }, 2000);
    return () => clearInterval(timer); }, [running, session.id, onSession]);
  const dirty = caption !== (session.postCopy?.selectedCaption ?? '') || hashtags.join(' ') !== (session.postCopy?.selectedHashtags ?? []).join(' ');
  const persist = async (newCaption = caption, newTags = hashtags, captionStyle?: string) => { const next = await savePostCopy(session, newCaption, newTags, captionStyle); onSession(next); setStatus('Post copy saved'); return next; };
  const action = async (fn: () => Promise<unknown>) => { setLoading(true); setWarnings([]); setStatus(''); try { await fn(); } catch (error) {
    setWarnings([error instanceof Error ? error.message : 'Post copy could not be saved.']);
    // Reload the authoritative copy version after a conflict before accepting another write.
    const latest = await reframeRequest(`/${session.id}`).catch(() => null); if (latest) onSession(latest);
  } finally { setLoading(false); } };
  const generate = (rewrite?: string, hashtagsOnly = false) => action(async () => { const current = dirty ? await persist() : session;
    const result = await generatePostCopy(current, { externalAiAuthorized: consent, editingDirection: intent, purpose, hashtagsOnly, ...(rewrite ? { rewrite } : {}) });
    onSession(result.session); setWarnings(result.warnings); });
  const useCaption = (value: string, style: string) => action(async () => { setCaption(value); await persist(value, hashtags, style); });
  const addTag = () => { const value = `#${tag.trim().replace(/^#+/u, '')}`;
    if (!/^#[\p{L}\p{N}_]{1,60}$/u.test(value)) { setWarnings(['Use letters, numbers or underscores for a hashtag.']); return; }
    if (hashtags.length >= 15) { setWarnings(['Keep your selection to 15 hashtags.']); return; }
    const next = [...new Map([...hashtags, value].map(t => [t.toLowerCase(), t])).values()];
    void action(async () => { await persist(caption, next); setTag(''); }); };
  const original = session.sourceContext;
  const stale = session.postCopy?.contextRevision !== undefined && session.postCopy.contextRevision !== session.revision;
  if (!session.cropConfirmed || !session.editPath) return null;
  return <section aria-label='Caption & Hashtags' data-testid='post-copy-panel' className='grid min-w-0 gap-4 rounded-2xl border border-border bg-surface p-3 sm:p-4'>
    <div><h2 className='font-display text-lg font-semibold'>Caption &amp; Hashtags</h2><p className='mt-1 text-xs text-muted-foreground'>Social post copy for sharing your finished video. Video Captions are managed separately.</p></div>
    {original && <details className='min-w-0 rounded-xl border border-border p-3'><summary className='cursor-pointer text-sm font-semibold'>Original post caption &amp; hashtags</summary>
      {original.sourcePostText ? <p className='mt-3 whitespace-pre-wrap break-words text-sm'>{original.sourcePostText}</p>
        : <p className='mt-3 text-xs text-muted-foreground'>Post text wasn&apos;t available. XeeClip can still generate a new caption from the video.</p>}
      {!!original.sourceHashtags.length && <p className='mt-3 break-words text-xs text-muted-foreground'>{original.sourceHashtags.join(' ')}</p>}
    </details>}
    {!session.analysis && <div className='grid gap-2 text-xs text-muted-foreground'><p>{running ? 'Checking video speech and on-screen text…' : 'Check the video before generating social copy.'}</p>
      {!running && <Button type='button' variant='secondary' disabled={disabled} onClick={() => void action(async () => onSession(await analyzeReframe(session.id)))}>Check video</Button>}</div>}
    <details><summary className='cursor-pointer text-xs text-muted-foreground'>Editing direction &amp; audience</summary><div className='mt-2 grid gap-2'>
      <label className='grid gap-1 text-xs'>Editing direction<input className={field} maxLength={500} value={intent} onChange={e => setIntent(e.target.value)} placeholder='Emphasize the practical advice' /></label>
      <label className='grid gap-1 text-xs'>Purpose / audience<input className={field} maxLength={500} value={purpose} onChange={e => setPurpose(e.target.value)} placeholder='Who is this video for?' /></label>
    </div></details>
    {user?.aiProcessingConsentAt ? <label className='flex items-start gap-2 text-xs leading-5 text-muted-foreground'><input type='checkbox' className='mt-1' checked={consent} onChange={e => setConsent(e.target.checked)} />Use OpenAI for this request. Send relevant video text, original post copy, hashtags and editing intent.</label>
      : <p className='text-xs text-muted-foreground'>Suggestions use local video text. <Link className='underline' href='/settings'>Enable AI processing in Settings</Link> for richer rewrites.</p>}
    <div className='flex flex-wrap gap-2'><Button type='button' disabled={disabled || !session.analysis} onClick={() => void generate()}>{loading ? 'Working…' : 'Generate social copy'}</Button>
      <Button type='button' variant='secondary' disabled={disabled || !session.analysis} onClick={() => void generate(undefined, true)}>Generate hashtags</Button></div>
    {original?.sourcePostText && <div className='grid gap-2'><label className='grid gap-1 text-xs'>Transform original caption<select aria-label='Rewrite direction' className={field} value={direction} onChange={e => setDirection(e.target.value)}>{directions.map(d => <option key={d}>{d}</option>)}</select></label>
      <Button type='button' variant='secondary' disabled={disabled || !session.analysis} onClick={() => void generate(direction)}>Rewrite original</Button></div>}
    {stale && <p className='text-xs text-warning-soft'>Your video edits changed. Generate again to refresh suggestions for the current edit.</p>}
    {warnings.map((w, i) => <p key={i} role='alert' className='break-words text-xs text-warning-soft'>{w}</p>)}
    {!!session.postCopy?.generatedCaptions.length && <div className='grid min-w-0 gap-3'>{session.postCopy.generatedCaptions.map(c => <article key={c.style} className='grid min-w-0 gap-2 rounded-xl border border-border p-3'>
      <div className='flex flex-wrap items-center gap-2 text-xs font-semibold'><span>{c.style}</span>{c.recommended && <span className='rounded-md bg-primary/15 px-2 py-1 text-primary-soft'>Recommended</span>}</div>
      <textarea aria-label={`${c.style} social caption`} className={field} rows={4} maxLength={2200} value={variants[c.style] ?? c.text} onChange={e => setVariants(v => ({ ...v, [c.style]: e.target.value }))} />
      <div className='flex flex-wrap gap-2'><Button type='button' size='sm' variant='secondary' disabled={disabled} onClick={() => void useCaption(variants[c.style] ?? c.text, c.style)}>Use</Button>
        <Button type='button' size='sm' variant='secondary' onClick={() => void navigator.clipboard.writeText(variants[c.style] ?? c.text).then(() => setStatus('Copied')).catch(() => setStatus('Copy failed. Select the text manually.'))}>Copy</Button></div>
    </article>)}</div>}
    <label className='grid min-w-0 gap-2 text-sm font-semibold'>Selected Social Caption<textarea aria-label='Selected Social Caption' className={field} rows={4} maxLength={2200} value={caption} onChange={e => setCaption(e.target.value)} /></label>
    {!!session.postCopy?.generatedHashtagSets.length && <div className='grid min-w-0 gap-2'>{session.postCopy.generatedHashtagSets.map(set => <div key={set.label} className='grid min-w-0 gap-2 rounded-xl bg-sunken p-3'>
      <p className='text-xs font-semibold'>{set.label}</p><p className='break-words text-xs text-muted-foreground'>{set.hashtags.join(' ')}</p>
      <Button type='button' size='sm' variant='secondary' disabled={disabled} onClick={() => void action(() => persist(caption, set.hashtags))}>Use {set.label}</Button>
    </div>)}</div>}
    <div className='grid min-w-0 gap-2'><p className='text-xs font-semibold'>Selected hashtags</p><div className='flex flex-wrap gap-2'>{hashtags.map(t => <button key={t} type='button' disabled={disabled} aria-label={`Remove ${t}`} className='min-h-11 max-w-full break-all rounded-lg border border-border px-2 text-xs' onClick={() => void action(() => persist(caption, hashtags.filter(v => v !== t)))}>{t} ×</button>)}</div>
      <div className='flex min-w-0 gap-2'><input aria-label='Add hashtag' className={field} maxLength={61} value={tag} onChange={e => setTag(e.target.value)} placeholder='#yourtopic' onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (!disabled) addTag(); } }} />
        <Button type='button' variant='secondary' disabled={disabled || !tag.trim()} onClick={addTag}>Add</Button></div></div>
    <Button type='button' variant='secondary' disabled={disabled || !dirty} onClick={() => void action(() => persist())}>Save post copy</Button>
    <PostCopyButtons caption={caption} hashtags={hashtags} />
    <p role='status' className='text-xs text-muted-foreground'>{dirty ? 'Unsaved post copy — save to restore it from History.' : status}</p>
  </section>;
}
