# XeePro availability and "busy" behavior

Both modes are always visible and selectable on Create: **XeeFree** (local, zero cloud calls) and **XeePro** (online AI). The user's choice is authoritative and is stored on the job; nothing switches modes on its own.

## Two different things

| | Meaning | Where it lives | Effect |
|---|---|---|---|
| `XEEPRO_ENABLED` | Owner's **emergency kill switch**. Unset, empty or `true` = Pro selectable. Any other value turns **new** Pro work off. | one backend environment value | Create disables the Pro radio; new Pro uploads/imports/retries/selections return HTTP 409 `XEEPRO_UNAVAILABLE` before storage, queue or credit. |
| XeePro **busy** | The provider has no capacity right now (HTTP 429, rate limit, quota/credit, 5xx/overload, rejected key). | decided **per request**, never stored as a flag | The unit of Pro work ends as `XEEPRO_BUSY` (below). Pro stays selectable. |

Provider capacity is never read in advance and never written to a flag. Adding provider credit needs **no deployment, no flag change and no restart**.

## What happens on a busy provider

* The router records a safe category for the request (`PROVIDER_RATE_LIMITED`, `PROVIDER_QUOTA_UNAVAILABLE`, `PROVIDER_BUSY`, `PROVIDER_UNAVAILABLE`) and refuses further provider calls for that request (no retry loop, no quota burn; each provider is tried at most once, `maxRetries: 0`).
* Job entry points (analysis worker, clip creation, explicit Pro hook/post-copy/brief calls) run inside `runInProviderBusyScope` (`processing/generation-availability.ts`) and check it at stage boundaries. A busy request **ends**; it never completes on the XeeFree path under a Pro label.
* Analysis job: `status=FAILED`, `errorCode=XEEPRO_BUSY`, `error` = the product message, `telemetry.providerFailureCategory` = the internal category, `retryable=true`. Clip creation: `clipRenderStatus=FAILED`, `clipRenderError` = the product message, `errorCode=XEEPRO_BUSY`. Request-level calls return HTTP **503** `{ "code": "XEEPRO_BUSY", "message": "XeePro is busy right now. Try XeeFree or try again later.", "retryable": true }`.
* Credits: the reservation is settled as refunded exactly once (atomic `RESERVED -> REFUNDED`, shared with the periodic reconcile), because no usable output was delivered. A request that already delivered clips keeps normal consume semantics.
* The UI shows the product message with **Use XeeFree** and **Try again**. XeeFree is only ever started by the user (`POST /videos/:id/retry` with `{ "aiMode": "FALLBACK_ONLY" }` lowers a failed Pro job to Free; it can never raise one).
* Not mapped to busy: invalid video, corrupt media, timeouts, network/schema/invalid-request failures. They keep their own errors.
* Provider names, model names, quota codes, billing text and keys are never returned to clients.

## Recovery

The router keeps a short in-process cooldown after a quota/credit failure: `LLM_QUOTA_COOLDOWN_MS`, default **60 000 ms** (rate limits use `GOOGLE_RATE_LIMIT_COOLDOWN_MS` / `Retry-After`). After it expires the next XeePro request makes a live attempt. A rejected key stays unavailable only until the key changes. Old Pro outputs are unaffected: History, playback, manual editing, export and download use no provider.

## Tests

`npm --workspace apps/backend run test:xeepro-busy` (fake provider over real HTTP: Free zero calls, Pro success, 429 quota/rate/5xx/401, fail-fast, safe body, recovery after the cooldown) and `test:xeepro-availability` (kill switch).
