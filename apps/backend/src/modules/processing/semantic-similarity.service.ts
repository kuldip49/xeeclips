import { Injectable } from '@nestjs/common';

export interface SemanticSimilarityProvider {
  similarity(left: string, right: string): number;
}

const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by',
  'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to',
  'was', 'were', 'with', 'you', 'your']);

@Injectable()
export class LocalSemanticSimilarityService implements SemanticSimilarityProvider {
  similarity(leftValue: string, rightValue: string) {
    const terms = (value: string) => new Set(value.toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)?.filter((word) =>
        (/^\d/u.test(word) || word.length >= 3) && !STOP_WORDS.has(word)) || []);
    const left = terms(leftValue);
    const right = terms(rightValue);
    if (!left.size || !right.size) return 0;
    const intersection = [...left].filter((word) => right.has(word)).length;
    const containment = intersection / Math.min(left.size, right.size);
    const jaccard = intersection / (left.size + right.size - intersection);
    return Math.max(containment * .7, jaccard);
  }
}

// Future embedding providers can implement the same interface without changing clip business logic.
export const semanticSimilarity: SemanticSimilarityProvider = new LocalSemanticSimilarityService();
