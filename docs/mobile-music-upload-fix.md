# Mobile music upload release — 2026-10-11

The live API was still running `f9ad75c` after the Content Intelligence v2 rollback.
The previously pushed music fixes were absent. A valid synthetic MP3 submitted with
`application/octet-stream` reproduced the screenshot's HTTP 400 error:
`Unsupported audio MIME type or extension`.

Audio uploads now ignore the browser's MIME hint and validate the actual container,
audio stream and duration with a bounded ffprobe call. Supported music containers are
MP3, WAV, M4A/MP4, AAC, OGG/Opus, FLAC and WebM. Playback Content-Type comes from the
probed container, including when a phone supplies a generic/empty/non-standard MIME
type, an uppercase or extensionless filename, or a mismatched supported extension.
Invalid files still return 400 before storage. Image validation remains unchanged.

The release includes the previously tested music insertion, progress, revision queue,
background history reads, persistent preview audio, seek synchronization and retry
fixes. The Media drawer's upload input has an accessible name, and regression tests
exercise its exact **+ Music** entry point.

## Focused deployment

This is a music-only patch on the verified live baseline. It does not deploy the
Content Intelligence v2, ending or hook changes that remain on `main`.

- API image: `xeeclip-backend:mobile-music-20261011`, observed image ID
  `sha256:3e10fda28f9e7ab1c399e9a7b696efebf2f64e22ff618935077cad9c8f831805`.
- Static frontend version: `24399083-3202-4329-b319-a83b4df69b6b` on `xeeclip.me`.
- Worker/AI-service, runtime environment, persistent mounts and original database
  record fingerprints preserved. Local and public API health returned 200.
- Fresh 47,824,836-byte database backup restored successfully into isolated tmpfs
  PostgreSQL. SHA-256: `627142f4337feb0fecc77ade6d84e7f74fee127114cb6b528e435b26857fb51b`.
- Backend rollback retained as `xeeclip-backend-rollback:before-mobile-music`.

`scripts/prepare-mobile-music-release.cjs` prepares the baseline plus the scoped
patch in ignored `.real-qa-preview/mobile-music-release/`. The API image rebuilds
against the baseline dependencies and replaces only the compiled music-related
EditMode service. The static frontend uses the matching baseline shared package.
`scripts/release-mobile-music.cjs` implements verified backup, idle checks,
configuration/mount/data checks and automatic backend rollback on failure.
Its ignored `storage/mobile-music-release/release-compose.json` preserves the
current API image and exact runtime configuration for an intentional restart.
Do not rebuild/deploy all of `main` as a music-only restart; that includes the
separate, broader release still awaiting production acceptance.

## Verification

- Backend and frontend TypeScript builds passed.
- Eight real synthetic audio formats and ten mobile MIME/name variants passed;
  corrupt audio was refused and canonical insertion, controls, undo/redo passed.
- Focused production-image tests: music, phase 3, 226 colour/audio checks and real
  FFmpeg exports passed.
- Six desktop/phone browser scenarios passed against the development editor and
  again against the exact static release preview, including Media → + Music,
  slow history/media, seek synchronization, retry, persistence and all eight
  formats decoding in Chrome.
- Real public HTTPS acceptance in Chrome at 390×844: generic-type MP3 upload,
  automatic insertion, playback, mute/unmute, reload, canonical `audio/mpeg`,
  HTTP 206 streaming, corrupt upload 400, cross-account denial 404 and actual
  exported audio decoding with a non-silent signal all passed. The 33,458-byte
  synthetic MP3 took 3,969 ms from picker submission to an enabled timeline;
  this is a sample measurement, not a guarantee for other files or networks.
- Exactly two disposable QA accounts and their source/music/export assets were
  removed. All original record fingerprints matched after cleanup.

Evidence is retained locally in ignored `storage/mobile-music-release/`.
No existing user clips, external AI service or unrelated user context was used.
The existing 200 MiB editor upload limit and upstream proxy limits remain; this
release does not introduce chunked music uploads or promise every audio codec.
