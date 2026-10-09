import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { createMockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import { pgAppLabel, pgClusterLabel, pgClusterName, pgSecretAnnotation } from "../../../src/contracts/postgres.js";
import { register } from "../../../src/modules/postgres/index.js";
import { migrations } from "../../../src/modules/postgres/migrations.js";
import { clusterView, databaseViews, readSnapshot, versionOf } from "../../../src/modules/postgres/read.js";
import { parseStats, readStats } from "../../../src/modules/postgres/stats.js";
import { product } from "../../../src/product.js";

const domain = product.ownerMarker.labelDomain;
const NS = "postgres";
const now = () => new Date(MOCK_NOW);
// An unlabelled cluster is the shared one only under its default name.
const DEFAULT = pgClusterName(product.slug);

function cluster(name: string, options: { label?: string; ready?: number; phase?: string; hibernated?: boolean } = {}) {
  return {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: {
      name,
      namespace: NS,
      creationTimestamp: "2026-10-01T00:00:00Z",
      labels: options.label ? { [pgClusterLabel(domain)]: options.label } : {},
      ...(options.hibernated ? { annotations: { "cnpg.io/hibernation": "on" } } : {}),
    },
    spec: {
      instances: 2,
      imageName: "ghcr.io/cloudnative-pg/postgresql:17.6",
      storage: { size: "10Gi", storageClass: "longhorn" },
    },
    status: {
      phase: options.phase ?? "Cluster in healthy state",
      readyInstances: options.ready ?? 2,
      currentPrimary: `${name}-1`,
    },
  };
}

function database(clusterName: string, appId: string, applied = true) {
  const name = appId.replaceAll("-", "_");
  return {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Database",
    metadata: {
      name: `${clusterName}-${appId}`,
      namespace: NS,
      labels: { [pgAppLabel(domain)]: appId },
      annotations: { [pgSecretAnnotation(domain)]: `${appId}/${appId}-postgres` },
    },
    spec: { cluster: { name: clusterName }, name, owner: name },
    status: applied ? { applied: true } : { applied: false, message: "role missing" },
  };
}

function role(clusterName: string, appId: string, applied = true) {
  const name = appId.replaceAll("-", "_");
  return {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "DatabaseRole",
    metadata: { name: `${clusterName}-${appId}`, namespace: NS },
    spec: { cluster: { name: clusterName }, name },
    status: { applied },
  };
}

function pod(name: string, clusterName: string, node: string, ip: string) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace: NS, labels: { "cnpg.io/cluster": clusterName } },
    spec: { nodeName: node },
    status: { podIP: ip, conditions: [{ type: "Ready", status: "True" }] },
  };
}

function fake(objects: { clusters?: object[]; databases?: object[]; roles?: object[]; pods?: object[] } = {}) {
  return createFakeK8s({
    objects: [
      { ref: RESOURCES.cnpgClusters, items: (objects.clusters ?? []) as KubeObject[] },
      { ref: RESOURCES.cnpgDatabases, items: (objects.databases ?? []) as KubeObject[] },
      { ref: RESOURCES.cnpgDatabaseRoles, items: (objects.roles ?? []) as KubeObject[] },
      { ref: RESOURCES.pods, items: (objects.pods ?? []) as KubeObject[] },
    ],
    absentGroups: ["barmancloud.cnpg.io"],
  });
}

const restored = () =>
  fake({
    clusters: [
      cluster("console-postgres", { label: "previous", hibernated: true }),
      cluster("console-postgres-r1", { label: "current" }),
    ],
    databases: [
      database("console-postgres-r1", "authentik"),
      database("console-postgres-r1", "grafana", false),
      database("console-postgres", "authentik"),
    ],
    roles: [role("console-postgres-r1", "authentik"), role("console-postgres-r1", "grafana", false)],
    pods: [
      pod("console-postgres-r1-1", "console-postgres-r1", "node-1", "10.0.0.11"),
      pod("console-postgres-r1-2", "console-postgres-r1", "node-2", "10.0.0.12"),
      pod("console-postgres-1", "console-postgres", "node-1", "10.0.0.13"),
    ],
  });

test("the cluster labelled current wins; previous ones are listed, hibernated", async () => {
  const view = clusterView(await readSnapshot(restored()), "t");
  assert.equal(view.operator, "installed");
  assert.equal(view.barmanCloud, "absent");
  assert.equal(view.name, "console-postgres-r1");
  assert.equal(view.state, "ready");
  assert.equal(view.version, "17.6");
  assert.deepEqual(
    view.instanceList.map((i) => [i.pod, i.node, i.role]),
    [
      ["console-postgres-r1-1", "node-1", "primary"],
      ["console-postgres-r1-2", "node-2", "replica"],
    ]
  );
  assert.deepEqual(view.previous, [{ name: "console-postgres", hibernated: true, createdAt: "2026-10-01T00:00:00Z" }]);
});

test("without CloudNativePG or without a cluster the view reads absent", async () => {
  const noOperator = createFakeK8s({ absentGroups: ["postgresql.cnpg.io", "barmancloud.cnpg.io"] });
  const a = clusterView(await readSnapshot(noOperator), "t");
  assert.deepEqual([a.operator, a.state], ["absent", "absent"]);
  const b = clusterView(await readSnapshot(fake()), "t");
  assert.deepEqual([b.operator, b.state], ["installed", "absent"]);
});

test("a cluster coming up is starting; one short of instances is degraded", async () => {
  const starting = clusterView(
    await readSnapshot(fake({ clusters: [cluster(DEFAULT, { ready: 0, phase: "Setting up primary" })] })),
    "t"
  );
  assert.equal(starting.state, "starting");
  const degraded = clusterView(
    await readSnapshot(
      fake({ clusters: [cluster(DEFAULT, { ready: 1, phase: "Waiting for the instances to become active" })] })
    ),
    "t"
  );
  assert.equal(degraded.state, "degraded");
});

test("databases of the current cluster only, with owner, Secret and stats", async () => {
  const stats = parseStats(
    [
      "# HELP cnpg_pg_database_size_bytes Disk space used by the database",
      'cnpg_pg_database_size_bytes{datname="authentik"} 1.2e+07',
      'cnpg_pg_database_size_bytes{datname="grafana"} 800',
      'cnpg_backends_total{datname="authentik",state="active",usename="authentik"} 2',
      'cnpg_backends_total{datname="authentik",state="idle",usename="authentik"} 3',
    ].join("\n")
  );
  const views = databaseViews(await readSnapshot(restored()), stats);
  assert.deepEqual(views, [
    {
      database: "authentik",
      role: "authentik",
      appId: "authentik",
      secret: { namespace: "authentik", name: "authentik-postgres" },
      applied: true,
      sizeBytes: 12_000_000,
      connections: 5,
    },
    {
      database: "grafana",
      role: "grafana",
      appId: "grafana",
      secret: { namespace: "grafana", name: "grafana-postgres" },
      applied: false,
      message: "role missing",
      sizeBytes: 800,
    },
  ]);
});

test("stats come from the primary's exporter, and are skipped when it doesn't answer", async () => {
  const urls: string[] = [];
  const ok = (async (url: string) => {
    urls.push(url);
    return new Response('cnpg_backends_total{datname="a"} 1\n');
  }) as unknown as typeof fetch;
  const primary = pod("p-1", "p", "n", "10.0.0.5") as Parameters<typeof readStats>[0];
  const stats = await readStats(primary, ok);
  assert.deepEqual(urls, ["http://10.0.0.5:9187/metrics"]);
  assert.equal(stats?.connections.get("a"), 1);
  const down = (async () => {
    throw new Error("refused");
  }) as unknown as typeof fetch;
  assert.equal(await readStats(primary, down), undefined);
  assert.equal(await readStats(undefined, ok), undefined);
});

test("version from the image tag", () => {
  assert.equal(versionOf("ghcr.io/cloudnative-pg/postgresql:17.6-standard-trixie"), "17.6");
  assert.equal(versionOf("ghcr.io/cloudnative-pg/postgresql:18"), "18");
  assert.equal(versionOf(undefined), undefined);
});

test("health: ok when ready, warn for a database not in place, absent without a cluster", async () => {
  const mock = createMockContext("postgres", { migrations, services: { k8s: restored() } });
  try {
    register(mock.ctx, { now });
    const provider = mock.ctx.health.list().find((p) => p.id === "postgres")!;
    assert.equal(provider.category, "storage");
    const results = await provider.collect();
    assert.deepEqual(
      results.map((r) => [r.id, r.status]),
      [
        ["cluster", "ok"],
        ["databases", "warn"],
      ]
    );
    assert.match(results[1]!.detail, /grafana \(role missing\)/);
  } finally {
    await mock.close();
  }

  const empty = createMockContext("postgres", { migrations, services: { k8s: fake() } });
  try {
    register(empty.ctx, { now });
    const results = await empty.ctx.health.list()[0]!.collect();
    assert.deepEqual(
      results.map((r) => r.status),
      ["absent"]
    );
  } finally {
    await empty.close();
  }

  const down = createMockContext("postgres", {
    migrations,
    services: { k8s: fake({ clusters: [cluster(DEFAULT, { ready: 0, phase: "Failing over" })] }) },
  });
  try {
    register(down.ctx, { now });
    const [result] = await down.ctx.health.list()[0]!.collect();
    assert.equal(result!.status, "crit");
    assert.ok(result!.raw);
  } finally {
    await down.close();
  }
});

test("routes: cluster and databases, 503 without the Kubernetes API", async () => {
  const fetcher = (async () =>
    new Response('cnpg_pg_database_size_bytes{datname="authentik"} 42\n')) as unknown as typeof fetch;
  const mock = createMockContext("postgres", { migrations, services: { k8s: restored() } });
  const server: Server = await new Promise((resolve) => {
    const s = mock.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    register(mock.ctx, { now, fetch: fetcher });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/postgres`;
    const view = (await (await fetch(`${base}/cluster`)).json()) as { name: string; checkedAt: string };
    assert.equal(view.name, "console-postgres-r1");
    assert.equal(view.checkedAt, new Date(MOCK_NOW).toISOString());
    const dbs = (await (await fetch(`${base}/databases`)).json()) as Array<{ database: string; sizeBytes?: number }>;
    assert.deepEqual(
      dbs.map((d) => [d.database, d.sizeBytes]),
      [
        ["authentik", 42],
        ["grafana", undefined],
      ]
    );
  } finally {
    server.close();
    await mock.close();
  }

  const bare = createMockContext("postgres", { migrations });
  const bareServer: Server = await new Promise((resolve) => {
    const s = bare.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    register(bare.ctx, { now });
    const res = await fetch(`http://127.0.0.1:${(bareServer.address() as AddressInfo).port}/api/postgres/cluster`);
    assert.equal(res.status, 503);
  } finally {
    bareServer.close();
    await bare.close();
  }
});
