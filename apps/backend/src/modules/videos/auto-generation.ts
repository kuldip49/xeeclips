import { BadRequestException } from '@nestjs/common';
import { ClipCreationRequest, parseClipCreationRequest } from './clip-selection.service';
import { MAX_REQUESTABLE_CLIPS, validateRequestedClipCount } from '../processing/clip-selection-policy';

const ENTRY_TEMPLATES = new Set(['AUTOMATIC_1', 'AUTOMATIC_2', 'AUTOMATIC_3_STYLE_TWO', 'AUTOMATIC_RAW']);

/**
 * One-step entry (upload or YouTube link): the clip request the user chose before the source
 * existed. It is exactly the body the "Create clips" button posts to clip-selection, validated
 * up front so a bad choice fails on submit rather than after a long import and analysis.
 * Multipart uploads send it as a JSON string. Returns null when nothing was chosen.
 */
export function parseAutoGeneration(value: unknown): ClipCreationRequest | null {
  if (value == null || value === '') return null;
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch {
      throw new BadRequestException('generationRequest must be a JSON object');
    }
  }
  const request = parseClipCreationRequest(raw);
  // Up to the largest count any source allows; the source's own maximum (8 / 20 / 30 by
  // length) is applied again when the request starts, once the duration is known.
  const requestedClipCount = validateRequestedClipCount(request.requestedClipCount,
    MAX_REQUESTABLE_CLIPS);
  const templateId = request.generation?.templateId ?? null;
  if (!templateId || !ENTRY_TEMPLATES.has(templateId))
    throw new BadRequestException('Choose StyleZero, StyleOne, StyleTwo or No Edit');
  if (request.generation?.referenceId)
    throw new BadRequestException('A reference video can be added after the source is ready');
  return { requestedClipCount, outputStyle: request.outputStyle ?? 'AI_EDITED',
    generation: request.generation, regenerate: false };
}
