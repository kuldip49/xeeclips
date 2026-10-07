import { createHash } from 'crypto';
import type { ContentEvidence } from './content-understanding.service';
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
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
    && !['HOOK','KEY_POINT'].includes(String(record(e.properties).presetRole)))
    .map(e => String(record(e.properties).content ?? '')).filter(Boolean).join('\n');
  return { sourceId: String(source.id ?? p.id ?? ''), transcript: speech,
    transcriptVersion: createHash('sha256').update(JSON.stringify({transcript,ranges})).digest('hex'),
    visualVersion: createHash('sha256').update(visible).digest('hex'), visibleText: visible,
    speakerTurns: segments.filter(s => kept(Number(s.start),Number(s.end)) && typeof s.speaker === 'string')
      .map(s => ({speaker:String(s.speaker),text:String(s.text ?? '')})),
    // A full-source OCR summary can include text cropped out by hand. Retained overlays are the safe default here.
    sceneType: String(record(record(source.analysis).summary).sceneType ?? ''),
    template: String(record(p.settings).selectedPreset ?? '') };
}
