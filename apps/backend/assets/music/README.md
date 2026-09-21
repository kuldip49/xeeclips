# Curated music library


**Background music is OFF by default.** The current editorial standard for
AI_EDITED clips is dialogue/source audio only: no bed is selected, mixed, ducked
or faded, and the music quality checks report N/A rather than failing an edit.
Everything below still works exactly as described — set `EDIT_MUSIC_ENABLED=true`
(and `EDIT_MUSIC_REQUIRED=true` if a bed should be mandatory) to turn it back on.

Drop your own audio into the mood folders here. Nothing is ever downloaded
automatically — only files already on disk are indexed.

```
assets/music/
  documentary/   podcast/     tension/      technology/
  motivational/  emotional/   neutral/      energetic/   atmospheric/
  curated.json   <- written by scripts/scan-music-library.cjs (your tracks)
  library.json   <- written by scripts/generate-music-library.cjs (generated beds)
  generated/     <- the generated bed files
```

The two manifests are kept separate on purpose: regenerating the in-house beds
can never drop one of your tracks from the library.

## Adding tracks

1. Copy the file into the folder that matches its mood. The folder name is the
   track's default mood:

   | folder | mood |
   | --- | --- |
   | `documentary`, `podcast`, `interview` | `SUBTLE_DOCUMENTARY` |
   | `tension`, `dramatic` | `DOCUMENTARY_TENSION` |
   | `technology`, `tech` | `MODERN_MINIMAL` |
   | `motivational`, `energetic`, `upbeat` | `ENERGETIC_LIGHT` |
   | `emotional`, `warm`, `calm` | `CALM_WARM` |
   | `neutral`, `clean`, `educational` | `CLEAN_NEUTRAL` |
   | `atmospheric`, `ambient` | `ATMOSPHERIC` |

2. Re-scan:

   ```bash
   cd apps/backend
   node scripts/scan-music-library.cjs --license ROYALTY_FREE_APPROVED
   ```

   The scan probes each file with ffprobe for duration and format, measures
   integrated loudness with `ebur128` (pass `--no-loudness` to skip), and writes
   `curated.json`.

Supported formats: `.mp3`, `.m4a`, `.wav`, `.aac`, `.ogg`, `.flac`.

## Licensing

Every track carries a license. Only these are used in production:

`OWNED`, `LICENSED`, `ROYALTY_FREE_APPROVED`, `GENERATED_IN_HOUSE`, `CC0`,
`ROYALTY_FREE_LICENSED`

`--license` sets the default for a scan; anything else (including the default
`UNKNOWN`) is written to the manifest but refused by the renderer unless
`EDIT_MUSIC_ALLOW_UNLICENSED=true`, which is for local auditioning only.

## Per-track metadata

Any field can be overridden with a sidecar `<track>.json` next to the file, or a
`meta.json` in the folder keyed by filename:

```json
{
  "title": "Slow Ascent",
  "moods": ["DOCUMENTARY_TENSION", "ATMOSPHERIC"],
  "license": "LICENSED",
  "attribution": "Composer Name — Licence #12345",
  "energy": "MEDIUM",
  "texture": "PAD",
  "weight": 2,
  "priority": 20,
  "enabled": true
}
```

* `energy` — `LOW` / `MEDIUM` / `HIGH`
* `texture` — `PAD` (sustained), `DRONE` (texture, no motion), `PULSE` (rhythmic)
* `weight` — bias inside a priority tier (1 = normal, 0 = never used)
* `priority` — curated tracks default to 10, generated beds to 0, so your own
  material is preferred whenever it matches the mood
* `enabled: false` — keep the file but stop using it

## How a track is chosen

Luna decides editorial intent only (`musicMood`, `musicEnergy`, `musicTexture`)
and never names a file. The library then picks the highest-priority track whose
mood matches, ranked by energy/texture fit and `weight`, with a reuse penalty
against the other clips already rendered from the same source video — so five
clips from one video do not all get the same bed. `NONE` remains a valid
editorial decision for solemn or dense material.
