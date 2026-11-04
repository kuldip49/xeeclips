/** Only these two same-origin approval paths may survive a login. */
export function authReturnPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^\/mcp\/authorize\?request=[A-Za-z0-9_-]{43}$/.test(value) ||
    /^\/settings\?review=[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
    ? value
    : null;
}
