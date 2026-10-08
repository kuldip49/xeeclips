# StyleTwo production release attempt — 2026-10-08

**Current result: crop-parity fix `f9ad75cd74e7b38e65d2a50e2b04e47200cf172c` passed local and live production acceptance, is deployed, and processing is reopened. Original attempts `64998bf` and `6f4a927` were rolled back. The historical attempt details below are retained; the final release results appear in the follow-up section.**

Commit `64998bfc8fa9284af8f0527ec52e7a77b383cc7e` was verified on `kuldip49/xeeclips` `origin/main`, built, and temporarily deployed behind a processing maintenance gate. The final manual-crop editor comparison exposed a reproducible preview/export position mismatch. The previous backend and static frontend were restored. Public health/routes pass, maintenance is off, disposable production QA accounts/content are removed, and all pre-existing database fingerprints match the pre-deployment snapshot. No application source or approved design was changed during this deployment attempt.

## Original 64998bf attempt: versions and production safety

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

Commit `6f4a92765186c65ddc02382ff7b95350e8c6e04e` passed the live manual-crop comparison (desktop 1 px, mobile 375 2 px, mobile 390 1 px) and both real editor round-trips. However, the canonical Quick Reframe editor's much smaller 177×315 mobile canvas measured **4 production pixels**, exceeding the strict gate. This attempt was rolled back: previous backend image `sha256:0f3da03e71ea55d1883945ab2f3f93eb63da3f1d550ffb141ad47de4b293b288` and frontend `63426d28-d505-4d4a-be29-c3f896af8192` restored; maintenance removed; two disposable accounts and their media removed; all original record/session/credit fingerprints preserved. Live cache replays and credit/Ask AI acceptance were interrupted by that failure and are not claimed as completed for `6f4a927`.

### Native FIT layout follow-up

The remaining bug was independent FIT picture/window layout in responsive CSS. At the actual tiny mobile canvas, fractional CSS rounding moved the whole source relative to the fixed window. Quick Reframe now uses the shared `styleTwoBakedCropTransform` and `styleTwoFitBox`: the entire 906×1152 baked source is retained, fitted to **676×860 at (202,630)**. The 4:2:0 overlay center is explicitly aligned down to its two-pixel chroma grid; manual 4:4:4 crops retain integer offsets without that restriction. Reduced server previews pass their actual target window to the same helper, so a 540×960 preview fits 338×430 at its existing chroma-aligned offset. There is no second source crop.

React draws video, black window matte and white bands on one native 1080×1920 coordinate plane and projects it once into the measured preview canvas. Source crop, manual scale/position, existing camera and zoom remain separate stages. StyleZero, StyleOne and uncropped non-Quick-Reframe StyleTwo retain their existing paths. The approved StyleTwo media window, typography, colors and text renderer are unchanged.

The exact retained production Quick Reframe project, baked source, **177×315 canvas at (99,108.15625)**, DPR 3 and five sample times were reproduced locally at both 375/390 viewport widths. The preceding bundle fails at 3 px with continuous native-viewport sampling (its original live clipped screenshots measured 4 px); the corrected bundle measures **1 px at every sample**. Native screenshots are also sampled at the continuous measured canvas bounds to avoid introducing integer CSS clip-origin rounding. The gate remains 2 production pixels and was not relaxed.

Final local manual-crop measurements are below. Values are maximum measured X/Y displacement in 1080×1920 production pixels. Shared serialized source rectangles, scale, translation and target boxes compare exactly. The remaining 2 px mobile image-alignment residual is reported explicitly; it is native video/screenshot rasterization, not a saved-coordinate change or a claim of exact pixel identity.

| Crop | Desktop | 375 | 390 |
|---|---:|---:|---:|
| Centered | 1 | 0 | 2 |
| Left-heavy | 0 | 1 | 1 |
| Right-heavy | 0 | 1 | 1 |
| Top-heavy | 1 | 0 | 1 |
| Bottom-heavy | 0 | 0 | 2 |
| Narrow | 0 | 1 | 1 |
| Wide | 1 | 0 | 1 |
| Exact failed production crop, five times | 0 | 1 | 2 |
| Crop + accepted zoom | 1 | 1 | 1 |
| Manual scale/position | 1 | 0 | 1 |
| Rotation/flip | 1 | 0 | 2 |
| Quick Reframe whole FIT, five times | 1 | 1 | 2 |
| Quick Reframe exact tiny production canvas | — | 1 | 1 |
| Service save/reload/Undo/Redo → export → React reopen | 0 | 1 | 2 |

All comparisons remain within the strict 2 px gate. Source19 still yields zero rendered emphasis zooms and zero recorded in-shot speaker switches; the zoom test is an accepted canonical local fixture. The source has burned-in text/padding and remains functional acceptance, not clean-source certification.

Fresh deterministic rerenders again match all **1,762 video / 2,744 audio frames** for each of StyleZero, StyleOne and StyleTwo no-crop. The new explicit Quick Reframe FIT filter matches its preceding filter in all **1,173 decoded video / 1,829 audio frames**. Canonical save/reload/Undo/Redo, caption correction persistence, 142 transform assertions, full StyleTwo suite, baked Quick Reframe full/reduced-preview regression, backend build, frontend types and static Cloudflare build pass.

Additional application files: `edit-mode-render-plan.ts` and `edit-mode-render.types.ts` carry a StyleTwo-only baked-source flag; `edit-mode-filtergraph.ts`, `edit-preview.tsx` and shared crop geometry consume the native FIT box. Additional evidence: `storage/style-two-crop-parity/{final-fit-deltas,tiny-before-deltas,tiny-fixed-deltas,fit-quick-deltas,fit-roundtrip-deltas,fit-regressions}.json`; actual MP4s, shared geometry, compiler arguments, preview/export pairs and differences remain in that directory.

The original production runtime independently stopped during the continuation. Docker startup failed on inaccessible stale UNIX socket entries. Only two verified socket-only runtime directories were quarantined intact; no configuration, secrets, database or volume storage was moved. The existing containers and public API recovered (200), and original data fingerprints matched exactly. A new 27,687,508-byte backup restored successfully into isolated PostgreSQL; SHA-256 `9bf91f243ea6ead69d1be773a0bde96dcd23a4db594baa04dd5de039c361579a`. Original counts: 3 users, 175 clips, 100 edit projects, 4 Quick Reframes, 26 total credits.

### Final production release — passed and reopened

Release commit **`f9ad75cd74e7b38e65d2a50e2b04e47200cf172c`** was committed and pushed to `kuldip49/xeeclips` `main` after local acceptance. Running backend: `xeeclip-backend:f9ad75c`, image `sha256:bdd5dcbc97eabbe41dd6fa9538abde850baff67e3c5070bd83aa5e223bf8c437`, with the exact OCI Git revision label. Final clean static Cloudflare frontend: **`7ae450dd-b588-4127-8866-5233406375cf`**. Static hosting/asset routing is preserved; no SSR was introduced.

Maintenance was verified before cutover; new public processing mutations were rejected before reservations. Login, reads, media, History and admin remained allowed, with processing exceptions restricted to two exact disposable QA sessions. Two strict idle snapshots passed before restart. Runtime environment, persistent mounts and original record fingerprints were checked after restart. One operational checker compared the same bind source as Windows `C:/projects/.../assets/music` and Docker Desktop's `/run/desktop/mnt/host/c/projects/.../assets/music`; it conservatively rolled back. After normalizing only that equivalent host-drive alias, all mount/environment/fingerprint checks passed on the repeated rollout. No application source or mount target was changed to bypass the check.

Actual production canonical-editor frames were captured after reload at **0.5/3/12/25/34 s**, desktop and mobile 375/390 widths, then compared to their real exports. All 30 frames pass the unchanged **2 production-pixel** rollback threshold:

| Live workflow | Desktop max X/Y | 375 viewport | 390 viewport |
|---|---:|---:|---:|
| Create → manual crop → StyleTwo | 1 | 2 | 1 |
| Quick Reframe saved crop → StyleTwo | 1 | 1 | 2 |

The shared serialized geometry matches exactly at every viewport. Quick Reframe retains all 906×1152 already-baked pixels, fits them once into the unchanged window, and performs no second automatic crop. The native window/background and approved hook/caption styling remain intact. The remaining 1–2 px mobile video/screenshot rasterization differences are recorded rather than claimed as zero. **No parity-triggered rollback was required for the final release.**

| Acceptance | Actual result |
|---|---|
| Source | Authorized `C:/Users/kuldi/Downloads/file (19).mp4`; same 0–39.1 s clip in all three styles; two main speakers, other people visible. Contains existing headline/padding, so this is functional testing rather than clean-source certification. |
| Live zoom / speaker switches | 0 rendered zoom events; 0 recorded in-shot speaker switches; 6 camera moves; 147 analyzed samples / 109 with faces; 0 face-safety violations; subject-safety ratio 98.58%. Existing planners unchanged. Accepted local 2.5 s zoom fixture passes crop parity; natural important-phrase zoom and in-shot speaker switching are not certified by this source. |
| Captions / audio | 26 groups, 112 positive-duration timed words; max start/end discrepancy `7.105427357601002e-15` s against the real SOURCE transcript. Subtitle/overlay bounds pass. Three zero-duration ASR entries remain the pre-existing transcript limitation. Audio lag: StyleTwo/StyleOne −5 ms (correlation 0.99923), StyleZero −21 ms (0.93587). |
| Create editor | Eight real browser steps pass: History → reopen → hook edit → caption-word correction → crop → Undo → Redo → export → reload. Exact saved crop, typography, plate style and corrected word persist. Revision-7 export matches the captured editor. |
| Quick Reframe editor / UI | Saved confirmed `(0.08,0.24,0.84,0.60)` crop persists. Hook/caption edits, Undo/Redo, canonical export and reload pass. Current-revision preview regenerated after edits; six chooser/preview/export/History/Re-edit/Edit More UI checks pass. |
| Cache isolation | Four sequential live requests: StyleTwo → StyleZero → StyleOne → StyleTwo. Three distinct canonical keys; repeated StyleTwo key stable; every delivered identity correct; no foreign-style output. All requests produced new clip IDs, so an actual cache hit is not claimed. |
| StyleZero / StyleOne regression | Live same-source renders pass; deterministic rerenders each match 1,762 video and 2,744 audio decoded frames. StyleTwo no-crop also unchanged; baked Quick Reframe old/new FIT outputs match 1,173 video / 1,829 audio frames. |
| Auth / ownership / UI | Secure browser login/logout and revocation, cross-account source/clip/editor/Quick Reframe/History ownership, ordinary-user admin denial, owner admin, authenticated byte-range media, desktop/mobile routes and no browser errors pass. |
| Credits / Ask AI | 11 settled QA outputs consume 11 credits from the disposable 16-credit allowance, leaving 5. A corrected checker's redundant pre-pass produced one extra QA render; its concurrent duplicate was rejected with 409. Zero-credit Create/Quick Reframe add no reservation. Consent denial, scoped mute proposal/apply/Undo and caption-correction persistence pass. Existing-user credits unchanged. |
| XeePro | Real ONLINE analysis and No Edit generation pass. The separate known edited-candidate face-lock rejection remains outside this crop-only fix. |
| Cleanup / reopening | Exactly two QA accounts and their owned media/projects/Quick Reframes/sessions/usage removed; audit entries retained; all original fingerprint checks pass; no live QA work/reservations. Original tunnel restored and validated, proxy stopped, revoked QA credentials removed. Clean frontend published, notice absent at 375/390, public/local health 200, normal unauthenticated processing returns 401 rather than maintenance 503. |

Final evidence is under `storage/style-two-fit-parity-release/`: `production-create-deltas.json`, `production-quick-deltas.json`, `source19-editor-results.json`, `qr-editor-roundtrip.json`, `qr-ui-check.json`, `cache-isolation.json`, `source19-mechanical-results.json`, `auth-ownership.json`, `credits-askai.json`, `pro-state.json`, `cleanup-result.json`, `runtime-recovery.json`, `backend-deployed.json`, `backup-restore.json`, `final-health.json`, and `acceptance-gates.json`.

- [StyleTwo final cropped output](C:/projects/ai-content-platform/storage/style-two-fit-parity-release/source19-editor-final.mp4)
- [Three-style comparison](C:/projects/ai-content-platform/storage/style-two-fit-parity-release/production-styles-comparison.png)
- [Corrected word and crop: preview/export pair](C:/projects/ai-content-platform/storage/style-two-fit-parity-release/parity-create/exact-t0.5-pair.png)
- [Manual crop preview/export pair at 25 s](C:/projects/ai-content-platform/storage/style-two-fit-parity-release/parity-create/exact-t25-pair.png)
- [Manual crop overlay](C:/projects/ai-content-platform/storage/style-two-fit-parity-release/parity-create/exact-t25-overlay.png)
- [Manual crop difference](C:/projects/ai-content-platform/storage/style-two-fit-parity-release/parity-create/exact-t25-difference.png)
- [Quick Reframe preview/export pair](C:/projects/ai-content-platform/storage/style-two-fit-parity-release/parity-quick/exact-t25-pair.png)

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

Full clean-source visual certification and in-shot two-speaker switching certification remain pending. Legacy ONLINE edited-clip face-lock rejection and the missed close-up→wide shot cut are separate issues; neither validator nor shared shot detection was changed during this deployment. Production XeePro smoke exercised ONLINE analysis + No Edit, not the known failing edited-candidate case. This source produced no rendered StyleTwo emphasis zoom, and its transcript has three zero-duration ASR entries. The former manual-crop and tiny Quick Reframe parity blockers are fixed; the final live release passes the strict 2 px gate.

The original `64998bf` and first crop fix `6f4a927` were both rolled back after their respective production parity failures. Native FIT follow-up `f9ad75c` is now deployed and reopened after passing live acceptance. No force push, destructive Git command, production DB repair, or volume deletion was performed.
