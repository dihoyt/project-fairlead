// Longhorn recurring jobs take a standard five-field cron expression,
// evaluated by longhorn-manager in UTC. Only what is needed to answer "when
// should this job last have run" lives here: no seconds, no year field.

const MINUTE = 60_000;
const DAY = 1_440 * MINUTE;

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  // Both day fields restricted: cron fires when either matches.
  dayOr: boolean;
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function field(text: string, min: number, max: number, names: string[] = [], nameBase = min): Set<number> | null {
  const value = (token: string): number | null => {
    const named = names.indexOf(token.toLowerCase());
    if (named >= 0) return named + nameBase;
    return /^\d+$/.test(token) ? Number(token) : null;
  };
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) ? Number(stepText) : 0;
    if (step < 1) return null;
    let lo: number | null;
    let hi: number | null;
    if (range === "*" || range === "?") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a = "", b = ""] = range.split("-");
      lo = value(a);
      hi = value(b);
    } else {
      lo = value(range);
      hi = stepText === undefined ? lo : max;
    }
    if (lo === null || hi === null || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

const restricted = (f: string) => f !== "*" && f !== "?";

export function parseCron(expression: string): Cron | null {
  const text = MACROS[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) return null;
  const [m = "", h = "", dom = "", mon = "", dow = ""] = parts;
  const minutes = field(m, 0, 59);
  const hours = field(h, 0, 23);
  const days = field(dom, 1, 31);
  const months = field(mon, 1, 12, MONTH_NAMES, 1);
  // 7 is Sunday too.
  const weekdaysRaw = field(dow, 0, 7, DAY_NAMES, 0);
  if (!minutes || !hours || !days || !months || !weekdaysRaw) return null;
  const weekdays = new Set([...weekdaysRaw].map((d) => d % 7));
  return { minutes, hours, days, months, weekdays, dayOr: restricted(dom) && restricted(dow) };
}

function dayMatches(cron: Cron, day: Date): boolean {
  if (!cron.months.has(day.getUTCMonth() + 1)) return false;
  const dom = cron.days.has(day.getUTCDate());
  const dow = cron.weekdays.has(day.getUTCDay());
  return cron.dayOr ? dom || dow : dom && dow;
}

// Fire times at or before `before`, newest first, looking back at most
// `lookbackDays`.
export function previousFires(cron: Cron, before: number, count: number, lookbackDays = 400): number[] {
  const out: number[] = [];
  const hours = [...cron.hours].toSorted((a, b) => b - a);
  const minutes = [...cron.minutes].toSorted((a, b) => b - a);
  const startDay = Math.floor(before / DAY) * DAY;
  for (let d = 0; d <= lookbackDays && out.length < count; d++) {
    const day = startDay - d * DAY;
    if (!dayMatches(cron, new Date(day))) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const at = day + (h * 60 + m) * MINUTE;
        if (at > before) continue;
        out.push(at);
        if (out.length === count) return out;
      }
    }
  }
  return out;
}

// The longest gap between consecutive fires over the year before `at`: how
// old the newest backup may be just before the next run is due.
export function longestGapMs(cron: Cron, at: number): number | undefined {
  const fires = previousFires(cron, at, 2_000, 370);
  if (fires.length < 2) return undefined;
  let gap = 0;
  for (let i = 1; i < fires.length; i++) gap = Math.max(gap, fires[i - 1]! - fires[i]!);
  return gap;
}
