# Clipper Workspace V1 — local acceptance report

Status: **CLIPPER_WORKSPACE_V1_READY**

Completed locally on 17 October 2026, on `codex/clipper-workspace-v1`, based on main
`791547ed1e692bacec643deb9735268c88b8f204`. Production was not deployed or migrated.
The isolated preview remains available at <http://localhost:3200/clippers>, with QA API
on port 4200. Its users, campaigns, media, credentials and provider fixtures are disposable.

1. **Architecture.** A campaign workflow module references existing Project, Video,
   GeneratedClip and EditProject records. It calls the existing analysis, selection,
   styles, canonical commands, renderer, auth, usage and History services. CampaignRun
   persists orchestration and idempotent requests; it is not another media engine.

2. **Navbar.** Added Clippers beside Create, Quick Reframe, History and Settings.
   Admin remains conditional on the existing admin role. Mobile has a compact Clippers
   entry; the existing bottom navigation remains intact.

3. **Routes.** `/clippers`, `/clippers/campaigns`, `/clippers/campaigns/new`,
   `/clippers/campaigns/:id`, `/clippers/assets`, `/clippers/clips`, `/clippers/ready`,
   `/clippers/posted`, `/clippers/performance`. Dynamic campaigns reuse a static shell.
   Seven routing checks cover campaign HTML/payloads, the literal `new` route, query
   strings and the existing editor/project shells.

4. **Database models.** Added Campaign, CampaignBrief, CampaignAsset, CampaignSource,
   CampaignRun, CampaignClip and CampaignPost. Briefs, snapshots, social copy and
   compliance are validated JSONB; earnings use DECIMAL(14,2), grouped by currency.

5. **Migration status.** The exact SQL and FK/index/default description were presented
   before migration. Only the isolated `clipper-v1-qa` database received it. Seven new
   tables, seven primary keys, nine additional indexes and thirteen foreign keys;
   existing table columns and production rows were not changed. See
   [migration preview](clipper-workspace-migration.md).

6. **Campaign creation.** The five-step wizard saves basics, full rules, assets,
   understanding and reviewed confirmation. Generation stays locked until the current
   brief is confirmed. Validated API updates and archiving preserve canonical resources.

7. **Rule parser.** Structures explicit duration ranges, platforms, topics, keywords,
   CTA, captions, branding, music, hashtags, mentions, tone, audience, posting/submission
   instructions and descriptive deadline/reward text. Conflicts and unclassified
   instructions remain visible. Simple, complex and ambiguous fixtures were tested.

8. **XeeFree understanding.** Deterministic parsing and cached source intelligence.
   It never asks for an online route. Audited interpretation and complete generation
   paths recorded zero cloud, blocked-provider and transport attempts.

9. **XeePro understanding.** Uses the existing online router with existing consent.
   Proposed rules require supplied text evidence; uncertainty survives interpretation.
   A real HTTP QA case classified grounded audience/tone that Free left unresolved,
   followed by explicit correction and confirmation.

10. **Asset upload.** Validates extension, MIME, magic bytes, size and decodability for
    supported media. Owner/campaign-scoped UUID storage, private authenticated streaming,
    byte ranges, safe headers, labels, required/optional use and deletion were exercised.
    TXT is extracted once; PDF/DOCX are reference-only attachments.

11. **Folder/multi-file upload.** Sequential bounded batches support ordinary files and
    browser folder selection. Safe relative paths preserve groups; absolute paths,
    traversal and spoofed media are rejected. Duplicate filenames use distinct storage keys.

12. **Source videos.** Existing chunk upload, owned source attachment and existing public
    import capability are reused. Source authorization is explicit. One locally synthesized
    77.8-second conversation was transcribed locally and shared across campaign runs.

13. **Campaign-aware generation.** Confirmed constraints rank the engine's already usable
    candidates using cached transcript/topic/chapter evidence plus existing content,
    hook and standalone scores. Forbidden/off-topic/invalid-duration/required-keyword
    candidates are excluded. Pro adds semantic relevance judging. Completeness gates remain.

14. **Free zero-cloud proof.** QA traps router entries and provider transports. Both
    remained at zero for Free; a new Free generation after Pro added no Pro calls.
    `acceptance.json` records this extra mode-switch case.

15. **Pro behavior.** All three styles ran through the online context using safe provider
    fixtures. Pro mode propagates from campaign selection to rendering, persisted clip
    telemetry, canonical editor origin and global History. Busy returns exactly:
    “XeePro is busy right now. Try XeeFree or try again later.” No automatic mode switch.

16. **StyleZero.** Free and Pro produced playable canonical MP4s with correct mode,
    captions, required logo, compliance, editor link and current export.

17. **StyleOne.** Free and Pro retained the existing composition and exported logo,
    background music, captions and required CTA. Posting/metrics and deterministic fixes
    were exercised on these clips.

18. **StyleTwo.** Free and Pro retained the existing style and exported the mapped logo
    and captions. The same final video plays in the campaign card and downloads.

19. **Logo application.** Required mapped logos use existing canonical assets and commands.
    Campaign sizing accounts for the output aspect ratio. Automatic headlines can move
    within the header to avoid the mark; manually edited/user text keeps its geometry.
    Overlap that remains is a visible review warning. Six exported logos were checked
    with actual decoded pixels against their canonical editor positions.

20. **Music application.** Only explicitly required mapped tracks are added, using existing
    audio commands and bounded looping when necessary. Compliance checks audible interval
    coverage. Optional references are not automatically inserted.

21. **CTA application.** Explicit confirmed CTA/required text is added as canonical text.
    Presence is rechecked after edits. Real StyleOne exports and editor previews contained
    the requested “Learn more” CTA.

22. **Compliance engine.** PASS/WARN/FAIL/UNKNOWN/NOT_APPLICABLE checks cover duration,
    topics/keywords, mapped media, captions, headline, CTA, forbidden CTA, required text,
    aspect ratio, hashtags and mentions. Nuanced style/posting rules require human review.
    Unknown or failed checks block Ready. Cache keys include canonical revision and brief version.

23. **Compliance UI.** Cards show match score, lifecycle, detailed reasons and current/stale
    export status. Warning acceptance is explicit. Mobile tests exercised failures,
    automatic fixes and Ready gating at 375px and 390px.

24. **Automatic fix.** Explicit action calls canonical commands for mapped assets, eligible
    text, captions and aspect. Removing/moving a logo caused FAIL; fixing restored PASS.
    Fixes invalidate Ready and require a current export. They do not regenerate the source.

25. **Editor integration.** Edit Video opens the existing canonical editor only on request.
    Existing crop, playback, Undo/Redo and export passed a real browser regression.
    All six campaign projects retained the correct Free/Pro origin and visible branding.

26. **Ready to Post.** Requires confirmed current rules, PASS or accepted WARN, and an
    export of the current revision. Atomic revision/brief predicates guard the transition.
    A changed edit is immediately excluded from Ready summary counts.

27. **Social caption/hashtags.** Grounded existing creative packages supply captions and
    hashtags; confirmed campaign additions supply CTA/mentions/posting notes. Required
    mentions enter the copyable caption. Copy/edit controls work; removing required
    hashtags/mentions fails the relevant checks without another generation.

28. **Posted.** Records a manually made post: platform, optional HTTPS URL, date and notes.
    It requires Ready/current export. No social publishing integration is introduced.

29. **Metrics.** Validated non-negative integer views, likes, comments and shares.
    Recorded fixture: 1,234 views and 97 total engagements. Overview/campaign pages use
    stored values, averages, best clip reference and best campaign by views.

30. **Earnings.** Recorded USD 12.50 aggregated exactly; excessive decimal precision and
    negative metrics were rejected. Currencies remain separate. Payout descriptions never
    become invented earnings or automatic approval estimates.

31. **Ownership/security.** Explicit service ownership, existing request/Prisma scopes and
    recursive ownership validation protect every new resource. Real second-user reads,
    mutations, asset streaming, source attachment, fixes and metric changes were denied.
    Public generation parsing cannot inject trusted campaign context. Untrusted inherited
    object keys cannot become rule fields or styles.

32. **Credits.** Existing generation policy charged exactly once for successful requests;
    duplicate submissions reused the same run. Busy with no output refunded under existing
    policy. Rule edits, assets, compliance, fixes, canonical re-exports and metrics did not
    add generation charges.

33. **Desktop.** Wizard, navigation, assets, rules, cards, posting and metrics passed at
    1440px. Real canonical editor/branding checks used a larger desktop viewport.

34. **375px.** All workflow controls and live pages passed; no document horizontal overflow.
    Screenshots are retained under `.real-qa-preview/clipper-v1/browser/`.

35. **390px.** The same mock and live workflows, media playback and overflow checks passed.

36. **Performance.** Source analysis is reused. Compliance reads cached retained evidence
    and canonical state without ASR/OCR/cloud calls. Five local cached reads measured
    110/44/37/44/48 ms (57 ms mean); this is fixture evidence, not a production SLA.

37. **Tests.** 54 focused campaign checks; six real mode/style cases plus Free-after-Pro;
    16 additional real HTTP workflow checks; nine Clipper browser workflows; four live
    campaign/browser tests; seven static routing checks. Backend build, shared build,
    frontend typecheck and complete 28-page static build passed. The static build used
    an isolated HTTPS placeholder and was not published.

38. **Regressions.** All 17 selected backend suites passed, covering Quick Reframe modes,
    transcript, styles, copy, hook grammar, candidates, selection, media export, style
    readiness, rematerialization, headline-fit, Free policy and busy behavior. Browser:
    22 Quick Reframe result cases, seven post-copy cases, four crop geometry cases and
    one real crop/Undo/Redo/export case passed. The stale candidate test fixtures were
    updated to the current complete critic/timing contracts; production gates were retained.

39. **Known limitations.** Pro availability, quota and response contracts were tested with
    mocks, not paid live providers. Nuanced semantic/branding judgments require human
    review. PDF/DOCX and screenshots are references; paste their rules as text. Source
    imports retain existing capability restrictions. Analytics and earnings are manual.
    The orchestration scanner targets the current single-backend deployment; multiple
    scanner replicas need coordinated claiming before horizontal scaling.

40. **Files changed.** New campaign backend module (six files), seven-table SQL/schema,
    shared campaign contracts, nine frontend page files covering nine routes, five UI
    components and API types. Integrated App/EditMode modules, ownership/security/Prisma,
    selection/export routing, navbar and Cloudflare shells. Added QA Compose, provider
    fixtures/preparation/media scripts, API/browser/routing tests and these two reports.
    The full working-tree manifest is in `.real-qa-preview/clipper-v1/files-changed.txt`.

41. **Commit status.** Changes are local and uncommitted on `codex/clipper-workspace-v1`.
    No push, main merge, production migration or deployment. Preserved the three unrelated
    pre-existing untracked editor-timing release scripts.

## Reproduce the isolated checks

From the repository root, review the exact SQL first. Build shared/backend and generate
Prisma, then use `node apps/backend/scripts/prepare-campaign-qa.cjs` and the dedicated
`infra/docker/clipper-v1-qa.yml` with Compose project name `clipper-v1-qa`. The image
preparation reuses the locally available baseline image `xeeclip-backend:result-flow-791547e`.
It never starts production services. Generate disposable Windows SAPI/FFmpeg media with
`apps/backend/scripts/make-campaign-fixtures.ps1`.

Run `verify-campaigns.cjs`, `verify-campaign-workflow.cjs` and
`verify-campaign-exports.cjs` from `apps/backend/scripts/`. Browser tests use
`E2E_FRONTEND_URL=http://localhost:3200`, `E2E_API_URL=http://localhost:4200`, and
`CLIPPER_LIVE_QA=1` for `clippers-live.spec.ts`. Private QA cookies stay in ignored
`.cache/clippers/qa/browser-private.json`; do not commit them.

Evidence is in ignored `.real-qa-preview/clipper-v1/`: acceptance/workflow/performance JSON,
six final MP4s, desktop/mobile/editor screenshots and backend regression logs.
