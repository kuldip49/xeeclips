# XeeClip multi-user release — 2026-10-07

Deployed at https://xeeclip.me. Owner email: `kuldipdhar321@gmail.com`.
No password, cookie, session token or API secret is included in this report.

1. **Architecture.** Static Cloudflare Next.js frontend plus NestJS/PostgreSQL authentication.
   Bcrypt cost 12 and opaque database-backed secure sessions fit the existing API/tunnel and avoid
   per-request Next rendering. See [architecture and operations](authentication-and-credits.md).
2. **User/session schema.** Unique normalized email, password hash, display name, USER/ADMIN,
   ACTIVE/SUSPENDED, balances/consumed usage, AI consent and timestamps. Sessions store a SHA-256
   digest of a random 256-bit token and seven-day expiry; public user APIs omit hashes/tokens.
3. **Migration.** Two additive Prisma migrations applied with migrate deploy. No reset/db push.
   PostgreSQL backup before migration: 21,767,893 bytes, saved locally in ignored storage and
   restricted to the Windows operator. Backup restore was not exercised during this release.
4. **Existing ownership.** The owner explicitly confirmed attribution after exact counts. All
   original content remains: 26 projects, 24 source videos, 162 generated clips, 86 EditProjects,
   3 Quick Reframe sessions, 4 imports, 24 processing jobs and 1 reference asset. Final verification
   found zero unowned roots, one user/one admin and no open credit reservations. Attribution has
   its own audit entry. Existing exports/storage references were preserved.
5. **Bootstrap.** A generated password was used only through ignored bootstrap configuration;
   the password is in local `storage/security-backups/owner-login.txt` with restricted permissions.
   The initial password was removed from runtime configuration after creation. Restart never
   resets an existing account. A stdin-only operator recovery CLI revokes sessions after reset.
6. **Login/signup/logout.** Browser signup/login works on the HTTPS production site. Cookies are
   API-host-only, HttpOnly, Secure, SameSite=Lax and Path=/. Login rotates the current session;
   logout revokes it. Wrong-password responses are generic. Mobile signup was verified at 390px
   without horizontal overflow. Session and balance persistence were tested across fresh backend
   clients and actual production restarts.
7. **History.** API queries and page data are scoped to the account. A and B saw separate History;
   neither saw the 162 old owner clips. Logout/back-navigation did not expose private video state.
8. **Policy.** New USER accounts receive configurable default 5 credits. One per Create Clips
   request, regardless of number of clips; one per Quick Reframe final export, including manual
   Quick Reframe exports. Admin is unlimited. Editing, crop, preview, History, existing downloads
   and ordinary manual-editor exports are free.
9. **Atomic reservation.** Conditional active-user balance decrement, job claim, reservation and
   reserve ledger entry occur in one PostgreSQL transaction. Dispatch happens after commit. Imports
   reserve before downloading and transfer the same reservation into canonical generation.
10. **Refunds.** The first usable output commits with consumption. No usable output releases a
    reservation; conditional transitions prevent double refunds. Usable partial/base output costs
    one even if optional later styling fails. Queue failures, cancellations, terminal reconciliation
    and interrupted manual Quick Reframe exports were covered. Live jobs are not refunded by age.
11. **Admin dashboard.** `/admin`, `/admin/users`, and static `/admin/users/detail?id=...` use the
    existing dark/violet/cyan design. Ordinary accounts cannot mount admin pages or call their APIs.
12. **Statistics.** Actual user/activity/source/clip/Quick Reframe/export totals; post-launch tracked
    generation outcomes, recent users/jobs/failures, seven-day UTC charts, modes and styles. Recorded
    media size is clearly distinguished from full disk use. Legacy generation-request counts are
    not fabricated; reservation-based analytics begin when accounts launch.
13. **Credit management.** Search/pagination, bounded user detail/ledger, ADD/REMOVE/SET with reason
    and confirmation. Live UI verification confirmed the balance stayed unchanged until confirmation.
    Row locks serialize admin adjustments with generation; ledger and audit commit together.
14. **Suspension.** Owner can suspend/reactivate USER accounts. Suspension revokes sessions and
    blocks all API access/login. Production reactivation allowed a new login. Owner is protected
    from suspension; there is no public role-management endpoint.
15. **Audit.** CREDIT_CHANGE, USER_SUSPEND, USER_REACTIVATE and LEGACY_OWNERSHIP_CLAIM store actor,
    target, before/after, reason and timestamp. Disposable account audit entries were retained.
16. **Media.** Guarded ownership checks cover source/generated/editor files, posters and exports.
    Owned ranges returned HTTP 206; cross-account IDs returned 404; anonymous MinIO returned 403.
    Real Chrome decoded a credentialed cross-origin production video. Source/reference attachment
    checks and public-IP-pinned, bounded reference downloads protect private storage.
17. **Security/regressions.** 22 isolated real HTTP/PostgreSQL/Redis/MinIO cases passed: auth,
    CSRF origins, protected/admin routes, mass assignment, IDOR, upload staging, media, consent,
    credits, logout/expiry/rotation, restart persistence, suspension, audit and rate limits. Backend
    and frontend typechecks plus static build passed. Clip selection and unified generation (86),
    frontend Create (60), timeline UX (147), Quick Reframe V3/StyleOne composition, manual editor
    isolation and Phase 7 (62) passed. Real FFmpeg covered multi-segment/text/caption/music/zoom,
    reconstructed clips, shared sources, repeat/stale/silent exports, typed failures and intentional
    source mute. Live Ask AI mute exposed an old QA audio-expectation bug; it was fixed and verified
    by both a new FFmpeg case and the final live manual export.
18. **Concurrency.** Isolated distinct clip requests with one credit accepted exactly one and
    recorded one reservation. Concurrent refund attempts refunded once. Production raced Create
    Clips against Quick Reframe with one credit: exactly one HTTP 201, one NO_CREDITS 403, one
    reserve entry and one consumed credit. Balance stayed zero, never negative.
19. **Production acceptance.** Actual Chrome owner/user login and signup, admin UI/stats/users,
    real source upload/analysis and generation passed. Two renders changed 2→1→0; the third was
    blocked. Admin +3 appeared through account polling and generation worked again. Quick Reframe
    upload/crop/analysis/final export and its alternate manual-editor export consumed one each;
    both routes rejected at zero. Ordinary manual trim/Ask AI/apply/export worked at zero. Media,
    History, suspension/reactivation and logout were verified on the public HTTPS endpoints.
20. **Cleanup.** Both disposable production users, their media/editor/Quick Reframe content,
    empty projects, sessions and usage records were removed using authenticated APIs and exact
    identity-checked operator cleanup. Isolated databases/buckets/test keys were also removed.
    The disposable credential manifest was deleted. Final owner counts match item 4 exactly.
21. **Git.** Implementation, migrations, repeatable tests and documentation are committed/pushed
    to `kuldip49/xeeclips`; the final chat identifies the release commit. Real secrets, credentials,
    database dumps, generated test artifacts and `.env` remain ignored.
22. **Deployment.** Static frontend Worker `xeeclips-frontend` and final Docker backend deployed;
    final frontend version `a8f3f93f-53bd-49f9-8da8-0dc27c1d7ec2`.
    public site and API health verified. The laptop/tunnel architecture and existing storage volumes
    are unchanged. No SSR Worker migration, billing, OAuth, teams or organizations were introduced.
23. **Remaining limits.** No email verification, mail-based reset, MFA or automatic account deletion
    in v1; password recovery requires the laptop operator. Live processing still requires an awake,
    online laptop. Fresh third-party YouTube/social retrieval was not repeated for this auth release;
    eligibility/network limits remain, and ownership/import admission/refund behavior was tested.
    Final backend npm audit reports four moderate advisories in the MinIO dependency chain and no
    high/critical advisories. Repository-wide audit additionally reports build-tool glob/CSS advisories
    (five high, two additional moderate); the static site serves built assets and does not process
    untrusted CSS/glob input at runtime. Compatible framework/router/queue/CSS/image dependency
    patches were applied; the obsolete SSR adapter was removed. Major toolchain/MinIO migrations
    remain a separate maintenance task. This release's tests are not an independent penetration test.

Deployment procedure: [production deployment](production-deployment.md).
