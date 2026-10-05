export class RevisionCommandDto {
  revision?: unknown;
}

export class TrimElementDto extends RevisionCommandDto {
  elementId?: unknown;
  trimStart?: unknown;
  trimEnd?: unknown;
}

export class SplitElementDto extends RevisionCommandDto {
  elementId?: unknown;
  playheadSec?: unknown;
}

export class DeleteElementDto extends RevisionCommandDto {
  elementId?: unknown;
}

export class MoveElementDto extends RevisionCommandDto {
  elementId?: unknown;
  toPosition?: unknown;
  track?: unknown;
}

export class AdjustSourceRangeDto extends RevisionCommandDto {
  start?: unknown;
  end?: unknown;
  startDelta?: unknown;
  endDelta?: unknown;
}

export class Phase3EditCommandDto extends RevisionCommandDto {
  /** Canonical target cardinality; validated by the mutation layer. */
  scope?: unknown;
  elementId?: unknown;
  assetId?: unknown;
  startTime?: unknown;
  duration?: unknown;
  trimStart?: unknown;
  trimEnd?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  opacity?: unknown;
  zIndex?: unknown;
  content?: unknown;
  fontSize?: unknown;
  fontWeight?: unknown;
  fontFamily?: unknown;
  textAlign?: unknown;
  color?: unknown;
  backgroundColor?: unknown;
  rotation?: unknown;
  locked?: unknown;
  volume?: unknown;
  muted?: unknown;
  fadeInSec?: unknown;
  fadeOutSec?: unknown;
  // Manual transform. Values are bounds-checked in edit-mode-transform.ts, not
  // here, so the editor, an assistant bundle and a raw request all get the same
  // answer for the same value.
  cropLeft?: unknown;
  cropRight?: unknown;
  cropTop?: unknown;
  cropBottom?: unknown;
  flipH?: unknown;
  flipV?: unknown;
  scale?: unknown;
  speed?: unknown;
  // Workstream C: text and caption styling. Every value is bounds-checked in
  // edit-mode-text.ts / edit-mode-captions.ts rather than here, so the editor,
  // an assistant bundle and a raw request all get the same answer.
  textStyleId?: unknown;
  captionStyleId?: unknown;
  applyBox?: unknown;
  strokeEnabled?: unknown;
  strokeColor?: unknown;
  strokeWidth?: unknown;
  shadowEnabled?: unknown;
  shadowColor?: unknown;
  shadowOpacity?: unknown;
  shadowBlur?: unknown;
  shadowOffsetX?: unknown;
  shadowOffsetY?: unknown;
  backgroundEnabled?: unknown;
  backgroundOpacity?: unknown;
  backgroundPadding?: unknown;
  backgroundRadius?: unknown;
  letterSpacing?: unknown;
  lineSpacing?: unknown;
  uppercase?: unknown;
  activeWordEnabled?: unknown;
  activeWordColor?: unknown;
  visible?: unknown;
  atSec?: unknown;
  direction?: unknown;
  // Workstream D: colour. One field per control, bounds-checked in
  // edit-mode-color.ts rather than here, so the editor, an assistant bundle and
  // a raw request all get the same answer for the same value.
  exposure?: unknown;
  brightness?: unknown;
  contrast?: unknown;
  highlights?: unknown;
  shadows?: unknown;
  saturation?: unknown;
  temperature?: unknown;
  tint?: unknown;
  sharpness?: unknown;
  fade?: unknown;
  vignette?: unknown;
  filterId?: unknown;
  strength?: unknown;
  fromElementId?: unknown;
  // Workstream D: audio. Bounds live in edit-mode-audio.ts.
  duckEnabled?: unknown;
  duckStrength?: unknown;
  attackMs?: unknown;
  releaseMs?: unknown;
  // Workstream E: the bulk form of SET_ELEMENT_VISIBLE / SET_ELEMENT_LOCKED,
  // used when a timeline track header toggles a whole track at once.
  // Workstream G also accepts elementType SUBTITLE on the text style commands
  // and MOVE_ELEMENT, so the caption track can be restyled as one target.
  elementType?: unknown;
  // Workstream G: zoom events. `scale` above is the peak scale; bounds live in
  // edit-mode-zoom-events.ts.
  enabled?: unknown;
  claimsMoment?: unknown;
  triggerText?: unknown;
  // Step 5: semantic targets (HOOK / LOGO), framing, reframe policy, relative
  // zoom strength. Validated by the command layer.
  semanticRole?: unknown;
  mode?: unknown;
  aspectRatio?: unknown;
  fitMode?: unknown;
  policy?: unknown;
  clearSegmentOverrides?: unknown;
  step?: unknown;
  background?: unknown;
}

export class ProjectConstraintsDto extends RevisionCommandDto {
  constraints?: unknown;
}
