export function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** "3 min ago", "2 days ago" — compact enough for a phone card. */
export function timeAgo(value: string | number | Date, now = Date.now()) {
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  // Each step: how many of the current unit make the next one.
  const steps: Array<[number, string]> = [[60, 'h'], [24, 'day'], [7, 'week'], [4.35, 'month'], [12, 'year']];
  let amount = seconds / 60;
  let unit = 'min';
  for (const [size, next] of steps) {
    if (amount < size) break;
    amount /= size;
    unit = next;
  }
  const rounded = Math.max(1, Math.floor(amount));
  const plural = unit === 'min' || unit === 'h' ? unit : `${unit}${rounded === 1 ? '' : 's'}`;
  return `${rounded} ${plural} ago`;
}

export function clipDuration(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  return `${Math.floor(safe / 60)}:${(safe % 60).toString().padStart(2, '0')}`;
}
