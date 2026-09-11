/** "in 5m" / "3h ago" — the one relative-time format every tab needs. */
export function relativeTime(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  const mins = Math.round(Math.abs(ms) / 60_000);
  const label = mins < 1 ? 'now' : mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  if (mins < 1) return 'now';
  return ms > 0 ? `in ${label}` : `${label} ago`;
}
