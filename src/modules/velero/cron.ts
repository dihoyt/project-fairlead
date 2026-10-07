// Velero parses Schedule.spec.schedule with robfig/cron's standard parser:
// five fields, the @-descriptors, "@every <duration>", and an optional
// CRON_TZ= (or TZ=) prefix. This is enough of that grammar to answer "when
// should the last run have happened" and "how often is a run expected".

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// Long enough for "0 0 29 2 *" to find a leap day.
const LOOKBACK_DAYS = 5 * 366;

export type CronSpec =
  | { kind: "every"; everyMs: number; expr: string }
  | {
      kind: "cron";
      expr: string;
      tz?: string;
      minutes: Set<number>;
      hours: Set<number>;
      dom: Set<number>;
      months: Set<number>;
      dow: Set<number>;
      // robfig: when either day field is a wildcard both must match, else either may.
      domStar: boolean;
      dowStar: boolean;
    };

const DESCRIPTORS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function value(token: string, names: string[] | undefined, offset: number): number {
  const named = names?.indexOf(token.toLowerCase()) ?? -1;
  if (named >= 0) return named + offset;
  if (!/^\d+$/.test(token)) throw new Error(`not a number: "${token}"`);
  return Number(token);
}

function field(text: string, min: number, max: number, names?: string[], nameOffset = 0): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : value(stepText, undefined, 0);
    if (step < 1) throw new Error(`bad step in "${part}"`);
    let lo: number;
    let hi: number;
    if (range === "*" || range === "?") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a = "", b = ""] = range.split("-");
      lo = value(a, names, nameOffset);
      hi = value(b, names, nameOffset);
    } else {
      lo = value(range, names, nameOffset);
      hi = stepText === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`"${part}" is outside ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: MINUTE, h: 60 * MINUTE };

// Go's time.ParseDuration, without the sub-millisecond units nobody schedules backups with.
export function parseGoDuration(text: string): number {
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
  if (!parts.length || parts.map((p) => p[0]).join("") !== text) throw new Error(`bad duration "${text}"`);
  return parts.reduce((sum, [, n = "0", unit = "ms"]) => sum + Number(n) * (UNITS[unit] ?? 0), 0);
}

export function parseSchedule(input: string): CronSpec {
  const expr = input.trim();
  let rest = expr;
  let tz: string | undefined;
  const tzMatch = /^(?:CRON_TZ|TZ)=(\S+)\s+(.*)$/.exec(rest);
  if (tzMatch) {
    tz = tzMatch[1];
    rest = tzMatch[2] ?? "";
    if (tz === "UTC" || tz === "Etc/UTC") tz = undefined;
    else offsetMs(tz, Date.now());
  }
  if (rest.startsWith("@every ")) {
    const everyMs = parseGoDuration(rest.slice(7).trim());
    if (everyMs < 1000) throw new Error(`"${rest}" is shorter than a second`);
    return { kind: "every", everyMs, expr };
  }
  const fields = (DESCRIPTORS[rest.toLowerCase()] ?? rest).split(/\s+/);
  if (fields.length !== 5) throw new Error(`expected 5 fields, got ${fields.length}`);
  const [m = "", h = "", dom = "", mon = "", dow = ""] = fields;
  const dowSet = field(dow, 0, 7, DAYS);
  if (dowSet.delete(7)) dowSet.add(0);
  return {
    kind: "cron",
    expr,
    ...(tz ? { tz } : {}),
    minutes: field(m, 0, 59),
    hours: field(h, 0, 23),
    dom: field(dom, 1, 31),
    months: field(mon, 1, 12, MONTHS, 1),
    dow: dowSet,
    domStar: dom.startsWith("*") || dom.startsWith("?"),
    dowStar: dow.startsWith("*") || dow.startsWith("?"),
  };
}

// The zone's offset from UTC at an instant, from Intl's wall-clock fields.
function offsetMs(tz: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return wall - Math.floor(at / MINUTE) * MINUTE;
}

const sortedDesc = (set: Set<number>) => [...set].toSorted((a, b) => b - a);

function dayMatches(spec: Extract<CronSpec, { kind: "cron" }>, d: Date): boolean {
  if (!spec.months.has(d.getUTCMonth() + 1)) return false;
  const domOk = spec.dom.has(d.getUTCDate());
  const dowOk = spec.dow.has(d.getUTCDay());
  return spec.domStar || spec.dowStar ? domOk && dowOk : domOk || dowOk;
}

// The latest fire time at or before `at`, as an instant. Undefined for
// "@every", whose fires are counted from whenever Velero last started.
export function previousFire(spec: CronSpec, at: number): number | undefined {
  if (spec.kind !== "cron") return undefined;
  // Search in wall-clock time with UTC arithmetic, then shift back. Off by
  // up to the DST jump for a fire inside the transition, which is within
  // any sensible grace period.
  const shift = spec.tz ? offsetMs(spec.tz, at) : 0;
  const wall = Math.floor((at + shift) / MINUTE) * MINUTE;
  const hours = sortedDesc(spec.hours);
  const minutes = sortedDesc(spec.minutes);
  const startOfDay = Math.floor(wall / DAY) * DAY;
  for (let i = 0; i <= LOOKBACK_DAYS; i++) {
    const day = startOfDay - i * DAY;
    if (!dayMatches(spec, new Date(day))) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const t = day + h * 60 * MINUTE + m * MINUTE;
        if (t <= wall) return spec.tz ? t - offsetMs(spec.tz, t - shift) : t;
      }
    }
  }
  return undefined;
}

// Fires in (after, upTo], newest first, at most `limit` of them.
export function firesBetween(spec: CronSpec, after: number, upTo: number, limit = 10): number[] {
  if (spec.kind === "every") {
    const count = Math.max(0, Math.floor((upTo - after) / spec.everyMs));
    return Array.from({ length: Math.min(count, limit) }, (_, i) => after + (i + 1) * spec.everyMs).toReversed();
  }
  const out: number[] = [];
  let cursor = upTo;
  while (out.length < limit) {
    const fire = previousFire(spec, cursor);
    if (fire === undefined || fire <= after) break;
    out.push(fire);
    cursor = fire - MINUTE;
  }
  return out;
}

// The longest gap between recent fires: the age a good backup may reach
// before one is overdue. "0 2 * * 1-5" expects one every three days over a
// weekend, not every day.
export function expectedEveryMs(spec: CronSpec, at: number): number | undefined {
  if (spec.kind === "every") return spec.everyMs;
  const fires = firesBetween(spec, at - 400 * DAY, at, 9);
  let longest = 0;
  for (let i = 1; i < fires.length; i++) longest = Math.max(longest, (fires[i - 1] ?? 0) - (fires[i] ?? 0));
  return longest || undefined;
}
