const { HOOK_LANGUAGE_CHECKS } = require('../../dist/modules/content-intelligence/hook-language');
// A complete stub verdict for existing integration tests. Rejection behavior has separate adversarial tests.
module.exports = input => ({ reviews: JSON.parse(input.request.userPrompt).hooks.map(h => ({ index:h.index, approved:true,
  clickability:90, context:95, grounding:95, misleadingRisk:5, specificity:90, naturalness:95,
  summaryLike:false, unclearReference:false, issue:'', why:'supported by test fixture',
  language:Object.fromEntries(HOOK_LANGUAGE_CHECKS.map(k=>[k,true])) })), copy:{supported:true,failures:[]} });
