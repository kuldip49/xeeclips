/**
 * Structured import failure. `code` is the real category (persisted as VideoImport.errorCode and
 * logged), `message` is the user-facing sentence, `detail` is the provider's own reason for logs.
 */
export class ImportError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: string) { super(message); }
}

export const IMPORT_FAILURE_CODES = ['VIDEO_NOT_FOUND', 'PRIVATE_VIDEO', 'LOGIN_REQUIRED',
  'AGE_RESTRICTED', 'REGION_RESTRICTED', 'LIVE_STREAM_UNSUPPORTED', 'NO_VIDEO_FORMAT',
  'NO_AUDIO_FORMAT', 'RATE_LIMITED', 'BOT_CHALLENGE', 'NETWORK_TIMEOUT', 'DOWNLOAD_FAILED',
  'MEDIA_INVALID', 'DRM_PROTECTED', 'STORAGE_FAILED', 'UNKNOWN_PROVIDER_ERROR'] as const;
export type ImportFailureCode = typeof IMPORT_FAILURE_CODES[number];

const UPLOAD = 'You can upload the video file instead.';
export const IMPORT_FAILURE_MESSAGES: Record<ImportFailureCode, string> = {
  VIDEO_NOT_FOUND: `This video doesn't exist or has been removed. Check the link, or upload the file instead.`,
  PRIVATE_VIDEO: `This video is private and can't be imported. ${UPLOAD}`,
  LOGIN_REQUIRED: `This video requires sign-in and can't be imported automatically. ${UPLOAD}`,
  AGE_RESTRICTED: `This video is age-restricted and can't be imported automatically. ${UPLOAD}`,
  REGION_RESTRICTED: `This video is not available in this region. ${UPLOAD}`,
  LIVE_STREAM_UNSUPPORTED: `Live streams can't be imported while they are live. Try again after the stream has ended, or upload the file.`,
  NO_VIDEO_FORMAT: `Automatic import isn't available for this video. ${UPLOAD}`,
  NO_AUDIO_FORMAT: `This video has no usable audio track, so clips can't be made from it automatically. ${UPLOAD}`,
  RATE_LIMITED: `Import temporarily failed. Try again in a few minutes, or upload the file instead.`,
  BOT_CHALLENGE: `This platform is temporarily blocking automatic import. Try again later, or upload the file instead.`,
  NETWORK_TIMEOUT: `Import temporarily failed. Try again, or upload the file instead.`,
  DOWNLOAD_FAILED: `Import failed while downloading. Try again, or upload the file instead.`,
  DRM_PROTECTED: 'This video is protected and cannot be imported.',
  MEDIA_INVALID: `The imported video couldn't be used. ${UPLOAD}`,
  STORAGE_FAILED: `Import failed while saving the video. Try again.`,
  UNKNOWN_PROVIDER_ERROR: `Automatic import isn't available for this video. ${UPLOAD}`
};

export function importFailure(code: ImportFailureCode, detail?: string) {
  return new ImportError(code, IMPORT_FAILURE_MESSAGES[code], detail);
}

/** Failures worth retrying with backoff: the same request can succeed moments later. */
export const TRANSIENT_IMPORT_FAILURES = new Set<string>(['NETWORK_TIMEOUT', 'RATE_LIMITED']);
