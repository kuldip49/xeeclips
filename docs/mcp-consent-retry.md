# MCP consent retry fix

A clip request first made with AI processing off saved a terminal AI_CONSENT_REQUIRED receipt. Saving consent in Settings correctly changed the account, but the assistant's retry with the same idempotency key kept returning that earlier failure without checking current consent.

The retry now checks saved account consent and atomically claims only a consent-blocked XeePro precondition for Create Clips, Quick Reframe, campaign understanding, or campaign generation. These guards precede generation, edits and credit reservations. One concurrent request may proceed; completed receipts, conflicting inputs, other failures and revocation retain their existing behavior. No migration or real-account consent change is required. The account tool returns the saved consent boolean so assistants can verify it.

Settings has an explicit Allow AI processing On/Off switch with saved-state feedback. It applies to the website and connected assistants. The integration section shows assistant names, connection status, a short explanation, and Disconnect; technical addresses, scope lists and timestamps are removed from that display.

Validation: backend build and MCP contract regression; frontend typecheck and static production build; real isolated API/MCP consent OFF, repeated blocked request, saved ON, retry using the same key, saved OFF, account isolation and unchanged credits. Desktop, 375px and 390px browser acceptance verifies on/off persistence after reload, no horizontal overflow, consent callbacks and disconnect with login preserved. These checks use disposable accounts and nonexistent source IDs so no real generation is started. Production evidence will be appended after the gated rollout.
