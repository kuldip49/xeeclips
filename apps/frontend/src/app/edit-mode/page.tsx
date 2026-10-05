'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Clapperboard, LoaderCircle, Plus } from 'lucide-react';
import { OfflineNotice } from '@/components/offline-notice';
import { isServerUnavailable } from '@/lib/use-backend-status';
import { timeAgo } from '@/lib/format';
import { AppShell } from '@/components/app-shell';
import { createEditProject, listEditProjects } from '@/lib/edit-mode-api';
import type { EditProject } from '@/lib/edit-mode-types';

export default function EditModePage() {
  const [projects, setProjects] = useState<EditProject[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const load = () => listEditProjects().then((items) => { setProjects(items); setOffline(false); setError(''); })
    .catch((caught) => {
      if (isServerUnavailable(caught)) setOffline(true);
      else setError(caught instanceof Error ? caught.message : 'Could not load your edits');
    }).finally(() => setLoading(false));
  useEffect(() => { void load(); }, []);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setCreating(true); setError('');
    try {
      const project = await createEditProject(name.trim());
      window.location.assign(`/edit-mode/${project.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create EditProject');
      setCreating(false);
    }
  };
  return <AppShell title='Edits'><div className='grid gap-6 md:gap-8'>
    <header className='flex flex-col justify-between gap-4 md:flex-row md:items-end'>
      <div><p className='eyebrow'>Editor</p><h1 className='mt-2 text-[26px] font-bold tracking-tight md:text-3xl'>Your edits</h1><p className='mt-2 max-w-xl text-sm leading-6 text-slate-400'>Every generated clip you open lands here as an editable project. You can also start a blank edit.</p></div>
      <form onSubmit={create} className='grid w-full gap-2 sm:flex sm:max-w-md'><input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder='New edit name' aria-label='Edit project name' enterKeyHint='done' className='h-12 min-w-0 flex-1 rounded-xl border border-white/10 bg-[#0d111c] px-4 text-sm outline-none focus:border-violet-400/50 sm:h-11' /><button disabled={creating || !name.trim() || offline} className='pressable flex h-12 items-center justify-center gap-2 rounded-xl bg-violet-500 px-4 text-sm font-semibold disabled:opacity-50 sm:h-11'>{creating ? <LoaderCircle size={16} className='animate-spin' /> : <Plus size={16} />}Create New Edit</button></form>
    </header>
    {offline ? <OfflineNotice onRetry={() => { setLoading(true); return load(); }} /> : null}
    {error && <div role='alert' className='break-words rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200 [overflow-wrap:anywhere]'>{error}</div>}
    <section><div className='mb-3 flex items-center justify-between'><h2 className='text-sm font-semibold'>Edit projects</h2><span className='text-xs text-slate-500'>{projects.length} total</span></div>
      {loading ? <div className='grid gap-2.5 md:grid-cols-2 xl:grid-cols-3' aria-busy='true'>{[1, 2, 3].map((item) => <div key={item} className='skeleton h-[76px] rounded-2xl md:h-36' />)}</div> : projects.length ? <div className='grid gap-2.5 md:grid-cols-2 md:gap-3 xl:grid-cols-3'>{projects.map((project) => {
        const source = project.assets.find((asset) => asset.role === 'SOURCE');
        return <Link href={`/edit-mode/${project.id}`} key={project.id} className='pressable group flex min-w-0 items-center gap-3 rounded-2xl border border-white/10 bg-[#0d111c] p-3.5 transition hover:border-violet-400/30 md:block md:p-5'>
          <div className='flex shrink-0 items-start justify-between gap-3'><span className='grid h-11 w-11 place-items-center rounded-xl bg-violet-500/10 text-violet-300 md:h-10 md:w-10'><Clapperboard size={18} /></span><ArrowRight size={17} className='hidden text-slate-600 transition group-hover:translate-x-1 group-hover:text-violet-300 md:block' /></div>
          <div className='min-w-0 flex-1'><h3 className='truncate text-[15px] font-semibold md:mt-5 md:text-sm'>{project.name}</h3><p className='mt-1 truncate text-xs text-slate-500 md:mt-2'>{source ? source.analysis ? 'Analysis complete' : 'Source ready for analysis' : 'No source attached'}<span className='md:hidden'> · {timeAgo(project.updatedAt)}</span></p><p className='mt-4 hidden text-[11px] text-slate-600 md:block'>Updated {new Date(project.updatedAt).toLocaleString()}</p></div>
          <ArrowRight size={17} className='shrink-0 text-slate-600 md:hidden' aria-hidden />
        </Link>;
      })}</div> : !offline ? <div className='empty-state'><Clapperboard className='text-violet-300' size={26} /><h3 className='mt-4 font-semibold'>No edits yet</h3><p className='mt-1 max-w-xs text-sm text-slate-400'>Open a generated clip with Edit or Ask AI, or start a new edit above.</p><Link href='/create' className='mt-4 text-sm font-semibold text-violet-300'>Create clips →</Link></div> : null}
    </section>
  </div></AppShell>;
}
