import type { SmartDevice } from "./commands.js";
import { MAX_SMART_DEVICES, isSafeDevice } from "./commands.js";

// Pure parsers over the output of the commands in commands.ts. Each takes
// what the command printed and returns undefined (or an empty list) when the
// output is not what it expects, never throwing.

export interface CpuCounters {
  total: number;
  idle: number;
  cpus: number;
}

export function parseStat(text: string): CpuCounters | undefined {
  let counters: Omit<CpuCounters, "cpus"> | undefined;
  let cpus = 0;
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === "cpu") {
      // user nice system idle iowait irq softirq steal; guest time is
      // already counted in user, so the guest columns are left out.
      const n = fields.slice(1, 9).map(Number);
      if (n.length < 4 || n.some((v) => !Number.isFinite(v))) return undefined;
      const total = n.reduce((a, b) => a + b, 0);
      counters = { total, idle: (n[3] ?? 0) + (n[4] ?? 0) };
    } else if (/^cpu\d+$/.test(fields[0] ?? "")) {
      cpus++;
    }
  }
  return counters ? { ...counters, cpus } : undefined;
}

export function cpuPercent(prev: CpuCounters, next: CpuCounters): number | undefined {
  const total = next.total - prev.total;
  const idle = next.idle - prev.idle;
  // A reboot resets the counters; skip that interval rather than report nonsense.
  if (total <= 0 || idle < 0 || idle > total) return undefined;
  return round(((total - idle) / total) * 100);
}

export interface Memory {
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  percent: number;
}

export function parseMeminfo(text: string): Memory | undefined {
  const kb = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) kb.set(m[1]!, Number(m[2]));
  }
  const total = kb.get("MemTotal");
  if (!total) return undefined;
  // MemAvailable is missing on kernels before 3.14.
  const available =
    kb.get("MemAvailable") ?? (kb.get("MemFree") ?? 0) + (kb.get("Buffers") ?? 0) + (kb.get("Cached") ?? 0);
  const used = Math.max(0, total - available);
  return {
    totalBytes: total * 1024,
    availableBytes: available * 1024,
    usedBytes: used * 1024,
    percent: round((used / total) * 100),
  };
}

export interface Filesystem {
  source: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  percent: number;
  // A ZFS dataset: its own percentage is relative to the dataset, not the
  // pool, so the pool's capacity is what gets judged.
  zfs: boolean;
}

const PSEUDO_SOURCES = new Set([
  "tmpfs",
  "devtmpfs",
  "overlay",
  "shm",
  "none",
  "udev",
  "efivarfs",
  "squashfs",
  "nsfs",
  "cgroup",
  "cgroup2",
  "proc",
  "sysfs",
]);
const PSEUDO_MOUNTS =
  /^\/(proc|sys|dev|run|snap)(\/|$)|^\/var\/lib\/(docker|kubelet|containerd|rancher|lxcfs)\/|\/@docker(\/|$)|\/\.ix-apps(\/|$)|\/ix-applications(\/|$)|\/\.system(\/|$)/;

export function parseDf(text: string): Filesystem[] {
  const out: Filesystem[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6) continue;
    const [source, size, used, avail] = fields as [string, string, string, string];
    const mount = fields.slice(5).join(" ");
    const total = Number(size);
    if (!(total > 0) || !Number.isFinite(Number(used)) || !Number.isFinite(Number(avail))) continue;
    if (PSEUDO_SOURCES.has(source) || source.startsWith("/dev/loop") || PSEUDO_MOUNTS.test(mount)) continue;
    if (seen.has(mount)) continue;
    seen.add(mount);
    const usedKb = Number(used);
    const availKb = Number(avail);
    // df's own Capacity column rounds up and counts reserved blocks as used;
    // used / (used + available) is what a user can actually still write.
    const usable = usedKb + availKb;
    out.push({
      source,
      mount,
      totalBytes: total * 1024,
      usedBytes: usedKb * 1024,
      freeBytes: availKb * 1024,
      percent: usable > 0 ? round((usedKb / usable) * 100) : 0,
      zfs: !source.startsWith("/") && !source.includes(":") && !source.startsWith("//"),
    });
  }
  return out;
}

// The filesystem holding a path: the longest mount point that is a prefix of it.
export function filesystemFor(path: string, filesystems: Filesystem[]): Filesystem | undefined {
  let best: Filesystem | undefined;
  for (const fs of filesystems) {
    const prefix = fs.mount === "/" ? "/" : `${fs.mount}/`;
    if ((path === fs.mount || path.startsWith(prefix)) && (!best || fs.mount.length > best.mount.length)) best = fs;
  }
  return best;
}

export type NetCounters = Record<string, { rx: number; tx: number }>;

const VIRTUAL_IFACES =
  /^(lo|veth|docker|br-|cali|flannel|cni|vxlan|kube-|tunl|virbr|cilium|lxc|tap|vnet|sit|ip6tnl|ip6gre|gre|erspan|dummy|ifb)/;

export function parseNetDev(text: string): NetCounters {
  const out: NetCounters = {};
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const iface = line.slice(0, colon).trim();
    if (!iface || iface.includes("|") || VIRTUAL_IFACES.test(iface)) continue;
    const fields = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    if (fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue;
    out[iface] = { rx: fields[0]!, tx: fields[8]! };
  }
  return out;
}

export function parseUptime(text: string): number | undefined {
  const value = Number(text.trim().split(/\s+/)[0]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

export function parseLoadavg(text: string): [number, number, number] | undefined {
  const [a, b, c] = text.trim().split(/\s+/).map(Number);
  return [a, b, c].every((v) => Number.isFinite(v)) ? [a!, b!, c!] : undefined;
}

export function parseUname(text: string): { hostname?: string; kernel?: string } {
  const [, hostname, kernel] = text.trim().split(/\s+/);
  return { ...(hostname ? { hostname } : {}), ...(kernel ? { kernel } : {}) };
}

// KEY="value" lines, as in /etc/os-release and DSM's /etc.defaults/VERSION.
export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

export function synologyOs(text: string): string | undefined {
  const kv = parseKeyValues(text);
  if (!kv.productversion) return undefined;
  const name = kv.os_name || "DSM";
  return `${name} ${kv.productversion}${kv.buildnumber ? `-${kv.buildnumber}` : ""}`;
}

export function truenasVersion(text: string): string | undefined {
  const value = text.trim().split("\n")[0]?.trim();
  return value && /^\d+\.\d+[\w.-]*$/.test(value) ? value : undefined;
}

export interface TempReading {
  sensor: string;
  celsius: number;
  max?: number;
  crit?: number;
}

const MAX_TEMPS = 32;

// `sensors -j`: { chip: { Adapter, feature: { tempN_input, tempN_max, tempN_crit } } }.
export function parseSensors(text: string): TempReading[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(doc)) return [];
  const out: TempReading[] = [];
  for (const [chip, features] of Object.entries(doc)) {
    if (!isRecord(features)) continue;
    for (const [feature, values] of Object.entries(features)) {
      if (!isRecord(values)) continue;
      for (const [key, value] of Object.entries(values)) {
        const m = /^(temp\d+)_input$/.exec(key);
        if (!m || typeof value !== "number" || !Number.isFinite(value)) continue;
        // Unconnected inputs read as absurd values on some boards.
        if (value <= -50 || value >= 150) continue;
        const max = values[`${m[1]}_max`];
        const crit = values[`${m[1]}_crit`];
        out.push({
          sensor: `${chip}/${feature}`,
          celsius: round(value),
          ...(typeof max === "number" && max > 0 ? { max } : {}),
          ...(typeof crit === "number" && crit > 0 ? { crit } : {}),
        });
        if (out.length >= MAX_TEMPS) return out;
      }
    }
  }
  return out;
}

// `smartctl --scan` text: "/dev/sda -d sat # /dev/sda [SAT], ATA device".
// The text form is used because smartmontools 6 has no JSON scan.
export function parseSmartScan(text: string): SmartDevice[] {
  const out: SmartDevice[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^(\S+)\s+-d\s+(\S+)/.exec(line.trim());
    if (!m) continue;
    const dev = { device: m[1]!, type: m[2]! };
    if (!isSafeDevice(dev) || seen.has(dev.device)) continue;
    seen.add(dev.device);
    out.push(dev);
    if (out.length >= MAX_SMART_DEVICES) break;
  }
  return out;
}

export interface SmartDisk {
  device: string;
  model?: string;
  serial?: string;
  // undefined when the drive answered but reported no overall status.
  passed?: boolean;
  temperature?: number;
  reallocated?: number;
  pending?: number;
  uncorrectable?: number;
  mediaErrors?: number;
  criticalWarning?: number;
  percentUsed?: number;
}

export type SmartRead =
  | { kind: "disk"; disk: SmartDisk }
  | { kind: "denied"; message: string }
  // smartmontools older than 7 has no -j.
  | { kind: "no-json" }
  | { kind: "error"; message: string };

const DENIED =
  /permission denied|operation not permitted|a password is required|not in the sudoers|not allowed to execute|sudo: .*(terminal|askpass)/i;

export function parseSmartJson(device: string, stdout: string, stderr: string): SmartRead {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    if (DENIED.test(stdout + stderr)) return { kind: "denied", message: firstLine(stderr || stdout) };
    if (/unrecognized option|invalid option|unknown option/i.test(stdout + stderr)) return { kind: "no-json" };
    return { kind: "error", message: firstLine(stderr || stdout) || "smartctl printed nothing" };
  }
  if (!isRecord(doc)) return { kind: "error", message: "smartctl JSON was not an object" };
  const messages = (
    Array.isArray(get(doc, "smartctl", "messages")) ? get(doc, "smartctl", "messages") : []
  ) as unknown[];
  const text = messages.map((m) => (isRecord(m) && typeof m.string === "string" ? m.string : "")).join("; ");
  const passed = get(doc, "smart_status", "passed");
  if (typeof passed !== "boolean" && DENIED.test(text)) return { kind: "denied", message: text };

  const disk: SmartDisk = { device };
  const model = get(doc, "model_name") ?? get(doc, "scsi_model_name");
  if (typeof model === "string") disk.model = model;
  const serial = get(doc, "serial_number");
  if (typeof serial === "string") disk.serial = serial;
  if (typeof passed === "boolean") disk.passed = passed;
  const temp = get(doc, "temperature", "current");
  if (typeof temp === "number") disk.temperature = temp;

  const table = get(doc, "ata_smart_attributes", "table");
  if (Array.isArray(table)) {
    for (const attr of table) {
      if (!isRecord(attr)) continue;
      const raw = get(attr, "raw", "value");
      if (typeof raw !== "number") continue;
      if (attr.id === 5) disk.reallocated = raw;
      else if (attr.id === 197) disk.pending = raw;
      else if (attr.id === 198) disk.uncorrectable = raw;
    }
  }
  const nvme = get(doc, "nvme_smart_health_information_log");
  if (isRecord(nvme)) {
    if (typeof nvme.critical_warning === "number") disk.criticalWarning = nvme.critical_warning;
    if (typeof nvme.media_errors === "number") disk.mediaErrors = nvme.media_errors;
    if (typeof nvme.percentage_used === "number") disk.percentUsed = nvme.percentage_used;
  }
  if (disk.passed === undefined && disk.reallocated === undefined && disk.criticalWarning === undefined) {
    return { kind: "error", message: text || "smartctl reported no health status" };
  }
  return { kind: "disk", disk };
}

// smartctl 6 text output of -H -A.
export function parseSmartText(device: string, stdout: string, stderr: string): SmartRead {
  const all = stdout + stderr;
  const disk: SmartDisk = { device };
  const ata = /self-assessment test result:\s*(\w+)/i.exec(all);
  const scsi = /SMART Health Status:\s*(\w+)/i.exec(all);
  if (ata) disk.passed = ata[1]!.toUpperCase() === "PASSED";
  else if (scsi) disk.passed = scsi[1]!.toUpperCase() === "OK";
  const model = /^(?:Device Model|Product|Model Number):\s*(.+)$/im.exec(stdout);
  if (model) disk.model = model[1]!.trim();
  const serial = /^Serial Number:\s*(.+)$/im.exec(stdout);
  if (serial) disk.serial = serial[1]!.trim();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+\S+\s+0x[0-9a-f]+\s+\d+\s+\d+\s+\d+\s+\S+\s+\S+\s+\S+\s+(\d+)/i.exec(line);
    if (!m) continue;
    const id = Number(m[1]);
    const raw = Number(m[2]);
    if (id === 5) disk.reallocated = raw;
    else if (id === 197) disk.pending = raw;
    else if (id === 198) disk.uncorrectable = raw;
    else if (id === 194 || (id === 190 && disk.temperature === undefined)) disk.temperature = raw;
  }
  if (disk.passed === undefined && disk.reallocated === undefined) {
    if (DENIED.test(all)) return { kind: "denied", message: firstLine(stderr || stdout) };
    return { kind: "error", message: firstLine(stderr || stdout) || "smartctl printed nothing" };
  }
  return { kind: "disk", disk };
}

export interface Pool {
  name: string;
  sizeBytes: number;
  allocBytes: number;
  freeBytes: number;
  percent: number;
  health: string;
}

// `zpool list -H -p -o name,size,alloc,free,cap,health`: tab separated, exact numbers.
export function parseZpoolList(text: string): Pool[] {
  const out: Pool[] = [];
  for (const line of text.split("\n")) {
    const fields = line.split("\t").map((f) => f.trim());
    if (fields.length < 6) continue;
    const [name, size, alloc, free, cap, health] = fields as [string, string, string, string, string, string];
    const sizeBytes = Number(size);
    if (!name || !(sizeBytes > 0)) continue;
    const percent = Number(cap.replace("%", ""));
    out.push({
      name,
      sizeBytes,
      allocBytes: Number(alloc) || 0,
      freeBytes: Number(free) || 0,
      percent: Number.isFinite(percent) ? percent : round(((Number(alloc) || 0) / sizeBytes) * 100),
      health: health.toUpperCase(),
    });
  }
  return out;
}

export function zpoolStatusHealthy(text: string): boolean {
  return /all pools are healthy/i.test(text) || /no pools available/i.test(text);
}

export interface MdArray {
  name: string;
  state: string;
  level?: string;
  members: number;
  failed: number;
  // [n/m]: slots in the array, slots working.
  slots?: number;
  working?: number;
  // "recovery = 12.6%", "resync = DELAYED", "check = 40.1%".
  activity?: string;
}

export function parseMdstat(text: string): MdArray[] {
  const out: MdArray[] = [];
  let current: MdArray | undefined;
  for (const line of text.split("\n")) {
    const head = /^(md\w+)\s*:\s*(\S+)\s*(.*)$/.exec(line);
    if (head) {
      const rest = head[3]!.split(/\s+/).filter(Boolean);
      const level = rest[0] && /^(raid\d+|linear|multipath|faulty)$/.test(rest[0]) ? rest[0] : undefined;
      const members = rest.filter((t) => /\[\d+\]/.test(t));
      current = {
        name: head[1]!,
        state: head[2]!,
        ...(level ? { level } : {}),
        members: members.length,
        failed: members.filter((t) => t.includes("(F)")).length,
      };
      out.push(current);
      continue;
    }
    if (!current) continue;
    const slots = /\[(\d+)\/(\d+)\]/.exec(line);
    if (slots) {
      current.slots = Number(slots[1]);
      current.working = Number(slots[2]);
    }
    const activity = /\b(recovery|resync|reshape|check|repair)\s*=\s*(\S+)/.exec(line);
    if (activity) current.activity = `${activity[1]} ${activity[2]}`;
    if (line.trim() === "") current = undefined;
  }
  return out;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim().slice(0, 300) ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function get(value: unknown, ...path: string[]): unknown {
  let cur = value;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function round(value: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
