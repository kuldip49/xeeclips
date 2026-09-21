// The deterministic chat planner.
//
// A large share of real editing requests are not semantic at all - "mute the
// music", "make it 9:16", "split here", "make the logo smaller". Those are
// parsed here, with no model involved, which makes them free, instant,
// reproducible, and available in FALLBACK_ONLY mode where no provider exists.
//
// This planner is deliberately conservative. It recognises a request or it
// returns null; it never stretches a pattern to cover a sentence it did not
// really understand. When it returns null the caller either asks a model (when
// one is configured) or tells the user plainly that the request needs AI mode.
//
// Because it can read the live context, it resolves its own targets and emits
// absolute values - a "20% smaller" request becomes the exact width the editor
// will store. It still produces the same ChatIntent the LLM path produces, so
// both go through identical validation, resolution and proposal machinery.

import type { ChatContext, ChatElementView } from './edit-chat-context';
import {
  type ChatCommand, type ChatGrounding, type ChatIntent, type ChatTarget, type ChatTargetRole
} from './edit-chat-commands';

const CERTAIN = 0.95;
const SELECTION_CONFIDENCE = 0.9;
/** Matches the canonical layer's own minimum VIDEO length. */
const MIN_SEGMENT_SEC = 0.05;

type Draft = { commands: ChatCommand[]; summary: string; grounding: ChatGrounding[];
  warnings?: string[] };

const intent = (draft: Draft): ChatIntent => ({
  intent: 'EDIT_PROJECT', summary: draft.summary, commands: draft.commands,
  grounding: draft.grounding, warnings: draft.warnings ?? [],
  needsClarification: false, clarificationQuestion: ''
});

const clarify = (question: string, summary = 'I need one more detail.'): ChatIntent => ({
  intent: 'NEEDS_CLARIFICATION', summary, commands: [], grounding: [], warnings: [],
  needsClarification: true, clarificationQuestion: question
});

const ground = (type: ChatGrounding['type'], confidence: number, evidence: string,
  range?: { startSec: number; endSec: number }): ChatGrounding =>
  ({ type, confidence, evidence, ...(range ?? {}) });

const clamp = (value: number, low: number, high: number) =>
  Number(Math.min(high, Math.max(low, value)).toFixed(4));

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30
};

/**
 * Rewrites spoken quantities as digits.
 *
 * People say "remove the first second" and "cut the last two seconds" far more
 * often than they type "3". Normalising here keeps every downstream pattern
 * numeric instead of duplicating word forms across a dozen regexes.
 */
function normalizeQuantities(text: string): string {
  return text
    // "the first second" / "the last second" carry an implied 1.
    .replace(/\b(first|last|opening|final)\s+(seconds?|secs?)\b/gu, '$1 1 $2')
    .replace(/\b([a-z]+)\s+(seconds?|secs?)\b/gu, (match, word: string, unit: string) =>
      NUMBER_WORDS[word] === undefined ? match : `${NUMBER_WORDS[word]} ${unit}`);
}

/** Seconds from "12", "12.5" or "1:05". */
const parseSeconds = (raw: string): number | null => {
  const clock = /^(\d{1,2}):(\d{2}(?:\.\d+)?)$/u.exec(raw.trim());
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
};

/** The role a phrase names, if it names one unambiguously. */
function roleFromPhrase(text: string): ChatTargetRole | null {
  if (/\blogos?\b/u.test(text)) return 'LOGO';
  if (/\b(music|soundtrack|background (?:audio|track)|audio track|song)\b/u.test(text)) return 'MUSIC';
  if (/\b(subtitles?|captions?)\b/u.test(text)) return 'SUBTITLE';
  if (/\b(text|title|headline|words)\b/u.test(text)) return 'TEXT';
  if (/\b(image|picture|photo|graphic)\b/u.test(text)) return 'IMAGE';
  return null;
}

/**
 * The element a sentence is pointing at, resolved against the live context.
 *
 * A named role wins over a pronoun. A bare "it"/"this" resolves to the
 * selection when there is one and otherwise to the element the previous turn
 * touched. Returning null means the reference was genuinely ambiguous, and the
 * caller turns that into a question rather than picking something.
 */
function resolveSubject(text: string, context: ChatContext):
  { element?: ChatElementView; ambiguous?: string } {
  const role = roleFromPhrase(text);
  if (role) {
    const matches = context.elements.filter((element) => element.role === role);
    if (!matches.length) return { ambiguous: `There is no ${role.toLowerCase()} on the timeline yet.` };
    if (matches.length > 1) {
      const selected = matches.find((element) => element.selected);
      if (selected) return { element: selected };
      return { ambiguous: `There are ${matches.length} of those (${matches
        .map((element) => element.label).join(', ')}). Which one do you mean?` };
    }
    return { element: matches[0] };
  }
  const selectedHandle = context.selection.selectedElementHandle;
  if (selectedHandle) {
    const selected = context.elements.find((element) => element.handle === selectedHandle);
    if (selected) return { element: selected };
  }
  const recent = context.recent.lastAffectedHandles[0];
  if (recent) {
    const last = context.elements.find((element) => element.handle === recent);
    if (last) return { element: last };
  }
  return {};
}

const AMBIGUOUS_TARGET = 'Which element do you mean? Select it on the timeline or preview ' +
  'first, or name it (for example "the logo", "the text" or "the music").';

const handleTarget = (element: ChatElementView): ChatTarget =>
  ({ kind: 'ELEMENT', handle: element.handle });

/**
 * Keeps overlays inside a timeline that just got shorter.
 *
 * The canonical validator refuses an overlay that runs past the end of the
 * video, and rightly so - after a cut, a logo that covered the whole clip no
 * longer fits. Rather than let the apply fail, the plan states the consequence
 * up front: each affected overlay gets an explicit timing command, and each one
 * appears as its own line in the preview, so shortening is never silent.
 */
function refitOverlays(context: ChatContext, newDurationSec: number): ChatCommand[] {
  return context.elements.flatMap((element): ChatCommand[] => {
    if (element.role === 'VIDEO') return [];
    if (element.endSec <= newDurationSec + 1e-6) return [];
    const room = Number((newDurationSec - element.startSec).toFixed(3));
    if (room < MIN_SEGMENT_SEC) {
      return [{ kind: 'ELEMENT', action: 'REMOVE_ELEMENT', target: handleTarget(element),
        parameters: {},
        reason: 'The cut leaves no room on the timeline for this overlay.' }];
    }
    return [{ kind: 'ELEMENT', action: 'SET_ELEMENT_TIMING', target: handleTarget(element),
      parameters: { startTime: element.startSec, duration: room,
        ...(element.role === 'MUSIC'
          ? { trimStart: element.trimStartSec, trimEnd: element.trimStartSec + room } : {}) },
      reason: 'Shortened to stay inside the trimmed timeline.' }];
  });
}

/**
 * The command sequence that removes a timeline range.
 *
 * Which commands are needed depends entirely on where the range sits. Removing
 * an edge of a segment is a trim; removing a whole segment is a delete; and
 * removing something out of the middle genuinely needs two splits and a delete.
 * The splits address the timeline by TIME rather than by element id, because
 * each split changes which element covers a given second - those targets are
 * resolved step by step as the bundle executes.
 */
function cutRangeCommands(context: ChatContext, startSec: number, endSec: number):
  { commands: ChatCommand[] } | { question: string } {
  const segment = context.elements.find((element) => element.role === 'VIDEO' &&
    startSec >= element.startSec - 1e-6 && startSec < element.endSec - 1e-6);
  if (!segment) return { question: `There is no video at ${startSec.toFixed(1)}s.` };
  if (endSec > segment.endSec + 1e-6) {
    return { question: `That range crosses a cut at ${segment.endSec.toFixed(1)}s. ` +
      'Remove it one segment at a time, or tell me the exact segment.' };
  }
  const atStart = startSec <= segment.startSec + 1e-6;
  const atEnd = endSec >= segment.endSec - 1e-6;
  const trimStart = segment.trimStartSec;
  const trimEnd = segment.trimEndSec ?? trimStart + (segment.endSec - segment.startSec);
  const reason = `Removes ${startSec.toFixed(1)}s–${endSec.toFixed(1)}s.`;
  // Every branch below shortens the timeline by exactly this much, so overlays
  // are refitted against the length the cut will leave behind.
  //
  // The refit runs FIRST, and that ordering is load-bearing: the canonical
  // layer validates after every single command, so shrinking the overlays while
  // the timeline is still long is valid at each step, whereas cutting first
  // would momentarily leave an overlay hanging past the end and be refused.
  const refit = refitOverlays(context, context.project.timelineDurationSec - (endSec - startSec));

  if (atStart && atEnd) {
    return { commands: [...refit, { kind: 'ELEMENT', action: 'DELETE_ELEMENT',
      target: handleTarget(segment), parameters: {}, reason }] };
  }
  if (atStart) {
    const nextTrimStart = Number((trimStart + (endSec - segment.startSec)).toFixed(6));
    if (trimEnd - nextTrimStart < MIN_SEGMENT_SEC) {
      return { question: 'That would leave nothing of this segment. Should I delete it instead?' };
    }
    return { commands: [...refit, { kind: 'ELEMENT', action: 'TRIM_ELEMENT',
      target: handleTarget(segment),
      parameters: { trimStart: nextTrimStart, trimEnd }, reason }] };
  }
  if (atEnd) {
    const nextTrimEnd = Number((trimStart + (startSec - segment.startSec)).toFixed(6));
    if (nextTrimEnd - trimStart < MIN_SEGMENT_SEC) {
      return { question: 'That would leave nothing of this segment. Should I delete it instead?' };
    }
    return { commands: [...refit, { kind: 'ELEMENT', action: 'TRIM_ELEMENT',
      target: handleTarget(segment),
      parameters: { trimStart, trimEnd: nextTrimEnd }, reason }] };
  }
  // Interior range: split either side of it, then delete the piece between.
  return { commands: [
    ...refit,
    { kind: 'ELEMENT', action: 'SPLIT_ELEMENT', target: { kind: 'AT_TIME', atSec: startSec },
      parameters: { playheadSec: startSec }, reason: `Splits at ${startSec.toFixed(1)}s.` },
    { kind: 'ELEMENT', action: 'SPLIT_ELEMENT', target: { kind: 'AT_TIME', atSec: endSec },
      parameters: { playheadSec: endSec }, reason: `Splits at ${endSec.toFixed(1)}s.` },
    { kind: 'ELEMENT', action: 'DELETE_ELEMENT',
      target: { kind: 'AT_TIME', atSec: Number(((startSec + endSec) / 2).toFixed(6)) },
      parameters: {}, reason }
  ] };
}

/**
 * Parses a request, or returns null when it is not a shape this planner knows.
 *
 * Order matters: the most specific patterns are tried first so that "lower the
 * music" is an audio command rather than a generic "move it lower".
 */
export function planDeterministicChat(message: string, context: ChatContext): ChatIntent | null {
  const text = normalizeQuantities(message.toLowerCase().trim());
  if (!text) return null;
  const style = context.project.style;
  const duration = context.project.timelineDurationSec;

  // --- Project style -------------------------------------------------------

  const aspect = /\b(9\s*[:x]\s*16|16\s*[:x]\s*9|1\s*[:x]\s*1|vertical|portrait|horizontal|landscape|square)\b/u.exec(text);
  if (aspect && /\b(make|set|change|switch|use|convert|export|format|ratio|aspect)\b/u.test(text)) {
    const token = aspect[1].replace(/\s/gu, '');
    const aspectRatio = /9[:x]16|vertical|portrait/u.test(token) ? '9:16'
      : /16[:x]9|horizontal|landscape/u.test(token) ? '16:9' : '1:1';
    return intent({
      summary: `Switch the project to ${aspectRatio}.`,
      commands: [{ kind: 'SETTINGS', action: 'SET_ASPECT_RATIO',
        parameters: { aspectRatio }, reason: 'The request names an output shape.' }],
      grounding: [ground('CONTEXT', CERTAIN, `Requested aspect ratio ${aspectRatio}.`)]
    });
  }

  if (/\b(subtitles?|captions?)\b/u.test(text) &&
    /\b(on|off|enable|disable|turn|add|remove|show|hide)\b/u.test(text)) {
    const off = /\b(off|disable|remove|hide|no)\b/u.test(text);
    return intent({
      summary: off ? 'Turn subtitles off.' : 'Turn subtitles on.',
      commands: [{ kind: 'SETTINGS', action: 'SET_SUBTITLE_POLICY',
        parameters: { subtitlePolicy: off ? 'OFF' : 'ALWAYS' },
        reason: 'The request sets the caption policy.' }],
      grounding: [ground('CONTEXT', CERTAIN, `Subtitle policy ${off ? 'OFF' : 'ALWAYS'}.`)],
      warnings: off || context.project.hasTranscript ? []
        : ['This source has not been analysed yet, so captions can only appear after you run ' +
          '"Analyze source".']
    });
  }

  const grade = /\b(no|none|subtle|clean|warm|contrast|contrasty)\s+(?:colou?r\s+)?(?:grading|grade|look)\b/u
    .exec(text) ?? /\b(?:grading|grade|colou?r)\b.*?\b(none|subtle|clean|warm|contrast)\b/u.exec(text);
  if (grade) {
    const word = grade[1];
    const gradingPolicy = word === 'no' || word === 'none' ? 'NONE'
      : word === 'contrasty' ? 'CONTRAST' : word.toUpperCase() as 'SUBTLE';
    return intent({
      summary: `Use ${gradingPolicy.toLowerCase()} colour grading.`,
      commands: [{ kind: 'SETTINGS', action: 'SET_COLOR_GRADE',
        parameters: { gradingPolicy }, reason: 'The request names a grading look.' }],
      grounding: [ground('CONTEXT', CERTAIN, `Grading ${gradingPolicy}.`)]
    });
  }

  if (/\bzoom\b/u.test(text)) {
    const level = /\b(no|off|none|subtle|slight|gentle|moderate|medium|strong|heavy)\b/u.exec(text);
    if (level) {
      const word = level[1];
      const zoomPolicy = ['no', 'off', 'none'].includes(word) ? 'OFF'
        : ['subtle', 'slight', 'gentle'].includes(word) ? 'SUBTLE'
          : ['moderate', 'medium'].includes(word) ? 'MODERATE' : 'STRONG';
      return intent({
        summary: `Set automatic zoom to ${zoomPolicy.toLowerCase()}.`,
        commands: [{ kind: 'SETTINGS', action: 'SET_AUTO_ZOOM',
          parameters: { zoomPolicy }, reason: 'The request names a zoom intensity.' }],
        grounding: [ground('CONTEXT', CERTAIN, `Zoom policy ${zoomPolicy}.`)]
      });
    }
  }

  // "don't crop the slide" / "keep both people visible" - framing intent.
  if (/\b(do\s?n'?t|dont|never|avoid|stop)\b.*\bcrop\b/u.test(text) ||
    /\b(keep|preserve|protect)\b.*\b(slide|chart|graph|diagram|screen|document|whiteboard)\b/u.test(text)) {
    return intent({
      summary: 'Protect on-screen information when reframing.',
      commands: [{ kind: 'SETTINGS', action: 'SET_AUTO_REFRAME',
        parameters: { reframePolicy: 'INFORMATION_PRESERVING' },
        reason: 'The request asks for readable on-screen information.' }],
      grounding: [ground(context.analysis.available ? 'ANALYSIS' : 'CONTEXT',
        context.analysis.available ? 0.85 : 0.7,
        context.analysis.hasInformationRegion
          ? 'The cached analysis found a protected information region in this source.'
          : 'Reframing set to information-preserving.')]
    });
  }
  if (/\b(keep|show)\b.*\bboth\b.*\b(people|speakers|faces|persons)\b/u.test(text)) {
    return intent({
      summary: 'Keep both speakers framed.',
      commands: [{ kind: 'SETTINGS', action: 'SET_AUTO_REFRAME',
        parameters: { reframePolicy: 'FACE_FOCUSED' },
        reason: 'The request asks to keep the speakers visible.' }],
      grounding: [ground(context.analysis.available ? 'ANALYSIS' : 'CONTEXT', 0.8,
        `Pair framing present in ${Math.round(context.analysis.pairShotRatio * 100)}% of shots.`)]
    });
  }

  if (/\b(remove|delete|drop|no|get rid of|clear)\b.*\bhook\b/u.test(text)) {
    return intent({
      summary: 'Remove the on-screen hook.',
      commands: [{ kind: 'SETTINGS', action: 'SET_HOOK',
        parameters: { hookText: null, hookPolicy: 'OFF' },
        reason: 'The request removes the headline.' }],
      grounding: [ground('CONTEXT', CERTAIN,
        style.hookText ? `Current hook: "${style.hookText}".` : 'No hook is currently set.')]
    });
  }

  // --- Audio ---------------------------------------------------------------

  const audioSubject = /\b(music|soundtrack|song|audio|background (?:audio|track))\b/u.test(text);
  if (audioSubject && /\b(mute|silence|unmute)\b/u.test(text)) {
    const subject = resolveSubject('music', context);
    if (subject.ambiguous) return clarify(subject.ambiguous);
    if (!subject.element) return clarify('There is no audio track on the timeline yet.');
    const muted = !/\bunmute\b/u.test(text);
    return intent({
      summary: muted ? 'Mute the background audio.' : 'Unmute the background audio.',
      commands: [{ kind: 'ELEMENT', action: 'SET_AUDIO_MUTED',
        target: handleTarget(subject.element), parameters: { muted },
        reason: 'The request mutes the audio element.' }],
      grounding: [ground('CONTEXT', CERTAIN, `Targets ${subject.element.label}.`)]
    });
  }
  if (audioSubject && /\bfade\b/u.test(text)) {
    const subject = resolveSubject('music', context);
    if (subject.ambiguous) return clarify(subject.ambiguous);
    if (!subject.element) return clarify('There is no audio track on the timeline yet.');
    const amount = /(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/u.exec(text);
    const span = amount ? Number(amount[1]) : 2;
    const fadeOut = /\bout\b/u.test(text);
    const fadeIn = /\bin\b/u.test(text) || !fadeOut;
    const length = Math.min(span, Math.max(0,
      (subject.element.endSec - subject.element.startSec) / (fadeIn && fadeOut ? 2 : 1)));
    return intent({
      summary: `Fade the audio ${fadeIn && fadeOut ? 'in and out' : fadeIn ? 'in' : 'out'} over ${
        length.toFixed(1)}s.`,
      commands: [{ kind: 'ELEMENT', action: 'SET_AUDIO_FADE',
        target: handleTarget(subject.element),
        parameters: { fadeInSec: fadeIn ? length : 0, fadeOutSec: fadeOut ? length : 0 },
        reason: 'The request sets audio fades.' }],
      grounding: [ground('CONTEXT', CERTAIN, `Fade length ${length.toFixed(1)}s.`)]
    });
  }
  if (audioSubject &&
    /\b(lower|quieter|quiet|reduce|turn down|softer|louder|turn up|raise|volume)\b/u.test(text)) {
    const subject = resolveSubject('music', context);
    if (subject.ambiguous) return clarify(subject.ambiguous);
    if (!subject.element) return clarify('There is no audio track on the timeline yet.');
    const current = Number(subject.element.properties.volume ?? 0.25);
    const explicit = /(\d{1,3})\s*%/u.exec(text);
    const louder = /\b(louder|turn up|raise|increase)\b/u.test(text);
    const volume = explicit ? clamp(Number(explicit[1]) / 100, 0, 1)
      : clamp(current * (louder ? 1.5 : 0.5), 0.02, 1);
    return intent({
      summary: `Set the background audio to ${Math.round(volume * 100)}%.`,
      commands: [{ kind: 'ELEMENT', action: 'SET_AUDIO_VOLUME',
        target: handleTarget(subject.element), parameters: { volume },
        reason: 'The request changes audio loudness.' }],
      grounding: [ground('CONTEXT', CERTAIN, `Was ${Math.round(current * 100)}%, requested ${
        louder ? 'louder' : 'quieter'}.`)]
    });
  }

  // --- Video timeline ------------------------------------------------------

  // "remove the first 3 seconds" / "cut the last 2 seconds"
  const edge = /\b(?:remove|cut|trim|drop|delete|chop|take)\b[^.]*?\b(first|last|opening|final|beginning|end)\b[^.]*?(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/u
    .exec(text);
  if (edge) {
    const fromStart = /first|opening|beginning/u.test(edge[1]);
    const amount = Number(edge[2]);
    if (amount <= 0) return clarify('How many seconds should I remove?');
    const cut = fromStart
      ? cutRangeCommands(context, 0, amount)
      : cutRangeCommands(context, Math.max(0, duration - amount), duration);
    if ('question' in cut) return clarify(cut.question);
    return intent({
      summary: `Remove the ${fromStart ? 'first' : 'last'} ${amount}s.`,
      commands: cut.commands,
      grounding: [ground('TIMESTAMP', CERTAIN,
        `${fromStart ? 'Leading' : 'Trailing'} ${amount}s of a ${duration.toFixed(1)}s timeline.`,
        fromStart ? { startSec: 0, endSec: amount }
          : { startSec: Math.max(0, duration - amount), endSec: duration })]
    });
  }

  // "cut from 12 to 17 seconds"
  const range = /\b(?:cut|trim|remove|delete|drop)\b[^.]*?\b(?:from\s+)?(\d{1,2}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)?\s*(?:to|-|–|until|through)\s*(\d{1,2}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)?\b/u
    .exec(text);
  if (range) {
    const start = parseSeconds(range[1]);
    const end = parseSeconds(range[2]);
    if (start == null || end == null || end <= start) {
      return clarify('I could not read that time range. Which seconds should I cut, for ' +
        'example "cut from 12 to 17 seconds"?');
    }
    if (end > duration + 1e-6) {
      return clarify(`This video is ${duration.toFixed(1)}s long, so ${end.toFixed(1)}s is past ` +
        'the end. Which range did you mean?');
    }
    const cut = cutRangeCommands(context, start, end);
    if ('question' in cut) return clarify(cut.question);
    return intent({
      summary: `Remove ${start.toFixed(1)}s–${end.toFixed(1)}s.`,
      commands: cut.commands,
      grounding: [ground('TIMESTAMP', CERTAIN,
        `Explicit range ${start.toFixed(1)}s–${end.toFixed(1)}s.`, { startSec: start, endSec: end })]
    });
  }

  // "split here" / "split at 12 seconds"
  if (/\bsplit\b|\bdivide\b/u.test(text)) {
    const at = /\bat\s+(\d{1,2}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)?\b/u.exec(text);
    const atSec = at ? parseSeconds(at[1]) : context.selection.playheadSec;
    if (atSec == null) return clarify('Where should I split - at the playhead, or at a time?');
    if (atSec > duration + 1e-6) {
      return clarify(`This video is ${duration.toFixed(1)}s long, so there is nothing at ${
        atSec.toFixed(1)}s.`);
    }
    return intent({
      summary: `Split the video at ${atSec.toFixed(1)}s.`,
      commands: [{ kind: 'ELEMENT', action: 'SPLIT_ELEMENT',
        target: { kind: 'AT_TIME', atSec }, parameters: { playheadSec: atSec },
        reason: 'The request splits at a timeline position.' }],
      grounding: [ground(at ? 'TIMESTAMP' : 'PLAYHEAD', CERTAIN,
        at ? `Explicit split at ${atSec.toFixed(1)}s.`
          : `Playhead at ${atSec.toFixed(1)}s.`)]
    });
  }

  // --- Overlays ------------------------------------------------------------

  // "add text saying Subscribe"
  const addText = /\badd\b[^.]*?\b(?:text|caption|title)\b[^.]*?(?:saying|that says|reading|with the words)\s*["“']?([^"”']{1,120})["”']?\s*$/iu
    .exec(message.trim());
  if (addText) {
    const content = addText[1].trim().replace(/[.!?]*$/u, '');
    return intent({
      summary: `Add a text overlay reading "${content}".`,
      commands: [
        { kind: 'ELEMENT', action: 'ADD_TEXT', ref: 'newtext', parameters: {},
          reason: 'The request adds an on-screen text element.' },
        { kind: 'ELEMENT', action: 'UPDATE_TEXT', target: { kind: 'REF', ref: 'newtext' },
          parameters: { content }, reason: 'The request supplies the exact wording.' }
      ],
      grounding: [ground('CONTEXT', CERTAIN, `Literal user-authored text: "${content}".`)]
    });
  }
  if (/\badd\b[^.]*\btext\b/u.test(text) && !/saying|says|reading/u.test(text)) {
    return intent({
      summary: 'Add a text overlay.',
      commands: [{ kind: 'ELEMENT', action: 'ADD_TEXT', parameters: {},
        reason: 'The request adds a text element to fill in.' }],
      grounding: [ground('CONTEXT', 0.8, 'No wording supplied; a default text block is added.')],
      warnings: ['No wording was given, so the text is added with placeholder content.']
    });
  }

  // "add my logo top right" / "use product.png at 12 seconds for 4 seconds"
  if (/\b(?:add|use|place|put|show|insert|overlay|start)\b/u.test(text) && !/\btext\b/u.test(text)) {
    const named = context.assets.find((asset) =>
      asset.role !== 'SOURCE' && asset.role !== 'EXPORT' &&
      text.includes(asset.filename.toLowerCase()));
    const wantsLogo = /\blogos?\b/u.test(text);
    const wantsAudio = /\b(music|song|soundtrack|audio track|background audio)\b/u.test(text);
    const wantsImage = /\b(image|picture|photo|graphic)\b/u.test(text);
    if (named || wantsLogo || wantsAudio || wantsImage) {
      const role = named ? named.role : wantsLogo ? 'LOGO' : wantsAudio ? 'AUDIO' : 'IMAGE';
      const candidates = named ? [named] : context.assets.filter((asset) => asset.role === role);
      if (!candidates.length) {
        return clarify(`There is no ${role.toLowerCase()} uploaded in this project yet. ` +
          `Upload one first, then ask me again.`);
      }
      if (candidates.length > 1) {
        return clarify(`You have ${candidates.length} ${role.toLowerCase()} files (${candidates
          .map((asset) => asset.filename).join(', ')}). Which one should I use?`);
      }
      const asset = candidates[0];
      const action = role === 'AUDIO' ? 'ADD_AUDIO' : role === 'LOGO' ? 'ADD_LOGO' : 'ADD_IMAGE';
      const commands: ChatCommand[] = [{ kind: 'ELEMENT', action, ref: 'newasset',
        assetHandle: asset.handle, parameters: {},
        reason: `The request places the uploaded ${role.toLowerCase()}.` }];
      const corner = /\b(top|bottom)[\s-]*(left|right)\b/u.exec(text);
      if (corner && role !== 'AUDIO') {
        commands.push({ kind: 'ELEMENT', action: 'MOVE_ELEMENT',
          target: { kind: 'REF', ref: 'newasset' },
          parameters: { x: corner[2] === 'right' ? 0.76 : 0.04,
            y: corner[1] === 'bottom' ? 0.82 : 0.04 },
          reason: `The request places it ${corner[1]} ${corner[2]}.` });
      }
      const at = /\b(?:at|from|here at)\s+(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\b/u.exec(text);
      const forSpan = /\bfor\s+(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\b/u.exec(text);
      const toSpan = /\bto\s+(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\b/u.exec(text);
      const here = /\bhere\b/u.test(text) && !at;
      if (at || forSpan || toSpan || here) {
        const startTime = at ? Number(at[1]) : here ? context.selection.playheadSec : 0;
        const length = forSpan ? Number(forSpan[1])
          : toSpan ? Math.max(0.5, Number(toSpan[1]) - startTime)
            : Math.max(0.5, duration - startTime);
        commands.push({ kind: 'ELEMENT', action: 'SET_ELEMENT_TIMING',
          target: { kind: 'REF', ref: 'newasset' },
          parameters: { startTime, duration: length },
          reason: 'The request gives an explicit on-screen window.' });
      }
      return intent({
        summary: `Add ${asset.filename} to the video.`,
        commands,
        grounding: [ground('ASSET', CERTAIN, `Matched uploaded asset "${asset.filename}".`),
          ...(here ? [ground('PLAYHEAD', CERTAIN,
            `Playhead at ${context.selection.playheadSec.toFixed(1)}s.`)] : [])]
      });
    }
  }

  // --- Transform on an existing element ------------------------------------

  const smaller = /\b(smaller|shrink|reduce|tinier|scale down)\b/u.test(text);
  const bigger = /\b(bigger|larger|grow|enlarge|scale up)\b/u.test(text);
  if (smaller || bigger) {
    const subject = resolveSubject(text, context);
    if (subject.ambiguous) return clarify(subject.ambiguous);
    if (!subject.element) return clarify(AMBIGUOUS_TARGET);
    const element = subject.element;
    if (element.role === 'VIDEO' || element.role === 'MUSIC') {
      return clarify(`I can resize overlays, but not ${element.label.toLowerCase()}. ` +
        'Which overlay did you mean?');
    }
    const explicit = /(\d{1,3})\s*%/u.exec(text);
    const factor = explicit
      ? (smaller ? 1 - Number(explicit[1]) / 100 : 1 + Number(explicit[1]) / 100)
      : smaller ? 0.8 : 1.25;
    const width = Number(element.properties.width ?? 0.2);
    const height = Number(element.properties.height ?? 0.2);
    const x = Number(element.properties.x ?? 0);
    const y = Number(element.properties.y ?? 0);
    return intent({
      summary: smaller ? `Make ${element.label.toLowerCase()} smaller.`
        : `Make ${element.label.toLowerCase()} bigger.`,
      commands: [{ kind: 'ELEMENT', action: 'RESIZE_ELEMENT', target: handleTarget(element),
        parameters: { width: clamp(width * factor, 0.02, 1 - x),
          height: clamp(height * factor, 0.02, 1 - y) },
        reason: `Scales ${element.label.toLowerCase()} by ${factor.toFixed(2)}.` }],
      grounding: [ground(element.selected ? 'SELECTION' : 'CONTEXT', SELECTION_CONFIDENCE,
        `${element.label} is ${Math.round(width * 100)}% wide; scaling by ${factor.toFixed(2)}.`)]
    });
  }

  if (/\b(move|nudge|shift|push|raise|lower)\b/u.test(text) &&
    /\b(up|down|left|right|lower|higher|top|bottom)\b/u.test(text) && !audioSubject) {
    const subject = resolveSubject(text, context);
    if (subject.ambiguous) return clarify(subject.ambiguous);
    if (!subject.element) return clarify(AMBIGUOUS_TARGET);
    const element = subject.element;
    if (element.role === 'VIDEO' || element.role === 'MUSIC') {
      return clarify(`I can reposition overlays, but not ${element.label.toLowerCase()}.`);
    }
    const step = /\b(a little|slightly|a bit|little|small)\b/u.test(text) ? 0.05 : 0.12;
    let dx = 0; let dy = 0;
    if (/\b(down|lower|bottom)\b/u.test(text)) dy = step;
    if (/\b(up|higher|top|raise)\b/u.test(text)) dy = -step;
    if (/\bright\b/u.test(text)) dx = step;
    if (/\bleft\b/u.test(text)) dx = -step;
    if (!dx && !dy) return null;
    const width = Number(element.properties.width ?? 0.2);
    const height = Number(element.properties.height ?? 0.2);
    return intent({
      summary: `Move ${element.label.toLowerCase()} on screen.`,
      commands: [{ kind: 'ELEMENT', action: 'MOVE_ELEMENT', target: handleTarget(element),
        parameters: { x: clamp(Number(element.properties.x ?? 0) + dx, 0, 1 - width),
          y: clamp(Number(element.properties.y ?? 0) + dy, 0, 1 - height) },
        reason: 'The request nudges the element.' }],
      grounding: [ground(element.selected ? 'SELECTION' : 'CONTEXT', SELECTION_CONFIDENCE,
        `Moves ${element.label} by ${Math.round(step * 100)}% of the frame.`)]
    });
  }

  if (/\b(transparent|opacity|opaque|see.?through)\b/u.test(text) && !audioSubject) {
    const subject = resolveSubject(text, context);
    if (subject.ambiguous) return clarify(subject.ambiguous);
    if (!subject.element) return clarify(AMBIGUOUS_TARGET);
    const explicit = /(\d{1,3})\s*%/u.exec(text);
    const more = /\b(more transparent|fainter|lighter|less opaque|see.?through)\b/u.test(text);
    const current = Number(subject.element.properties.opacity ?? 1);
    const opacity = explicit ? clamp(Number(explicit[1]) / 100, 0, 1)
      : more ? clamp(current * 0.6, 0.05, 1) : 1;
    return intent({
      summary: `Set ${subject.element.label.toLowerCase()} opacity to ${
        Math.round(opacity * 100)}%.`,
      commands: [{ kind: 'ELEMENT', action: 'SET_ELEMENT_OPACITY',
        target: handleTarget(subject.element), parameters: { opacity },
        reason: 'The request changes transparency.' }],
      grounding: [ground(subject.element.selected ? 'SELECTION' : 'CONTEXT',
        SELECTION_CONFIDENCE, `Opacity ${Math.round(current * 100)}% to ${
          Math.round(opacity * 100)}%.`)]
    });
  }

  if (/\b(bring|send|move|put)\b.*\b(front|forward|back|behind|top layer)\b/u.test(text)) {
    const subject = resolveSubject(text, context);
    if (subject.ambiguous) return clarify(subject.ambiguous);
    if (!subject.element) return clarify(AMBIGUOUS_TARGET);
    const toFront = /\b(front|forward|top)\b/u.test(text);
    return intent({
      summary: toFront ? `Bring ${subject.element.label.toLowerCase()} to the front.`
        : `Send ${subject.element.label.toLowerCase()} behind the other overlays.`,
      commands: [{ kind: 'ELEMENT', action: 'SET_ELEMENT_Z_INDEX',
        target: handleTarget(subject.element), parameters: { zIndex: toFront ? 90 : 5 },
        reason: 'The request changes stacking order.' }],
      grounding: [ground(subject.element.selected ? 'SELECTION' : 'CONTEXT', SELECTION_CONFIDENCE,
        toFront ? 'Raised above other overlays.' : 'Lowered behind other overlays.')]
    });
  }

  // "change the text to X"
  const retext = /\b(?:change|set|make|update|rewrite)\b[^.]*?\btext\b[^.]*?(?:to say|to read|to)\s*["“']?([^"”']{1,200})["”']?\s*$/iu
    .exec(message.trim());
  if (retext) {
    const subject = resolveSubject('text', context);
    if (subject.ambiguous) return clarify(subject.ambiguous);
    if (!subject.element) return clarify('There is no text overlay to change yet.');
    return intent({
      summary: `Change the text to "${retext[1].trim()}".`,
      commands: [{ kind: 'ELEMENT', action: 'UPDATE_TEXT',
        target: handleTarget(subject.element), parameters: { content: retext[1].trim() },
        reason: 'The user supplied the exact wording.' }],
      grounding: [ground('CONTEXT', CERTAIN, 'Literal user-authored text.')]
    });
  }

  // --- Delete / remove -----------------------------------------------------

  if (/\b(delete|remove|get rid of|take out|erase)\b/u.test(text)) {
    // A semantic removal ("remove the part about pricing") is transcript work,
    // which this planner does not attempt. Fall through to the model.
    if (/\b(part|section|bit|segment|where|about|when)\b/u.test(text)) {
      if (!context.transcript.available) {
        return clarify('This source has not been analysed yet, so I cannot find that section. ' +
          'Run "Analyze source" first, or give me the seconds to cut.');
      }
      return null;
    }
    const subject = resolveSubject(text, context);
    if (subject.ambiguous) return clarify(subject.ambiguous);
    if (!subject.element) return clarify(AMBIGUOUS_TARGET);
    const element = subject.element;
    const isVideo = element.role === 'VIDEO';
    return intent({
      summary: `Remove ${element.label.toLowerCase()}.`,
      commands: [{ kind: 'ELEMENT', action: isVideo ? 'DELETE_ELEMENT' : 'REMOVE_ELEMENT',
        target: handleTarget(element), parameters: {},
        reason: 'The request removes an element.' }],
      grounding: [ground(element.selected ? 'SELECTION' : 'CONTEXT', CERTAIN,
        isVideo ? 'Removes a video segment and closes the gap.' : 'Removes an overlay.')]
    });
  }

  return null;
}

/**
 * The FALLBACK_ONLY answer for a request this planner could not parse.
 *
 * Deliberately blunt: in fallback mode there is no language understanding
 * available, so the honest response is to say what is missing and offer the
 * concrete phrasings that do work - never a speculative edit.
 */
export function fallbackUnsupported(context: ChatContext): ChatIntent {
  const semantic = context.transcript.available;
  return {
    intent: 'UNSUPPORTED',
    summary: 'I cannot plan that request in this mode.',
    commands: [],
    grounding: [],
    warnings: [semantic
      ? 'Requests phrased by meaning - "the part where I talk about pricing" - need ONLINE or ' +
        'OFFLINE AI mode. Direct instructions still work here.'
      : 'No AI provider is configured for this mode, so only direct instructions are available.'],
    needsClarification: true,
    clarificationQuestion: 'I can still do direct edits - for example "remove the first 3 ' +
      'seconds", "cut from 12 to 17 seconds", "split here", "mute the music", "make the logo ' +
      'smaller" or "make it 9:16". Which would you like?'
  };
}
