# Quick Reframe AI

Implementation and acceptance report, 2026-10-07.

## Processing order

**Input → Analyze → Clean → StyleOne → Preview → Edit → Export → History.**

Quick Reframe remains a separate top-navigation button and /quick-reframe page. It owns a concurrency-one BullMQ queue and canonical EditProject/asset/element/history records. It never invokes candidate discovery, clip ranking, highlight selection, or multi-clip generation, and never creates Video, ProcessingJob, ClipCandidate or GeneratedClip records.

Stage 1 analyzes the entire source (maximum 180 seconds) locally with the existing face/person, scene-boundary, OCR and Whisper services. Safe edge/black-bar crops protect detected faces, important visuals, captions and attribution throughout tracked movement. Authorized timed blur or dark covers address localized overlays; masks overlapping detected faces or information are rejected. Third-party attribution stays protected; selected own branding needs the existing explicit ownership declaration. No content-aware reconstruction is implemented.

The clean renderer consumes only the original VIDEO segment at 1×, with source audio at its original level. It strips all generated TEXT/SUBTITLE elements, style layout, zoom and grading. Cleanup, safe source crop and optional denoise produce a separate owned CLEAN reference asset. FFprobe verifies duration, dimensions, H.264/AAC and audio presence, followed by a complete decode. **A failure here prevents StyleOne compilation and composition.**

Stage 2 consumes those validated clean pixels. It calls the actual resolveCreativeStyle(AUTOMATIC_2), compileCreativeStyle, canonical editor command bundle, buildRenderPlan, buildEditModeAss and buildFfmpegArgs. AUTOMATIC_2_STREET3_LAYOUT remains the single geometry source: black 1080×1920 canvas; media window x=0, y=610, width=1080, height=700; existing EB Garamond serif hook with white/red semantic emphasis; existing white/lime active-word subtitle style and safe area. StyleOne’s existing full-frame fit branch keeps the entire cleaned source inside that fixed media window. A second face crop or semantic zoom does not alter the clean result.

Exports are one full-sequence 1080×1920 H.264 MP4 with AAC when applicable. Rendered previews are 540×960 with the exact same normalized layout, text rules and fixed card. A larger canvas does not create new source detail. User color and gain/mute edits apply once during composition; the intermediate retains original audio.

## Editing, captions and persistence

Original, Clean original and StyleOne are separate review modes. The editor retains source-crop/pinch controls, localized cleanup, optional hook wording, caption text, restrained color and original-audio controls. StyleOne’s canvas, media window, serif hook placement and caption style remain fixed. Hooks use the existing template’s whole-video timing. Small sources shorter than one second retain their actual duration.

Readable embedded subtitles stay in the cleaned source and suppress new subtitles. Missing subtitles can use local transcription. Partial/unreadable layers require explicit replacement; each detected old caption must be fully cropped out or covered before a new layer can be added. Blur alone does not qualify as removal. When recognition cannot locate uncertain subtitles, automatic replacement is blocked for review. The canonical generateCaptions grouper produces short original-word phrases. Real word timings are stored relative to each caption and drive the existing active-word highlights. No timings are invented; edited captions exceeding StyleOne’s two-line area are rejected for correction.

Clean assets are cached by source ID, crop/tracking, masks and denoise. The hash sorts object keys because PostgreSQL JSONB changes their order. Hook, caption, color and audio changes can reuse the clean pixels. A changed cleanup invalidates the clean review URL and renders Stage 1 again. Current previews/exports carry pipeline version, clean asset identity and project revision; exports from the previous processing version remain downloadable in History but are stale for the new workflow.

Owned previews and intermediates are bounded; final exports persist until deletion. History supports re-edit, download and canonical owned-media deletion. Operation tokens and cancellation guard worker writes. Serialization conflicts have bounded retries without bypassing revision checks. Existing PostgreSQL, Redis and MinIO volumes are preserved.

## Inputs and local AI

Uploads accept MP4, MOV, M4V and WebM up to 1 GiB, with existing disk-backed chunks, progress, retries and cancellation. Actual FFprobe duration rejects sources over 180 seconds without trimming. Incompatible codecs receive derived H.264 browser playback; the original remains immutable.

Public Instagram Reel/video and X/Twitter adapters retain strict URL validation, rights confirmation, the deployment approval flag, no cookies/login, platform CDN allowlists, HTTPS redirect validation, public DNS pinning and bounded downloads. Private, restricted, unavailable or unsupported links receive an upload alternative. X importing has security/parser checks; a real authorized X acceptance video remains unavailable.

Local analysis and transcription do not send video or transcripts to an external AI provider. Optional three hook suggestions use the configured OpenAI router only after separate explicit consent to send up to 8,000 transcript characters. **All acceptance tests use externalAiAuthorized=false**, following the user’s local-only preference. Manual hooks remain available.

## Verification of the two-stage update

- Shared/backend/frontend typechecks; backend and Cloudflare static builds.
- test-quick-reframe.cjs: conservative crops, moving-subject protection, charts, captions, attribution, URL validation and source-local render filters.
- test-quick-reframe-styleone.cjs: no generated clean overlays, actual StyleOne compiler/editor, canonical geometry/serif emphasis/caption styles, preview/export parity, source-only timeline, cache key order independence, short-source hook timing, and no Stage 2 after a clean read failure.
- Existing canonical render/text/Automatic 2 camera suites and unified-generation regressions (86 checks) passed.
- Chrome: all tools at 320, 360, 375, 390, 412, 430, 768, 1024 and 1440 px; no horizontal overflow or page errors; original four mobile bottom tabs preserved. Separate clean/StyleOne review and fixed portrait preview passed (4 tests).
- Live 8-second fixtures with readable embedded captions and missing captions passed both stages, preview, 1080×1920 export, ranged playback, History and undo/redo. Embedded captions were retained.
- A 180-second fixture passed full local analysis, clean, StyleOne preview/export, History and revision edits. Existing long-video pipeline row counts stayed unchanged. The initial implementation also tested rejection at 181 seconds.
- Final synthetic speech: 15.35 seconds, eight bounded caption cues, original/export audio correlation **0.999506**. A rendered late word at 2.72 seconds produced 5,400 lime pixels, verifying active-word timing beyond the first caption.
- Silent VP9 WebM: derived browser playback, tracked source crop and timed blur/cover passed Clean → StyleOne, with one 1080×1920 output and no fabricated audio.
- User-authorized Instagram Reel Dddut7lMvl7: **139.109342 seconds**, 135 face samples, readable embedded captions retained, exactly one full-sequence output. Original/clean audio correlation **0.999935**; original/export **0.999868**. The fixed media window matched the clean source at beginning/middle/end (RGB mean absolute error 0.146, 0.170 and 0.008 on a 0–255 scale); canvas corners remained black. All analysis/transcription stayed local.
- Public Chrome: both clean and StyleOne video playback, fixed portrait preview, comparison, History/re-edit, browser reload and mobile caption controls passed. Initial transient session-load failure passed on repeat after confirming the public API response.
- Controlled backend restart: persisted clean asset, current preview/export revisions, plan, History and ranged playback passed; owned deletion returned 404 for session, source, clean and export URLs.

Reproducible runners live in apps/backend/scripts: verify-quick-reframe.cjs, verify-quick-reframe-speech.cjs, verify-quick-reframe-styleone.cjs, verify-quick-reframe-word-highlight.cjs and verify-quick-reframe-persistence.cjs. Run real-media runners inside the backend container with the live stack. Disposable test records/media are deleted; the speech session can be temporarily retained for browser/restart checks. The StyleOne runner takes an explicitly authorized social URL and compares original/clean/export audio, fixed black canvas and source content at beginning/middle/end.

The initial version’s eight procedural cases (30-second top hook, 60-second side text, central overlay, moving graphics, embedded captions, missing captions, chart/grid and 180-second source), 181-second rejection, authorized 139.109-second Instagram import and History/restart/deletion passed before the processing-order update. Moving graphics are not proof of moving-face detector accuracy. The updated checks above specifically verify Clean → actual StyleOne.

## Deployment and limits

Frontend: https://xeeclip.me/quick-reframe, static Cloudflare Worker assets. Backend: the existing Docker stack on this Windows laptop via https://api.xeeclip.me. Follow production-deployment.md; never remove volumes. Cloudflare Worker version: 2458ef87-5071-48d1-8583-af04957bd646. This update needs no schema migration: CLEAN is an owned canonical REFERENCE asset.

Recognition samples at one frame per second and remains confidence-based. Tiny, fast-moving, low-contrast or unfamiliar text may need manual review. Conservative cleanup may preserve an overlay when removal would risk a face, attribution or important visual. Full-frame fit can make portrait content smaller within StyleOne’s wide media window. Silent sources stay silent. External AI hook generation remains untested per the user’s preference. The laptop must remain online, and CPU analysis can take several minutes.
