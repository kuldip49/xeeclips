export const REVIEW_SEVERITIES = ['NEEDS_ATTENTION', 'COULD_IMPROVE', 'LOOKS_GOOD'] as const;
export type ReviewSeverity = typeof REVIEW_SEVERITIES[number];

export const REVIEW_DIMENSIONS = ['HOOK', 'PACING', 'CAPTIONS', 'FRAMING', 'ZOOM', 'COLOR',
  'AUDIO', 'OVERLAYS', 'STRUCTURE'] as const;
export type ReviewDimension = typeof REVIEW_DIMENSIONS[number];

export type ReviewFinding = {
  id: string;
  dimension: ReviewDimension;
  severity: ReviewSeverity;
  title: string;
  /** Measured or directly stored state only. */
  evidence: string[];
  /** Editorial judgement, deliberately separate from evidence. */
  suggestion: string | null;
  /** Natural-language input for the existing chat proposal path. */
  applyInstruction: string | null;
  previewRange: { startSec: number; endSec: number } | null;
  evidenceLimit: string | null;
};

/** Server-only proposal grounding. Never returned by the review API. */
export type StoredReviewFinding = ReviewFinding & { targetElementId: string | null };

export type EditReview = {
  reviewId: string;
  editProjectId: string;
  revision: number;
  scope: 'PROJECT' | 'SELECTION' | 'RANGE' | 'HOOK' | 'CAPTIONS' | 'AUDIO' | 'PACING';
  summary: string;
  findings: StoredReviewFinding[];
  sampledMomentsSec: number[];
  createdAt: string;
};

/** No internal ids leave the review API. */
export type EditReviewView = Omit<EditReview, 'editProjectId' | 'findings'> & {
  findings: ReviewFinding[];
};
