'use client';
import { useState } from 'react';
import { ArrowLeft, Captions, Loader2, SlidersHorizontal, Sparkles, Wand2 } from 'lucide-react';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import { mediaUrl, type ReframeSession } from '@/lib/quick-reframe-api';
import { cn } from '@/lib/utils';

export type ChooseAction = { kind: 'STYLEONE' } | { kind: 'MANUAL'; removeStyleOne: boolean };

/**
 * "How would you like to edit your video?" Shown only after the crop is confirmed. Switching from an
 * existing composition always asks first, and every switch is one undoable editor revision.
 */
export function ChooseStep({ session, busy, onChoose, onBack }: {
  session: ReframeSession; busy: boolean; onChoose: (action: ChooseAction) => void; onBack: () => void;
}) {
  const [confirm, setConfirm] = useState<'TO_STYLEONE' | 'TO_MANUAL' | null>(null);
  const captionsNote = session.analysis?.subtitleState === 'EXISTING_READABLE' ? 'Captions detected in your video. They are kept and no duplicates are added.'
    : session.analysis?.subtitleState === 'MISSING' ? (session.hasTranscript ? 'No captions detected. StyleOne adds synchronized captions from the speech.' : 'No speech was found, so no captions are added.')
      : 'Some text may already be captions. You can review captions before export.';
  const styleOne = () => { if (session.editPath === 'MANUAL') setConfirm('TO_STYLEONE'); else onChoose({ kind: 'STYLEONE' }); };
  const manual = () => { if (session.styleOneApplied) setConfirm('TO_MANUAL'); else onChoose({ kind: 'MANUAL', removeStyleOne: false }); };
  const card = 'group grid min-w-0 content-start gap-4 rounded-2xl border bg-surface p-5 text-left transition-colors sm:p-6';
  return <div className='grid min-w-0 gap-6'>
    <div className='grid gap-4 md:grid-cols-[180px_minmax(0,1fr)] md:items-center'>
      <div className='mx-auto w-40 overflow-hidden rounded-xl bg-black md:mx-0 md:w-full'>
        <video src={mediaUrl(session.sourceUrl)} muted playsInline preload='metadata' controls aria-label='Cropped video' className='h-auto max-h-56 w-full object-contain' />
      </div>
      <div className='grid gap-2 text-center md:text-left'>
        <h2 className='font-display text-2xl font-bold tracking-tight sm:text-3xl'>How would you like to edit your video?</h2>
        <p className='text-sm text-muted-foreground'>Your crop is saved. Both options keep the full video and its original sound.</p>
        <p className='flex items-start justify-center gap-2 text-xs text-muted-foreground md:justify-start'><Captions size={14} className='mt-0.5 shrink-0 text-primary-soft' />{captionsNote}</p>
      </div>
    </div>
    <div className='grid min-w-0 gap-4 md:grid-cols-2'>
      <div className={cn(card, session.editPath === 'STYLEONE' ? 'border-primary/60' : 'border-border')}>
        <span className='grid h-12 w-12 place-items-center rounded-2xl bg-primary/15 text-primary-soft'><Wand2 size={22} /></span>
        <div className='grid gap-2'><p className='eyebrow'>Option A · Automatic</p><h3 className='font-display text-xl font-semibold'>StyleOne</h3>
          <p className='text-sm text-muted-foreground'>Let XeeClip automatically create a polished video with professional hooks, captions, framing and styling.</p></div>
        <ul className='grid gap-1 text-xs text-muted-foreground'><li>· Fixed 1080 × 1920 black canvas and media window</li><li>· Serif hook written from your video</li><li>· Active-word captions when your video has none</li></ul>
        <Button type='button' size='lg' disabled={busy} onClick={styleOne} data-testid='choose-styleone'>{busy ? <Loader2 size={16} className='animate-spin' /> : <Sparkles size={16} />}Apply StyleOne</Button>
      </div>
      <div className={cn(card, session.editPath === 'MANUAL' ? 'border-primary/60' : 'border-border')}>
        <span className='grid h-12 w-12 place-items-center rounded-2xl bg-secondary/15 text-secondary-soft'><SlidersHorizontal size={22} /></span>
        <div className='grid gap-2'><p className='eyebrow'>Option B · You decide</p><h3 className='font-display text-xl font-semibold'>Manual Editing</h3>
          <p className='text-sm text-muted-foreground'>Edit the video yourself with suggested hooks, captions, filters, colors, and professional editing tools.</p></div>
        <ul className='grid gap-1 text-xs text-muted-foreground'><li>· The full XeeClip editor and timeline</li><li>· AI-suggested hooks in six styles</li><li>· Filters, color, audio, text, overlays, undo</li></ul>
        <Button type='button' size='lg' variant='secondary' disabled={busy} onClick={manual} data-testid='choose-manual'><SlidersHorizontal size={16} />Open Manual Editor</Button>
      </div>
    </div>
    <div><Button type='button' variant='ghost' disabled={busy} onClick={onBack}><ArrowLeft size={16} />Back to crop</Button></div>

    <BottomSheet open={confirm === 'TO_STYLEONE'} onClose={() => setConfirm(null)} title='Apply StyleOne over your edits?' desktopWidth='md:max-w-md'>
      <p className='text-sm leading-6 text-muted-foreground'>StyleOne replaces your current hook, caption style, framing and layout with its fixed design. Your crop, video and sound stay the same.
        A checkpoint is saved: press Undo in the editor to restore your manual version.</p>
      <div className='mt-5 grid grid-cols-2 gap-2'><Button type='button' variant='secondary' className='h-11' onClick={() => setConfirm(null)}>Keep my edits</Button>
        <Button type='button' className='h-11' onClick={() => { setConfirm(null); onChoose({ kind: 'STYLEONE' }); }}>Apply StyleOne</Button></div>
    </BottomSheet>
    <BottomSheet open={confirm === 'TO_MANUAL'} onClose={() => setConfirm(null)} title='Edit manually' desktopWidth='md:max-w-md'>
      <p className='text-sm leading-6 text-muted-foreground'>Your video already has StyleOne. Keep it and refine it in the editor, or start from the clean cropped video. Removing StyleOne is saved as a checkpoint you can undo.</p>
      <div className='mt-5 grid gap-2'><Button type='button' className='h-11' onClick={() => { setConfirm(null); onChoose({ kind: 'MANUAL', removeStyleOne: false }); }}>Keep StyleOne and edit</Button>
        <Button type='button' variant='secondary' className='h-11' onClick={() => { setConfirm(null); onChoose({ kind: 'MANUAL', removeStyleOne: true }); }}>Start from the cropped video</Button>
        <Button type='button' variant='ghost' className='h-11' onClick={() => setConfirm(null)}>Cancel</Button></div>
    </BottomSheet>
  </div>;
}
