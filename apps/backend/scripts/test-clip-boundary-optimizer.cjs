require('reflect-metadata');
const assert = require('node:assert/strict');
const { optimizeClipBoundaries } = require('../dist/modules/processing/clip-boundary-optimizer');
const { MIN_CLIP_DURATION_SECONDS } = require('../dist/modules/processing/clip-candidates');

function wordsFor(text, start, wordDuration = 0.3, gap = 0.05) {
  const tokens = text.split(/\s+/u);
  let t = start;
  return tokens.map((token) => {
    const word = { start: t, end: t + wordDuration, text: token };
    t += wordDuration + gap;
    return word;
  });
}

// A long, realistic filler run followed by a substantive clause, padded well past the
// 15s minimum so trimming a couple of seconds off either edge still leaves a valid clip.
const LONG_TEXT = 'So the government knew this would happen and did nothing about it for ' +
  'years while people kept asking questions that nobody in charge wanted to answer honestly.';
// Long enough on its own (well over MIN_CLIP_DURATION_SECONDS of spoken content at the
// fixture word rate) that trimming trailing dead air still clears the minimum duration.
const VERY_LONG_TEXT = LONG_TEXT + ' ' + 'The full story took years to come out because ' +
  'nobody wanted to be the one who admitted what everybody already suspected was true.';

function main() {
  // 1) Leading filler is trimmed to the first substantive word.
  {
    const words = wordsFor(LONG_TEXT, 100);
    const candidate = { startTime: 100, endTime: words[words.length - 1].end + 12,
      transcriptText: LONG_TEXT };
    assert.ok(candidate.endTime - candidate.startTime >= MIN_CLIP_DURATION_SECONDS + 3,
      'test fixture must start well above the minimum duration');
    const result = optimizeClipBoundaries(candidate, words);
    assert.ok(result.startTime > candidate.startTime, 'filler opener must be trimmed');
    assert.equal(result.startTime, words[1].start, 'must snap exactly to the next word start');
    assert.ok(!/^so\b/iu.test(result.transcriptText));
    assert.ok(result.leadingTrimmedMs > 0);
  }

  // 2) A strong, non-filler opener is left untouched.
  {
    const text = LONG_TEXT.replace(/^So the /u, 'The ');
    const words = wordsFor(text, 50);
    const candidate = { startTime: 50, endTime: words[words.length - 1].end + 12, transcriptText: text };
    const result = optimizeClipBoundaries(candidate, words);
    assert.equal(result.startTime, candidate.startTime, 'a non-filler opener must not be trimmed');
    assert.equal(result.leadingTrimmedMs, 0);
  }

  // 3) Trailing dead air beyond the natural tail is trimmed, never past the last word.
  {
    const words = wordsFor(VERY_LONG_TEXT, 10, 0.4, 0.05);
    const lastWordEnd = words[words.length - 1].end;
    assert.ok(lastWordEnd - 10 >= MIN_CLIP_DURATION_SECONDS + 4,
      'test fixture must have enough spoken content to trim a trailing tail safely');
    const candidate = { startTime: 10, endTime: lastWordEnd + 4, transcriptText: VERY_LONG_TEXT };
    const result = optimizeClipBoundaries(candidate, words);
    assert.ok(result.endTime < candidate.endTime, 'long trailing silence must be trimmed');
    assert.ok(result.endTime >= lastWordEnd, 'must never cut before the last word ends');
    assert.ok(result.trailingWasteMs > 0);
  }

  // 4) Trimming never shrinks a clip below the minimum duration, even with filler and slack.
  {
    const words = wordsFor(LONG_TEXT, 0);
    const lastWordEnd = words[words.length - 1].end;
    // Just over the minimum, with both filler at the front and slack at the back.
    const candidate = { startTime: 0, endTime: MIN_CLIP_DURATION_SECONDS + 0.5, transcriptText: LONG_TEXT };
    const trimmable = words.filter((word) => word.end <= candidate.endTime + 0.001);
    assert.ok(trimmable.length > 3, 'fixture must contain enough words inside the window');
    const result = optimizeClipBoundaries(candidate, words);
    assert.ok(result.endTime - result.startTime >= MIN_CLIP_DURATION_SECONDS - 0.001,
      'duration must never drop below the minimum');
  }

  // 5) No word timestamps available: safe no-op that still scores opening/ending from text.
  {
    const candidate = { startTime: 5, endTime: 40, transcriptText: LONG_TEXT };
    const result = optimizeClipBoundaries(candidate, []);
    assert.equal(result.startTime, candidate.startTime);
    assert.equal(result.endTime, candidate.endTime);
    assert.equal(result.transcriptText, LONG_TEXT);
    assert.ok(result.openingStrength < 50, 'a filler opener must score low without word data too');
  }

  // 6) Never cuts a word in half: returned boundaries always land on word edges when trimmed.
  {
    const words = wordsFor('Well ' + LONG_TEXT, 200);
    const candidate = { startTime: 200, endTime: words[words.length - 1].end + 3,
      transcriptText: 'Well ' + LONG_TEXT };
    const result = optimizeClipBoundaries(candidate, words);
    assert.ok(words.some((word) => Math.abs(word.start - result.startTime) < 0.0001),
      'trimmed start must align exactly with a word boundary');
  }

  console.log(JSON.stringify({ fillerOpenerTrimmed: true, strongOpenerPreserved: true,
    trailingSilenceTrimmed: true, minimumDurationPreserved: true, noWordDataIsSafeNoop: true,
    wordBoundaryAligned: true }));
}

main();
