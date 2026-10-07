// Every command line the collector may send to a host. Nothing here is built
// from request input: the only variable parts are a disk's device path and
// type from the host's own `smartctl --scan`, and those are checked against
// a strict pattern before they reach a template.

// Tools like smartctl and zpool live in sbin, which a non-root user's PATH
// usually lacks (TrueNAS SCALE, Debian). sudo resets PATH to its own
// secure_path, so the sudo form needs nothing extra.
const SBIN = 'export PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin"; ';

export const BASE_COMMANDS = {
  uname: "uname -snr",
  osRelease: "cat /etc/os-release",
  synologyVersion: "cat /etc.defaults/VERSION",
  truenasVersion: "cat /etc/version",
  stat: "cat /proc/stat",
  meminfo: "cat /proc/meminfo",
  df: "df -P -k",
  netdev: "cat /proc/net/dev",
  uptime: "cat /proc/uptime",
  loadavg: "cat /proc/loadavg",
  mdstat: "cat /proc/mdstat",
  hasSensors: `${SBIN}command -v sensors`,
  hasSmartctl: `${SBIN}command -v smartctl`,
  hasZpool: `${SBIN}command -v zpool`,
  hasMidclt: `${SBIN}command -v midclt`,
} as const;

export const OPTIONAL_COMMANDS = {
  sensors: `${SBIN}sensors -j`,
  smartScan: `${SBIN}smartctl --scan`,
  smartScanSudo: "sudo -n smartctl --scan",
  zpoolList: `${SBIN}zpool list -H -p -o name,size,alloc,free,cap,health`,
  zpoolStatus: `${SBIN}zpool status -x`,
} as const;

export type BaseCommand = keyof typeof BASE_COMMANDS;
export type OptionalCommand = keyof typeof OPTIONAL_COMMANDS;

export interface SmartDevice {
  device: string;
  type: string;
}

const DEVICE = /^\/dev\/[A-Za-z0-9_][A-Za-z0-9_/.-]{0,63}$/;
const DEVICE_TYPE = /^[A-Za-z0-9][A-Za-z0-9,+_-]{0,31}$/;
export const MAX_SMART_DEVICES = 32;

export function isSafeDevice(dev: SmartDevice): boolean {
  return DEVICE.test(dev.device) && !dev.device.includes("..") && DEVICE_TYPE.test(dev.type);
}

export type SmartMode = "plain" | "sudo";

// JSON output needs smartmontools 7; older builds (DSM's among them) reject
// -j, and the text form is the fallback.
export function smartCommand(dev: SmartDevice, mode: SmartMode, json: boolean): string {
  if (!isSafeDevice(dev)) throw new Error(`Refusing device ${JSON.stringify(dev)}`);
  const args = `smartctl ${json ? "-j " : ""}-H -A -d ${dev.type} ${dev.device}`;
  return mode === "sudo" ? `sudo -n ${args}` : `${SBIN}${args}`;
}

// Every command a host can be sent for the given disks, for tests and docs.
export function allCommands(devices: SmartDevice[] = []): string[] {
  return [
    ...Object.values(BASE_COMMANDS),
    ...Object.values(OPTIONAL_COMMANDS),
    ...devices.flatMap((dev) =>
      (["plain", "sudo"] as const).flatMap((mode) => [true, false].map((json) => smartCommand(dev, mode, json)))
    ),
  ];
}
