// The admin page's structured editors send health.rules and health.links as
// JSON text; these pin the shapes they produce to what the module accepts.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Module } from "../../../src/contracts/module.js";
import { declareSettings, type HealthSettings } from "../../../src/modules/health/settings.js";
import { boot, type Booted } from "../../platform/harness.js";

let app: Booted;
let cookie = "";
let declared: HealthSettings;

const health: Module = {
  id: "health",
  milestone: "A",
  register(ctx) {
    declared = declareSettings(ctx.settings);
  },
};

beforeEach(async () => {
  delete process.env.HEALTH_RULES;
  delete process.env.HEALTH_LINKS;
  app = await boot({ modules: [health] });
  await app.makeUser("root", "root password!!", { role: "admin" });
  cookie = (await app.login("root", "root password!!")).cookie;
});
afterEach(() => app.close());

const put = (key: string, value: unknown) => app.send("PUT", `/api/admin/settings/${key}`, { value }, cookie);

test("check rules from the table editor are stored as sent", async () => {
  const rules = {
    "checks/chk_gitea": { warnAbove: 300, critAbove: 1000, maxStatus: "warn" },
    "cluster/nodes.ready": { warnBelow: 3, critBelow: 1 },
    "longhorn/volumes": { disabled: true },
  };
  assert.equal((await put("health.rules", JSON.stringify(rules))).status, 200);
  assert.deepEqual(declared.rules.get(), rules);
  assert.equal(declared.rules.source(), "ui");
  assert.equal((await put("health.rules", JSON.stringify({}))).status, 200);
  assert.deepEqual(declared.rules.get(), {});
});

test("a cap the module does not know is refused", async () => {
  const res = await put("health.rules", JSON.stringify({ "checks/x": { maxStatus: "crit" } }));
  assert.equal(res.status, 400);
});

test("links from the shared Links form are stored as sent", async () => {
  const links = {
    cluster: [{ label: "Rancher", url: "https://rancher.example.com/dashboard/c/local/explorer" }],
    gitops: [{ label: "Gitea", url: "https://git.example.com" }],
  };
  assert.equal((await put("health.links", JSON.stringify(links))).status, 200);
  assert.deepEqual(declared.links.get(), links);
});

test("an environment value locks neither editor's setting but is shown as the fallback", async () => {
  process.env.HEALTH_RULES = JSON.stringify({ "checks/*": { critAbove: 2000 } });
  assert.deepEqual(declared.rules.get(), { "checks/*": { critAbove: 2000 } });
  assert.equal(declared.rules.source(), "env");
  const overview = (await (await app.get("/api/admin/overview", cookie)).json()) as {
    settings: { key: string; group: string; locked?: boolean; env?: string }[];
  };
  const row = overview.settings.find((s) => s.key === "health.rules")!;
  assert.equal(row.group, "health");
  assert.equal(row.env, "HEALTH_RULES");
  assert.equal(row.locked, undefined);
});
