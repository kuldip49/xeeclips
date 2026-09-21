# Phase 1 clip editing

The upload form stores `processingType` on the processing job. `NORMAL_CLIPS` is the
default. For `EDITED_CLIPS`, it also stores one of `9:16`, `16:9`, `1:1`, or `4:5`
(default `9:16`). The AI processing mode remains independent of this choice.

Candidate generation, scoring, content packages, and recommendation selection are
unchanged. The final clip is determined by the existing **Create clips** action.
That action renders the selected boundaries as before for normal clips. For edited
clips, the exporter first extracts the selected clip, then gathers its transcript,
word times, visual samples, and generated content. Only ONLINE jobs ask OpenAI
GPT-5.6 Luna for the structured `editingPlan`. OFFLINE and FALLBACK_ONLY use a
conservative deterministic plan and make no editing LLM call.

The validator rejects edits outside the selected range, cuts through timed words,
overlapping cuts, cuts over 15% of clip duration or four seconds, zooms outside
1.07–1.18, frequent zooms, and invalid hooks or overlays. An invalid or failed
Luna plan falls back to the selected clip with requested crop, timed subtitles,
and loudness normalization. No fabricated hook is added in fallback.

FFmpeg performs safe pause cuts, a stable editorial crop based on persistent face
positions (or person, then center), a smooth zoom envelope, ASS subtitle and overlay burn-in, loudness
normalization, and H.264/AAC encoding. Five reusable subtitle themes use Noto Sans,
high-contrast colors, mobile-safe margins, semantic two-to-five-word phrases,
and selective word emphasis. Overlay placement chooses the least face-occupied
region from platform-safe zones; optional text is omitted when no region is clear.
The rendered file is checked with ffprobe before storage. The edit plan and
per-clip telemetry are stored on `GeneratedClip`; aggregate telemetry is stored
on `ProcessingJob`.

Output sizes are 1080×1920 (`9:16`), 1920×1080 (`16:9`), 1080×1080 (`1:1`),
and 1080×1350 (`4:5`). The expected duration is the selected range less the
validated safe cuts; ffprobe must match it within 0.6 seconds. The FFmpeg chain
uses trim/concat for cuts, 30 fps scale and stabilized crop, zoompan with 10–15-frame
ease in/out and a held peak, ASS subtitle and overlay burn-in, optional `loudnorm`, and H.264/AAC
encoding. The executor does not add music.

Premium edited styling validates contextual hooks, rejects generic or title-repeated
hooks, limits zooms to three with at least 2.3 seconds between them, and reserves
scales above 1.14 for strongly emphasized speech. A deterministic timeline mapper
shifts subtitles, emphasized words, hooks, supporting text, zooms, and sampled
reframes after safe cuts. Per-clip and job telemetry includes rendered phrase,
highlight, hook, and callout counts; zoom count/scale; placement adjustments;
theme, platform preset, animation style, and timeline remapping.

Run `npm --workspace apps/backend run test:editing` for schema, validator, upload
persistence, mode routing, subtitle, and reframe checks. Run
`npm --workspace apps/backend run test:editing-media` inside the backend container
to exercise normal export and edited FFmpeg rendering. The media test skips when
FFmpeg is unavailable. A full live upload also requires the app services, a source
video, and configured online credentials for a Luna plan.

Face/person boxes come from sampled visual analysis frames. The editing camera
holds a stable crop while the subject remains within a 56% dead zone, keeps the
face inside a 76% horizontal safe region, and requires two samples before switching
to a distant face. A confirmed switch holds for 120 ms and eases over 400 ms.
Transcript speaker changes help choose between simultaneous faces when available.
When visual analysis is disabled or detections are unavailable, the crop is centered.
These are sampled detections rather than per-frame speaker identification, so complex
motion and overlapping speakers still need manual review. Phase 1 does not add background music, B-roll, cinematic
transitions, or a timeline editor.

Real-media QA used a 20-second, uncaptioned 1280×720 talking-head segment with
locally transcribed word timing and inspected face positions. The rendered H.264/AAC
output is 1080×1920 with 16 subtitle phrases, two emphasized words, an opening
hook, and a 1.15× zoom that returns to baseline. Frame inspection found two issues
that were corrected: a close-framed speaker blocked every original hook location,
so the renderer now tries a lower face-safe center position; adjacent subtitle
phrases briefly overlapped, so each phrase now ends when the next begins. This QA
run exercises the production executor but uses inspected face tracks rather than
the full upload/visual-analysis pipeline, which still needs a live end-to-end review.
An already-captioned portrait source was also rendered: its burned-in title and
word captions collided with newly generated graphics. Input videos with existing
text layers need separate source-text handling before they can receive another
full caption/hook layer cleanly.

## Files

Created:

- `apps/backend/prisma/migrations/20260913230000_processing_type_editing/migration.sql`
- `apps/backend/src/modules/processing/processing-type.ts`
- `apps/backend/src/modules/editing/edit-plan.ts`
- `apps/backend/src/modules/editing/edit-plan.service.ts`
- `apps/backend/src/modules/editing/editing-plan-validator.ts`
- `apps/backend/src/modules/editing/reframe.service.ts`
- `apps/backend/src/modules/editing/subtitle-phrases.ts`
- `apps/backend/src/modules/editing/subtitle-renderer.service.ts`
- `apps/backend/src/modules/editing/timeline-remap.ts`
- `apps/backend/src/modules/editing/visual-style-tokens.ts`
- `apps/backend/src/modules/editing/video-edit-executor.service.ts`
- `apps/backend/src/modules/editing/editing.module.ts`
- `apps/backend/scripts/test-editing.cjs`
- `apps/backend/scripts/test-editing-media.cjs`
- `docs/phase1-editing.md`

Changed:

- `apps/ai-service/app/main.py`
- `apps/ai-service/app/visual_analysis.py`
- `apps/backend/package.json`
- `apps/backend/Dockerfile`
- `apps/backend/prisma/schema.prisma`
- `apps/backend/src/modules/processing/llm-provider.service.ts`
- `apps/backend/src/modules/processing/llm-router.service.ts`
- `apps/backend/src/modules/processing/performance-telemetry.ts`
- `apps/backend/src/modules/processing/processing.module.ts`
- `apps/backend/src/modules/processing/provider-registry.ts`
- `apps/backend/src/modules/processing/video-processor.service.ts`
- `apps/backend/src/modules/videos/clip-export.service.ts`
- `apps/backend/src/modules/videos/videos.controller.ts`
- `apps/backend/src/modules/videos/videos.module.ts`
- `apps/backend/src/modules/videos/videos.service.ts`
- `apps/frontend/scripts/test-ai-mode-ui.cjs`
- `apps/frontend/src/components/clip-candidates-panel.tsx`
- `apps/frontend/src/components/upload-video-form.tsx`
- `apps/frontend/src/lib/api.ts`
