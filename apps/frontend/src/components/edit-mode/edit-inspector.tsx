'use client';

import { Copy, Layers, Trash2 } from 'lucide-react';
import type { ManualEditCommand } from '@/lib/edit-mode-api';
import type { EditAsset, EditElement, EditProject } from '@/lib/edit-mode-types';
import { EditTransformControls } from './edit-transform-controls';
import { EditTextInspector } from './edit-text-inspector';
import { timelineDuration } from '@/lib/edit-mode-timeline';

const num = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const fieldClass = 'w-full rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-slate-200';
const timeLabel = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(2).padStart(5, '0')}`;
};

export function EditInspector({ project, source, selected, playheadSec, onPreview, onCommit,
  onDebounced, onDuplicate, onDelete }: { project: EditProject; source?: EditAsset;
  selected?: EditElement; playheadSec: number;
  onPreview: (element: EditElement) => void; onCommit: (command: ManualEditCommand) => void;
  onDebounced: (command: ManualEditCommand) => void; onDuplicate: () => void; onDelete: () => void;
}) {
  if (!selected) return <section className='rounded-2xl border border-white/10 bg-[#0d111c] p-4'><h2 className='text-sm font-semibold'>Inspector</h2><p className='mt-3 text-xs text-slate-500'>Select an element in the timeline or preview.</p><p className='mt-4 text-[11px] text-slate-600'>Revision {project.revision}</p></section>;
  const sourceAspect = source?.width && source?.height ? source.width / source.height : null;
  const origin = project.settings.origin && typeof project.settings.origin === 'object'
    ? project.settings.origin as Record<string, unknown> : null;
  const originalSource = origin?.originKind === 'GENERATED_CLIP' &&
    origin.sourceMode === 'ORIGINAL_VIDEO' && project.originalVideoId;
  const boundaryStart = Number(origin?.currentSourceStart);
  const boundaryEnd = Number(origin?.currentSourceEnd);
  if (selected.type === 'VIDEO') return <section className='rounded-2xl border border-violet-300/20 bg-[#0d111c] p-4'><div className='flex items-center justify-between'><h2 className='text-sm font-semibold'>Selected segment</h2><span className='rounded-full bg-violet-400/10 px-2 py-1 text-[10px] font-semibold text-violet-200'>VIDEO</span></div><dl className='mt-4 grid gap-2 text-xs'>{[['Timeline start', `${selected.startTime.toFixed(2)}s`], ['Clip-local duration', `${selected.duration.toFixed(2)}s`], [originalSource ? 'Original start' : 'Source trim start', originalSource ? timeLabel(selected.trimStart) : `${selected.trimStart.toFixed(2)}s`], [originalSource ? 'Original end' : 'Source trim end', originalSource ? timeLabel(selected.trimEnd ?? selected.trimStart + selected.duration) : `${(selected.trimEnd ?? selected.trimStart + selected.duration).toFixed(2)}s`], ['Source asset', source?.originalName ?? 'Unknown']].map(([label, value]) => <div key={label} className='flex justify-between gap-4 rounded-lg bg-white/[.03] px-3 py-2'><dt className='text-slate-500'>{label}</dt><dd className='truncate text-right text-slate-200'>{value}</dd></div>)}</dl>
    {originalSource && <div className='mt-4 rounded-xl border border-violet-300/15 bg-violet-400/[.04] p-3'>
      <p className='text-[11px] font-semibold text-violet-200'>Original source boundaries</p>
      <p className='mt-1 text-[10px] text-slate-500'>Seconds in the full uploaded video. Each change is one undoable edit.</p>
      <div className='mt-3 grid grid-cols-2 gap-2'>
        <label className='text-[10px] text-slate-500'>Start
          <input key={`start-${project.revision}`} className={fieldClass} type='number' min={0}
            max={boundaryEnd - .05} step='.05'
            defaultValue={boundaryStart} onBlur={(event) => {
              const value = Number(event.currentTarget.value);
              if (Number.isFinite(value) && Math.abs(value - boundaryStart) > 1e-6)
                onCommit({ action: 'adjust-source-range', start: value });
            }} />
        </label>
        <label className='text-[10px] text-slate-500'>End
          <input key={`end-${project.revision}`} className={fieldClass} type='number'
            min={boundaryStart + .05} max={source?.duration ?? undefined} step='.05'
            defaultValue={boundaryEnd}
            onBlur={(event) => {
              const value = Number(event.currentTarget.value);
              if (Number.isFinite(value) && Math.abs(value - boundaryEnd) > 1e-6)
                onCommit({ action: 'adjust-source-range', end: value });
            }} />
        </label>
      </div>
      <div className='mt-2 grid grid-cols-4 gap-1 text-[10px]'>
        <button className='rounded border border-white/10 py-1' onClick={() => onCommit({ action: 'adjust-source-range', startDelta: -1 })}>Start −1s</button>
        <button className='rounded border border-white/10 py-1' onClick={() => onCommit({ action: 'adjust-source-range', startDelta: 1 })}>Start +1s</button>
        <button className='rounded border border-white/10 py-1' onClick={() => onCommit({ action: 'adjust-source-range', endDelta: -1 })}>End −1s</button>
        <button className='rounded border border-white/10 py-1' onClick={() => onCommit({ action: 'adjust-source-range', endDelta: 1 })}>End +1s</button>
      </div>
    </div>}
    <div className='mt-4'><EditTransformControls selected={selected} sourceAspect={sourceAspect}
      onPreview={onPreview} onCommit={onCommit} /></div>
  </section>;
  const elements = project.elements ?? [];
  // TEXT and captions get the full professional inspector. Everything else keeps
  // the compact Phase 3 panel, so this file stays the router rather than growing
  // a second, divergent text editor.
  if (selected.type === 'TEXT' || selected.type === 'SUBTITLE') {
    return <section className={`rounded-2xl border p-3 ${selected.type === 'SUBTITLE'
      ? 'border-sky-300/20 bg-[#0d111c]' : 'border-violet-300/20 bg-[#0d111c]'}`}>
      <div className='mb-2 flex items-center justify-between'>
        <h2 className='text-sm font-semibold'>Inspector</h2>
        <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${
          selected.type === 'SUBTITLE' ? 'bg-sky-400/10 text-sky-200'
            : 'bg-violet-400/10 text-violet-200'}`}>
          {selected.type === 'SUBTITLE' ? 'CAPTION' : 'TEXT'}</span>
      </div>
      <EditTextInspector selected={selected} playheadSec={playheadSec}
        timelineDurationSec={timelineDuration(elements)}
        captionCount={elements.filter((element) => element.type === 'SUBTITLE').length}
        onPreview={onPreview} onCommit={onCommit} onDebounced={onDebounced} />
      <div className='mt-3 flex gap-2'>
        <button onClick={onDuplicate}
          className='flex flex-1 items-center justify-center gap-1 rounded-lg border border-white/10 py-2 text-xs'>
          <Copy size={13} />Duplicate</button>
        <button onClick={onDelete}
          className='flex flex-1 items-center justify-center gap-1 rounded-lg border border-red-400/20 py-2 text-xs text-red-300'>
          <Trash2 size={13} />Delete</button>
      </div>
    </section>;
  }
  const p = selected.properties;
  const patchProperties = (patch: Record<string, unknown>) => onPreview({ ...selected, properties: { ...p, ...patch } });
  const timing = (patch: Partial<Pick<EditElement, 'startTime' | 'duration' | 'trimStart' | 'trimEnd'>>) => onPreview({ ...selected, ...patch });
  const commitTiming = () => onCommit({ action: 'set-element-timing', elementId: selected.id,
    startTime: selected.startTime, duration: selected.duration, trimStart: selected.trimStart,
    ...(selected.trimEnd == null ? {} : { trimEnd: selected.trimEnd }) });
  return <section className='rounded-2xl border border-cyan-300/20 bg-[#0d111c] p-4'>
    <div className='flex items-center justify-between'><h2 className='text-sm font-semibold'>Inspector</h2><span className='rounded-full bg-cyan-400/10 px-2 py-1 text-[10px] font-semibold text-cyan-200'>{selected.type === 'IMAGE' ? String(p.role ?? 'IMAGE') : selected.type}</span></div>
    <div className='mt-4 grid grid-cols-2 gap-2'><label className='text-[10px] text-slate-500'>Start<input className={fieldClass} type='number' min={0} step='.05' value={selected.startTime} onChange={(e) => timing({ startTime: num(e.target.value) })} onBlur={commitTiming} /></label><label className='text-[10px] text-slate-500'>Duration<input className={fieldClass} type='number' min='.05' step='.05' value={selected.duration} onChange={(e) => timing({ duration: num(e.target.value) })} onBlur={commitTiming} /></label></div>
    {selected.type === 'IMAGE' && <>
      <div className='mt-3 grid grid-cols-2 gap-2'>{(['x', 'y', 'width', 'height'] as const).map((key) => <label key={key} className='text-[10px] capitalize text-slate-500'>{key}<input className={fieldClass} type='number' min={0} max={1} step='.01' value={num(p[key])} onChange={(e) => patchProperties({ [key]: num(e.target.value) })} onBlur={() => onCommit(key === 'x' || key === 'y' ? { action: 'move-element', elementId: selected.id, x: num(selected.properties.x), y: num(selected.properties.y) } : { action: 'resize-element', elementId: selected.id, width: num(selected.properties.width), height: num(selected.properties.height) })} /></label>)}</div>
      <label className='mt-3 block text-[10px] text-slate-500'>Opacity · {Math.round(num(p.opacity, 1) * 100)}%<input className='mt-1 w-full accent-cyan-300' type='range' min={0} max={1} step='.01' value={num(p.opacity, 1)} onChange={(e) => patchProperties({ opacity: num(e.target.value) })} onPointerUp={() => onCommit({ action: 'set-element-opacity', elementId: selected.id, opacity: num(selected.properties.opacity, 1) })} /></label>
      <div className='mt-3'><p className='text-[10px] text-slate-500'>Layer</p><div className='mt-1 grid grid-cols-4 gap-1'>{[['Back', -1000], ['−', -1], ['+', 1], ['Front', 1000]].map(([label, delta]) => <button key={label} onClick={() => onCommit({ action: 'set-element-z-index', elementId: selected.id, zIndex: Math.max(0, num(p.zIndex) + Number(delta)) })} className='rounded border border-white/10 py-1 text-[10px]'><Layers size={10} className='mx-auto' />{label}</button>)}</div></div>
      {selected.type === 'IMAGE' && <div className='mt-3'>
        <EditTransformControls selected={selected} sourceAspect={sourceAspect}
          onPreview={onPreview} onCommit={onCommit} /></div>}
    </>}
    {selected.type === 'AUDIO' && <div className='mt-3 grid gap-3'><label className='text-[10px] text-slate-500'>Volume · {Math.round(num(p.volume, .25) * 100)}%<input className='mt-1 w-full accent-emerald-300' type='range' min={0} max={1} step='.01' value={num(p.volume, .25)} onChange={(e) => patchProperties({ volume: num(e.target.value) })} onPointerUp={() => onCommit({ action: 'set-audio-volume', elementId: selected.id, volume: num(selected.properties.volume, .25) })} /></label><label className='flex items-center gap-2 text-xs'><input type='checkbox' checked={Boolean(p.muted)} onChange={(e) => { patchProperties({ muted: e.target.checked }); onCommit({ action: 'set-audio-muted', elementId: selected.id, muted: e.target.checked }); }} />Muted</label><div className='grid grid-cols-2 gap-2'>{(['fadeInSec', 'fadeOutSec'] as const).map((key) => <label key={key} className='text-[10px] text-slate-500'>{key === 'fadeInSec' ? 'Fade in' : 'Fade out'}<input className={fieldClass} type='number' min={0} step='.1' value={num(p[key])} onChange={(e) => patchProperties({ [key]: num(e.target.value) })} onBlur={() => onCommit({ action: 'set-audio-fade', elementId: selected.id, fadeInSec: num(selected.properties.fadeInSec), fadeOutSec: num(selected.properties.fadeOutSec) })} /></label>)}</div><div className='grid grid-cols-2 gap-2'><label className='text-[10px] text-slate-500'>Trim start<input className={fieldClass} type='number' min={0} step='.05' value={selected.trimStart} onChange={(e) => timing({ trimStart: num(e.target.value), trimEnd: num(e.target.value) + selected.duration })} onBlur={commitTiming} /></label><label className='text-[10px] text-slate-500'>Trim end<input className={fieldClass} type='number' min='.05' step='.05' value={selected.trimEnd ?? selected.trimStart + selected.duration} onChange={(e) => timing({ trimEnd: num(e.target.value), duration: num(e.target.value) - selected.trimStart })} onBlur={commitTiming} /></label></div></div>}
    <div className='mt-4 flex gap-2'><button onClick={onDuplicate} className='flex flex-1 items-center justify-center gap-1 rounded-lg border border-white/10 py-2 text-xs'><Copy size={13} />Duplicate</button><button onClick={onDelete} className='flex flex-1 items-center justify-center gap-1 rounded-lg border border-red-400/20 py-2 text-xs text-red-300'><Trash2 size={13} />Delete</button></div>
  </section>;
}
