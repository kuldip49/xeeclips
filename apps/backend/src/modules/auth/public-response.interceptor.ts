import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs';

const privateFields = new Set(['bucket', 'objectKey', 'storageKey', 'storageObjectKey',
  'audioBucket', 'audioObjectKey', 'thumbnailObjectKey', 'passwordHash', 'tokenHash',
  'stack', 'stderr', 'rawResponse', 'providerResponse', 'providerMetadata',
  'provider', 'model', '_intelligenceInternal', 'internal']);

export function publicErrorMessage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicErrorMessage);
  if (typeof value !== 'string') return value;
  return /^The export render failed\b|^The exported file did not pass EditMode QA\b|prisma|ffmpeg|ffprobe|libav\w*|stack\s*trace|\n\s+at\s|s3:\/\/|storage[ _-]?key|object[ _-]?key|openai|anthropic|gemini|nemotron|gpt-\d|provider\s*[:={]|"(?:model|provider|error)"\s*:/i.test(value)
    ? 'Processing could not finish. Please try again.' : value;
}

/** HTTP-only projection: internal editor/render services retain their storage locators. */
export function publicResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicResponse);
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !privateFields.has(key))
    .map(([key, item]) => [key, publicResponse(['error', 'message', 'lastError'].includes(key) ? publicErrorMessage(item) : item)]));
}

@Injectable()
export class PublicResponseInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(map(publicResponse));
  }
}
