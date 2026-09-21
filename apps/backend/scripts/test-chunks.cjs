const assert = require('node:assert/strict');
const { buildTranscriptChunks: build } = require('../dist/modules/processing/transcript-chunks');
const s = (position, start, end, text) => ({ position, start, end, text });
const chunks = build('video', [s(2, 4, 5, 'Next.'), s(0, 0, 1, 'Hello'), s(1, 1.2, 3, 'world!')]);
assert.deepEqual(chunks.map(({ text, startTime, endTime, duration, wordCount }) => ({ text, startTime, endTime, duration, wordCount })), [
  { text: 'Hello world!', startTime: 0, endTime: 3, duration: 3, wordCount: 2 },
  { text: 'Next.', startTime: 4, endTime: 5, duration: 1, wordCount: 1 }
]);
assert.equal(build('v', [s(0, 0, 1, 'a'), s(1, 2, 3, 'b')]).length, 2);
assert.equal(build('v', [s(0, 0, 1, 'Done.”'), s(1, 1, 2, 'Next')]).length, 2);
assert.equal(build('v', [s(0, 0, 16, 'Long phrase,'), s(1, 16, 18, 'next')]).length, 2);
assert.equal(build('v', [s(0, 0, 31, 'No punctuation'), s(1, 31, 33, 'next')]).length, 2);
assert.equal(build('v', [s(0, 0, 4, 'overlap'), s(1, 2, 3, 'inside')])[0].endTime, 4);
assert.deepEqual(build('v', [s(0, 0, 1, '  ')]), []);
assert.deepEqual(build('v', []), []);
assert.throws(() => build('v', [s(0, 4, 1, 'bad')]));
assert.equal(build('v', [s(0, 0, 1, '  one   two  ')])[0].wordCount, 2);
console.log('Chunk algorithm checks passed.');
