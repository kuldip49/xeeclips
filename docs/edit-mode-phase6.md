# EditMode Phase 6 — AI chat editor

Phase 6 adds a natural-language front end to the EditMode editor. It adds no second editor, no
second mutation path, no new renderer and no new provider: a sentence becomes a structured,
validated command bundle that the canonical EditMode layer executes exactly the way the manual
editor and the preset planner already do.

Nothing is ever applied without an explicit **Apply**.

## Architecture

```
user message + selection + selected range + playhead
        ↓
buildChatContext            bounded, handle-addressed view of the project
  ├─ searchTranscript       DETERMINISTIC transcript search, before any model
  └─ cached analysis        never re-transcribes, never re-analyses
        ↓
planDeterministicChat       direct instructions, no model, works in FALLBACK_ONLY
  └─ (or) planWithLlm       `editingPlan` role, strict CHAT_INTENT_SCHEMA
        ↓
validateChatIntent          closed action union; unknown/foreign fields rejected
        ↓
rejectInventedTimestamps    a transcript range the search never offered is discarded
        ↓
resolveChatPlan             handles → real ids, timestamps checked, confidence enforced
        ↓
PROPOSAL (server-held)      plain-sentence preview; NOTHING is written
        ↓
user presses Apply
        ↓
EditModeService.applyAssistantBundle
  └─ applyElementCommand / splitVideoTimeline / deleteVideoTimeline / reorderVideoTimeline
     normalizeVideoTrack + validateTimeline after EVERY command
        ↓
ONE EditHistory row         actor ASSISTANT, action APPLY_ASSISTANT_EDIT  →  one undo step
        ↓
existing Phase 5 export     unchanged, deterministic, LLM-free
```

## What the model is and is not allowed to do

The model only ever emits `ChatIntent` — a closed union validated by `validateChatIntent`. It
cannot express anything else, so these are structural guarantees rather than prompt requests:

| Forbidden | Why it cannot happen |
| --- | --- |
| Write FFmpeg / shell / SQL | No command carries a free-text field that reaches a process. Unknown parameter keys are dropped by the allow-list in `edit-chat-commands.ts`. |
| Mutate Prisma | The chat layer contains no `editElement` write. Apply calls `applyAssistantBundle`, nothing else. |
| Emit arbitrary JSON patches | `parameters` is filtered to a fixed key set; settings commands are filtered to the typed fields of that action. |
| Bypass validation | Every command is folded through `applyElementCommand`, and `validateTimeline` runs after each one, inside the transaction. |
| Invent element/asset ids | It never sees a UUID. It addresses things by `el3` / `asset1` handles, or by `SELECTED` / `LAST` / `ROLE` / `AT_TIME` / `REF`. |
| Invent timestamps | Every time value is bounds-checked against the live timeline, and a `TRANSCRIPT`-grounded range must match a window the backend's own search produced. |
| Invent transcript content or speakers | Transcript spans come from `searchTranscript` over the cached transcript; the model may only select one. |
| Apply anything by itself | Plan and Apply are separate calls. Even "make the logo 10% smaller" shows a proposal. |

## Grounding

Grounding is computed by the backend, not asserted by the model.

- **Transcript** — `searchTranscript` scores IDF-weighted term overlap over sentence windows of the
  cached transcript. `resolveTranscriptSpan` returns a span only when it is strong enough *and*
  clearly better than the runner-up; otherwise `NO_MATCH`, `LOW_CONFIDENCE` or `AMBIGUOUS`, all of
  which become a question. A topic mentioned in two places is ambiguous, not a coin toss.
- **Selection / playhead** — `selectedElementId`, `selectedTimeRange` and `playheadSec` travel with
  every request, so "split here", "delete this" and "make this smaller" mean what the user is
  looking at.
- **Asset** — the chat only sees uploaded `EditAsset`s behind handles. A file that was never
  uploaded is reported as missing; two candidates produce a question naming both.
- **Analysis** — cached shot/face/information-region evidence backs framing requests such as
  "don't crop the slide".

### Confidence policy

| Bar | Value | Applies to |
| --- | --- | --- |
| `CHAT_MIN_CONFIDENCE` | 0.45 | below this nothing is proposed |
| `CHAT_SAFE_CONFIDENCE` | 0.6 | reversible, cosmetic commands |
| `CHAT_DESTRUCTIVE_CONFIDENCE` | 0.75 | `TRIM_ELEMENT`, `SPLIT_ELEMENT`, `DELETE_ELEMENT`, `REMOVE_ELEMENT` |

A weakly grounded cut is refused and turned into a question; the same confidence is acceptable for
an opacity change.

## Stateful follow-ups

The thread is **structured**, not a pile of sentences. `EditProject.settings.chat` holds the
messages plus `lastAffectedElementIds`, `lastAppliedSummary` and `lastAppliedAtRevision`.

"Add my logo top right." → "Make it smaller." → "Move it a little lower." all target the *same*
logo, because the follow-up resolves through `lastAffectedElementIds`, not through wording
similarity. A follow-up never adds a second logo.

The thread is bounded (40 messages, 2000 chars each, 8 remembered element ids) so a long session
cannot grow `settings` without limit. It is conversation state, not project state: it does not move
the revision, it is excluded from history snapshots, and undo deliberately preserves it.

## Proposal storage

Proposals live in `EditChatProposalStore`, in process, for 15 minutes
(`EDIT_MODE_CHAT_PROPOSAL_TTL_MS`), bounded to 8 per project and 500 overall. The browser holds
only a `proposalId`; the command bundle never leaves the server, so a tampered Apply cannot
introduce a command the validator never saw.

**Restart limitation:** a backend restart drops pending proposals and the next Apply returns
`PROPOSAL_NOT_FOUND`, which the panel surfaces as "ask me again and I will re-plan it". Nothing can
be half-applied: Apply is a single transaction that either finds a complete proposal or does
nothing. Redis was deliberately not introduced for state that is cheap to regenerate and
meaningless once the project moves on.

## Revision conflicts

Each proposal records `baseRevision` and `plannedDurationSec`. If the project moved on before
Apply:

- every element the plan resolved must still exist, **and**
- if the plan carries absolute times, the timeline length must be unchanged,

otherwise the proposal is marked `STALE` and the user is asked to re-plan. A plan that passes both
checks is safely rebased onto the current revision.

## Cuts that shorten the timeline

A cut that removes time can orphan overlays that covered the whole clip — and the canonical
validator rightly refuses an overlay hanging past the end. The plan states the consequence instead
of failing: overflowing overlays get explicit `SET_ELEMENT_TIMING` commands, each shown as its own
line in the preview.

The **ordering is load-bearing**: refit commands run *before* the cut, because validation runs
after every command, and shrinking overlays while the timeline is still long is valid at each step.

## AI modes

Routing reuses the existing `editingPlan` role on the existing `LlmRouterService`. Phase 6 adds no
provider, no API key and no role.

| Mode | Behaviour |
| --- | --- |
| `ONLINE` | Direct instructions are still served by the deterministic planner (free and instant). Anything it does not recognise goes to the configured cloud provider under `CHAT_INTENT_SCHEMA`. |
| `OFFLINE` | The router's own role allowlist governs local routing. `editingPlan` is not in that frozen allowlist, so chat planning falls back to the deterministic planner. Malformed output from any model is rejected by `validateChatIntent` before anything is resolved. |
| `FALLBACK_ONLY` | No provider is consulted at all. Direct instructions work fully; a request needing language understanding returns an honest `UNSUPPORTED` with the phrasings that do work. |

`EDIT_MODE_CHAT_LLM_ENABLED=false` disables the model path entirely.

Every model failure — outage, timeout, truncation, malformed JSON, unsupported action, invented
timestamp — degrades to the deterministic planner or to a refusal. None of them can mutate
anything.

## API

All routes stay under `/edit-mode`. No `/projects` or `/videos` route changed.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/edit-mode/projects/:id/chat` | the stored conversation |
| `POST` | `/edit-mode/projects/:id/chat/plan` | build a proposal — writes no edit |
| `POST` | `/edit-mode/projects/:id/chat/apply` | commit the server-held proposal |
| `POST` | `/edit-mode/projects/:id/chat/cancel` | discard a pending proposal |

`plan` takes `message`, optional `revision`, `selectedElementId`, `selectedTimeRange` and
`playheadSec`. `apply` takes only `proposalId`.

## Isolation

Verified by test and by source scan:

- no `ProcessingJob`, `ClipCandidate` or `GeneratedClip` row is created or read;
- `ProcessingQueueService`, `VideoProcessorService`, `ClipSelectionService`,
  `ClipRenderQueueService` and `ClipExportService` are never referenced;
- nothing under `processing/`, `videos/`, `projects/` or `editing/` was modified;
- the chat layer never reaches FFmpeg or a shell, and never starts an export;
- export remains fully deterministic and LLM-free — applying a chat edit never triggers one.

## Schema

**No migration.** `EditHistoryActor.ASSISTANT`, the `ASSISTANT` element origin and the free-form
`EditProject.settings` JSON all existed already.

## Tests

- `npm --workspace apps/backend run test:edit-mode-chat` — 89 offline checks covering the command
  schema, every supported phrasing, grounding, ambiguity, resolution safety, context bounding,
  thread and proposal storage, fallback behaviour and isolation.
- `npm --workspace apps/backend run verify:edit-mode-chat` — 27 checks against the live stack: a
  disposable project with real media, plan → *assert nothing moved* → apply → one ASSISTANT
  revision → follow-up targeting → manual work preserved → undo/redo → safe rebase → stale refusal
  → Phase 5 export → FFprobe → cleanup.

`test:edit-mode` runs the chat suite alongside Phases 1–5.

## Known limitations

- Pending proposals do not survive a backend restart (see above).
- `selectedTimeRange` is plumbed end to end but the timeline UI does not yet produce a range
  selection, so it is always `null` from the workspace today.
- In OFFLINE mode chat planning is deterministic-only, because `editingPlan` is absent from the
  router's frozen offline role allowlist. Adding it is a one-line change to a frozen file and was
  deliberately not made.
- A cut spanning two video segments asks the user to do it one segment at a time.
- The deterministic planner is English-only.
