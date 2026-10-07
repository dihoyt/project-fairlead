import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE_COMMANDS, OPTIONAL_COMMANDS, isSafeDevice, smartCommand } from "../../../src/modules/hosts/commands.js";
import {
  cpuPercent,
  filesystemFor,
  parseDf,
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
  synologyOs,
  truenasVersion,
  zpoolStatusHealthy,
} from "../../../src/modules/hosts/parse.js";
import { linuxHost, synologyHost, truenasHost, type Table } from "./fixtures.js";

const out = (table: Table, command: string): string => {
  const v = table[command];
  return typeof v === "string" ? v : (v?.stdout ?? "");
};

test("/proc/stat: counters, CPU count and percentage between two reads", () => {
  const a = parseStat(out(linuxHost({ statIdle: 4_000_000 }), BASE_COMMANDS.stat))!;
  assert.equal(a.cpus, 4);
  assert.equal(a.total, 1_000_000 + 2000 + 300_000 + 4_000_000 + 50_000 + 10_000);
  const b = parseStat(out(linuxHost({ statIdle: 4_100_000 }), BASE_COMMANDS.stat))!;
  // Only idle moved: 100% idle over the interval.
  assert.equal(cpuPercent(a, b), 0);
  assert.equal(cpuPercent({ total: 1000, idle: 500, cpus: 1 }, { total: 2000, idle: 750, cpus: 1 }), 75);
  assert.equal(cpuPercent(b, a), undefined, "counters going backwards (reboot) give no value");
  assert.equal(parseStat("garbage"), undefined);
});

test("/proc/meminfo: used from MemAvailable, with the pre-3.14 fallback", () => {
  const m = parseMeminfo(out(linuxHost(), BASE_COMMANDS.meminfo))!;
  assert.equal(m.totalBytes, 16303428 * 1024);
  assert.equal(m.usedBytes, (16303428 - 9781234) * 1024);
  assert.equal(m.percent, 40.01);
  const old = parseMeminfo("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 100 kB\nCached: 300 kB\n")!;
  assert.equal(old.percent, 50);
  assert.equal(parseMeminfo(""), undefined);
});

test("df -P: keeps real filesystems, drops pseudo, loop, container and duplicate mounts", () => {
  const linux = parseDf(out(linuxHost(), BASE_COMMANDS.df));
  assert.deepEqual(
    linux.map((f) => f.mount),
    ["/", "/boot/efi", "/srv/data", "/mnt/nas-backups"]
  );
  assert.ok(linux.every((f) => !f.zfs));
  const data = linux.find((f) => f.mount === "/srv/data")!;
  assert.equal(data.freeBytes, 2449306616 * 1024);
  assert.equal(data.percent, 32.88);

  const syno = parseDf(out(synologyHost(), BASE_COMMANDS.df));
  assert.deepEqual(
    syno.map((f) => f.mount),
    ["/", "/volume1"]
  );

  const nas = parseDf(out(truenasHost(), BASE_COMMANDS.df));
  assert.ok(nas.filter((f) => f.mount.startsWith("/mnt/tank")).every((f) => f.zfs));
  assert.ok(!nas.some((f) => f.mount.includes("ix-applications")));

  assert.deepEqual(
    parseDf("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sdb1 100 50 50 50% /mnt/my disk\n")[0]
      ?.mount,
    "/mnt/my disk"
  );
});

test("filesystemFor picks the longest mount that holds the path", () => {
  const fs = parseDf(out(truenasHost(), BASE_COMMANDS.df));
  assert.equal(filesystemFor("/mnt/tank/backups/velero", fs)?.mount, "/mnt/tank/backups");
  assert.equal(filesystemFor("/mnt/tank/other", fs)?.mount, "/mnt/tank");
  assert.equal(filesystemFor("/mnt/tankish", fs)?.mount, "/");
  assert.equal(filesystemFor("/x", []), undefined);
});

test("/proc/net/dev: physical interfaces only", () => {
  const net = parseNetDev(out(linuxHost({ rx: 123 }), BASE_COMMANDS.netdev));
  assert.deepEqual(Object.keys(net), ["enp3s0"]);
  assert.deepEqual(net.enp3s0, { rx: 123, tx: 450000000 });
  assert.deepEqual(Object.keys(parseNetDev(out(synologyHost(), BASE_COMMANDS.netdev))), ["eth0", "eth1"]);
});

test("uptime, loadavg and uname", () => {
  assert.equal(parseUptime("350735.47 1234567.89\n"), 350735);
  assert.equal(parseUptime("x"), undefined);
  assert.deepEqual(parseLoadavg("0.42 0.38 0.33 2/412 123456\n"), [0.42, 0.38, 0.33]);
  assert.equal(parseLoadavg(""), undefined);
  assert.deepEqual(parseUname("Linux nas 4.4.302+\n"), { hostname: "nas", kernel: "4.4.302+" });
});

test("DSM and TrueNAS versions", () => {
  assert.equal(synologyOs(out(synologyHost(), BASE_COMMANDS.synologyVersion)), "DSM 7.2.1-69057");
  assert.equal(synologyOs("nothing=here"), undefined);
  assert.equal(truenasVersion("24.10.2"), "24.10.2");
  assert.equal(truenasVersion("not a version\n"), undefined);
});

test("sensors -j: temperature inputs with their limits, junk readings skipped", () => {
  const temps = parseSensors(out(linuxHost(), OPTIONAL_COMMANDS.sensors));
  assert.deepEqual(
    temps.map((t) => t.sensor),
    ["coretemp-isa-0000/Package id 0", "coretemp-isa-0000/Core 0", "nvme-pci-0100/Composite", "acpitz-acpi-0/temp1"]
  );
  assert.deepEqual(temps[0], { sensor: "coretemp-isa-0000/Package id 0", celsius: 47, max: 80, crit: 100 });
  assert.equal(temps[3]!.max, undefined);
  assert.deepEqual(parseSensors('{"x":{"t":{"temp1_input":-273.15}}}'), []);
  assert.deepEqual(parseSensors("not json"), []);
});

test("smartctl --scan: devices and types, unsafe names refused", () => {
  assert.deepEqual(parseSmartScan(out(linuxHost(), OPTIONAL_COMMANDS.smartScan)), [
    { device: "/dev/sda", type: "sat" },
    { device: "/dev/nvme0", type: "nvme" },
  ]);
  assert.deepEqual(parseSmartScan("/dev/sda;reboot -d sat # x\n/dev/../etc/passwd -d sat\n/dev/sdb -d $(id)\n"), []);
  assert.equal(isSafeDevice({ device: "/dev/bus/0", type: "megaraid,0" }), true);
  assert.throws(() => smartCommand({ device: "/dev/sda; rm -rf /", type: "sat" }, "plain", true));
});

test("smartctl JSON: ATA and NVMe health, permission denied, no -j support", () => {
  const table = linuxHost({ realloc: 8 });
  const ata = parseSmartJson(
    "/dev/sda",
    out(table, smartCommand({ device: "/dev/sda", type: "sat" }, "sudo", true)),
    ""
  );
  assert.equal(ata.kind, "disk");
  assert.deepEqual(ata.kind === "disk" && ata.disk, {
    device: "/dev/sda",
    model: "WDC WD40EFRX-68N32N0",
    serial: "SERIAL0001",
    passed: true,
    temperature: 34,
    reallocated: 8,
    pending: 0,
    uncorrectable: 0,
  });
  const nvme = parseSmartJson(
    "/dev/nvme0",
    out(table, smartCommand({ device: "/dev/nvme0", type: "nvme" }, "sudo", true)),
    ""
  );
  assert.equal(nvme.kind === "disk" && nvme.disk.percentUsed, 3);

  const denied = parseSmartJson(
    "/dev/sda",
    out(table, smartCommand({ device: "/dev/sda", type: "sat" }, "plain", true)),
    ""
  );
  assert.equal(denied.kind, "denied");
  assert.equal(parseSmartJson("/dev/sda", "", "sudo: a password is required\n").kind, "denied");

  const old = synologyHost()[smartCommand({ device: "/dev/sata1", type: "sat" }, "plain", true)] as { stdout: string };
  assert.equal(parseSmartJson("/dev/sata1", old.stdout, "").kind, "no-json");
  assert.equal(parseSmartJson("/dev/sda", "", "").kind, "error");
});

test("smartctl text (smartmontools 6): overall health and attributes", () => {
  const table = synologyHost({ failedDisk: true });
  const good = parseSmartText(
    "/dev/sata1",
    out(table, smartCommand({ device: "/dev/sata1", type: "sat" }, "sudo", false)),
    ""
  );
  assert.deepEqual(good.kind === "disk" && good.disk, {
    device: "/dev/sata1",
    passed: true,
    reallocated: 0,
    temperature: 35,
    pending: 0,
    uncorrectable: 0,
  });
  const bad = parseSmartText(
    "/dev/sata3",
    out(table, smartCommand({ device: "/dev/sata3", type: "sat" }, "sudo", false)),
    ""
  );
  assert.equal(bad.kind === "disk" && bad.disk.passed, false);
  assert.equal(bad.kind === "disk" && bad.disk.reallocated, 2048);
  const scsi = parseSmartText("/dev/sdc", "SMART Health Status: OK\n", "");
  assert.equal(scsi.kind === "disk" && scsi.disk.passed, true);
  assert.equal(
    parseSmartText("/dev/sda", "Smartctl open device: /dev/sda failed: Permission denied\n", "").kind,
    "denied"
  );
});

test("zpool list and status -x", () => {
  const pools = parseZpoolList(out(truenasHost({ poolHealth: "DEGRADED", poolCap: 91 }), OPTIONAL_COMMANDS.zpoolList));
  assert.deepEqual(
    pools.map((p) => [p.name, p.percent, p.health]),
    [
      ["boot-pool", 2, "ONLINE"],
      ["tank", 91, "DEGRADED"],
    ]
  );
  assert.equal(pools[1]!.sizeBytes, 15_994_458_210_304);
  assert.equal(zpoolStatusHealthy("all pools are healthy\n"), true);
  assert.equal(zpoolStatusHealthy("  pool: tank\n state: DEGRADED\n"), false);
});

test("mdstat: arrays, slots, failed members and rebuild progress", () => {
  const healthy = parseMdstat(out(synologyHost(), BASE_COMMANDS.mdstat));
  assert.deepEqual(
    healthy.map((a) => [a.name, a.level, a.members, a.slots, a.working]),
    [
      ["md2", "raid5", 4, 4, 4],
      ["md1", "raid1", 4, 16, 4],
      ["md0", "raid1", 4, 16, 4],
    ]
  );
  const rebuilding = parseMdstat(out(synologyHost({ degraded: true, rebuilding: true }), BASE_COMMANDS.mdstat));
  assert.equal(rebuilding[0]!.working, 3);
  assert.equal(rebuilding[0]!.activity, "recovery 17.5%");
  const failed = parseMdstat(
    "md3 : active raid1 sdb1[1](F) sda1[0]\n      100 blocks [2/1] [U_]\n\nmd4 : inactive sdc1[0](S)\n"
  );
  assert.equal(failed[0]!.failed, 1);
  assert.equal(failed[1]!.state, "inactive");
  assert.deepEqual(parseMdstat("Personalities : \nunused devices: <none>\n"), []);
});
