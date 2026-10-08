import { test } from "node:test";
import assert from "node:assert/strict";
import { mockDiscovery } from "../../../src/contracts/mocks/catalog.js";
import { render } from "../../../src/modules/deploy/plan.js";
import { directTlsEntry } from "../../../src/modules/connector-cloudflare/direct.js";

const base = {
  enabled: true,
  defaults: { clusterIssuer: "letsencrypt-prod", access: "cloudflare-tunnel" as const },
  discovery: mockDiscovery,
  jobNamespace: "console",
  jobName: "deploy-direct-tls-1",
  valuesSecret: "deploy-direct-tls-values",
};

const inputs = {
  name: "app-direct-gitea",
  domain: "gitea.example.test",
  service: "gitea-http",
  port: "3000",
  ingressClass: "traefik",
  issuer: "letsencrypt-prod",
  remove: false,
};

test("the direct-tls recipe applies a TLS-only Ingress in the app's namespace", () => {
  const entry = directTlsEntry("gitea");
  const out = render({ ...base, entry, request: { appId: entry.id, namespace: "gitea", inputs } }, "install");
  assert.equal(out.plan.allowed, true, out.plan.blockedBy);
  assert.deepEqual(out.plan.commands, ["kubectl apply -f /values/ingress.yaml"]);
  const yaml = out.files["ingress.yaml"]!;
  assert.match(yaml, /namespace: gitea/);
  assert.match(yaml, /cert-manager.io\/cluster-issuer: letsencrypt-prod/);
  assert.match(yaml, /secretName: app-direct-gitea-tls/);
  assert.match(yaml, /ingressClassName: traefik/);
  assert.match(yaml, /number: 3000/);
});

test("remove deletes the same Ingress; bad names are refused", () => {
  const entry = directTlsEntry("gitea");
  const gone = render(
    { ...base, entry, request: { appId: entry.id, namespace: "gitea", inputs: { ...inputs, remove: true } } },
    "install"
  );
  assert.deepEqual(gone.plan.commands, ["kubectl delete --ignore-not-found -f /values/ingress.yaml"]);
  const bad = render(
    {
      ...base,
      entry,
      request: {
        appId: entry.id,
        namespace: "gitea",
        inputs: { ...inputs, service: "x; rm -rf /", port: "http port" },
      },
    },
    "install"
  );
  assert.equal(bad.plan.allowed, false);
  assert.ok(bad.plan.inputErrors.service);
  assert.ok(bad.plan.inputErrors.port);
});
