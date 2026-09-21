# Live video performance correction

Implemented in the existing backend pipeline; no architecture or database-schema redesign.

## Confirmed Gemini failure

Two synthetic requests compared the original and corrected schema fields against the configured
`gemini-3.8-flash` model at
`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`.

The original request returned HTTP 400 / INVALID_ARGUMENT:
`Unknown name "additionalProperties" at 'generation_config.response_schema': Cannot find field.`
Google also identified the nested candidates item schema. The code sent JSON Schema through
Google's OpenAPI-style `responseSchema` field. It now uses `responseJsonSchema` alongside
`responseMimeType: application/json`. Model ID, endpoint, temperature and token-budget fields
were preserved. The corrected payload returned HTTP 503 / UNAVAILABLE (“high demand”) on two
probes, rather than a schema compatibility error. Successful live generation is not yet verified.

Reference: [Google structured output documentation](https://ai.google.dev/gemini-api/docs/generate-content/structured-output?hl=en).

Run `npm.cmd --workspace apps/backend run diagnose:gemini` for a small synthetic corrected-schema
probe. Add `--compare` when directly invoking `node apps/backend/scripts/diagnose-gemini.cjs`
to reproduce the old schema failure as well. This path uses no user video/transcript.
Diagnostics redact the configured credential; the runtime records status, provider error detail,
model, schema, request role and response finish reason without logging authorization headers.

## Schema rejection causes and recovery

* Provider validation previously rejected the complete response for an extra field, a numeric/boolean
  string, any missing required field, or any invalid member of an array. Safe representation changes
  now normalize extra fields, unambiguous snake-case keys, numeric/boolean strings, enum casing,
  Markdown fences and a bare array when the schema has a single array property.
* Multimodal post-validation required every chunk position exactly once. A missing position
  discarded all expensive observations. Valid known positions now survive; missing/invalid
  positions use deterministic visual evidence.
* ClipUnderstanding required an exact array length and positional correspondence. One invalid
  item also failed provider-level validation before the service could use any siblings. Each input
  now carries a stable candidateId; valid items are matched by ID, and only invalid/missing items
  use deterministic understanding. Per-candidate failure and routing metadata preserve this distinction.
* Creative `Response length mismatch` came directly from `parseBatch` comparing returned and input
  array lengths. Production Compose requested ten large packages in one response with a 16,000-token
  ceiling; each package required 10–12 scored hooks plus all other content pools. That output pressure
  was a plausible contributor to incomplete batches. The historical responses were not retained here,
  so the exact field-level violation in each original Omni/understanding response, and whether an
  individual creative response stopped at its token limit, cannot be established retroactively.
* Creative generation now sends one full package per request. Local scoring selects grounded text
  from the returned title/caption/synopsis/hashtag pools as well as the existing hook scoring.
  One invalid package cannot discard the other four in a five-package workload.
* A bounded JSON recovery pass can retain complete objects from a truncated batch array. It never
  completes a partial object or invents facts. Remaining invalid items use local fallback.
* Critic operates on one near-final package per request with bounded workers. It retains component-only
  repair; critic failure uses deterministic validation and local repair without another model repair call.

Content grounding checks, unsupported-number checks, recommendation thresholds and user selection
limits remain active. Safe normalization is not permission to accept fabricated claims.

## Work and request counts

| Work for the 15-minute / 76-raw example | Previous | New upper bound |
| --- | ---: | ---: |
| Candidates entering AI understanding | 76 | 15 |
| Understanding requests (batch size 5) | 16 | 3 |
| Candidates receiving model creative packages | 76 | 10 |
| Creative requests before retries/failover | 8 with Compose batch 10; 16 with code batch 5 | 10 single-package requests |
| Candidates reviewed by critic | Up to 76 | 10 |
| Critic requests before retries/failover | 1 oversized request | Only locally suspicious packages; capped by the per-job critic budget (default 4) |
| Whole-video and multimodal requests, ordinary single-pass case | 2 | 2 |

The new ordinary path is at most 25 primary model requests (3 + 10 + 10 + 2), excluding cache hits,
optional component repairs, retries and failovers. The old ordinary path was 27–35 logical requests
before those additions. The supplied stage durations do not establish the exact historical HTTP
attempt count. In particular, 76 candidate evaluations did not mean 76 understanding HTTP requests.
Most of the savings come from reducing evaluated content and output volume, eliminating invalid
Google requests and bounding provider waits, rather than simply minimizing HTTP request count.

AI understanding limits are 12 / 15 / 20 / 25 / 30 for video durations <=10 / <=20 / <=30 / <=60 /
over60 minutes. Creative model budgets are respectively 6 / 10 / 12 / 15 / 18. Both stages rank,
suppress overlaps and preserve semantic/topic diversity before applying their budgets. AI confidence
has a modest effect on creative priority; deterministic content quality remains the main signal.
All understood candidates remain available with transcript-based fallback content when they do not
receive an AI creative package. These budgets do not replace the existing user selection policy.

## Time budget

The 90 / 180 / 270-second log sequence was cumulative latency from a timer outside the retry loop,
not an exponentially growing per-attempt timeout in the inspected implementation. Each original
attempt could consume 90 seconds, for roughly 270 seconds total plus backoff. The timer is now per attempt.

Default fixed per-attempt request timeouts are 35 seconds for multimodal understanding, 50 seconds
for whole-video understanding, 35 seconds for ClipUnderstanding, 30 seconds for creative
generation, 25 seconds for critic, and 20 seconds for component repair. Normal roles allow at most
two attempts; critic and component repair default to one. Backoff is independent and uses a
1,000 ms base, a 5,000 ms cap, and 0–750 ms jitter. A provider/model circuit opens after three
health failures in 60 seconds, cools down for 45 seconds, and admits one half-open probe.

Frame sampling starts alongside transcription. After transcript chunks exist, whole-video analysis
overlaps visual analysis/multimodal work. Long transcripts use extractive compression across the
timeline before the ordinary whole-video request. Small-context configurations retain the existing
hierarchical path. Both-provider failure yields an extractive transcript summary.

With ordinary provider performance, a planning estimate for 15 minutes is approximately 4–5 minutes:
73 seconds transcription + 45 seconds overlapping whole-video/visual work + two understanding waves
at 25 seconds + four creative waves at 20 seconds + four critic waves at 8 seconds + about 20 seconds
other media/database work = about 300 seconds. This assumes three provider/creative/critic workers,
two understanding workers, no failover and no extra repair round. These are assumptions, not a live benchmark.

For 60 minutes, a roughly linear 292-second transcription plus 45 seconds whole-video/visual work,
three understanding waves at 25 seconds, five creative waves at 20 seconds, five critic waves at
8 seconds and 60 seconds media/database work gives about 612 seconds (~10 minutes). The 10–15-minute
target remains dependent on actual provider and media-processing latency. Provider overload, retries,
long visual analysis or expensive repair rounds can exceed either target. The latest degraded-provider
baseline was about 650,877 ms (10m51s). The local timeout and prompt reductions are intended to move
that scenario toward the sub-six-minute target, but a fresh run of the same video is required to
measure the actual end-to-end improvement.

## Configuration and telemetry

`.env.example` and Compose expose `LLM_<ROLE_IN_SNAKE_CASE>_TIMEOUT_MS` and
`LLM_<ROLE_IN_SNAKE_CASE>_MAX_ATTEMPTS` for remote roles, plus bounded
`LOCAL_LLM_<ROLE_IN_SNAKE_CASE>_TIMEOUT_MS` values. `LOCAL_LLM_TIMEOUT_MS` remains the hard local
ceiling. Local whole-video evidence defaults to a 12,000-character compressed input budget.
Compose/provider defaults are two Gemini and two Nemotron Super concurrent requests, one Nemotron
Omni request, and two understanding workers. Creative and critic workers default to three and are
capped at four.
Explicit existing concurrency environment values still take precedence. `CLIP_JUDGE_BATCH_SIZE`
is no longer used because complete creative packages always run individually.

Each processing attempt logs one `pipeline_performance_summary` with video/job IDs, all twelve
requested `*Ms` fields, rawCandidateCount, aiShortlistCount, creativePackageCount,
llmRequestCountByRole, llmRequestCountByProvider, llmRequestCountByRoleProvider, retryCount,
failoverCount, circuitOpenCount, criticCount, repairCount, totalLlmCalls, cloudLlmCalls,
localLlmCalls, the deprecated cloud-only `totalCloudLlmCalls` alias, schemaRepairCount
and cacheHits. Optional enhancement calls stop at the configurable per-job call, critic, repair,
and retry budgets.
AsyncLocalStorage keeps request counters isolated between simultaneous jobs. Stage wall times
can overlap, so their sum is not totalMs. Skipped stages have zero current-attempt time.
The summary is logged, not added as a new database entity; existing stage timestamps remain persisted.

`exportMs` is zero in candidate-processing summaries because exports already run after user selection.
Actual later exports log `clip_export_performance` with exportMs and cacheHits. Candidate visibility
continues to be independent of MP4 export. No timer-based progress simulation was introduced.

## Validation

Passed: `npm.cmd run lint`, `npm.cmd run build`,
`npm.cmd --workspace apps/backend run test:multi-model`,
`npm.cmd --workspace apps/backend run test:clip-intelligence`,
`npm.cmd --workspace apps/backend run test:clips`, and the additional
`npm.cmd --workspace apps/backend run test:understanding`.

The clips command's FFmpeg integration subtest was skipped because this host has no FFmpeg binary.
The other clip/recommendation/UI/export-idempotency checks passed. New tests cover 76→15→10 budgets,
diversity, bounded batch concurrency, four-of-five partial recovery, candidate-ID alignment,
multimodal normalization/recovery, truncated JSON recovery, fixed retry timeouts, an actual abort-driven
failover deadline, the Gemini wire contract, stage timing and request/retry/failover/cache counters.

## Files changed

* `.env.example`, `docker-compose.yml`
* `apps/backend/package.json`
* `apps/backend/src/modules/processing/llm-provider.service.ts`
* `apps/backend/src/modules/processing/llm-router.service.ts`
* `apps/backend/src/modules/processing/clip-candidates.ts`
* `apps/backend/src/modules/processing/clip-intelligence.service.ts`
* `apps/backend/src/modules/processing/openai-clip-judge.service.ts`
* `apps/backend/src/modules/processing/clip-critic.service.ts`
* `apps/backend/src/modules/processing/video-understanding.service.ts`
* `apps/backend/src/modules/processing/video-processor.service.ts`
* `apps/backend/src/modules/processing/performance-telemetry.ts` (new)
* `apps/backend/src/modules/videos/clip-export.service.ts`
* `apps/backend/scripts/diagnose-gemini.cjs` (new)
* `apps/backend/scripts/test-pipeline-performance.cjs` (new)
* `apps/backend/scripts/test-clip-candidates.cjs`
* `apps/backend/scripts/test-video-understanding.cjs`
* `docs/live-video-performance.md` (this report)

Build outputs were regenerated. No production video was reprocessed and no deployment was performed.
