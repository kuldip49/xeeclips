# Three-hour source uploads

Create Clips and Clipper campaign source videos accept durations up to and including
10,800 seconds (3 hours). Upload preflight, the processing worker, clip-selection limits,
UI guidance and safe error messages use the new boundary. Videos over the limit are
rejected; sources are never truncated. The maximum requested clip count remains 30.

YouTube import defaults are also 10,800 seconds. Existing deployments with an explicit
`YOUTUBE_IMPORT_MAX_DURATION=7200` (or the legacy duration variable) must update that
setting to allow three-hour imports. Explicit lower operator limits remain respected.
The chunked upload size limit remains 4 GiB. Quick Reframe retains its separate
180-second contract; direct editor source capacity is unchanged.

## Verification — 2 November 2026

- Shared/backend builds and frontend static production build passed.
- Real FFmpeg/ffprobe media at 7,201, 10,800 and 10,801 seconds exercised HTTP multipart
  uploads; chunk completion and legacy buffer uploads exercised the exact three-hour
  boundary and over-limit refusal. Persistence/storage/queue/credit effects were stubbed:
  accepted uploads reached each once, repeated completion stayed idempotent, and rejected
  uploads reached none. The new check is included in `npm --workspace apps/backend run test:upload`.
- Nine Chrome cases passed at 1440px, 375px and 390px using actual media metadata and
  intercepted API responses. Exactly three hours uploads successfully; over-limit files
  show a friendly message before any project/upload request. No horizontal overflow.
- All 17 existing Clipper backend regression suites and all 8 frontend regression suites
  passed, covering campaigns, all styles, Quick Reframe, editor/export, XeeFree policy,
  and XeePro busy/refund behavior.
- Upload-session integrity, corrupt-media probing, retry classification, YouTube metadata
  limits, exact clip counts, safe public errors, and pipeline performance tests passed.
  The performance test was refreshed for the existing 40-candidate cap, current shared
  creative pipeline and explicit mocked Pro context. Processing budgets were not increased.

These checks validate duration admission and regression behavior, not the transcription
quality or completion time of a full three-hour production workload. No database migration,
production configuration change, push or deployment is part of this commit.

Browser reproduction after building the static frontend with an HTTPS test API origin:
run `node apps/frontend/scripts/serve-static-qa.cjs`, set `E2E_FRONTEND_URL` to
`http://127.0.0.1:3301` and `E2E_API_URL` to the same origin as the build, then run
`npx playwright test e2e/source-upload-duration.spec.ts` from `apps/frontend`.
FFmpeg and ffprobe must be on PATH for the media fixtures.
