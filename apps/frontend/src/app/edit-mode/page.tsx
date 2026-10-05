'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Clapperboard, LoaderCircle, Plus } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { createEditProject, listEditProjects } from '@/lib/edit-mode-api';
import type { EditProject } from '@/lib/edit-mode-types';

export default function EditModePage() {
  const [projects, setProjects] = useState<EditProject[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void listEditProjects().then(setProjects).catch((caught) =>
    setError(caught instanceof Error ? caught.message : 'Could not load your edits')).finally(() => setLoading(false)); }, []);
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
  return <AppShell title='Editor'><div className='grid gap-8'>
    <header className='flex flex-col justify-between gap-5 md:flex-row md:items-end'>
      <div><p className='text-xs font-semibold uppercase tracking-[.18em] text-violet-300'>Editor</p><h1 className='mt-2 text-3xl font-bold tracking-tight'>Your edits</h1><p className='mt-3 max-w-xl text-sm leading-6 text-slate-400'>Every generated clip you open lands here as an editable project. You can also start a blank edit from any video.</p></div>
      <form onSubmit={create} className='flex w-full max-w-md gap-2'><input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder='New edit name' aria-label='Edit project name' className='min-w-0 flex-1 rounded-xl border border-white/10 bg-[#0d111c] px-4 text-sm outline-none focus:border-violet-400/50' /><button disabled={creating || !name.trim()} className='flex items-center gap-2 rounded-xl bg-violet-500 px-4 py-3 text-sm font-semibold disabled:opacity-50'>{creating ? <LoaderCircle size={16} className='animate-spin' /> : <Plus size={16} />}Create New Edit</button></form>
    </header>
    {error && <div role='alert' className='rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200'>{error}</div>}
    <section><div className='mb-4 flex items-center justify-between'><h2 className='text-sm font-semibold'>Edit projects</h2><span className='text-xs text-slate-500'>{projects.length} total</span></div>
      {loading ? <div className='grid min-h-40 place-items-center text-slate-500'><LoaderCircle className='animate-spin' /></div> : projects.length ? <div className='grid gap-3 md:grid-cols-2 xl:grid-cols-3'>{projects.map((project) => {
        const source = project.assets.find((asset) => asset.role === 'SOURCE');
        return <Link href={`/edit-mode/${project.id}`} key={project.id} className='group rounded-2xl border border-white/10 bg-[#0d111c] p-5 transition hover:border-violet-400/30'>
          <div className='flex items-start justify-between gap-3'><span className='grid h-10 w-10 place-items-center rounded-xl bg-violet-500/10 text-violet-300'><Clapperboard size={18} /></span><ArrowRight size={17} className='text-slate-600 transition group-hover:translate-x-1 group-hover:text-violet-300' /></div>
          <h3 className='mt-5 truncate text-sm font-semibold'>{project.name}</h3><p className='mt-2 text-xs text-slate-500'>{source ? source.analysis ? 'Analysis complete' : 'Source ready for analysis' : 'No source attached'}</p><p className='mt-4 text-[11px] text-slate-600'>Updated {new Date(project.updatedAt).toLocaleString()}</p>
        </Link>;
      })}</div> : <div className='rounded-2xl border border-dashed border-white/10 py-16 text-center text-sm text-slate-500'>No edits yet. Open a generated clip with Edit or Ask AI, or start a new edit.</div>}
    </section>
  </div></AppShell>;
}
