# Accounts, ownership and credits

## Deployment architecture

XeeClip remains a static Next.js export on Cloudflare and a NestJS API behind the laptop's
Cloudflare Tunnel. Authentication runs entirely in NestJS/PostgreSQL. An opaque random
256-bit session token lives in an API-host-only `__Host-xeeclip-session` cookie: HttpOnly,
Secure, SameSite=Lax, Path=/, seven-day absolute expiry. PostgreSQL stores only its SHA-256
digest. Login/signup rotate a prior session; logout deletes it. Backend restarts preserve
sessions. Passwords accept 8–128 characters and use bcrypt cost 12. Inputs above bcrypt's
72-byte limit use tagged HMAC-SHA384/base64 preparation with a stable `PASSWORD_HASH_PEPPER`
kept outside the database. Existing direct bcrypt hashes remain compatible. Generate the
pepper with a cryptographically secure random generator (at least 32 bytes), retain it in
the ignored environment configuration, and back it up privately; changing or losing it
invalidates passwords stored with the tagged preparation format.
This works across the same-site `xeeclip.me` and `api.xeeclip.me` without adding Next SSR,
an identity-provider dependency, JWT refresh tokens, or client-side secrets.

The API explicitly allows the frontend origin with credentials. Mutations require an
allowlisted Origin, including login and logout. All routes except health, signup, login
and logout require a valid active account. Admin routes and provider configuration require
ADMIN. Ordinary endpoints remain scoped even for ADMIN. Redis limits auth by IP and
normalized email, and expensive submissions by account. API responses and media are
private/no-store. The frontend verifies sessions before mounting private pages, unmounts
state on logout/401, and refreshes balance/session every 15 seconds and on focus.

## Schema and ownership

User stores normalized unique email, password hash, display name, USER/ADMIN role,
ACTIVE/SUSPENDED status, balance, consumed credits, account AI consent, and timestamps.
Session stores user, token digest and expiry. CreditReservation stores a unique operation
key, owner, resource, amount and RESERVED/CONSUMED/REFUNDED state. CreditTransaction is
the immutable application ledger; AuditLog records admin, target, action, before/after,
reason and timestamp. API user projections exclude hashes and session tokens.

Project, EditProject, ReferenceAsset, SavedStyle and EditTemplate have nullable indexed
userId fields. Videos, imports, pipeline jobs, transcripts, candidates and generated clips
inherit Project ownership; Quick Reframe, editor assets/elements/history inherit EditProject
ownership. Server request context scopes Prisma reads, updates and deletes. Root creation
stamps the session owner; request references are validated using scoped queries. Project
creation whitelists fields, preventing nested Prisma mass assignment. Upload staging
manifests carry an owner and reject other accounts. Workers execute trusted internal jobs.

Media always travels through guarded API endpoints. MinIO has a private bucket policy,
loopback host ports and internal-only short-lived signed URLs for FFmpeg. Owned source,
clip and editor media retain HTTP byte ranges. Reference downloads pin a verified public
IPv4 address, reject private networks/redirects, and limit size/time to avoid internal
storage access via SSRF. Multipart reference attachments explicitly verify video ownership.

## Central usage policy

`UsageService` is authoritative: one credit per accepted Create Clips request, independent
of clip count; one per Quick Reframe final export, including its manual-editor export route.
Admin reservations cost zero. Preview, crop, edit, History, existing export download and
ordinary manual-editor export are free. Newly registered users receive
DEFAULT_USER_CREDITS (default 5) with an INITIAL_GRANT ledger entry.

In the transaction that claims/creates the generation job, a conditional active User update
decrements balance only when sufficient funds exist; the reservation and ledger are written
in that same transaction. Workers are dispatched after commit. Concurrent requests with one
credit cannot spend two. NO_CREDITS is HTTP 403 with "No generations remaining." The UI
disables generation at zero; the backend handles stale tabs/direct requests independently.
Automatic upload/import generation reserves once before accepted processing, then carries
the reservation into canonical generation. Imports reserve before downloading.

The first usable persisted output consumes the reservation atomically with output creation.
A delivered base clip remains usable even if optional styling later fails. Partial delivery
therefore costs one credit. No usable output, enqueue failure, infrastructure failure or
eligible cancellation releases it; reservation state transitions guarantee one settlement.
GENERATION_RESERVE subtracts, GENERATION_CONSUME records zero additional balance change
and increments consumed usage, and GENERATION_REFUND restores the reserved amount. The
sum of ledger amounts reconciles to balance. A 15-second sweep and startup recovery repair
interrupted terminal jobs; live jobs are never refunded merely because they are old.

Admin ADD/REMOVE/SET serializes with generation using a PostgreSQL User row lock and
records ledger plus CREDIT_CHANGE audit in the same transaction. Confirmation is required
in the UI. Suspension revokes all sessions and blocks login/API access, including reads;
reactivation permits a new login. The sole owner cannot be suspended. No public role-change
API exists; a partial unique database index limits ADMIN to one account.

## Admin and account UI

`/admin` provides actual aggregate user/source/clip/Quick Reframe/export counts, tracked
post-launch generation outcomes, UTC seven-day charts, processing-mode and clip-style
distribution, recent users/generations/failures. Recorded media size explicitly excludes
temporary files, audio derivatives and storage overhead; it is not physical disk usage.
`/admin/users` searches email/name with 25-row pagination. Static
`/admin/users/detail?id=<id>` includes bounded ledger, generation/Quick Reframe histories,
failures, audit entries, credit controls and suspension. Normal users cannot mount admin
pages or call admin APIs. Settings provides account information, remaining credits and
revocable account-owned Ask AI consent. Login/signup are mobile-compatible.

## Owner bootstrap and operator recovery

Set ADMIN_EMAIL and ADMIN_INITIAL_PASSWORD in ignored root `.env`, then start the backend.
An existing owner's password is never reset at startup. The local helper
`node scripts/bootstrap-owner-config.cjs <confirmed-email>` creates a random password and
saves it only to ignored `.env` and `storage/security-backups/owner-login.txt`. Restrict these
files to the laptop operator. Never include passwords/cookies in reports or screenshots.

There is no email password-reset flow or email verification in v1: no mail delivery provider
is configured. For account recovery, an authorized laptop operator can pipe a new password
over stdin to `node scripts/reset-password.cjs <email>` inside the backend container. It
validates/hashes the password and revokes existing sessions. Do not pass it as a CLI argument.
Remove ADMIN_INITIAL_PASSWORD from production configuration after securely saving the
credential; existing account startup does not need the initial password. Retain
`PASSWORD_HASH_PEPPER` across deployments and operator password resets.

## Migration and verification

Never reset production. Back up PostgreSQL before `prisma migrate deploy`. The additive
thumbnail compatibility migration also makes fresh installations match the legacy schema.
Old nullable ownership is invisible to new users until explicitly attributed. After exact
counts and owner confirmation, `scripts/claim-legacy-owner.cjs` dry-runs by default;
`--apply --expected=<exact JSON>` assigns only unowned roots and writes an audit entry.
It preserves all content and storage references. It does not charge old generations.

`node scripts/run-auth-tests.cjs` creates a random disposable PostgreSQL database, refuses
nonempty Redis database 15, applies migrations, runs real HTTP/security/database/storage
tests, and removes the test database, bucket, accounts and keys. Queue dispatch for clip
tests is replaced by a recorder; actual FFmpeg regressions and live generation acceptance
provide separate rendering evidence. Do not point this test at production.

Security references: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html),
[OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
