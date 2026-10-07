import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckResult } from "../../../src/contracts/health.js";
import { createMockContext } from "../../../src/contracts/mocks/context.js";
import { allCommands } from "../../../src/modules/hosts/commands.js";
import { migrations } from "../../../src/modules/hosts/migrations.js";
import { startHosts } from "../../../src/modules/hosts/service.js";
import { rowResults, toView } from "../../../src/modules/hosts/store.js";
import { startFakeSshHost } from "../../support/index.js";
import {
  LINUX_DISKS,
  SYNOLOGY_DISKS,
  TRUENAS_DISKS,
  linuxHost,
  synologyHost,
  truenasHost,
  type Table,
  parseableKeyPair,
} from "./fixtures.js";

const T0 = Date.parse("2026-10-07T12:00:00Z");
const THRESHOLDS = { diskWarnPercent: 85, diskCritPercent: 95, loadWarnPerCpu: 2 };

async function setup(initial: Table, options: { paths?: string[]; pin?: string; noCredential?: boolean } = {}) {
  const keys = parseableKeyPair();
  let table = initial;
  const fake = await startFakeSshHost({
    publicKey: keys.publicKey,
    hostKey: parseableKeyPair().privateKey,
    commands: (c) => table[c],
  });
  const mock = createMockContext("hosts", { migrations });
  let clock = T0;
  const service = startHosts(mock.ctx, {
    now: () => clock,
    intervalMs: () => 60_000,
    thresholds: () => THRESHOLDS,
  });
  const id = "host_test";
  service.store.insert(
    id,
    {
      label: "NAS",
      address: fake.host,
      port: fake.port,
      username: fake.username,
      auth: "key",
      kind: "auto",
      backupTargetPaths: options.paths ?? [],
      hostKeyFingerprint: options.pin ?? null,
    },
    new Date(T0).toISOString()
  );
  if (!options.noCredential) await mock.ctx.secrets.put("hosts", id, keys.privateKey);
  return {
    fake,
    mock,
    service,
    id,
    setTable(next: Table) {
      table = next;
    },
    advance(ms: number) {
      clock += ms;
    },
    row: () => service.store.get(id)!,
    results: () => rowResults(service.store.get(id)!),
    check: (part: string) => rowResults(service.store.get(id)!).find((r) => r.id === `${id}.${part}`),
    async close() {
      await mock.close();
      await fake.close();
    },
  };
}

const byId = (results: CheckResult[]) => Object.fromEntries(results.map((r) => [r.id.split(".").at(-1)!, r]));

test("generic Linux: facts, metrics, rates on the second visit, SMART through sudo", async () => {
  const h = await setup(linuxHost());
  try {
    await h.service.collectHost(h.id);
    assert.deepEqual(h.fake.unexpected, [], "every command sent is in the canned table");
    const allowed = new Set(allCommands(LINUX_DISKS));
    assert.deepEqual(
      h.fake.executed.filter((c) => !allowed.has(c)),
      [],
      "nothing outside the fixed list"
    );
    const view = toView(h.row(), true);
    assert.equal(view.detectedKind, "linux");
    assert.equal(view.status, "ok");
    assert.deepEqual(view.facts, {
      hostname: "box1",
      kernel: "6.8.0-45-generic",
      os: "Ubuntu 24.04.1 LTS",
      uptimeSeconds: 350735,
      cpus: 4,
      memoryBytes: 16303428 * 1024,
    });
    assert.match(h.row().host_key_fingerprint ?? "", /^SHA256:/, "pinned on first connect");
    assert.equal(h.row().host_key_fingerprint, h.fake.fingerprint);

    const checks = byId(h.results());
    assert.deepEqual(Object.keys(checks).toSorted(), ["disk", "load", "reachable", "smart", "temperature"]);
    assert.equal(checks.reachable!.detail, "SSH as monitor, Ubuntu 24.04.1 LTS");
    assert.equal(checks.smart!.status, "ok");
    assert.equal(checks.smart!.detail, "2 disks healthy");
    assert.match(checks.disk!.detail, /^Fullest: \/mnt\/nas-backups at 43%/);
    assert.equal(checks.temperature!.detail, "Hottest: coretemp-isa-0000/Package id 0 at 47°C");

    const series = (name: string) => h.mock.samples.filter((s) => s.series === name);
    assert.equal(series("host.cpu.percent").length, 0, "no CPU rate from one reading");
    assert.equal(series("host.memory.percent")[0]!.value, 40.01);
    assert.deepEqual(
      series("host.disk.percent").map((s) => s.labels.mount),
      ["/", "/boot/efi", "/srv/data", "/mnt/nas-backups"]
    );
    assert.ok(series("host.temp.celsius").some((s) => s.labels.sensor === "disk/dev/sda" && s.value === 34));
    assert.ok(h.mock.samples.every((s) => s.labels.host === h.id && s.ts === T0));

    h.mock.samples.length = 0;
    h.advance(60_000);
    // 400k more jiffies idle (of 400k total), 60 MB more received.
    h.setTable(linuxHost({ statIdle: 4_400_000, rx: 960_000_000 }));
    await h.service.collectHost(h.id);
    assert.equal(series("host.cpu.percent")[0]!.value, 0);
    const rx = series("host.net.rx.bytesPerSec");
    assert.deepEqual(
      rx.map((s) => [s.labels.iface, s.value]),
      [["enp3s0", 1_000_000]]
    );
  } finally {
    await h.close();
  }
});

test("generic Linux: warnings for a full disk, reallocated sectors and high load", async () => {
  const h = await setup(linuxHost({ diskUsedKb: 440_000_000, realloc: 16, load: "9.10 8.00 7.00" }));
  try {
    await h.service.collectHost(h.id);
    const checks = byId(h.results());
    assert.equal(checks.disk!.status, "crit");
    assert.match(checks.disk!.detail, /^\/ at 97%/);
    assert.ok(Array.isArray(checks.disk!.raw));
    assert.equal(checks.smart!.status, "warn");
    assert.match(checks.smart!.detail, /\/dev\/sda \(WDC WD40EFRX-68N32N0\): 16 reallocated sectors/);
    assert.equal(checks.load!.status, "warn");
    assert.equal(checks.load!.value, 9.1);
    assert.equal(h.row().status, "crit");
  } finally {
    await h.close();
  }
});

test("SMART without root and without sudo is unknown with what to set up", async () => {
  const h = await setup(linuxHost({ sudo: false }));
  try {
    await h.service.collectHost(h.id);
    const smart = h.check("smart")!;
    assert.equal(smart.status, "unknown");
    assert.match(smart.detail, /allow "monitor" to run smartctl through sudo/);
    assert.deepEqual(h.fake.unexpected, []);
  } finally {
    await h.close();
  }
});

test("Synology DSM: detected, md arrays judged without DSM's spare system slots, smartctl 6 text", async () => {
  const h = await setup(synologyHost(), { paths: ["/volume1/backups"] });
  try {
    await h.service.collectHost(h.id);
    assert.deepEqual(h.fake.unexpected, []);
    const allowed = new Set(allCommands(SYNOLOGY_DISKS));
    assert.deepEqual(
      h.fake.executed.filter((c) => !allowed.has(c)),
      []
    );
    const view = toView(h.row(), true);
    assert.equal(view.detectedKind, "synology");
    assert.equal(view.facts?.os, "DSM 7.2.1-69057");
    const checks = byId(h.results());
    assert.deepEqual(Object.keys(checks).toSorted(), ["disk", "load", "raid", "reachable", "smart"]);
    assert.equal(checks.raid!.status, "ok");
    assert.equal(checks.raid!.detail, "3 arrays healthy");
    assert.equal(checks.smart!.detail, "4 disks healthy");
    assert.equal(view.status, "ok");

    h.setTable(synologyHost({ degraded: true, rebuilding: true, failedDisk: true }));
    h.advance(60_000);
    await h.service.collectHost(h.id);
    const after = byId(h.results());
    assert.equal(after.raid!.status, "crit");
    assert.equal(after.raid!.detail, "md2 is degraded (3/4 working), recovery 17.5%");
    assert.equal(after.smart!.status, "crit");
    assert.match(after.smart!.detail, /\/dev\/sata3: SMART overall health FAILED, 2048 reallocated sectors/);
  } finally {
    await h.close();
  }
});

test("TrueNAS SCALE: detected, pools judged by zpool not by dataset, backup target capacity", async () => {
  const h = await setup(truenasHost(), { paths: ["/mnt/tank/backups"] });
  try {
    h.service.syncCapacities();
    await h.service.collectHost(h.id);
    assert.deepEqual(h.fake.unexpected, []);
    const allowed = new Set(allCommands(TRUENAS_DISKS));
    assert.deepEqual(
      h.fake.executed.filter((c) => !allowed.has(c)),
      []
    );
    const view = toView(h.row(), true);
    assert.equal(view.detectedKind, "truenas");
    assert.equal(view.facts?.os, "TrueNAS SCALE 24.10.2");
    const checks = byId(h.results());
    assert.equal(checks.pools!.status, "ok");
    assert.equal(checks.pools!.detail, "2 pools ONLINE: boot-pool, tank");
    assert.match(checks.disk!.detail, /^Fullest: pool tank at 42%/);
    assert.ok(!h.mock.samples.some((s) => s.series === "host.disk.percent" && s.labels.mount?.startsWith("/mnt/tank")));
    assert.deepEqual(
      h.mock.samples.filter((s) => s.series === "host.pool.percent").map((s) => [s.labels.pool, s.value]),
      [
        ["boot-pool", 2],
        ["tank", 42],
      ]
    );

    const [capacity] = h.mock.ctx.backups.capacities();
    assert.ok(capacity);
    assert.equal(
      capacity.targetMatch({ id: "longhorn:x", label: "x", url: `nfs://${h.fake.host}:/mnt/tank/backups/longhorn` }),
      true
    );
    assert.equal(
      capacity.targetMatch({ id: "longhorn:x", label: "x", url: "nfs://truenas:/mnt/tank/backups" }),
      true,
      "by hostname too"
    );
    assert.equal(
      capacity.targetMatch({ id: "longhorn:x", label: "x", url: `nfs://${h.fake.host}:/mnt/tank/other` }),
      false
    );
    assert.equal(
      capacity.targetMatch({ id: "velero:default", label: "default", url: "s3://bucket@us-east-1/" }),
      false
    );
    assert.deepEqual(await capacity.freeBytes(), { free: 5_000_000_000 * 1024, total: 9_000_000_000 * 1024 });

    h.setTable(truenasHost({ poolHealth: "DEGRADED", poolCap: 96, statusX: "  pool: tank\n state: DEGRADED\n" }));
    await h.service.collectHost(h.id);
    const after = byId(h.results());
    assert.equal(after.pools!.status, "crit");
    assert.equal(after.pools!.detail, "tank is DEGRADED");
    assert.equal(after.disk!.status, "crit");

    h.setTable(
      truenasHost({
        statusX: "  pool: tank\n state: ONLINE\nstatus: One or more devices has experienced an unrecoverable error.\n",
      })
    );
    await h.service.collectHost(h.id);
    assert.equal(h.check("pools")!.status, "warn");
  } finally {
    await h.close();
  }
});

test("an unreachable host fails reachability and keeps its other checks as unknown", async () => {
  const h = await setup(linuxHost());
  try {
    await h.service.collectHost(h.id);
    const seenAt = h.row().last_seen_at;
    await h.fake.close();
    h.advance(60_000);
    await h.service.collectHost(h.id);
    const checks = byId(h.results());
    assert.equal(checks.reachable!.status, "crit");
    assert.match(checks.reachable!.detail, /Could not collect from 127\.0\.0\.1/);
    assert.equal(checks.disk!.status, "unknown");
    assert.match(checks.disk!.detail, /^Not collected: host unreachable/);
    assert.equal(h.row().status, "crit");
    assert.equal(h.row().last_seen_at, seenAt);
    assert.ok(h.row().last_error);
  } finally {
    await h.mock.close();
  }
});

test("a host presenting a different key than the pinned one is refused", async () => {
  const h = await setup(linuxHost(), { pin: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
  try {
    await h.service.collectHost(h.id);
    assert.deepEqual(h.fake.executed, [], "nothing is run on a host that failed verification");
    const reachable = h.check("reachable")!;
    assert.equal(reachable.status, "crit");
    assert.match(reachable.detail, /Host key changed: pinned SHA256:A+, host presented SHA256:/);
    assert.equal(h.row().host_key_fingerprint, "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "pin unchanged");
  } finally {
    await h.close();
  }
});

test("no stored credential is unknown, not unreachable", async () => {
  const h = await setup(linuxHost(), { noCredential: true });
  try {
    await h.service.collectHost(h.id);
    assert.equal(h.check("reachable")!.status, "unknown");
    assert.equal(h.fake.executed.length, 0);
  } finally {
    await h.close();
  }
});

test("health provider: no hosts is absent, a new host waits, stale results turn unknown", async () => {
  const mock = createMockContext("hosts", { migrations });
  let clock = T0;
  const service = startHosts(mock.ctx, { now: () => clock, intervalMs: () => 60_000, thresholds: () => THRESHOLDS });
  try {
    assert.deepEqual(
      (await service.provider.collect()).map((r) => [r.id, r.status]),
      [["none", "absent"]]
    );
    const fields = {
      label: "Box",
      address: "192.0.2.20",
      port: 22,
      username: "monitor",
      auth: "key" as const,
      kind: "auto" as const,
      backupTargetPaths: [],
      hostKeyFingerprint: null,
    };
    service.store.insert("host_a", fields, new Date(T0).toISOString());
    const [waiting] = await service.provider.collect();
    assert.equal(waiting!.status, "unknown");
    assert.equal(waiting!.detail, "Waiting for the first collection");

    const ok: CheckResult = {
      id: "host_a.disk",
      label: "Box: disk space",
      status: "ok",
      detail: "Fullest: / at 10%",
      observedAt: "",
    };
    service.store.record(service.store.get("host_a")!, { status: "ok", results: [ok], at: new Date(T0).toISOString() });
    assert.equal((await service.provider.collect())[0]!.status, "ok");
    clock += 10 * 60_000;
    const [stale] = await service.provider.collect();
    assert.equal(stale!.status, "unknown");
    assert.match(stale!.detail, /^No collection since/);
  } finally {
    await mock.close();
  }
});

test("collectDue visits only hosts whose interval has passed", async () => {
  const h = await setup(linuxHost());
  try {
    await h.service.collectDue(new AbortController().signal);
    const first = h.fake.executed.length;
    assert.ok(first > 0);
    h.advance(20_000);
    await h.service.collectDue(new AbortController().signal);
    assert.equal(h.fake.executed.length, first, "not due yet");
    h.advance(40_000);
    await h.service.collectDue(new AbortController().signal);
    assert.ok(h.fake.executed.length > first);
  } finally {
    await h.close();
  }
});
