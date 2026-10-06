# Quick Reframe AI

Implementation and acceptance report, 2026-10-07.

## Product and architecture

1. **Navigation:** `/quick-reframe` is a standalone static-compatible page. Desktop navigation is Create, Quick Reframe, History, Settings. Mobile exposes Quick Reframe at the top while retaining the four existing bottom tabs.
2. **Isolation:** `QuickReframeModule`, `/quick-reframe` API routes, a dedicated BullMQ queue with concurrency one, and persisted operation tokens orchestrate imports, analysis, previews and exports. Sources and edits belong to canonical `EditProject`, `EditAsset`, `EditElement` and revision history records. No Quick Reframe operation creates long-video `Video`, `ProcessingJob`, `ClipCandidate`, or `GeneratedClip` records.
3. **Inputs:** MP4, MOV, M4V and WebM use the extracted existing disk-backed 20 MiB upload transport with retries, progress and cancellation. Actual local FFprobe results enforce 180 seconds, 1 GiB and supported resolution. Incompatible playback codecs receive a derived browser-compatible preview; the original source remains immutable.
4. **Social adapters:** Strict public Instagram Reel/video and X/Twitter status URL validation; explicit source rights; deployment flag `QUICK_REFRAME_SOCIAL_IMPORT_APPROVED`; public yt-dlp metadata without cookies or login; platform CDN allowlists; validated HTTPS redirects; pinned public IPv4 DNS; bounded download, socket, file and probe limits. Unsupported, private, restricted and unavailable media receive an upload alternative. Query tracking parameters are removed.
5. **Analysis:** Local OpenCV, MediaPipe/YOLO and PaddleOCR reuse the established visual engine. Subject sampling is bounded at one frame per second, with full-decode scene boundaries. OCR stores per-time wording, confidence and normalized geometry. Adjacent regions merge only when wording and position match. Verified text-layout reuse reduces repeated recognition; uncertain geometric regions remain explicitly unknown. Dense text/edges protect charts and screen content conservatively.
6. **Crop:** Full-frame, black-bar and decorative-edge candidates are scored against subject, caption, attribution, information, zoom and resolution constraints. Original, 9:16, square, 16:9 and custom framing are supported. Smooth tracked framing is used only when every sampled subject/information constraint and movement bound passes; otherwise the planner retains content using fit. Manual four-edge controls and pointer dragging/pinch remain available.
7. **Cleanup:** Timed source-local blur and dark covers, limited to localized regions. Auto Clean requires overlay-removal authorization before applying masks. Attribution remains protected automatically; manually selected own branding requires a separate ownership declaration. No background reconstruction is advertised or implemented.
8. **Hooks:** Optional three suggestions use the existing server-side OpenAI routing policy and an authorized transcript excerpt of at most 8,000 characters. Video pixels and credentials are never sent to the browser/provider for this feature. Suggestions can be selected, edited, positioned or disabled. Hook/face and hook/generated-caption collisions are rejected. Manual hooks work locally.
9. **Captions:** Local Whisper uses `transcribe` to preserve the original language; existing long-video requests retain their default `translate` behavior. `EXISTING_READABLE` retains the original layer; `MISSING` enables synchronized transcript captions; `PARTIAL_OR_UNREADABLE` requires explicit replacement and removal/coverage of detected old captions. Font, size, position, color and text are editable.
10. **Preview/export:** Original/Edited playback, synchronized comparison slider, scrubbing/fullscreen, crop and detected-region overlays. Rendered preview and final export use the same typed plan and proportional text geometry. Canonical FFmpeg/ASS utilities produce H.264 MP4 and AAC when the source contains audible audio. Output never gains genuine resolution by upscaling. Source timing, sequence and audio are kept at 1x; optional gain/mute are explicit. FFprobe checks duration, streams, dimensions and codecs; full output decoding rejects corruption.
11. **History:** Existing `/history` adds a Quick Reframe section with preview, re-edit, download and deletion. PostgreSQL, Redis and MinIO hold durable progress, plans and owned media. Deletion uses the canonical owned-asset removal path. Preview revisions prevent stale media from appearing as current edits; earlier exports remain labeled as earlier exports.
12. **Mobile:** The full tool set uses touch-sized controls and the existing safe-area/keyboard-aware bottom sheet, with accessible sticky export controls and no mobile desktop inspector.

## Verification

Focused tests: `scripts/test-quick-reframe.cjs`; Python nested OCR geometry and black-bar tests; shared/backend/frontend typechecks; backend and Cloudflare builds. Regression checks cover existing upload assembly, canonical render planning, color/audio, unified generation (86 checks), YouTube import, and FFprobe/extraction/retry classification.

Chrome responsive checks passed at **320, 360, 375, 390, 412, 430, 768, 1024 and 1440 px** with no horizontal overflow or page errors, all editing tools available, and the mobile bottom navigation unchanged.

| Real-media case | Result |
| --- | --- |
| 30 s portrait / decorative top title | Passed upload, OCR, preview, H.264/AAC export, ranges, History, undo/redo |
| 60 s landscape / side text | Passed the same full media workflow |
| Center overlay with explicit localized blur | Passed |
| Moving graphics | Passed; this procedural fixture is not evidence of moving-face accuracy |
| Embedded readable captions | Detected `EXISTING_READABLE`; original captions retained |
| Missing captions | Detected `MISSING`; optional manual hook rendered |
| Chart/grid content | Passed conservative analysis and export |
| Actual spoken tip, 13.05–13.15 s fixtures | Two synchronized caption cues; audio correlation **0.999618**; matching preview/export revision; visual geometry inspected; no unexpected black interval in the final export |
| Silent VP9 WebM | Derived H.264 playback, smooth tracked square export, timed blur/cover, no fabricated audio |
| 180 s / 181 s limit | 180 s passed full export; 181 s rejected without trimming |
| User-authorized Instagram Reel `Dddut7lMvl7` | 139.109 s imported, analyzed, previewed and exported; 37 timed regions, 135 face samples, `EXISTING_READABLE`; full-frame plan preserved faces and original captions; no external AI |
| Backend restart | Persisted export, plan, captions, History and ranged playback passed after restart and image update |
| Owned deletion | Deleted the disposable session; source/export URLs and session then returned 404 |
| Public Chrome | Real edited MP4 playback, comparison, History/re-edit, browser reload and mobile caption controls passed on `xeeclip.me` |

Reproducible real-media runners: `scripts/verify-quick-reframe.cjs`, `scripts/verify-quick-reframe-speech.cjs`, `scripts/verify-quick-reframe-persistence.cjs`. Run them inside the backend container with the live stack. Fixtures are disposable and removed; the speech session can be explicitly retained temporarily for a controlled backend restart check. Instagram/X tests require an authorized eligible link. A passing URL parser is never reported as a passing import.

## Deployment and limits

Frontend: `https://xeeclip.me/quick-reframe`, static Cloudflare Worker assets. Backend: existing Docker stack on this Windows laptop via `https://api.xeeclip.me`. Follow `production-deployment.md`; never remove volumes. New migration only adds Quick Reframe records and their canonical-project relation. The ignored production `.env` enables approved public social imports; `.env.example` defaults that gate off.

Recognition is sampled and confidence-based, rather than guaranteed frame-perfect segmentation. Tiny, rapidly moving, low-contrast or non-English baked-in text may need manual review. Conservative crops often retain the full frame; fit intentionally adds aspect-ratio padding. Masks use detected time ranges and positions; fast motion between samples can need manually adjusted regions. No content-aware reconstruction is offered. Silent sources remain silent. The deployment's existing account-independent access model is preserved.

Live external AI hook generation was **not tested**, per the user's local-only instruction. X import has URL/security tests but still needs a real authorized X acceptance video. The laptop must stay online; CPU analysis can take several minutes. No universal automatic face-safety or overlay-removal guarantee is made.

The eight procedural acceptance cases left existing long-video pipeline row counts unchanged. Public Cloudflare deployment: Worker version `ce2d1b28-23b0-4b1e-b03d-f42f12bc91a2`. The first live Instagram attempt exposed a Node 22 lookup callback mismatch; the corrected adapter handles both single-address and all-address callbacks while retaining DNS pinning, and the subsequent real import/export passed.

Final edge checks also reject simultaneous masks exceeding 30% of the frame and hooks overlapping original captions. Two-pixel cleanup regions use a Gaussian fallback because FFmpeg box-blur kernels cannot fit such a small region; a real export/decode test covers this case. Quick Reframe decoding and playback normalization permit only local file/pipe inputs and supported media demuxers; existing YouTube defaults are unchanged.
