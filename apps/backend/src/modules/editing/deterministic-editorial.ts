import type { EditPlan, SubtitleEmphasis, TimedWord } from './edit-plan';
import { fallbackMusicMood } from './music-library';
import { semanticZoomTarget, ZOOM_TUNING } from './zoom-planner';

// Non-LLM editorial signals for plans produced without Luna (OFFLINE,
// FALLBACK_ONLY, or a failed plan). Only spoken words are ever emphasized.
const STOP = new Set(['because', 'through', 'without', 'another', 'something', 'anything',
  'everything', 'nothing', 'actually', 'basically', 'probably', 'literally', 'already',
  'whatever', 'somebody', 'everyone', 'everybody', 'yourself', 'themselves', 'himself',
  'herself', 'between', 'whether', 'they\'re', 'there\'s', 'wouldn\'t', 'couldn\'t', 'shouldn\'t']);
const NUMBER_WORDS = /^(million|billion|trillion|percent|hundred|thousand|half|double|triple)$/u;
// Words worth a viewer's eye: the surprise, the turn, the stake, the payoff.
// Ordinary filler never qualifies, however long it is.
const MEANINGFUL = new Set(['never', 'nobody', 'always',
  'banned', 'illegal', 'blocked', 'stopped', 'refused', 'denied', 'failed', 'failure',
  'secret', 'hidden', 'quietly', 'ignored', 'exposed', 'revealed', 'admitted', 'confirmed',
  'wrong', 'mistake', 'lie', 'lied', 'fraud', 'scam', 'stolen', 'crisis', 'collapse',
  'danger', 'risk', 'threat', 'warning', 'worst', 'best', 'biggest', 'largest', 'fastest',
  'first', 'last', 'only', 'record', 'instead', 'despite', 'however', 'until',
  'backfired', 'opposite', 'cost', 'consequence', 'forced', 'changed', 'transformed',
  'became', 'overnight', 'impossible', 'proof', 'truth', 'reason']);
// Capitalised at the start of a sentence rather than because it names anything.
const SENTENCE_STARTERS = new Set(['this', 'that', 'these', 'those', 'there', 'their', 'they',
  'then', 'when', 'what', 'where', 'which', 'while', 'with', 'from', 'here', 'have', 'been',
  'because', 'about', 'after', 'before', 'every', 'some', 'most', 'more', 'just', 'even']);
const clean = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}'%$]/gu, '');

function score(word: TimedWord) {
  const token = clean(word.text);
  const letters = token.replace(/[^\p{L}]/gu, '');
  if (/\d/u.test(token) || NUMBER_WORDS.test(token)) return 3;
  if (letters.length >= 3 && word.text.replace(/[^\p{L}]/gu, '') === word.text.replace(/[^\p{L}]/gu, '').toUpperCase())
    return 2.5;
  if (MEANINGFUL.has(token)) return 2.4;
  // A capitalised word mid-sentence is a name, place or product: the concrete
  // thing the phrase is about.
  if (letters.length >= 4 && /^\p{Lu}/u.test(word.text) && !STOP.has(token) &&
    !SENTENCE_STARTERS.has(token)) return 1.8;
  if (letters.length >= 8 && !STOP.has(token)) return 1 + letters.length / 20;
  return 0;
}

export function applyDeterministicEditorial(plan: EditPlan, words: TimedWord[], transcript: string): EditPlan {
  const inRange = words.filter((word) => word.start >= plan.clipStartSec && word.end <= plan.clipEndSec);
  const duration = plan.clipEndSec - plan.clipStartSec;
  const limit = semanticZoomTarget(duration);
  const picked: TimedWord[] = [];
  for (const word of [...inRange].sort((a, b) => score(b) - score(a) || a.start - b.start)) {
    if (score(word) <= 0 || picked.length >= limit) break;
    if (picked.some((other) => Math.abs(other.start - word.start) < ZOOM_TUNING.localPeakSpacingSec)) continue;
    picked.push(word);
  }
  picked.sort((a, b) => a.start - b.start);
  const subtitleEmphasis: SubtitleEmphasis[] = plan.subtitleEmphasis.length ? plan.subtitleEmphasis :
    picked.map((word) => ({ word: word.text, startSec: word.start, endSec: word.end,
      strength: score(word) >= 2.5 ? 'STRONG' as const : 'MEDIUM' as const }));
  const operations = [...plan.operations];
  // Without Luna the beats are whatever the deterministic scorer found. Zoom is
  // the only motion device now, so the fallback plans a real handful of them -
  // roughly one per 10 s, on the strongest words - instead of a single token
  // push. The planner still enforces spacing, safety and the final budget.
  if (!operations.some((operation) => operation.type === 'ZOOM') && duration >= 12) {
    const strength = new Map(subtitleEmphasis.map((item) => [item.startSec, item.strength]));
    const budget = semanticZoomTarget(duration);
    const chosen: TimedWord[] = [];
    for (const word of [...picked].sort((a, b) => score(b) - score(a))) {
      if (chosen.length >= budget || score(word) < 1.4) break;
      if (word.start <= plan.clipStartSec + 1.5 || word.end >= plan.clipEndSec - 1.2) continue;
      if (chosen.some((other) => Math.abs(other.start - word.start) < ZOOM_TUNING.localPeakSpacingSec)) continue;
      chosen.push(word);
    }
    for (const word of chosen.sort((a, b) => a.start - b.start)) {
      const numeric = /\d|\b(million|billion|percent|hundred|thousand)\b/iu.test(word.text);
      const strong = strength.get(word.start) === 'STRONG';
      operations.push({ type: 'ZOOM', startSec: Math.max(plan.clipStartSec, word.start - .3),
        endSec: Math.min(plan.clipEndSec, word.end + 1.2),
        reason: numeric ? 'Statistic emphasis' : 'Emphasis on key spoken word',
        scale: strong ? 1.3 : 1.2, focusX: null, focusY: null, target: 'FACE', words: [],
        intensity: strong ? 'STRONG' : 'NORMAL',
        triggerText: word.text.replace(/[^\p{L}\p{N}%$' ]/gu, '') });
    }
  }
  return { ...plan, subtitleEmphasis, operations,
    subtitleStyle: { ...plan.subtitleStyle, animationStyle: 'POP', highlightCurrentWord: true },
    musicMood: plan.musicMood && plan.musicMood !== 'CLEAN_NEUTRAL' ? plan.musicMood :
      fallbackMusicMood(transcript) };
}
