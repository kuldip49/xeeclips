// Clip limits by length and the fill tiers that make a request deliver exactly the count asked
// for. Offline; run after `npm run build`.
const assert = require('node:assert/strict');
const policy = require('../dist/modules/processing/clip-selection-policy.js');
const { orderCandidatesForSelection } = require('../dist/modules/videos/clip-selection.service.js');

const minutes = (value) => value * 60;
// Limits: 8 under 15 min, 20 up to an hour, 30 up to two hours.
for (const [duration, expected] of [[minutes(5), 8], [minutes(14), 8], [minutes(15), 20], [minutes(45), 20],
  [minutes(60), 20], [minutes(61), 30], [minutes(120), 30], [minutes(121), 0]])
  assert.equal(policy.maxClipCountForDuration(duration), expected, `max for ${duration}s`);
assert.equal(policy.MAX_REQUESTABLE_CLIPS, 30);
assert.equal(policy.validateRequestedClipCount(30, policy.maxClipCountForDuration(minutes(120))), 30);
assert.throws(() => policy.validateRequestedClipCount(21, policy.maxClipCountForDuration(minutes(60))), /at most 20/);

const speech = (seed, count = 40) => Array.from({ length: count }, (_, index) => `${seed}word${index}`).join(' ');
const candidate = (id, startTime, endTime, overrides = {}) => ({ id, rangeKey: `${startTime}:${endTime}`,
  startTime, endTime, transcriptText: speech(id), contentPotential: 70, rank: 1, reject: false,
  evidence: {}, ...overrides });

// Fill usability keeps the hard limits but not the scoring rejections.
assert.equal(policy.evaluateFillUsability(candidate('a', 0, 20, { reject: true, rank: null })).usable, true);
assert.equal(policy.evaluateFillUsability(candidate('b', 0, 10)).usable, false, 'still at least 15 s');
assert.equal(policy.evaluateFillUsability(candidate('c', 0, 130)).usable, false, 'still at most 120 s');
assert.equal(policy.evaluateFillUsability({ ...candidate('d', 0, 30), transcriptText: 'one two' }).usable, false,
  'still needs real speech');

// Tiers tolerate more overlap, but never a repeat of the same range.
const chosen = [candidate('x', 0, 30)];
const halfOverlap = { ...candidate('y', 15, 45) };   // 50% overlap
const heavyOverlap = { ...candidate('z', 6, 36) };   // 80% overlap
assert.equal(policy.isDuplicateOfAny(halfOverlap, chosen), true, 'strict selection refuses 50% overlap');
assert.equal(policy.isNearDuplicateOfAny(halfOverlap, chosen, 1), false, 'tier 1 accepts 50% overlap');
assert.equal(policy.isNearDuplicateOfAny(heavyOverlap, chosen, 1), true);
assert.equal(policy.isNearDuplicateOfAny(heavyOverlap, chosen, 2), false, 'tier 2 accepts 80% overlap');
assert.equal(policy.isNearDuplicateOfAny(candidate('same', 0.4, 30.3), chosen, 3), true, 'same range is never a fill');

// Ordering: fill candidates only ever come after every distinct moment.
const ordered = orderCandidatesForSelection([
  candidate('strong1', 0, 30, { contentPotential: 80 }),
  candidate('strong2', 100, 130, { contentPotential: 75 }),
  candidate('fill1', 15, 45, { contentPotential: 99, evidence: { candidateFill: 1 } }),
  candidate('fill3', 110, 140, { contentPotential: 99, evidence: { candidateFill: 3 } })
], 300).ordered.map((item) => item.id);
assert.deepEqual(ordered, ['strong1', 'strong2', 'fill1', 'fill3']);
console.log('Clip limits and exact-count fill tier checks passed');
