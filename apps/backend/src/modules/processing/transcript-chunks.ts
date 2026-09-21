type Segment = { position: number; start: number; end: number; text: string };

// Preserve whole segments because word-level timestamps are unavailable.
export function buildTranscriptChunks(videoId: string, segments: Segment[]) {
  const chunks: Array<{
    videoId: string; position: number; startTime: number; endTime: number;
    text: string; duration: number; wordCount: number;
  }> = [];
  let current: { startTime: number; endTime: number; text: string } | undefined;
  const flush = () => {
    if (!current) return;
    chunks.push({ ...current, videoId, position: chunks.length,
      duration: current.endTime - current.startTime,
      wordCount: current.text.split(/\s+/u).length });
    current = undefined;
  };
  for (const segment of [...segments].sort((a, b) => a.position - b.position)) {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
        segment.start < 0 || segment.end < segment.start) {
      throw new Error('Invalid transcript segment timestamps');
    }
    const text = segment.text.trim().replace(/\s+/gu, ' ');
    if (!text) continue;
    if (current) {
      const sentenceEnd = /[.!?。！？][\x22\x27”’»\)\]]*$/u.test(current.text);
      const softBoundary = /[,;:，；：][\x22\x27”’»\)\]]*$/u.test(current.text);
      const elapsed = current.endTime - current.startTime;
      if (segment.start - current.endTime >= 1 || sentenceEnd ||
          (elapsed >= 15 && softBoundary) || elapsed >= 30) flush();
    }
    current = current
      ? { ...current, endTime: Math.max(current.endTime, segment.end), text: current.text + ' ' + text }
      : { startTime: segment.start, endTime: segment.end, text };
  }
  flush();
  return chunks;
}
