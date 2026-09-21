import { Activity, ScanFace, ScanText, ScissorsLineDashed } from 'lucide-react';
import type { EditAsset, EditElement, EditProject } from '@/lib/edit-mode-types';

const seconds = (value: number) => `${value.toFixed(2)}s`;

export function EditInspector({ project, source, selected }: {
  project: EditProject; source?: EditAsset; selected?: EditElement;
}) {
  if (selected?.type === 'VIDEO') return <section className='rounded-2xl border border-violet-300/20 bg-[#0d111c] p-4'>
    <div className='flex items-center justify-between'><h2 className='text-sm font-semibold'>Selected segment</h2><span className='rounded-full bg-violet-400/10 px-2 py-1 text-[10px] font-semibold text-violet-200'>VIDEO</span></div>
    <dl className='mt-4 grid gap-2 text-xs'>{[
      ['Timeline start', seconds(selected.startTime)], ['Timeline duration', seconds(selected.duration)],
      ['Source trim start', seconds(selected.trimStart)], ['Source trim end', seconds(selected.trimEnd ?? selected.trimStart + selected.duration)],
      ['Source asset', source?.originalName ?? 'Unknown']
    ].map(([label, value]) => <div key={label} className='flex justify-between gap-4 rounded-lg bg-white/[.03] px-3 py-2'><dt className='text-slate-500'>{label}</dt><dd className='truncate text-right text-slate-200'>{value}</dd></div>)}</dl>
  </section>;
  const summary = source?.analysis?.summary;
  const rows = [
    ['Faces detected', summary?.faceDetections ?? 0, ScanFace],
    ['Mouth activity', summary?.mouthActivitySamples ?? 0, Activity],
    ['Shots', summary?.shotCount ?? 0, ScissorsLineDashed],
    ['OCR regions', summary?.ocrRegionCount ?? 0, ScanText]
  ] as const;
  return <section className='rounded-2xl border border-white/10 bg-[#0d111c] p-4'>
    <div className='flex items-center justify-between'><h2 className='text-sm font-semibold'>Analysis</h2><span className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase ${source?.analysis ? 'bg-emerald-400/10 text-emerald-300' : 'bg-white/5 text-slate-500'}`}>{source?.analysis ? 'Complete' : 'Not run'}</span></div>
    <div className='mt-4 grid grid-cols-2 gap-2'>{rows.map(([label, value, Icon]) => <div key={label} className='rounded-xl bg-white/[.03] p-3'><Icon size={15} className='text-slate-500' /><p className='mt-3 text-lg font-semibold'>{value}</p><p className='text-[11px] text-slate-500'>{label}</p></div>)}</div>
    <div className='mt-3 text-xs text-slate-500'>Revision {project.revision} · {project.status.toLowerCase()}</div>
  </section>;
}
