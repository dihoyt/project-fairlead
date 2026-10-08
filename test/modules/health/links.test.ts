import { test } from "node:test";
import assert from "node:assert/strict";
import type { CategoryDetail, HealthLinkView } from "../../../src/contracts/health.js";
import { createMockContext, mockViewer } from "../../../src/contracts/mocks/context.js";
import mod from "../../../src/modules/health/index.js";
import { migrations } from "../../../src/modules/health/migrations.js";
import { listen } from "../../runtime/helpers.js";

async function setup() {
  const mock = createMockContext("health", {
    migrations,
    settings: { "health.links": { cluster: [{ label: "Rancher", url: "https://rancher.example.com" }] } },
  });
  await mod.register(mock.ctx);
  const server = await listen(mock.app);
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${server.url}/api/health${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  return {
    ...mock,
    send,
    async close() {
      await server.close();
      await mock.close();
    },
  };
}

test("custom links are added, changed and deleted, and show on their category page", async () => {
  const app = await setup();
  try {
    const created = await app.send("POST", "/links", {
      category: "apps",
      label: " Paperless ",
      url: "https://docs.example.com",
    });
    assert.equal(created.status, 200);
    const link = created.body as HealthLinkView;
    assert.equal(link.label, "Paperless");
    assert.equal(link.source, "custom");
    assert.equal(link.createdBy, "admin");

    const all = (await app.send("GET", "/links")).body as HealthLinkView[];
    assert.deepEqual(
      all.map((l) => [l.id, l.source]),
      [
        ["settings:cluster:0", "settings"],
        [link.id, "custom"],
      ]
    );
    assert.equal(((await app.send("GET", "/links?category=cluster")).body as HealthLinkView[]).length, 1);

    const moved = await app.send("PUT", `/links/${link.id}`, { category: "cluster" });
    assert.equal((moved.body as HealthLinkView).url, "https://docs.example.com");
    const page = (await app.send("GET", "/categories/cluster")).body as CategoryDetail;
    assert.deepEqual(page.links, [
      { label: "Rancher", url: "https://rancher.example.com" },
      { label: "Paperless", url: "https://docs.example.com" },
    ]);

    assert.equal((await app.send("DELETE", `/links/${link.id}`)).status, 200);
    assert.equal((await app.send("DELETE", `/links/${link.id}`)).status, 404);
    assert.deepEqual(
      app.audit.map((a) => a.action),
      ["health.link-create", "health.link-update", "health.link-delete"]
    );
  } finally {
    await app.close();
  }
});

test("links are validated, settings links are read-only, and changes need write", async () => {
  const app = await setup();
  try {
    for (const body of [
      { category: "nope", label: "x", url: "https://a.example.com" },
      { category: "apps", label: "", url: "https://a.example.com" },
      { category: "apps", label: "x", url: "javascript:alert(1)" },
      { category: "apps", label: "x", url: "not a url" },
    ]) {
      assert.equal((await app.send("POST", "/links", body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await app.send("PUT", "/links/settings:cluster:0", { label: "y" })).status, 409);
    assert.equal((await app.send("GET", "/links?category=nope")).status, 400);
    app.setUser(mockViewer);
    assert.equal(
      (await app.send("POST", "/links", { category: "apps", label: "x", url: "https://a.example.com" })).status,
      403
    );
    assert.equal((await app.send("GET", "/links")).status, 200);
  } finally {
    await app.close();
  }
});

test("the links reset clears custom links and leaves settings links alone", async () => {
  const app = await setup();
  try {
    await app.send("POST", "/links", { category: "apps", label: "x", url: "https://a.example.com" });
    const handlers = app.ctx.reset.list().filter((h) => h.scope === "links");
    assert.equal(
      handlers.reduce((sum, h) => sum + (h.clear?.() ?? 0), 0),
      1
    );
    const left = (await app.send("GET", "/links")).body as HealthLinkView[];
    assert.deepEqual(
      left.map((l) => l.source),
      ["settings"]
    );
  } finally {
    await app.close();
  }
});
