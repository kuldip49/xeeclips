# Styled clip re-materialization

A `GeneratedClip` must open as the **same canonical `EditProject`** whether the project was created during generation or has
to be rebuilt later because it was deleted. This is independent of the headline-fit hotfix (`d2b8c83`); the bug exists on
`1fb65ed` too.

## Root cause

StyleOne (`AUTOMATIC_2`) and StyleTwo (`AUTOMATIC_3_STYLE_TWO`) clips store `editPlan.onScreenHook.enabled = false`. Their
headline is not part of the clip; it is added by the generation styling pass (`GenerationStylingService.styleClip`) as one
`APPLY_ASSISTANT_EDIT` / `TEMPLATE` revision on top of the base materialization. `POST /edit-mode/projects/from-generated-clip/:id`
only ran the base materializer when the project was missing, so a deleted project came back at revision 1 without the style.
StyleZero (`AUTOMATIC_1`) carries its headline in the plan and was never affected.

## What the styling pass changes (StyleOne / StyleTwo)

Measured on the same project ids, base materialization (rev 1) vs styled (rev 2):

| | StyleOne | StyleTwo |
|---|---|---|
| TEXT elements added | headline (`HOOK`, clip-long) | headline (`HOOK`, clip-long) |
| EFFECT elements removed | Automatic 1 zoom | Automatic 1 zoom |
| SUBTITLE elements modified | position, size, font, stroke, shadow, background, active word, caption style | same |
| VIDEO elements modified | `frameLayout` | none |
| settings | `resolvedVisualLayout`, `generationStyle` | same |
| history | rev 2 `APPLY_ASSISTANT_EDIT` actor `TEMPLATE` | same |

The headline is therefore not the only state, which is why the fix re-runs the whole pass instead of patching the headline in.

## Design

```
from-generated-clip
  -> GenerationStylingService.materializeStyled(clipId)
       project exists  -> returned untouched (never restyled; user edits are preserved)
       project missing -> resolveClipStyleRequest(clip, job)
                          -> styleClip(clip, resolved, template, { deferExport })   <- the SAME pass as generation
                          -> project returned
```

* `styles/clip-style-request.ts` is the only place that decides which style a clip was delivered with. Sources, strongest first:
  1. **`CLIP_SNAPSHOT`** - the resolved style written on the clip (`editTelemetry.generationStyle`) the first time it is styled.
  2. **`REQUEST_SETTINGS`** - the `ProcessingJob` settings, only when the clip provably belongs to that request (same job id,
     same template, not rendered before the job's current request began). The job row is reused by every request for a video.
  3. **`TEMPLATE_DEFAULT`** - the clip's own persisted template (`effectiveTemplate` / `requestedTemplate` / `templateId`)
     with no extra components. Used for clips of older requests that predate the snapshot; extra components picked for that
     request cannot be recovered and are not guessed.
  Nothing consults UI defaults or the video's latest request. The resolved style is recorded on the project as
  `settings.generationStyle.reconstruction`.
* Template rules are not duplicated: StyleOne/StyleTwo logic stays in `compileCreativeStyle`; the adapter is unchanged.
  The headline wording comes from the clip's persisted content package (`contentPackaging.sharedPackage`), so nothing is
  regenerated and no model is called (XeeFree/XeePro routing is untouched).
* `styleClip` is single-flight per clip, so generation, `retry-style` and opening the editor cannot apply the style twice. It also
  already skips restyling when the project was edited (`history > 1`).
* The card's export is deferred when a clip is reopened: the editor opens as soon as the canonical style revision exists. The
  background export is skipped if the user has edited in the meantime (state `READY`).

## Revision history

A rebuilt project is `rev 0 PROJECT_CREATED`, `rev 1 GENERATED_CLIP_MATERIALIZED`, `rev 2 APPLY_ASSISTANT_EDIT (TEMPLATE)` - exactly
the original. The style revision is a template revision, not a user edit: Undo from revision 2 returns to the unstyled base like
a freshly generated clip, and the "edited after styling" guard (`history > 1`) does not count it.

## retry-style

`POST /edit-mode/generation/clips/:id/retry-style` now uses the same resolver instead of the video's latest job, so a clip from an
earlier request is retried with its own template. It restores a project that an older build left unstyled (and is idempotent:
the style hash matches, so a styled project is returned as is). Projects already rebuilt unstyled by the old behaviour are not
modified automatically (they may contain user edits); `retry-style` fixes them on request.

## Tests

* `npm --workspace apps/backend run test:rematerialize-styled-clip` - in-memory, real adapter/compiler/edit-mode service.
* `node apps/backend/scripts/verify-rematerialize-styled-clips-live.cjs` - real media on the isolated QA stack (`:4100` only).
