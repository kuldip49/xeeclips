import { createHash } from 'crypto';
import type { ContentEvidence } from './content-understanding.service';
import { ClipBoundaryService, transcriptBoundaryWords, type BoundaryQa } from './clip-boundary.service';
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
/** Validate user-retained ranges without silently changing explicit manual trims. */
export function retainedBoundaryQa(segments: unknown[], ranges: Array<{start:number;end:number}>, sourceDuration?: number): BoundaryQa | undefined {
  if (!ranges.length) return undefined;
  const words = transcriptBoundaryWords(segments.map(record).map(s => ({ start: Number(s.start), end: Number(s.end),
    text: String(s.text ?? ''), words: s.words, speaker: typeof s.speaker === 'string' ? s.speaker : null })));
  const results = ranges.map(r => new ClipBoundaryService().validate({startTime:r.start,endTime:r.end,transcriptText:''},words,
    {minDuration:.1,sourceDuration}));
  const qa = {...results[0].qa};
  for (const key of Object.keys(qa) as Array<keyof BoundaryQa>) qa[key] = results.every(r => r.qa[key]);
  return qa;
}
/** Evidence follows retained SOURCE ranges; removed speech/hidden overlays cannot supply creative facts. */
export function editProjectEvidence(value: unknown): ContentEvidence {
  const p = record(value), assets = Array.isArray(p.assets) ? p.assets.map(record) : [];
  const elements = Array.isArray(p.elements) ? p.elements.map(record) : [];
  const source = assets.find(a => a.role === 'SOURCE') ?? {};
  const ranges = elements.filter(e => e.type === 'VIDEO' && e.assetId === source.id && record(e.properties).hidden !== true)
    .map(e => ({ start: Number(e.trimStart ?? 0), end: Number(e.trimEnd ?? Number(e.trimStart ?? 0) + Number(e.duration)) }));
  const transcript = record(source.transcript), segments = Array.isArray(transcript.segments) ? transcript.segments.map(record) : [];
  const kept = (start:number,end:number) => ranges.some(r => start >= r.start-.001 && end <= r.end+.001);
  const speech = segments.flatMap(s => {
    const words = Array.isArray(s.words) ? s.words.map(record) : [];
    return words.length ? words.filter(w => kept(Number(w.start),Number(w.end))).map(w => String(w.text ?? w.word ?? ''))
      : kept(Number(s.start),Number(s.end)) ? [String(s.text ?? '')] : [];
  }).join(' ');
  const visible = elements.filter(e => ['TEXT','SUBTITLE'].includes(String(e.type)) && record(e.properties).hidden !== true
    && !['HOOK','KEY_POINT'].includes(String(record(e.properties).presetRole))
    && !['HOOK','KEY_POINT'].includes(String(record(e.properties).templateRole)))
    .map(e => String(record(e.properties).content ?? '')).filter(Boolean).join('\n');
  return { sourceId: String(source.id ?? p.id ?? ''), transcript: speech,
    previousContext: segments.filter(s => Number(s.end) <= Math.min(...ranges.map(r=>r.start))).map(s=>String(s.text??'')).join(' ').slice(-1500),
    nextContext: segments.filter(s => Number(s.start) >= Math.max(...ranges.map(r=>r.end))).map(s=>String(s.text??'')).join(' ').slice(0,1500),
    boundaryQa: retainedBoundaryQa(segments,ranges,typeof source.duration==='number'?source.duration:undefined),
    transcriptVersion: createHash('sha256').update(JSON.stringify({transcript,ranges})).digest('hex'),
    visualVersion: createHash('sha256').update(visible).digest('hex'), visibleText: visible,
    speakerTurns: segments.filter(s => kept(Number(s.start),Number(s.end)) && typeof s.speaker === 'string')
      .map(s => ({speaker:String(s.speaker),text:String(s.text ?? '')})),
    // A full-source OCR summary can include text cropped out by hand. Retained overlays are the safe default here.
    sceneType: String(record(record(source.analysis).summary).sceneType ?? ''),
    template: String(record(p.settings).selectedPreset ?? '') };
}
