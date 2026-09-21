export type Cut = { start: number; end: number };
export type RemappedRange = { start: number; end: number };

export function createTimelineMapper(clipStart: number, cuts: Cut[]) {
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const point = (sourceTime: number) => sourceTime - clipStart - sorted.reduce((total, cut) =>
    total + Math.max(0, Math.min(sourceTime, cut.end) - cut.start), 0);
  const range = (start: number, end: number): RemappedRange | null => {
    if (end <= start || sorted.some((cut) => start >= cut.start && end <= cut.end)) return null;
    const mapped = { start: point(start), end: point(end) };
    return mapped.end > mapped.start ? mapped : null;
  };
  const removed = (start: number, end: number) =>
    sorted.some((cut) => start < cut.end && end > cut.start);
  return { point, range, removed, cuts: sorted };
}
