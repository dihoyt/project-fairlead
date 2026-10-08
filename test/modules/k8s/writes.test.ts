import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { KubeConfig } from "@kubernetes/client-node";
import { RESOURCES } from "../../../src/contracts/k8s.js";
import type { KubeObject } from "../../../src/contracts/k8s.js";
import { createK8sService, type K8sService } from "../../../src/modules/k8s/api.js";
import { loadFixtureSet, startFakeApi, type FakeApi } from "../../support/index.js";

interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

let server: Server;
let seen: Seen[];
let k8s: K8sService;
let fake: FakeApi;
let fakeK8s: K8sService;

const respond = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const jobs = { group: "batch", version: "v1", plural: "jobs", kind: "Job", namespaced: true };

before(async () => {
  seen = [];
  server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", body: text ? JSON.parse(text) : {} });
      if (req.url?.includes("/missing"))
        return respond(res, 404, { kind: "Status", message: "not found", reason: "NotFound" });
      if (req.url?.includes("/forbidden") || text.includes('"forbidden"'))
        return respond(res, 403, { kind: "Status", message: "forbidden", reason: "Forbidden" });
      if (req.method === "POST") {
        const obj = JSON.parse(text) as KubeObject;
        return respond(res, 201, { ...obj, metadata: { ...obj.metadata, uid: "u1" } });
      }
      respond(res, 200, { kind: "Status", status: "Success" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [
      { name: "c", server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, skipTLSVerify: true },
    ],
    users: [{ name: "u" }],
    contexts: [{ name: "x", cluster: "c", user: "u" }],
    currentContext: "x",
  });
  k8s = createK8sService({ connection: () => ({ source: "kubeconfig", server: "x", kubeConfig: kc }) });

  fake = await startFakeApi({ fixtures: loadFixtureSet("synthetic"), denied: ["delete batch/jobs"] });
  const conn = { source: "kubeconfig" as const, server: fake.url, kubeConfig: fake.kubeConfig() };
  fakeK8s = createK8sService({ connection: () => conn });
});
after(async () => {
  await k8s.close();
  await fakeK8s.close();
  await fake.close();
  await new Promise((resolve) => server.close(resolve));
});

test("create posts to the namespaced collection with the owner label and type meta", async () => {
  seen.length = 0;
  const input: KubeObject = {
    metadata: { name: "j1", namespace: "ns", labels: { keep: "yes" } },
    spec: { x: 1 },
  } as KubeObject;
  const created = await k8s.create!(jobs, input);
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.path, "/apis/batch/v1/namespaces/ns/jobs");
  assert.deepEqual(seen[0]!.body.metadata, {
    name: "j1",
    namespace: "ns",
    labels: { keep: "yes", ...k8s.ownedLabels() },
  });
  assert.equal(seen[0]!.body.apiVersion, "batch/v1");
  assert.equal(seen[0]!.body.kind, "Job");
  assert.equal(created.metadata.uid, "u1");
  assert.ok(k8s.isOwned(created));
  // The caller's object is not mutated.
  assert.deepEqual(input.metadata.labels, { keep: "yes" });
});

test("create hits the core group path for Secrets; a namespaced kind needs a namespace", async () => {
  seen.length = 0;
  await k8s.create!(RESOURCES.secrets, { metadata: { name: "s", namespace: "ns" } });
  assert.equal(seen[0]!.path, "/api/v1/namespaces/ns/secrets");
  await assert.rejects(k8s.create!(RESOURCES.secrets, { metadata: { name: "s" } }), /namespaced/);
});

test("create surfaces API errors", async () => {
  await assert.rejects(k8s.create!(jobs, { metadata: { name: "forbidden", namespace: "ns" } }), /forbidden/);
});

test("delete uses foreground propagation and tolerates a missing object", async () => {
  seen.length = 0;
  await k8s.delete!(jobs, "j1", "ns");
  assert.equal(seen[0]!.method, "DELETE");
  assert.equal(seen[0]!.path, "/apis/batch/v1/namespaces/ns/jobs/j1");
  assert.equal(seen[0]!.body.propagationPolicy, "Foreground");
  await k8s.delete!(jobs, "missing", "ns");
  await assert.rejects(k8s.delete!(jobs, "forbidden", "ns"), /forbidden/);
  await assert.rejects(k8s.delete!(jobs, "j1"), /namespaced/);
});

test("can() passes create and delete verbs through the access review", async () => {
  assert.equal(await fakeK8s.can({ verb: "create", group: "batch", resource: "jobs", namespace: "ns" }), true);
  assert.equal(await fakeK8s.can({ verb: "delete", group: "batch", resource: "jobs", namespace: "ns" }), false);
  const review = fake.requests.filter((r) => r.path.endsWith("selfsubjectaccessreviews"));
  assert.ok(review.length >= 2);
});

test("capability rows cover the four resources added for discovery", async () => {
  const report = await fakeK8s.capabilities(true);
  for (const id of [
    "networking.ingresses",
    "networking.ingressclasses",
    "core.services",
    "cert-manager.clusterissuers",
  ]) {
    const row = report.capabilities.find((c) => c.id === id);
    assert.ok(row, id);
    assert.equal(row.check.verb, "list");
  }
});
