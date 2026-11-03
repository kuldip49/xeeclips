import { ImportError } from './source-import-errors';

export function parseYouTubeUrl(input: unknown) {
  if (typeof input !== 'string' || input.length > 2048) {
    throw new ImportError('INVALID_URL', 'Enter a valid YouTube video URL.');
  }
  let url: URL;
  try { url = new URL(input.trim()); } catch {
    throw new ImportError('INVALID_URL', 'Enter a valid YouTube video URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    throw new ImportError('INVALID_URL', 'Use a public HTTPS YouTube video URL.');
  }
  const host = url.hostname.toLowerCase();
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) {
    throw new ImportError('UNSUPPORTED_PROVIDER', 'Only YouTube video links are supported.');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const id = host === 'youtu.be' && segments.length === 1 ? segments[0]
    : segments.length === 1 && segments[0] === 'watch' ? url.searchParams.get('v')
    : segments.length === 2 && ['shorts', 'live'].includes(segments[0]) ? segments[1] : null;
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) {
    throw new ImportError('INVALID_URL', 'The YouTube link must identify one video.');
  }
  return { externalVideoId: id, sourceUrl: `https://www.youtube.com/watch?v=${id}` };
}


/** The implemented provider registry also drives website and MCP capabilities. */
export const SOURCE_PROVIDERS = [
  { id: 'YOUTUBE', approval: 'YOUTUBE_IMPORT_APPROVED', extractor: /^Youtube$/u },
  { id: 'INSTAGRAM', approval: 'QUICK_REFRAME_SOCIAL_IMPORT_APPROVED', extractor: /^Instagram$/u },
  { id: 'X', approval: 'QUICK_REFRAME_SOCIAL_IMPORT_APPROVED', extractor: /^Twitter$/u },
] as const;
export type SourceProvider = typeof SOURCE_PROVIDERS[number]['id'];
export function resolveSourceUrl(input: unknown): { provider: SourceProvider; externalVideoId: string; sourceUrl: string } {
  if (typeof input !== 'string' || input.length > 2048) throw new ImportError('INVALID_URL', 'Enter a public HTTPS video URL.');
  let u: URL; try { u = new URL(input.trim()); } catch { throw new ImportError('INVALID_URL', 'Enter a valid HTTPS video URL.'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) throw new ImportError('INVALID_URL', 'Use a public HTTPS video URL without credentials.');
  const host = u.hostname.toLowerCase();
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) return { provider: 'YOUTUBE', ...parseYouTubeUrl(input) };
  const instagram = /^\/(reel|reels|p|tv)\/([a-zA-Z0-9_-]+)\/?$/u.exec(u.pathname);
  if (['instagram.com', 'www.instagram.com'].includes(host) && instagram) return {
    provider: 'INSTAGRAM', externalVideoId: instagram[2], sourceUrl: `https://www.instagram.com/${instagram[1]}/${instagram[2]}/` };
  const tweet = /^\/([a-zA-Z0-9_]{1,15})\/status\/(\d+)\/?(?:video\/(\d+)\/?)?$/u.exec(u.pathname);
  if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host) && tweet) {
    const index = Number(tweet[3] || 1);
    if (!Number.isSafeInteger(index) || index < 1 || index > 100) throw new ImportError('INVALID_URL', 'Choose a valid video within the post.');
    return { provider: 'X', externalVideoId: tweet[2] + (index === 1 ? '' : `:video:${index}`),
      sourceUrl: `https://x.com/${tweet[1]}/status/${tweet[2]}/video/${index}` };
  }
  throw new ImportError('UNSUPPORTED_PROVIDER', 'This video platform or link type is not supported by XeeClip.');
}
export function sourceProviderEnabled(provider: SourceProvider) {
  return process.env[SOURCE_PROVIDERS.find(p => p.id === provider)!.approval] === 'true';
}
export function requireSourceProvider(provider: SourceProvider) {
  if (!sourceProviderEnabled(provider)) throw new ImportError('IMPORT_UNAVAILABLE', 'Video link import is temporarily unavailable for this platform.');
}
export function sourceImportErrorCode(code: string | null | undefined) {
  const known: Record<string, string> = {
    UNSUPPORTED_PROVIDER: 'UNSUPPORTED_SOURCE', INVALID_URL: 'INVALID_INPUT',
    PRIVATE_VIDEO: 'SOURCE_PRIVATE', LOGIN_REQUIRED: 'SOURCE_LOGIN_REQUIRED', AGE_RESTRICTED: 'SOURCE_LOGIN_REQUIRED',
    DRM_PROTECTED: 'SOURCE_DRM_PROTECTED', DURATION_LIMIT: 'SOURCE_TOO_LONG', VIDEO_TOO_LONG: 'SOURCE_TOO_LONG',
    REGION_RESTRICTED: 'SOURCE_REGION_RESTRICTED', VIDEO_NOT_FOUND: 'SOURCE_UNAVAILABLE',
    SOURCE_ADDRESS_BLOCKED: 'UNSUPPORTED_SOURCE', IMPORT_UNAVAILABLE: 'SOURCE_IMPORT_FAILED',
  };
  return known[code || ''] || 'SOURCE_IMPORT_FAILED';
}
