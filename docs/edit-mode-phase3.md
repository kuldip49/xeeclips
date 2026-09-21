# EditMode Phase 3 state contract

Phase 3 continues to use `EditProject`, `EditAsset`, `EditElement`, and `EditHistory` as its only
authoritative editor state. It does not enqueue processing or render jobs.

## Coordinates

Visual element `properties` use normalized coordinates relative to the 16:9 preview canvas. `x`
and `y` locate the top-left anchor; `width` and `height` are fractions of the canvas. All four are
in the inclusive `0..1` range, and commands clamp the element bounding box within the canvas.
Images and logos preserve their aspect ratio during pointer resizing by default. `rotation` is in
degrees, `opacity` is `0..1`, and `zIndex` controls deterministic overlay paint order. Video is
always the background.

## Audio

Audio `volume` is normalized: `0` is silent and `1` is the uploaded asset's original level.
`startTime` and `duration` use edit-timeline seconds; `trimStart` and `trimEnd` use source-asset
seconds. Fade values are seconds and may not exceed the element duration in total. Ducking fields
are stored as a future-facing foundation but do not affect Phase 3 preview or the automatic
pipeline.

Browser preview synchronizes music to timeline time and approximates fades through the media
element volume. Browser scheduling and seeking can drift slightly and are not a production mix.
