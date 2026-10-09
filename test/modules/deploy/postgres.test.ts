import { test } from "node:test";
import assert from "node:assert/strict";
import { loadYaml } from "@kubernetes/client-node";
import type { CatalogEntry, DiscoveryReport } from "../../../src/contracts/catalog.js";
import type { DeployActionRequest } from "../../../src/contracts/deploy.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { mockDiscovery } from "../../../src/contracts/mocks/catalog.js";
import { pgClusterLabel } from "../../../src/contracts/postgres.js";
import { catalog } from "../../../src/modules/catalog/entries.js";
import { bundles } from "../../../src/modules/catalog/bundles.js";
import {
  actionRecipe,
  actionSchema,
  type ActionContext,
  type ActionRendered,
} from "../../../src/modules/deploy/actions/index.js";
import { currentCluster, databaseObjects } from "../../../src/modules/deploy/actions/pg-objects.js";
import { render, type PlanInput } from "../../../src/modules/deploy/plan.js";
import { stepRequests } from "../../../src/modules/deploy/bundles.js";
import { product } from "../../../src/product.js";

const entry = (id: string) => catalog.find((e) => e.id === id)!;
const LABEL = pgClusterLabel(product.ownerMarker.labelDomain);
const SHARED = { namespace: "postgres", cluster: `${product.slug}-postgres` };

const twoNodes: DiscoveryReport = {
  ...mockDiscovery,
  kubernetesVersion: "v1.36.1",
  nodeDisks: [{ node: "a" }, { node: "b" }],
  apps: mockDiscovery.apps.map((a) =>
    a.appId === "cloudnative-pg"
      ? { ...a, state: "installed" as const, namespace: "cnpg-system", release: "cloudnative-pg" }
      : a.appId === "grafana"
        ? { ...a, state: "not-installed" as const }
        : a
  ),
};

function plan(app: CatalogEntry, inputs: Record<string, string>, more: Partial<PlanInput> = {}) {
  return render(
    {
      entry: app,
      request: { appId: app.id, inputs },
      enabled: true,
      defaults: { baseDomain: "example.test", storageClass: "longhorn", access: "local", ingressClass: "traefik" },
      discovery: twoNodes,
      jobNamespace: "console",
      jobName: `deploy-${app.id}-1`,
      valuesSecret: `deploy-${app.id}-values`,
      ...more,
    },
    "install",
    () => "generated-pw"
  );
}

test("authentik and grafana keep their data in the shared Postgres; nothing else does", () => {
  const users = catalog.filter((e) => e.database === "postgres").map((e) => e.id);
  assert.deepEqual(users.toSorted(), ["authentik", "grafana"]);
});

test("the bundle adds CloudNativePG and the shared cluster before Authentik, only with Authentik", () => {
  const items = bundles[0]!.items.map((i) => i.appId);
  const at = (id: string) => items.indexOf(id);
  assert.ok(at("cert-manager") < at("barman-cloud"));
  assert.ok(at("cloudnative-pg") < at("barman-cloud") && at("barman-cloud") < at("postgres"));
  assert.ok(at("postgres") < at("authentik"));
  for (const id of ["cloudnative-pg", "barman-cloud", "postgres"]) {
    assert.deepEqual(bundles[0]!.items.find((i) => i.appId === id)!.when, { input: "signIn", in: ["authentik"] });
  }
  assert.equal(bundles[0]!.items.find((i) => i.appId === "barman-cloud")!.required, false);
});

test("the shared cluster: one instance per node up to two, anti-affinity, labelled current", () => {
  const r = plan(entry("postgres"), { size: "20Gi" }, { postgres: SHARED });
  assert.equal(r.plan.allowed, true, r.plan.blockedBy);
  const list = JSON.parse(JSON.stringify(loadYaml(r.files["cluster.yaml"]!))) as { items: KubeObject[] };
  const cluster = list.items.find((o) => o.kind === "Cluster") as KubeObject & { spec: Record<string, unknown> };
  assert.equal(cluster.metadata.name, SHARED.cluster);
  assert.equal(cluster.metadata.labels?.[LABEL], "current");
  assert.equal(cluster.spec.instances, 2);
  assert.deepEqual(cluster.spec.storage, { size: "20Gi", storageClass: "longhorn" });
  assert.equal(cluster.spec.enableSuperuserAccess, true);
  assert.deepEqual(
    r.steps.map((s) => s.argv.slice(0, 3).join(" ")),
    ["kubectl apply -f", `kubectl wait clusters.postgresql.cnpg.io/${SHARED.cluster}`]
  );

  const single = plan(
    entry("postgres"),
    {},
    { postgres: SHARED, discovery: { ...twoNodes, nodeDisks: [{ node: "a" }] } }
  );
  const one = (
    loadYaml(single.files["cluster.yaml"]!) as { items: Array<{ kind: string; spec?: { instances?: number } }> }
  ).items.find((o) => o.kind === "Cluster")!;
  assert.equal(one.spec?.instances, 1);
  assert.ok(single.plan.warnings.some((w) => /One instance/.test(w)));
});

test("a restored cluster keeps its name when the shared Postgres is installed again", () => {
  const r = plan(entry("postgres"), {}, { postgres: { namespace: "postgres", cluster: "x-postgres-r1" } });
  assert.match(r.steps[1]!.argv.join(" "), /clusters\.postgresql\.cnpg\.io\/x-postgres-r1/);
});

test("authentik on the shared Postgres: database first, bundled Postgres off, connection from its Secret", () => {
  const r = plan(entry("authentik"), { host: "auth.example.test", adminEmail: "a@example.test" }, { postgres: SHARED });
  assert.equal(r.plan.allowed, true, r.plan.blockedBy);
  const commands = r.plan.commands;
  const helmAt = commands.findIndex((c) => c.startsWith("helm upgrade --install authentik"));
  const applyAt = commands.findIndex((c) => c.includes("postgres-authentik.yaml"));
  assert.ok(applyAt >= 0 && applyAt < helmAt, commands.join("\n"));
  assert.ok(commands.slice(applyAt, helmAt).some((c) => c.includes("databaseroles.postgresql.cnpg.io")));

  const values = loadYaml(r.files["values.yaml"]!) as {
    postgresql: { enabled: boolean };
    authentik: { postgresql: Record<string, string> };
    global: { env: Array<{ name: string; valueFrom: { secretKeyRef: { name: string; key: string } } }> };
  };
  assert.equal(values.postgresql.enabled, false);
  assert.deepEqual(values.authentik.postgresql, { host: "", name: "", user: "", password: "" });
  assert.deepEqual(
    values.global.env.map((e) => [e.name, e.valueFrom.secretKeyRef.name, e.valueFrom.secretKeyRef.key]),
    [
      ["AUTHENTIK_POSTGRESQL__HOST", "authentik-postgres", "host"],
      ["AUTHENTIK_POSTGRESQL__PORT", "authentik-postgres", "port"],
      ["AUTHENTIK_POSTGRESQL__NAME", "authentik-postgres", "dbname"],
      ["AUTHENTIK_POSTGRESQL__USER", "authentik-postgres", "user"],
      ["AUTHENTIK_POSTGRESQL__PASSWORD", "authentik-postgres", "password"],
    ]
  );
  // The generated password reaches the role Secret and the app's Secret, and is redacted.
  assert.match(r.files["postgres-authentik.yaml"]!, /generated-pw/);
  assert.ok(r.secrets.includes("generated-pw"));
  assert.doesNotMatch(r.plan.values, /generated-pw/);
});

test("authentik without the shared Postgres keeps its bundled one", () => {
  const r = plan(entry("authentik"), { host: "auth.example.test", adminEmail: "a@example.test" });
  const values = loadYaml(r.files["values.yaml"]!) as { postgresql: { enabled: boolean }; global?: unknown };
  assert.equal(values.postgresql.enabled, true);
  assert.equal(values.global, undefined);
  assert.equal(r.files["postgres-authentik.yaml"], undefined);
  assert.ok(!r.plan.commands.some((c) => c.includes("postgresql.cnpg.io")));
});

test("grafana on the shared Postgres reads its database from its Secret", () => {
  const r = plan(entry("grafana"), { host: "grafana.example.test", adminPassword: "pw-123456" }, { postgres: SHARED });
  assert.equal(r.plan.allowed, true, r.plan.blockedBy);
  const values = loadYaml(r.files["values.yaml"]!) as {
    "grafana.ini": { database: { type: string } };
    envValueFrom: Record<string, { secretKeyRef: { name: string; key: string } }>;
  };
  assert.equal(values["grafana.ini"].database.type, "postgres");
  assert.deepEqual(values.envValueFrom.GF_DATABASE_PASSWORD, {
    secretKeyRef: { name: "grafana-postgres", key: "password" },
  });
});

test("an app's database objects: role and database on the cluster, connection Secret in its namespace", () => {
  const objects = databaseObjects(SHARED, "pocket-id", "pocket-id", "pw");
  assert.deepEqual(
    objects.map((o) => [o.kind, o.metadata.namespace ?? "", o.metadata.name]),
    [
      ["Secret", "postgres", "pocket-id-postgres"],
      ["DatabaseRole", "postgres", `${SHARED.cluster}-pocket-id`],
      ["Database", "postgres", `${SHARED.cluster}-pocket-id`],
      ["Namespace", "", "pocket-id"],
      ["Secret", "pocket-id", "pocket-id-postgres"],
    ]
  );
  const role = objects[1] as KubeObject & { spec: Record<string, unknown> };
  assert.deepEqual(role.spec, {
    cluster: { name: SHARED.cluster },
    name: "pocket_id",
    login: true,
    passwordSecret: { name: "pocket-id-postgres" },
    databaseRoleReclaimPolicy: "retain",
  });
  const app = objects[4] as KubeObject & { stringData: Record<string, string> };
  assert.equal(app.stringData.host, `${SHARED.cluster}-rw.postgres.svc`);
  assert.equal(app.stringData.uri, `postgresql://pocket_id:pw@${SHARED.cluster}-rw.postgres.svc:5432/pocket_id`);
});

// --- the pg-database action ---------------------------------------------------

const cnpgCluster = (name: string, labels: Record<string, string> = {}): KubeObject => ({
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "Cluster",
  metadata: { name, namespace: "postgres", labels },
});

function context(k8s: FakeK8s, overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    run: true,
    enabled: true,
    image: "img",
    call: () => Promise.reject(new Error("no calls here")),
    k8s,
    discover: async () => undefined,
    releases: [],
    versions: new Map(),
    ...overrides,
  };
}

async function action(request: DeployActionRequest, ctx: ActionContext): Promise<ActionRendered> {
  assert.ok(actionSchema.safeParse(request).success, `schema refuses ${JSON.stringify(request)}`);
  return actionRecipe(request.kind)!.render(request as never, ctx);
}

test("pg-database is refused without CloudNativePG or without the shared cluster", async () => {
  const none = createFakeK8s({ absentGroups: ["postgresql.cnpg.io"] });
  let r = await action({ kind: "pg-database", appId: "wiki", namespace: "wiki" }, context(none));
  assert.match(r.plan.blockedBy!, /CloudNativePG is not installed/);
  r = await action({ kind: "pg-database", appId: "wiki", namespace: "wiki" }, context(createFakeK8s()));
  assert.match(r.plan.blockedBy!, /no shared Postgres/);
});

test("pg-database uses the cluster labelled current and keeps the password out of the plan", async () => {
  const k8s = createFakeK8s({
    objects: [
      {
        ref: RESOURCES.cnpgClusters,
        items: [cnpgCluster(SHARED.cluster, { [LABEL]: "previous" }), cnpgCluster("x-r1", { [LABEL]: "current" })],
      },
    ],
  });
  const found = await currentCluster(k8s);
  assert.equal(found !== "absent" && found?.metadata.name, "x-r1");

  const preview = await action({ kind: "pg-database", appId: "wiki", namespace: "apps" }, context(k8s, { run: false }));
  assert.equal(preview.plan.allowed, true);
  assert.deepEqual(preview.files, {});
  assert.deepEqual(
    preview.plan.creates.map((o) => `${o.kind} ${o.namespace}/${o.name}`),
    [
      "DatabaseRole postgres/x-r1-wiki",
      "Database postgres/x-r1-wiki",
      "Secret postgres/wiki-postgres",
      "Secret apps/wiki-postgres",
    ]
  );

  const run = await action({ kind: "pg-database", appId: "wiki", namespace: "apps" }, context(k8s));
  assert.equal(run.release, "postgres");
  const password = run.secrets![0]!;
  assert.ok(password.length >= 24);
  assert.match(run.files["postgres-wiki.yaml"]!, new RegExp(password));
  assert.deepEqual(
    run.steps.map((s) => s.argv.slice(0, 3).join(" ")),
    [
      "kubectl apply -f",
      "kubectl wait databaseroles.postgresql.cnpg.io/x-r1-wiki",
      "kubectl wait databases.postgresql.cnpg.io/x-r1-wiki",
    ]
  );
});

test("the bundle preview on a fresh cluster with Authentik ticked installs CloudNativePG and the cluster first", () => {
  // Every basic in place, nothing installed: no basic asks for CloudNativePG.
  const fresh: DiscoveryReport = {
    ...mockDiscovery,
    apps: mockDiscovery.apps.map((a) => ({ ...a, state: "not-installed" as const })),
    basics: mockDiscovery.basics.map((b) => ({ ...b, status: "ok" as const, fixAppIds: [] })),
  };
  const steps = stepRequests(
    bundles[0]!,
    entry,
    { bundleId: bundles[0]!.id, inputs: { signIn: "authentik" }, include: ["barman-cloud"] },
    fresh
  );
  const installs = steps.filter((s) => !s.skip).map((s) => s.appId);
  const at = (id: string) => installs.indexOf(id);
  assert.ok(at("cloudnative-pg") >= 0, JSON.stringify(steps.filter((s) => s.skip)));
  assert.ok(at("cloudnative-pg") < at("barman-cloud"));
  assert.ok(at("barman-cloud") < at("postgres") && at("postgres") < at("authentik"));

  // With Pocket ID instead, none of them.
  const pocket = stepRequests(bundles[0]!, entry, { bundleId: bundles[0]!.id, inputs: { signIn: "pocket-id" } }, fresh);
  const skipped = new Set(pocket.filter((s) => s.skip).map((s) => s.appId));
  for (const id of ["cloudnative-pg", "barman-cloud", "postgres"]) assert.ok(skipped.has(id), id);
});
