import { test } from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_ROUTES, type RouteKey } from "../../src/contracts/api.js";
import {
  MCP_TOOL_ROUTES,
  ROUTE_ACCESS,
  grantReaches,
  grantRefusal,
  routeNamespace,
  type ApiTokenGrant,
} from "../../src/contracts/grants.js";
import { MCP_TOOLS } from "../../src/contracts/mcp.js";
import { createMockContext, mockAdmin, mockTokenUser } from "../../src/contracts/mocks/context.js";
import { listen } from "./helpers.js";

const all: ApiTokenGrant = { scope: "write" };
const apps: ApiTokenGrant = { scope: "write", areas: ["workloads", "deploy"], namespaces: ["apps"] };

test("admin and auth routes are never reachable with a token; public routes need nothing", () => {
  for (const key of Object.keys(ROUTE_ACCESS) as RouteKey[]) {
    const path = key.split(" ")[1]!;
    if (path.startsWith("/api/admin") || path.startsWith("/api/auth")) {
      assert.equal(ROUTE_ACCESS[key], "session", key);
      assert.ok(grantRefusal(all, key), key);
    }
  }
  for (const key of Object.keys(PUBLIC_ROUTES) as RouteKey[]) assert.equal(ROUTE_ACCESS[key], "public", key);
});

test("a grant without limits reaches every token route, as tokens made before grants did", () => {
  for (const key of Object.keys(ROUTE_ACCESS) as RouteKey[]) {
    if (ROUTE_ACCESS[key] === "session") continue;
    assert.equal(grantRefusal(all, key, { params: { namespace: "x" }, body: { namespace: "x" } }), null, key);
  }
});

test("areas limit which routes a token reaches", () => {
  assert.equal(grantRefusal(apps, "GET /api/workloads/namespaces"), null);
  assert.match(grantRefusal(apps, "GET /api/checks") ?? "", /HTTP checks/);
  assert.match(grantRefusal(apps, "GET /api/health/board") ?? "", /Health board/);
  assert.equal(grantRefusal(apps, "GET /api/me"), null);
});

test("namespaces limit namespaced routes; cluster-wide ones are read-only for such a token", () => {
  const pods = "GET /api/workloads/namespaces/:namespace/pods";
  assert.equal(grantRefusal(apps, pods, { params: { namespace: "apps" } }), null);
  assert.match(grantRefusal(apps, pods, { params: { namespace: "kube-system" } }) ?? "", /"kube-system"/);
  assert.equal(grantRefusal(apps, "POST /api/deploy/jobs", { body: { appId: "gitea", namespace: "apps" } }), null);
  assert.match(
    grantRefusal(apps, "POST /api/deploy/jobs", { body: { appId: "gitea", namespace: "other" } }) ?? "",
    /"other"/
  );
  // No namespace named: cluster-wide.
  assert.match(grantRefusal(apps, "POST /api/deploy/jobs", { body: { appId: "gitea" } }) ?? "", /cluster-wide/);
  assert.match(grantRefusal(apps, "POST /api/deploy/bundles") ?? "", /cluster-wide/);
  assert.equal(grantRefusal(apps, "GET /api/deploy/jobs"), null);
  assert.equal(grantRefusal({ scope: "write", namespaces: ["apps"] }, "GET /api/health/board"), null);
});

test("install-wide routes need a token without limits", () => {
  assert.match(grantRefusal(apps, "POST /api/system/reset") ?? "", /every area and every namespace/);
  assert.ok(grantRefusal({ scope: "write", namespaces: ["apps"] }, "POST /api/onboarding/steps/:step"));
  assert.equal(grantRefusal(all, "POST /api/system/reset"), null);
});

test("routeNamespace reads params and body fields, ignoring empty or non-string values", () => {
  assert.equal(routeNamespace("GET /api/workloads/namespaces/:namespace/pods", { params: { namespace: "a" } }), "a");
  assert.equal(routeNamespace("POST /api/deploy/plan", { body: { namespace: "" } }), undefined);
  assert.equal(routeNamespace("POST /api/deploy/plan", { body: { namespace: 3 } }), undefined);
  assert.equal(routeNamespace("GET /api/checks", { params: { namespace: "a" } }), undefined);
});

test("every MCP tool maps to a route, and reach follows the grant", () => {
  assert.deepEqual(Object.keys(MCP_TOOL_ROUTES).toSorted(), MCP_TOOLS.map((t) => t.name).toSorted());
  assert.equal(grantReaches(apps, MCP_TOOL_ROUTES.list_pods), true);
  assert.equal(grantReaches(apps, MCP_TOOL_ROUTES.deploy_app), true);
  assert.equal(grantReaches(apps, MCP_TOOL_ROUTES.start_bundle), false);
  assert.equal(grantReaches(apps, MCP_TOOL_ROUTES.list_checks), false);
  assert.equal(grantReaches(all, MCP_TOOL_ROUTES.start_bundle), true);
});

test("the runtime refuses a token's request outside its grant before the handler runs", async () => {
  const mock = createMockContext("workloads", { user: mockTokenUser() });
  let ran = 0;
  mock.ctx.route("GET /api/workloads/namespaces/:namespace/pods", () => (ran++, []));
  mock.ctx.route("GET /api/workloads/namespaces", (req) => {
    ran++;
    return mock.ctx.visibleNamespaces(req) as never;
  });
  const server = await listen(mock.app);
  try {
    assert.equal((await fetch(`${server.url}/api/workloads/namespaces/apps/pods`)).status, 200);
    const refused = await fetch(`${server.url}/api/workloads/namespaces/kube-system/pods`);
    assert.equal(refused.status, 403);
    assert.match(((await refused.json()) as { error: string }).error, /kube-system/);
    assert.equal(ran, 1);
    assert.deepEqual(await (await fetch(`${server.url}/api/workloads/namespaces`)).json(), ["apps"]);
    mock.setUser(mockAdmin);
    assert.equal((await fetch(`${server.url}/api/workloads/namespaces/kube-system/pods`)).status, 200);
    assert.equal(await (await fetch(`${server.url}/api/workloads/namespaces`)).json(), null);
  } finally {
    await server.close();
    await mock.close();
  }
});
