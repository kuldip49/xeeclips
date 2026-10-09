// Workstream G: ordinary language -> the object it means -> the canonical command.
//
// A person does not say "SET_AUDIO_VOLUME on audio:music1 to 0.14". They say
// "the music is too loud", then "lower it a little", then "a little more". This
// module understands that vocabulary WITHOUT a model, which is what makes it
// instant, reproducible, free, and - the Phase 7 rule - available OFFLINE, where
// no model may serve the chat.
//
// Every request is read as SUBJECT + OPERATION + AMOUNT:
//
//   subject    an explicit noun ("the logo", "the hook", "captions"), an asset
//              name, a pronoun, or nothing at all;
//   operation  one of a closed set of families (SCALE, POSITION, VOLUME, COLOR,
//              ZOOM, CROP, ROTATION, SPEED, TEXT style, ...);
//   amount     "a little" / normal / "a lot", or an explicit number.
//
// The subject is resolved with a fixed priority (explicit noun > fresh
// selection > the conversational ACTIVE target > the previous clause of the
// same message > the element under the playhead > the only candidate), and a
// genuinely ambiguous reference becomes ONE precise question. Relative requests
// are computed from the object's CURRENT stored value, so "a little smaller" is
// always smaller than what is on screen now.
//
// The output is ordinary ChatCommands addressed by opaque handles. Nothing here
// writes anything: the same resolver, proposal and canonical apply path the LLM
// planner uses takes it from there. Creative wording (a new hook) and templates
// are returned as REQUESTS for the service to fulfil through their own paths.

import { COLOR_BOUNDS, type ColorKey } from '../edit-mode-color';
import { MAX_ROTATION, MAX_SCALE, MAX_SPEED, MIN_CROP_REMAINDER, MIN_ROTATION, MIN_SCALE,
  MIN_SPEED, SPEED_PRESETS } from '../edit-mode-transform';
import { MAX_VOLUME } from '../edit-mode-audio';
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from '../edit-mode-text';
import { DEFAULT_ZOOM_DURATION_SEC, DEFAULT_ZOOM_SCALE, MAX_ZOOM_SCALE, MIN_ZOOM_DURATION_SEC,
  MIN_ZOOM_SCALE, ZOOM_SCALE_STEP } from '../edit-mode-zoom-events';
import type { ChatCommand, ChatGrounding, ChatTarget } from './edit-chat-commands';
import type { ChatContext, ChatElementView, ChatTemplateView,
  SemanticRole } from './edit-chat-context';
import type { HookMode } from './edit-chat-hook';
import type { ChatActiveTarget, ChatOutcomeCode } from './edit-chat.types';

// --- Outcomes -----------------------------------------------------------------

export type FollowUp = Omit<ChatActiveTarget, 'selectionId' | 'revision'>;

export type ClauseOutcome =
  | { type: 'COMMANDS'; commands: ChatCommand[]; summary: string; grounding: ChatGrounding[];
      warnings: string[]; followUp: FollowUp | null; subject: Subject | null }
  | { type: 'HOOK'; mode: HookMode; target: ChatElementView | null; summary: string;
      subject: Subject | null }
  | { type: 'TEMPLATE'; template: ChatTemplateView }
  | { type: 'QUESTION'; question: string; code: ChatOutcomeCode | null }
  | { type: 'UNSUPPORTED'; message: string };

export type NaturalPlan = { outcomes: ClauseOutcome[]; unparsed: string[] };

/** Part 19: a chat turn is a few direct intents. A whole brief is Workstream I. */
export const MAX_CHAT_INTENTS = 5;

// --- Vocabulary ---------------------------------------------------------------

type Magnitude = 'small' | 'normal' | 'large';

const SMALL = /\b(?:a (?:little|bit|tad|touch)(?: bit)?|slightly|just a bit|a hair|tiny bit|somewhat|little)\b/u;
const LARGE = /\b(?:a lot|much|way|really|very|significantly|heavily|lots|massively|a ton)\b/u;
const magnitudeOf = (text: string): Magnitude =>
  SMALL.test(text) ? 'small' : LARGE.test(text) ? 'large' : 'normal';

/** Named colours a person actually says, as the hex the validators accept. */
const COLOR_NAMES: Record<string, string> = {
  yellow: '#ffd400', white: '#ffffff', black: '#000000', red: '#ff3b30', blue: '#2f80ff',
  green: '#34c759', orange: '#ff9500', pink: '#ff2d95', purple: '#af52de', gold: '#ffc83d',
  grey: '#9ca3af', gray: '#9ca3af', cyan: '#22d3ee', teal: '#14b8a6'
};
/** The softer yellow Workstream C uses for the spoken-word highlight. */
const HIGHLIGHT_YELLOW = '#ffe066';

const FILTER_WORDS: Array<[RegExp, string]> = [
  [/\bcinematic\b/u, 'CINEMATIC'], [/\bvintage|retro|old[- ]school\b/u, 'VINTAGE'],
  [/\bvibrant|punchy\b/u, 'VIBRANT'], [/\bblack[_ ]and[_ ]white|b\s?&\s?w|monochrome|greyscale|grayscale\b/u,
    'BLACK_AND_WHITE'], [/\bsoft(?:er)? look\b|\bdreamy\b/u, 'SOFT'],
  [/\bhigh[- ]contrast (?:look|filter|style)\b/u, 'HIGH_CONTRAST'],
  [/\bwarm (?:look|filter|style|grade)\b/u, 'WARM'], [/\bcool (?:look|filter|style|grade)\b/u, 'COOL'],
  [/\bclean(?:er)?(?: look| filter| grade)?\b/u, 'CLEAN']
];

/** Built-in caption styles by the words people use for them. */
const CAPTION_STYLE_WORDS: Array<[RegExp, string]> = [
  [/\bbold highlight\b/u, 'BOLD_HIGHLIGHT'], [/\bpodcast\b/u, 'PODCAST'],
  [/\bminimal\b/u, 'MINIMAL'], [/\bsocial\b/u, 'SOCIAL'], [/\beducational\b/u, 'EDUCATIONAL'],
  [/\bhigh[- ]contrast\b/u, 'HIGH_CONTRAST'], [/\bclean(?:er)?\b/u, 'CLEAN']
];
const TEXT_STYLE_WORDS: Array<[RegExp, string]> = [
  [/\bhook style\b/u, 'HOOK'], [/\btitle style\b/u, 'TITLE'], [/\bheading style\b/u, 'HEADING'],
  [/\blower[- ]third style\b/u, 'LOWER_THIRD'], [/\bcta style\b/u, 'CTA'],
  [/\bbold social\b/u, 'BOLD_SOCIAL'], [/\bminimal style\b/u, 'MINIMAL'],
  [/\bbasic style\b/u, 'BASIC']
];
const FONT_WORDS: Array<[RegExp, string]> = [
  [/\bserif\b|\bgeorgia\b/u, 'Georgia, serif'], [/\bmono(?:space)?\b|\btypewriter\b/u, 'monospace'],
  [/\bextra ?bold\b|\bheavy font\b/u, 'Inter ExtraBold, sans-serif'],
  [/\binter\b|\bmodern font\b|\bsans(?:-serif)?\b/u, 'Inter, sans-serif'],
  [/\barial\b/u, 'Arial, sans-serif']
];

/**
 * Capabilities people ask for that this editor genuinely does not have. Each
 * answer says so and points at the nearest thing that does exist, instead of a
 * generic list of what the assistant "can help with".
 */
const UNSUPPORTED: Array<[RegExp, string]> = [
  [/\btransitions?\b|\bcross ?fade between\b|\bdissolve\b|\bwipe\b/u,
    'This editor has no transitions between clips yet. I can cut, split, reorder and change the speed of segments.'],
  [/\b(?:green ?screen|chroma ?key|remove (?:the )?background|background removal|blur (?:the )?background)\b/u,
    'Background removal and green-screen keying are not available in this editor.'],
  [/\bstabili[sz]e\b|\bshaky\b/u, 'Stabilisation is not available. I can crop or scale the video instead.'],
  [/\b(?:voice ?over|dub|text to speech|ai voice|narrat(?:e|ion))\b/u,
    'I cannot record or generate a voiceover. You can upload an audio file and I can place it.'],
  [/\b(?:sound effects?|sfx|whoosh)\b/u,
    'Sound effects are not available yet. You can upload an audio file and I can place it as music.'],
  [/\b(?:gif|emoji|sticker)s?\b/u, 'Animated stickers and emoji are not available. You can upload a PNG and I can place it as an image.'],
  [/\b(?:keyframe|animate|animation|motion track|track (?:the|his|her) (?:face|head))\b/u,
    'Keyframed animation and motion tracking are not available. I can set a fixed position, size, rotation and timing.'],
  [/\b(?:reverse|rewind effect|play backwards)\b/u, 'Reverse playback is not available.'],
  [/\bfreeze[- ]?frame\b/u, 'Freeze frames are not available yet.'],
  [/\b(?:picture[- ]in[- ]picture|pip|split[- ]?screen)\b/u,
    'Picture-in-picture and split screen are not available in this editor.'],
  [/\b(?:denoise|noise reduction|remove (?:the )?(?:noise|hiss|echo))\b/u,
    'Noise reduction is not available. I can lower or mute the original sound.'],
  [/\b(?:beat ?sync|cut to the beat|on the beat)\b/u, 'Cutting to the beat is not available yet.'],
  [/\b(?:upscale|4k|higher resolution|hdr)\b/u,
    'Resolution and HDR are decided at export; I cannot upscale the source.']
];

/** Checked before anything else: a request for a capability that does not exist. */
export function unsupportedCapability(message: string): string | null {
  const text = message.toLowerCase();
  for (const [pattern, answer] of UNSUPPORTED) if (pattern.test(text)) return answer;
  return null;
}

// --- Subjects -----------------------------------------------------------------

type SubjectKind = 'ROLE' | 'CAPTIONS' | 'CAPTION_ONE' | 'SOURCE_AUDIO' | 'VIDEO' | 'HERE' |
  'PRONOUN' | 'NONE' | 'ELEMENT';
export type Subject = { kind: SubjectKind; role?: SemanticRole; view?: ChatElementView;
  words: string };

const SUBJECTS: Array<[RegExp, Omit<Subject, 'words'>]> = [
  [/\b(?:on[- ]?screen )?(?:hook|headline|opening (?:line|text|title|headline))\b|\bstronger opening\b/u,
    { kind: 'ROLE', role: 'HOOK' }],
  [/\b(?:cta|call[- ]to[- ]action)\b/u, { kind: 'ROLE', role: 'CTA' }],
  [/\blower[- ]third\b/u, { kind: 'ROLE', role: 'LOWER_THIRD' }],
  [/\b(?:this|that|the current|the selected|one) (?:caption|subtitle|line)\b/u, { kind: 'CAPTION_ONE' }],
  [/\b(?:captions?|subtitles?|subs)\b/u, { kind: 'CAPTIONS' }],
  // "Yellow words when spoken" names no track, but only captions have spoken words.
  [/\bwords? (?:when|as) (?:it'?s |they'?re )?(?:spoken|said)|\bwords? (?:when|as) (?:i|they|he|she|we) (?:speak|say|talk)|\bhighlighted words\b|\bkaraoke\b|\bactive word\b|\bspoken word\b/u,
    { kind: 'CAPTIONS' }],
  [/\b(?:music|song|soundtrack|bgm|background (?:music|audio|track|song))\b/u,
    { kind: 'ROLE', role: 'MUSIC' }],
  [/\b(?:original|source|video'?s?|clip'?s?|recorded) (?:sound|audio|voice)\b|\b(?:dialogue|voice ?track|mic audio)\b/u,
    { kind: 'SOURCE_AUDIO' }],
  [/\blogos?\b|\bwatermark\b/u, { kind: 'ROLE', role: 'LOGO' }],
  [/\bzoom(?:s|ed|ing)?\b|\bpunch[- ]?in\b/u, { kind: 'ROLE', role: 'ZOOM' }],
  [/\b(?:image overlay|photo|graphic|overlay|sticker image|the image)\b/u, { kind: 'ROLE', role: 'IMAGE' }],
  [/\btitle\b(?! case)/u, { kind: 'ROLE', role: 'TITLE' }],
  [/\btext\b|\bwords on screen\b/u, { kind: 'ROLE', role: 'TEXT' }],
  [/\b(?:this|that) (?:part|section|bit|clip|segment|shot|moment)\b|\bhere\b|\bright now\b/u,
    { kind: 'HERE' }],
  [/\b(?:the )?(?:whole |entire )?(?:video|footage|clip|shot|picture|image|frame|everything)\b/u,
    { kind: 'VIDEO' }],
  [/\b(?:it|this|that|them|these|those|one)\b/u, { kind: 'PRONOUN' }]
];

function explicitSubject(text: string, context: ChatContext): Subject {
  // A filename the user typed wins over any noun: "make intro-logo.png smaller".
  for (const element of context.elements) {
    const filename = String(element.properties.filename ?? '').toLowerCase();
    if (filename && filename.length > 3 && text.includes(filename)) {
      return { kind: 'ELEMENT', view: element, words: filename };
    }
  }
  for (const [pattern, subject] of SUBJECTS) {
    const match = pattern.exec(text);
    if (match) return { ...subject, words: match[0] };
  }
  return { kind: 'NONE', words: '' };
}

// --- Operations ---------------------------------------------------------------

type Op =
  | { family: 'SCALE'; dir: number; mag: Magnitude; byPercent?: number; toPercent?: number }
  | { family: 'POSITION'; dx: number; dy: number; mag: Magnitude;
      place?: { x?: 'left' | 'center' | 'right'; y?: 'top' | 'middle' | 'bottom' } }
  | { family: 'VOLUME'; dir: number; mag: Magnitude; toPercent?: number; byPercent?: number }
  | { family: 'MUTE'; muted: boolean }
  | { family: 'FADE'; fadeIn: boolean; fadeOut: boolean; sec: number | null; off: boolean }
  | { family: 'DUCK'; on: boolean; strength: string | null }
  | { family: 'COLOR'; key: ColorKey; dir: number; mag: Magnitude }
  | { family: 'FILTER'; filterId: string; strength: number }
  | { family: 'COLOR_RESET' }
  | { family: 'ZOOM'; mode: 'MORE' | 'LESS' | 'ADD' | 'REMOVE' | 'SET'; mag: Magnitude;
      scale?: number; phrase?: string }
  | { family: 'CROP'; mode: 'TIGHTER' | 'LOOSER' | 'SHIFT' | 'CENTER_FACE' | 'RESET';
      side?: 'left' | 'right' | 'top' | 'bottom'; mag: Magnitude }
  | { family: 'ROTATION'; mode: 'BY' | 'TO'; degrees: number }
  | { family: 'FLIP'; axis: 'H' | 'V' }
  | { family: 'SPEED'; mode: 'FASTER' | 'SLOWER' | 'SET'; value?: number; mag: Magnitude }
  | { family: 'TEXT_SIZE'; dir: number; mag: Magnitude; absolute?: number; byPercent?: number }
  | { family: 'TEXT_STYLE'; action: string; payload: Record<string, unknown>; describe: string }
  | { family: 'OPACITY'; dir: number; value?: number }
  | { family: 'LAYER'; front: boolean }
  | { family: 'VISIBLE'; visible: boolean }
  | { family: 'LOCK'; locked: boolean }
  | { family: 'REMOVE' }
  | { family: 'TIMING'; startSec?: number; durationSec?: number; endSec?: number; longer?: number }
  | { family: 'CONTENT'; content: string }
  | { family: 'HOOK'; mode: HookMode }
  | { family: 'CAPTIONS'; op: 'GENERATE' | 'REMOVE' | 'SHOW' | 'HIDE' | 'STYLE' | 'ACTIVE_WORD' |
      'SPLIT' | 'MERGE' | 'FIX'; styleId?: string; color?: string; enabled?: boolean;
      direction?: 'NEXT' | 'PREVIOUS'; content?: string }
  | { family: 'MORE' | 'LESS' }
  | { family: 'ANOTHER' };

const number = (raw: string | undefined) => raw === undefined ? undefined : Number(raw);
const percentIn = (text: string) => {
  const to = /\bto\s+(\d{1,3}(?:\.\d+)?)\s*%/u.exec(text);
  const by = /\bby\s+(\d{1,3}(?:\.\d+)?)\s*%/u.exec(text) ?? (!to ? /(\d{1,3}(?:\.\d+)?)\s*%/u
    .exec(text) : null);
  return { toPercent: number(to?.[1]), byPercent: number(by?.[1]) };
};
const secondsIn = (text: string, pattern: RegExp) => {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : undefined;
};
const colorWord = (text: string) => {
  const match = new RegExp(`\\b(${Object.keys(COLOR_NAMES).join('|')})\\b`, 'u').exec(text);
  return match ? COLOR_NAMES[match[1]] : undefined;
};
/** Literal wording the user dictated: quoted, or after "say/read/to say". */
const literalContent = (original: string): string | null => {
  const quoted = /["“”'‘’]([^"“”'‘’]{1,200})["“”'‘’]/u.exec(original);
  if (quoted) return quoted[1].trim();
  const said = /\b(?:to say|to read|say|says|saying|read|reads|reading)\s*:?\s+(.{2,200})$/iu
    .exec(original);
  if (said && !/^(?:something|anything|more|less|better|shorter)\b/iu.test(said[1])) {
    return said[1].trim().replace(/[.!]+$/u, '');
  }
  const to = /\b(?:change|set|rename|update|replace|edit)\b.*?\bto\s*:?\s+(.{3,200})$/iu.exec(original);
  if (to && !/^(?:be\b|sound\b|something|make\b|more\b|less\b|a (?:better|stronger|shorter)|feel\b|look\b)/iu
    .test(to[1])) return to[1].trim().replace(/[.!]+$/u, '');
  return null;
};

/**
 * The operation a clause asks for, or null. Order is load-bearing: the most
 * specific vocabulary is tried first, so "lower the music" is VOLUME before it
 * is ever POSITION, and "zoom more" is ZOOM before it is SCALE.
 */
function detectOp(text: string, original: string, subject: Subject,
  context: ChatContext): Op | null {
  const mag = magnitudeOf(text);
  const selected = context.selection.selectedElementHandle
    ? context.elements.find((element) => element.handle === context.selection.selectedElementHandle)
    : null;
  // "lower this" is object-relative. Operation detection runs before target
  // resolution, so carry the selected object's semantic role into this one
  // ambiguous verb; otherwise it falls through to POSITION and music is
  // refused as an object that cannot be moved.
  const selectedMusic = (subject.kind === 'PRONOUN' || subject.kind === 'NONE') &&
    selected?.semantic === 'MUSIC';
  const audioSubject = subject.kind === 'SOURCE_AUDIO' || subject.role === 'MUSIC' || selectedMusic;
  const activeFamily = context.runtime.thread.active?.family ?? '';
  const activeAudio = !subject.role && subject.kind !== 'CAPTIONS' &&
    (activeFamily === 'VOLUME' || activeFamily === 'MUTE' || activeFamily === 'FADE');

  // --- Follow-ups with no operation of their own ---------------------------
  if (/^(?:and |ok(?:ay)?,? |now |please )*(?:try |give me |show me )?(?:another(?: one| option| version)?|a different one|something else|one more|different(?: one)?|next(?: one)?)\b/u
    .test(text)) return { family: 'ANOTHER' };
  const bare = text.replace(/\b(?:please|now|ok(?:ay)?|just|then|and|it|that|this|the|one|again)\b/gu, '')
    .replace(/[^a-z ]/gu, '').replace(/\s+/gu, ' ').trim();
  if (/^(?:(?:a )?(?:little|bit|tad|touch|lot|smidge)(?: bit)? )?(?:more|further|even more|keep going|stronger|deeper|go further|do more|bit more|little more|same again|more please)$/u
    .test(bare) || /^(?:do (?:it|that) )?again$/u.test(bare)) return { family: 'MORE' };
  if (/\b(?:too much|that'?s too much|too far|too strong|overdone|over the top|tone it down|dial it back|back it off|not so much|pull (?:it )?back|go back a (?:little|bit))\b/u
    .test(text) || /^(?:(?:a )?(?:little|bit|tad|touch)(?: bit)? )?(?:less|reduce(?: it)?(?: a (?:little|bit))?|smaller amount|weaker|softer)$/u
    .test(bare)) return { family: 'LESS' };

  // --- Hook (creative) and literal text -------------------------------------
  const literal = literalContent(original);
  const hookish = subject.role === 'HOOK' || (!subject.role && subject.kind !== 'CAPTIONS' &&
    context.runtime.thread.active?.task === 'HOOK_REWRITE');
  if (subject.role === 'HOOK' && /\b(?:add|create|write|make|give me|put)\b.*\b(?:a|an|new)\b.*\b(?:hook|headline|opening)\b/u
    .test(text) && !context.tracks.hook) return { family: 'HOOK', mode: 'NEW' };
  if (hookish && !literal) {
    if (/\bshort(?:er|en)|tighter|fewer words|too long|concise|trim it\b/u.test(text) &&
      !/\b(?:seconds?|on screen|stay|show)\b/u.test(text)) return { family: 'HOOK', mode: 'SHORTER' };
    if (/\bcurio|intrigu|question|mystery|open loop|tease|teaser\b/u.test(text)) {
      return { family: 'HOOK', mode: 'CURIOSITY' };
    }
    if (/\bstronger|better|punch|catch|compelling|more engaging|more interesting|clickbait|hits? harder|improve|bolder claim|clickier\b/u
      .test(text) && !/\b(?:font|bold(?:er)?\b(?! claim)|weight)\b/u.test(text)) {
      return { family: 'HOOK', mode: 'STRONGER' };
    }
    if (subject.role === 'HOOK' && /\b(?:change|rewrite|redo|replace|new|different|another|fix|edit|swap|update|don'?t like|hate)\b/u
      .test(text)) return { family: 'HOOK', mode: 'REWRITE' };
  }
  // Dictated wording belongs to text. "Zoom when I say overnight rate" quotes
  // the SPEAKER, not new on-screen text.
  const textual = !subject.role || ['HOOK', 'CTA', 'TITLE', 'LOWER_THIRD', 'TEXT']
    .includes(subject.role);
  if (literal && textual && !/\bwhen (?:i|he|she|they|we|you|someone)\b/u.test(text) &&
    /\b(?:change|set|make|rename|update|replace|edit|rewrite|should|say|read)\b/u.test(text) &&
    subject.kind !== 'CAPTIONS') {
    return subject.kind === 'CAPTION_ONE' ? { family: 'CAPTIONS', op: 'FIX', content: literal }
      : { family: 'CONTENT', content: literal };
  }

  // --- Captions as a track --------------------------------------------------
  if (subject.kind === 'CAPTIONS' || subject.kind === 'CAPTION_ONE') {
    if (/\bre-?generate|redo (?:the |all )?captions|rebuild\b/u.test(text)) {
      return { family: 'CAPTIONS', op: 'GENERATE' };
    }
    // "turn subtitles on" puts the object between the verb and "on".
    const switchedOn = /\bturn\b(?:.*\b(?:captions?|subtitles?|subs|them)\b)?\s+on\b|\bturn on\b/u.test(text);
    const switchedOff = /\bturn\b(?:.*\b(?:captions?|subtitles?|subs|them)\b)?\s+off\b|\bturn off\b/u.test(text);
    if ((switchedOn || /\b(?:add|generate|create|put|enable|show)\b/u.test(text)) &&
      !context.tracks.captions.count) {
      return { family: 'CAPTIONS', op: 'GENERATE' };
    }
    if (/\b(?:delete|remove|get rid of|clear)\b/u.test(text) && subject.kind === 'CAPTIONS') {
      return { family: 'CAPTIONS', op: 'REMOVE' };
    }
    if ((switchedOff || /\b(?:hide|disable|no captions)\b/u.test(text)) &&
      subject.kind === 'CAPTIONS') return { family: 'CAPTIONS', op: 'HIDE' };
    if ((switchedOn || /\b(?:show|unhide|enable|bring back)\b/u.test(text)) &&
      subject.kind === 'CAPTIONS') return { family: 'CAPTIONS', op: 'SHOW' };
    if (/\bsplit\b/u.test(text)) return { family: 'CAPTIONS', op: 'SPLIT' };
    if (/\b(?:merge|combine|join)\b/u.test(text)) {
      return { family: 'CAPTIONS', op: 'MERGE',
        direction: /\b(?:previous|before|last one|earlier)\b/u.test(text) ? 'PREVIOUS' : 'NEXT' };
    }
    if (/\bfix\b|\btypo\b|\bwrong\b|\bmisspel/u.test(text) && subject.kind === 'CAPTION_ONE') {
      return { family: 'CAPTIONS', op: 'FIX' };
    }
    if (/\bhighlight|karaoke|active word|spoken word|word by word|as (?:i|they|he|she) (?:speak|say)|when (?:it'?s )?spoken\b/u
      .test(text)) {
      const off = /\b(?:no|remove|turn off|stop|without|disable)\b/u.test(text);
      return { family: 'CAPTIONS', op: 'ACTIVE_WORD', enabled: !off,
        color: colorWord(text) === COLOR_NAMES.yellow ? HIGHLIGHT_YELLOW
          : colorWord(text) ?? HIGHLIGHT_YELLOW };
    }
    for (const [pattern, styleId] of CAPTION_STYLE_WORDS) {
      if (pattern.test(text)) return { family: 'CAPTIONS', op: 'STYLE', styleId };
    }
  }

  // --- Audio ------------------------------------------------------------------
  if (audioSubject || activeAudio) {
    if (/\bunmute\b|\bturn (?:it |the \w+ )?back on\b|\bbring (?:it |the \w+ )?back\b/u.test(text)) {
      return { family: 'MUTE', muted: false };
    }
    if (/\b(?:mute|silence|kill|no music|turn off)\b/u.test(text)) return { family: 'MUTE', muted: true };
    if (/\bfade/u.test(text)) {
      const off = /\b(?:no|remove|without|stop)\b.*\bfade/u.test(text);
      // "fade the music out" puts the object between the verb and its particle,
      // so the particle is looked for anywhere after "fade".
      const after = text.slice(text.search(/\bfade/u));
      const both = /\bin[_ ]and[_ ]out\b/u.test(after);
      const fadeIn = both || /\bin\b/u.test(after) || /\bat the (?:start|beginning)\b/u.test(after);
      const fadeOut = both || /\bout\b/u.test(after) || /\bat the end\b/u.test(after);
      return { family: 'FADE', fadeIn: fadeIn || (!fadeIn && !fadeOut), fadeOut, off,
        sec: secondsIn(text, /(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/u) ?? null };
    }
    if (/\bduck|when (?:i|someone|they|he|she|people) (?:speak|talk)|under (?:the )?(?:speech|voice|talking|dialogue)|while (?:i'?m|someone is|they'?re) (?:speaking|talking)|over (?:the |my )?voice\b/u
      .test(text) && subject.kind !== 'SOURCE_AUDIO') {
      const off = /\b(?:stop|don'?t|no|turn off|disable)\b/u.test(text);
      return { family: 'DUCK', on: !off,
        strength: /\ba lot|much|strong|way\b/u.test(text) ? 'STRONG'
          : /\ba little|slightly|subtle|gently\b/u.test(text) ? 'SUBTLE' : null };
    }
    const { toPercent, byPercent } = percentIn(text);
    if (/\btoo (?:loud|much|strong|overpowering)|quieter|softer|lower|turn (?:it |the \w+ )?down|reduce|decrease|down a bit|drown|overpower|can'?t hear/u
      .test(text)) return { family: 'VOLUME', dir: -1, mag, toPercent, byPercent };
    if (/\btoo (?:quiet|soft|low)|louder|raise|turn (?:it |the \w+ )?up|increase|boost|pump|can'?t hear the (?:music|song)/u
      .test(text)) return { family: 'VOLUME', dir: 1, mag, toPercent, byPercent };
    if (toPercent !== undefined && /\bvolume|level\b/u.test(text)) {
      return { family: 'VOLUME', dir: 1, mag, toPercent };
    }
  }

  // --- Zoom -------------------------------------------------------------------
  const zoomSubject = subject.role === 'ZOOM' || /\bzoom|punch[- ]?in\b/u.test(text);
  if (zoomSubject && !/\b(?:auto(?:matic)?[- ]zoom|zoom policy|all (?:the )?zooms|any zooms?|no zooms)\b/u
    .test(text)) {
    const when = /\bwhen (?:i|he|she|they|we|you) (?:say|says|mention|mentions|talk about)s?\s+["“']?([^"”']{2,60})["”']?/u
      .exec(text);
    if (when) return { family: 'ZOOM', mode: 'ADD', mag, phrase: when[1].trim() };
    if (/\b(?:remove|delete|get rid of|no|drop|cancel|kill)\b/u.test(text)) {
      return { family: 'ZOOM', mode: 'REMOVE', mag };
    }
    if (/\bsubtle|gentle|slight zoom|just a touch\b/u.test(text) && !/\bmore\b/u.test(text)) {
      return { family: 'ZOOM', mode: 'SET', mag, scale: 1.06 };
    }
    if (/\bless|weaker|softer|zoom out|too (?:much|strong|deep|close|far)|smaller|reduce|not so\b/u
      .test(text)) return { family: 'ZOOM', mode: 'LESS', mag };
    if (/\bmore|deeper|stronger|further|closer|tighter|bigger|harder|punchier\b/u.test(text)) {
      return { family: 'ZOOM', mode: 'MORE', mag };
    }
    if (/\bzoom(?: in)?(?: on)? (?:here|this|now|there|right here)|zoom in\b|\bpunch in\b|\badd (?:a )?zoom\b/u
      .test(text)) return { family: 'ZOOM', mode: 'ADD', mag };
  }

  // --- Crop / frame -------------------------------------------------------------
  if (/\bcrop|\bshow more\b|\bcentered|centre the|center the (?:person|speaker|face|subject)|\bframing|in frame\b/u
    .test(text) && subject.role !== 'ZOOM') {
    if (/\b(?:remove|reset|undo|no|clear)\b.*\bcrop|\buncrop\b|\bfull frame\b/u.test(text)) {
      return { family: 'CROP', mode: 'RESET', mag };
    }
    if (/\b(?:keep|put|center|centre|centred|centered)\b.*\b(?:person|speaker|face|subject|me|him|her|them)\b|\b(?:person|speaker|face)\b.*\bcent(?:er|re)d?\b/u
      .test(text)) return { family: 'CROP', mode: 'CENTER_FACE', mag };
    const side = /\b(left|right|top|bottom)\b/u.exec(text)?.[1] as
      'left' | 'right' | 'top' | 'bottom' | undefined;
    if (/\bmove (?:the )?crop\b|\bshift (?:the )?crop\b|\bpan\b/u.test(text) && side) {
      return { family: 'CROP', mode: 'SHIFT', side, mag };
    }
    if (/\bshow more|wider|loosen|less crop|crop less|looser|zoom out\b/u.test(text)) {
      return { family: 'CROP', mode: 'LOOSER', side, mag };
    }
    if (/\btighter|closer|crop (?:in|more|it)|more crop|tighten\b|\bcrop\b/u.test(text)) {
      return { family: 'CROP', mode: 'TIGHTER', side, mag };
    }
  }

  // --- Rotation / flip ----------------------------------------------------------
  if (/\bstraighten|level (?:it|the|out)|make it straight|un-?rotate|reset (?:the )?rotation\b/u.test(text)) {
    return { family: 'ROTATION', mode: 'TO', degrees: 0 };
  }
  if (/\bupside down\b/u.test(text) && !/\bflip\b/u.test(text)) {
    return { family: 'ROTATION', mode: 'TO', degrees: 180 };
  }
  if (/\b(?:flip|mirror)\b/u.test(text)) {
    return { family: 'FLIP', axis: /\bvertical|upside|top to bottom\b/u.test(text) ? 'V' : 'H' };
  }
  if (/\brotat|\btilt\b|\bturn (?:it |this |the \w+ )?(?:slightly |a (?:little|bit) )?(?:counter[- ]?|anti[- ]?)?clockwise\b|\bspin\b/u
    .test(text)) {
    const explicit = /(-?\d+(?:\.\d+)?)\s*(?:°|degrees?\b|deg\b)/u.exec(text);
    const counter = /\b(?:counter[- ]?clockwise|anti[- ]?clockwise|left|ccw|back)\b/u.test(text);
    const to = /\bto\s+-?\d/u.test(text);
    const degrees = explicit ? Math.abs(Number(explicit[1]))
      : mag === 'small' ? 2 : /\b(?:left|right)\b/u.test(text) && !/clockwise/u.test(text) ? 90 : 5;
    return { family: 'ROTATION', mode: to ? 'TO' : 'BY',
      degrees: to ? Number(explicit?.[1] ?? 0) : counter ? -degrees : degrees };
  }

  // --- Speed ----------------------------------------------------------------------
  const factor = /\b(\d+(?:\.\d+)?)\s*x\b(?!\s*\d)|\bx\s?(\d+(?:\.\d+)?)\b/u.exec(text);
  if (/\bnormal speed|real[- ]?time|regular speed|original speed|1x\b/u.test(text)) {
    return { family: 'SPEED', mode: 'SET', value: 1, mag };
  }
  if (/\bhalf speed|half as fast\b/u.test(text)) return { family: 'SPEED', mode: 'SET', value: 0.5, mag };
  if (/\bdouble (?:the )?speed|twice as fast\b/u.test(text)) {
    return { family: 'SPEED', mode: 'SET', value: 2, mag };
  }
  if (factor && /\bspeed|faster|slower|play|x\b/u.test(text)) {
    return { family: 'SPEED', mode: 'SET', value: Number(factor[1] ?? factor[2]), mag };
  }
  if (/\bfaster|speed (?:it |this |the \w+ )?up|quicker|pick up the pace\b/u.test(text) &&
    subject.kind !== 'CAPTIONS') return { family: 'SPEED', mode: 'FASTER', mag };
  if (/\bslower|slow (?:it |this |the \w+ )?down|slow[- ]?mo(?:tion)?\b/u.test(text)) {
    return { family: 'SPEED', mode: 'SLOWER', mag };
  }

  // --- Colour ---------------------------------------------------------------------
  const colorTarget = subject.kind !== 'CAPTIONS' && subject.kind !== 'CAPTION_ONE' &&
    !['HOOK', 'CTA', 'TITLE', 'LOWER_THIRD', 'TEXT', 'LOGO', 'IMAGE', 'MUSIC'].includes(
      String(subject.role ?? ''));
  if (colorTarget) {
    if (/\b(?:reset|remove|clear|undo|no|original|natural)\b.*\b(?:colou?rs?|grade|grading|filters?|look)\b|\bno filter\b/u
      .test(text)) return { family: 'COLOR_RESET' };
    for (const [pattern, filterId] of FILTER_WORDS) {
      if (pattern.test(text)) {
        return { family: 'FILTER', filterId, strength: mag === 'small' ? 0.5 : 1 };
      }
    }
    const color = (key: ColorKey, dir: number): Op => ({ family: 'COLOR', key, dir, mag });
    if (/\bwarm(?:er)?\b|\bgolden\b/u.test(text)) return color('temperature', 1);
    if (/\bcool(?:er)?\b|\bcold(?:er)?\b|\bbluer\b/u.test(text)) return color('temperature', -1);
    if (/\b(?:less|lower|reduce|decrease|softer|flatter)\b.*\bcontrast|\bcontrast\b.*\b(?:down|less|lower)\b|\bflatter\b/u
      .test(text)) return color('contrast', -1);
    if (/\bcontrast|contrasty|punchier\b/u.test(text)) return color('contrast', 1);
    if (/\b(?:less|lower|reduce|decrease)\b.*\bsaturat|\bdesaturat|\bmuted colou?rs?\b|\bwashed out\b|\bless colou?rful\b/u
      .test(text)) return color('saturation', -1);
    if (/\bsaturat|\bmore colou?rful|\bcolou?rful|\bpop\b|\bmore vivid/u.test(text)) {
      return color('saturation', 1);
    }
    if (/\b(?:lift|brighten|raise|open up)\b.*\bshadows?\b|\bshadows?\b.*\b(?:brighter|lighter|up)\b/u
      .test(text)) return color('shadows', 1);
    if (/\b(?:deeper|crush|darker|lower)\b.*\bshadows?\b|\bshadows?\b.*\b(?:darker|down|deeper)\b/u
      .test(text)) return color('shadows', -1);
    if (/\b(?:bring down|recover|lower|reduce|tame)\b.*\bhighlights?\b|\bhighlights?\b.*\b(?:down|less|darker)\b|\bblown out\b/u
      .test(text)) return color('highlights', -1);
    if (/\bhighlights?\b.*\b(?:up|brighter|more)\b/u.test(text)) return color('highlights', 1);
    if (/\bbrightness\b/u.test(text)) {
      return color('brightness', /\b(?:less|lower|reduce|down|decrease)\b/u.test(text) ? -1 : 1);
    }
    if (/\bexposure\b/u.test(text)) {
      return color('exposure', /\b(?:less|lower|reduce|down|decrease)\b/u.test(text) ? -1 : 1);
    }
    // "brighter"/"darker" move EXPOSURE (a gamma change): it lifts the image
    // the way a person means "brighter" while keeping blacks black and whites
    // white. Brightness (an additive lift) is used only when named.
    if (/\bbrighter|lighter|too dark|brighten|more light\b/u.test(text)) return color('exposure', 1);
    if (/\bdarker|too bright|darken|dimmer|moodier\b/u.test(text)) return color('exposure', -1);
    if (/\bsharper|sharpen|crisper|more detail\b/u.test(text)) return color('sharpness', 1);
    if (/\bless sharp|softer image|unsharpen\b/u.test(text)) return color('sharpness', -1);
    if (/\bvignette\b/u.test(text)) {
      return color('vignette', /\b(?:less|remove|no|reduce)\b/u.test(text) ? -1 : 1);
    }
    if (/\bfaded|film fade|matte\b/u.test(text)) return color('fade', 1);
    if (/\b(?:more )?(?:magenta|pinker)\b/u.test(text)) return color('tint', 1);
    if (/\b(?:more )?green(?:er)?\b|\bless magenta\b/u.test(text) && !subject.role) {
      return color('tint', -1);
    }
  }

  // --- Text style -------------------------------------------------------------------
  for (const [pattern, textStyleId] of TEXT_STYLE_WORDS) {
    if (pattern.test(text)) {
      return { family: 'TEXT_STYLE', action: 'SET_TEXT_STYLE_PRESET', describe: 'style',
        payload: { textStyleId } };
    }
  }
  if (/\b(?:all caps|uppercase|capitals|capital letters|caps)\b/u.test(text)) {
    const off = /\b(?:no|not|remove|without|normal case|lower ?case)\b/u.test(text);
    return { family: 'TEXT_STYLE', action: 'SET_TEXT_CASE', describe: 'case',
      payload: { uppercase: !off } };
  }
  if (/\b(?:align|aligned|alignment)\b|\b(?:left|right)[- ]aligned\b|\bcenter the text\b|\bcentre the text\b/u
    .test(text)) {
    const textAlign = /\bleft\b/u.test(text) ? 'left' : /\bright\b/u.test(text) ? 'right' : 'center';
    return { family: 'TEXT_STYLE', action: 'SET_TEXT_ALIGNMENT', describe: 'alignment',
      payload: { textAlign } };
  }
  if (/\b(?:outline|stroke|border)\b/u.test(text)) {
    return { family: 'TEXT_STYLE', action: 'SET_TEXT_STROKE', describe: 'outline',
      payload: { strokeEnabled: !/\b(?:no|remove|without|turn off|get rid)\b/u.test(text),
        ...(colorWord(text) ? { strokeColor: colorWord(text) } : {}) } };
  }
  if (/\bshadow\b/u.test(text)) {
    return { family: 'TEXT_STYLE', action: 'SET_TEXT_SHADOW', describe: 'shadow',
      payload: { shadowEnabled: !/\b(?:no|remove|without|turn off|get rid)\b/u.test(text) } };
  }
  if (/\b(?:background|box|plate|pill|backing|banner)\b/u.test(text) &&
    !/\bmusic|audio\b/u.test(text)) {
    return { family: 'TEXT_STYLE', action: 'SET_TEXT_BACKGROUND', describe: 'background',
      payload: { backgroundEnabled: !/\b(?:no|remove|without|turn off|get rid|transparent)\b/u.test(text),
        ...(colorWord(text) ? { backgroundColor: colorWord(text) } : {}) } };
  }
  if (/\b(?:letter[- ]?spacing|spacing|spread (?:it|the letters) out|tighter letters)\b/u.test(text)) {
    return { family: 'TEXT_STYLE', action: 'SET_TEXT_SPACING', describe: 'spacing',
      payload: { letterSpacingDir: /\b(?:less|tighter|reduce|closer)\b/u.test(text) ? -1 : 1 } };
  }
  for (const [pattern, fontFamily] of FONT_WORDS) {
    if (/\bfont|typeface\b/u.test(text) && pattern.test(text)) {
      return { family: 'TEXT_STYLE', action: 'SET_TEXT_FONT', describe: 'font',
        payload: { fontFamily } };
    }
  }
  if (/\bbold(?:er)?\b|\bheavier\b|\bthicker\b/u.test(text) && !/\bnot bold|unbold\b/u.test(text)) {
    return { family: 'TEXT_STYLE', action: 'SET_TEXT_WEIGHT', describe: 'weight',
      payload: { fontWeightDir: 1, bold: /\bbold\b/u.test(text) } };
  }
  if (/\bnot bold|unbold|thinner|lighter weight|less bold|regular weight\b/u.test(text)) {
    return { family: 'TEXT_STYLE', action: 'SET_TEXT_WEIGHT', describe: 'weight',
      payload: { fontWeightDir: -1 } };
  }
  const named = colorWord(text);
  if (named && /\b(?:make|turn|colou?r|change|set|paint|use)\b/u.test(text) &&
    !/\bhighlight/u.test(text)) {
    return { family: 'TEXT_STYLE', action: 'SET_TEXT_COLOR', describe: 'colour',
      payload: { color: named } };
  }

  // --- Visibility, removal, lock, layer, opacity --------------------------------------
  if (/\bunlock\b/u.test(text)) return { family: 'LOCK', locked: false };
  if (/\block\b/u.test(text)) return { family: 'LOCK', locked: true };
  if (/\b(?:hide|make (?:it )?invisible|turn off)\b/u.test(text)) return { family: 'VISIBLE', visible: false };
  if (/\b(?:unhide|show (?:it|the \w+) again|make (?:it )?visible|bring (?:it|the \w+) back)\b/u.test(text)) {
    return { family: 'VISIBLE', visible: true };
  }
  if (/\b(?:bring|send|move|put)\b.*\b(?:front|forward|back|behind|top layer|on top|underneath|below everything)\b/u
    .test(text)) return { family: 'LAYER', front: /\b(?:front|forward|top|on top)\b/u.test(text) };
  if (/\b(?:transparent|opacity|opaque|see[- ]?through|fainter|more solid|less visible|ghost)/u.test(text)) {
    const explicit = /(\d{1,3})\s*%/u.exec(text);
    return { family: 'OPACITY',
      dir: /\b(?:more solid|opaque|less transparent|more visible)\b/u.test(text) ? 1 : -1,
      ...(explicit ? { value: Number(explicit[1]) / 100 } : {}) };
  }

  // --- Timing -------------------------------------------------------------------------
  const span = /\bfrom\s+(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)?\s*(?:to|until|-|–)\s*(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)?\b/u
    .exec(text);
  if (span && !/\b(?:cut|trim|remove|delete|drop)\b/u.test(text)) {
    return { family: 'TIMING', startSec: Number(span[1]), endSec: Number(span[2]) };
  }
  const forSec = secondsIn(text, /\bfor\s+(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\b/u);
  const atSec = secondsIn(text, /\b(?:start(?:s|ing)?|begin(?:s|ning)?|come in|appear)\b.*?\b(?:at|from)\s+(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)?\b/u);
  const endSec = secondsIn(text, /\b(?:end(?:s|ing)?|stop(?:s|ping)?|until|disappear)\b.*?\b(?:at|by)?\s*(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\b/u);
  if ((forSec !== undefined && /\b(?:show|keep|display|stay|on screen|play)\b/u.test(text)) ||
    atSec !== undefined || endSec !== undefined) {
    return { family: 'TIMING', startSec: atSec, durationSec: forSec, endSec };
  }
  if (/\b(?:longer|shorter)\b.*\b(?:on screen|stay|show|appear|visible)\b|\b(?:stay|show|appear)\b.*\b(?:longer|shorter)\b/u
    .test(text)) return { family: 'TIMING', longer: /\blonger\b/u.test(text) ? 1 : -1 };

  if (/\b(?:delete|remove|get rid of|take (?:it |the \w+ )?(?:off|out)|erase|drop)\b/u.test(text) &&
    subject.kind !== 'HERE' && subject.kind !== 'VIDEO' &&
    !/\b(?:part|section|bit|segment|seconds?|where|about|when|first|last|beginning|end)\b/u.test(text)) {
    return { family: 'REMOVE' };
  }

  // --- Size and position ----------------------------------------------------------------
  const { toPercent, byPercent } = percentIn(text);
  if (/\bbigger|larger|grow|enlarge|scale (?:it )?up|increase (?:the )?size|huge|more visible|too small\b/u
    .test(text)) return { family: 'SCALE', dir: 1, mag, byPercent, toPercent };
  if (/\bsmaller|shrink|tinier|scale (?:it )?down|decrease (?:the )?size|reduce (?:the )?size|too big|less (?:big|huge)|tiny\b/u
    .test(text)) return { family: 'SCALE', dir: -1, mag, byPercent, toPercent };

  const corner = /\b(top|bottom|upper|lower)[\s-]*(left|right)\b|\b(?:to the |in the )?(top|bottom|center|centre|middle)\b|\b(?:to the |on the )(left|right)(?: side)?\b/u
    .exec(text);
  const moves = /\b(?:move|nudge|shift|push|put|place|drag|position|lower|raise|higher|up|down|left|right)\b/u.test(text);
  if (moves && !/\bvolume|loud|quiet\b/u.test(text)) {
    const absolute = /\b(?:to|in|at|into) the (?:top|bottom|center|centre|middle|left|right|corner|upper|lower)|\b(?:top|bottom|upper|lower)[\s-]*(?:left|right)\b|\bcent(?:er|re) (?:it|the)\b/u
      .test(text);
    if (absolute && corner) {
      const vertical = (corner[1] ?? corner[3] ?? '').replace('upper', 'top').replace('lower', 'bottom')
        .replace('centre', 'center');
      const horizontal = corner[2] ?? corner[4];
      return { family: 'POSITION', dx: 0, dy: 0, mag,
        place: { ...(vertical === 'top' || vertical === 'bottom' ? { y: vertical as 'top' | 'bottom' }
          : vertical === 'center' || vertical === 'middle' ? { y: 'middle' as const, x: 'center' as const } : {}),
        ...(horizontal ? { x: horizontal as 'left' | 'right' } : {}) } };
    }
    let dx = 0; let dy = 0;
    if (/\b(?:down|lower|downward|below)\b/u.test(text)) dy = 1;
    if (/\b(?:up|higher|upward|raise|above)\b/u.test(text)) dy = -1;
    if (/\bright\b/u.test(text)) dx = 1;
    if (/\bleft\b/u.test(text)) dx = -1;
    if (dx || dy) return { family: 'POSITION', dx, dy, mag };
  }
  return null;
}

// --- Target resolution ----------------------------------------------------------

/** Which semantic roles each operation family can act on. */
const TEXTLIKE: SemanticRole[] = ['HOOK', 'CTA', 'TITLE', 'LOWER_THIRD', 'TEXT', 'CAPTION'];
const FAMILY_ROLES: Record<string, SemanticRole[]> = {
  SCALE: ['LOGO', 'IMAGE', ...TEXTLIKE, 'SOURCE_VIDEO', 'ZOOM'],
  TEXT_SIZE: TEXTLIKE,
  POSITION: ['LOGO', 'IMAGE', ...TEXTLIKE, 'SOURCE_VIDEO'],
  VOLUME: ['MUSIC'], MUTE: ['MUSIC'], FADE: ['MUSIC'], DUCK: ['MUSIC'],
  COLOR: ['SOURCE_VIDEO'], FILTER: ['SOURCE_VIDEO'], COLOR_RESET: ['SOURCE_VIDEO'],
  ZOOM: ['ZOOM'],
  CROP: ['SOURCE_VIDEO', 'LOGO', 'IMAGE'], FLIP: ['SOURCE_VIDEO', 'LOGO', 'IMAGE'],
  ROTATION: ['SOURCE_VIDEO', 'LOGO', 'IMAGE', ...TEXTLIKE],
  SPEED: ['SOURCE_VIDEO'],
  TEXT_STYLE: TEXTLIKE, CONTENT: ['HOOK', 'CTA', 'TITLE', 'LOWER_THIRD', 'TEXT'],
  OPACITY: ['LOGO', 'IMAGE', ...TEXTLIKE], LAYER: ['LOGO', 'IMAGE', ...TEXTLIKE],
  VISIBLE: ['LOGO', 'IMAGE', ...TEXTLIKE], LOCK: ['LOGO', 'IMAGE', ...TEXTLIKE, 'MUSIC', 'SOURCE_VIDEO'],
  REMOVE: ['LOGO', 'IMAGE', 'HOOK', 'CTA', 'TITLE', 'LOWER_THIRD', 'TEXT', 'MUSIC', 'ZOOM'],
  TIMING: ['LOGO', 'IMAGE', 'HOOK', 'CTA', 'TITLE', 'LOWER_THIRD', 'TEXT', 'MUSIC', 'ZOOM'],
  HOOK: ['HOOK']
};

type Resolution = { views: ChatElementView[]; aggregate?: 'CAPTIONS' | 'VIDEO_ALL' | 'SOURCE_AUDIO';
  how: string } | { question: string; code: ChatOutcomeCode | null };

const NOUN: Partial<Record<SemanticRole, string>> = {
  HOOK: 'hook', CTA: 'call to action', TITLE: 'title', LOWER_THIRD: 'lower third', TEXT: 'text',
  CAPTION: 'caption', LOGO: 'logo', IMAGE: 'image', MUSIC: 'music', SOURCE_VIDEO: 'video segment',
  ZOOM: 'zoom'
};

const videos = (context: ChatContext) =>
  context.elements.filter((element) => element.semantic === 'SOURCE_VIDEO');
const atPlayhead = (context: ChatContext, views: ChatElementView[], slack = 0) => {
  const at = context.selection.playheadSec;
  return views.filter((view) => at >= view.startSec - slack - 1e-6 && at < view.endSec + slack);
};
const zoomNearPlayhead = (context: ChatContext) => atPlayhead(context,
  context.elements.filter((element) => element.semantic === 'ZOOM'), 0.75);

/** The selected element, but only when the user selected it since the active
 *  target was set - the editor always has SOMETHING selected. */
function freshSelection(context: ChatContext): ChatElementView | undefined {
  const selectedId = context.runtime.selectedElementId;
  if (!selectedId) return undefined;
  const active = context.runtime.thread.active;
  if (active && active.selectionId === selectedId) return undefined;
  return context.elements.find((element) => element.id === selectedId);
}

function activeViews(context: ChatContext): ChatElementView[] {
  const ids = context.runtime.thread.active?.elementIds ?? [];
  return ids.map((id) => context.elements.find((element) => element.id === id))
    .filter((view): view is ChatElementView => !!view);
}

function chooseAmong(matches: ChatElementView[], role: SemanticRole, context: ChatContext):
  Resolution {
  if (matches.length === 1) return { views: matches, how: 'ROLE' };
  const selected = matches.find((view) => view.selected);
  if (selected) return { views: [selected], how: 'SELECTED' };
  const active = activeViews(context).filter((view) => matches.includes(view));
  if (active.length) return { views: active, how: 'ACTIVE' };
  const local = atPlayhead(context, matches);
  if (local.length === 1) return { views: local, how: 'PLAYHEAD' };
  const noun = NOUN[role] ?? 'element';
  return { code: 'NEEDS_TARGET', question: `There are ${matches.length} ${noun}s (${matches
    .slice(0, 4).map((view) => view.label).join(', ')}). Which ${noun} do you mean? Select it ` +
    'on the timeline, or say which one.' };
}

/**
 * Resolves the subject of one clause to the object(s) it means.
 *
 * Priority, per Part 6: an explicit noun names its object outright. Otherwise:
 * a FRESH selection, then the conversational active target, then the subject
 * of the previous clause in the same message, then the object under the
 * playhead or inside the selected range, then the only object the operation
 * could possibly mean. Anything else is one precise question.
 */
function resolveTargets(subject: Subject, family: string, context: ChatContext,
  carry: Subject | null, text: string): Resolution {
  const roles = FAMILY_ROLES[family] ?? [];
  const fits = (view: ChatElementView) => roles.includes(view.semantic);
  const byRole = (role: SemanticRole) => context.elements.filter((view) => view.semantic === role);

  if (subject.kind === 'ELEMENT' && subject.view) {
    return fits(subject.view) ? { views: [subject.view], how: 'NAMED' }
      : { code: null, question: `I can't do that to ${subject.view.label.toLowerCase()}.` };
  }
  if (subject.kind === 'SOURCE_AUDIO') return { views: [], aggregate: 'SOURCE_AUDIO', how: 'ROLE' };
  if (subject.kind === 'CAPTIONS') {
    if (!context.tracks.captions.count) {
      return { code: null, question: 'There are no captions yet. Say "add captions" and I will ' +
        'build them from the transcript.' };
    }
    return { views: [], aggregate: 'CAPTIONS', how: 'ROLE' };
  }
  if (subject.kind === 'CAPTION_ONE') {
    const selected = freshSelection(context) ?? context.elements.find((view) => view.selected);
    if (selected?.semantic === 'CAPTION') return { views: [selected], how: 'SELECTED' };
    const local = atPlayhead(context, byRole('CAPTION'));
    if (local.length) return { views: [local[0]], how: 'PLAYHEAD' };
    return { code: 'NEEDS_TARGET', question: 'Which caption? Select it on the timeline or move ' +
      'the playhead onto it.' };
  }
  if (subject.kind === 'ROLE' && subject.role) {
    let matches = byRole(subject.role);
    // "the text" also means a hook/title when there is no plain text at all.
    if (subject.role === 'TEXT' && !matches.length) {
      matches = context.elements.filter((view) => ['HOOK', 'CTA', 'TITLE', 'LOWER_THIRD']
        .includes(view.semantic));
    }
    if (subject.role === 'ZOOM') {
      const near = zoomNearPlayhead(context);
      if (near.length === 1 && matches.length > 1) return { views: near, how: 'PLAYHEAD' };
    }
    if (!matches.length) {
      return { code: null, question: subject.role === 'HOOK'
        ? 'This video does not have an on-screen hook yet. Say "add a hook" and I will write one ' +
          'from the opening of the video.'
        : subject.role === 'ZOOM' ? 'There are no zooms yet. Put the playhead where you want one ' +
          'and say "zoom in here".'
          : `There is no ${NOUN[subject.role] ?? 'element'} on the timeline yet.` };
    }
    if (!roles.includes(subject.role) && !(subject.role === 'TEXT' && matches.every(fits))) {
      return { code: null, question: `I can't do that to the ${NOUN[subject.role] ?? 'element'}.` };
    }
    return chooseAmong(matches, subject.role, context);
  }
  if (subject.kind === 'VIDEO' || (subject.kind === 'HERE' && roles.includes('SOURCE_VIDEO'))) {
    if (!roles.includes('SOURCE_VIDEO')) {
      return { code: null, question: 'That change does not apply to the video itself.' };
    }
    const selected = freshSelection(context);
    if (subject.kind === 'HERE') {
      if (selected?.semantic === 'SOURCE_VIDEO') return { views: [selected], how: 'SELECTED' };
      const local = atPlayhead(context, videos(context));
      return local.length ? { views: [local[0]], how: 'PLAYHEAD' }
        : { code: null, question: 'The playhead is past the end of the video.' };
    }
    if (videos(context).length === 1) return { views: videos(context), how: 'ONLY' };
    return { views: [], aggregate: 'VIDEO_ALL', how: 'ROLE' };
  }

  // No noun: pronoun, "here" for a non-video family, or nothing at all.
  // Inside one message a pronoun means the noun of the clause before it.
  if (carry && carry.kind !== 'NONE' && carry.kind !== 'PRONOUN') {
    const carried = resolveTargets(carry, family, context, null, text);
    if ('views' in carried) return { ...carried, how: 'CARRIED' };
  }
  const colour = ['COLOR', 'FILTER', 'COLOR_RESET'].includes(family);
  const fresh = colour && subject.kind !== 'HERE' ? undefined : freshSelection(context);
  if (fresh && fits(fresh)) return { views: [fresh], how: 'SELECTED' };
  // "it" right after the user selected something NEW means that thing. If the
  // change does not apply to it, silently acting on the previous target would
  // edit an object the user is no longer pointing at - so ask.
  if (fresh && subject.kind === 'PRONOUN' && !colour) {
    return { code: 'NEEDS_TARGET', question: `I can't do that to ${
      fresh.label.toLowerCase()}, which is what you have selected. Which element did you mean?` };
  }
  const active = activeViews(context).filter(fits);
  if (active.length) return wholeVideo(active, context) ?? { views: active, how: 'ACTIVE' };
  if (family === 'ZOOM') {
    const near = zoomNearPlayhead(context);
    if (near.length) return { views: [near[0]], how: 'PLAYHEAD' };
    const zooms = byRole('ZOOM');
    if (zooms.length === 1) return { views: zooms, how: 'ONLY' };
    return { views: [], how: 'NONE' };
  }
  if (colour) {
    if (subject.kind === 'HERE') {
      const local = atPlayhead(context, videos(context));
      if (local.length) return { views: [local[0]], how: 'PLAYHEAD' };
    }
    return videos(context).length === 1 ? { views: videos(context), how: 'ONLY' }
      : { views: [], aggregate: 'VIDEO_ALL', how: 'DEFAULT' };
  }
  if (['SPEED', 'CROP', 'ROTATION', 'FLIP'].includes(family) && subject.kind !== 'PRONOUN' ||
    (subject.kind === 'HERE' && roles.includes('SOURCE_VIDEO'))) {
    if (videos(context).length === 1) return { views: videos(context), how: 'ONLY' };
    const local = atPlayhead(context, videos(context));
    if (local.length) return { views: [local[0]], how: 'PLAYHEAD' };
  }
  const selected = context.elements.find((view) => view.selected);
  if (selected && fits(selected)) return { views: [selected], how: 'SELECTED' };
  const candidates = context.elements.filter(fits).filter((view) => !view.virtual ||
    family === 'ZOOM');
  const distinctRoles = new Set(candidates.map((view) => view.semantic));
  if (candidates.length === 1 || (distinctRoles.size === 1 && roles.length === 1)) {
    const role = candidates[0]?.semantic;
    return candidates.length === 1 ? { views: candidates, how: 'ONLY' }
      : chooseAmong(candidates, role, context);
  }
  const local = atPlayhead(context, candidates.filter((view) => view.semantic !== 'SOURCE_VIDEO' &&
    view.semantic !== 'CAPTION'));
  if (local.length === 1) return { views: local, how: 'PLAYHEAD' };
  return { code: 'NEEDS_TARGET', question: `Which ${family === 'VOLUME' || family === 'MUTE'
    ? 'audio' : 'element'} do you mean? Select it, or name it - for example ${
    roles.includes('LOGO') ? '"the logo", ' : ''}${roles.includes('HOOK') ? '"the hook", ' : ''}${
    roles.includes('MUSIC') ? '"the music", ' : ''}"the captions".` };
}

// --- Value maths ------------------------------------------------------------------

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const r4 = (value: number) => Number(value.toFixed(4));
const r2 = (value: number) => Number(value.toFixed(2));

const SCALE_FACTORS: Record<Magnitude, number> = { small: 1.1, normal: 1.25, large: 1.6 };
const MOVE_STEPS: Record<Magnitude, number> = { small: 0.03, normal: 0.08, large: 0.15 };
const VOLUME_FACTORS: Record<Magnitude, number> = { small: 0.85, normal: 0.7, large: 0.5 };
const COLOR_STEPS: Record<Magnitude, number> = { small: 0.08, normal: 0.15, large: 0.3 };
const CROP_STEPS: Record<Magnitude, number> = { small: 0.03, normal: 0.06, large: 0.12 };
const ZOOM_STEPS: Record<Magnitude, number> = { small: 0.02, normal: ZOOM_SCALE_STEP, large: 0.05 };
const MARGIN = 0.04;

const scaleFactor = (op: { dir: number; mag: Magnitude; byPercent?: number }) =>
  op.byPercent !== undefined ? 1 + op.dir * op.byPercent / 100
    : op.dir > 0 ? SCALE_FACTORS[op.mag] : 1 / SCALE_FACTORS[op.mag];

const target = (view: ChatElementView): ChatTarget => ({ kind: 'ELEMENT', handle: view.handle });
const element = (action: string, view: ChatElementView | string, parameters: Record<string, unknown>,
  reason: string): ChatCommand => ({ kind: 'ELEMENT', action: action as never,
  target: typeof view === 'string' ? { kind: 'ELEMENT', handle: view } : target(view),
  parameters, reason });

type Built = { commands: ChatCommand[]; summary: string; warnings?: string[];
  followUp: FollowUp | null } | { question: string; code?: ChatOutcomeCode | null };

const done = (commands: ChatCommand[], summary: string, followUp: FollowUp | null,
  warnings: string[] = []): Built => ({ commands, summary, followUp, warnings });
const follow = (family: string, direction: number, views: ChatElementView[] | string[], task: string,
  vector: { dx: number; dy: number } | null = null): FollowUp => ({
  family, direction, vector, task,
  elementIds: (views as Array<ChatElementView | string>).map((view) =>
    typeof view === 'string' ? view : view.id).filter((id) => !id.startsWith('moment:')) });
const nameOf = (view: ChatElementView) => view.semantic === 'SOURCE_VIDEO'
  ? 'the video' : `the ${NOUN[view.semantic] ?? 'element'}`;

/** The video segments an aggregate or a view list means. */
const segmentsFor = (resolution: Extract<Resolution, { views: unknown }>, context: ChatContext) =>
  resolution.aggregate === 'VIDEO_ALL' ? videos(context) : resolution.views;

/**
 * One command per segment - or, when the whole video is meant and every
 * segment gets the SAME value, one command on "video:all" that the resolver
 * fans out. Same edit either way; the proposal then reads as one change to
 * the video instead of the same line repeated per segment.
 */
function perSegment(resolution: Extract<Resolution, { views: unknown }>, segments: ChatElementView[],
  action: string, payloadFor: (view: ChatElementView) => Record<string, unknown> | null,
  reason: string): ChatCommand[] {
  const payloads = segments.map((view) => ({ view, payload: payloadFor(view) }))
    .filter((entry): entry is { view: ChatElementView; payload: Record<string, unknown> } =>
      !!entry.payload);
  const uniform = payloads.length === segments.length && payloads.length > 1 &&
    payloads.every((entry) => JSON.stringify(entry.payload) === JSON.stringify(payloads[0].payload));
  if (resolution.aggregate === 'VIDEO_ALL' && uniform) {
    return [element(action, 'video:all', payloads[0].payload, reason)];
  }
  return payloads.map((entry) => element(action, entry.view, entry.payload, reason));
}

/** Resize about the element's centre, but keep an edge it is docked against. */
function resizeCommands(view: ChatElementView, factor: number, absoluteWidth?: number):
  ChatCommand[] | null {
  const props = view.properties;
  const x = Number(props.x ?? 0); const y = Number(props.y ?? 0);
  const width = Number(props.width ?? 0.2); const height = Number(props.height ?? 0.2);
  const nextWidth = r4(clamp(absoluteWidth ?? width * factor, 0.02, 1));
  const nextHeight = r4(clamp(height * (nextWidth / width), 0.02, 1));
  if (Math.abs(nextWidth - width) < 1e-4) return null;
  const dockRight = x + width >= 1 - 0.02; const dockLeft = x <= 0.02;
  const dockBottom = y + height >= 1 - 0.02; const dockTop = y <= 0.02;
  const nextX = r4(clamp(dockRight && !dockLeft ? x + width - nextWidth
    : dockLeft ? x : x + (width - nextWidth) / 2, 0, 1 - nextWidth));
  const nextY = r4(clamp(dockBottom && !dockTop ? y + height - nextHeight
    : dockTop ? y : y + (height - nextHeight) / 2, 0, 1 - nextHeight));
  const resize = element('RESIZE_ELEMENT', view, { width: nextWidth, height: nextHeight },
    'Resizes about its centre.');
  const move = element('MOVE_ELEMENT', view, { x: nextX, y: nextY },
    'Keeps it centred (or docked to its edge) as it resizes.');
  // Growing: move first, so the larger box never overruns the frame edge the
  // validator clamps against. Shrinking: resize first, for the same reason.
  return nextWidth > width ? [move, resize] : [resize, move];
}

/**
 * Builds the commands for one operation against resolved targets, computing
 * every relative value from the object's current stored state.
 */
function build(op: Op, resolution: Extract<Resolution, { views: unknown }>,
  context: ChatContext, text: string): Built {
  const views = resolution.views;
  const first = views[0];
  const styles = context.runtime.styles;

  switch (op.family) {
    case 'SCALE': {
      if (resolution.aggregate === 'CAPTIONS') {
        return build({ family: 'TEXT_SIZE', dir: op.dir, mag: op.mag, byPercent: op.byPercent },
          resolution, context, text);
      }
      if (!first) return { question: 'Which element should I resize?', code: 'NEEDS_TARGET' };
      if (TEXTLIKE.includes(first.semantic)) {
        return build({ family: 'TEXT_SIZE', dir: op.dir, mag: op.mag, byPercent: op.byPercent },
          resolution, context, text);
      }
      if (first.semantic === 'ZOOM') {
        return build({ family: 'ZOOM', mode: op.dir > 0 ? 'MORE' : 'LESS', mag: op.mag },
          resolution, context, text);
      }
      if (first.semantic === 'SOURCE_VIDEO') {
        const commands = views.map((view) => element('SET_VIDEO_SCALE', view, {
          scale: r4(clamp(Number(view.properties.scale ?? 1) * scaleFactor(op), MIN_SCALE,
            MAX_SCALE)) }, 'Scales the footage in the frame.'));
        return done(commands, `Make the video ${op.dir > 0 ? 'bigger' : 'smaller'} in the frame.`,
          follow('SCALE', op.dir, views, 'VIDEO_SCALE'));
      }
      const commands = views.flatMap((view) => resizeCommands(view, scaleFactor(op),
        op.toPercent !== undefined ? op.toPercent / 100 : undefined) ?? []);
      if (!commands.length) {
        return { question: `${first.label} is already at the ${op.dir > 0 ? 'largest' : 'smallest'} size I can make it.` };
      }
      return done(commands, `Make ${nameOf(first)} ${op.dir > 0 ? 'bigger' : 'smaller'}.`,
        follow('SCALE', op.dir, views, `${first.semantic}_RESIZE`));
    }
    case 'TEXT_SIZE': {
      if (resolution.aggregate === 'CAPTIONS') {
        const current = context.tracks.captions.fontSize ?? 40;
        const fontSize = Math.round(clamp(op.absolute ?? current * scaleFactor(op),
          MIN_FONT_SIZE, MAX_FONT_SIZE));
        return done([element('SET_TEXT_SIZE', 'captions:all', { fontSize },
          'Changes caption size and nothing else.')],
        `Make the captions ${op.dir > 0 ? 'bigger' : 'smaller'}.`,
        follow('TEXT_SIZE', op.dir, [], 'CAPTIONS'));
      }
      const commands = views.map((view) => element('SET_TEXT_SIZE', view, {
        fontSize: Math.round(clamp(op.absolute ?? Number(view.properties.fontSize ?? 48) *
          scaleFactor(op), MIN_FONT_SIZE, MAX_FONT_SIZE)) }, 'Changes the text size.'));
      return done(commands, `Make ${nameOf(first)} ${op.dir > 0 ? 'bigger' : 'smaller'}.`,
        follow('TEXT_SIZE', op.dir, views, `${first.semantic}_RESIZE`));
    }
    case 'POSITION': {
      const step = MOVE_STEPS[op.mag];
      if (resolution.aggregate === 'CAPTIONS') {
        const y = context.tracks.captions.y ?? 0.73;
        if (op.place) {
          const placed = op.place.y === 'top' ? MARGIN : op.place.y === 'middle' ? 0.44 : 0.8;
          return done([element('MOVE_ELEMENT', 'captions:all', { y: placed },
            'Moves the caption band.')], `Move the captions to the ${op.place.y ?? 'bottom'}.`,
          follow('POSITION', 1, [], 'CAPTIONS', { dx: 0, dy: placed > y ? 1 : -1 }));
        }
        if (!op.dy) return { question: 'Captions stay centred across the frame - should they go up or down?' };
        const next = r4(clamp(y + op.dy * step, 0, 0.95));
        return done([element('MOVE_ELEMENT', 'captions:all', { y: next },
          'Moves the caption band; each caption keeps its own size.')],
        `Move the captions ${op.dy > 0 ? 'lower' : 'higher'}.`,
        follow('POSITION', 1, [], 'CAPTIONS', { dx: 0, dy: op.dy }));
      }
      if (!first) return { question: 'Which element should I move?', code: 'NEEDS_TARGET' };
      if (first.semantic === 'SOURCE_VIDEO') {
        const commands = views.map((view) => element('SET_VIDEO_POSITION', view, {
          x: r4(clamp(Number(view.properties.offsetX ?? 0) + op.dx * step, -1, 1)),
          y: r4(clamp(Number(view.properties.offsetY ?? 0) + op.dy * step, -1, 1)) },
        'Moves the footage inside the frame.'));
        return done(commands, 'Reposition the video in the frame.',
          follow('POSITION', 1, views, 'VIDEO_POSITION', { dx: op.dx, dy: op.dy }));
      }
      const commands = views.map((view) => {
        const width = Number(view.properties.width ?? 0.2);
        const height = Number(view.properties.height ?? 0.2);
        let x = Number(view.properties.x ?? 0) + op.dx * step;
        let y = Number(view.properties.y ?? 0) + op.dy * step;
        if (op.place?.x) x = op.place.x === 'left' ? MARGIN : op.place.x === 'right'
          ? 1 - width - MARGIN : (1 - width) / 2;
        if (op.place?.y) y = op.place.y === 'top' ? MARGIN : op.place.y === 'bottom'
          ? 1 - height - MARGIN : (1 - height) / 2;
        return element('MOVE_ELEMENT', view, { x: r4(clamp(x, 0, 1 - width)),
          y: r4(clamp(y, 0, 1 - height)) }, 'Moves it on screen.');
      });
      const where = op.place ? `to the ${[op.place.y, op.place.x].filter(Boolean).join(' ')
        .replace('middle center', 'centre')}` : [op.dy > 0 ? 'lower' : op.dy < 0 ? 'higher' : '',
        op.dx > 0 ? 'right' : op.dx < 0 ? 'left' : ''].filter(Boolean).join(' and ');
      return done(commands, `Move ${nameOf(first)} ${where}.`,
        follow('POSITION', 1, views, `${first.semantic}_MOVE`,
          op.place ? null : { dx: op.dx, dy: op.dy }));
    }
    case 'VOLUME': {
      const factor = (current: number) => op.toPercent !== undefined ? op.toPercent / 100
        : op.byPercent !== undefined ? current * (1 + op.dir * op.byPercent / 100)
          : op.dir > 0 ? current / VOLUME_FACTORS[op.mag] : current * VOLUME_FACTORS[op.mag];
      if (resolution.aggregate === 'SOURCE_AUDIO') {
        const current = context.tracks.sourceAudio.volume;
        const volume = r2(clamp(factor(current), op.toPercent === 0 ? 0 : 0.02, MAX_VOLUME));
        const commands: ChatCommand[] = [{ kind: 'ELEMENT', action: 'SET_SOURCE_AUDIO_VOLUME',
          target: { kind: 'ELEMENT', handle: 'audio:source' }, parameters: { volume },
          reason: 'Changes the level of the original sound on every segment.' }];
        if (context.tracks.sourceAudio.muted && op.dir > 0) {
          commands.push({ kind: 'ELEMENT', action: 'SET_SOURCE_AUDIO_MUTED',
            target: { kind: 'ELEMENT', handle: 'audio:source' }, parameters: { muted: false },
            reason: 'It was muted; louder means audible.' });
        }
        return done(commands, `Make the original sound ${op.dir > 0 ? 'louder' : 'quieter'}.`,
          follow('VOLUME', op.dir, [], 'SOURCE_AUDIO'));
      }
      if (!first) return { question: 'Which audio should I change?', code: 'NEEDS_TARGET' };
      const commands = views.flatMap((view) => {
        const current = Number(view.properties.volume ?? 0.25);
        const volume = r2(clamp(factor(current), op.toPercent === 0 ? 0 : 0.02, MAX_VOLUME));
        return [element('SET_AUDIO_VOLUME', view, { volume }, 'Changes the music level.'),
          ...(view.properties.muted === true && op.dir > 0
            ? [element('SET_AUDIO_MUTED', view, { muted: false }, 'It was muted.')] : [])];
      });
      return done(commands, `Make the music ${op.dir > 0 ? 'louder' : 'quieter'}.`,
        follow('VOLUME', op.dir, views, 'MUSIC_VOLUME'));
    }
    case 'MUTE': {
      if (resolution.aggregate === 'SOURCE_AUDIO') {
        return done([{ kind: 'ELEMENT', action: 'SET_SOURCE_AUDIO_MUTED',
          target: { kind: 'ELEMENT', handle: 'audio:source' }, parameters: { muted: op.muted },
          reason: 'Mutes the original sound on every segment.' }],
        `${op.muted ? 'Mute' : 'Unmute'} the original sound.`,
        follow('MUTE', op.muted ? -1 : 1, [], 'SOURCE_AUDIO'));
      }
      if (!first) return { question: 'Which audio should I mute?', code: 'NEEDS_TARGET' };
      return done(views.map((view) => element('SET_AUDIO_MUTED', view, { muted: op.muted },
        'Mutes the music clip.')), `${op.muted ? 'Mute' : 'Unmute'} the music.`,
      follow('MUTE', op.muted ? -1 : 1, views, 'MUSIC_MUTE'));
    }
    case 'FADE': {
      if (!first) return { question: 'Which music should fade?', code: 'NEEDS_TARGET' };
      const commands = views.map((view) => {
        const length = view.endSec - view.startSec;
        const span = Math.min(op.sec ?? 2, length / (op.fadeIn && op.fadeOut ? 2 : 1));
        // Only the edge that was asked for changes; the other fade is kept.
        return element('SET_AUDIO_FADE', view, {
          fadeInSec: r2(op.fadeIn ? (op.off ? 0 : span) : Number(view.properties.fadeInSec ?? 0)),
          fadeOutSec: r2(op.fadeOut ? (op.off ? 0 : span) : Math.min(Number(
            view.properties.fadeOutSec ?? 0), Math.max(0, length - (op.fadeIn ? span : 0)))) },
        'Sets the fade the request names and keeps the other.');
      });
      return done(commands, op.off ? 'Remove the music fade.'
        : `Fade the music ${op.fadeIn && op.fadeOut ? 'in and out' : op.fadeIn ? 'in' : 'out'}.`,
      follow('FADE', 1, views, 'MUSIC_FADE'));
    }
    case 'DUCK': {
      if (!first) return { question: 'Which music should duck under speech?', code: 'NEEDS_TARGET' };
      if (op.on && !context.project.hasWordTimings) {
        return { question: 'I can\'t lower the music under speech yet: this source has no word ' +
          'timings. Run "Analyze source" first, then ask again.' };
      }
      return done(views.map((view) => element('SET_AUDIO_DUCKING', view, {
        duckEnabled: op.on, ...(op.strength ? { duckStrength: op.strength } : {}) },
      'Lowers the music automatically wherever the transcript has speech.')),
      op.on ? 'Lower the music automatically while someone is speaking.'
        : 'Stop lowering the music under speech.', follow('DUCK', op.on ? 1 : -1, views, 'MUSIC_DUCK'));
    }
    case 'COLOR': {
      const segments = segmentsFor(resolution, context);
      const bounds = COLOR_BOUNDS[op.key];
      const step = COLOR_STEPS[op.mag] * op.dir;
      const action = `SET_VIDEO_${op.key.toUpperCase()}`;
      const commands = perSegment(resolution, segments, action, (view) => {
        const current = Number((view.properties.color as Record<string, number> | undefined)?.[op.key] ?? 0);
        const next = r4(clamp(current + step, bounds.min, bounds.max));
        return Math.abs(next - current) < 1e-6 ? null : { [op.key]: next };
      }, `Moves ${op.key} ${op.dir > 0 ? 'up' : 'down'} from its current value.`);
      const words: Record<string, [string, string]> = { temperature: ['warmer', 'cooler'],
        contrast: ['higher-contrast', 'lower-contrast'], saturation: ['more saturated', 'less saturated'],
        exposure: ['brighter', 'darker'], brightness: ['brighter', 'darker'],
        highlights: ['brighter highlights', 'softer highlights'], shadows: ['lifted shadows',
          'deeper shadows'], sharpness: ['sharper', 'softer'], fade: ['more faded', 'less faded'],
        vignette: ['more vignette', 'less vignette'], tint: ['more magenta', 'more green'] };
      if (!commands.length) {
        return { question: `The video is already as ${words[op.key][op.dir > 0 ? 0 : 1]
          .replace(/^more |^less |-contrast$/u, '')} as it can go.` };
      }
      return done(commands, `Make the video ${words[op.key][op.dir > 0 ? 0 : 1]}.`,
        follow(`COLOR:${op.key}`, op.dir, segments, 'COLOR'));
    }
    case 'FILTER': {
      const segments = segmentsFor(resolution, context);
      return done(perSegment(resolution, segments, 'APPLY_COLOR_FILTER',
        () => ({ filterId: op.filterId, strength: op.strength }), 'Applies a built-in look.'),
      `Give the video the ${op.filterId.toLowerCase().replace(/_/gu, ' ')} look.`,
      follow('FILTER', 1, segments, `FILTER:${op.filterId}`),
      segments.some((view) => Object.keys((view.properties.colorChanged ?? {}) as object).length)
        ? ['A look replaces the colour adjustments already on the video.'] : []);
    }
    case 'COLOR_RESET': {
      const segments = segmentsFor(resolution, context);
      return done(perSegment(resolution, segments, 'RESET_VIDEO_ADJUSTMENTS', () => ({}),
        'Returns every colour control to neutral.'), 'Reset the video colour.',
      follow('COLOR_RESET', 1, segments, 'COLOR'));
    }
    case 'ZOOM': {
      const zoom = first?.semantic === 'ZOOM' ? first : undefined;
      if (op.mode === 'ADD' || (!zoom && op.mode !== 'REMOVE')) {
        let startTime: number;
        let duration = DEFAULT_ZOOM_DURATION_SEC;
        let trigger = '';
        if (op.phrase) {
          const found = findSpoken(op.phrase, context);
          if (!found) {
            return { question: `I couldn't find "${op.phrase}" in the transcript${
              context.transcript.available ? '' : ' (this source has not been analysed yet)'}.` };
          }
          startTime = Math.max(0, found.timelineSec - 0.1);
          trigger = found.text;
        } else {
          const range = context.selection.selectedTimeRange;
          startTime = range ? range.startSec : Math.max(0, context.selection.playheadSec - 0.1);
          if (range) duration = Math.max(MIN_ZOOM_DURATION_SEC, range.endSec - range.startSec);
        }
        duration = Math.min(duration, context.project.timelineDurationSec - startTime);
        if (duration < MIN_ZOOM_DURATION_SEC) {
          return { question: 'There is not enough video left after that point for a zoom to ease ' +
            'in and out. Move the playhead a little earlier.' };
        }
        const scale = op.scale ?? (op.mag === 'small' ? 1.06 : op.mag === 'large'
          ? MAX_ZOOM_SCALE : DEFAULT_ZOOM_SCALE);
        return done([{ kind: 'ELEMENT', action: 'ADD_ZOOM', parameters: { startTime: r2(startTime),
          duration: r2(duration), scale, ...(trigger ? { triggerText: trigger } : {}) },
        reason: 'Adds one zoom at the requested moment.' }],
        `Zoom in at ${startTime.toFixed(1)}s${trigger ? ` ("${trigger}")` : ''}.`,
        follow('ZOOM', 1, [], 'ZOOM_ADD'),
        ['A zoom is checked at export: if it would crop the speaker or on-screen text, it is ' +
          'reduced or skipped.']);
      }
      if (!zoom) {
        return { question: 'There is no zoom here. Put the playhead on the zoom you mean, or say ' +
          '"zoom in here" to add one.', code: 'NEEDS_TARGET' };
      }
      const current = Number(zoom.properties.scale ?? DEFAULT_ZOOM_SCALE);
      if (op.mode === 'REMOVE') {
        return done([element('REMOVE_ZOOM', zoom, {}, 'Removes this zoom only.')],
          `Remove the zoom at ${zoom.startSec.toFixed(1)}s.`, follow('ZOOM', -1, [zoom], 'ZOOM'));
      }
      const next = op.mode === 'SET' ? op.scale!
        : r2(current + (op.mode === 'MORE' ? 1 : -1) * ZOOM_STEPS[op.mag]);
      if (next > MAX_ZOOM_SCALE + 1e-6 && op.mode === 'MORE') {
        return { question: `That zoom is already at the strongest safe level (${MAX_ZOOM_SCALE}x).` };
      }
      if (next < MIN_ZOOM_SCALE - 1e-6) {
        return { question: `That zoom is already as subtle as a zoom can be (${
          current.toFixed(2)}x). Should I remove it instead?` };
      }
      return done([element('SET_ZOOM_SCALE', zoom, { scale: r2(clamp(next, MIN_ZOOM_SCALE,
        MAX_ZOOM_SCALE)) }, 'Changes this zoom\'s strength only.')],
      `Make the zoom at ${zoom.startSec.toFixed(1)}s ${op.mode === 'MORE' ? 'deeper'
        : op.mode === 'LESS' ? 'subtler' : 'subtle'}.`,
      follow('ZOOM', op.mode === 'LESS' || (op.mode === 'SET' && next < current) ? -1 : 1,
        zoom.virtual ? [] : [zoom], zoom.virtual ? `ZOOM_MOMENT:${zoom.momentKey}` : 'ZOOM'));
    }
    case 'CROP': {
      const targets = segmentsFor(resolution, context);
      if (!targets.length) return { question: 'What should I crop?', code: 'NEEDS_TARGET' };
      const step = CROP_STEPS[op.mag];
      const commands: ChatCommand[] = [];
      let settings: ChatCommand | null = null;
      for (const view of targets) {
        const crop = { left: 0, right: 0, top: 0, bottom: 0,
          ...(view.properties.crop as Record<string, number> | undefined) };
        const next = { ...crop };
        const room = (a: number, b: number) => 1 - MIN_CROP_REMAINDER - 0.05 - a - b;
        if (op.mode === 'RESET') { next.left = next.right = next.top = next.bottom = 0; }
        else if (op.mode === 'TIGHTER') {
          if (op.side) next[op.side] = crop[op.side] + Math.min(step,
            room(crop.left + crop.right, 0) > 0 && (op.side === 'left' || op.side === 'right')
              ? room(crop.left, crop.right) : room(crop.top, crop.bottom));
          else {
            const h = Math.max(0, Math.min(step, room(crop.left, crop.right) / 2));
            const v = Math.max(0, Math.min(step, room(crop.top, crop.bottom) / 2));
            next.left += h; next.right += h; next.top += v; next.bottom += v;
          }
        } else if (op.mode === 'LOOSER') {
          if (op.side) next[op.side] = Math.max(0, crop[op.side] - step);
          else for (const key of ['left', 'right', 'top', 'bottom'] as const) {
            next[key] = Math.max(0, crop[key] - step);
          }
        } else if (op.mode === 'SHIFT' && op.side) {
          const [from, to] = op.side === 'left' ? ['left', 'right'] : op.side === 'right'
            ? ['right', 'left'] : op.side === 'top' ? ['top', 'bottom'] : ['bottom', 'top'];
          const moved = Math.min(step, crop[from as keyof typeof crop]);
          next[from as keyof typeof crop] -= moved; next[to as keyof typeof crop] += moved;
        } else if (op.mode === 'CENTER_FACE') {
          const width = 1 - crop.left - crop.right;
          const faces = context.runtime.faceCentres;
          if (width >= 0.999) {
            if (context.project.aspectRatio !== 'SOURCE' && faces.length) {
              settings = { kind: 'SETTINGS', action: 'SET_AUTO_REFRAME',
                parameters: { reframePolicy: 'FACE_FOCUSED' },
                reason: 'Reframing follows the detected face.' };
              continue;
            }
            return { question: 'Nothing is cropped - the whole frame is already showing, so the ' +
              'person is as centred as the original shot.' };
          }
          if (!faces.length) {
            return { question: 'The cached analysis has no face positions for this video, so I ' +
              'cannot centre on the person. Tell me which way to move the crop instead.' };
          }
          const xs = faces.map((face) => face.x).sort((a, b) => a - b);
          const centre = xs[Math.floor(xs.length / 2)];
          next.left = clamp(centre - width / 2, 0, 1 - width);
          next.right = 1 - width - next.left;
        }
        const rounded = Object.fromEntries(Object.entries(next).map(([key, value]) =>
          [key, r4(Math.max(0, value))])) as typeof next;
        if (['left', 'right', 'top', 'bottom'].every((key) =>
          Math.abs(rounded[key as keyof typeof next] - crop[key as keyof typeof crop]) < 1e-6)) continue;
        commands.push(element('SET_VIDEO_CROP', view, { cropLeft: rounded.left,
          cropRight: rounded.right, cropTop: rounded.top, cropBottom: rounded.bottom },
        'Adjusts the crop from its current edges.'));
      }
      if (settings) {
        return done([settings], 'Keep the person centred by following their face.', null);
      }
      if (!commands.length) {
        return { question: op.mode === 'LOOSER' || op.mode === 'RESET'
          ? `Nothing is cropped${op.side ? ` on the ${op.side}` : ''} - that edge of the frame is already fully showing.`
          : op.mode === 'SHIFT' ? `The crop is already at the ${op.side} edge.`
            : 'The crop is already as tight as it can safely go.' };
      }
      const describe = op.mode === 'TIGHTER' ? 'Crop in tighter' : op.mode === 'LOOSER'
        ? `Show more${op.side ? ` on the ${op.side}` : ''}` : op.mode === 'SHIFT'
          ? `Move the crop ${op.side}` : op.mode === 'RESET' ? 'Remove the crop' : 'Centre the crop on the person';
      return done(commands, `${describe}.`, follow('CROP', op.mode === 'TIGHTER' ? 1
        : op.mode === 'LOOSER' ? -1 : 1, targets, `CROP:${op.mode}${op.side ? `:${op.side}` : ''}`));
    }
    case 'ROTATION': {
      const targets = resolution.aggregate === 'VIDEO_ALL' ? videos(context) : views;
      if (!targets.length) return { question: 'What should I rotate?', code: 'NEEDS_TARGET' };
      const commands = perSegment(resolution, targets, 'SET_VIDEO_ROTATION', (view) => {
        const current = Number(view.properties.rotation ?? 0);
        let next = op.mode === 'TO' ? op.degrees : current + op.degrees;
        if (next > MAX_ROTATION) next -= 360;
        if (next < MIN_ROTATION) next += 360;
        next = r2(clamp(next, MIN_ROTATION, MAX_ROTATION));
        return Math.abs(next - current) < 1e-6 ? null : { rotation: next };
      }, 'Rotates from its current angle.');
      if (!commands.length) {
        return { question: op.degrees === 0 && op.mode === 'TO'
          ? `${targets.length > 1 ? 'The video is' : `${targets[0].label} is`} already straight (0°).`
          : 'That is already the angle.' };
      }
      return done(commands, op.mode === 'TO' && op.degrees === 0 ? `Straighten ${nameOf(targets[0])}.`
        : `Rotate ${nameOf(targets[0])} ${op.mode === 'TO' ? `to ${op.degrees}°`
          : `${Math.abs(op.degrees)}° ${op.degrees > 0 ? 'clockwise' : 'counter-clockwise'}`}.`,
      follow('ROTATION', op.degrees >= 0 ? 1 : -1, targets, 'ROTATION'));
    }
    case 'FLIP': {
      const targets = resolution.aggregate === 'VIDEO_ALL' ? videos(context) : views;
      if (!targets.length) return { question: 'What should I flip?', code: 'NEEDS_TARGET' };
      return done(targets.map((view) => element('SET_VIDEO_FLIP', view, {
        flipH: op.axis === 'H' ? view.properties.flipH !== true : view.properties.flipH === true,
        flipV: op.axis === 'V' ? view.properties.flipV !== true : view.properties.flipV === true },
      'Toggles the flip on one axis and keeps the other.')),
      `Flip ${nameOf(targets[0])} ${op.axis === 'H' ? 'horizontally' : 'vertically'}.`,
      follow('FLIP', 1, targets, 'FLIP'));
    }
    case 'SPEED': {
      const range = context.selection.selectedTimeRange;
      const next = (current: number) => {
        if (op.mode === 'SET') return clamp(op.value ?? 1, MIN_SPEED, MAX_SPEED);
        const presets = [...SPEED_PRESETS] as number[];
        const steps = op.mag === 'large' ? 2 : 1;
        if (op.mode === 'FASTER') {
          const higher = presets.filter((value) => value > current + 1e-6);
          return higher[Math.min(steps, higher.length) - 1] ?? Math.min(MAX_SPEED, current * 1.5);
        }
        const lower = presets.filter((value) => value < current - 1e-6).reverse();
        return lower[Math.min(steps, lower.length) - 1] ?? Math.max(MIN_SPEED, current / 1.5);
      };
      // "Make this section faster" with a range drawn: split at both edges, then
      // change only the middle. Right edge first so the left split does not move it.
      if (range && /\b(?:this|that|the selected) (?:section|part|bit|range|selection)\b|\bselection\b/u
        .test(text)) {
        const segment = videos(context).find((view) => range.startSec >= view.startSec - 1e-6 &&
          range.endSec <= view.endSec + 1e-6);
        if (!segment) {
          return { question: 'That range crosses a cut. Select a range inside one clip and ask again.' };
        }
        const speed = r2(next(Number(segment.properties.speed ?? 1)));
        const commands: ChatCommand[] = [];
        if (range.endSec < segment.endSec - 0.1) commands.push({ kind: 'ELEMENT',
          action: 'SPLIT_ELEMENT', target: { kind: 'AT_TIME', atSec: range.endSec },
          parameters: { playheadSec: range.endSec }, reason: 'Isolates the end of the range.' });
        if (range.startSec > segment.startSec + 0.1) commands.push({ kind: 'ELEMENT',
          action: 'SPLIT_ELEMENT', target: { kind: 'AT_TIME', atSec: range.startSec },
          parameters: { playheadSec: range.startSec }, reason: 'Isolates the start of the range.' });
        commands.push({ kind: 'ELEMENT', action: 'SET_SPEED',
          target: { kind: 'AT_TIME', atSec: r4((range.startSec + range.endSec) / 2) },
          parameters: { speed }, reason: 'Changes the speed of the selected range only.' });
        return done(commands, `Play ${range.startSec.toFixed(1)}s–${range.endSec.toFixed(1)}s at ${speed}x.`,
          null, ['Overlays and captions over this range move with it.']);
      }
      const targets = resolution.aggregate === 'VIDEO_ALL' ? videos(context) : views;
      if (!targets.length) return { question: 'Which part should change speed?', code: 'NEEDS_TARGET' };
      const commands = perSegment(resolution, targets, 'SET_SPEED', (view) => {
        const current = Number(view.properties.speed ?? 1);
        const speed = r2(next(current));
        return Math.abs(speed - current) < 1e-6 ? null : { speed };
      }, 'Changes the playback speed of this segment.');
      if (!commands.length) {
        return { question: `It is already at ${op.mode === 'FASTER' ? 'the fastest'
          : op.mode === 'SLOWER' ? 'the slowest' : 'that'} speed.` };
      }
      return done(commands, `${op.mode === 'SLOWER' ? 'Slow down' : 'Speed up'} ${
        targets.length === videos(context).length && targets.length > 1 ? 'the whole video'
          : targets.length === 1 && videos(context).length > 1 ? 'this segment' : 'the video'}.`,
      follow('SPEED', op.mode === 'SLOWER' ? -1 : 1, targets, 'SPEED'),
      ['Overlays and captions over the changed segment move with it.']);
    }
    case 'TEXT_STYLE': {
      const bulk = resolution.aggregate === 'CAPTIONS';
      if (!bulk && !first) return { question: 'Which text should I restyle?', code: 'NEEDS_TARGET' };
      if (op.action === 'SET_TEXT_STYLE_PRESET' && (bulk || first.semantic === 'CAPTION')) {
        return { question: 'That is a text style. For captions, choose a caption style - for ' +
          'example "use bold highlight captions".' };
      }
      const payloadFor = (id: string): Record<string, unknown> | null => {
        const style = styles.get(id);
        const p = op.payload;
        if (op.action === 'SET_TEXT_STROKE') {
          return { strokeEnabled: p.strokeEnabled, strokeColor: p.strokeColor ?? style?.stroke.color ?? '#000000',
            strokeWidth: style?.stroke.width && style.stroke.width > 0 ? style.stroke.width : 4 };
        }
        if (op.action === 'SET_TEXT_SHADOW') {
          const shadow = style?.shadow;
          return { shadowEnabled: p.shadowEnabled, shadowColor: shadow?.color ?? '#000000',
            shadowOpacity: shadow?.opacity ?? 0.6, shadowBlur: shadow?.blur ?? 6,
            shadowOffsetX: shadow?.offsetX ?? 2, shadowOffsetY: shadow?.offsetY ?? 3 };
        }
        if (op.action === 'SET_TEXT_BACKGROUND') {
          const background = style?.background;
          return { backgroundEnabled: p.backgroundEnabled,
            backgroundColor: p.backgroundColor ?? background?.color ?? '#000000',
            backgroundOpacity: background?.opacity ?? 0.6, backgroundPadding: background?.padding ?? 12,
            backgroundRadius: background?.radius ?? 8 };
        }
        if (op.action === 'SET_TEXT_SPACING') {
          const letter = style?.letterSpacing ?? 0;
          return { letterSpacing: r2(clamp(letter + Number(p.letterSpacingDir) * 2, -20, 60)),
            lineSpacing: style?.lineSpacing ?? 1.2 };
        }
        if (op.action === 'SET_TEXT_WEIGHT') {
          const weight = style?.fontWeight ?? 700;
          const next = p.bold === true && weight < 700 ? 700
            : clamp(weight + Number(p.fontWeightDir) * 200, 300, 900);
          return next === weight ? null : { fontWeight: next };
        }
        return { ...p };
      };
      const reference = bulk ? context.runtime.captionIds[0] : first.id;
      const payload = payloadFor(reference);
      if (!payload) return { question: `That text is already as ${op.payload.fontWeightDir === 1
        ? 'bold' : 'light'} as it goes.` };
      const commands = bulk ? [element(op.action, 'captions:all', payload,
        'Restyles the whole caption track, changing only this property.')]
        : views.map((view) => element(op.action, view, payloadFor(view.id) ?? payload,
          'Changes one style property.'));
      return done(commands, `Change the ${op.describe} of ${bulk ? 'the captions' : nameOf(first)}.`,
        follow('TEXT_STYLE', 1, bulk ? [] : views, bulk ? 'CAPTIONS' : `${first.semantic}_STYLE`));
    }
    case 'OPACITY': {
      if (!first) return { question: 'Which element?', code: 'NEEDS_TARGET' };
      return done(views.map((view) => {
        const current = Number(view.properties.opacity ?? 1);
        return element('SET_ELEMENT_OPACITY', view, { opacity: r2(op.value ?? clamp(op.dir > 0
          ? current + 0.25 : current * 0.6, 0.05, 1)) }, 'Changes transparency.');
      }), `Make ${nameOf(first)} ${op.dir > 0 ? 'more solid' : 'more transparent'}.`,
      follow('OPACITY', op.dir, views, `${first.semantic}_OPACITY`));
    }
    case 'LAYER':
      if (!first) return { question: 'Which element?', code: 'NEEDS_TARGET' };
      return done(views.map((view) => element('SET_ELEMENT_Z_INDEX', view,
        { zIndex: op.front ? 90 : 5 }, 'Changes stacking order.')),
      `${op.front ? 'Bring' : 'Send'} ${nameOf(first)} ${op.front ? 'to the front' : 'behind the other overlays'}.`,
      null);
    case 'VISIBLE':
      if (resolution.aggregate === 'CAPTIONS') {
        return done([{ kind: 'ELEMENT', action: 'SET_CAPTIONS_VISIBLE', parameters: { visible: op.visible },
          reason: 'Shows or hides the whole caption track.' }],
        `${op.visible ? 'Show' : 'Hide'} the captions.`, null);
      }
      if (!first) return { question: 'Which element?', code: 'NEEDS_TARGET' };
      if (first.semantic === 'MUSIC') return build({ family: 'MUTE', muted: !op.visible }, resolution, context, text);
      return done(views.map((view) => element('SET_ELEMENT_VISIBLE', view, { visible: op.visible },
        'Hides it without deleting it.')), `${op.visible ? 'Show' : 'Hide'} ${nameOf(first)}.`,
      follow('VISIBLE', op.visible ? 1 : -1, views, `${first.semantic}_VISIBLE`));
    case 'LOCK':
      if (!first) return { question: 'Which element?', code: 'NEEDS_TARGET' };
      return done(views.map((view) => element('SET_ELEMENT_LOCKED', view, { locked: op.locked },
        'Locks it against timeline gestures.')), `${op.locked ? 'Lock' : 'Unlock'} ${nameOf(first)}.`, null);
    case 'REMOVE':
      if (resolution.aggregate === 'CAPTIONS') {
        return build({ family: 'CAPTIONS', op: 'REMOVE' }, resolution, context, text);
      }
      if (!first) return { question: 'What should I remove?', code: 'NEEDS_TARGET' };
      return done(views.map((view) => view.semantic === 'ZOOM'
        ? element('REMOVE_ZOOM', view, {}, 'Removes this zoom only.')
        : element('REMOVE_ELEMENT', view, {}, 'Removes it from the timeline.')),
      `Remove ${nameOf(first)}.`, null);
    case 'TIMING': {
      if (!first) return { question: 'Which element should I retime?', code: 'NEEDS_TARGET' };
      const total = context.project.timelineDurationSec;
      return done(views.map((view) => {
        const length = view.endSec - view.startSec;
        let start = op.startSec ?? view.startSec;
        let duration = op.durationSec ?? (op.endSec !== undefined ? op.endSec - start : length);
        if (op.longer) duration = length * (op.longer > 0 ? 1.5 : 0.67);
        if (op.endSec !== undefined && op.startSec === undefined && op.durationSec === undefined) {
          duration = op.endSec - start;
        }
        start = clamp(start, 0, Math.max(0, total - 0.1));
        duration = r2(clamp(duration, 0.1, total - start));
        return element('SET_ELEMENT_TIMING', view, { startTime: r2(start), duration,
          ...(view.semantic === 'MUSIC' ? { trimStart: view.trimStartSec,
            trimEnd: r4(view.trimStartSec + duration) } : {}) }, 'Changes when it is on screen.');
      }), `Change when ${nameOf(first)} appears.`, follow('TIMING', 1, views, `${first.semantic}_TIMING`));
    }
    case 'CONTENT':
      if (!first) return { question: 'Which text should I change?', code: 'NEEDS_TARGET' };
      return done([element('SET_TEXT_CONTENT', first, { content: op.content },
        'Uses the wording exactly as given.')], `Change ${nameOf(first)} to "${op.content}".`,
      follow('CONTENT', 1, [first], first.semantic === 'HOOK' ? 'HOOK_REWRITE' : 'TEXT_CONTENT'));
    case 'CAPTIONS': {
      const style = context.tracks.captions;
      switch (op.op) {
        case 'GENERATE':
          if (!context.project.hasWordTimings) {
            return { question: context.project.hasTranscript
              ? 'Captions need word timings, and this source\'s transcript only has sentence ' +
                'timings. Run "Analyze source" again to get word-level timings.'
              : 'Captions are built from the transcript, and this source has not been analysed ' +
                'yet. Run "Analyze source" first.' };
          }
          return done([{ kind: 'ELEMENT', action: 'GENERATE_CAPTIONS',
            parameters: style.styleId ? { captionStyleId: style.styleId } : {},
            reason: 'Builds caption lines from the cached transcript.' }],
          style.count ? 'Regenerate the captions from the transcript.' : 'Add captions.', null,
          style.manualEdited ? [`Regenerating replaces all ${style.count} captions, including ${
            style.manualEdited} you corrected by hand.`] : []);
        case 'REMOVE':
          return done([{ kind: 'ELEMENT', action: 'REMOVE_CAPTIONS', parameters: {},
            reason: 'Removes the caption track.' }], 'Remove all captions.', null,
          style.manualEdited ? [`${style.manualEdited} hand-corrected captions will be removed too.`] : []);
        case 'HIDE': case 'SHOW':
          return done([{ kind: 'ELEMENT', action: 'SET_CAPTIONS_VISIBLE',
            parameters: { visible: op.op === 'SHOW' }, reason: 'Shows or hides the captions.' }],
          `${op.op === 'SHOW' ? 'Show' : 'Hide'} the captions.`, null);
        case 'STYLE':
          return done([element('SET_CAPTION_STYLE', 'captions:all', { captionStyleId: op.styleId },
            'Applies a built-in caption style to every caption.')],
          `Use the ${String(op.styleId).toLowerCase().replace(/_/gu, ' ')} caption style.`,
          follow('CAPTION_STYLE', 1, [], 'CAPTIONS'),
          ['Caption styles include their own placement, so the captions may move.']);
        case 'ACTIVE_WORD':
          return done([element('SET_CAPTION_ACTIVE_WORD', 'captions:all', {
            activeWordEnabled: op.enabled !== false, activeWordColor: op.color ?? HIGHLIGHT_YELLOW },
          'Highlights each word as it is spoken.')],
          op.enabled === false ? 'Turn off the spoken-word highlight.'
            : 'Highlight each word as it is spoken.', follow('CAPTION_STYLE', 1, [], 'CAPTIONS'),
          style.manualEdited ? ['Captions you reworded by hand have no word timings to highlight, ' +
            'so they stay plain.'] : []);
        case 'FIX':
          if (!first) return { question: 'Which caption? Select it or move the playhead onto it.', code: 'NEEDS_TARGET' };
          if (!op.content) {
            return { question: `What should ${first.label.toLowerCase()} say instead?` };
          }
          return done([element('SET_CAPTION_TEXT', first, { content: op.content },
            'Uses your wording exactly; it is marked as corrected so it is kept.')],
          `Change that caption to "${op.content}".`, null);
        case 'SPLIT': {
          if (!first) return { question: 'Which caption should I split?', code: 'NEEDS_TARGET' };
          const at = context.selection.playheadSec;
          const atSec = at > first.startSec + 0.3 && at < first.endSec - 0.3 ? at
            : (first.startSec + first.endSec) / 2;
          return done([element('SPLIT_CAPTION', first, { atSec: r4(atSec) },
            'Splits the caption between words.')], `Split that caption at ${atSec.toFixed(1)}s.`, null);
        }
        case 'MERGE':
          if (!first) return { question: 'Which caption should I merge?', code: 'NEEDS_TARGET' };
          return done([element('MERGE_CAPTION', first, { direction: op.direction ?? 'NEXT' },
            'Merges it with its neighbour.')],
          `Merge that caption with the ${(op.direction ?? 'NEXT').toLowerCase()} one.`, null);
      }
    }
  }
  return { question: 'I understood what to change but not how. Could you say it another way?' };
}

/** A spoken phrase, found in the cached transcript and placed on the timeline. */
function findSpoken(phrase: string, context: ChatContext) {
  const words = context.runtime.words;
  const wanted = phrase.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, '').split(/\s+/u).filter(Boolean);
  if (!wanted.length) return null;
  const clean = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  for (let index = 0; index + wanted.length <= words.length; index += 1) {
    if (wanted.every((word, offset) => clean(words[index + offset].text) === word)) {
      const timelineSec = context.runtime.map.toTimeline(words[index].start)[0];
      if (timelineSec !== undefined) {
        return { timelineSec, text: words.slice(index, index + wanted.length)
          .map((word) => word.text).join(' ') };
      }
    }
  }
  return null;
}

// --- Follow-ups --------------------------------------------------------------------

/** "a little more" / "that's too much": the active family again, small, same or reversed. */
function followUpOp(kind: 'MORE' | 'LESS', context: ChatContext): Op | { question: string } {
  const active = context.runtime.thread.active;
  if (!active) {
    return { question: kind === 'MORE' ? 'More of what? Tell me what to change - for example ' +
      '"make the logo smaller".' : 'Less of what? Tell me which change went too far.' };
  }
  const dir = kind === 'MORE' ? active.direction : -active.direction;
  const [family, key] = active.family.split(':');
  const mag: Magnitude = 'small';
  switch (family) {
    case 'SCALE': return { family: 'SCALE', dir, mag };
    case 'TEXT_SIZE': return { family: 'TEXT_SIZE', dir, mag };
    case 'POSITION': {
      const vector = active.vector ?? { dx: 0, dy: 1 };
      const sign = kind === 'MORE' ? 1 : -1;
      return { family: 'POSITION', dx: vector.dx * sign, dy: vector.dy * sign, mag };
    }
    case 'VOLUME': return { family: 'VOLUME', dir, mag };
    case 'COLOR': return { family: 'COLOR', key: key as ColorKey, dir, mag };
    case 'FILTER': return { family: 'FILTER', filterId: active.task.split(':')[1] ?? 'CLEAN',
      strength: kind === 'MORE' ? 1 : 0.5 };
    case 'ZOOM': return { family: 'ZOOM', mode: dir > 0 ? 'MORE' : 'LESS', mag };
    case 'CROP': return { family: 'CROP', mode: dir > 0 ? 'TIGHTER' : 'LOOSER', mag };
    case 'ROTATION': return { family: 'ROTATION', mode: 'BY', degrees: 2 * dir };
    case 'SPEED': return { family: 'SPEED', mode: dir > 0 ? 'FASTER' : 'SLOWER', mag };
    case 'OPACITY': return { family: 'OPACITY', dir };
    case 'DUCK': return { family: 'DUCK', on: true, strength: kind === 'MORE' ? 'STRONG' : 'SUBTLE' };
    case 'CONTENT':
      if (active.task === 'HOOK_REWRITE') {
        return { family: 'HOOK', mode: kind === 'MORE' ? 'STRONGER' : 'SHORTER' };
      }
      break;
    default: break;
  }
  return { question: `I'm not sure how to do ${kind === 'MORE' ? 'more' : 'less'} of that. ` +
    'Could you say what to change?' };
}

/** The objects the active target refers to, including whole-track tasks. */
function activeResolution(context: ChatContext): Extract<Resolution, { views: unknown }> | null {
  const active = context.runtime.thread.active;
  if (!active) return null;
  if (active.task === 'CAPTIONS') return { views: [], aggregate: 'CAPTIONS', how: 'ACTIVE' };
  if (active.task === 'SOURCE_AUDIO') return { views: [], aggregate: 'SOURCE_AUDIO', how: 'ACTIVE' };
  if (active.task.startsWith('ZOOM_MOMENT:')) {
    const key = active.task.slice('ZOOM_MOMENT:'.length);
    const view = context.elements.find((element) => element.momentKey === key) ??
      context.elements.find((element) => element.semantic === 'ZOOM' &&
        element.properties.claimsMoment === key);
    return view ? { views: [view], how: 'ACTIVE' } : null;
  }
  // A zoom that was just ADDED has no id yet in the thread; the newest zoom is it.
  if (active.task === 'ZOOM_ADD' && !active.elementIds.length) {
    const near = zoomNearPlayhead(context);
    if (near.length) return { views: near, how: 'ACTIVE' };
  }
  const views = activeViews(context);
  return views.length ? wholeVideo(views, context) ?? { views, how: 'ACTIVE' } : null;
}

/** An active target that is every segment of the video IS the whole video. */
function wholeVideo(views: ChatElementView[], context: ChatContext):
  Extract<Resolution, { views: unknown }> | null {
  const all = videos(context);
  return all.length > 1 && views.length === all.length &&
    all.every((view) => views.includes(view))
    ? { views: all, aggregate: 'VIDEO_ALL', how: 'ACTIVE' } : null;
}

// --- Clause chaining ---------------------------------------------------------------------

/** A copy of the context whose object state the parser may update as it goes. */
function workingCopy(context: ChatContext): ChatContext {
  return { ...context,
    elements: context.elements.map((view) => ({ ...view,
      properties: JSON.parse(JSON.stringify(view.properties)) as Record<string, unknown> })),
    tracks: JSON.parse(JSON.stringify(context.tracks)) as ChatContext['tracks'] };
}

/**
 * Folds one clause's commands into the working state, for the values a later
 * clause may compute from. Only the plain value writes are modelled; anything
 * else (a filter, a template) is left as it was, which at worst makes a later
 * relative step start from the pre-message value - never an invented one.
 */
function simulate(context: ChatContext, commands: ChatCommand[]) {
  for (const command of commands) {
    if (command.kind !== 'ELEMENT' || command.target?.kind !== 'ELEMENT') continue;
    const handle = command.target.handle ?? '';
    const values = command.parameters;
    if (handle === 'captions:all') {
      if (values.fontSize !== undefined) context.tracks.captions.fontSize = Number(values.fontSize);
      if (values.y !== undefined) context.tracks.captions.y = Number(values.y);
      continue;
    }
    if (handle === 'audio:source') {
      if (values.volume !== undefined) context.tracks.sourceAudio.volume = Number(values.volume);
      if (values.muted !== undefined) context.tracks.sourceAudio.muted = values.muted === true;
      continue;
    }
    const views = handle === 'video:all' ? videos(context)
      : context.elements.filter((view) => view.handle === handle);
    for (const view of views) {
      const props = view.properties;
      const colorKey = /^SET_VIDEO_(EXPOSURE|BRIGHTNESS|CONTRAST|HIGHLIGHTS|SHADOWS|SATURATION|TEMPERATURE|TINT|SHARPNESS|FADE|VIGNETTE)$/u
        .exec(command.action)?.[1]?.toLowerCase();
      if (colorKey) {
        props.color = { ...(props.color as object ?? {}), [colorKey]: values[colorKey] };
      } else if (command.action === 'SET_VIDEO_CROP') {
        props.crop = { left: values.cropLeft, right: values.cropRight, top: values.cropTop,
          bottom: values.cropBottom };
      } else if (command.action === 'SET_VIDEO_POSITION') {
        props.offsetX = values.x; props.offsetY = values.y;
      } else if (command.action === 'SET_TEXT_CONTENT') {
        props.content = values.content;
      } else {
        for (const key of ['x', 'y', 'width', 'height', 'fontSize', 'volume', 'muted', 'rotation',
          'scale', 'speed', 'opacity']) {
          if (values[key] !== undefined) props[key] = values[key];
        }
      }
    }
  }
}

// --- Clause parsing ---------------------------------------------------------------------

/** Phrases whose "and" is not a clause boundary. */
const PROTECTED = [/\bblack and white\b/gu, /\bin and out\b/gu, /\bup and down\b/gu,
  /\bback and forth\b/gu];

export function splitClauses(message: string): string[] {
  let text = message.trim().replace(/[.!]+$/u, '');
  for (const pattern of PROTECTED) text = text.replace(pattern, (match) => match.replace(/ /gu, '_'));
  // Quoted wording is never split.
  const quotes: string[] = [];
  text = text.replace(/["“][^"”]*["”]/gu, (match) => { quotes.push(match); return `\u0000${quotes.length - 1}\u0000`; });
  const parts = text.split(/\s*(?:[,;]\s*(?:and\s+|then\s+|also\s+|plus\s+)?|\s+(?:and then|and also|then|also|and|plus|but)\s+|\.\s+)/u)
    .map((part) => part.replace(/\u0000(\d+)\u0000/gu, (_match, index) => quotes[Number(index)])
      .replace(/_/gu, ' ').trim()).filter(Boolean);
  return parts.length ? parts : [message.trim()];
}

/** A template the message names, by its display name. */
function namedTemplate(text: string, context: ChatContext): ChatTemplateView | null {
  const named = /\btemplate\b/u.test(text);
  if (!named && !/\b(?:use|apply|switch to|try|go with|change (?:it |the style )?to)\b/u.test(text)) {
    return null;
  }
  const squash = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const said = squash(text);
  const mine = /\bmy\b/u.test(text);
  const lookWord = (name: string) => FILTER_WORDS.some(([pattern]) => pattern.test(name.toLowerCase()));
  const hits = context.templates.filter((template) => squash(template.name).length >= 4 &&
    said.includes(squash(template.name)) &&
    // "Cinematic" is both a template and a colour look; only "template" decides.
    (named || /\s/u.test(template.name.trim()) || !lookWord(template.name)));
  if (!hits.length) return null;
  const preferred = mine ? hits.filter((template) => template.source === 'USER') : hits;
  return (preferred.length ? preferred : hits).sort((a, b) => b.name.length - a.name.length)[0];
}

/**
 * Parses a message into per-clause outcomes, or null when nothing in it is a
 * shape this layer knows (the caller then tries the legacy direct planner and,
 * ONLINE, the model).
 */
/** One clause of a request and exactly what the natural-language layer made of it. */
export type ClauseLedgerEntry = { clause: string; outcomes: ClauseOutcome[]; unparsed: boolean };

export function parseNaturalRequest(message: string, input: ChatContext,
  options: { maxIntents?: number; ledger?: ClauseLedgerEntry[] } = {}): NaturalPlan | null {
  const maxIntents = options.maxIntents ?? MAX_CHAT_INTENTS;
  // Later clauses are computed from the state earlier clauses leave behind:
  // "move the logo down and make it smaller" must shrink the MOVED logo.
  const context = workingCopy(input);
  const clauses = splitClauses(message.toLowerCase());
  const originals = splitClauses(message);
  // A timeline range is stronger grounding than the conversational active
  // target. Keep this legacy timeline shape in the direct planner below this
  // layer; otherwise "remove this part" can be mistaken for removing a stale
  // active zoom/effect before the range-cut planner sees it.
  if (input.selection.selectedTimeRange && clauses.length === 1 &&
    /\b(remove|cut|delete|drop|get rid of|take out)\b/u.test(clauses[0]) &&
    /\b(this|that|it|here|selection|selected|section|part|bit|range)\b/u.test(clauses[0])) {
    return null;
  }
  const outcomes: ClauseOutcome[] = [];
  const unparsed: string[] = [];
  if (clauses.length > maxIntents) {
    return { outcomes: [{ type: 'QUESTION', code: null, question: `That is ${clauses.length} ` +
      `changes at once. I can make up to ${maxIntents} direct changes per message - send ` +
      'them in smaller groups.' }], unparsed: [] };
  }
  let carry: Subject | null = null;
  let lastFollow: string | null = null;
  const parseClause = (clause: string, index: number) => {
    const original = originals[index] ?? clause;
    const template = namedTemplate(clause, context);
    if (template) { outcomes.push({ type: 'TEMPLATE', template }); return; }
    const subject = explicitSubject(clause, context);
    const adding = /^(?:please\s+|can you\s+|now\s+)*(?:add|insert|upload|place|put in|drop in|use)\b/u
      .test(clause);
    // Placing an uploaded file or a plain text block is the existing add path.
    if (adding && (['LOGO', 'IMAGE', 'MUSIC', 'TEXT'].includes(String(subject.role)) ||
      subject.kind === 'ELEMENT')) { unparsed.push(original); return; }
    if (adding && (subject.role === 'CTA' || (subject.role === 'HOOK' && literalContent(original)))) {
      const content = literalContent(original);
      if (!content) {
        outcomes.push({ type: 'QUESTION', code: null,
          question: 'What should the call to action say? For example: add a CTA saying "Follow for part 2".' });
        return;
      }
      const role = subject.role === 'CTA' ? 'CTA' : 'HOOK';
      const total = context.project.timelineDurationSec;
      const length = Math.min(3, total);
      outcomes.push({ type: 'COMMANDS', subject, followUp: null, warnings: [],
        summary: `Add a ${role === 'CTA' ? 'call to action' : 'hook'} reading "${content}".`,
        grounding: [{ type: 'CONTEXT', confidence: 0.95, evidence: 'Literal user-authored text.' }],
        commands: [
          { kind: 'ELEMENT', action: 'ADD_TEXT', ref: 'newtext', reason: 'Adds the text element.',
            parameters: { content, textStyleId: role, semanticRole: role, applyBox: true } },
          { kind: 'ELEMENT', action: 'SET_ELEMENT_TIMING', target: { kind: 'REF', ref: 'newtext' },
            reason: role === 'CTA' ? 'A call to action closes the video.' : 'A hook opens the video.',
            parameters: { startTime: r2(role === 'CTA' ? Math.max(0, total - length) : 0),
              duration: r2(length) } }
        ] });
      return;
    }
    const op = detectOp(clause, original, subject, context);
    if (!op) { unparsed.push(original); return; }
    if ((op.family === 'MORE' || op.family === 'LESS') && lastFollow === op.family) return;
    lastFollow = op.family === 'MORE' || op.family === 'LESS' ? op.family : null;

    if (op.family === 'ANOTHER') {
      const last = context.runtime.thread.lastProposal ?? context.runtime.thread.active;
      if (last?.task === 'HOOK_REWRITE' || subject.role === 'HOOK') {
        const hook = context.elements.find((view) => view.semantic === 'HOOK');
        outcomes.push({ type: 'HOOK', mode: 'ANOTHER', target: hook ?? null,
          summary: 'Try another hook.', subject });
        return;
      }
      outcomes.push({ type: 'QUESTION', code: null, question: 'Another what? I can offer ' +
        'alternatives for the hook - say "try another hook".' });
      return;
    }

    let resolvedOp: Op = op;
    let resolution: Resolution | null = null;
    if (op.family === 'MORE' || op.family === 'LESS') {
      const next = followUpOp(op.family, context);
      if ('question' in next) { outcomes.push({ type: 'QUESTION', code: null, question: next.question }); return; }
      resolvedOp = next;
      resolution = activeResolution(context) ??
        { code: 'NEEDS_TARGET', question: 'The thing I changed last is no longer on the timeline. ' +
          'Which element do you mean?' };
    }

    if (resolvedOp.family === 'HOOK') {
      const hooks = context.elements.filter((view) => view.semantic === 'HOOK');
      if (resolvedOp.mode !== 'NEW' && !hooks.length) {
        outcomes.push({ type: 'QUESTION', code: null, question: 'This video does not have an ' +
          'on-screen hook yet. Say "add a hook" and I will write one from the opening of the video.' });
        return;
      }
      if (hooks.length > 1) {
        const chosen = chooseAmong(hooks, 'HOOK', context);
        if ('question' in chosen) { outcomes.push({ type: 'QUESTION', code: chosen.code, question: chosen.question }); return; }
        outcomes.push({ type: 'HOOK', mode: resolvedOp.mode, target: chosen.views[0], summary: '', subject });
        return;
      }
      outcomes.push({ type: 'HOOK', mode: resolvedOp.mode, target: hooks[0] ?? null, summary: '', subject });
      carry = { kind: 'ROLE', role: 'HOOK', words: 'hook' };
      return;
    }

    const family = resolvedOp.family === 'CAPTIONS' ? 'TEXT_STYLE' : resolvedOp.family;
    if (!resolution) {
      if (resolvedOp.family === 'CAPTIONS' && ['GENERATE', 'REMOVE', 'SHOW', 'HIDE']
        .includes(resolvedOp.op)) {
        resolution = { views: [], aggregate: 'CAPTIONS', how: 'ROLE' };
      } else if (resolvedOp.family === 'CAPTIONS' && ['FIX', 'SPLIT', 'MERGE'].includes(resolvedOp.op)) {
        resolution = resolveTargets(subject.kind === 'CAPTIONS' ? { kind: 'CAPTION_ONE', words: '' }
          : subject, 'TEXT_STYLE', context, carry, clause);
      } else if (resolvedOp.family === 'ZOOM' && resolvedOp.mode === 'ADD') {
        const near = resolvedOp.phrase ? [] : zoomNearPlayhead(context);
        if (near.length) {
          resolvedOp = { family: 'ZOOM', mode: 'MORE', mag: resolvedOp.mag };
          resolution = { views: [near[0]], how: 'PLAYHEAD' };
        } else resolution = { views: [], how: 'NONE' };
      } else {
        resolution = resolveTargets(subject, family, context, carry, clause);
      }
    }
    if ('question' in resolution) {
      outcomes.push({ type: 'QUESTION', code: resolution.code, question: resolution.question });
      return;
    }
    const built = build(resolvedOp, resolution, context, clause);
    if ('question' in built) {
      outcomes.push({ type: 'QUESTION', code: built.code ?? null, question: built.question });
      return;
    }
    const how = resolution.how;
    simulate(context, built.commands);
    outcomes.push({ type: 'COMMANDS', commands: built.commands, summary: built.summary,
      warnings: built.warnings ?? [], followUp: built.followUp, subject,
      grounding: [{ type: how === 'SELECTED' ? 'SELECTION' : how === 'PLAYHEAD' ? 'PLAYHEAD'
        : 'CONTEXT', confidence: 0.95,
      evidence: `Target resolved by ${how.toLowerCase()} (${subject.kind.toLowerCase()} reference).` }] });
    if (subject.kind !== 'NONE' && subject.kind !== 'PRONOUN') carry = subject;
    else if (resolution.views[0]) {
      carry = { kind: 'ELEMENT', view: resolution.views[0], words: '' };
    }
  };
  clauses.forEach((clause, index) => {
    const outcomesBefore = outcomes.length;
    const unparsedBefore = unparsed.length;
    parseClause(clause, index);
    // The agent's instruction ledger: every clause is accounted for, in order.
    options.ledger?.push({ clause: originals[index] ?? clause,
      outcomes: outcomes.slice(outcomesBefore), unparsed: unparsed.length > unparsedBefore });
  });
  if (!outcomes.length) return null;
  return { outcomes, unparsed };
}
