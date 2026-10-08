'use client';

import { useEffect, useRef, useState } from 'react';
import { RAW_LOOK } from '@/lib/automatic-looks';
import { CheckCircle2, Circle, Link2, Loader2, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StylePreview } from '@/components/generation/style-preview';
import { MobileDisclosure } from '@/components/ui/mobile-disclosure';
import {
  CATEGORY_LABELS, getReference, referenceFromUrl, SOURCE_LABELS, sourceFileUrl, sourcePosterUrl, STYLE_CATEGORIES, uploadReference,
  type CreativeCatalog, type CreativeResolution, type ReferenceAsset, type SavedStyle, type StyleCategory
} from '@/lib/creative-generation';
import { cn } from '@/lib/utils';

/** Automatic 1 is the untouched golden automatic editor. Automatic 2 arrives
 * from the server as the one public style variant. */
export const BASE_LOOKS = [
  { value: 'AUTOMATIC_1', title: 'StyleZero', description: 'Clean framing, captions and subtle zooms.' }
] as const;

export type GenerationChoices = {
  look: string | null;
  components: Partial<Record<StyleCategory, string>>;
  brief: string;
  reference: ReferenceAsset | null;
};

const BRIEF_EXAMPLES = 'e.g. "find the funny moments", "keep the full conversation in context", ' +
  '"clean podcast look, captions lower, warm colour"';

export function GenerationSetup({ videoId, catalog, savedStyles, choices, onChange, resolution, resolving,
  disabled }: {
  videoId: string;
  catalog: CreativeCatalog | null;
  savedStyles: SavedStyle[];
  choices: GenerationChoices;
  onChange: (next: GenerationChoices) => void;
  resolution: CreativeResolution | null;
  resolving: boolean;
  disabled: boolean;
}) {
  const [referenceUrl, setReferenceUrl] = useState('');
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef(choices);
  latest.current = choices;

  // A reference is analysed server-side; poll until it settles.
  const referenceId = choices.reference?.id;
  const referenceStatus = choices.reference?.status;
  useEffect(() => {
    if (!referenceId || referenceStatus !== 'ANALYZING') return;
    const interval = window.setInterval(() => {
      void getReference(referenceId).then((next) => {
        if (latest.current.reference?.id === next.id && next.status !== 'ANALYZING') {
          onChange({ ...latest.current, reference: next });
        }
      }).catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(interval);
  }, [referenceId, referenceStatus, onChange]);

  async function addReference(start: () => Promise<ReferenceAsset>) {
    setReferenceBusy(true);
    setReferenceError(null);
    try { onChange({ ...latest.current, reference: await start() }); setReferenceUrl(''); }
    catch (error) { setReferenceError(error instanceof Error ? error.message : 'The reference could not be added.'); }
    finally { setReferenceBusy(false); }
  }

  const resolved = resolution?.resolved ?? null;
  // Plain cuts with nothing else chosen are exactly the source frame.
  const previewStyle = choices.look === 'NORMAL' && !resolved?.styled ? null : resolved;
  const looks = [...BASE_LOOKS.map((look) => ({ value: look.value as string, title: look.title, description: look.description })),
    ...(catalog?.templates ?? []).filter((template) => template.id === 'AUTOMATIC_2' || template.id === 'AUTOMATIC_3_STYLE_TWO')
      .map((template) => ({ value: template.id, title: template.id === 'AUTOMATIC_2' ? 'StyleOne' : 'StyleTwo',
        description: template.id === 'AUTOMATIC_2' ? 'Editorial black canvas, serif headline and red highlights.'
          : 'White canvas, condensed headline and red boxed captions.' })),
    { value: RAW_LOOK.value as string, title: RAW_LOOK.title, description: RAW_LOOK.description }];
  const intent = resolution?.interpreted.intent;
  const derived = choices.reference?.derivedStyle;

  const advancedCount = Object.keys(choices.components).length + (choices.brief.trim() ? 1 : 0) + (choices.reference ? 1 : 0);
  return <div className='grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]'>
    <div className='grid min-w-0 content-start gap-6'>
      {/* Native radios: the whole card is the label, so clicks, Enter/Space and arrow keys all work. */}
      <fieldset className='grid gap-3' disabled={disabled}>
        <legend className='mb-2 text-sm font-medium'>Style</legend>
        <div className='grid gap-2 sm:grid-cols-3 sm:gap-3'>
          {looks.map((option) => {
            const selected = choices.look === option.value;
            const Indicator = selected ? CheckCircle2 : Circle;
            return <label key={option.value} data-look={option.value} data-selected={selected}
              className={cn('pressable block min-h-[56px] cursor-pointer rounded-2xl border p-3 text-left transition-colors focus-within:ring-2 focus-within:ring-ring sm:rounded-xl',
                selected ? 'border-primary bg-primary/10' : 'border-border bg-surface hover:border-border-strong')}>
              <input type='radio' className='sr-only' name={`look-${videoId}`} value={option.value}
                checked={selected} onChange={() => onChange({ ...choices, look: option.value })} />
              <span className='flex items-center justify-between gap-2 text-sm font-semibold'>{option.title}
                <Indicator size={16} className={selected ? 'text-primary-soft' : 'text-faint'} aria-hidden /></span>
              <span className='mt-1 block text-xs leading-5 text-muted-foreground'>{option.description}</span>
            </label>;
          })}
        </div>
      </fieldset>

      <MobileDisclosure title='Advanced options' defaultOpen={advancedCount > 0}
        summary={advancedCount ? `${advancedCount} set` : 'styles, description, reference'}>
      <details className='group rounded-xl border border-border bg-surface p-4' open={Object.keys(choices.components).length > 0}>
        <summary className='cursor-pointer text-sm font-medium'>Mix individual styles
          <span className='ml-2 font-normal text-faint'>· overrides the look, one part at a time</span></summary>
        <div className='mt-4 grid gap-3 sm:grid-cols-2'>
          {STYLE_CATEGORIES.filter((category) => category !== 'TEXT').map((category) => {
            const current = resolved?.components[category];
            const mine = savedStyles.filter((style) => style.category === category);
            return <label key={category} className='grid gap-1 text-xs'>
              <span className='flex items-center justify-between gap-2 font-medium text-soft'>{CATEGORY_LABELS[category]}
                {current?.source && current.source !== 'COMPONENT' && current.name
                  ? <span className='truncate font-normal text-faint'>{current.name} · {SOURCE_LABELS[current.source]}</span> : null}
              </span>
              <select data-component={category} disabled={disabled || !catalog}
                value={choices.components[category] ?? ''}
                onChange={(event) => {
                  const components = { ...choices.components };
                  if (event.target.value) components[category] = event.target.value;
                  else delete components[category];
                  onChange({ ...choices, components });
                }}
                className='h-11 rounded-lg border border-border bg-sunken px-2 text-sm text-soft md:h-9'>
                <option value=''>From the look</option>
                {(catalog?.components[category] ?? []).map((style) =>
                  <option key={style.id} value={style.id} disabled={!style.supported} title={style.note ?? style.description}>
                    {style.name}{style.supported ? '' : ' (not available)'}</option>)}
                {mine.length ? <optgroup label='My styles'>
                  {mine.map((style) => <option key={style.id} value={style.id}>{style.name}</option>)}
                </optgroup> : null}
              </select>
            </label>;
          })}
        </div>
      </details>

      <label className='grid gap-2'>
        <span className='text-sm font-medium'>Describe what you want <span className='font-normal text-faint'>· optional</span></span>
        <textarea data-testid='creative-brief' value={choices.brief} disabled={disabled} maxLength={1500} rows={3}
          onChange={(event) => onChange({ ...choices, brief: event.target.value })} placeholder={BRIEF_EXAMPLES}
          className='rounded-xl border border-border bg-sunken p-3 text-sm text-soft placeholder:text-faint' />
        {intent && ((intent.modes?.length ?? 0) > 0 || (intent.topics?.length ?? 0) > 0)
          ? <span className='text-xs text-muted-foreground' data-testid='brief-intent'>
            Clip selection will favour {[...(intent.modes ?? []).map((mode) => mode.toLowerCase()),
              ...(intent.topics ?? []).map((topic) => `“${topic}”`)].join(', ')}
            {intent.strict ? ' (only matching moments)' : ''}.</span>
          : null}
      </label>

      <div className='grid gap-2'>
        <span className='text-sm font-medium'>Reference video <span className='font-normal text-faint'>· optional — we learn its editing style, never its content</span></span>
        {choices.reference ? <div className='flex items-start gap-3 rounded-xl border border-border bg-surface p-3 text-xs'>
          {choices.reference.status === 'ANALYZING' ? <Loader2 className='mt-0.5 shrink-0 animate-spin text-secondary' size={14} /> : null}
          <div className='min-w-0 flex-1'>
            <p className='truncate font-medium text-soft'>{choices.reference.originalName}</p>
            <p className={choices.reference.status === 'FAILED' ? 'text-danger' : 'text-muted-foreground'} data-testid='reference-status'>
              {choices.reference.status === 'ANALYZING' ? 'Analysing pacing, framing, captions and colour…'
                : choices.reference.status === 'FAILED' ? `Could not analyse: ${choices.reference.error ?? 'unknown error'}`
                  : 'Analysed. Its editing principles feed the style below your own picks.'}</p>
            {derived?.principles?.length ? <ul className='mt-1 list-disc pl-4 text-muted-foreground'>
              {derived.principles.slice(0, 5).map((line) => <li key={line}>{line}</li>)}</ul> : null}
            {derived?.notMeasured?.length ? <p className='mt-1 text-faint'>Not measured: {derived.notMeasured.join('; ')}</p> : null}
          </div>
          <Button type='button' size='sm' variant='ghost' className='h-10 w-10 shrink-0 px-0' disabled={disabled}
            aria-label='Remove reference' onClick={() => onChange({ ...choices, reference: null })}><X size={14} /></Button>
        </div> : <div className='flex flex-wrap items-center gap-2'>
          <input ref={fileInput} type='file' accept='video/*' className='hidden' onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void addReference(() => uploadReference(file, videoId));
          }} />
          <Button type='button' size='sm' variant='outline' className='h-11 md:h-9' disabled={disabled || referenceBusy}
            onClick={() => fileInput.current?.click()}>
            {referenceBusy ? <Loader2 className='animate-spin' size={14} /> : <Upload size={14} />}Upload reference</Button>
          <span className='text-xs text-faint'>or</span>
          <input value={referenceUrl} onChange={(event) => setReferenceUrl(event.target.value)} disabled={disabled || referenceBusy}
            placeholder='Direct video URL (.mp4)' className='h-11 min-w-0 flex-1 basis-40 rounded-lg border border-border bg-sunken px-2 text-sm md:h-9' />
          <Button type='button' size='sm' variant='outline' className='h-11 md:h-9' disabled={disabled || referenceBusy || !referenceUrl.trim()}
            onClick={() => void addReference(() => referenceFromUrl(referenceUrl.trim(), videoId))}><Link2 size={14} />Add</Button>
        </div>}
        {referenceError ? <p role='alert' className='break-words text-xs text-danger'>{referenceError}</p> : null}
      </div>
      </MobileDisclosure>
    </div>

    <div className='grid min-w-0 content-start gap-3'>
      <StylePreview posterUrl={sourcePosterUrl(videoId)} sourceUrl={sourceFileUrl(videoId)}
        resolved={previewStyle} layout={resolution?.layout ?? null} loading={resolving} />
      {resolved?.notes.length ? <ul className='text-xs text-warning-soft/80'>{resolved.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
    </div>
  </div>;
}
