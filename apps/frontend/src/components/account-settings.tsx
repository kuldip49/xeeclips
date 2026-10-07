'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from './auth-provider';
export function AccountSettings() {
  const { user, preferences, logout } = useAuth(); const [name, setName] = useState(user?.displayName ?? ''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  async function save(v: { displayName?: string; aiProcessingConsent?: boolean }) { setBusy(true); try { await preferences(v); setMessage('Saved.'); } catch (e) { setMessage(e instanceof Error ? e.message : 'Please try again.'); } finally { setBusy(false); } }
  return <section className='mt-6 grid gap-5 rounded-2xl border border-border bg-surface p-5'><h2 className='font-display text-lg font-semibold'>Your account</h2><p className='text-soft'>{user?.email}</p>
    <label className='grid gap-2 text-sm'>Name<input value={name} onChange={e => setName(e.target.value)} maxLength={100} className='rounded-xl border border-border bg-inset p-3'/></label><button disabled={busy} onClick={() => void save({ displayName: name })} className='btn-primary min-h-11 rounded-xl px-4'>Save name</button>
    <p>{user?.role === 'ADMIN' ? 'Unlimited generations' : `${user?.creditBalance ?? 0} credits remaining`}</p>
    <label className='flex items-start gap-3 text-sm'><input type='checkbox' disabled={busy} checked={!!user?.aiProcessingConsentAt} onChange={e => void save({ aiProcessingConsent: e.target.checked })} className='mt-1 accent-primary'/><span>Allow Ask AI to process my prompts and relevant clip content. You can revoke this permission at any time.</span></label>
    {message && <p role='status' className='text-sm text-soft'>{message}</p>}{user?.role === 'ADMIN' && <Link href='/admin' className='text-primary-soft'>Open Admin</Link>}<button onClick={() => void logout()} className='min-h-11 rounded-xl border border-border px-4'>Log out</button></section>;
}
