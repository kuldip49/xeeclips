'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { useAuth } from './auth-provider';
import { BrandMark } from './brand';
export function AuthForm({ signup = false }: { signup?: boolean }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const router = useRouter(); const { refresh } = useAuth();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError(''); const data = new FormData(e.currentTarget);
    try { await apiFetch('/auth/' + (signup ? 'signup' : 'login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: data.get('email'), password: data.get('password'), displayName: data.get('displayName') }) }); await refresh(); router.replace('/'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Please try again.'); } finally { setBusy(false); }
  }
  return <div className='mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-12'><Link href='/' className='mb-8 flex items-center justify-center gap-3 font-display text-xl font-bold'><BrandMark className='h-11 w-11 rounded-xl'/>XeeClip</Link>
    <form onSubmit={submit} className='grid gap-5 rounded-2xl border border-border bg-surface p-6 shadow-card'><h1 className='font-display text-2xl font-bold'>{signup ? 'Create your account' : 'Welcome back'}</h1>
      {signup && <label className='grid gap-2 text-sm'>Name<input name='displayName' autoComplete='name' maxLength={100} className='input h-12 rounded-xl border border-border bg-inset px-3'/></label>}
      <label className='grid gap-2 text-sm'>Email<input required name='email' type='email' autoComplete='email' maxLength={254} className='h-12 rounded-xl border border-border bg-inset px-3'/></label>
      <label className='grid gap-2 text-sm'>Password<input required name='password' type='password' minLength={8} maxLength={128} autoComplete={signup ? 'new-password' : 'current-password'} className='h-12 rounded-xl border border-border bg-inset px-3'/>{signup && <span className='text-xs text-muted-foreground'>8 to 128 characters.</span>}</label>
      {error && <p role='alert' className='text-sm text-danger'>{error}</p>}<button disabled={busy} className='btn-primary min-h-12 rounded-xl font-semibold disabled:opacity-50'>{busy ? 'Please wait…' : signup ? 'Create account' : 'Log in'}</button>
      <Link href={signup ? '/login' : '/signup'} className='text-center text-sm text-primary-soft'>{signup ? 'Already have an account? Log in' : 'Create an account'}</Link>
    </form></div>;
}
