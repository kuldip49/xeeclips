# Temporary XeeFree-only availability

`XEEPRO_ENABLED=false` disables new Pro processing through one backend environment value. An unset flag preserves existing deployments; `true` restores Pro. Invalid explicit values fail closed. The provider configuration and Pro implementation remain intact.

`GET /videos/import-capabilities` exposes only `youtubeEnabled`, `xeeFree` and `xeePro`. It is safe to read before login. Create defaults to Free, disables the Pro radio until the server confirms availability, refreshes availability every 30 seconds and displays “XeePro is temporarily unavailable. XeeFree is available.” Quick Reframe’s optional Pro controls use the same endpoint.

New Pro uploads, imports, source retries and clip-selection requests return HTTP 409 with `code=XEEPRO_UNAVAILABLE` before source storage, queue mutation or credit reservation. The shared router/provider entry guard also refuses Pro calls before request construction or cache access. Existing Free guards, credit accounting, ownership and thresholds stay intact.

Existing Pro provenance remains Pro. Playback, History, manual edits and providerless export/download continue. Direct local editor commands remain available; requests needing fresh Pro wording/planning report product-level unavailability. No database migration or tier backfill is required.

To re-enable Pro, set `XEEPRO_ENABLED=true` in the ignored production `.env` and recreate the backend with the production release configuration. The static frontend reads the changed server state on reload or its next availability refresh; no frontend rebuild or provider configuration removal is needed.

Validation: 15 availability checks with zero network attempts; existing Free engine/policy and legacy checks; 33 isolated database auth/ownership/credit cases; 22 Create UI source contracts; actual desktop/mobile disable and mocked re-enable checks. Under six fail-fast provider traps, an owned authored-story fixture completes Free StyleZero/One/Two, History, local editor actions and Quick Reframe with zero provider entries/requests and zero cloud counters. An owned legacy fixture using a previously accepted Pro export opens, plays, saves, reloads, exports and downloads without new provider calls or credit charges; fresh Pro hook rewrite returns the unavailable response. Existing AI application source matches the candidate and remains unchanged. No live Pro smoke test is used.

The production release report is retained separately in the ignored `.real-qa-preview/xeefree-only-20261014/` folder. Authored speech exercises functionality and does not certify all human framing, languages or speaker switching.
