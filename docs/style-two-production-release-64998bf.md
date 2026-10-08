# StyleTwo production release attempt — 2026-10-08

**Original release result: acceptance failed and 64998bf was rolled back. Follow-up crop fix: local acceptance passed; production rollout is pending strict idle checks.**

Commit `64998bfc8fa9284af8f0527ec52e7a77b383cc7e` was verified on `kuldip49/xeeclips` `origin/main`, built, and temporarily deployed behind a processing maintenance gate. The final manual-crop editor comparison exposed a reproducible preview/export position mismatch. The previous backend and static frontend were restored. Public health/routes pass, maintenance is off, disposable production QA accounts/content are removed, and all pre-existing database fingerprints match the pre-deployment snapshot. No application source or approved design was changed during this deployment attempt.

## Versions and production safety

| Item | Observed result |
|---|---|
| Previous/final backend | `sha256:0f3da03e71ea55d1883945ab2f3f93eb63da3f1d550ffb141ad47de4b293b288`. The previous image has no Git revision label; its source commit cannot be independently asserted. |
| Rollback image retained | `xeeclip-backend-rollback:before-64998bf`, now running. The original image and separately tagged release image also remain available. |
| Attempted release image | `xeeclip-backend:64998bf`, inspected image `sha256:845a8bf8ad180d49b73aefea4253fc3edb08b833d156912df28575aae141bb2d`; OCI revision label contains the full release commit. |
| Previous/final frontend | Cloudflare version `63426d28-d505-4d4a-be29-c3f896af8192`, restored to 100% of traffic. |
| Initially deployed release frontend | `8421e250-26be-4b92-9b11-65c4c2181bd4`. Temporary maintenance-notice versions were subsequently deployed and then rolled back. |
| Hosting | Existing static export/static asset router preserved. No SSR introduced. |
| Maintenance | Enabled 16:25:02 IST; ended 17:10:03 IST after restoring the previous healthy production release. Exact requested message shown. |
| Gate | Temporary loopback proxy blocked public processing mutations before reservation/dispatch; login, account preferences, admin and reads/media stayed available. Only the exact disposable QA sessions could process smoke tests. Original tunnel configuration restored and proxy stopped. |
| Backup | Fresh `before-64998bf.dump`, 26,170,606 bytes; SHA-256 `b26ee8bbb3fc0d78699894521660b3d45dad417dd51285b0e644bef44b8474b8`. Successfully restored with `pg_restore --exit-on-error --single-transaction` into an isolated tmpfs PostgreSQL instance; user/clip/editor/Quick Reframe counts and total credits matched. Production database was not restored or manually repaired. |
| Idle gates | Twice before release restart and twice before rollback: every BullMQ active/wait/delayed/prioritized/waiting-children/retry count zero; database processing, clip rendering, imports, styling, Quick Reframe, editor exports and reserved credits zero. Two historical `IMPORT_FAILED` records were verified terminal and left unchanged. |
| Health | Attempted release and restored backend: local/public health HTTP 200. Database query, Redis connectivity and all four worker registrations, MinIO and AI-service health passed. Final site, History, Quick Reframe, admin and dynamic editor shell HTTP 200. |
| Configuration/data | Existing environment and mounts preserved exactly. After cleanup/rollback, original row counts and complete fingerprints match for users (excluding login timestamps), projects, videos, clips, editor projects/assets/elements, Quick Reframe, credit reservations/transactions and sessions. |
| Cleanup | Exactly two identified disposable accounts and their production content removed through owned APIs and the existing guarded operator cleanup. QA audit entries retained. Original users and content untouched; no Docker volumes deleted. Local report/media evidence retained. Revoked QA credential manifest removed. |
| Final submissions | Public mutation probes return normal authentication denial (401), rather than maintenance 503. No new real-user jobs were submitted to prove reopening. |

## Production smoke evidence

Source: authorized `C:\Users\kuldi\Downloads\file (19).mp4`, 1080×1920, 30 fps, 39.1 seconds. Two principal participants appear across edited debate shots, with other visible participants/bystanders. Portrait padding and embedded on-screen text are present: **this remains functional smoke evidence, not clean-source certification**.

No production candidate, transcript, detection or credit reservation was manually inserted or repaired. Create Clips was submitted through the public browser as XeeFree/StyleTwo. The same upload was then requested as StyleZero and StyleOne. All three delivered the same 0–39.1-second source interval. A second upload of the same source exercised XeePro ONLINE analysis and No Edit generation; five OpenAI requests were recorded and the effective mode stayed ONLINE.

| Check | Result and scope |
|---|---|
| StyleTwo Create Clips | PASS: browser selection/upload, real pipeline generation, authenticated playback, History and canonical editor. Identity `AUTOMATIC_3_STYLE_TWO`. |
| Approved composition | PASS: 1080×1920 white canvas, fixed (0,630,1080,860) window; Roboto Condensed Bold hook (44.5 design units / 80.1 production), black centered; Anton captions (52.5 / 94.5), 1.05 line height, white on rounded `#B0321B` plates with dark edge/shadow. No design retuning. |
| Motion/crop telemetry | 0 rendered zooms, 0 recorded in-shot speaker switches, 6 camera moves, 147 sampled frames, 109 with faces, 0 reported face-safety violations. Export subject-safety ratio 98.58%. No short zooms occurred. Positive important-phrase zoom and in-shot speaker switching were not exercised/certified by this source. Canonical zoom policy/renderer tests passed. |
| Captions | 26 groups, 112 positive-duration timestamped words; maximum reconstruction error about `7.1e-15` seconds. All positive-duration transcript words represented. Three zero-duration ASR entries (`works.`, `Yeah,`, `so`) were excluded by existing caption handling; they are not counted as successfully captioned words. Subtitle/overlay bounds passed. |
| Audio | StyleTwo/StyleOne correlation to source 0.99923, measured offset −5 ms; StyleZero 0.93587, −21 ms. Video/audio streams, monotonic packet timestamps, planned duration and final-frame decoding passed. |
| Boundaries | Full supplied source retained, first timed word “Like,” begins at 0; last word “world.” ends 38.99 before the 39.1 export end. The last sentence completes. The conversational opening's standalone context remains limited by the supplied excerpt; full clean-source semantic certification is not claimed. |
| Quick Reframe | PASS: manual crop x=.08, y=.24, w=.84, h=.60 → baked 906×1152 → first-class `/styletwo` route → 540×960 preview → 1080×1920 export → History → reopen. No StyleTwo UI/path 404. |
| Saved crop / no second crop | PASS at four instants: picture fitted to 676×860 at x=202, y=630; mismatch from baked source 0.88–1.26/255, best shift (0,0). A deliberate 12% second crop differs by 16.4–22.0/255. Correct black window matte and white canvas; no stretching. |
| Quick Reframe preview/export | PASS at 3/12/25/34 s: mean absolute error 2.24–2.54/255, color bias ≤1.33/255, geometry within documented tolerance; Class A rasterization/codec residual. |
| Create editor state round-trip | PASS: History → hook edit → one caption-word edit → manual crop → Undo/Redo → export revision 7 → reload. Identity, typography, red plates, correction and crop state persisted. **Final preview/export camera position fails the parity gate below.** |
| Quick Reframe editor | PASS: canonical hook/caption edits, Undo/Redo, export, History/current revision, reload; exact confirmed source crop and StyleTwo identity persist. |
| Cache/template isolation | PASS for distinct settings keys and correct delivery identity across four alternating live requests. No foreign-style render returned. All four requests produced new clip IDs; this does not claim an actual render cache hit. |
| StyleZero regression | PASS live render; deterministic fixture's 1,762 decoded video frames and 2,744 audio packets identical to approved baseline. |
| StyleOne regression | PASS live render and Quick Reframe regression; deterministic fixture's 1,762 video frames and 2,744 audio packets identical to approved baseline. |
| Auth/ownership/credits | PASS: secure browser cookies, login/logout revocation, account isolation for source/clip/editor/Quick Reframe media and History, ordinary-user admin denial, owner admin access. Ten settled QA outputs consumed ten credits from a 16-credit allowance. Zero-credit Create/Quick Reframe rejected without adding reservations. |
| Ask AI | PASS: consent denial, scoped proposal/apply/Undo, caption correction preserved. |
| Desktop/mobile/routes | PASS at 1440 and 390 pixels, including editor shell and account/settings, with no final browser errors. A temporary static maintenance banner initially caused React hydration errors; corrected by attaching the notice after hydration, then removed entirely on rollback. |

## Release-blocking defect

**Manual crop in the StyleTwo automatic editor preview does not match the export's video position.** Hook, caption plates and fixed window stay aligned; the subject image drifts vertically by approximately 5–7 pixels at 1080 production scale.

At timeline 0.5/3/25/34 seconds, alignment finds 3–4 preview pixels of vertical displacement (preview inner width 678), exceeding the existing ≤2-preview-pixel camera alignment tolerance. The 12-second FIT sample passes. Geometry, color and overall image-error checks pass; the displacement check fails and is classified **B: investigate**, rather than silently relaxing the threshold.

The browser's video transform is `scale(1.06) translate(0.0001%, 0.0001%)` after the manual crop. The shared card preview overwrites its transform origin with the face-camera target (e.g. `50% 54.4682%` at 3 s and `50% 56.5427%` at 25 s). This scales the manual source crop around that target rather than the source center used by the exporter. A diagnostic **browser-only** override to `50% 50%` makes both samples pass Class A, confirming the source of the mismatch. That override was not saved or deployed, and is not a complete implementation for simultaneous crop + zoom/rotation.

Relevant code: `apps/frontend/src/components/edit-mode/edit-preview.tsx`, the combined video transform and card `transformOrigin` assignments. A follow-up fix must compose the source crop around its source center while keeping zoom focused on the camera target, scope changes to StyleTwo, and rerun cropped preview/export comparisons with and without zoom. It must preserve the approved design and existing StyleZero/StyleOne behavior. **A new validated follow-up release is required; commit 64998bf alone did not pass.**

## Crop parity follow-up — 2026-10-08

Local acceptance passes. The authorized source and exact retained revision-7 project from the failed production attempt were reused. No hook/caption design, font, color, content intelligence, speaker planner, zoom planner, shot detection, ONLINE, auth or credit behavior was changed.

### Root cause and coordinate trace

The old preview combined manual source-crop fit and camera zoom on one video element, then overwrote the crop's center origin with the face-camera target. At 25 s the resulting center-to-face shift is approximately `(.06 × (.565427 − .5) × 1920) = 7.54` source pixels before raster/codec rounding. Its manual inset math also retained fractional source coordinates while FFmpeg used even crop dimensions and chroma-aligned offsets. Mobile compositing added another fractional raster stage.

The saved normalized crop remains `{top:0.028301,left:0.028301,right:0.028303,bottom:0.028303}`. Both consumers now resolve it through `packages/shared/style-two-crop.cjs`:

1. Nearest integer source rectangle: `(31,54,1019,1811)` on the 1080×1920 source.
2. Fit into the original source frame: `(0,0,1080,1919)`, with one bottom padding pixel. Crop fit scales are `1.0598626104` and `1.0596355605`; the tiny axis difference is integer raster rounding, rather than an aspect-fill stretch.
3. Optional manual scale/position on that normalized source frame, using the same integer scaled dimensions and clamped integer translation.
4. Existing camera path, with its existing focal position rounded explicitly to the nearest raster pixel. For example, 3 s resolves source camera Y `615.7888 → 616`; 0.5 s resolves `640.7392 → 641`. The shared camera serializer writes `round(...)` into the existing FFmpeg expressions. No camera decisions are replanned.
5. Existing camera zoom remains outside the cropped source layer; final target is exactly `(0,630,1080,860)` on the white 1080×1920 canvas.

React consumes these pixel boxes through separately clipped crop/rotation, fit/pad and scale stages inside a production-coordinate surface, projected once to the measured preview. FFmpeg consumes the same boxes as explicit `crop`, `scale` and `pad` values. The backend resolves each segment's manual geometry once. Source geometry uses `yuv444p` and `crop:exact=1`, so odd X/Y offsets do not silently align to another source pixel. Conversion to `yuv420p` remains at the final encoder boundary. Saved normalized insets retain the existing six-decimal precision. Nearest-integer ties round upward; a spare padding pixel goes on the bottom/right via `floor(slack/2)`. No intermediate even restriction is imposed where the filter does not need it.

The guarded path requires StyleTwo **and a non-neutral VIDEO crop**. StyleZero, StyleOne and fully uncropped StyleTwo retain their existing filter arguments and preview path. Quick Reframe's confirmed source crop is already baked: this transform reads only the editor VIDEO crop and never reinterprets `confirmed.crop` as another automatic crop.

### Measured local acceptance

All values below are **1080×1920 production pixels**, not preview pixels. Actual React video frames and actual FFmpeg MP4 frames were compared in four textured quadrants with image-gradient alignment. Device-resolution mobile screenshots avoid an intermediate CSS-pixel downsample. White bands, hook vectors, plates and window stayed in the approved composition; source position was tested separately from color/codec differences.

The exact old preview versus retained old export measured Y offsets **5,5,1,6,4 px** at 0.5/3/12/25/34 s; X offsets reached 2 px. The 12 s whole-frame FIT sample was already aligned. Across these samples, quadrant-to-quadrant width/height drift was at most 1 px; the defect was predominantly translation. After the fix, the exact crop measures at most **1 px in X/Y** at all five times on desktop, 375 and 390 widths. The target window retains zero width/height change. Shared source rectangle, scale and translation compare exactly between preview and compiler.

| Crop case | Desktop max X/Y | 375 px viewport | 390 px viewport |
|---|---:|---:|---:|
| Centered (8% all edges) | 1 | 0 | 1 |
| Left-heavy (26% / 1%) | 1 | 1 | 0 |
| Right-heavy (1% / 26%) | 1 | 1 | 1 |
| Top-heavy (26% / 1%) | 1 | 0 | 1 |
| Bottom-heavy (1% / 26%) | 1 | 0 | 1 |
| Narrow (32% both sides) | 1 | 1 | 1 |
| Wide (32% top/bottom) | 1 | 0 | 1 |
| Exact production crop | 1 | 1 | 1 |
| Crop + accepted 2.5 s zoom, sampled at 5.5 s | 1 | 1 | 1 |
| Crop + manual scale/position | 0 | 0 | 1 |
| Crop + 7° rotation/horizontal flip | 1 | 0 | 1 |

The zoom fixture is a local canonical EFFECT, accepted by the unchanged real safety/zoom planner; it is not a fabricated production event or a claim that source19 naturally produced an important-phrase zoom. The source19 baseline still has zero rendered zooms and zero recorded in-shot speaker switches.

Quick Reframe reuses the actual retained 906×1152 baked source from confirmed `(0.08,0.24,0.84,0.60)`, fitted whole in the fixed window. Desktop alignment is zero at five sample times; mobile comparison is ≤2 px on the untouched, existing 4:2:0 whole-fit path. No second crop is present. Its canonical registry/route, no-double-crop and StyleOne isolation tests pass again.

Real service commands edited the hook and one caption word, saved the exact crop, reloaded, undid, redid and reloaded again. Geometry compared exactly, StyleTwo typography remained, and the caption correction/plate color survived. The resulting canonical project was exported and reopened in the actual React preview at both mobile widths. The separate production browser History/editor round-trip will be repeated after the deployment gates pass.

StyleZero and StyleOne deterministic regression renders match all **1,762 decoded video frames and 2,744 decoded audio frames** each. The StyleTwo no-crop baseline also matches all **1,762 / 2,744** frames. Backend build, frontend TypeScript check, 142 existing transform assertions, StyleTwo identity/cache/caption tests, canonical zoom tests and both Quick Reframe style tests pass. Tests are in the normal `test:style-two` command; the real-media verifier and measurement script are checked in for reproducibility.

Changed application files: shared `style-two-crop.cjs` / declarations, backend `edit-mode-filtergraph.ts`, frontend `edit-preview.tsx`. Verification files: `test-style-two-crop.cjs`, `verify-style-two-crop-parity.cjs`, `measure-style-two-crop-parity.py`, backend test command. Approved design constants and text renderer are unchanged.

Evidence under `storage/style-two-crop-parity/`: `before-deltas.json`, `final-deltas.json`, `regressions.json`, `quick-deltas.json`, `roundtrip-deltas.json`; `final/exact.mp4`; per-case preview, pair, overlay and difference PNGs; compiler arguments, render plans and canonical JSON. Full-source certification and the separate legacy ONLINE/shot-cut limitations remain pending as described above.

### Follow-up production status

The first preflight found one real active clip-render job, confirmed both in BullMQ and the database. Production was not restarted or modified to clear it. Commit/push and release preparation proceed after local acceptance; deployment must still obtain a fresh restorable backup, two strict idle checks, maintenance gating and live production parity ≤2 px. This section will be updated with the actual release result and versions.

## Evidence

Local files under `C:/projects/ai-content-platform/storage/style-two-release-64998bf/` are ignored by Git and contain report artifacts; production QA media has been removed.

- [Three-style comparison](C:/projects/ai-content-platform/storage/style-two-release-64998bf/production-styles-comparison.png)
- [StyleTwo output](C:/projects/ai-content-platform/storage/style-two-release-64998bf/styletwo.mp4)
- [Final cropped editor preview/export comparison](C:/projects/ai-content-platform/storage/style-two-release-64998bf/source19-editor-reloaded-t0.5-pair.png)
- [Parity failure measurements](C:/projects/ai-content-platform/storage/style-two-release-64998bf/automatic-final-parity.json)
- [Browser-only origin diagnostic](C:/projects/ai-content-platform/storage/style-two-release-64998bf/crop-origin-diagnostic.json)
- [Diagnostic parity results](C:/projects/ai-content-platform/storage/style-two-release-64998bf/origin-center-parity.json)
- [Quick Reframe crop measurements](C:/projects/ai-content-platform/storage/style-two-release-64998bf/quick-pixel-qa.json)
- [Quick Reframe parity](C:/projects/ai-content-platform/storage/style-two-release-64998bf/quick-parity.json)
- [Caption/audio/export QA](C:/projects/ai-content-platform/storage/style-two-release-64998bf/source19-mechanical-results.json)
- [Cache isolation](C:/projects/ai-content-platform/storage/style-two-release-64998bf/cache-isolation.json)
- [Deterministic regression](C:/projects/ai-content-platform/storage/style-two-release-64998bf/deterministic-regression.json)
- [Cleanup and preservation](C:/projects/ai-content-platform/storage/style-two-release-64998bf/cleanup-result.json)
- [Rollback verification](C:/projects/ai-content-platform/storage/style-two-release-64998bf/rollback-result.json)
- [Final public health/routes](C:/projects/ai-content-platform/storage/style-two-release-64998bf/final-health.json)

## Remaining limitations

Full clean-source visual certification and in-shot two-speaker switching certification remain pending. Legacy ONLINE edited-clip face-lock rejection and the missed close-up→wide shot cut are separate issues; neither validator nor shared shot detection was changed during this deployment. Production XeePro smoke exercised ONLINE analysis + No Edit, not the known failing edited-candidate case. This source produced no rendered StyleTwo emphasis zoom, and its transcript has three zero-duration ASR entries. The new manual-crop preview mismatch above blocks releasing this exact commit.

Git HEAD remains `64998bfc8fa9284af8f0527ec52e7a77b383cc7e`. No follow-up application commit, force push, destructive Git command, production DB repair, or volume deletion was performed. This deployment report is an uncommitted documentation artifact.
