# Quick Reframe social post copy

Quick Reframe imports available public Instagram/X post descriptions, Unicode hashtags, author label,
title and normalized source URL alongside the media. The existing public retriever, CDN allowlist,
DNS pinning and rights/authorization gates remain in use. No cookies, private content, login scraping
or protection bypass is added. Missing post text never fails an otherwise successful video import.

`QuickReframe.sourceContext` and `QuickReframe.postCopy` are additive JSON columns, created by
`20261007130000_quick_reframe_post_copy`. Post copy stores five caption styles, three hashtag groups,
selected editable copy, structured content understanding and a separate optimistic edit version.
Saving copy does not change a media revision, timeline element, export asset or credit balance.

The crop-first sequence remains Import → manual Crop → Done Cropping → choose StyleOne/Manual.
Only then may local analysis or social copy generation run. Both the social-copy and hook endpoints
enforce the crop/mode boundary, including when analysis is cached from a previous crop.

The shared **Caption & Hashtags** panel appears in StyleOne editing, the canonical Manual editor's
separate tool, and Export before download. Original copy is collapsible. The crop step has no new
controls. Suggested captions (Concise, Engaging, Professional, Conversational, Bold) are editable,
copyable and selectable; one is Recommended for grounding and clarity. Rewrite original offers
Shorter, More engaging, Professional, Casual, Stronger opening and Cleaner CTA. Focused/Broad/Niche
hashtags can be selected, removed, added and copied. Save post copy persists custom wording for
reopening; History offers Copy Caption, Copy Hashtags and Copy Caption + Hashtags.

These tools never emit editor commands or render social copy as video subtitles. Video Captions
remain in their own existing workflow, including the crop-aware readable-subtitle duplicate check.
The existing StyleOne compiler and preview/export renderers are unchanged.

Generation uses retained source transcript segments, readable OCR inside the confirmed crop, visible
burned-in/video subtitles, the canonical hook, source post text/hashtags, selected Social Caption and
editing direction/purpose. OCR removed by a crop or cleanup and transcript segments removed by timeline
trims are excluded. Original post text alone cannot drive suggestions. With insufficient real-video
evidence, the panel explains the limitation and still accepts manual copy.

External AI requires account consent in Settings AND per-request authorization. The bounded payload
contains only relevant text and intent, never URLs, author/provider details, internal IDs or media
metadata. Imported text is untrusted prompt data. Suggestions with unsupported numbers, fabricated
quotes, copied originals or insufficient video overlap are rejected in favor of grounded local
suggestions. Generated hashtags are filtered for actual-video relevance. This validation is a
conservative quality guard, not a guarantee of perfect semantic accuracy; users can review/edit every
option. A local extractive fallback handles unavailable or unauthorized OpenAI. It does not promise
the same rewrite richness as an external language model.

API: `POST /quick-reframe/:id/post-copy` generates suggestions; `PUT` saves selected caption/hashtags.
Both require the current media `revision` and copy `version`. Generation also accepts per-request
`externalAiAuthorized`, optional `rewrite`, `editingDirection` and `purpose`. Existing ownership,
CSRF and submission rate limits apply. Conflicting saves or edits during generation return 409.
`hashtagsOnly` refreshes hashtag suggestions while retaining existing caption variants. Saving an
edited option with `captionStyle` also persists that variant's wording.

Verification:

- `npm run test:quick-reframe-post-copy --workspace apps/backend`: public metadata fixtures,
  absent metadata, transcript grounding, AI payload/consent/fallback, rewrite, hashtags,
  retained crop/trim evidence, optimistic writes and separation from media.
- Existing Quick Reframe V3 and StyleOne scripts, plus Create Clips UI/selection regression.
- `e2e/quick-reframe-post-copy.spec.ts` plus `quick-reframe.spec.ts`: 16 browser tests, including
  375/390/1280px, edits/copy/rewrite/tag controls, reload/History, both paths and manual crop regressions.
- `verify-quick-reframe-post-copy.cjs`: synthetic owned video with actual OCR, headline versus
  readable burned-in subtitles, both rendering paths, History/ownership/credits and H.264 download.
  This script refuses any database outside the disposable `reframe_post_copy_test_` namespace.

Social import metadata is tested with disposable public-post fixtures. No third-party private post
is fetched during verification. Live platform eligibility remains subject to the public adapter's
availability. `.gitignore` now explicitly retains the existing backend Storage module, which the
runtime `storage/` ignore pattern previously excluded from fresh Git checkouts.

## Production acceptance — 2026-10-08

Feature commit `3ba9fad` was pushed to `kuldip49/xeeclips` main. A clean snapshot excluded the
pre-existing unrelated authentication changes. The static Cloudflare deployment is version
`d3a64240-f266-4192-b8fb-42005a6e8a33`; only the backend container was restarted, preserving its
existing asset mounts and persistent volumes. The additive migration ran at backend startup.
The user approved a local database backup before deployment; the Git-ignored dump is retained
under `storage/reframe-post-copy-qa/production-before.dump`.

All 16 browser acceptance/crop regression tests passed against the public `xeeclip.me` frontend,
using disposable mocked API fixtures. A separate live HTTPS API smoke test used a synthetic owned
video and disposable account: actual OCR, no analysis before crop/mode, five caption variants,
three hashtag groups, account/per-request consent, successful OpenAI with no fallback warning,
copy editing, History restore, unchanged canonical composition, H.264 download and exactly one
export credit passed. The account, media and its own credit records were removed afterward.

Both StyleOne and Manual paths also passed live OCR/render/export verification in an isolated
database, Redis database and private media bucket, including readable burned-in subtitles versus
missing subtitles. The isolated backend, test database, empty media bucket and test queue were
removed after verification. Existing Create Clips selection, content-package, UI and FFmpeg export
regressions passed; its export test fixture was updated to support the existing object-key lookup.

Production record counts and credit totals matched the pre-deployment snapshot: 2 users,
26 projects, 24 videos, 162 generated clips, 87 edit projects, 4 Quick Reframe items, 3 credit
transactions, 1 credit reservation, total balance 5 and consumed credits 0. Existing authentication
changes in the working directory remain uncommitted and were not deployed with this release.
