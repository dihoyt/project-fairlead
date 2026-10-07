// Every mock timestamp is relative to this fixed instant, so mock data and
// the assertions made about it never depend on when a test runs.
export const MOCK_NOW = Date.parse("2026-10-07T12:00:00.000Z");

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export function isoAgo(ms: number): string {
  return new Date(MOCK_NOW - ms).toISOString();
}
