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
