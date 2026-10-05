const assert = require('node:assert/strict');
const { ReframeService } = require('../dist/modules/editing/reframe.service.js');

const faces = [];
for (let t = 0; t <= 10; t += .25) {
  // A one-sample false positive at 2s must not pull the camera to B. B becomes
  // the real active speaker at 5s and stays dominant long enough to confirm.
  const falseSpike = Math.abs(t - 2) < .01;
  const bSpeaking = t >= 5;
  faces.push({ timestamp: t, x: .12, y: .12, w: .18, h: .28,
    confidence: .96, mouthActivity: bSpeaking ? .03 : falseSpike ? .04 : .8, trackId: 'A' });
  faces.push({ timestamp: t, x: .7, y: .11, w: .17, h: .27,
    confidence: .95, mouthActivity: bSpeaking || falseSpike ? .86 : .02, trackId: 'B' });
}

const camera = new ReframeService().plan('9:16', faces, [], 0, [], 1920, 1080,
  [], 30, { x: 0, y: 0, width: 1080, height: 700 }, false,
  { speakerSafe: true });

const named = camera.speakerSegments.filter((segment) => segment.trackId);
assert.equal(named[0]?.trackId, 'A', 'the opening speaker should be A');
assert.equal(named.filter((segment) => segment.trackId === 'B').length, 1,
  'the sustained takeover should switch to B exactly once');
assert(named.find((segment) => segment.trackId === 'B').startSec >= 5.5,
  'B must remain dominant for at least 0.6s before the switch');
assert.equal(camera.speakerSwitchCount, 1, 'the false spike must not create A-B-A jitter');
assert.equal(camera.faceSafetyViolations, 0, 'the selected speaker face must stay fully visible');
assert(camera.cameraMoves.every((move) => move.durationSec <= .35),
  'speaker changes must cut or settle quickly, never create a long pan');
assert(camera.cropWidth > .65,
  'Automatic 2 must solve for the wide editorial card instead of a tight 9:16 crop');

console.log(JSON.stringify({
  speakerSwitchCount: camera.speakerSwitchCount,
  speakerSegments: named.map((segment) => ({ start: segment.startSec, end: segment.endSec,
    trackId: segment.trackId, confidence: segment.confidence })),
  cameraMoves: camera.cameraMoves,
  faceSafetyViolations: camera.faceSafetyViolations,
  cropWidth: camera.cropWidth
}, null, 2));
