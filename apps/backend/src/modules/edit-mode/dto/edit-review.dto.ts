export class ReviewEditDto {
  message?: unknown;
  revision?: unknown;
  selectedElementId?: unknown;
  selectedTimeRange?: unknown;
  playheadSec?: unknown;
}

export class ProposeReviewSuggestionDto extends ReviewEditDto {
  findingId?: unknown;
}

export class CreateEditBriefDto {
  brief?: unknown;
  revision?: unknown;
  selectedElementId?: unknown;
  selectedTimeRange?: unknown;
  playheadSec?: unknown;
}

export class RespondEditBriefDto {
  message?: unknown;
  revision?: unknown;
  selectedElementId?: unknown;
  selectedTimeRange?: unknown;
  playheadSec?: unknown;
}
