# XeeClip V1 release candidate — 19 October 2026

Feature freeze: integrate the existing Clipper implementation and its two completed hardening branches. No product feature or renderer redesign is included.

The release preserves the exact V1 snapshot `3a07d98`, backend hardening `966847f` and frontend hardening `a393de8`. The frontend commit already contains the backend commit. Original worktrees, the original uncommitted implementation and unrelated editor release scripts remain intact. The backend worktree's additional uncommitted migration difference is one blank line; the committed, tested SQL is used unchanged.

Release blocker corrected: existing media/editor HTTP responses exposed private storage locator fields. A response interceptor removes those fields without changing internal service objects, streams, editor history or render input. Public error handling also keeps diagnostic/provider failures private while retaining the exact busy and credit contracts.

Acceptance on the integrated source:

- 17 backend suites; 29 campaign adversarial checks; 46 HTTP campaign checks; 34 auth/security checks; 8 frontend suites; backend/shared/frontend type checks and complete builds.
- 72 browser cases covering Clipper workflows, pagination, errors, all compliance states, busy behavior, static routing, Quick Reframe Result, direct export/download and explicit editing.
- Real local media: Free StyleOne/StyleTwo and mocked Pro StyleZero campaign generation, actual MP4 exports, exact credit settlement and cached History. All four Free cloud counters, provider attempts and external provider transports stay zero. Busy after admission reserves/refunds exactly once; busy before admission makes no ledger entry.
- Additional browser acceptance against the actual integrated API: New Campaign → rules → real logo/music → confirm → source upload → Free StyleOne → compliance → canonical editor/save → updated export → Ready → manually Posted → 1,234 views/USD 12.50. Create Clips and Quick Reframe each generate/export all three styles. Corrupt upload, empty credits, admin/credit authorization and reciprocal media/campaign/editor ownership checks pass.
- Actual desktop, 375px and 390px pages pass overflow checks across Create, Quick Reframe, Clippers/campaign compliance/export, canonical editor, History and Settings. The separate Result tests verify accessible export/edit controls at each width.
- Nine healthy campaign clips require two batched Prisma operations. Concurrent request/scanner tests prevent duplicate runs and credit reservations. Local parsing/compliance reuse existing evidence; no unbounded retry was introduced.

Database rehearsal used an actual production backup, restored in a network-isolated PostgreSQL container. All 51,465 legacy rows in 27 tables retained their complete row fingerprints after both additive migrations. Seven new empty tables and 17 validation constraints were verified. No reset, destructive SQL or production migration was used for the rehearsal. The ignored evidence includes the dump, checksum, runtime/config backups and restore result.

Open P0/P1: none after local acceptance. Production rollout remains gated on a fresh backup/restore, maintenance, idle queues/reservations, preserved configuration, additive migration and disposable production acceptance. AI-service code and runtime dependencies are unchanged. A source audit found all 220 production backend TypeScript files match the `791547e` release base.

V1.1 backlog: P2 — an unknown URL handled by the static SPA fallback displays the not-found view with HTTP 200; correct the response status when hosting supports it without compromising campaign deep links. P3 — no additional polish change is included during the freeze. PDF/DOCX reference-only handling, human review of unverifiable campaign requirements and manual posting are existing V1 behavior, not release failures.

Reproduction/evidence: `scripts/prepare-xeeclip-v1-qa.cjs`, `scripts/serve-xeeclip-v1-qa-api.cjs`, `scripts/xeeclip-v1-acceptance.cjs`, `scripts/xeeclip-v1-database-release.cjs`; ignored `.cache/xeeclip-v1-release`, `.cache/clipper-hardening` and `.cache/clipper-frontend`. Production QA requires explicit opt-in and pins the public origins; local acceptance pins a dedicated Docker project. Credentials, TLS keys, backups and generated media are ignored and must not be committed.
