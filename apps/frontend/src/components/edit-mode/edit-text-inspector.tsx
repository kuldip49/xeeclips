'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Layers, Scissors, Sparkles } from 'lucide-react';
import type { ManualEditCommand } from '@/lib/edit-mode-api';
import type { EditElement } from '@/lib/edit-mode-types';
import { canHighlightWords, readCaptionWords, readTextStyle, recolorBaseRuns, runsFromWordColors, wordColors,
  CAPTION_STYLE_PRESETS, EDIT_MODE_FONTS, TEXT_BOUNDS, TEXT_STYLE_PRESETS, type CaptionStylePresetId,
  type TextStylePresetId } from '@/lib/edit-mode-text';

/**
 * The professional text and caption inspector.
 *
 * Every control here emits ONE typed canonical command. Sliders and drags are
 * local and realtime while the pointer is down and persist once on release;
 * typed fields persist on blur; the content box debounces. Nothing sends a
 * request per pointer move, and nothing keeps a second copy of the text state -
 * the canonical element is the only model.
 */

const num = (value: unknown, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;
const field = 'w-full rounded-lg border border-border bg-inset px-2 py-1.5 text-xs text-soft';
const label = 'text-[10px] text-faint';

function Section({ title, children, defaultOpen = true }: {
  title: string; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return <section className='rounded-xl border border-border bg-tint-subtle'>
    <button onClick={() => setOpen(!open)} aria-expanded={open}
      className='flex w-full items-center justify-between px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground'>
      {title}<ChevronDown size={12} className={open ? 'rotate-180 transition' : 'transition'} />
    </button>
    {open && <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 px-2.5 pb-2.5'>
      {children}</div>}
  </section>;
}

function Slider({ title, value, min, max, step, format, onInput, onCommit }: {
  title: string; value: number; min: number; max: number; step: number;
  format?: (value: number) => string;
  onInput: (value: number) => void; onCommit: () => void;
}) {
  return <label className={label}>{title} · {format ? format(value) : value}
    <input type='range' min={min} max={max} step={step} value={value}
      aria-label={title}
      onChange={(event) => onInput(num(event.target.value))}
      onPointerUp={onCommit} onKeyUp={onCommit} onBlur={onCommit}
      className='mt-1 w-full accent-secondary' />
  </label>;
}

/**
 * A colour picker that persists the colour it was given. The native picker blurs its input as soon as
 * it opens, so committing on blur alone sent the OLD colour; this commits the picked value itself,
 * shortly after the last change (one command per pick, not per drag step) and again on blur.
 */
function ColorField({ title, value, onInput, onCommit }: {
  title: string; value: string; onInput: (value: string) => void; onCommit: (value: string) => void;
}) {
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commit = useRef(onCommit); commit.current = onCommit;
  const flush = () => { if (timer.current) clearTimeout(timer.current); timer.current = null;
    if (pending.current !== null) { const next = pending.current; pending.current = null; commit.current(next); } };
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return <label className={label}>{title}
    <input type='color' value={value} aria-label={title}
      onChange={(event) => { const next = event.target.value; onInput(next); pending.current = next;
        if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(flush, 400); }}
      onBlur={flush}
      className='mt-1 h-7 w-full rounded bg-transparent' />
  </label>;
}

function Toggle({ title, checked, onChange }: {
  title: string; checked: boolean; onChange: (checked: boolean) => void;
}) {
  return <label className='flex items-center gap-2 text-xs text-soft'>
    <input type='checkbox' checked={checked} className='accent-secondary'
      onChange={(event) => onChange(event.target.checked)} />{title}</label>;
}

const CAPTION_SCOPE_ACTIONS = new Set<ManualEditCommand['action']>([
  'move-element', 'set-element-opacity', 'set-text-font', 'set-text-size', 'set-text-weight',
  'set-text-color', 'set-text-alignment', 'set-text-stroke', 'set-text-shadow',
  'set-text-background', 'set-text-spacing', 'set-text-case', 'set-caption-style',
  'set-caption-active-word'
]);

export function EditTextInspector({ selected, timelineDurationSec, playheadSec, captionCount,
  onPreview, onCommit: rawOnCommit, onDebounced }: {
  selected: EditElement;
  timelineDurationSec: number;
  playheadSec: number;
  captionCount: number;
  onPreview: (element: EditElement) => void;
  onCommit: (command: ManualEditCommand) => void;
  onDebounced: (command: ManualEditCommand) => void;
}) {
  const id = selected.id;
  const properties = selected.properties;
  const style = readTextStyle(properties);
  const caption = selected.type === 'SUBTITLE';
  const [captionScope, setCaptionScope] = useState<'SELECTED_ELEMENT' | 'TRACK'>('SELECTED_ELEMENT');
  const words = readCaptionWords(properties);
  const content = String(properties.content ?? '');
  const onCommit = (command: ManualEditCommand) => rawOnCommit(caption &&
    captionScope === 'TRACK' && CAPTION_SCOPE_ACTIONS.has(command.action)
    ? { ...command, scope: 'TRACK' } as ManualEditCommand : command);

  // Local, realtime edits. The canonical element is patched in place so the
  // preview redraws immediately; the matching command is what persists it.
  const patch = (next: Record<string, unknown>) =>
    onPreview({ ...selected, properties: { ...properties, ...next } });
  const live = () => readTextStyle({ ...properties });

  const commitStroke = (next: Partial<ReturnType<typeof readTextStyle>['stroke']> = {}) => { const s = { ...live().stroke, ...next };
    onCommit({ action: 'set-text-stroke', elementId: id, strokeEnabled: s.enabled,
      strokeColor: s.color, strokeWidth: s.width }); };
  const commitShadow = (next: Partial<ReturnType<typeof readTextStyle>['shadow']> = {}) => { const s = { ...live().shadow, ...next };
    onCommit({ action: 'set-text-shadow', elementId: id, shadowEnabled: s.enabled,
      shadowColor: s.color, shadowOpacity: s.opacity, shadowBlur: s.blur,
      shadowOffsetX: s.offsetX, shadowOffsetY: s.offsetY }); };
  const commitBackground = (next: Partial<ReturnType<typeof readTextStyle>['background']> = {}) => { const b = { ...live().background, ...next };
    onCommit({ action: 'set-text-background', elementId: id, backgroundEnabled: b.enabled,
      backgroundColor: b.color, backgroundOpacity: b.opacity, backgroundPadding: b.padding,
      backgroundRadius: b.radius }); };
  const commitSpacing = () => { const s = live();
    onCommit({ action: 'set-text-spacing', elementId: id, letterSpacing: s.letterSpacing,
      lineSpacing: s.lineSpacing }); };
  const commitSize = () => onCommit({ action: 'set-text-size', elementId: id,
    fontSize: live().fontSize });
  const commitMove = () => onCommit({ action: 'move-element', elementId: id,
    x: num(selected.properties.x), y: num(selected.properties.y) });
  const commitResize = () => onCommit({ action: 'resize-element', elementId: id,
    width: num(selected.properties.width), height: num(selected.properties.height) });
  const commitRotation = () => onCommit({ action: 'set-video-rotation', elementId: id,
    rotation: num(selected.properties.rotation) });
  const commitOpacity = () => onCommit({ action: 'set-element-opacity', elementId: id,
    opacity: num(selected.properties.opacity, 1) });
  const commitTiming = () => onCommit({ action: 'set-element-timing', elementId: id,
    startTime: selected.startTime, duration: selected.duration, trimStart: selected.trimStart });
  const commitActiveWord = (next: Partial<ReturnType<typeof readTextStyle>['activeWord']> = {}) => { const a = { ...live().activeWord, ...next };
    onCommit({ action: 'set-caption-active-word', elementId: id, activeWordEnabled: a.enabled,
      activeWordColor: a.color }); };

  const strokeSuppressed = style.background.enabled && style.background.opacity > 0 &&
    style.stroke.enabled && style.stroke.width > 0;

  return <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2'>
    <Section title='Content'>
      <textarea value={content} aria-label='Text content'
        className={`${field} min-h-20 resize-y`}
        onChange={(event) => {
          const next = event.target.value;
          patch({ content: next, ...(caption ? { manualEdited: true } : {}) });
          onDebounced(caption
            ? { action: 'set-caption-text', elementId: id, content: next }
            : { action: 'set-text-content', elementId: id, content: next });
        }} />
      {caption && properties.manualEdited === true && <p className='text-[10px] text-warning-soft/70'>
        Edited by hand. Regenerating captions replaces this wording.</p>}
      {!caption && <div className='grid grid-cols-2 gap-1'>
        {TEXT_STYLE_PRESETS.map((preset) => <button key={preset.id} title={preset.description}
          onClick={() => onCommit({ action: 'set-text-style-preset', elementId: id,
            textStyleId: preset.id as TextStylePresetId })}
          className={`rounded-md border px-1.5 py-1 text-[10px] ${
            properties.textStyleId === preset.id
              ? 'border-primary/50 bg-primary/15 text-foreground'
              : 'border-border text-soft hover:bg-tint'}`}>{preset.label}</button>)}
      </div>}
    </Section>

    {caption && <Section title='Caption'>
      <label className={label}>Apply style changes to
        <select className={field} aria-label='Caption style scope' value={captionScope}
          onChange={(event) => setCaptionScope(event.target.value as typeof captionScope)}>
          <option value='SELECTED_ELEMENT'>Selected caption only</option>
          <option value='TRACK'>Entire caption track</option>
        </select>
      </label>
      <div className='grid grid-cols-2 gap-1'>
        {CAPTION_STYLE_PRESETS.map((preset) => <button key={preset.id} title={preset.description}
          onClick={() => onCommit({ action: 'set-caption-style', elementId: id,
            captionStyleId: preset.id as CaptionStylePresetId })}
          className={`rounded-md border px-1.5 py-1 text-[10px] ${
            properties.captionStyleId === preset.id
              ? 'border-secondary/50 bg-secondary/15 text-secondary-soft'
              : 'border-border text-soft hover:bg-tint'}`}>{preset.label}</button>)}
      </div>
      <button onClick={() => onCommit({ action: 'apply-caption-style-to-all', elementId: id })}
        className='flex items-center justify-center gap-1.5 rounded-lg border border-secondary/25 py-1.5 text-[11px] font-semibold text-secondary-soft hover:bg-secondary/10'>
        <Sparkles size={12} />Apply this style to all {captionCount} captions</button>
      <p className='text-[10px] leading-4 text-faint'>
        Style and placement only — wording, timing and manual corrections are left alone, and
        one undo puts every caption back.</p>
      <div className='grid grid-cols-3 gap-1'>
        <button onClick={() => onCommit({ action: 'split-caption', elementId: id,
          atSec: playheadSec })}
          disabled={playheadSec <= selected.startTime ||
            playheadSec >= selected.startTime + selected.duration}
          title='Split this caption at the playhead'
          className='flex items-center justify-center gap-1 rounded-md border border-border py-1 text-[10px] disabled:opacity-30'>
          <Scissors size={10} />Split</button>
        <button onClick={() => onCommit({ action: 'merge-caption', elementId: id,
          direction: 'PREVIOUS' })}
          className='rounded-md border border-border py-1 text-[10px]'>Merge ←</button>
        <button onClick={() => onCommit({ action: 'merge-caption', elementId: id,
          direction: 'NEXT' })}
          className='rounded-md border border-border py-1 text-[10px]'>Merge →</button>
      </div>
      <Toggle title='Highlight the active word' checked={style.activeWord.enabled}
        onChange={(enabled) => {
          patch({ activeWord: { ...style.activeWord, enabled } });
          onCommit({ action: 'set-caption-active-word', elementId: id,
            activeWordEnabled: enabled, activeWordColor: style.activeWord.color });
        }} />
      {style.activeWord.enabled && <ColorField title='Active word colour'
        value={style.activeWord.color}
        onInput={(color) => patch({ activeWord: { ...style.activeWord, color } })}
        onCommit={(color) => commitActiveWord({ color })} />}
      {style.activeWord.enabled && !canHighlightWords(properties) &&
        <p className='text-[10px] leading-4 text-warning-soft/70'>
          {words.length === 0
            ? 'This caption has no word timings, so it renders as a normal caption — word-level animation is never faked.'
            : 'The wording no longer matches the stored word timings, so this caption renders without the highlight.'}
        </p>}
    </Section>}

    <Section title='Font'>
      <label className={label}>Family
        <select className={field} value={style.fontFamily} aria-label='Font family'
          onChange={(event) => { patch({ fontFamily: event.target.value });
            onCommit({ action: 'set-text-font', elementId: id,
              fontFamily: event.target.value }); }}>
          {EDIT_MODE_FONTS.map((font) =>
            <option key={font.id} value={font.id}>{font.label}</option>)}
        </select>
      </label>
      <div className='grid grid-cols-2 gap-2'>
        <label className={label}>Size
          <input className={field} type='number' aria-label='Font size'
            min={TEXT_BOUNDS.minFontSize} max={TEXT_BOUNDS.maxFontSize}
            value={style.fontSize}
            onChange={(event) => patch({ fontSize: num(event.target.value, style.fontSize) })}
            onBlur={commitSize} />
        </label>
        <label className={label}>Weight
          <select className={field} value={style.fontWeight} aria-label='Font weight'
            onChange={(event) => { const weight = num(event.target.value, 700);
              patch({ fontWeight: weight });
              onCommit({ action: 'set-text-weight', elementId: id, fontWeight: weight }); }}>
            {[300, 400, 500, 600, 700, 800, 900].map((weight) =>
              <option key={weight} value={weight}>{weight}</option>)}
          </select>
        </label>
      </div>
      <Slider title='Size' value={style.fontSize} min={TEXT_BOUNDS.minFontSize}
        max={150} step={1} onInput={(value) => patch({ fontSize: value })} onCommit={commitSize} />
      <p className='text-[10px] leading-4 text-faint'>
        ASS carries one bold flag, so 600 and above export bold and below export regular.</p>
    </Section>

    <Section title='Style'>
      <ColorField title='Text colour' value={style.color}
        onInput={(color) => patch({ color, textRuns: recolorBaseRuns(properties, color) })}
        onCommit={(color) => onCommit({ action: 'set-text-color', elementId: id, color })} />
      <Slider title='Opacity' value={style.opacity} min={0} max={1} step={0.01}
        format={(value) => `${Math.round(value * 100)}%`}
        onInput={(value) => patch({ opacity: value })} onCommit={commitOpacity} />
      <div className='grid grid-cols-3 gap-1'>
        {(['left', 'center', 'right'] as const).map((align) =>
          <button key={align} onClick={() => { patch({ textAlign: align });
            onCommit({ action: 'set-text-alignment', elementId: id, textAlign: align }); }}
            className={`rounded-md border py-1 text-[10px] capitalize ${
              style.textAlign === align ? 'border-secondary/50 bg-secondary/15 text-secondary-soft'
                : 'border-border text-soft'}`}>{align}</button>)}
      </div>
    </Section>

    {!caption && content.trim() && <WordColors key={id} elementId={id} properties={properties} content={content}
      baseColor={style.color} onPreview={(textRuns) => patch({ textRuns })} onCommit={onCommit} />}

    <Section title='Stroke' defaultOpen={false}>
      <Toggle title='Stroke' checked={style.stroke.enabled}
        onChange={(enabled) => { patch({ stroke: { ...style.stroke, enabled } });
          onCommit({ action: 'set-text-stroke', elementId: id, strokeEnabled: enabled,
            strokeColor: style.stroke.color, strokeWidth: style.stroke.width }); }} />
      <ColorField title='Colour' value={style.stroke.color}
        onInput={(color) => patch({ stroke: { ...style.stroke, color } })}
        onCommit={(color) => commitStroke({ color })} />
      <Slider title='Width' value={style.stroke.width} min={0} max={TEXT_BOUNDS.maxStrokeWidth}
        step={0.5} onInput={(width) => patch({ stroke: { ...style.stroke, width } })}
        onCommit={() => commitStroke()} />
      {strokeSuppressed && <p className='text-[10px] leading-4 text-warning-soft/70'>
        A background plate and a stroke cannot both be drawn in the export, so the plate wins.
        The preview shows the same choice.</p>}
    </Section>

    <Section title='Shadow' defaultOpen={false}>
      <Toggle title='Shadow' checked={style.shadow.enabled}
        onChange={(enabled) => { patch({ shadow: { ...style.shadow, enabled } });
          onCommit({ action: 'set-text-shadow', elementId: id, shadowEnabled: enabled,
            shadowColor: style.shadow.color, shadowOpacity: style.shadow.opacity,
            shadowBlur: style.shadow.blur, shadowOffsetX: style.shadow.offsetX,
            shadowOffsetY: style.shadow.offsetY }); }} />
      <ColorField title='Colour' value={style.shadow.color}
        onInput={(color) => patch({ shadow: { ...style.shadow, color } })}
        onCommit={(color) => commitShadow({ color })} />
      <Slider title='Opacity' value={style.shadow.opacity} min={0} max={1} step={0.01}
        format={(value) => `${Math.round(value * 100)}%`}
        onInput={(opacity) => patch({ shadow: { ...style.shadow, opacity } })}
        onCommit={() => commitShadow()} />
      <Slider title='Blur' value={style.shadow.blur} min={0} max={TEXT_BOUNDS.maxShadowBlur}
        step={1} onInput={(blur) => patch({ shadow: { ...style.shadow, blur } })}
        onCommit={() => commitShadow()} />
      <div className='grid grid-cols-2 gap-2'>
        {(['offsetX', 'offsetY'] as const).map((axis) => <label key={axis} className={label}>
          {axis === 'offsetX' ? 'X offset' : 'Y offset'}
          <input className={field} type='number' aria-label={axis}
            min={-TEXT_BOUNDS.maxShadowOffset} max={TEXT_BOUNDS.maxShadowOffset} step={1}
            value={style.shadow[axis]}
            onChange={(event) => patch({ shadow: { ...style.shadow,
              [axis]: num(event.target.value) } })}
            onBlur={() => commitShadow()} />
        </label>)}
      </div>
      <p className='text-[10px] leading-4 text-faint'>
        ASS has no independent shadow blur; the export softens the border and shadow together,
        which is the closest visual match.</p>
    </Section>

    <Section title='Background' defaultOpen={false}>
      <Toggle title='Background plate' checked={style.background.enabled}
        onChange={(enabled) => { patch({ background: { ...style.background, enabled } });
          onCommit({ action: 'set-text-background', elementId: id, backgroundEnabled: enabled,
            backgroundColor: style.background.color,
            backgroundOpacity: style.background.opacity,
            backgroundPadding: style.background.padding,
            backgroundRadius: style.background.radius }); }} />
      <ColorField title='Colour' value={style.background.color}
        onInput={(color) => patch({ background: { ...style.background, color } })}
        onCommit={(color) => commitBackground({ color })} />
      <Slider title='Opacity' value={style.background.opacity} min={0} max={1} step={0.01}
        format={(value) => `${Math.round(value * 100)}%`}
        onInput={(opacity) => patch({ background: { ...style.background, opacity } })}
        onCommit={() => commitBackground()} />
      <Slider title='Padding' value={style.background.padding} min={0}
        max={TEXT_BOUNDS.maxBackgroundPadding} step={1}
        onInput={(padding) => patch({ background: { ...style.background, padding } })}
        onCommit={() => commitBackground()} />
      <Slider title='Corner radius' value={style.background.radius} min={0}
        max={TEXT_BOUNDS.maxBackgroundRadius} step={1}
        onInput={(radius) => patch({ background: { ...style.background, radius } })}
        onCommit={() => commitBackground()} />
      {style.background.enabled && style.background.radius > 0 &&
        <p className='text-[10px] leading-4 text-warning-soft/70'>
          Rounded plates render square in the export — ASS has no corner radius.</p>}
    </Section>

    <Section title='Spacing' defaultOpen={false}>
      <Slider title='Letter spacing' value={style.letterSpacing}
        min={TEXT_BOUNDS.minLetterSpacing} max={TEXT_BOUNDS.maxLetterSpacing} step={0.5}
        onInput={(letterSpacing) => patch({ letterSpacing })} onCommit={commitSpacing} />
      <Slider title='Line spacing' value={style.lineSpacing} min={TEXT_BOUNDS.minLineSpacing}
        max={TEXT_BOUNDS.maxLineSpacing} step={0.05}
        format={(value) => `${value.toFixed(2)}×`}
        onInput={(lineSpacing) => patch({ lineSpacing })} onCommit={commitSpacing} />
      <p className='text-[10px] leading-4 text-faint'>
        Line spacing shapes the preview only; libass lays lines out on the font&rsquo;s own
        leading.</p>
    </Section>

    <Section title='Transform'>
      <div className='grid grid-cols-2 gap-2'>
        {(['x', 'y'] as const).map((key) => <label key={key} className={`${label} uppercase`}>
          {key}
          <input className={field} type='number' min={0} max={1} step={0.01}
            aria-label={`Position ${key}`} value={num(properties[key])}
            onChange={(event) => patch({ [key]: num(event.target.value) })}
            onBlur={commitMove} />
        </label>)}
        {(['width', 'height'] as const).map((key) => <label key={key} className={label}>
          {key === 'width' ? 'Width' : 'Height'}
          <input className={field} type='number' min={0.02} max={1} step={0.01}
            aria-label={key} value={num(properties[key])}
            onChange={(event) => patch({ [key]: num(event.target.value) })}
            onBlur={commitResize} />
        </label>)}
      </div>
      <Slider title='Rotation' value={num(properties.rotation)} min={-180} max={180} step={1}
        format={(value) => `${value}°`}
        onInput={(rotation) => patch({ rotation })} onCommit={commitRotation} />
    </Section>

    <Section title='Timing'>
      <div className='grid grid-cols-2 gap-2'>
        <label className={label}>Start
          <input className={field} type='number' min={0} step={0.05} aria-label='Start'
            value={selected.startTime}
            onChange={(event) => onPreview({ ...selected,
              startTime: num(event.target.value) })}
            onBlur={commitTiming} />
        </label>
        <label className={label}>Duration
          <input className={field} type='number' min={0.05} step={0.05} aria-label='Duration'
            value={selected.duration}
            onChange={(event) => onPreview({ ...selected,
              duration: num(event.target.value, 0.05) })}
            onBlur={commitTiming} />
        </label>
      </div>
      <p className='text-[10px] text-faint'>
        Ends at {(selected.startTime + selected.duration).toFixed(2)}s of
        {' '}{timelineDurationSec.toFixed(2)}s</p>
    </Section>

    <Section title='Layer' defaultOpen={false}>
      <div className='grid grid-cols-4 gap-1'>
        {([['Back', -1000], ['−', -1], ['+', 1], ['Front', 1000]] as const).map(([text, delta]) =>
          <button key={text} onClick={() => onCommit({ action: 'set-element-z-index',
            elementId: id, zIndex: Math.max(0, num(properties.zIndex) + delta) })}
            className='rounded border border-border py-1 text-[10px]'>
            <Layers size={10} className='mx-auto' />{text}</button>)}
      </div>
      <p className={label}>zIndex {num(properties.zIndex)}</p>
    </Section>
  </div>;
}

/**
 * Per-word colours (e.g. the emphasised word of a StyleOne hook). Pick words, choose a colour, apply:
 * one canonical SET_TEXT_RUNS command, so the preview and the export draw exactly the same colours.
 */
function WordColors({ elementId, properties, content, baseColor, onPreview, onCommit }: {
  elementId: string; properties: Record<string, unknown>; content: string; baseColor: string;
  onPreview: (textRuns: Array<{ text: string; color: string }>) => void; onCommit: (command: ManualEditCommand) => void;
}) {
  const words = wordColors(properties);
  const [picked, setPicked] = useState<number[]>([]);
  const highlighted = words.map((word, index) => word.color !== baseColor.toLowerCase() ? index : -1).filter((index) => index >= 0);
  const [color, setColor] = useState(highlighted.length ? words[highlighted[0]].color : '#ffd400');
  const commit = (colors: string[]) => {
    const textRuns = runsFromWordColors(content, colors, baseColor);
    if (textRuns.length > 24) return;
    onPreview(textRuns);
    onCommit({ action: 'set-text-runs', elementId, textRuns });
  };
  const toggle = (index: number) => setPicked((now) => now.includes(index) ? now.filter((i) => i !== index) : [...now, index]);
  return <Section title='Word colours'>
    <p className='text-[10px] leading-4 text-faint'>Tap words to select them, then colour them. Other words keep the text colour.</p>
    <div className='flex flex-wrap gap-1' role='group' aria-label='Words'>
      {words.map((word, index) => <button key={`${index}-${word.text}`} type='button' aria-pressed={picked.includes(index)}
        onClick={() => toggle(index)} style={{ color: word.color }}
        className={`rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${picked.includes(index) ? 'border-secondary bg-secondary/20' : 'border-border bg-inset'}`}>
        {word.text}</button>)}
    </div>
    <ColorField title='Colour for selected words' value={color} onInput={setColor} onCommit={() => undefined} />
    <div className='grid grid-cols-2 gap-1'>
      <button type='button' disabled={!picked.length} onClick={() => { commit(words.map((word, index) => picked.includes(index) ? color : word.color)); setPicked([]); }}
        className='rounded-md border border-secondary/40 py-1 text-[10px] font-semibold text-secondary-soft disabled:opacity-30'>Colour selected</button>
      <button type='button' disabled={!highlighted.length} onClick={() => commit(words.map((word, index) => highlighted.includes(index) ? color : word.color))}
        className='rounded-md border border-border py-1 text-[10px] disabled:opacity-30'>Recolour highlights</button>
      <button type='button' disabled={!picked.length} onClick={() => { commit(words.map((word, index) => picked.includes(index) ? baseColor : word.color)); setPicked([]); }}
        className='rounded-md border border-border py-1 text-[10px] disabled:opacity-30'>Reset selected</button>
      <button type='button' disabled={!highlighted.length} onClick={() => commit(words.map(() => baseColor))}
        className='rounded-md border border-border py-1 text-[10px] disabled:opacity-30'>One colour for all</button>
    </div>
  </Section>;
}
