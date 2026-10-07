'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, Download, History, Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isProcessing, mediaUrl, renderReframe, type ReframeSession } from '@/lib/quick-reframe-api';
import { cn } from '@/lib/utils';

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
const ratio = (w: number, h: number) => { const known: Array<[number, string]> = [[9 / 16, '9:16'], [16 / 9, '16:9'], [1, '1:1'], [4 / 5, '4:5']];
  const hit = known.find(([r]) => Math.abs(r - w / h) < 0.01); if (hit) return hit[1]; const d = gcd(w, h); return `${w / d}:${h / d}`; };
/** H.264 at the renderer's quality setting averages roughly 0.08 bits per pixel per frame; AAC adds 128 kbps. */
const estimateMb = (w: number, h: number, seconds: number, audio: boolean) => Math.max(1, Math.round((w * h * 30 * 0.08 + (audio ? 128000 : 0)) * seconds / 8 / 1e6));

/** One export process for both paths: final preview, details, quality, a verified MP4 and History. */
export function ExportStep({ session, onSession, onBack, onError }: {
  session: ReframeSession; onSession: (s: ReframeSession) => void; onBack: () => void; onError: (message: string) => void;
}) {
  const [quality, setQuality] = useState<720 | 1080>(1080);
  const [busy, setBusy] = useState(false);
  const processing = isProcessing(session);
  const exporting = session.status === 'EXPORT';
  const latest = session.exports[0];
  const done = !!latest && latest.current && !processing;
  const previewCurrent = !!session.previewUrl && session.previewRevision === session.revision;
  const out = session.outputs?.[quality];
  const run = async (kind: 'preview' | 'export') => { setBusy(true);
    try { onSession(await renderReframe(session, kind, quality)); } catch (error) { onError(error instanceof Error ? error.message : 'Rendering could not start.'); } finally { setBusy(false); } };
  const playing = done ? latest.url : previewCurrent ? session.previewUrl : null;
  return <div className='grid min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_340px] md:items-start'>
    <div className='grid min-w-0 gap-2'>
      {/* The video fills the box absolutely: a percentage height inside a centred grid does not resolve,
          which let a 1080x1920 export overflow and show only its middle band. */}
      <div className='relative mx-auto grid w-full place-items-center overflow-hidden rounded-2xl bg-black' style={{ height: 'min(64vh, 680px)' }} data-testid='export-preview'>
        {playing && !processing ? <video key={playing} src={mediaUrl(playing)} controls playsInline preload='metadata' className='absolute inset-0 h-full w-full object-contain' aria-label={done ? 'Exported video' : 'Final preview'} />
          : <div className='grid justify-items-center gap-3 p-6 text-center text-sm text-muted-foreground'>
            {processing ? <><Loader2 className='animate-spin text-primary-soft' />{session.message}<progress className='w-48 accent-primary' max={100} value={session.progress} /></>
              : <><p>Render a final preview to check your edit before exporting.</p><Button type='button' variant='secondary' disabled={busy} onClick={() => void run('preview')}><Play size={15} />Render preview</Button></>}
          </div>}
      </div>
      <p className='text-center text-xs text-muted-foreground'>{done ? `Exported ${latest.width} × ${latest.height}` : previewCurrent ? 'Final preview · same layout, text and colors as the export' : ' '}</p>
    </div>
    <aside className='grid min-w-0 content-start gap-4 rounded-2xl border border-border bg-surface p-5'>
      <h2 className='font-display text-lg font-semibold'>Export video</h2>
      <dl className='grid grid-cols-2 gap-x-3 gap-y-2 text-sm'>
        <dt className='text-muted-foreground'>Duration</dt><dd className='text-right tabular-nums'>{clock(done && latest.duration ? latest.duration : session.duration)}</dd>
        <dt className='text-muted-foreground'>Resolution</dt><dd className='text-right tabular-nums'>{out ? `${out.width} × ${out.height}` : '—'}</dd>
        <dt className='text-muted-foreground'>Aspect ratio</dt><dd className='text-right'>{out ? ratio(out.width, out.height) : '—'}</dd>
        <dt className='text-muted-foreground'>Format</dt><dd className='text-right'>MP4 · H.264{session.hasAudio ? ' · AAC' : ''}</dd>
        <dt className='text-muted-foreground'>Estimated size</dt><dd className='text-right tabular-nums'>{out ? `≈ ${estimateMb(out.width, out.height, session.duration, session.hasAudio)} MB` : '—'}</dd>
        <dt className='text-muted-foreground'>Editing path</dt><dd className='text-right'>{session.editPath === 'STYLEONE' ? 'StyleOne' : 'Manual'}</dd>
      </dl>
      <fieldset className='grid gap-2'><legend className='mb-2 text-xs font-semibold uppercase tracking-wider text-soft'>Quality</legend>
        <div className='grid grid-cols-2 gap-2'>{([720, 1080] as const).map((q) => <button key={q} type='button' aria-pressed={quality === q} disabled={processing}
          onClick={() => setQuality(q)} className={cn('min-h-12 rounded-xl border text-sm font-semibold', quality === q ? 'border-primary/60 bg-primary/15' : 'border-border hover:bg-tint')}>{q}p</button>)}</div>
      </fieldset>
      {done ? <div className='grid gap-2'>
        <p className='flex items-center gap-2 text-sm text-success'><Check size={16} />Your video is ready and saved in History.</p>
        <Button type='button' size='lg' className='h-12' asChild><a href={`${mediaUrl(latest.url)}?download=1`} download data-testid='download-video'><Download size={16} />Download Video</a></Button>
        <Button type='button' variant='secondary' asChild><Link href='/history'><History size={15} />Open History</Link></Button>
        <Button type='button' variant='ghost' disabled={busy} onClick={() => void run('export')}>Export again at {quality}p</Button>
      </div> : <Button type='button' size='lg' className='h-12' disabled={busy || processing} onClick={() => void run('export')} data-testid='export-video'>
        {exporting ? <Loader2 size={16} className='animate-spin' /> : <Download size={16} />}{exporting ? 'Exporting…' : `Export ${quality}p`}</Button>}
      {latest && !latest.current && !processing && <p className='text-xs text-muted-foreground'>An earlier export is in History. Export again to include your latest edits.</p>}
      <Button type='button' variant='ghost' className='justify-start' disabled={processing} onClick={onBack}><ArrowLeft size={15} />Back to editing</Button>
    </aside>
  </div>;
}
