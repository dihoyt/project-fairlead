// The five-field cron (UTC) of deploy.consoleBackup: digits, *, lists,
// ranges and steps, no names or macros. Enough to say whether a minute
// matches and when the next one is.

const MINUTE = 60_000;
// A week and a day covers every expression that matches at all, bar
// month/day pairs that occur once a year, which a nightly copy never uses.
const SEARCH_MINUTES = 8 * 1_440;

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  // Both day fields restricted: cron fires when either matches.
  dayOr: boolean;
}

function field(text: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) ? Number(stepText) : 0;
    if (step < 1) return null;
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (/^\d+-\d+$/.test(range)) {
      [lo, hi] = range.split("-").map(Number) as [number, number];
    } else if (/^\d+$/.test(range)) {
      lo = Number(range);
      hi = stepText === undefined ? lo : max;
    } else {
      return null;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(text: string): Cron | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const minutes = field(m, 0, 59);
  const hours = field(h, 0, 23);
  const days = field(dom, 1, 31);
  const months = field(mon, 1, 12);
  const weekdays = field(dow, 0, 7);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  if (weekdays.delete(7)) weekdays.add(0);
  return { minutes, hours, days, months, weekdays, dayOr: dom !== "*" && dow !== "*" };
}

export function matches(cron: Cron, at: Date): boolean {
  if (!cron.minutes.has(at.getUTCMinutes()) || !cron.hours.has(at.getUTCHours())) return false;
  if (!cron.months.has(at.getUTCMonth() + 1)) return false;
  const day = cron.days.has(at.getUTCDate());
  const weekday = cron.weekdays.has(at.getUTCDay());
  return cron.dayOr ? day || weekday : day && weekday;
}

// The first matching minute after `from`.
export function nextRun(cron: Cron, from: number): Date | undefined {
  const start = Math.floor(from / MINUTE) * MINUTE + MINUTE;
  for (let i = 0; i < SEARCH_MINUTES; i++) {
    const at = new Date(start + i * MINUTE);
    if (matches(cron, at)) return at;
  }
  return undefined;
}
