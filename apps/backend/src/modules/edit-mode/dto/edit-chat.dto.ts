// Chat request bodies. Like the rest of EditMode's DTOs these declare shape
// only; every field is validated in the service against the live project.

export class PlanEditChatDto {
  message?: unknown;
  revision?: unknown;
  selectedElementId?: unknown;
  selectedTimeRange?: unknown;
  playheadSec?: unknown;
}

export class ApplyEditChatDto {
  proposalId?: unknown;
  revision?: unknown;
}

export class CancelEditChatDto {
  proposalId?: unknown;
}
