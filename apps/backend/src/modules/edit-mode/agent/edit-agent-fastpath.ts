// Step 7: deterministic handling for SIMPLE, OBVIOUS commands.
//
// OpenAI is the semantic interpreter for vague, creative, multilingual and
// imperfect wording. This file only covers the unambiguous shapes the Step 5
// primitives introduced (whole-clip framing, music to N%, zooms weaker/remove/
// add, caption colour + active word, regenerate captions, "finish it"), so they
// work instantly and without AI - and so the older natural-language layer's
// near-misses for them ("crop to 9:16" becoming a uniform 6% inset crop) are
// never used.
//
// `normalizeRequest` is a deliberately SMALL Hinglish lexicon so the offline
// fallback still understands the most common mixed-language edits. It is not a
// language model and does not try to be: anything it does not reduce to plain
// English is left for OpenAI.

import type { AgentToolCall } from './edit-agent.types';
import { boundaryRequest } from './edit-agent-boundary';

const HINGLISH: Array<[RegExp, string]> = [
  [/\b(?:thoda|thodi|thora|zara)\s+/gu, 'a little '],
  [/\b(?:bahut|bohot|kaafi)\s+/gu, 'much '],
  [/\b(?:kam\s+(?:karo|kar\s+do|kardo|kijiye)|ghatao|kam)\b/gu, 'lower'],
  [/\b(?:zyada\s+(?:karo|kar\s+do)|badhao|badha\s+do|tez\s+karo)\b/gu, 'higher'],
  [/\b(?:neeche|niche|nichey)\b/gu, 'lower'],
  [/\b(?:upar|oopar)\b/gu, 'higher'],
  [/\b(?:bada|badi|bade)\s+(?:karo|kar\s+do|kardo)\b/gu, 'bigger'],
  [/\b(?:chhota|chota|chhoti|choti)\s+(?:karo|kar\s+do|kardo)\b/gu, 'smaller'],
  [/\b(?:hatao|hata\s+do|nikalo|nikal\s+do)\b/gu, 'remove'],
  [/\b(?:garam|warm)\s+(?:karo|kar\s+do)\b/gu, 'warmer'],
  [/\b(?:safed)\b/gu, 'white'], [/\b(?:peela|peeli)\b/gu, 'yellow'],
  [/\b(?:kaala|kaali)\b/gu, 'black'], [/\b(?:laal)\b/gu, 'red'],
  [/\b(?:gaana|gana)\b/gu, 'music'], [/\b(?:awaaz|awaz|aawaz)\b/gu, 'volume'],
  [/\b(?:aur)\b/gu, 'and'], [/\b(?:phir)\b/gu, 'then'],
  [/\b(?:bana\s+do|banao|kar\s+do|kardo|karo|rakho|rakh\s+do|kijiye|please|yaar|bhai)\b/gu, '']
];

/** Lower-cased English-ish form used for matching; the ledger keeps the user's words. */
export function normalizeRequest(message: string) {
  let value = message.toLowerCase();
  for (const [pattern, replacement] of HINGLISH) value = value.replace(pattern, replacement);
  return value.replace(/\s{2,}/gu, ' ').trim();
}

const COLORS = 'yellow|white|black|red|blue|green|orange|pink|purple|gold|grey|gray|cyan|teal';

export type FastPath = { intent: string; calls: AgentToolCall[] } | { intent: 'FINISH' } |
  { intent: 'CONFIRM' };

const SAVED_CATEGORY: Array<[RegExp, string]> = [[/captions?|subtitles?/u, 'CAPTIONS'],
  [/colou?rs?|look|grade|grading/u, 'COLOR'], [/hook/u, 'HOOK'], [/text/u, 'TEXT'],
  [/zooms?/u, 'ZOOM'], [/framing|crop/u, 'FRAMING'], [/audio|music/u, 'AUDIO'],
  [/background|layout/u, 'BACKGROUND'], [/logo|intro|brand/u, 'OVERLAY']];

/** Step 17: "use my usual podcast captions" -> a saved-style lookup by category. */
export function savedStyleRequest(clause: string): { category: string; spoken: string } | null {
  const match = /\b(?:use|apply|put on|switch to|go with)\s+my\s+(?:usual|saved|normal|favou?rite|own|regular)?\s*(.{1,60})$/u
    .exec(clause.toLowerCase().trim());
  if (!match) return null;
  const spoken = match[1].trim();
  const category = SAVED_CATEGORY.find(([pattern]) => pattern.test(spoken))?.[1];
  return category ? { category, spoken } : null;
}

export function fastPath(clause: string): FastPath | null {
  const text = clause.toLowerCase().trim();
  if (/^(?:finish(?: it| the edit| up)?|complete (?:it|the edit)|wrap (?:it )?up|do the rest|finish what'?s left)$/u.test(text)) {
    return { intent: 'FINISH' };
  }
  if (/^(?:yes|yep|yeah|sure|confirm(?:ed)?|go ahead|do it|proceed|ok(?:ay)?|haan?)(?:[\s,!.]+(?:yes|do it|go ahead|please|proceed|confirm|apply it|karo))*[.!]?$/u.test(text)) {
    return { intent: 'CONFIRM' };
  }

  // --- Step 16: transcript-based clip boundaries -------------------------------
  const boundary = boundaryRequest(clause);
  if (boundary) {
    return { intent: boundary.anchor === 'PHRASE'
      ? `${boundary.edge === 'START' ? 'Start' : 'End'} at "${boundary.phrase}"`
      : `${boundary.edge === 'START' ? 'Start' : 'End'}: ${boundary.anchor.toLowerCase().replace(/_/gu, ' ')}`,
    calls: [{ tool: 'video.semantic_boundary', args: { ...boundary } }] };
  }

  // --- the self-review's own fix instructions ("finish it") -------------------
  // These are fixed strings emitted by EditReviewService, mapped to tools so a
  // "finish it" pass can act on them without AI. Anything not mapped here is
  // reported honestly rather than guessed.
  if (/^make the existing hook shorter/u.test(text)) {
    return { intent: 'Shorten the hook', calls: [{ tool: 'hook.write', args: { mode: 'SHORTER' } }] };
  }
  if (/^add a concise curiosity-based opening hook/u.test(text)) {
    return { intent: 'Add an opening hook', calls: [{ tool: 'hook.write', args: { mode: 'NEW' } }] };
  }
  if (/^generate captions from the existing timed transcript/u.test(text)) {
    return { intent: 'Generate captions', calls: [{ tool: 'captions.generate', args: {} }] };
  }
  if (/^make the existing captions easier to read/u.test(text)) {
    return { intent: 'Make captions easier to read', calls: [{ tool: 'captions.style',
      args: { scope: 'ALL', fontWeight: 700, backgroundColor: '#000000', backgroundOpacity: 0.5 } }] };
  }
  if (/^make the existing zooms more subtle/u.test(text)) {
    return { intent: 'Make zooms more subtle', calls: [{ tool: 'zoom.adjust',
      args: { direction: 'WEAKER', scope: 'ALL' } }] };
  }
  if (/^lower the existing music under speech and add gentle fades/u.test(text)) {
    return { intent: 'Duck the music under speech with gentle fades', calls: [
      { tool: 'audio.ducking', args: { enabled: true, strength: 'MEDIUM' } },
      { tool: 'audio.fade', args: { fadeInSec: 0.5, fadeOutSec: 1 } }] };
  }

  // --- framing ---------------------------------------------------------------
  const aspect = /\b(?:9\s*[:x/]\s*16|vertical(?:ly)?|portrait)\b/u.test(text) ? '9:16'
    : /\b(?:16\s*[:x/]\s*9|horizontal(?:ly)?|landscape)\b/u.test(text) ? '16:9'
      : /\b(?:1\s*[:x/]\s*1|square)\b/u.test(text) ? '1:1' : null;
  const framingVerb = /\b(?:crop|reframe|frame|make|convert|turn|change|switch|set|fit|fill)\b/u.test(text);
  const videoWords = /\b(?:video|clip|footage|it|whole|entire|everything|segment|shot|frame)\b/u.test(text);
  const segment = /\b(?:this (?:segment|shot|part|cut)|current (?:segment|shot)|only here)\b/u.test(text);
  const scope = segment ? 'CURRENT_SEGMENT' : 'WHOLE_CLIP';
  if (aspect && framingVerb && (videoWords || /\bcrop\b/u.test(text)) &&
    !/\b(caption|subtitle|text|hook|logo|image)\b/u.test(text)) {
    return { intent: `Crop ${segment ? 'this segment' : 'the whole clip'} to ${aspect}`,
      calls: [{ tool: 'video.frame', args: { mode: 'ASPECT', aspectRatio: aspect, scope } }] };
  }
  if (/\b(?:fit|show) (?:the )?(?:whole|entire|full) (?:frame|picture|video)\b|\bfit (?:it|the video|the clip)\b/u.test(text)) {
    return { intent: 'Fit the whole frame', calls: [{ tool: 'video.frame', args: { mode: 'FIT', scope } }] };
  }
  if (/\bfill (?:the )?(?:frame|screen|canvas)\b|\bno black bars\b/u.test(text)) {
    return { intent: 'Fill the frame', calls: [{ tool: 'video.frame', args: { mode: 'FILL', scope } }] };
  }
  const reframe = /\b(?:face|speaker|talking.head)\b.*\b(?:focus|priority|frame|framing|reframe|follow|track)\b|\b(?:focus|frame|reframe|follow|track)\b.*\b(?:face|speaker|talking.head)\b/u.test(text)
    ? 'FACE_PRIORITY'
    : /\b(?:center|centre)(?:ed|d)? (?:the )?(?:frame|framing|video|shot)\b|\bcentered framing\b/u.test(text) ? 'CENTERED'
      : /\b(?:screen|tutorial|slides?|information|text on screen)\b.*\b(?:framing|frame|reframe|readable|visible)\b/u.test(text) ? 'INFORMATION_PRIORITY' : null;
  if (reframe) return { intent: `Reframe for ${reframe.toLowerCase().replace('_', ' ')}`,
    calls: [{ tool: 'video.reframe', args: { policy: reframe } }] };

  // --- music to an exact level ----------------------------------------------
  const percent = /(\d{1,3})\s*(?:%|percent)/u.exec(text);
  if (/\b(?:music|song|bgm|background (?:music|track)|soundtrack)\b/u.test(text) && percent &&
    !/\b(?:video audio|original (?:audio|sound)|voice)\b/u.test(text)) {
    const volume = Math.min(200, Number(percent[1])) / 100;
    return { intent: `Set the music to ${percent[1]}%`,
      calls: [{ tool: 'audio.music_volume', args: { volume } }] };
  }

  // --- zooms --------------------------------------------------------------------
  if (/\bzoom/u.test(text)) {
    const selected = /\b(?:this|that|selected|current) zoom\b/u.test(text);
    const scopeArg = selected ? 'SELECTED' : 'ALL';
    if (/\b(?:remove|delete|drop|get rid of|no|kill|turn off|disable)\b/u.test(text)) {
      return { intent: selected ? 'Remove this zoom' : 'Remove all zooms',
        calls: [{ tool: 'zoom.remove', args: { scope: scopeArg } }] };
    }
    if (/\b(?:too strong|too much|too aggressive|weaker|softer|subtler|less|gentler|tone (?:it |them )?down|reduce|calmer|lower)\b/u.test(text)) {
      return { intent: `Make ${selected ? 'this zoom' : 'the zooms'} weaker`,
        calls: [{ tool: 'zoom.adjust', args: { direction: 'WEAKER', scope: scopeArg } }] };
    }
    if (/\b(?:stronger|punchier|more|bigger|harder|increase|too weak|too subtle)\b/u.test(text) &&
      !/\badd\b/u.test(text)) {
      return { intent: `Make ${selected ? 'this zoom' : 'the zooms'} stronger`,
        calls: [{ tool: 'zoom.adjust', args: { direction: 'STRONGER', scope: scopeArg } }] };
    }
    if (/\badd\b.*\bzooms\b|\b(?:some|a few|few)\b.*\bzooms\b/u.test(text)) {
      const strength = /\b(?:strong|punch|punchy|energetic)\b/u.test(text) ? 'STRONG'
        : /\b(?:balanced|moderate|medium)\b/u.test(text) ? 'BALANCED' : 'SUBTLE';
      return { intent: `Add ${strength.toLowerCase()} zooms at emphasis moments`,
        calls: [{ tool: 'zoom.add_semantic', args: { strength } }] };
    }
  }

  // --- captions: colour + active word, regenerate ----------------------------
  if (/\b(?:caption|subtitle)s?\b/u.test(text)) {
    if (/\bregenerate\b|\bredo (?:the )?(?:caption|subtitle)s? (?:text|wording)\b|\bre-?transcribe\b/u.test(text)) {
      return { intent: 'Regenerate caption wording from the transcript',
        calls: [{ tool: 'captions.regenerate', args: {} }] };
    }
    const active = new RegExp(`\\b(${COLORS})\\s+(?:active|highlight(?:ed)?|current|spoken)\\s*(?:words?|highlights?)?\\b`, 'u').exec(text) ??
      new RegExp(`\\b(?:active|highlight(?:ed)?)\\s*(?:words?)?\\s+(?:in\\s+)?(${COLORS})\\b`, 'u').exec(text);
    const base = new RegExp(`\\b(?:captions?|subtitles?)\\s+(?:to\\s+|in\\s+)?(${COLORS})\\b|\\b(${COLORS})\\s+(?:captions?|subtitles?)\\b`, 'u').exec(text);
    const selected = /\b(?:this|that|selected|current) (?:caption|subtitle)\b/u.test(text);
    if (active || (base && /\bwith\b/u.test(text))) {
      const args: Record<string, unknown> = { scope: selected ? 'SELECTED' : 'ALL' };
      const color = base?.[1] ?? base?.[2];
      if (color && color !== active?.[1]) args.color = color;
      if (active) args.activeWordColor = active[1];
      return { intent: `Captions${args.color ? ` ${String(args.color)}` : ''}${active ? ` with ${active[1]} active words` : ''}`,
        calls: [{ tool: 'captions.style', args }] };
    }
  }
  return null;
}
