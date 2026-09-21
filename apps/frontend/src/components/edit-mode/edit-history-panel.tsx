import { History } from 'lucide-react';
import type { EditHistory } from '@/lib/edit-mode-types';

const labels: Record<string, string> = {
  PROJECT_CREATED: 'Project created', SOURCE_ATTACHED: 'Source attached',
  SOURCE_ANALYZED: 'Source analyzed', ELEMENTS_UPDATED: 'Timeline updated',
  PROJECT_UPDATED: 'Project updated', APPLY_PRESET: 'Preset applied',
  UNDO: 'Undo', REDO: 'Redo'
};

export function EditHistoryPanel({ history }: { history: EditHistory[] }) {
  return <section className='rounded-2xl border border-white/10 bg-[#0d111c] p-4'>
    <div className='flex items-center gap-2'><History size={16} className='text-cyan-300' /><h2 className='text-sm font-semibold'>History</h2></div>
    <ol className='mt-4 grid gap-3'>{history.length ? history.map((item) => <li key={item.id} className='flex gap-3 text-xs'>
      <span className='grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/5 text-[10px] text-slate-400'>r{item.revision}</span>
      <span><span className='block text-slate-300'>{labels[item.action] ?? item.action}{item.actor === 'PRESET' && <span className='ml-2 rounded bg-violet-400/10 px-1 py-0.5 text-[9px] font-semibold text-violet-200'>PRESET</span>}</span><time className='mt-1 block text-slate-600'>{new Date(item.createdAt).toLocaleString()}</time></span>
    </li>) : <li className='text-xs text-slate-500'>No revisions yet.</li>}</ol>
  </section>;
}

