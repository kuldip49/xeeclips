'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { isProcessing, setReframeMode, type ReframeMode, type ReframeSession } from '@/lib/quick-reframe-api';

/** The saved project mode drives every intelligence surface, including the full editor. */
export function ReframeModeSelector({ session, onSession, busy = false, offerFree = false }: {
  session: ReframeSession; onSession: (session: ReframeSession) => void; busy?: boolean; offerFree?: boolean;
}) {
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const choose = async (mode: ReframeMode) => {
    setSaving(true); setError('');
    try { onSession(await setReframeMode(session, mode)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Your mode could not be saved.'); }
    finally { setSaving(false); }
  };
  const disabled = busy || saving || isProcessing(session);
  return <section aria-label='Processing mode' className='grid min-w-0 gap-2'>
    <div role='group' aria-label='Choose XeeFree or XeePro' className='grid grid-cols-2 gap-2'>
      {(['XEEFREE', 'XEEPRO'] as const).map(mode => <Button key={mode} type='button'
        aria-pressed={(session.mode ?? 'XEEFREE') === mode} disabled={disabled}
        variant={(session.mode ?? 'XEEFREE') === mode ? 'default' : 'secondary'}
        className='min-h-11' onClick={() => void choose(mode)}>{mode === 'XEEFREE' ? 'XeeFree' : 'XeePro'}</Button>)}
    </div>
    <p className='text-xs text-muted-foreground'>{session.mode === 'XEEPRO'
      ? 'Advanced online reasoning. Full editing and export.' : 'Local intelligence. Full editing and export.'}</p>
    {(offerFree || session.errorCode === 'XEEPRO_BUSY') && session.mode === 'XEEPRO' && <Button type='button'
      variant='secondary' disabled={disabled} onClick={() => void choose('XEEFREE')}>Use XeeFree</Button>}
    {error && <p role='alert' className='text-xs text-warning-soft'>{error}</p>}
  </section>;
}
