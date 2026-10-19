# Clipper frontend API handoff

No blocking backend implementation change is required by this frontend diff. It targets the contracts documented in `clipper-backend-handoff.md` at backend commit `966847f322d6412b79c9a044a301249909c76bb1`. Browser acceptance uses local deterministic API fixtures; it does not claim a production deployment or paid-provider integration test.

| Endpoint | Expected behaviour / fields | Current contract and frontend handling |
| --- | --- | --- |
| `GET /campaigns`, `/campaign-assets`, `/campaign-clips` | Array, `limit`, `offset` | Frontend requests pages of 50 and exposes Load more. Overview totals remain independent of pagination. |
| `GET /campaigns/:id` | Campaign scalars, `brief`, paged `assets`, `sources`, `runs`, `clips` | Detail pages combine requested collection pages. Confirmation always uses the current `brief.version`. |
| `PATCH /campaigns/:id/brief` | `{version, data, sourceText}`; invalidates confirmation | Wizard persists pasted rules before continuing to assets. Its per-account tab draft also preserves unsaved text and visited steps. |
| `POST /campaigns/:id/understand` | `{version, sourceText, mode}`; public brief/audit | No implicit Free switch or second call after Pro busy. User must select Free and submit explicitly. |
| `POST /campaigns/:id/confirm` | `{version, confirmedByUser: true, warningsAcknowledged}` | Structured fields, warnings and explicit review checkboxes are retained; no raw JSON editor. |
| `POST /campaigns/:id/assets` | Multipart `file`, `type`, `relativePath`; safe asset DTO | Each file has a bounded request. Failed files are identified, remaining files continue, successful files remain stored. |
| `POST /campaigns/:id/generate` | Source IDs, mode, style, count, notes, request key; run DTOs | Selected values are visible before submission. Existing queued generation and credit semantics are reused. |
| `POST /campaign-clips/:id/fix`, `/ready`; `PATCH .../social` | Public clip DTO; 409 on changed state | Lists refresh after success. Warning acceptance belongs to the displayed compliance/revision/social-copy version. A social change requires fresh review. |
| `POST /campaign-clips/:id/export` | `{export, project:{id,revision}}` | Frontend polls `/edit-mode/projects/:id/export/progress` until terminal, then refreshes current export/compliance. Errors never display a success message. |
| `POST /campaign-clips/:id/mark-posted` | Platform, optional HTTPS URL, optional timestamp, notes; public post DTO | Blank timestamp is omitted; entered local time is converted to a timezone-qualified ISO timestamp. UI explicitly records a post made by the user. |
| `PATCH /campaign-clips/:id/metrics` | Non-negative whole counters, decimal earnings string, uppercase currency | Stored decimal values remain strings. Summary uses API totals grouped by currency, with no invented values. |
| Existing canonical editor routes | `editorUrl`, canonical project/history/export APIs | Same editor opens only on Edit Video. A scoped session return link goes back to the campaign's Generated Clips tab; no alternate editor or backend data model. |

Run errors and normal request errors must continue to use the public codes/messages in the backend handoff. The frontend additionally suppresses raw legacy database, renderer, storage and provider error details if an upstream response contains them.

No backend, Prisma, migration, business-logic or shared-package file was edited for this work.
