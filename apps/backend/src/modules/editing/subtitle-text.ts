// Normalize transcript text once, before phrase grouping and ASS construction.
export function sanitizeSubtitleText(value: string): string {
  return value.normalize('NFC')
    .replace(/[\u2018\u2019\u02BC]/gu, "'")
    .replace(/[\u201C\u201D]/gu, '"')
    .replace(/[\u2010-\u2015]/gu, '-')
    .replace(/\u2026/gu, '…')
    .replace(/[\u00A0\u202F]/gu, ' ')
    .replace(/[\uFFFD\u200B-\u200D\u2060\uFEFF]/gu, '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, ' ')
    .replace(/^\s*[*_`#]+|[*_`#]+\s*$/gu, '')
    .replace(/\s+/gu, ' ').trim();
}

// ASS has no reliable backslash escape for literal override braces. Use visual
// Unicode equivalents so source text can never open an override block.
export function escapeAssText(value: string): string {
  return sanitizeSubtitleText(value).replace(/\\/gu, '＼')
    .replace(/\{/gu, '｛').replace(/\}/gu, '｝');
}

export function invalidSubtitleCharacters(value: string): string[] {
  return [...new Set(value.match(/[\uFFFD\u200B-\u200D\u2060\uFEFF\u0000-\u001F\u007F-\u009F]/gu) ?? [])];
}
