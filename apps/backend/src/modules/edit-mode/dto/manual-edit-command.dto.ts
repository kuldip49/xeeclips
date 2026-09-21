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

export class Phase3EditCommandDto extends RevisionCommandDto {
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
}
