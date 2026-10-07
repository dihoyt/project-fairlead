import ssh2 from "ssh2";
import { generateKeyPair, type CannedResult } from "../../support/index.js";
import {
  BASE_COMMANDS,
  OPTIONAL_COMMANDS,
  smartCommand,
  type SmartDevice,
} from "../../../src/modules/hosts/commands.js";

// Canned output for the collector's fixed command list, one table per kind
// of host. Shapes are from real hosts of each kind, with names, serials and
// addresses replaced.

export type Table = Record<string, CannedResult | string>;

const missing = (file: string): CannedResult => ({ stderr: `cat: ${file}: No such file or directory\n`, code: 1 });
const notFound: CannedResult = { code: 1 };
const denied = (dev: string): CannedResult => ({
  stdout: `smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.8.0-45-generic] (local build)\nCopyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org\n\nSmartctl open device: ${dev} failed: Permission denied\n`,
  code: 2,
});
const deniedJson = (dev: string): CannedResult => ({
  stdout: JSON.stringify({
    json_format_version: [1, 0],
    smartctl: {
      version: [7, 4],
      exit_status: 2,
      messages: [{ string: `Smartctl open device: ${dev} failed: Permission denied`, severity: "error" }],
    },
    device: { name: dev, info_name: dev, type: "sat", protocol: "ATA" },
  }),
  code: 2,
});
const sudoRefused: CannedResult = { stderr: "sudo: a password is required\n", code: 1 };

function ataJson(
  dev: string,
  model: string,
  opts: { passed?: boolean; realloc?: number; pending?: number; temp?: number } = {}
) {
  return JSON.stringify({
    json_format_version: [1, 0],
    smartctl: { version: [7, 4], exit_status: opts.passed === false ? 8 : 0 },
    device: { name: dev, info_name: dev, type: "sat", protocol: "ATA" },
    model_name: model,
    serial_number: "SERIAL0001",
    smart_status: { passed: opts.passed ?? true },
    temperature: { current: opts.temp ?? 34 },
    ata_smart_attributes: {
      revision: 16,
      table: [
        {
          id: 5,
          name: "Reallocated_Sector_Ct",
          value: 100,
          worst: 100,
          thresh: 10,
          raw: { value: opts.realloc ?? 0, string: String(opts.realloc ?? 0) },
        },
        { id: 9, name: "Power_On_Hours", value: 92, worst: 92, thresh: 0, raw: { value: 31234, string: "31234" } },
        {
          id: 194,
          name: "Temperature_Celsius",
          value: 66,
          worst: 50,
          thresh: 0,
          raw: { value: opts.temp ?? 34, string: String(opts.temp ?? 34) },
        },
        {
          id: 197,
          name: "Current_Pending_Sector",
          value: 100,
          worst: 100,
          thresh: 0,
          raw: { value: opts.pending ?? 0, string: String(opts.pending ?? 0) },
        },
        { id: 198, name: "Offline_Uncorrectable", value: 100, worst: 100, thresh: 0, raw: { value: 0, string: "0" } },
      ],
    },
  });
}

function nvmeJson(dev: string, opts: { criticalWarning?: number; mediaErrors?: number; percentUsed?: number } = {}) {
  return JSON.stringify({
    json_format_version: [1, 0],
    smartctl: { version: [7, 4], exit_status: 0 },
    device: { name: dev, info_name: dev, type: "nvme", protocol: "NVMe" },
    model_name: "Samsung SSD 980 PRO 1TB",
    serial_number: "SERIAL0002",
    smart_status: { passed: true, nvme: { value: 0 } },
    temperature: { current: 41 },
    nvme_smart_health_information_log: {
      critical_warning: opts.criticalWarning ?? 0,
      temperature: 41,
      percentage_used: opts.percentUsed ?? 3,
      media_errors: opts.mediaErrors ?? 0,
    },
  });
}

// smartmontools 6 text, as DSM ships it.
function ataText(model: string, opts: { passed?: boolean; realloc?: number; temp?: number } = {}) {
  return `smartctl 6.5 (build date Sep 26 2022) [x86_64-linux-4.4.302+] (local build)
Copyright (C) 2002-16, Bruce Allen, Christian Franke, www.smartmontools.org

=== START OF READ SMART DATA SECTION ===
SMART overall-health self-assessment test result: ${opts.passed === false ? "FAILED!" : "PASSED"}

SMART Attributes Data Structure revision number: 16
Vendor Specific SMART Attributes with Thresholds:
ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE
  1 Raw_Read_Error_Rate     0x000b   100   100   016    Pre-fail  Always       -       0
  5 Reallocated_Sector_Ct   0x0033   100   100   005    Pre-fail  Always       -       ${opts.realloc ?? 0}
  9 Power_On_Hours          0x0012   096   096   000    Old_age   Always       -       29871
194 Temperature_Celsius     0x0002   171   171   000    Old_age   Always       -       ${opts.temp ?? 35} (Min/Max 18/44)
197 Current_Pending_Sector  0x0022   100   100   000    Old_age   Always       -       0
198 Offline_Uncorrectable   0x0008   100   100   000    Old_age   Offline      -       0
# Model: ${model}
`;
}

const unrecognizedJ: CannedResult = {
  stdout:
    "smartctl 6.5 (build date Sep 26 2022) [x86_64-linux-4.4.302+] (local build)\n\n=======> UNRECOGNIZED OPTION: j\n\nUse smartctl -h to get a usage summary\n",
  code: 1,
};

function smartTable(
  devices: SmartDevice[],
  answer: (dev: SmartDevice, mode: "plain" | "sudo", json: boolean) => CannedResult | string
): Table {
  const out: Table = {};
  for (const dev of devices) {
    for (const mode of ["plain", "sudo"] as const) {
      for (const json of [true, false]) out[smartCommand(dev, mode, json)] = answer(dev, mode, json);
    }
  }
  return out;
}

// --- generic Linux: Ubuntu 24.04, 4 CPUs, lm-sensors, smartctl 7 through sudo ---

export const LINUX_DISKS: SmartDevice[] = [
  { device: "/dev/sda", type: "sat" },
  { device: "/dev/nvme0", type: "nvme" },
];

export interface LinuxOptions {
  statIdle?: number;
  rx?: number;
  diskUsedKb?: number;
  load?: string;
  realloc?: number;
  sudo?: boolean;
}

export function linuxHost(opts: LinuxOptions = {}): Table {
  const idle = opts.statIdle ?? 4_000_000;
  const rx = opts.rx ?? 900_000_000;
  const rootUsed = opts.diskUsedKb ?? 30_000_000;
  return {
    [BASE_COMMANDS.uname]: "Linux box1 6.8.0-45-generic\n",
    [BASE_COMMANDS.osRelease]:
      'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nVERSION="24.04.1 LTS (Noble Numbat)"\nID=ubuntu\nID_LIKE=debian\n',
    [BASE_COMMANDS.synologyVersion]: missing("/etc.defaults/VERSION"),
    [BASE_COMMANDS.truenasVersion]: missing("/etc/version"),
    [BASE_COMMANDS.stat]: `cpu  ${1_000_000} 2000 300000 ${idle} 50000 0 10000 0 0 0
cpu0 250000 500 75000 ${idle / 4} 12500 0 2500 0 0 0
cpu1 250000 500 75000 ${idle / 4} 12500 0 2500 0 0 0
cpu2 250000 500 75000 ${idle / 4} 12500 0 2500 0 0 0
cpu3 250000 500 75000 ${idle / 4} 12500 0 2500 0 0 0
intr 123456789 0 9 0
ctxt 987654321
btime 1759800000
processes 123456
procs_running 2
procs_blocked 0
`,
    [BASE_COMMANDS.meminfo]: `MemTotal:       16303428 kB
MemFree:         1203456 kB
MemAvailable:    9781234 kB
Buffers:          312345 kB
Cached:          7654321 kB
SwapCached:            0 kB
SwapTotal:       4194300 kB
SwapFree:        4194300 kB
`,
    [BASE_COMMANDS.df]: `Filesystem     1024-blocks      Used Available Capacity Mounted on
tmpfs              1630344      2148   1628196       1% /run
/dev/nvme0n1p2   479596204  ${rootUsed} ${479596204 - rootUsed - 24000000}      ${Math.ceil((rootUsed / (479596204 - 24000000)) * 100)}% /
tmpfs              8151712         0   8151712       0% /dev/shm
/dev/nvme0n1p1     1098632      6220   1092412       1% /boot/efi
/dev/sda1       3844640564 1200000000 2449306616      33% /srv/data
/dev/loop0           65536     65536         0     100% /snap/core22/1612
overlay          479596204  30000000 425596204       7% /var/lib/docker/overlay2/abc/merged
192.0.2.10:/volume1/backups 11701135232 5000000000 6701135232 43% /mnt/nas-backups
`,
    [BASE_COMMANDS.netdev]: `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 12345678   12345    0    0    0     0          0         0 12345678   12345    0    0    0     0       0          0
enp3s0: ${rx} 1234567    0    0    0     0          0      1234 450000000  987654    0    0    0     0       0          0
docker0:  1000    10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0
veth1a2b:  1000    10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0
`,
    [BASE_COMMANDS.uptime]: "350735.47 1234567.89\n",
    [BASE_COMMANDS.loadavg]: `${opts.load ?? "0.42 0.38 0.33"} 2/412 123456\n`,
    [BASE_COMMANDS.mdstat]: "Personalities : \nunused devices: <none>\n",
    [BASE_COMMANDS.hasSensors]: "/usr/bin/sensors\n",
    [BASE_COMMANDS.hasSmartctl]: "/usr/sbin/smartctl\n",
    [BASE_COMMANDS.hasZpool]: notFound,
    [BASE_COMMANDS.hasMidclt]: notFound,
    [OPTIONAL_COMMANDS.sensors]: JSON.stringify({
      "coretemp-isa-0000": {
        Adapter: "ISA adapter",
        "Package id 0": { temp1_input: 47.0, temp1_max: 80.0, temp1_crit: 100.0, temp1_crit_alarm: 0.0 },
        "Core 0": { temp2_input: 45.0, temp2_max: 80.0, temp2_crit: 100.0, temp2_crit_alarm: 0.0 },
      },
      "nvme-pci-0100": {
        Adapter: "PCI adapter",
        Composite: { temp1_input: 40.85, temp1_max: 81.85, temp1_min: -273.15, temp1_crit: 84.85, temp1_alarm: 0.0 },
      },
      "acpitz-acpi-0": { Adapter: "ACPI interface", temp1: { temp1_input: 27.8 } },
    }),
    [OPTIONAL_COMMANDS.smartScan]:
      "/dev/sda -d sat # /dev/sda [SAT], ATA device\n/dev/nvme0 -d nvme # /dev/nvme0, NVMe device\n",
    ...smartTable(LINUX_DISKS, (dev, mode, json) => {
      if (mode === "plain") return json ? deniedJson(dev.device) : denied(dev.device);
      if (opts.sudo === false) return sudoRefused;
      if (!json) return notFound;
      return dev.type === "nvme"
        ? nvmeJson(dev.device)
        : ataJson(dev.device, "WDC WD40EFRX-68N32N0", { realloc: opts.realloc ?? 0 });
    }),
  };
}

// --- Synology DSM 7.2: SHR over mdadm, smartmontools 6, no lm-sensors ---

export const SYNOLOGY_DISKS: SmartDevice[] = [
  { device: "/dev/sata1", type: "sat" },
  { device: "/dev/sata2", type: "sat" },
  { device: "/dev/sata3", type: "sat" },
  { device: "/dev/sata4", type: "sat" },
];

export interface SynologyOptions {
  degraded?: boolean;
  rebuilding?: boolean;
  failedDisk?: boolean;
  volumeUsedKb?: number;
}

export function synologyHost(opts: SynologyOptions = {}): Table {
  const used = opts.volumeUsedKb ?? 5_000_000_000;
  const md2 = opts.degraded
    ? `md2 : active raid5 sata1p5[0] sata2p5[1] sata4p5[3]
      11701135232 blocks super 1.2 level 5, 64k chunk, algorithm 2 [4/3] [UU_U]
${opts.rebuilding ? "      [===>.................]  recovery = 17.5% (683456128/3900378410) finish=310.2min speed=172800K/sec\n" : ""}`
    : `md2 : active raid5 sata1p5[0] sata2p5[1] sata3p5[2] sata4p5[3]
      11701135232 blocks super 1.2 level 5, 64k chunk, algorithm 2 [4/4] [UUUU]
`;
  return {
    [BASE_COMMANDS.uname]: "Linux nas 4.4.302+\n",
    [BASE_COMMANDS.osRelease]: missing("/etc/os-release"),
    [BASE_COMMANDS.synologyVersion]: `majorversion="7"
minorversion="2"
major="7"
minor="2"
micro="1"
buildphase="GM"
buildnumber="69057"
smallfixnumber="5"
nano="5"
base="69057"
productversion="7.2.1"
os_name="DSM"
builddate="2024/04/03"
buildtime="12:00:00"
`,
    [BASE_COMMANDS.truenasVersion]: missing("/etc/version"),
    [BASE_COMMANDS.stat]: `cpu  500000 1000 200000 9000000 30000 0 5000 0 0 0
cpu0 125000 250 50000 2250000 7500 0 1250 0 0 0
cpu1 125000 250 50000 2250000 7500 0 1250 0 0 0
cpu2 125000 250 50000 2250000 7500 0 1250 0 0 0
cpu3 125000 250 50000 2250000 7500 0 1250 0 0 0
intr 1 0
`,
    [BASE_COMMANDS.meminfo]: `MemTotal:        8058288 kB
MemFree:          312000 kB
MemAvailable:    5400000 kB
Buffers:           90000 kB
Cached:          4800000 kB
`,
    [BASE_COMMANDS.df]: `Filesystem             1024-blocks       Used   Available Capacity Mounted on
/dev/md0                   2385528    1600000      666000      71% /
devtmpfs                   4010660          0     4010660       0% /dev
tmpfs                      4029144        244     4028900       1% /dev/shm
tmpfs                      4029144      21808     4007336       1% /run
tmpfs                      4029144          0     4029144       0% /sys/fs/cgroup
tmpfs                      4029144       1268     4027876       1% /tmp
/dev/mapper/cachedev_0 11701135232 ${used} ${11701135232 - used} ${Math.ceil((used / 11701135232) * 100)}% /volume1
/dev/mapper/cachedev_0 11701135232 ${used} ${11701135232 - used} ${Math.ceil((used / 11701135232) * 100)}% /volume1/@docker
`,
    [BASE_COMMANDS.netdev]: `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  2000000   20000    0    0    0     0          0         0  2000000   20000    0    0    0     0       0          0
  eth0: 55000000000 40000000    0    0    0     0          0     12345 22000000000 30000000    0    0    0     0       0          0
  eth1:        0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0
 sit0:        0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0
`,
    [BASE_COMMANDS.uptime]: "3456000.12 12000000.00\n",
    [BASE_COMMANDS.loadavg]: "1.05 0.98 0.91 1/890 23456\n",
    [BASE_COMMANDS.mdstat]: `Personalities : [raid1] [linear] [raid0] [raid10] [raid6] [raid5] [raid4]
${md2}
md1 : active raid1 sata1p2[0] sata2p2[1] sata3p2[2] sata4p2[3]
      2097088 blocks [16/4] [UUUU____________]

md0 : active raid1 sata1p1[0] sata2p1[1] sata3p1[2] sata4p1[3]
      2490176 blocks [16/4] [UUUU____________]

unused devices: <none>
`,
    [BASE_COMMANDS.hasSensors]: notFound,
    [BASE_COMMANDS.hasSmartctl]: "/usr/bin/smartctl\n",
    [BASE_COMMANDS.hasZpool]: notFound,
    [BASE_COMMANDS.hasMidclt]: notFound,
    [OPTIONAL_COMMANDS.smartScan]:
      SYNOLOGY_DISKS.map((d) => `${d.device} -d ${d.type} # ${d.device}, ATA device`).join("\n") + "\n",
    ...smartTable(SYNOLOGY_DISKS, (dev, mode, json) => {
      if (json) return unrecognizedJ;
      if (mode === "plain") return denied(dev.device);
      const failing = opts.failedDisk && dev.device === "/dev/sata3";
      return ataText("ST4000VN008-2DR166", failing ? { passed: false, realloc: 2048 } : {});
    }),
  };
}

// --- TrueNAS SCALE 24.10: ZFS, midclt, smartctl 7 through sudo ---

export const TRUENAS_DISKS: SmartDevice[] = [
  { device: "/dev/sda", type: "sat" },
  { device: "/dev/sdb", type: "sat" },
];

export interface TruenasOptions {
  poolHealth?: string;
  poolCap?: number;
  statusX?: string;
}

export function truenasHost(opts: TruenasOptions = {}): Table {
  const cap = opts.poolCap ?? 42;
  const size = 15_994_458_210_304;
  const alloc = Math.round((size * cap) / 100);
  return {
    [BASE_COMMANDS.uname]: "Linux truenas 6.6.44-production+truenas\n",
    [BASE_COMMANDS.osRelease]:
      'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n',
    [BASE_COMMANDS.synologyVersion]: missing("/etc.defaults/VERSION"),
    [BASE_COMMANDS.truenasVersion]: "24.10.2",
    [BASE_COMMANDS.stat]: `cpu  800000 0 400000 20000000 100000 0 20000 0 0 0
cpu0 100000 0 50000 2500000 12500 0 2500 0 0 0
cpu1 100000 0 50000 2500000 12500 0 2500 0 0 0
cpu2 100000 0 50000 2500000 12500 0 2500 0 0 0
cpu3 100000 0 50000 2500000 12500 0 2500 0 0 0
cpu4 100000 0 50000 2500000 12500 0 2500 0 0 0
cpu5 100000 0 50000 2500000 12500 0 2500 0 0 0
cpu6 100000 0 50000 2500000 12500 0 2500 0 0 0
cpu7 100000 0 50000 2500000 12500 0 2500 0 0 0
`,
    [BASE_COMMANDS.meminfo]: `MemTotal:       32819196 kB
MemFree:         2000000 kB
MemAvailable:   12000000 kB
`,
    [BASE_COMMANDS.df]: `Filesystem                                           1024-blocks      Used   Available Capacity Mounted on
udev                                                    16362912         0    16362912       0% /dev
tmpfs                                                    3281920     10328     3271592       1% /run
boot-pool/ROOT/24.10.2                                 210000000   2500000   207500000       2% /
boot-pool/ROOT/24.10.2/var/log                         207600000    100000   207500000       1% /var/log
tank                                                  9000000000       200  9000000000       1% /mnt/tank
tank/backups                                          9000000000 4000000000 5000000000      45% /mnt/tank/backups
tank/ix-applications                                  9000000000   5000000  8995000000       1% /mnt/tank/ix-applications
tank/.system                                          9000000000   1000000  8999000000       1% /var/db/system
`,
    [BASE_COMMANDS.netdev]: `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  2000000   20000    0    0    0     0          0         0  2000000   20000    0    0    0     0       0          0
 eno1: 77000000000 50000000    0    0    0     0          0     12345 33000000000 40000000    0    0    0     0       0          0
`,
    [BASE_COMMANDS.uptime]: "1209600.00 9000000.00\n",
    [BASE_COMMANDS.loadavg]: "0.80 0.70 0.60 1/1200 45678\n",
    [BASE_COMMANDS.mdstat]: "Personalities : \nunused devices: <none>\n",
    [BASE_COMMANDS.hasSensors]: notFound,
    [BASE_COMMANDS.hasSmartctl]: "/usr/sbin/smartctl\n",
    [BASE_COMMANDS.hasZpool]: "/usr/sbin/zpool\n",
    [BASE_COMMANDS.hasMidclt]: "/usr/bin/midclt\n",
    [OPTIONAL_COMMANDS.zpoolList]: `boot-pool\t247497187328\t5368709120\t242128478208\t2\tONLINE\ntank\t${size}\t${alloc}\t${size - alloc}\t${cap}\t${opts.poolHealth ?? "ONLINE"}\n`,
    [OPTIONAL_COMMANDS.zpoolStatus]: opts.statusX ?? "all pools are healthy\n",
    [OPTIONAL_COMMANDS.smartScan]:
      "/dev/sda -d sat # /dev/sda [SAT], ATA device\n/dev/sdb -d sat # /dev/sdb [SAT], ATA device\n",
    ...smartTable(TRUENAS_DISKS, (dev, mode, json) => {
      if (mode === "plain") return json ? deniedJson(dev.device) : denied(dev.device);
      if (!json) return notFound;
      return ataJson(dev.device, "ST8000VN004-3CP101", { temp: 36 });
    }),
  };
}

// ssh2's generateKeyPairSync now and then (about 1 in 300) emits an ed25519
// key its own parser rejects; tests that must not flake retry until it parses.
export function parseableKeyPair(): { privateKey: string; publicKey: string } {
  for (;;) {
    const pair = generateKeyPair();
    if (!(ssh2.utils.parseKey(pair.privateKey) instanceof Error)) return pair;
  }
}
