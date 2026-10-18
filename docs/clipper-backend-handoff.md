# Clipper backend API handoff

Campaign routes and field names remain compatible with V1. Use authenticated API requests and the canonical `editorUrl` returned for each clip.

## Pagination

`GET /campaigns`, `/campaign-assets`, `/campaign-clips`, `/campaigns/:id/clips`, and `/campaigns/:id` accept `?limit=50&offset=0`. Results remain arrays; campaign detail retains its object with bounded nested arrays. Maximum limit is 100, minimum is 1. Offset is a non-negative integer up to 1,000,000. Default limit is 50, except the global asset list defaults to 100. Detail applies the page to each nested collection. Campaigns/runs/clips sort newest first; detail assets/sources sort oldest first, with an ID tie-breaker.

Frontend action: page global lists and campaign detail collections explicitly. Do not assume a single request returns every item. Overview/performance totals include all owned stored records regardless of list pagination.

## Public DTOs

`POST /campaigns`, `PATCH /campaigns/:id`, and `DELETE /campaigns/:id` return campaign scalar fields: `id`, `projectId`, `name`, `description`, `status`, `platforms`, `payoutDescription`, `deadline`, `defaultClipCount`, `createdAt`, `updatedAt`. Fetch campaign detail for its `brief`, `assets`, `sources`, `runs`, and `clips`. The list also includes brief confirmation/version and `_count`.

`POST /campaigns/:id/generate` returns an array of public run DTOs. Runs retain `id`, `campaignId`, `sourceId`, `requestKey`, `mode`, `style`, `requestedClipCount`, `briefVersion`, `status`, `error`, `errorCode`, timestamps. Trusted orchestration `snapshot` is private.

`POST /campaign-clips/:id/fix`, `POST .../ready`, and `PATCH .../social` now return the same public clip shape as `GET /campaign-clips`:

```ts
{
  id, campaignId, campaignName, runId, generatedClipId, editProjectId,
  title, mode, style, lifecycleStatus,
  compliance, complianceStatus, complianceScore,
  checkedRevision, checkedBriefVersion, socialPackage, post,
  createdAt, updatedAt, exportCurrent, previewUrl, downloadUrl, editorUrl
}
```

`previewUrl`, `downloadUrl`, `editorUrl`, and canonical IDs can be null. `exportCurrent` determines whether the downloaded export matches the current edit. An older preview can remain available while a new export is needed. Nested ORM relations, source transcripts, provider telemetry, and storage paths are private. Frontend action: replace the displayed clip with the mutation DTO, or refetch; fetch `/edit-mode/projects/:id` only when opening the canonical editor.

`POST /campaign-clips/:id/export` returns `{export: <existing canonical export progress>, project: {id, revision}}`. Frontend action: poll the existing canonical export progress route `/edit-mode/projects/:id/export/progress`, then refresh the clip list. Do not expect a full editor snapshot in this mutation response.

`POST /campaign-clips/:id/mark-posted` and `PATCH .../metrics` return a public post DTO: `campaignClipId`, `platform`, `postedAt`, `postUrl`, `views`, `likes`, `comments`, `shares`, `earnings`, `currency`, `notes`, `updatedAt`. `earnings` is a decimal string with two places. Use `earningsByCurrency` in performance responses; currencies are not combined into an invented conversion.

Asset DTOs retain safe file metadata, `fileUrl`, `required`, `intendedUse`, and `extractedTextAvailable`. Storage paths and extracted text are private. Source job errors are generic product messages/codes, with `XEEPRO_BUSY` retained when applicable.

## Validation and error handling

Campaign error responses provide `statusCode`, `code`, and `message`, except the existing public Pro busy shape. Render the product message and branch on the code.

| Status/code | Frontend action |
| --- | --- |
| 400 `CAMPAIGN_INVALID_INPUT` | Correct the indicated text/body field. Arrays, objects, NUL bytes, and oversize values are not silently converted/truncated. |
| 400 `CAMPAIGN_BRIEF_TOO_LARGE` | Reduce combined pasted and uploaded text to 100,000 characters. Pasted/text-file rules each allow 50,000 characters. |
| 400 `CAMPAIGN_REQUEST_REJECTED` | Show the field, upload, pagination, mapping, URL, or metric validation message. |
| 404 | Remove unavailable resources from local state; do not infer another account's object exists. |
| 409 `CAMPAIGN_STATE_CHANGED` | Refresh clip, brief and canonical revision; review again before Ready/Posted. Do not automatically repeat acceptance. |
| 409 `CAMPAIGN_REQUEST_CONFLICT` | Reuse a request key only for identical mode, style, count, notes, source and brief version. Use a fresh key for a new generation. |
| 409 `CAMPAIGN_CONFLICT` | Refresh resources before retrying the conflicting operation. |
| 416 `CAMPAIGN_INVALID_RANGE` | Reset the media range request; `Content-Range` is `bytes */<size>`. |
| 500 `CAMPAIGN_REQUEST_FAILED` | Offer retry with the product message. No internal error text is returned. |
| 503 `XEEPRO_BUSY` | Show “XeePro is busy right now. Try XeeFree or try again later.” Keep the selected mode; switching to Free requires a separate user action. |

Run `errorCode` is `XEEPRO_BUSY`, `NO_CREDITS`, `CAMPAIGN_RUN_FAILED`, or null. Source analysis uses a generic failure code or `XEEPRO_BUSY`. Do not parse provider names from errors.

## Required frontend actions

- Treat `confidence: NEEDS_CONFIRMATION`, `unresolvedRules`, and warnings as review requirements. Do not replace them with a PASS badge. Explicit conflicting/partial rules remain visible after both Free and Pro interpretation.
- Send the current brief `version` when understanding, saving and confirming. Require `warningsAcknowledged: true` to confirm visible warnings. Description/platform or asset changes invalidate confirmation atomically; refresh the detail after changes.
- Display all five individual compliance states: `PASS`, `WARN`, `FAIL`, `UNKNOWN`, `NOT_APPLICABLE`. Overall compliance is one of the first four. Optional and explicitly excluded media rules retain their actual meaning.
- After canonical edits, Undo/Redo, or social copy changes, refresh compliance and clip state. A missing canonical project gives UNKNOWN. Social edits invalidate Ready; Posted remains a record of the actual post.
- Ready requires a confirmed current brief, current export, PASS/WARN compliance, and explicit `acceptWarnings: true` for WARN. Re-review after a conflict. Export again after fixes that change the canonical revision.
- Hashtags must be an array of at most 50 `#` tags containing letters, numbers or underscores, each at most 100 characters. Social caption allows 4,000 characters.
- Mark Posted requires Ready and a non-empty platform. Optional post URLs must use HTTPS without embedded credentials. Send `postedAt` as an ISO timestamp with timezone; omission records server time. Recording a post does not publish to a social platform.
- Metrics must be non-negative integers up to 2,147,483,647. Earnings accept up to 12 integer digits and two decimal places; send a decimal string. Currency must be three uppercase letters. Values are manually recorded, never estimated.
- Upload only PNG/JPG/WebP images, MP3/WAV/M4A/OGG/FLAC audio, MP4/WebM references, TXT/PDF/DOCX documents with matching MIME/contents. Images allow 10 MiB, TXT 1 MiB, other references 50 MiB. TXT is UTF-8; PDF/DOCX remain reference attachments. Required logo/music/image use must match the media type. Preserve authenticated `fileUrl` access.
