type ChunkForAnalysis = {
  text: string;
  duration: number;
};

export type ChunkAnalysisMetrics = {
  questionCount: number;
  exclamationCount: number;
  keywordDensity: number;
  averageSentenceLength: number;
  speechRate: number;
  informationDensity: number;
  readabilityScore: number;
};

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'hers',
  'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'may', 'me',
  'might', 'more', 'most', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'ours',
  'shall', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their',
  'theirs', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'too',
  'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will',
  'with', 'would', 'you', 'your', 'yours'
]);

const round = (value: number) => Math.round(value * 100) / 100;
const percentage = (part: number, whole: number) => whole ? (part / whole) * 100 : 0;

function words(text: string) {
  return text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
}

function countSentences(text: string, wordCount: number) {
  if (!wordCount) return 0;
  const endings = text.match(/[.!?。！？]+(?=\s|$|[\x22\x27”’»\)\]])/gu)?.length ?? 0;
  return Math.max(1, endings);
}

// A deterministic English approximation used by the Flesch reading-ease formula.
function countSyllables(word: string) {
  const ascii = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!ascii) return 1;
  if (ascii.length <= 3) return 1;
  const withoutSilentEndings = ascii.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/u, '');
  return Math.max(1, withoutSilentEndings.match(/[aeiouy]+/gu)?.length ?? 1);
}

export function analyzeTranscriptChunk(chunk: ChunkForAnalysis): ChunkAnalysisMetrics {
  const tokens = words(chunk.text);
  const wordCount = tokens.length;
  const sentenceCount = countSentences(chunk.text, wordCount);
  const contentWords = tokens.filter((word) => !STOP_WORDS.has(word));
  const frequencies = new Map<string, number>();
  for (const word of contentWords) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  const topKeywordOccurrences = Math.max(0, ...frequencies.values());
  const syllableCount = tokens.reduce((total, word) => total + countSyllables(word), 0);
  const rawReadability = wordCount && sentenceCount
    ? 206.835 - 1.015 * (wordCount / sentenceCount) - 84.6 * (syllableCount / wordCount)
    : 0;

  return {
    questionCount: chunk.text.match(/[?？]/gu)?.length ?? 0,
    exclamationCount: chunk.text.match(/[!！]/gu)?.length ?? 0,
    keywordDensity: round(percentage(topKeywordOccurrences, wordCount)),
    averageSentenceLength: round(sentenceCount ? wordCount / sentenceCount : 0),
    speechRate: round(chunk.duration > 0 ? (wordCount / chunk.duration) * 60 : 0),
    informationDensity: round(percentage(contentWords.length, wordCount)),
    readabilityScore: round(Math.min(100, Math.max(0, rawReadability)))
  };
}
