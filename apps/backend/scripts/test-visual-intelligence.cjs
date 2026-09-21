require('reflect-metadata');
const assert = require('node:assert/strict');
const { applyDeterministicEvidence, candidateVisualEvidence, inferContentType,
  ClipIntelligenceService } = require('../dist/modules/processing/clip-intelligence.service');
const { calculateContentPotential, recommendationTierForScore, PRIMARY_CLIP_SCORE } =
  require('../dist/modules/processing/clip-candidates');
const { speechCoverageForRange } = require('../dist/modules/processing/video-processor.service');

const signal = (overrides = {}) => ({ position: 0, startTime: 0, endTime: 30,
  sceneChangeCount: 2, sceneCutRate: .067, averageShotDuration: 10,
  visualTransitionScore: 90, averageMotion: 8, visualNovelty: 30,
  faceCount: 1, largestFaceRatio: 14, facePresenceRatio: 86,
  averageFaceCount: 1, primaryFaceAreaRatio: 14, primaryFaceCenteredness: 92,
  faceStability: 94, talkingHeadLikelihood: 86, personPresenceRatio: 91,
  averagePersonCount: 1, objectActivity: 1, objectDiversity: 1,
  detectedObjectClasses: ['person'], largestPersonProminence: 30,
  centralPersonScore: 85, detectionConfidenceMean: 90,
  brightness: 54, contrast: 75, colorfulness: 42, sharpnessScore: 83,
  blackFrameRatio: 0, ocrText: 'reliable workflow evidence', ocrConfidence: 92,
  textAreaRatio: 3, subtitleDetected: true, ...overrides });
const candidate = { videoId: 'v', rangeKey: '0:30', startTime: 0, endTime: 30, duration: 30,
  transcriptText: 'How can reliable workflow evidence make this process useful? ' +
    'Here is the result, because clear evidence supports each step.',
  heuristicScore: 65, judgeSource: 'HEURISTIC_FALLBACK', rank: null,
  hookScore: 65, sourceHookScore: 65, standaloneScore: 66, payoffScore: 68,
  flowScore: 62, informationScore: 70, retentionScore: 62, shareabilityScore: 66,
  contentPotential: 65, overallScore: 65, reject: false, topic: 'reliable workflow',
  reason: 'Transcript evidence', rejectionReason: '' };

assert.equal(PRIMARY_CLIP_SCORE, 75);
assert.equal(recommendationTierForScore(74.99), 'SECONDARY');
assert.deepEqual(speechCoverageForRange(0, 10, [
  { start: 1, end: 3 }, { start: 2, end: 4 }, { start: 7, end: 9 }
]), { speechDensity: 50, silenceRatio: 50 });
const evidence = new ClipIntelligenceService().fuse(candidate, [signal()], [],
  { speechDensity: 84, silenceRatio: 16 });
assert.equal(evidence.contentType, 'talking head');
assert.equal(inferContentType([signal({ facePresenceRatio: 0, personPresenceRatio: 0,
  textAreaRatio: 12, averageMotion: 2 })]), 'slides/presentation');
assert.equal(candidateVisualEvidence(candidate, [signal()]).facePresenceRatio, 86);
assert.equal(evidence.candidateVisualEvidence.faceProminence, 14);
assert.equal(evidence.candidateVisualEvidence.silenceRatio, 16);
assert.ok(evidence.candidateVisualEvidence.transcriptOcrAlignment > 0);
const missingSemantic = new ClipIntelligenceService().fuse(candidate, [signal({
  yoloFrameCount: 0, faceFrameCount: 0, ocrFrameCount: 0,
  facePresenceRatio: 0, personPresenceRatio: 0, ocrText: ''
})], []);
assert.equal(missingSemantic.candidateVisualEvidence.facePresenceRatio, null);
assert.equal(missingSemantic.candidateVisualEvidence.personPresenceRatio, null);
assert.equal(missingSemantic.candidateVisualEvidence.ocrPresenceScore, null);
assert.deepEqual(applyDeterministicEvidence(candidate, missingSemantic), candidate);
const successfulAbsence = new ClipIntelligenceService().fuse(candidate, [signal({
  yoloFrameCount: 3, faceFrameCount: 3, ocrFrameCount: 1,
  facePresenceRatio: 0, personPresenceRatio: 0, ocrText: ''
})], []);
assert.equal(successfulAbsence.candidateVisualEvidence.facePresenceRatio, 0);
assert.equal(successfulAbsence.candidateVisualEvidence.personPresenceRatio, 0);
assert.equal(successfulAbsence.candidateVisualEvidence.ocrPresenceScore, 0);
const scored = applyDeterministicEvidence(candidate, evidence);
assert.notEqual(scored.contentPotential, candidate.contentPotential);
assert.equal(scored.contentPotential, calculateContentPotential(scored));
assert.match(scored.whySelected, /Speaker visible through 86%/);
for (const field of ['hookScore', 'standaloneScore', 'payoffScore', 'flowScore',
  'informationScore', 'retentionScore', 'shareabilityScore']) {
  assert.ok(scored[field] >= 0 && scored[field] <= 100, field);
}
const noVisual = new ClipIntelligenceService().fuse(candidate, [], []);
assert.deepEqual(applyDeterministicEvidence(candidate, noVisual), candidate);
const gameplay = new ClipIntelligenceService().fuse(candidate, [signal({ facePresenceRatio: 0,
  averageFaceCount: 0, primaryFaceAreaRatio: 0, talkingHeadLikelihood: 0,
  personPresenceRatio: 0, averageMotion: 15, objectDiversity: 0,
  detectedObjectClasses: [] })], []);
assert.equal(gameplay.contentType, 'gameplay');
assert.ok(applyDeterministicEvidence(candidate, gameplay).retentionScore > 0);

console.log('Visual intelligence tests passed: fusion, content types, speech gaps, scores, thresholds.');
