# Sound-design assets

Drop your own short effects here. The folder a file sits in *is* its category —
no manifest is required, and nothing is ever downloaded automatically.

```
zoom-in/      soft rising whoosh, played as the camera pushes in
zoom-out/     soft reverse whoosh / air pull, played as the camera pulls back
transition/   subtle sweep across a hard change of frame
reveal/       short tonal hit on the reveal word
stat/         very light impact under a number or statistic
impact/       low-intensity accent for a punchline or hard statement
```

Supported formats: `.wav` `.mp3` `.m4a` `.ogg` `.flac`.

Keep them tasteful and short (roughly 0.2–1.0 s). Loud meme sounds and cartoon
stings are not what this system is for: every effect is mixed under the dialogue,
ducked by the speech it plays beneath, and peak-limited, so anything aggressive
will simply be squashed.

## Optional refinement

`sfx.json` at this level overrides individual files. Only include what you want
to change:

```json
{
  "assets": [
    { "file": "zoom-in/whoosh-soft.wav", "loudnessLufs": -18, "weight": 2 },
    { "file": "impact/heavy.wav", "enabled": false },
    { "file": "reveal/bell.wav", "type": "STAT_HIT", "license": "OWNED" }
  ]
}
```

- `loudnessLufs` (default `-20`) is how the level is matched to the category
  target, so an unusually hot or quiet file still lands where it should.
- `weight` (default `1`) biases the deterministic pick; `0` disables the file.
- `type` re-categorises a file without moving it.
- `priority` (default `10`) — local files always outrank the generated effects.

## Without any assets

The renderer can synthesize its own plain effects in-graph (filtered noise swells
and soft low sines), so motion has matching sound design even with this folder
empty. A real file always wins over the generated one.

**Sound design is OFF by default.** The current editorial standard for AI_EDITED
clips is dialogue/source audio only: no effect is selected or mixed, and the SFX
quality checks report N/A rather than failing an edit. Everything below still
works exactly as described — set `EDIT_SFX_ENABLED=true` to turn it back on.

Environment:

- `EDIT_SFX_ENABLED=true` — turn sound design on (default: `false`).
- `EDIT_SFX_DIR` — point at a different folder (default: this one).
- `EDIT_SFX_ALLOW_GENERATED=false` — only ever use files you put here.
