import { BadRequestException } from '@nestjs/common';

export type ProcessingType = 'NORMAL_CLIPS' | 'EDITED_CLIPS';
export type OutputAspectRatio = '9:16' | '16:9' | '1:1' | '4:5';
export const DEFAULT_PROCESSING_TYPE: ProcessingType = 'NORMAL_CLIPS';
export const DEFAULT_OUTPUT_ASPECT_RATIO: OutputAspectRatio = '9:16';

export function parseProcessingType(value: unknown): ProcessingType {
  if (value == null || value === '') return DEFAULT_PROCESSING_TYPE;
  if (value === 'NORMAL_CLIPS' || value === 'EDITED_CLIPS') return value;
  throw new BadRequestException('processingType must be NORMAL_CLIPS or EDITED_CLIPS');
}

export function parseOutputAspectRatio(value: unknown): OutputAspectRatio {
  if (value == null || value === '') return DEFAULT_OUTPUT_ASPECT_RATIO;
  if (value === '9:16' || value === '16:9' || value === '1:1' || value === '4:5') return value;
  throw new BadRequestException('aspectRatio must be 9:16, 16:9, 1:1, or 4:5');
}
