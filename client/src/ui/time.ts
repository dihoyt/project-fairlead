// "3 min ago", falling back to a date past two days. Accepts ISO strings
// and unix milliseconds, the two shapes the API uses.
export function relativeTime(at: string | number | null | undefined, now = Date.now()): string {
  if (at === null || at === undefined) return "never";
  const ms = typeof at === "number" ? at : Date.parse(at);
  if (Number.isNaN(ms)) return "unknown";
  const seconds = Math.round((now - ms) / 1000);
  if (seconds < 0) {
    const ahead = -seconds;
    if (ahead < 60) return "in a moment";
    if (ahead < 3600) return `in ${Math.round(ahead / 60)} min`;
    return `in ${Math.round(ahead / 3600)} h`;
  }
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString();
}

export function absoluteTime(at: string | number): string {
  return new Date(at).toLocaleString();
}
