// Regression: when the clip opens just after a trimmed lead-in ("So" cut away), the caption phrase that straddled the
// start used to be dropped whole, leaving the clip's first spoken words ("imagine you got 200") without a caption.
// Found on the real source19 replay (15.52-39.10). Real word timings from that transcript, no providers.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { generateCaptions } = require('../dist/modules/edit-mode/edit-mode-captions');
const { buildTimelineMap } = require('../dist/modules/edit-mode/render/edit-mode-timeline-map');

const w = (text, start, end) => ({ text, start, end });
const words = [w('comparison.', 14.98, 15.44), w('So', 15.44, 15.52), w('imagine', 15.52, 15.82), w('you', 15.82, 16.42), w('got', 16.42, 16.58),
  w('200', 16.58, 16.88), w('people', 16.88, 17.34), w('on', 17.34, 17.48), w('a', 17.48, 17.54), w('plantation', 17.54, 17.96),
  w('and', 17.96, 18.38), w("they're", 18.38, 18.46), w('making', 18.46, 18.72), w('you', 18.72, 18.98), w('millions', 18.98, 19.66)];
const map = buildTimelineMap([{ id: 'v', type: 'VIDEO', track: 0, position: 0, startTime: 0, duration: 4.14, trimStart: 15.52, trimEnd: 19.66, properties: {} }]);
const result = generateCaptions({ words, wordTimings: true, map, limit: 400, wordsPerCaption: 5 });
const spoken = words.filter(x => x.start >= 15.52).map(x => x.text);
const captioned = result.captions.flatMap(c => c.content.split(/\s+/u));
assert.deepEqual(captioned.map(x => x.toLowerCase()), spoken.map(x => x.toLowerCase()), 'every spoken word of the clip is captioned exactly once, in order');
assert.equal(result.captions[0].startTime, 0, 'the first caption opens with the clip');
assert.match(result.captions[0].content, /^imagine you got/u);
assert(!result.captions.some(c => /^so\b/iu.test(c.content)), 'the trimmed lead-in word is not captioned');
for (const caption of result.captions) {
  assert(caption.words.length > 0);
  assert.equal(caption.words[0].start, 0, 'word timings are rebased onto the caption start');
}
// Untouched case: a clip that starts on a phrase start keeps its captions exactly as before.
const aligned = generateCaptions({ words, wordTimings: true, wordsPerCaption: 5, limit: 400,
  map: buildTimelineMap([{ id: 'v', type: 'VIDEO', track: 0, position: 0, startTime: 0, duration: 4.22, trimStart: 15.44, trimEnd: 19.66, properties: {} }]) });
assert.match(aligned.captions[0].content, /^so imagine you got$/iu);
console.log('Caption opening phrase: a phrase straddling the trimmed start is clipped to its kept words, not dropped: PASS');
console.log(JSON.stringify(result.captions.map(c => [c.startTime, c.duration, c.content])));
