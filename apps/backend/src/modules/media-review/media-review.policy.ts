import { createHmac, timingSafeEqual } from "node:crypto";
export const REVIEW_SCOPE = "xeeclip:media:review";
export const REVIEW_TTL = 15 * 60 * 1000;
export const REQUEST_TTL = 10 * 60 * 1000;
export class VideoReviewError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export const reviewMessages: Record<string, string> = {
  AI_VIDEO_REVIEW_EVIDENCE_REQUIRED:
    "Retrieve and inspect the approved rendered media before reporting review findings.",
  AI_VIDEO_REVIEW_PASS_COMPLETE:
    "This render's review is complete. Export requested changes or request a new review.",
  AI_VIDEO_REVIEW_DISABLED:
    "Turn on AI Video Review in XeeClip Settings to request a review.",
  AI_VIDEO_REVIEW_APPROVAL_REQUIRED:
    "Approve this specific video review in XeeClip Settings before media can be accessed.",
  AI_VIDEO_REVIEW_DENIED:
    "You declined this video review. No media access was granted.",
  AI_VIDEO_REVIEW_EXPIRED:
    "This review access has expired. Request a new review if needed.",
  AI_VIDEO_REVIEW_REVOKED: "This review access has been revoked.",
  AI_VIDEO_REVIEW_COMPLETE:
    "This review is complete. Request a new review for further access.",
  AI_VIDEO_REVIEW_CHANGED:
    "The rendered video changed. Request approval for the new render.",
  AI_VIDEO_REVIEW_LIMIT:
    "This review session reached its limit. Request a new review if needed.",
  AI_VIDEO_REVIEW_NOT_READY:
    "Export the video before requesting a review of its rendered media.",
  AI_VIDEO_REVIEW_FAILED:
    "The approved media could not be inspected. Try this review again or request a new one.",
  AI_VIDEO_REVIEW_BUSY:
    "This video review is already running. Wait a moment before checking again.",
};
function key() {
  const secret = process.env.PASSWORD_HASH_PEPPER;
  if (!secret || secret.length < 32)
    throw new VideoReviewError("AI_VIDEO_REVIEW_FAILED");
  return createHmac("sha256", secret)
    .update("xeeclip-media-review-v1")
    .digest();
}
export const reviewSign = (value: string) =>
  createHmac("sha256", key()).update(value).digest("base64url");
export function equalSignature(actual: unknown, expected: string) {
  if (typeof actual !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(actual))
    return false;
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
