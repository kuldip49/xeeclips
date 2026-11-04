# MCP consent retry fix

A clip request first made with AI processing off saved a terminal AI_CONSENT_REQUIRED receipt. Saving consent in Settings correctly changed the account, but the assistant's retry with the same idempotency key kept returning that earlier failure without checking current consent.

The retry now checks saved account consent and atomically claims only a consent-blocked XeePro precondition for Create Clips, Quick Reframe, campaign understanding, or campaign generation. These guards precede generation, edits and credit reservations. One concurrent request may proceed; completed receipts, conflicting inputs, other failures and revocation retain their existing behavior. No migration or real-account consent change is required. The account tool returns the saved consent boolean so assistants can verify it.

Settings has an explicit Allow AI processing On/Off switch with saved-state feedback. It applies to the website and connected assistants. The integration section shows assistant names, connection status, a short explanation, and Disconnect; technical addresses, scope lists and timestamps are removed from that display.

Validation: backend build and MCP contract regression; frontend typecheck and static production build; real isolated API/MCP consent OFF, repeated blocked request, saved ON, retry using the same key, saved OFF, account isolation and unchanged credits. Desktop, 375px and 390px browser acceptance verifies on/off persistence after reload, no horizontal overflow, consent callbacks and disconnect with login preserved. These checks use disposable accounts and nonexistent source IDs so no real generation is started. Production acceptance passed as recorded below.

## Production release — 2026-11-04

- Runtime commit: 49f6b8725a013c7c359859fa3ff608c5da4bc45b, pushed normally to main.
- Frontend version: 94ced590-6608-41bf-9d9f-d45e431d475d.
- Backend image: sha256:bfcedbb585d14349ef092a63a1c03562a5f611f9c4f94930bbb59f9ee0f67023.
- No migrations; all 38 existing migrations remain applied.
- Restored backup: C:\projects\ai-content-platform\storage\xeeclip-mcp-consent-20261104\production-1793775474239.dump; 32593267 bytes; SHA-256 f3c0bdbfd571eb8d5483e89167da63d1443866f0c18b72465406cec2e740bdb9. Database/config snapshots and rollback image are retained.
- Disposable production OAuth/MCP acceptance passed: OFF rejects processing, ON persists and unblocks the identical request key, OFF blocks new work, account isolation and unchanged credits. The missing-source test deliberately starts no paid generation.
- Production browser acceptance passed at desktop 1440px, 375px and 390px: ON/OFF persists across reloads; simplified connection display, consent callback, disconnect, preserved login and no horizontal overflow. The public Settings bundle exactly matches the tested build.
- Both local and production disposable users and registered clients were removed. No source/media was created by these tests.
- All 38 business/client/grant/audit table fingerprints and all 655 original storage objects were preserved. A second isolated restore proved the only changed metadata: the existing retention policy removed one authorization and two tokens already expired over 24 hours before cutover; every remaining original OAuth row was unchanged. Real-account consent was not changed.
- Live connected MCP get_account confirmed aiProcessingConsent=true for the reporting account after reopening. The original failed request can now be retried with its existing key.
- Maintenance is off and the exact original tunnel config is restored. A long tool-execution wait delayed the final preservation check and maintenance removal; final public health was verified at 2026-11-04T12:33:15.756Z.
- Site/API/MCP/database/Redis/MinIO/AI/tunnel healthy; no running jobs or credit reservations at final check. AI, database, Redis, MinIO and old local frontend containers were not restarted.
- Rollback was not used. Backend rollback: xeeclip-backend-rollback:before-xeeclip-mcp-consent; frontend rollback: c8ec9555-08e5-450a-b1d5-cf441021f951.

Status: deployed and healthy.
