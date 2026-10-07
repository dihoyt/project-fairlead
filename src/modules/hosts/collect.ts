import type { CheckResult, Status } from "../../contracts/health.js";
import type { HostKind, HostView } from "../../contracts/hosts.js";
import type { Sample } from "../../contracts/metrics.js";
import {
  BASE_COMMANDS,
  OPTIONAL_COMMANDS,
  smartCommand,
  type BaseCommand,
  type OptionalCommand,
  type SmartDevice,
  type SmartMode,
} from "./commands.js";
import {
  cpuPercent,
  parseDf,
  parseKeyValues,
  parseLoadavg,
  parseMdstat,
  parseMeminfo,
  parseNetDev,
  parseSensors,
  parseSmartJson,
  parseSmartScan,
  parseSmartText,
  parseStat,
  parseUname,
  parseUptime,
  parseZpoolList,
  round,
  synologyOs,
  truenasVersion,
  zpoolStatusHealthy,
  type CpuCounters,
  type Filesystem,
  type MdArray,
  type NetCounters,
  type Pool,
  type SmartDisk,
  type SmartRead,
} from "./parse.js";
import type { ExecResult, SshSession } from "./ssh.js";

export type DetectedKind = Exclude<HostKind, "auto">;
export type Facts = NonNullable<HostView["facts"]>;

export interface Thresholds {
  diskWarnPercent: number;
  diskCritPercent: number;
  loadWarnPerCpu: number;
}

export interface HostIdentity {
  id: string;
  label: string;
  username: string;
}

// Counters from the previous collection, for rates. Per pod and in memory by
// design: after a restart the first collection simply has no rates.
export interface RateState {
  ts: number;
  cpu?: CpuCounters;
  net?: NetCounters;
}

export interface SmartOutcome {
  mode?: SmartMode | "denied";
  denied?: string;
  reads: SmartRead[];
}

export interface Outputs {
  base: Record<BaseCommand, ExecResult>;
  optional: Partial<Record<OptionalCommand, ExecResult>>;
  smart: SmartOutcome;
}

export interface Observation {
  detectedKind: DetectedKind;
  facts: Facts;
  filesystems: Filesystem[];
  pools: Pool[];
  samples: Sample[];
  checks: CheckResult[];
  rates: RateState;
}

const COMMAND_TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const ran = (r: ExecResult | undefined): r is ExecResult => !!r && r.code === 0 && r.stdout.trim() !== "";

export async function gather(session: SshSession, signal?: AbortSignal): Promise<Outputs> {
  const run = (command: string) => {
    if (signal?.aborted) return Promise.reject(new Error("Collection was cancelled."));
    return session.exec(command, COMMAND_TIMEOUT_MS);
  };
  const baseKeys = Object.keys(BASE_COMMANDS) as BaseCommand[];
  const baseResults = await mapLimit(baseKeys, CONCURRENCY, (key) => run(BASE_COMMANDS[key]));
  const base = Object.fromEntries(baseKeys.map((key, i) => [key, baseResults[i]!])) as Outputs["base"];

  const wanted: OptionalCommand[] = [];
  if (ran(base.hasSensors)) wanted.push("sensors");
  if (ran(base.hasSmartctl)) wanted.push("smartScan");
  if (ran(base.hasZpool)) wanted.push("zpoolList", "zpoolStatus");
  const optionalResults = await mapLimit(wanted, CONCURRENCY, (key) => run(OPTIONAL_COMMANDS[key]));
  const optional: Outputs["optional"] = Object.fromEntries(wanted.map((key, i) => [key, optionalResults[i]!]));

  const smart: SmartOutcome = { reads: [] };
  if (optional.smartScan) {
    let devices = parseSmartScan(optional.smartScan.stdout);
    if (devices.length === 0) {
      optional.smartScanSudo = await run(OPTIONAL_COMMANDS.smartScanSudo);
      devices = parseSmartScan(optional.smartScanSudo.stdout);
    }
    await readSmart(devices, run, smart);
  }
  return { base, optional, smart };
}

// The first disk settles how smartctl may be run (plain, through sudo, or
// not at all) and whether it speaks JSON; the rest follow that.
async function readSmart(
  devices: SmartDevice[],
  run: (command: string) => Promise<ExecResult>,
  outcome: SmartOutcome
): Promise<void> {
  if (devices.length === 0) return;
  const read = async (dev: SmartDevice, mode: SmartMode, json: boolean): Promise<SmartRead> => {
    const r = await run(smartCommand(dev, mode, json));
    if (r.timedOut) return { kind: "error", message: `${dev.device}: smartctl timed out` };
    return json ? parseSmartJson(dev.device, r.stdout, r.stderr) : parseSmartText(dev.device, r.stdout, r.stderr);
  };

  const [first, ...rest] = devices as [SmartDevice, ...SmartDevice[]];
  let mode: SmartMode = "plain";
  let json = true;
  let probe = await read(first, mode, json);
  if (probe.kind === "no-json") {
    json = false;
    probe = await read(first, mode, json);
  }
  if (probe.kind === "denied") {
    mode = "sudo";
    const viaSudo = await read(first, mode, json);
    if (viaSudo.kind === "no-json") {
      json = false;
      probe = await read(first, mode, json);
    } else {
      probe = viaSudo;
    }
    if (probe.kind === "denied") {
      outcome.mode = "denied";
      outcome.denied = probe.message;
      return;
    }
  }
  outcome.mode = mode;
  outcome.reads = [probe, ...(await mapLimit(rest, CONCURRENCY, (dev) => read(dev, mode, json)))];
}

// --- judgement --------------------------------------------------------------

const worst = (statuses: Status[]): Status =>
  statuses.includes("crit")
    ? "crit"
    : statuses.includes("warn")
      ? "warn"
      : statuses.includes("unknown")
        ? "unknown"
        : statuses.includes("ok")
          ? "ok"
          : "absent";

function bytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let v = value;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function detectKind(base: Outputs["base"]): DetectedKind {
  if (ran(base.synologyVersion) && synologyOs(base.synologyVersion.stdout)) return "synology";
  if (ran(base.hasMidclt)) return "truenas";
  if (ran(base.truenasVersion) && truenasVersion(base.truenasVersion.stdout) && ran(base.hasZpool)) return "truenas";
  return "linux";
}

function osName(kind: DetectedKind, base: Outputs["base"]): string | undefined {
  if (kind === "synology") return synologyOs(base.synologyVersion.stdout);
  if (kind === "truenas") {
    const version = ran(base.truenasVersion) ? truenasVersion(base.truenasVersion.stdout) : undefined;
    return version ? `TrueNAS SCALE ${version}` : "TrueNAS SCALE";
  }
  if (!ran(base.osRelease)) return undefined;
  const kv = parseKeyValues(base.osRelease.stdout);
  return kv.PRETTY_NAME || [kv.NAME, kv.VERSION_ID].filter(Boolean).join(" ") || undefined;
}

export function analyze(
  host: HostIdentity,
  outputs: Outputs,
  prev: RateState | undefined,
  now: number,
  thresholds: Thresholds
): Observation {
  const { base, optional, smart } = outputs;
  const observedAt = new Date(now).toISOString();
  const labels = { host: host.id };
  const samples: Sample[] = [];
  const sample = (series: string, value: number, extra: Record<string, string> = {}) => {
    if (Number.isFinite(value)) samples.push({ series, labels: { ...labels, ...extra }, ts: now, value });
  };
  const check = (part: string, name: string, status: Status, detail: string, more: Partial<CheckResult> = {}) => ({
    id: `${host.id}.${part}`,
    label: `${host.label}: ${name}`,
    status,
    detail,
    observedAt,
    ...more,
  });

  const kind = detectKind(base);
  const uname = ran(base.uname) ? parseUname(base.uname.stdout) : {};
  const cpu = ran(base.stat) ? parseStat(base.stat.stdout) : undefined;
  const memory = ran(base.meminfo) ? parseMeminfo(base.meminfo.stdout) : undefined;
  const uptime = ran(base.uptime) ? parseUptime(base.uptime.stdout) : undefined;
  const load = ran(base.loadavg) ? parseLoadavg(base.loadavg.stdout) : undefined;
  const os = osName(kind, base);
  const facts: Facts = {
    ...uname,
    ...(os ? { os } : {}),
    ...(uptime !== undefined ? { uptimeSeconds: uptime } : {}),
    ...(cpu?.cpus ? { cpus: cpu.cpus } : {}),
    ...(memory ? { memoryBytes: memory.totalBytes } : {}),
  };

  const checks: CheckResult[] = [check("reachable", "SSH", "ok", `SSH as ${host.username}${os ? `, ${os}` : ""}`)];

  // CPU and network are rates over the interval since the last collection.
  const elapsed = prev ? (now - prev.ts) / 1000 : 0;
  if (cpu && prev?.cpu) {
    const pct = cpuPercent(prev.cpu, cpu);
    if (pct !== undefined) sample("host.cpu.percent", pct);
  }
  const net = ran(base.netdev) ? parseNetDev(base.netdev.stdout) : undefined;
  if (net && prev?.net && elapsed > 0) {
    for (const [iface, counters] of Object.entries(net)) {
      const before = prev.net[iface];
      if (!before || counters.rx < before.rx || counters.tx < before.tx) continue;
      sample("host.net.rx.bytesPerSec", round((counters.rx - before.rx) / elapsed), { iface });
      sample("host.net.tx.bytesPerSec", round((counters.tx - before.tx) / elapsed), { iface });
    }
  }
  if (memory) {
    sample("host.memory.percent", memory.percent);
    sample("host.memory.bytes", memory.usedBytes);
  }

  if (load) {
    sample("host.load", load[0]);
    const cpus = cpu?.cpus || 1;
    const perCpu = load[0] / cpus;
    checks.push(
      check(
        "load",
        "load",
        perCpu >= thresholds.loadWarnPerCpu ? "warn" : "ok",
        `Load ${load.map((v) => v.toFixed(2)).join(" ")} on ${cpus} CPU${cpus === 1 ? "" : "s"}`,
        { value: round(load[0]), ...(perCpu >= thresholds.loadWarnPerCpu ? { raw: base.loadavg.stdout.trim() } : {}) }
      )
    );
  }

  // Disk space: ordinary filesystems by df, ZFS by pool capacity (a
  // dataset's own percentage says nothing about how full its pool is).
  // df exits 1 when one mount is unreadable but still lists the rest.
  const filesystems = base.df.stdout ? parseDf(base.df.stdout) : [];
  const pools = optional.zpoolList ? parseZpoolList(optional.zpoolList.stdout) : [];
  const spaces = [
    ...filesystems.filter((fs) => !fs.zfs).map((fs) => ({ name: fs.mount, percent: fs.percent, free: fs.freeBytes })),
    ...pools.map((p) => ({ name: `pool ${p.name}`, percent: p.percent, free: p.freeBytes })),
  ];
  for (const fs of filesystems.filter((f) => !f.zfs)) {
    sample("host.disk.percent", fs.percent, { mount: fs.mount });
    sample("host.disk.free.bytes", fs.freeBytes, { mount: fs.mount });
  }
  for (const pool of pools) sample("host.pool.percent", pool.percent, { pool: pool.name });
  if (spaces.length > 0) {
    const judge = (percent: number): Status =>
      percent >= thresholds.diskCritPercent ? "crit" : percent >= thresholds.diskWarnPercent ? "warn" : "ok";
    const sorted = spaces.toSorted((a, b) => b.percent - a.percent);
    const top = sorted[0]!;
    const bad = sorted.filter((s) => judge(s.percent) !== "ok");
    const status = judge(top.percent);
    const describe = (s: (typeof spaces)[number]) => `${s.name} at ${Math.round(s.percent)}% (${bytes(s.free)} free)`;
    checks.push(
      check(
        "disk",
        "disk space",
        status,
        status === "ok"
          ? `Fullest: ${describe(top)}`
          : `${describe(top)}${bad.length > 1 ? `, and ${bad.length - 1} more over ${thresholds.diskWarnPercent}%` : ""}`,
        { value: top.percent, ...(status === "ok" ? {} : { raw: bad }) }
      )
    );
  } else {
    checks.push(
      check("disk", "disk space", "unknown", "df reported no filesystems", {
        raw: { stdout: base.df.stdout, stderr: base.df.stderr, code: base.df.code },
      })
    );
  }

  if (optional.zpoolList) checks.push(poolCheck(check, pools, optional));

  const arrays = ran(base.mdstat) ? parseMdstat(base.mdstat.stdout) : [];
  if (arrays.length > 0) checks.push(raidCheck(check, arrays, kind, base.mdstat.stdout));

  checks.push(smartCheck(check, base, optional, smart, host.username, sample));

  if (optional.sensors) {
    const temps = parseSensors(optional.sensors.stdout);
    for (const t of temps) sample("host.temp.celsius", t.celsius, { sensor: t.sensor });
    if (temps.length > 0) {
      const judged = temps.map((t) => ({
        ...t,
        status: (t.crit && t.celsius >= t.crit ? "crit" : t.max && t.celsius >= t.max ? "warn" : "ok") as Status,
      }));
      const hottest = judged.toSorted((a, b) => b.celsius - a.celsius)[0]!;
      const bad = judged.filter((t) => t.status !== "ok");
      const status = worst(judged.map((t) => t.status));
      checks.push(
        check(
          "temperature",
          "temperatures",
          status,
          status === "ok"
            ? `Hottest: ${hottest.sensor} at ${hottest.celsius}°C`
            : bad
                .map((t) => `${t.sensor} at ${t.celsius}°C (limit ${t.status === "crit" ? t.crit : t.max}°C)`)
                .join("; "),
          { value: hottest.celsius, ...(status === "ok" ? {} : { raw: bad }) }
        )
      );
    }
  }

  return {
    detectedKind: kind,
    facts,
    filesystems,
    pools,
    samples,
    checks,
    rates: { ts: now, ...(cpu ? { cpu } : {}), ...(net ? { net } : {}) },
  };
}

type CheckFn = (part: string, name: string, status: Status, detail: string, more?: Partial<CheckResult>) => CheckResult;

const POOL_BAD = new Set(["DEGRADED", "FAULTED", "UNAVAIL", "OFFLINE", "REMOVED", "SUSPENDED"]);

function poolCheck(check: CheckFn, pools: Pool[], optional: Outputs["optional"]): CheckResult {
  const list = optional.zpoolList!;
  if (list.code !== 0 && pools.length === 0) {
    return check("pools", "ZFS pools", "unknown", `zpool list failed: ${list.stderr.trim() || `exit ${list.code}`}`, {
      raw: list,
    });
  }
  if (pools.length === 0) return check("pools", "ZFS pools", "absent", "No ZFS pools imported");
  const bad = pools.filter((p) => p.health !== "ONLINE");
  const statusText = optional.zpoolStatus?.stdout ?? "";
  if (bad.length > 0) {
    return check(
      "pools",
      "ZFS pools",
      bad.some((p) => POOL_BAD.has(p.health)) ? "crit" : "warn",
      bad.map((p) => `${p.name} is ${p.health}`).join("; "),
      { raw: { pools, status: statusText.trim() } }
    );
  }
  if (optional.zpoolStatus && !zpoolStatusHealthy(statusText)) {
    return check("pools", "ZFS pools", "warn", `All pools ONLINE, but zpool status reports problems`, {
      raw: { status: statusText.trim() || optional.zpoolStatus.stderr.trim() },
    });
  }
  return check(
    "pools",
    "ZFS pools",
    "ok",
    `${pools.length} pool${pools.length === 1 ? "" : "s"} ONLINE: ${pools.map((p) => p.name).join(", ")}`
  );
}

// DSM gives every disk a slot in its system and swap arrays (md0, md1) for
// disks not yet installed, so "[16/2]" there is normal, not degraded.
function raidCheck(check: CheckFn, arrays: MdArray[], kind: DetectedKind, raw: string): CheckResult {
  const judged = arrays.map((a) => {
    const systemSlots = kind === "synology" && (a.name === "md0" || a.name === "md1");
    let status: Status = "ok";
    let note = `${a.name} ${a.level ?? a.state}`;
    if (a.state === "inactive") {
      status = "crit";
      note = `${a.name} is inactive`;
    } else if (a.failed > 0) {
      status = "crit";
      note = `${a.name} has ${a.failed} failed member${a.failed === 1 ? "" : "s"}`;
    } else if (!systemSlots && a.slots !== undefined && a.working !== undefined && a.working < a.slots) {
      status = "crit";
      note = `${a.name} is degraded (${a.working}/${a.slots} working)`;
    }
    if (a.activity && /^(recovery|resync|reshape)/.test(a.activity)) {
      if (status === "ok") status = "warn";
      note += `, ${a.activity}`;
    } else if (a.activity) {
      note += `, ${a.activity}`;
    }
    return { array: a, status, note };
  });
  const status = worst(judged.map((j) => j.status));
  const bad = judged.filter((j) => j.status !== "ok");
  return check(
    "raid",
    "RAID",
    status,
    status === "ok"
      ? `${arrays.length} array${arrays.length === 1 ? "" : "s"} healthy`
      : bad.map((j) => j.note).join("; "),
    status === "ok" ? {} : { raw }
  );
}

function judgeDisk(d: SmartDisk): { status: Status; problems: string[] } {
  const problems: string[] = [];
  let status: Status = "ok";
  if (d.passed === false) {
    status = "crit";
    problems.push("SMART overall health FAILED");
  }
  if (d.criticalWarning) {
    status = "crit";
    problems.push(`NVMe critical warning 0x${d.criticalWarning.toString(16)}`);
  }
  const counted: Array<[number | undefined, string]> = [
    [d.reallocated, "reallocated sectors"],
    [d.pending, "pending sectors"],
    [d.uncorrectable, "uncorrectable sectors"],
    [d.mediaErrors, "media errors"],
  ];
  for (const [value, what] of counted) {
    if (value && value > 0) {
      if (status === "ok") status = "warn";
      problems.push(`${value} ${what}`);
    }
  }
  if (d.percentUsed !== undefined && d.percentUsed >= 90) {
    if (status === "ok") status = "warn";
    problems.push(`${d.percentUsed}% of rated endurance used`);
  }
  return { status, problems };
}

function smartCheck(
  check: CheckFn,
  base: Outputs["base"],
  optional: Outputs["optional"],
  smart: SmartOutcome,
  username: string,
  sample: (series: string, value: number, extra?: Record<string, string>) => void
): CheckResult {
  if (!ran(base.hasSmartctl)) return check("smart", "SMART", "absent", "smartctl is not installed on this host");
  if (smart.mode === "denied") {
    return check(
      "smart",
      "SMART",
      "unknown",
      `smartctl needs root to read disks: allow "${username}" to run smartctl through sudo without a password`,
      { raw: { error: smart.denied } }
    );
  }
  if (smart.reads.length === 0) {
    const scan = optional.smartScanSudo ?? optional.smartScan;
    return check(
      "smart",
      "SMART",
      "absent",
      "smartctl --scan found no disks",
      scan ? { raw: { stdout: scan.stdout, stderr: scan.stderr, code: scan.code } } : {}
    );
  }
  const disks = smart.reads.flatMap((r) => (r.kind === "disk" ? [r.disk] : []));
  const errors = smart.reads.flatMap((r) => (r.kind === "error" || r.kind === "denied" ? [r.message] : []));
  for (const d of disks) {
    if (d.temperature !== undefined) sample("host.temp.celsius", d.temperature, { sensor: `disk${d.device}` });
  }
  const judged = disks.map((d) => ({ disk: d, ...judgeDisk(d) }));
  const bad = judged.filter((j) => j.status !== "ok");
  const statuses = judged.map((j) => j.status);
  if (errors.length > 0) statuses.push(disks.length === 0 ? "unknown" : "ok");
  const status = worst(statuses);
  const parts = bad.map((j) => `${j.disk.device}${j.disk.model ? ` (${j.disk.model})` : ""}: ${j.problems.join(", ")}`);
  if (errors.length > 0) parts.push(`${errors.length} disk${errors.length === 1 ? "" : "s"} unreadable`);
  const detail =
    bad.length === 0 && errors.length === 0
      ? `${disks.length} disk${disks.length === 1 ? "" : "s"} healthy`
      : bad.length === 0
        ? `${disks.length} disk${disks.length === 1 ? "" : "s"} healthy; ${parts.join("; ")}`
        : parts.join("; ");
  return check("smart", "SMART", status, detail, {
    value: bad.length,
    ...(status === "ok" ? {} : { raw: { disks: bad.map((j) => j.disk), errors } }),
  });
}

// What a host that could not be reached reports: reachability fails, and
// whatever else it reported last time is unknown rather than silently gone,
// so a disk that was full does not read as recovered.
export function unreachableChecks(
  host: HostIdentity,
  error: string,
  previous: CheckResult[],
  now: number
): CheckResult[] {
  const observedAt = new Date(now).toISOString();
  const reachable: CheckResult = {
    id: `${host.id}.reachable`,
    label: `${host.label}: SSH`,
    status: "crit",
    detail: error,
    raw: { error },
    observedAt,
  };
  const rest = previous
    .filter((r) => r.id !== reachable.id)
    .map((r) =>
      r.status === "absent"
        ? { ...r, observedAt }
        : { ...r, status: "unknown" as const, detail: `Not collected: host unreachable. Last: ${r.detail}`, observedAt }
    );
  return [reachable, ...rest];
}
