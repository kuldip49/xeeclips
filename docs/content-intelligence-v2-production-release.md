# Content Intelligence v2 production release — 2026-10-09

**Production acceptance failed and V2 was rolled back. The previous working release is live, maintenance is off, and disposable QA data is removed.** English human acceptance remains COMPLETE for Advice, Repaired Delivery and Cultural-Fusion. It certifies the reviewed artifacts; fresh production ingestion of Delivery did not pass.

| Requested result | Final result |
| --- | --- |
| V2 source commit | `9a027cd43c0cdbb85e4013bc3793ed9c17cd114f`, normally pushed to `kuldip49/xeeclips` `main`; message: `feat: improve contextual hooks and semantic clip endings` |
| Final regression | PASS: 25/25 current scripts, no skips; backend/shared/frontend type checks; 9 template visual cases; 18 final-hook renders; boundary, all three styles, Quick Reframe, editor/History, Ask AI hook rewrite, strong-hook preservation and explicit change-hook behavior. Eight PostgreSQL persistence checks passed in a new disposable database, subsequently removed. |
| Backend image/version | Live: previous `f9ad75c` image `sha256:bdd5dcbc97eabbe41dd6fa9538abde850baff67e3c5070bd83aa5e223bf8c437`, retained/running as `xeeclip-backend-rollback:before-ci-v2-9a027cd`. Attempted V2: `xeeclip-backend:9a027cd`, observed running image `sha256:b6aef58a386a7fa4cd8bbde48d304d23fb4a1acb70a8bfcf1360021773e516ed`. |
| Worker | Previous image restored: `sha256:b3597112644e7c4300fc38af2af9f1433dc384a52457fd49544f523cde347105`. Attempted minimal guard image `xeeclip-ai-service:9a027cd-guard` passed both sample-rate tests; its working dependencies and existing model mounts were preserved. |
| Frontend deployment version | Live, 100% traffic: `7ae450dd-b588-4127-8866-5233406375cf`. Attempted V2 static export: `d5edf697-e545-4603-84f4-fa84b8557b52`; rolled back. Static asset hosting/router retained. |
| Backup | PASS: fresh custom-format dump, 35,865,178 bytes; SHA-256 `2636c3188291e03c6c617b7af083adc118676325061af8b393ea4d6cd1d14fe6`. Restored with `pg_restore --exit-on-error --single-transaction` into isolated tmpfs PostgreSQL; user/clip/editor/Quick Reframe counts and total credits matched. No production restore or data repair. |
| Health | PASS after rollback: local/public API HTTP 200; AI and MinIO HTTP 200; public site, History, Quick Reframe and dynamic editor shell HTTP 200. Redis/database connections passed the final idle/fingerprint checks. |
| Maintenance status | OFF. Original tunnel configuration restored byte-for-byte, gate stopped, unauthenticated processing probes return normal 401 instead of maintenance 503. |
| Production start boundary | Candidate QA `START_COMPLETE` and `CONTEXT_SUFFICIENT` passed, retaining “Now, if you may recall yesterday”. No production output was delivered, so rendered start quality is not certified. |
| Production ending quality | FAIL acceptance: fresh ASR ended in “more like a metal...” rather than the reviewed “more like a Manuel.” Candidate `END_COMPLETE`, `THOUGHT_COMPLETE`, `CLAIM_RESOLVED`, `NO_DANGLING_CLAUSE` and `VIEWER_SATISFIED_END` failed. The gate refused rendering. |
| Production hook quality | NOT CERTIFIED. The candidate was rejected before accepted creative generation/rendering. The reviewed Delivery hook remains human-approved and unchanged in the local package. |
| StyleZero | Local regression PASS; V2 production smoke NOT RUN after the critical gate failure. |
| StyleOne | Local regression PASS; V2 production smoke NOT RUN after the critical gate failure. |
| StyleTwo | Local regression/render acceptance PASS; production Create Clips FAILED, zero delivered clips. |
| Quick Reframe | Local regression PASS; V2 production smoke NOT RUN after rollback. |
| Ask AI | Local rewrite/preservation/explicit-change and persistence checks PASS; V2 production smoke NOT RUN after rollback. |
| History/editor persistence | Local database checks PASS; V2 production round-trip NOT RUN. Restored History/editor routes pass health checks. |
| Auth/credits/ownership | Rollback checks PASS: both QA sessions owned their accounts; other-account project/source access denied with 404; empty other-account History; ordinary-user admin denied with 403. Failed generation released its reservation: QA balance remained 16, consumed credits 0. Complete fingerprints of all pre-existing users, projects, videos, clips, editor/assets/elements, Quick Reframes, credit reservations/transactions and sessions matched after cleanup. Generated-media ownership and complete V2 browser auth matrix were not exercised because no clip was delivered. |
| Rollback required | YES: production acceptance failed. Previous backend, worker and frontend restored. Earlier precautionary cutovers also rolled back for unordered mount comparison and probing worker health before model warm-up; those operational checks were corrected without changing application code or weakening health/path checks. |
| Final live status | Previous working release live and healthy; processing reopened. V2 code committed and pushed, **not live**. |
| Cleanup | Exactly two disposable accounts, their content/projects/sessions/usage and live reservations removed through owned APIs and guarded cleanup. Admin audit retained; revoked QA credential manifest removed. No persistent volume deletion. |

## Production failure evidence

The repaired, human-approved Delivery source was uploaded through the public Create UI as XeePro/ONLINE, one StyleTwo clip. Source analysis completed; delivery failed with `INSUFFICIENT_DISTINCT_SOURCE_MOMENTS`, one hard failure `REJECTED_BY_ANALYSIS`. The candidate covered 0–27.65 seconds and recorded `EXTENDED_TO_COMPLETE_THOUGHT,UNFINISHED_SENTENCE,UNRESOLVED_THOUGHT`. Its fresh transcript substituted the last name and ended with an ellipsis; content understanding consequently interpreted the ending as unresolved. No transcript, candidate, boundary signal, or credit record was manually inserted or corrected to bypass the gate.

This establishes failed production acceptance, not a proven new V2 defect: no controlled baseline ingestion comparison was performed. The native transcription/boundary interaction needs investigation before another V2 rollout. The accepted local English artifacts and their human sign-off remain valid.

Maintenance blocked new public mutations before reservations/dispatch, with exceptions scoped to the exact two disposable QA sessions. Two strict idle checks preceded each cutover and the final production rollback: BullMQ active/wait/delayed/prioritized/waiting-children/retry counts and database processing, imports, styling, Quick Reframe, exports and reserved credits were zero. Runtime environment, mounts and original fingerprints passed on the final attempted cutover. Rollback never restored the production database.

## Remaining limitations

- Real Hindi/Hinglish spoken-media certification: **PENDING**.
- Both synthetic language tests: **SYNTHETIC-ASR ACCEPTANCE INCONCLUSIVE**; no real-media certification claimed. No obvious forced-language/translation routing bug found; confidence-based downstream fail-safe remains unverified.
- Fresh production English ingestion failed on Delivery's ASR ending; V2 production quality and the remaining flow/style matrix are uncertified. No gate was relaxed to force an output.
- Previously documented unrelated stale candidate/understanding and worker-startup fixtures remain outside the required 25-script suite. Provider editorial scores/latency vary; local font/render acceptance is not a replacement for real multilingual media certification.

Evidence and verified backup are retained locally in `storage/content-intelligence-v2-release/` (Git-ignored): `backup-restore.json`, `idle-1.json`, `idle-2.json`, `backend-deployed.json`, `worker-deployed.json`, `create-state.json`, `failed-delivery-analysis.private.json`, `production-failure-rollback.json`, `rollback-security-checks.json`, `cleanup-result.json`, `final-health.json`, and `before-ci-v2-9a027cd.dump`. Authorized review material remains in `.real-qa-preview/creative-acceptance/human-review/`.
