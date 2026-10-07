'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import { BrandMark } from './brand';
export type Account = { id: string; email: string; displayName: string; role: 'USER' | 'ADMIN'; creditBalance: number; creditsConsumed: number; aiProcessingConsentAt: string | null };
const Context = createContext<{ user: Account | null; refresh: () => Promise<void>; logout: () => Promise<void>; preferences: (v: { displayName?: string; aiProcessingConsent?: boolean }) => Promise<void> }>({ user: null, refresh: async () => {}, logout: async () => {}, preferences: async () => {} });
export const useAuth = () => useContext(Context);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Account | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const path = usePathname(); const router = useRouter();
  const refresh = useCallback(async () => {
    try { setUser(await apiFetch<Account>('/auth/session')); setError(''); }
    catch (e) { if (e instanceof ApiError && e.status === 401) { setUser(null); setError(e.message.includes('unavailable') ? e.message : ''); } else { setError('Account service is unavailable. Please try again.'); } }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh(); const timer = setInterval(() => void refresh(), 15000);
    const focus = () => void refresh(); const expired = () => { setUser(null); };
    const hide = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', focus); window.addEventListener('pageshow', focus); window.addEventListener('xeeclip-auth-expired', expired); document.addEventListener('visibilitychange', hide);
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); window.removeEventListener('pageshow', focus); window.removeEventListener('xeeclip-auth-expired', expired); document.removeEventListener('visibilitychange', hide); };
  }, [refresh]);
  const publicRoute = path === '/login' || path === '/signup';
  useEffect(() => { if (!loading && !user && !publicRoute && path !== '/') router.replace('/login'); }, [loading, user, path, publicRoute, router]);
  const logout = async () => { await apiFetch('/auth/logout', { method: 'POST' }); setUser(null); router.replace('/login'); };
  const preferences = async (v: { displayName?: string; aiProcessingConsent?: boolean }) => { setUser(await apiFetch<Account>('/auth/preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) })); };
  let content: ReactNode;
  if (loading) content = <div className='grid min-h-screen place-items-center bg-background text-soft'>Loading your account…</div>;
  else if (error && !user && !publicRoute) content = <div className='grid min-h-screen place-content-center gap-4 p-6 text-center'><p role='alert'>{error}</p><button className='btn-primary rounded-xl p-3' onClick={() => void refresh()}>Try again</button></div>;
  else if (publicRoute || user && (!path.startsWith('/admin') || user.role === 'ADMIN')) content = <div key={user?.id ?? 'public'}>{children}</div>;
  else if (user) content = <div className='grid min-h-screen place-content-center gap-4 text-center'><p>Administrator access required.</p><Link href='/' className='text-primary-soft'>Back to Create</Link></div>;
  else content = <div className='mx-auto grid min-h-screen max-w-xl place-content-center gap-6 p-6 text-center'><BrandMark className='mx-auto h-16 w-16 rounded-2xl'/><h1 className='font-display text-4xl font-bold'>XeeClip</h1><p className='text-lg text-soft'>Turn long videos into short clips with AI.</p>{error && <p role='alert'>{error}</p>}<div className='flex justify-center gap-3'><Link href='/login' className='btn-primary rounded-xl px-6 py-3'>Log in</Link><Link href='/signup' className='rounded-xl border border-border px-6 py-3'>Create account</Link></div></div>;
  return <Context.Provider value={{ user, refresh, logout, preferences }}>{content}</Context.Provider>;
}
