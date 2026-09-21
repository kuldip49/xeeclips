require('reflect-metadata');
const assert = require('node:assert/strict');
const { ClipCriticService } = require('../dist/modules/processing/clip-critic.service');
const { ClipIntelligenceService, HIGH_CONFIDENCE_GATE_THRESHOLDS } =
  require('../dist/modules/processing/clip-intelligence.service');
const { LlmProviderError } = require('../dist/modules/processing/llm-provider.service');
const { performanceContext, createPerformanceTelemetry } =
  require('../dist/modules/processing/performance-telemetry');

const candidate = {
  videoId: 'video', rangeKey: '0:30', startTime: 0, endTime: 30, duration: 30,
  transcriptText: 'Dust blocks sunlight from reaching solar panels. Cleaning the panels restores their output.',
  heuristicScore: 80, hookScore: 80, sourceHookScore: 80, standaloneScore: 82,
  payoffScore: 84, flowScore: 81, informationScore: 86, retentionScore: 82,
  shareabilityScore: 78, contentPotential: 82, overallScore: 82, reject: false,
  topic: 'Solar panel cleaning', reason: 'Grounded useful payoff.', rejectionReason: '',
  judgeSource: 'LLM', rank: 1,
  hooks: [
    { text: 'Dust can quietly cut a solar panel’s useful output.', style: 'strong claim', score: 86 },
    { text: 'Why does cleaning help solar panels recover output?', style: 'question', score: 83 },
    { text: 'Clean panels let more sunlight reach the surface.', style: 'educational/value', score: 81 }
  ],
  bestHook: 'Dust can quietly cut a solar panel’s useful output.',
  alternateHooks: ['Why does cleaning help solar panels recover output?',
    'Clean panels let more sunlight reach the surface.'],
  generatedHookScore: 86, selectedHookStrategy: 'strong claim',
  title: 'Cleaning Solar Panels Restores Output',
  caption: 'Dust can quietly cut a solar panel’s useful output.',
  hashtags: ['#SolarPanels', '#SolarEnergy', '#PanelCleaning', '#EnergyOutput', '#Sunlight'],
  synopsis: 'The clip discusses dust blocking sunlight from solar panels.\n\nCleaning the panels removes that obstruction.\n\nThe result described is restored panel output.',
  contentType: 'Educational insight', whySelected: 'It has a clear problem and payoff.',
  provider: 'google', model: 'configured-flash', promptVersion: 'test',
  generationStatus: 'GENERATED', fallbackReason: '', contentFingerprint: 'fingerprint',
  evidence: { transcript: 'Dust blocks sunlight from reaching solar panels. Cleaning the panels restores their output.',
    previousContext: '', nextContext: '', chapter: 'Solar maintenance', overallVideoTopic: 'Solar energy',
    speechSignals: {}, visualSignals: [], multimodalSignals: [], supportedFacts: [], importantMoments: [] },
  clipUnderstanding: { mainTopic: 'Solar panel cleaning', subTopics: [], speakerIntent: 'explain',
    mainClaim: 'Cleaning restores output.', strongestFact: 'Dust blocks sunlight.', keyQuote: '',
    problem: 'Dust blocks sunlight.', conflict: '', surprisingPoint: '', emotionalTone: 'informative',
    targetAudience: 'Solar owners', viewerPainPoint: 'Lost output', viewerBenefit: 'Restore output',
    payoff: 'Cleaning restores output.', conclusion: 'Clean the panels.', contentType: 'educational',
    standaloneMeaning: 'self-contained', contextNeeded: '', engagementDrivers: [], supportedClaims: [],
    confidence: 85 },
  providerMetadata: [], generationMode: 'CLOUD_AI', fallbackUsed: false,
  failureCategory: ''
};

async function main() {
  const evidenceService = new ClipIntelligenceService({
    isAnyConfigured: () => false,
    async generate() { throw new LlmProviderError('CONFIGURATION_FAILURE', 'unconfigured'); }
  });
  const visual = [{ position: 0, startTime: 0, endTime: 30, sceneChangeCount: 2,
    averageMotion: 30, faceCount: 1, largestFaceRatio: 20, brightness: 50,
    contrast: 40, colorfulness: 55, ocrText: 'Solar output', subtitleDetected: true }];
  const multimodal = await evidenceService.analyzeMultimodal('video', visual);
  assert.equal(multimodal.observations.length, 1);
  const evidence = evidenceService.fuse(candidate, visual, multimodal.observations);
  assert.equal(evidence.transcript, candidate.transcriptText);
  assert.equal(evidence.visualSignals.length, 1);
  const understood = await evidenceService.understand([candidate], [evidence]);
  assert.equal(understood.understandings.length, 1);
  assert.ok(understood.understandings[0].supportedClaims.length > 0);

  // High-confidence candidates must skip the clipUnderstanding model call entirely.
  {
    const calls = [];
    const router = new ClipIntelligenceService({
      isAnyConfigured: () => true,
      async generate(input) { calls.push(input.role);
        throw new Error('a high-confidence candidate must never call the model'); }
    });
    const highConfidenceCandidate = { ...candidate, heuristicScore: 88, standaloneScore: 85,
      payoffScore: 82, hookScore: 80, flowScore: 78, informationScore: 75, reject: false };
    const skipped = await router.understand([highConfidenceCandidate], [evidence]);
    assert.deepEqual(calls, [], 'a high-confidence candidate must not reach the router');
    assert.equal(skipped.decisionSources[0], 'DETERMINISTIC_HIGH_CONFIDENCE');
    assert.equal(skipped.highConfidenceSkippedCount, 1);
    assert.ok(skipped.understandings[0].supportedClaims.length > 0);
  }

  // A candidate below the confidence gate must still reach the router.
  {
    const calls = [];
    const router = new ClipIntelligenceService({
      isAnyConfigured: () => true,
      async generate(input) { calls.push(input.role);
        return { data: { candidates: [] }, metadata: { role: input.role, provider: 'openai',
          model: 'gpt-5.6-luna', failover: false, cacheHit: false, attempts: [] } }; }
    });
    const standardCandidate = { ...candidate, heuristicScore: 65, standaloneScore: 60,
      payoffScore: 58, hookScore: 55, flowScore: 60, informationScore: 55, reject: false };
    const pursued = await router.understand([standardCandidate], [evidence]);
    assert.deepEqual(calls, ['clipUnderstanding'], 'a standard-confidence candidate must call the router');
    assert.equal(pursued.highConfidenceSkippedCount, 0);
    assert.equal(pursued.decisionSources[0], 'DETERMINISTIC_FALLBACK');
  }

  const roles = [];
  const critic = new ClipCriticService({
    async generate(input) {
      roles.push(input.role);
      if (input.role === 'critic') return { data: { reviews: [{ accepted: false,
        components: { hooks: true, caption: false, title: true, hashtags: true, synopsis: true },
        reasons: { hooks: '', caption: 'duplicates hook', title: '', hashtags: '', synopsis: '' },
        unsupportedClaims: [] }] }, metadata: { role: 'critic', provider: 'nvidia',
          model: 'nemotron-super', failover: false, cacheHit: false, attempts: [] } };
      return { data: { caption: 'Cleaning solar panels helps restore the output lost when dust blocks sunlight.' },
        metadata: { role: 'creativeGeneration', provider: 'google', model: 'gemini-flash',
          failover: false, cacheHit: false, attempts: [] } };
    }
  });
  const [reviewed] = await critic.review([candidate]);
  assert.deepEqual(roles, ['critic', 'componentRepair']);
  assert.notEqual(reviewed.caption, candidate.caption);
  assert.equal(reviewed.title, candidate.title, 'component repair must not regenerate passing title');
  assert.equal(reviewed.hooks[0].text, candidate.hooks[0].text,
    'component repair must not regenerate passing hooks');
  assert.equal(reviewed.generationMode, 'CLOUD_AI');
  assert.ok(reviewed.generationQuality >= 0 && reviewed.generationQuality <= 100);
  assert.ok(reviewed.confidence >= 0 && reviewed.confidence <= 100);
  assert.equal(reviewed.providerMetadata.length, 2);
  const validRoles = [];
  const validCritic = new ClipCriticService({ async generate(input) {
    validRoles.push(input.role); throw new Error('valid package should not call a model');
  } });
  const [locallyAccepted] = await validCritic.review([{ ...candidate,
    caption: 'Cleaning the panels restores solar output by letting sunlight reach them again.' }]);
  assert.deepEqual(validRoles, [], 'a locally valid package must skip the AI critic');
  assert.equal(locallyAccepted.criticResult.validationMode, 'DETERMINISTIC');
  assert.equal(roles.filter(role => role === 'componentRepair').length, 1,
    'only one component repair cycle is allowed');

  // A locally valid package must skip the AI critic in ONLINE mode too: only genuine
  // deterministic failures (or a flagged localValidationIssue) may spend a Luna critic call.
  {
    const onlineRoles = [];
    const onlineCritic = new ClipCriticService({ async generate(input) {
      onlineRoles.push(input.role); throw new Error('valid ONLINE package should not call Luna');
    } });
    await performanceContext.run(createPerformanceTelemetry('ONLINE'), () =>
      onlineCritic.review([{ ...candidate, generationStatus: 'GENERATED',
        caption: 'Cleaning the panels restores solar output by letting sunlight reach them again.' }]));
    assert.deepEqual(onlineRoles, [],
      'ONLINE mode must not force every GENERATED candidate through the critic when it already passes');
  }

  // Batching: several candidates that each need model review must share one critic call.
  {
    const batchRoles = [];
    const repairInputs = [];
    const batchCandidates = [0, 1, 2].map((index) => ({ ...candidate,
      rangeKey: `batch-${index}:30`, caption: candidate.bestHook }));
    const batchCritic = new ClipCriticService({ async generate(input) {
      batchRoles.push(input.role);
      if (input.role === 'critic') {
        const items = JSON.parse(input.request.userPrompt);
        assert.equal(items.length, 3, 'all three suspicious candidates must share one critic call');
        return { data: { reviews: items.map((item) => ({ candidateId: item.candidateId,
          accepted: false, components: { hooks: true, caption: false, title: true,
            hashtags: true, synopsis: true },
          reasons: { hooks: '', caption: 'duplicates hook', title: '', hashtags: '', synopsis: '' },
          unsupportedClaims: [] })) }, metadata: { role: 'critic', provider: 'openai',
          model: 'gpt-5.6-luna', failover: false, cacheHit: false, attempts: [] } };
      }
      repairInputs.push(input);
      return { data: { caption: 'A distinct, grounded caption about solar panel output.' },
        metadata: { role: 'componentRepair', provider: 'google', model: 'gemini-flash',
          failover: false, cacheHit: false, attempts: [] } };
    } });
    const reviewedBatch = await batchCritic.review(batchCandidates);
    assert.equal(batchRoles.filter((role) => role === 'critic').length, 1,
      'three suspicious candidates must cost exactly one Luna critic call when batched');
    assert.equal(repairInputs.length, 3,
      'componentRepair still runs once per candidate needing a fix (heterogeneous per-candidate repairs)');
    assert.ok(reviewedBatch.every((item) => item.caption !== candidate.bestHook));
  }

  // A purely mechanical hashtag failure (bad formatting, still 5 well-grounded ideas) must be
  // repaired deterministically and must never spend a Luna componentRepair call.
  {
    const mechanicalRoles = [];
    const mechanicalCandidate = { ...candidate, rangeKey: 'mechanical:30',
      caption: 'Cleaning the panels restores solar output by letting sunlight reach them again.',
      hashtags: ['#SolarPanels', '#Solar-Energy!!', '#PanelCleaning', '#EnergyOutput', '#Sunlight'] };
    const mechanicalCritic = new ClipCriticService({ async generate(input) {
      mechanicalRoles.push(input.role);
      if (input.role === 'critic') return { data: { reviews: [{ accepted: false,
        components: { hooks: true, caption: true, title: true, hashtags: false, synopsis: true },
        reasons: { hooks: '', caption: '', title: '', hashtags: 'malformed hashtag', synopsis: '' },
        unsupportedClaims: [] }] }, metadata: { role: 'critic', provider: 'nvidia',
          model: 'nemotron-super', failover: false, cacheHit: false, attempts: [] } };
      throw new Error('a mechanical hashtag failure must not spend a componentRepair call');
    } });
    const mechanicalTelemetry = createPerformanceTelemetry();
    const [mechanicalResult] = await performanceContext.run(mechanicalTelemetry, () =>
      mechanicalCritic.review([mechanicalCandidate]));
    assert.deepEqual(mechanicalRoles, ['critic'],
      'a mechanical-only hashtag failure must be resolved without calling componentRepair');
    assert.equal(mechanicalResult.hashtags.length, 5);
    assert.equal(new Set(mechanicalResult.hashtags.map((tag) => tag.toLowerCase())).size, 5);
    assert.ok(mechanicalResult.hashtags.every((tag) => /^#[\p{L}\p{N}_]+$/u.test(tag)));
    assert.equal(mechanicalTelemetry.mechanicalComponentRepairCount, 1);
    assert.equal(mechanicalTelemetry.repairCount, 0, 'no Luna componentRepair call was made');
  }

  // A purely mechanical title failure (markdown emphasis wrapping, e.g. "**Title**") must be
  // stripped and repaired deterministically, never spending a Luna componentRepair call. The
  // hashtags are also malformed here purely to make the candidate "suspicious" enough to reach
  // the critic in the first place (deterministicReview's own grounding check ignores markdown,
  // so a title-only issue would never surface without a second deterministic failure alongside it).
  {
    const titleRoles = [];
    const titleCandidate = { ...candidate, rangeKey: 'title-mechanical:30',
      caption: 'Cleaning the panels restores solar output by letting sunlight reach them again.',
      title: '**Cleaning Solar Panels Restores Output**',
      hashtags: ['#SolarPanels', '#Solar-Energy!!', '#PanelCleaning', '#EnergyOutput', '#Sunlight'] };
    const titleCritic = new ClipCriticService({ async generate(input) {
      titleRoles.push(input.role);
      if (input.role === 'critic') return { data: { reviews: [{ accepted: false,
        components: { hooks: true, caption: true, title: false, hashtags: false, synopsis: true },
        reasons: { hooks: '', caption: '', title: 'markdown formatting artifact',
          hashtags: 'malformed hashtag', synopsis: '' },
        unsupportedClaims: [] }] }, metadata: { role: 'critic', provider: 'nvidia',
          model: 'nemotron-super', failover: false, cacheHit: false, attempts: [] } };
      throw new Error('a mechanical title formatting failure must not spend a componentRepair call');
    } });
    const titleTelemetry = createPerformanceTelemetry();
    const [titleResult] = await performanceContext.run(titleTelemetry, () =>
      titleCritic.review([titleCandidate]));
    assert.deepEqual(titleRoles, ['critic'],
      'a mechanical-only title formatting failure must be resolved without calling componentRepair');
    assert.equal(titleResult.title, 'Cleaning Solar Panels Restores Output');
    assert.equal(titleTelemetry.mechanicalComponentRepairCount, 1);
    assert.equal(titleTelemetry.repairCount, 0, 'no Luna componentRepair call was made');
  }

  // A duplicate/short hashtag set (count+uniqueness failure, not just formatting) must still be
  // repaired deterministically by padding from the grounded fallback pool, without Luna.
  {
    const dupRoles = [];
    const dupCandidate = { ...candidate, rangeKey: 'hashtag-duplicate:30',
      caption: 'Cleaning the panels restores solar output by letting sunlight reach them again.',
      hashtags: ['#SolarPanels', '#SolarPanels', '#PanelCleaning', '#EnergyOutput', '#Sunlight'] };
    const dupCritic = new ClipCriticService({ async generate(input) {
      dupRoles.push(input.role);
      if (input.role === 'critic') return { data: { reviews: [{ accepted: false,
        components: { hooks: true, caption: true, title: true, hashtags: false, synopsis: true },
        reasons: { hooks: '', caption: '', title: '', hashtags: 'duplicate hashtag', synopsis: '' },
        unsupportedClaims: [] }] }, metadata: { role: 'critic', provider: 'nvidia',
          model: 'nemotron-super', failover: false, cacheHit: false, attempts: [] } };
      throw new Error('a duplicate-hashtag failure with a groundable fallback pool must not spend a componentRepair call');
    } });
    const dupTelemetry = createPerformanceTelemetry();
    const [dupResult] = await performanceContext.run(dupTelemetry, () => dupCritic.review([dupCandidate]));
    assert.deepEqual(dupRoles, ['critic'],
      'a duplicate-hashtag mechanical padding must avoid componentRepair');
    assert.equal(dupResult.hashtags.length, 5);
    assert.equal(new Set(dupResult.hashtags.map((tag) => tag.toLowerCase())).size, 5);
    assert.equal(dupTelemetry.mechanicalComponentRepairCount, 1);
    assert.equal(dupTelemetry.repairCount, 0, 'no Luna componentRepair call was made');
  }

  // Genuinely ungrounded (semantic) title failures have no safe mechanical fix and must still
  // escalate to the Luna componentRepair call.
  {
    const semanticRoles = [];
    const semanticCandidate = { ...candidate, rangeKey: 'title-semantic:30',
      caption: 'Cleaning the panels restores solar output by letting sunlight reach them again.',
      title: 'A totally unrelated invented gadget review' };
    const semanticCritic = new ClipCriticService({ async generate(input) {
      semanticRoles.push(input.role);
      if (input.role === 'critic') return { data: { reviews: [{ accepted: false,
        components: { hooks: true, caption: true, title: false, hashtags: true, synopsis: true },
        reasons: { hooks: '', caption: '', title: 'title is not about this clip', hashtags: '', synopsis: '' },
        unsupportedClaims: [] }] }, metadata: { role: 'critic', provider: 'nvidia',
          model: 'nemotron-super', failover: false, cacheHit: false, attempts: [] } };
      return { data: { title: 'Cleaning Solar Panels Restores Output' },
        metadata: { role: 'componentRepair', provider: 'google', model: 'gemini-flash',
          failover: false, cacheHit: false, attempts: [] } };
    } });
    const semanticTelemetry = createPerformanceTelemetry();
    const [semanticResult] = await performanceContext.run(semanticTelemetry, () =>
      semanticCritic.review([semanticCandidate]));
    assert.deepEqual(semanticRoles, ['critic', 'componentRepair'],
      'an ungrounded title must still be regenerated by Luna, not silently rewritten');
    assert.equal(semanticResult.title, 'Cleaning Solar Panels Restores Output');
    assert.equal(semanticTelemetry.mechanicalComponentRepairCount, 0,
      'an ungrounded title has no mechanical fix to count');
  }

  // Benchmark-style workload: several candidates each with a mechanically-fixable title/hashtag
  // issue must all resolve deterministically, so a tight per-job repair budget is never exceeded
  // and callBudgetDeniedCount stays at 0.
  {
    process.env.LLM_JOB_MAX_REPAIR_CALLS = '1';
    try {
      const workloadCritic = new ClipCriticService({ async generate(input) {
        if (input.role === 'critic') {
          const items = JSON.parse(input.request.userPrompt);
          return { data: { reviews: items.map((item) => ({ candidateId: item.candidateId,
            accepted: false, components: { hooks: true, caption: true, title: false,
              hashtags: false, synopsis: true },
            reasons: { hooks: '', caption: '', title: 'markdown formatting artifact',
              hashtags: 'malformed hashtag', synopsis: '' }, unsupportedClaims: [] })) },
            metadata: { role: 'critic', provider: 'nvidia', model: 'nemotron-super',
              failover: false, cacheHit: false, attempts: [] } };
        }
        throw new Error('a benchmark-style workload of mechanical-only issues must not call componentRepair');
      } });
      const workloadCandidates = [0, 1, 2, 3, 4].map((index) => ({ ...candidate,
        rangeKey: `workload-${index}:30`,
        caption: 'Cleaning the panels restores solar output by letting sunlight reach them again.',
        title: '**Cleaning Solar Panels Restores Output**',
        hashtags: ['#SolarPanels', '#Solar-Energy!!', '#PanelCleaning', '#EnergyOutput', '#Sunlight'] }));
      const workloadTelemetry = createPerformanceTelemetry();
      const workloadResults = await performanceContext.run(workloadTelemetry, () =>
        workloadCritic.review(workloadCandidates));
      assert.ok(workloadResults.every((item) => !item.title.includes('*')));
      assert.equal(workloadTelemetry.mechanicalComponentRepairCount, 5);
      assert.equal(workloadTelemetry.repairCount, 0);
      assert.equal(workloadTelemetry.callBudgetDeniedCount, 0,
        'mechanical resolution must keep the job well under its componentRepair budget');
    } finally { delete process.env.LLM_JOB_MAX_REPAIR_CALLS; }
  }

  // Stage 5 gate telemetry: highConfidenceGateBlockers must name every dimension below its
  // threshold, independent of the reject flag, and understand() must tally them per candidate.
  {
    const evidenceService = new ClipIntelligenceService({
      isAnyConfigured: () => true,
      async generate(input) { return { data: { candidates: [] }, metadata: { role: input.role,
        provider: 'openai', model: 'gpt-5.6-luna', failover: false, cacheHit: false, attempts: [] } }; }
    });
    const blockedOnHookAndFlow = { ...candidate, heuristicScore: 85, standaloneScore: 82,
      payoffScore: 80, hookScore: 60, flowScore: 55, informationScore: 70, reject: false };
    const blockedEvidence = evidenceService.fuse(blockedOnHookAndFlow, [], []);
    const gated = await evidenceService.understand([blockedOnHookAndFlow], [blockedEvidence]);
    assert.equal(gated.highConfidenceRejectedBy.hookScore, 1);
    assert.equal(gated.highConfidenceRejectedBy.flowScore, 1);
    assert.equal(gated.highConfidenceRejectedBy.standaloneScore, 0);
    assert.equal(gated.highConfidenceRejectedBy.heuristicScore, 0);
    assert.ok(HIGH_CONFIDENCE_GATE_THRESHOLDS.hookScore > 0, 'gate thresholds must stay exported and unchanged');
  }

  console.log(JSON.stringify({ structuredEvidence: true, deterministicUnderstanding: true,
    componentOnlyRegeneration: true, validPackageSkipsCritic: true, oneRepairCycle: true,
    threeQualityScores: true, criticGrounding: true, onlineSkipsUnnecessaryCritic: true,
    criticBatching: true, highConfidenceGateTelemetry: true }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
