# EditMode Phase 4 — presets and no-prompt auto edit

Phase 4 adds reusable presets and automatic editing that needs no prompt. It introduces no AI chat,
no natural-language edit planner, and no rendering.

## Architecture

```
source + cached transcript/analysis
        ↓
preset policy (typed enums)
        ↓
content-aware preset planner
        ↓
validated EditMode commands
        ↓
EditProject / EditElement / EditHistory   ← the same canonical state manual editing uses
        ↓
existing manual editor
```

Manual editing and presets share one mutation path. `EditModeService.applyElementCommand` is the
single element mutation function: Phase 2/3 manual commands and preset-generated commands both go
through it, then through `normalizeVideoTrack` and `validateTimeline`. A preset cannot reach the
timeline by any route that skips the validation the manual editor is held to.

No preset code writes `EditElement` rows, patches `settings` directly, or emits FFmpeg. There is no
generic JSON mutation command.

## Presets are policies, not templates

A preset is a typed policy — `aspectRatio`, `pacing`, `subtitlePolicy`, `hookPolicy`,
`reframingPolicy`, `zoomPolicy`, `textPolicy`, `audioPolicy`, `overlayPolicy`, `gradingPolicy`,
`informationRegionPolicy` — all closed enums (`apps/backend/src/modules/edit-mode/presets/edit-preset-policy.ts`).
The planner decides what the specific source justifies:

- one visible speaker → single-speaker framing
- two comparable faces that both survive the crop → pair composition preserved, stated as a note
- `FACE_FOCUSED` requested but no reliable face → falls back to `AUTO`
- charts / slides / screen content ≥ 40% of the shot span → `INFORMATION_PRESERVING`, zoom refused
- no semantic emphasis in the transcript → zoom `OFF`, whatever the preset asked for
- no shot safe to punch in on → zoom `OFF`
- no grounded headline available → hook `OFF`
- source already vertical (aspect ≤ 0.7) → no destructive reframe, aspect stays `SOURCE`
- no product image or logo uploaded → no product overlay is invented
- no call to action spoken in the source → no CTA text is invented

There is no "podcast always gets five zooms" and no "educational adds text every ten seconds".

## Cached analysis reuse

The planner reads only `EditAsset.transcript` and `EditAsset.analysis`, persisted by the Phase 1
**Analyze source** step. Preview and apply never call `/transcriptions`, `/edit-analysis` or
`/visual-analysis`, and never re-transcribe. A source that was never analysed still plans — project
policy only — and the proposal says so.

The frozen editing intelligence is reused as pure callable logic, with its own defaults unchanged:
`classifyShots` / `classifyFrames`, `detectInformationRegion`, `buildSubtitlePhrases`,
`detectSemanticZoomCandidates`, `buildEditedTimeline`, and `deterministicHook` / `chooseBestHook`.

## No-prompt behaviour

Choosing a preset and pressing **Preview changes** is the whole interaction. No prompt is requested
or accepted in this phase.

## PREVIEW and APPLY

`POST /edit-mode/projects/:id/preset/preview` returns a structured proposal and writes nothing: no
revision bump, no elements, no settings, no history. `POST /edit-mode/projects/:id/preset/apply`
re-plans against the current revision and commits the bundle in one transaction.
`GET /edit-mode/presets` returns the catalogue.

Both accept an optional `revision`; a stale value is rejected before any work is done.

## One preset application is one history revision

An apply writes exactly one `EditHistory` row: `actor: PRESET`, `action: APPLY_PRESET`, with the
folded command count on `command`. Its `beforeState` and `afterState` carry **both** `elements` and
`settings`, so one undo restores the complete pre-preset project and one redo restores the complete
applied project. Entries written before Phase 4 carry no `settings` and are restored as before.

## Ownership metadata and reapply

Every created element is stamped in `EditElement.properties`:

- `origin`: `USER` | `PRESET` | `ASSISTANT` — manual adds default to `USER`
- `presetId`, `presetRunId`, `presetRole` (`HOOK`, `SUBTITLE`, `KEY_POINT`, `CTA`, `PRODUCT`, `LOGO`, `MUSIC`)
- `createdAtRevision`

A reapply removes only elements whose `origin` is `PRESET` and leaves every `USER` element — logo,
custom text, image, music, trim, arrangement — untouched. Preset elements are replaced, never
duplicated. No schema change was needed: `EditHistoryActor` already had `PRESET`, and
`EditElementType` already had `SUBTITLE`.

Video trims are handled by ownership too. The preset trims the lead-in and tail only when the clip
is pristine or carries the trim the previous run recorded in `settings.presetRun.trims`; a trim the
user made by hand is never overwritten, and reapplying is idempotent for the source trim. The trim
is also skipped when a surviving manual overlay reaches past the shortened end.

## Persisted project style

`EditProject.settings` carries the style block — `selectedPreset`, `aspectRatio`, `pacing`,
`subtitlePolicy`, `hookPolicy`, `zoomPolicy`, `reframePolicy`, `musicPolicy`, `gradingPolicy`,
`textPolicy`, `overlayPolicy`, `informationRegionPolicy`, `hookText` — plus `presetRun`
(`presetId`, `presetRunId`, `appliedAtRevision`, `summary`, `plannedZoomMoments`, `trims`). No new
table. Unknown values in `settings` are ignored rather than trusted.

## Policies

- **Aspect ratio**: `9:16`, `16:9`, `1:1`, `SOURCE`. Instagram / Podcast / Product / Motivational
  target `9:16`; Educational targets `9:16` but drops to `SOURCE` when slides dominate; Clean
  Business, Minimal and Source / Manual keep `SOURCE`.
- **Subtitles**: `OFF` / `AUTO` / `ALWAYS`. When word timings exist, one `SUBTITLE` element is
  created per phrase with the transcript's exact words and exact timings — nothing is reworded and
  nothing is invented. Above `EDIT_MODE_MAX_SUBTITLE_ELEMENTS` (default 400) the policy is persisted
  for the render phase instead. Caption elements are repositionable by hand; `UPDATE_TEXT` stays
  `TEXT`-only, so caption wording remains transcript-exact.
- **Hook**: `OFF` / `AUTO` / `RECOMMENDED`. The headline comes from `deterministicHook`, or from the
  model path when one is configured; either way it is scored by the same grounding rules, so an
  ungrounded, meta or clickbait line is discarded and the hook is omitted.
- **Semantic zoom**: `OFF` / `SUBTLE` / `MODERATE` / `STRONG`. Beats come from real transcript
  emphasis peaks and are recorded as `plannedZoomMoments` intent. Phase 4 renders no zoom.
- **Reframe**: `SOURCE` / `AUTO` / `FACE_FOCUSED` / `INFORMATION_PRESERVING`. No speaker identity is
  ever invented: the transcription has no diarization, so nothing labels a host or a guest.
- **Music**: `OFF` / `KEEP_EXISTING` / `OPTIONAL_USER_ASSET`. Presets never fetch external music and
  never remove a music element the user added. `OPTIONAL_USER_ASSET` places an already-uploaded
  audio asset at a speech-safe level with fades, only when no music element exists yet.
- **Grading**: `NONE` / `SUBTLE` / `CLEAN` / `WARM` / `CONTRAST`. Style intent only; Phase 4 does
  not render grading.

## ONLINE / OFFLINE / FALLBACK

The planner is deterministic and reproducible. The only model use is headline wording, through the
existing `LlmRouterService` on the `hookGeneration` role under a strict JSON schema, so existing
online/offline routing and `FALLBACK_ONLY` apply unchanged and no API key is added.
`FALLBACK_ONLY` or an unconfigured role skips the call entirely; a provider error or a rejected
proposal degrades to the deterministic hook rather than failing the plan. Set
`EDIT_MODE_PRESET_LLM_ENABLED=false` to force the deterministic path.

## Isolation

Preset use creates no `ProcessingJob`, `ClipCandidate` or `GeneratedClip`, enqueues nothing, and
never reads or writes `Project` or `Video` rows. `EditModeModule` provides `LlmRouterService`
directly instead of importing `ProcessingModule`, so the frozen processing queue and video processor
never enter EditMode's injector graph. `test-edit-mode-presets.cjs` asserts the row counts and greps
the whole EditMode module tree for the forbidden service names.

## Tests

`npm --workspace apps/backend run test:edit-mode` (all Phase 1–4), or
`test:edit-mode-presets` for Phase 4 alone. Sixteen suites cover the catalogue and its typed enums,
invalid presets, `SOURCE_MANUAL` applying nothing, a plan per preset against talking-head /
two-person / slide / silent fixtures, cached-analysis reuse, isolation, PREVIEW purity, APPLY,
single-revision `PRESET` history, undo/redo, manual-edit preservation across reapply, generated
command validation, stale revisions, the no-prompt flow, and the deterministic fallback.

## Known limitations

- Nothing is rendered. Reframe, zoom and grading are persisted intent for a later render phase.
- Trimming removes only silent lead-in and tail. Mid-timeline silence removal is not implemented.
- No diarization, so no speaker-attributed framing or labels.
- Very long sources fall back to a persisted subtitle policy rather than a caption element per
  phrase.
- The preview reports counts and plain-language changes, not a rendered before/after.
