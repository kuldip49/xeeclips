const assert = require('node:assert/strict');
const { analyzeTranscriptChunk: analyze } = require('../dist/modules/processing/chunk-analysis');

assert.deepEqual(analyze({ text: '', duration: 0 }), {
  questionCount: 0,
  exclamationCount: 0,
  keywordDensity: 0,
  averageSentenceLength: 0,
  speechRate: 0,
  informationDensity: 0,
  readabilityScore: 0
});

const result = analyze({ text: 'Can video video work? Yes, it can!', duration: 4 });
assert.equal(result.questionCount, 1);
assert.equal(result.exclamationCount, 1);
assert.equal(result.keywordDensity, 28.57);
assert.equal(result.averageSentenceLength, 3.5);
assert.equal(result.speechRate, 105);
assert.equal(result.informationDensity, 57.14);
assert.ok(result.readabilityScore >= 0 && result.readabilityScore <= 100);

const unicode = analyze({ text: 'Really？！', duration: 1 });
assert.equal(unicode.questionCount, 1);
assert.equal(unicode.exclamationCount, 1);
assert.equal(unicode.averageSentenceLength, 1);

const repeated = analyze({ text: 'Signal signal signal.', duration: 0 });
assert.equal(repeated.keywordDensity, 100);
assert.equal(repeated.speechRate, 0);

console.log('Chunk analysis checks passed.');
