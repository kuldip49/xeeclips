'use client';

import { Music, Volume2, VolumeX } from 'lucide-react';
import type { ManualEditCommand } from '@/lib/edit-mode-api';
import { DUCK_STRENGTH_IDS, DUCK_STRENGTH_LABELS, MAX_VOLUME, exceedsPreviewGain,
  readAudioState, readSourceAudio, type DuckStrengthId } from '@/lib/edit-mode-audio';
import type { EditAsset, EditElement } from '@/lib/edit-mode-types';

const clock = (seconds: number) =>
  `${Math.floor(Math.max(0, seconds) / 60)}:${Math.floor(Math.max(0, seconds) % 60)
    .toString().padStart(2, '0')}`;

const field = 'w-full rounded-lg border border-border bg-inset px-2 py-1 text-xs text-soft';

/** One 0-200% volume slider. Local while dragging, one command on release. */
function VolumeSlider({ id, label, value, disabled, onPreview, onCommit }: {
  id: string; label: string; value: number; disabled: boolean;
  onPreview: (value: number) => void; onCommit: (value: number) => void;
}) {
  return <div className='grid gap-1'>
    <div className='flex items-baseline justify-between'>
      <label htmlFor={id} className='text-[11px] text-soft'>{label}</label>
      <span className='text-[10px] tabular-nums text-faint'>{Math.round(value * 100)}%</span>
    </div>
    <input id={id} type='range' min={0} max={MAX_VOLUME} step={0.01} value={value}
      disabled={disabled} className='w-full accent-success'
      onChange={(event) => onPreview(Number(event.target.value))}
      onPointerUp={() => onCommit(value)} onKeyUp={() => onCommit(value)} />
    {exceedsPreviewGain(value) && <p className='text-[9px] leading-3 text-faint'>
      Above 100% the preview plays at 100%; the export is at the level you set.</p>}
  </div>;
}

/**
 * The Audio panel: the video's own sound, and the music on top of it.
 *
 * The two are separated because that is how someone thinks about it - "the
 * original video" and "the music" - not because they are different internal
 * asset roles. Every label here is the plain-language one ("Lower under speech",
 * not "sidechain"), which is also the vocabulary the AI editor will be asked in.
 */
export function EditAudioPanel({ assets, elements, busy, hasSource, selectedElementId,
  duckingAvailable, onCommand, onPreviewElement, onSelectElement, onUpload, onAdd, onDelete }: {
  assets: EditAsset[];
  elements: EditElement[];
  busy: boolean;
  hasSource: boolean;
  selectedElementId: string | null;
  /** False when the source has no cached transcript word timings. */
  duckingAvailable: boolean;
  onCommand: (command: ManualEditCommand) => void;
  onPreviewElement: (element: EditElement) => void;
  onSelectElement: (id: string) => void;
  onUpload: (file: File) => void;
  onAdd: (asset: EditAsset) => void;
  onDelete: (asset: EditAsset) => void;
}) {
  const videos = elements.filter((element) => element.type === 'VIDEO' && element.track === 0);
  const audioClips = elements.filter((element) => element.type === 'AUDIO')
    .sort((left, right) => left.startTime - right.startTime);
  const library = assets.filter((asset) => asset.role === 'AUDIO');
  // The source level is one setting for the whole video as far as the user is
  // concerned, so the panel shows the first segment's and the command covers all.
  const source = readSourceAudio(videos[0]?.properties ?? {});
  const usedAssetIds = new Set(audioClips.map((clip) => clip.assetId));

  const previewSource = (patch: Record<string, unknown>) => videos.forEach((element) =>
    onPreviewElement({ ...element, properties: { ...element.properties, ...patch } }));

  const selected = audioClips.find((clip) => clip.id === selectedElementId);
  const state = selected ? readAudioState(selected.properties) : null;
  const selectedAsset = selected?.assetId
    ? assets.find((asset) => asset.id === selected.assetId) : undefined;
  const previewClip = (patch: Record<string, unknown>) => selected &&
    onPreviewElement({ ...selected, properties: { ...selected.properties, ...patch } });

  return <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4'>
    {/* --- The video's own sound --- */}
    <section className='grid gap-2'>
      <p className='text-[10px] font-semibold uppercase tracking-wider text-faint'>
        Original video sound</p>
      {videos.length === 0
        ? <p className='text-[11px] text-faint'>Attach a source video first.</p>
        : <>
          <VolumeSlider id='source-volume' label='Volume' value={source.volume} disabled={busy}
            onPreview={(value) => previewSource({ sourceVolume: value })}
            onCommit={(value) => onCommand({ action: 'set-source-audio-volume', volume: value })} />
          <button type='button' disabled={busy}
            onClick={() => onCommand({ action: 'set-source-audio-muted', muted: !source.muted })}
            className={`flex items-center justify-center gap-1.5 rounded-lg border py-1.5 text-[11px] disabled:opacity-30 ${
              source.muted ? 'border-danger/30 bg-danger/10 text-danger-soft'
                : 'border-border text-soft hover:bg-tint'}`}>
            {source.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
            {source.muted ? 'Muted' : 'Mute original video'}</button>
        </>}
    </section>

    {/* --- Music library --- */}
    <section className='grid gap-2 border-t border-border pt-3'>
      <p className='text-[10px] font-semibold uppercase tracking-wider text-faint'>
        Music and audio</p>
      <label className='flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border py-2 text-[11px] font-medium text-soft hover:bg-tint'>
        <Music size={12} />Upload music
        <input className='hidden' type='file' accept='.mp3,.wav,.m4a,.aac,audio/*'
          disabled={busy || !hasSource}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onUpload(file);
            event.target.value = '';
          }} />
      </label>
      <p className='text-[10px] leading-4 text-warning-soft/70'>
        Only upload audio you own or are licensed to use.</p>
      {library.map((asset) => <div key={asset.id} className='min-w-0 rounded-lg bg-tint-subtle p-2'>
        <div className='flex items-center gap-2'>
          <Music size={12} className='shrink-0 text-success' />
          <span className='min-w-0 flex-1 truncate text-[11px]'>{asset.originalName}</span>
          <span className='shrink-0 text-[10px] tabular-nums text-faint'>
            {clock(asset.duration ?? 0)}</span>
        </div>
        <p className='mt-0.5 text-[9px] text-faint'>
          {usedAssetIds.has(asset.id) ? 'On the timeline' : 'Not used yet'}</p>
        <div className='mt-1.5 grid grid-cols-[1fr_auto] gap-1'>
          <button type='button' disabled={busy || !hasSource} onClick={() => onAdd(asset)}
            className='rounded-md bg-tint py-1 text-[10px] font-semibold hover:bg-tint-strong disabled:opacity-30'>
            Add to timeline</button>
          <button type='button' disabled={busy} onClick={() => onDelete(asset)}
            aria-label={`Delete ${asset.originalName}`}
            className='rounded-md border border-border px-2 text-[10px] text-faint hover:text-danger'>
            Delete</button>
        </div>
      </div>)}
      {audioClips.length > 0 && <div className='grid gap-1'>
        <p className='text-[9px] uppercase tracking-wider text-faint'>On the timeline</p>
        {audioClips.map((clip) => {
          const asset = assets.find((item) => item.id === clip.assetId);
          return <button key={clip.id} type='button' onClick={() => onSelectElement(clip.id)}
            aria-pressed={clip.id === selectedElementId}
            className={`flex min-w-0 items-center gap-2 rounded-md border px-2 py-1 text-left text-[10px] ${
              clip.id === selectedElementId ? 'border-success/50 bg-success/10'
                : 'border-border hover:bg-tint'}`}>
            <span className='min-w-0 flex-1 truncate'>{asset?.originalName ?? 'Audio'}</span>
            <span className='shrink-0 tabular-nums text-faint'>
              {clock(clip.startTime)}</span>
          </button>;
        })}
      </div>}
    </section>

    {/* --- The selected music clip --- */}
    {selected && state && <section className='grid gap-2 border-t border-border pt-3'>
      <p className='min-w-0 truncate text-[10px] font-semibold uppercase tracking-wider text-faint'>
        {selectedAsset?.originalName ?? 'Selected audio'}</p>

      <VolumeSlider id='music-volume' label='Volume' value={state.volume} disabled={busy}
        onPreview={(value) => previewClip({ volume: value })}
        onCommit={(value) => onCommand({ action: 'set-audio-volume', elementId: selected.id,
          volume: value })} />

      <button type='button' disabled={busy}
        onClick={() => onCommand({ action: 'set-audio-muted', elementId: selected.id,
          muted: !state.muted })}
        className={`flex items-center justify-center gap-1.5 rounded-lg border py-1.5 text-[11px] disabled:opacity-30 ${
          state.muted ? 'border-danger/30 bg-danger/10 text-danger-soft'
            : 'border-border text-soft hover:bg-tint'}`}>
        {state.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
        {state.muted ? 'Muted' : 'Mute'}</button>

      <div className='grid grid-cols-2 gap-2'>
        <label className='text-[10px] text-faint'>Fade in
          <input className={field} type='number' min={0} step={0.1} value={state.fadeInSec}
            disabled={busy}
            onChange={(event) => previewClip({ fadeInSec: Number(event.target.value) })}
            onBlur={() => onCommand({ action: 'set-audio-fade', elementId: selected.id,
              fadeInSec: Number(selected.properties.fadeInSec ?? 0),
              fadeOutSec: Number(selected.properties.fadeOutSec ?? 0) })} /></label>
        <label className='text-[10px] text-faint'>Fade out
          <input className={field} type='number' min={0} step={0.1} value={state.fadeOutSec}
            disabled={busy}
            onChange={(event) => previewClip({ fadeOutSec: Number(event.target.value) })}
            onBlur={() => onCommand({ action: 'set-audio-fade', elementId: selected.id,
              fadeInSec: Number(selected.properties.fadeInSec ?? 0),
              fadeOutSec: Number(selected.properties.fadeOutSec ?? 0) })} /></label>
      </div>

      {/* Source trim: a read window over the uploaded file. The file itself is
          never modified, so widening the window back is always possible. */}
      <div className='grid grid-cols-2 gap-2'>
        <label className='text-[10px] text-faint'>Start in track
          <input className={field} type='number' min={0} step={0.1} value={selected.trimStart}
            disabled={busy}
            onChange={(event) => onPreviewElement({ ...selected,
              trimStart: Number(event.target.value) })}
            onBlur={() => onCommand({ action: 'set-audio-trim', elementId: selected.id,
              trimStart: selected.trimStart,
              trimEnd: selected.trimEnd ?? selected.trimStart + selected.duration })} /></label>
        <label className='text-[10px] text-faint'>End in track
          <input className={field} type='number' min={0} step={0.1}
            value={selected.trimEnd ?? selected.trimStart + selected.duration} disabled={busy}
            onChange={(event) => onPreviewElement({ ...selected,
              trimEnd: Number(event.target.value) })}
            onBlur={() => onCommand({ action: 'set-audio-trim', elementId: selected.id,
              trimStart: selected.trimStart,
              trimEnd: selected.trimEnd ?? selected.trimStart + selected.duration })} /></label>
      </div>
      <label className='text-[10px] text-faint'>Starts at (on the video)
        <input className={field} type='number' min={0} step={0.1} value={selected.startTime}
          disabled={busy}
          onChange={(event) => onPreviewElement({ ...selected,
            startTime: Number(event.target.value) })}
          onBlur={() => onCommand({ action: 'set-element-timing', elementId: selected.id,
            startTime: selected.startTime, duration: selected.duration,
            trimStart: selected.trimStart,
            ...(selected.trimEnd == null ? {} : { trimEnd: selected.trimEnd }) })} /></label>

      {/* --- Ducking --- */}
      <div className='grid gap-1.5 border-t border-border pt-2'>
        <button type='button' disabled={busy || (!duckingAvailable && !state.duckEnabled)}
          onClick={() => onCommand({ action: 'set-audio-ducking', elementId: selected.id,
            duckEnabled: !state.duckEnabled, duckStrength: state.duckStrength })}
          className={`flex items-center justify-between rounded-lg border px-2 py-1.5 text-[11px] disabled:opacity-30 ${
            state.duckEnabled ? 'border-success/50 bg-success/10 text-success-soft'
              : 'border-border text-soft hover:bg-tint'}`}>
          <span>Lower under speech</span>
          <span className='text-[10px] text-muted-foreground'>{state.duckEnabled ? 'On' : 'Off'}</span>
        </button>
        {!duckingAvailable && <p className='text-[9px] leading-3 text-warning-soft/70'>
          Unavailable: this source has no transcript word timings yet. Run &quot;Analyze
          source&quot; first.</p>}
        {state.duckEnabled && <div className='grid grid-cols-3 gap-1'>
          {DUCK_STRENGTH_IDS.map((id: DuckStrengthId) => <button key={id} type='button'
            disabled={busy} aria-pressed={state.duckStrength === id}
            onClick={() => onCommand({ action: 'set-audio-ducking', elementId: selected.id,
              duckEnabled: true, duckStrength: id })}
            className={`rounded-md border py-1 text-[10px] disabled:opacity-30 ${
              state.duckStrength === id ? 'border-success/50 bg-success/10'
                : 'border-border hover:bg-tint'}`}>
            {DUCK_STRENGTH_LABELS[id]}</button>)}
        </div>}
        {state.duckEnabled && <p className='text-[9px] leading-3 text-faint'>
          Applied on export, from the transcript timings. The preview plays this track at its
          set level throughout.</p>}
      </div>
    </section>}
  </div>;
}
